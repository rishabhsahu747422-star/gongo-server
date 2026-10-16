'use strict';

const { pool } = require('../db/pool');
const logger = require('../config/logger');

class CommissionLockService {
  /**
   * Resolves and locks the commission for a booking at booking creation time.
   *
   * IMMUTABILITY RULE:
   * If a commission snapshot already exists for this booking in `earnings`,
   * `commission_records`, or `commission_transactions`, it is NEVER recalculated.
   *
   * SNAPSHOT CALCULATION:
   * If no snapshot exists yet, the active commission rule as of the booking's
   * creation time is matched using canonical scope hierarchy:
   * 1. vehicle
   * 2. partner
   * 3. category
   * 4. default
   *
   * The calculated snapshot is then saved into `commission_records`,
   * `commission_transactions`, and `earnings` tables.
   *
   * @param {string|object} bookingOrId - Booking object or booking UUID
   * @param {import('pg').PoolClient} [client] - Optional database client
   * @returns {Promise<object>} Snapshot with { commissionRate, commissionAmount, partnerNetAmount, grossAmount, ruleId }
   */
  async lockBookingCommission(bookingOrId, client = null) {
    const db = client || pool;

    let bookingId;
    let bookingData = null;

    if (typeof bookingOrId === 'string') {
      bookingId = bookingOrId;
    } else if (bookingOrId && typeof bookingOrId === 'object') {
      bookingId = bookingOrId.id;
      bookingData = bookingOrId;
    }

    if (!bookingId) {
      return null;
    }

    // 1. Check if snapshot already exists
    const existingSnapRes = await db.query(
      `SELECT 
         cr.id AS cr_id,
         cr.commission_rate AS cr_rate,
         cr.commission_amount AS cr_comm,
         cr.partner_payable_amount AS cr_payable,
         ct.commission_rule_id AS ct_rule_id,
         ct.commission_rate AS ct_rate,
         ct.commission_amount AS ct_comm,
         e.id AS e_id,
         e.gross_amount AS e_gross,
         e.commission_amount AS e_comm,
         e.partner_net_amount AS e_net,
         COALESCE(bps.rental_amount, bpb.base_amount, b.subtotal, 0) AS b_rental,
         COALESCE(bps.security_deposit, bpb.security_deposit, vp.security_deposit, 0) AS b_deposit
       FROM bookings b
       LEFT JOIN commission_records cr ON cr.booking_id = b.id
       LEFT JOIN commission_transactions ct ON ct.booking_id = b.id
       LEFT JOIN earnings e ON e.booking_id = b.id
       LEFT JOIN booking_pricing_snapshots bps ON bps.booking_id = b.id
       LEFT JOIN LATERAL (
         SELECT bpb.* FROM booking_price_breakdown bpb WHERE bpb.booking_id = b.id ORDER BY bpb.created_at DESC LIMIT 1
       ) bpb ON true
       LEFT JOIN LATERAL (
         SELECT vp.* FROM vehicle_pricing vp WHERE vp.vehicle_id = b.vehicle_id AND vp.is_active = true ORDER BY vp.created_at DESC LIMIT 1
       ) vp ON true
       WHERE b.id = $1
       LIMIT 1`,
      [bookingId]
    );

    const row = existingSnapRes.rows[0];
    if (row && (row.cr_payable !== null || (row.e_net !== null && Number(row.e_comm) > 0) || row.ct_comm !== null)) {
      const bRental = Number(row.b_rental || 0);
      const bDeposit = Number(row.b_deposit || 0);
      let gross = Number(row.e_gross || bRental || 0);
      if (bRental > 0 && gross > bRental && bDeposit > 0) {
        gross = bRental;
      } else if (bDeposit > 0 && gross > bDeposit) {
        gross = gross - bDeposit;
      }
      const commAmt = Number(row.cr_comm ?? row.ct_comm ?? row.e_comm ?? 0);
      let netAmt = Number(row.cr_payable ?? row.e_net ?? (gross - commAmt));
      if (bDeposit > 0 && netAmt >= bDeposit && netAmt > gross) {
        netAmt = Math.max(0, netAmt - bDeposit);
      }
      if (netAmt > gross) {
        netAmt = Math.max(0, gross - commAmt);
      }
      const rate = Number(row.cr_rate ?? row.ct_rate ?? 0);

      return {
        bookingId,
        isExistingSnapshot: true,
        commissionRuleId: row.ct_rule_id || null,
        commissionRate: rate,
        commissionAmount: commAmt,
        partnerNetAmount: netAmt,
        grossAmount: gross,
      };
    }

    // 2. Fetch booking details if not supplied
    if (!bookingData || !bookingData.vehicle_id) {
      const bRes = await db.query(
        `SELECT b.*, v.partner_id AS vehicle_partner_id, v.category AS category_id
         FROM bookings b
         JOIN vehicles v ON v.id = b.vehicle_id
         WHERE b.id = $1`,
        [bookingId]
      );
      if (!bRes.rows || bRes.rows.length === 0) {
        return null;
      }
      bookingData = bRes.rows[0];
    }

    const partnerId = bookingData.partner_id || bookingData.vehicle_partner_id;
    const vehicleId = bookingData.vehicle_id;
    const rawCategoryId = bookingData.category_id || null;
    const isUuid = (val) => typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);
    const categoryId = isUuid(rawCategoryId) ? rawCategoryId : null;
    const bookingCreatedAt = bookingData.created_at || new Date();
    const depositAmt = Number(bookingData.security_deposit || 0);
    const rawRental = Number(
      bookingData.rental_amount ||
      bookingData.base_amount ||
      bookingData.subtotal ||
      0
    );
    let grossAmount = rawRental > 0 ? rawRental : Number(bookingData.total_amount || bookingData.total_customer_amount || 0);
    if (rawRental <= 0 && depositAmt > 0 && grossAmount > depositAmt) {
      grossAmount = grossAmount - depositAmt;
    }

    // 3. Match active commission rule effective as of booking creation time
    const ruleRes = await db.query(
      `SELECT * FROM commission_rules
       WHERE is_active = true
         AND (effective_from IS NULL OR effective_from <= $1)
         AND (effective_until IS NULL OR effective_until >= $1)
         AND (
           (rule_scope = 'vehicle' AND vehicle_id = $2)
           OR (rule_scope = 'partner' AND partner_id = $3)
           OR (rule_scope = 'category' AND category_id = $4)
           OR (rule_scope = 'default')
         )
       ORDER BY
         CASE rule_scope
           WHEN 'vehicle' THEN 4
           WHEN 'partner' THEN 3
           WHEN 'category' THEN 2
           WHEN 'default' THEN 1
           ELSE 0
         END DESC,
         priority DESC,
         created_at DESC
       LIMIT 1`,
      [bookingCreatedAt, vehicleId, partnerId, categoryId]
    );

    const rule = ruleRes.rows[0] || null;

    let commissionRate = 0;
    let commissionAmount = 0;
    let commissionType = 'percentage';

    if (rule) {
      commissionType = String(rule.commission_type || 'percentage').toLowerCase();
      if (commissionType === 'percentage') {
        commissionRate = Number(rule.commission_value || 0);
        commissionAmount = Number(((grossAmount * commissionRate) / 100).toFixed(2));
      } else {
        commissionRate = 0;
        commissionAmount = Math.min(grossAmount, Number(Number(rule.commission_value || 0).toFixed(2)));
      }
    }

    const partnerNetAmount = Math.max(0, Number((grossAmount - commissionAmount).toFixed(2)));
    const isCompleted =
      String(bookingData.booking_status || '').toUpperCase() === 'COMPLETED' ||
      ['completed', 'returned'].includes(String(bookingData.status || '').toLowerCase());

    // 4. Store immutable snapshot in commission_records
    const existCr = await db.query('SELECT id FROM commission_records WHERE booking_id = $1 LIMIT 1', [bookingId]);
    if (!existCr.rows || existCr.rows.length === 0) {
      await db.query(
        `INSERT INTO commission_records (
           booking_id, partner_id, commission_type, commission_rate,
           gross_booking_amount, commission_amount, partner_payable_amount, status, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'LOCKED', $8, CURRENT_TIMESTAMP)`,
        [
          bookingId,
          partnerId,
          commissionType.toUpperCase(),
          commissionRate,
          grossAmount,
          commissionAmount,
          partnerNetAmount,
          bookingCreatedAt,
        ]
      );
    }

    // 5. Store snapshot in commission_transactions
    const existCt = await db.query('SELECT id FROM commission_transactions WHERE booking_id = $1 LIMIT 1', [bookingId]);
    if (!existCt.rows || existCt.rows.length === 0) {
      await db.query(
        `INSERT INTO commission_transactions (
           booking_id, partner_id, commission_rule_id, commission_type, commission_rate,
           base_amount, commission_amount, currency, status, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'INR', 'applied', $8)`,
        [
          bookingId,
          partnerId,
          rule ? rule.id : null,
          commissionType.toUpperCase(),
          commissionRate,
          grossAmount,
          commissionAmount,
          bookingCreatedAt,
        ]
      );
    }

    // 6. Upsert earnings record
    await db.query(
      `INSERT INTO earnings (
         partner_id, booking_id, gross_amount, commission_amount, net_earnings,
         partner_net_amount, settlement_status, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
       ON CONFLICT (booking_id) DO UPDATE SET
         commission_amount = CASE WHEN earnings.commission_amount = 0 AND EXCLUDED.commission_amount > 0 THEN EXCLUDED.commission_amount ELSE earnings.commission_amount END,
         partner_net_amount = CASE WHEN earnings.partner_net_amount = earnings.gross_amount AND EXCLUDED.partner_net_amount < EXCLUDED.gross_amount THEN EXCLUDED.partner_net_amount ELSE earnings.partner_net_amount END,
         updated_at = CURRENT_TIMESTAMP`,
      [
        partnerId,
        bookingId,
        grossAmount,
        commissionAmount,
        partnerNetAmount,
        partnerNetAmount,
        isCompleted ? 'SETTLED' : 'PENDING',
        bookingCreatedAt,
      ]
    );

    logger.info('Commission snapshot locked for booking', {
      bookingId,
      partnerId,
      grossAmount,
      commissionAmount,
      partnerNetAmount,
      ruleId: rule ? rule.id : null,
    });

    return {
      bookingId,
      isExistingSnapshot: false,
      commissionRuleId: rule ? rule.id : null,
      commissionRate,
      commissionAmount,
      partnerNetAmount,
      grossAmount,
    };
  }
}

module.exports = new CommissionLockService();
