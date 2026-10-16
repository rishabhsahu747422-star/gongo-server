'use strict';

const BaseRepository = require('./base.repository');
const { PAYMENT_STATUS } = require('../constants/payment');
const { generateUniqueEntityReference } = require('../utils/reference-generator');

/**
 * PaymentRepository — database operations for payment records mapped to Supabase schema.
 *
 * All operations are strictly parameterized.
 */
class PaymentRepository extends BaseRepository {
  /**
   * Maps a raw SQL payment row (with attempt join) to a customer-safe DTO.
   *
   * @param {object} row
   * @returns {object|null}
   */
  static mapPaymentDto(row) {
    if (!row) return null;

    return {
      id: row.id,
      bookingId: row.booking_id,
      customerId: row.customer_id,
      orderReference: row.order_reference || null,
      provider: (row.gateway || row.provider || 'cashfree').toUpperCase(),
      providerOrderId: row.gateway_order_id || row.provider_order_id || row.payment_number,
      providerPaymentId: row.gateway_payment_id || row.provider_payment_id || null,
      amount: Number(row.amount),
      currency: row.currency || 'INR',
      status: row.status,
      paymentType: row.payment_type || 'BOOKING_ADVANCE',
      paymentMethod: row.payment_method || null,
      failureReason: row.failure_reason || null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }

  /**
   * Inserts a new payment record in Supabase (with fallback for legacy test schema).
   *
   * @param {object} data
   * @param {object} [client]
   * @returns {Promise<object>}
   */
  async create(data, client = null) {
    const runner = client || this;
    const paymentNumber = `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const status = data.status || PAYMENT_STATUS.INITIATED;
    const currency = data.currency || 'INR';

    let orderReference = data.orderReference || data.order_reference || null;
    if (!orderReference) {
      try {
        orderReference = await generateUniqueEntityReference(runner, 'payments', 'order_reference', 'ORD');
      } catch {
        orderReference = null;
      }
    }

    try {
      // 1. Try Supabase schema (payments + payment_attempts)
      let partnerId = data.partnerId;
      if (!partnerId && data.bookingId) {
        const bRes = await runner.query('SELECT partner_id FROM bookings WHERE id = $1', [data.bookingId]);
        partnerId = bRes.rows[0]?.partner_id;
      }

      const insertPaymentSql = `
        INSERT INTO payments (
          order_reference, booking_id, customer_id, partner_id, payment_number,
          amount, currency, status, payment_method,
          payment_type, provider_order_id, provider_payment_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12
        )
        RETURNING *
      `;

      let pRes;
      try {
        pRes = await runner.query(insertPaymentSql, [
          orderReference,
          data.bookingId,
          data.customerId,
          partnerId,
          paymentNumber,
          data.amount,
          currency,
          status,
          data.paymentMethod || null,
          data.paymentType || 'BOOKING_ADVANCE',
          data.providerOrderId || paymentNumber,
          data.providerPaymentId || null,
        ]);
      } catch (insertErr) {
        if (insertErr.message && insertErr.message.includes('order_reference')) {
          const fallbackSql = `
            INSERT INTO payments (
              booking_id, customer_id, partner_id, payment_number,
              amount, currency, status, payment_method,
              payment_type, provider_order_id, provider_payment_id
            ) VALUES (
              $1, $2, $3, $4,
              $5, $6, $7, $8,
              $9, $10, $11
            )
            RETURNING *
          `;
          pRes = await runner.query(fallbackSql, [
            data.bookingId,
            data.customerId,
            partnerId,
            paymentNumber,
            data.amount,
            currency,
            status,
            data.paymentMethod || null,
            data.paymentType || 'BOOKING_ADVANCE',
            data.providerOrderId || paymentNumber,
            data.providerPaymentId || null,
          ]);
        } else {
          const legacyInsertSql = `
            INSERT INTO payments (
              booking_id, customer_id, partner_id, payment_number,
              amount, currency, status, payment_method
            ) VALUES (
              $1, $2, $3, $4,
              $5, $6, $7, $8
            )
            RETURNING *
        `;
        pRes = await runner.query(legacyInsertSql, [
          data.bookingId,
          data.customerId,
          partnerId,
          paymentNumber,
          data.amount,
          currency,
          status,
          data.paymentMethod || null,
        ]);
      }
    }

    const payment = pRes.rows[0];

      // Record initial payment_attempt
      const gateway = (data.provider || 'cashfree').toLowerCase();
      try {
        const insertAttemptSql = `
          INSERT INTO payment_attempts (
            payment_id, attempt_number, gateway, gateway_order_id,
            gateway_payment_id, amount, currency, status
          ) VALUES (
            $1, 1, $2, $3,
            $4, $5, $6, $7
          )
        `;
        await runner.query(insertAttemptSql, [
          payment.id,
          gateway === 'cashfree' || gateway === 'razorpay' ? gateway : 'cashfree',
          data.providerOrderId || paymentNumber,
          data.providerPaymentId || null,
          data.amount,
          currency,
          status === PAYMENT_STATUS.SUCCESS ? 'captured' : 'initiated',
        ]);
      } catch {
        // Ignored
      }

      return PaymentRepository.mapPaymentDto({
        ...payment,
        gateway,
        gateway_order_id: data.providerOrderId || paymentNumber,
        gateway_payment_id: data.providerPaymentId || null,
        payment_type: data.paymentType || 'BOOKING_ADVANCE',
      });
    } catch (err) {
      if (err.message && (err.message.includes('payment_number') || err.message.includes('partner_id') || err.message.includes('does not exist'))) {
        // Fallback for legacy pg-mem test database
        const legacyStatus = (status === 'initiated' || status === 'pending')
          ? 'PENDING'
          : (status === 'paid' ? 'SUCCESS' : (status || 'PENDING').toUpperCase());
        const legacySql = `
          INSERT INTO payments (
            booking_id, customer_id, provider, provider_order_id,
            provider_payment_id, amount, currency, status,
            payment_method, failure_reason, metadata, payment_type
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            $9, $10, $11, $12
          )
          RETURNING *
        `;
        const res = await runner.query(legacySql, [
          data.bookingId,
          data.customerId,
          data.provider || 'CASHFREE',
          data.providerOrderId || paymentNumber,
          data.providerPaymentId || null,
          data.amount,
          currency,
          legacyStatus,
          data.paymentMethod || null,
          data.failureReason || null,
          data.metadata ? JSON.stringify(data.metadata) : null,
          data.paymentType || 'BOOKING_ADVANCE',
        ]);
        return PaymentRepository.mapPaymentDto(res.rows[0]);
      }
      throw err;
    }
  }

  /**
   * Finds a payment by its internal ID.
   *
   * @param {string} id
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findById(id, client = null) {
    const runner = client || this;
    try {
      const text = `
        SELECT
          p.*,
          pa.gateway,
          pa.gateway_order_id,
          pa.gateway_payment_id,
          pa.failure_reason
        FROM payments p
        LEFT JOIN payment_attempts pa ON pa.payment_id = p.id
        WHERE p.id = $1
        ORDER BY pa.created_at DESC
        LIMIT 1
      `;
      const res = await runner.query(text, [id]);
      return res.rows[0] ? PaymentRepository.mapPaymentDto(res.rows[0]) : null;
    } catch {
      const res = await runner.query('SELECT * FROM payments WHERE id = $1 LIMIT 1', [id]);
      return res.rows[0] ? PaymentRepository.mapPaymentDto(res.rows[0]) : null;
    }
  }

  /**
   * Finds a payment by the unique provider order ID.
   *
   * @param {string} providerOrderId
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findByProviderOrderId(providerOrderId, client = null) {
    const runner = client || this;
    try {
      const res = await runner.query(
        'SELECT * FROM payments WHERE provider_order_id = $1 OR payment_number = $1 LIMIT 1',
        [providerOrderId]
      );
      if (res.rows && res.rows[0]) {
        return PaymentRepository.mapPaymentDto(res.rows[0]);
      }
    } catch {
      // ignore
    }

    try {
      const text = `
        SELECT
          p.*,
          pa.gateway,
          pa.gateway_order_id,
          pa.gateway_payment_id,
          pa.failure_reason
        FROM payments p
        JOIN payment_attempts pa ON pa.payment_id = p.id
        WHERE pa.gateway_order_id = $1
        ORDER BY pa.created_at DESC
        LIMIT 1
      `;
      const res = await runner.query(text, [providerOrderId]);
      if (res.rows && res.rows[0]) {
        return PaymentRepository.mapPaymentDto(res.rows[0]);
      }
    } catch {
      // ignore
    }

    return null;
  }

  /**
   * Locks and retrieves a payment by provider_order_id FOR UPDATE inside a transaction.
   *
   * @param {string} providerOrderId
   * @param {object} client
   * @returns {Promise<object|null>}
   */
  async lockByProviderOrderId(providerOrderId, client) {
    try {
      const res = await client.query(
        'SELECT * FROM payments WHERE provider_order_id = $1 OR payment_number = $1 FOR UPDATE',
        [providerOrderId]
      );
      if (res.rows && res.rows[0]) {
        return res.rows[0];
      }
    } catch {
      // ignore
    }

    try {
      const attemptRes = await client.query(
        'SELECT payment_id FROM payment_attempts WHERE gateway_order_id = $1 ORDER BY created_at DESC LIMIT 1',
        [providerOrderId]
      );
      if (attemptRes.rows && attemptRes.rows[0]) {
        const paymentId = attemptRes.rows[0].payment_id;
        const lockRes = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
        return lockRes.rows[0] || null;
      }
    } catch {
      // ignore
    }

    return null;
  }

  /**
   * Finds the active payment for a booking.
   *
   * @param {string} bookingId
   * @param {string} [paymentType]
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findActiveByBookingId(bookingId, paymentType = null, client = null) {
    const runner = client || this;
    try {
      const text = `
        SELECT
          p.*,
          pa.gateway,
          pa.gateway_order_id,
          pa.gateway_payment_id,
          pa.failure_reason
        FROM payments p
        LEFT JOIN payment_attempts pa ON pa.payment_id = p.id
        WHERE p.booking_id = $1
          AND p.status IN ('initiated', 'pending', 'authorized', 'paid', 'CREATED', 'PENDING', 'SUCCESS')
        ORDER BY p.created_at DESC
        LIMIT 1
      `;
      const res = await runner.query(text, [bookingId]);
      return res.rows[0] ? PaymentRepository.mapPaymentDto(res.rows[0]) : null;
    } catch {
      const res = await runner.query(`
        SELECT * FROM payments
        WHERE booking_id = $1 AND status IN ('CREATED', 'PENDING', 'SUCCESS', 'initiated', 'pending', 'paid')
        ORDER BY created_at DESC
        LIMIT 1
      `, [bookingId]);
      return res.rows[0] ? PaymentRepository.mapPaymentDto(res.rows[0]) : null;
    }
  }

  /**
   * Finds the latest payment for a booking.
   *
   * @param {string} bookingId
   * @param {string} [paymentType]
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async findLatestByBookingId(bookingId, paymentType = null, client = null) {
    const runner = client || this;
    try {
      const text = `
        SELECT
          p.*,
          pa.gateway,
          pa.gateway_order_id,
          pa.gateway_payment_id,
          pa.failure_reason
        FROM payments p
        LEFT JOIN payment_attempts pa ON pa.payment_id = p.id
        WHERE p.booking_id = $1
        ORDER BY p.created_at DESC
        LIMIT 1
      `;
      const res = await runner.query(text, [bookingId]);
      return res.rows[0] ? PaymentRepository.mapPaymentDto(res.rows[0]) : null;
    } catch {
      const res = await runner.query('SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1', [bookingId]);
      return res.rows[0] ? PaymentRepository.mapPaymentDto(res.rows[0]) : null;
    }
  }

  /**
   * Updates payment status.
   *
   * @param {string} id
   * @param {string} status
   * @param {object} [extraFields]
   * @param {object} [client]
   * @returns {Promise<object|null>}
   */
  async updateStatus(id, status, extraFields = {}, client = null) {
    const runner = client || this;

    // 1. Determine targetStatus (preserve uppercase if supported by DB check constraint)
    const rawStatus = String(status || '').toUpperCase();
    let targetStatus;
    if (rawStatus === 'SUCCESS' || rawStatus === 'PAID' || rawStatus === 'CAPTURED') {
      targetStatus = status === 'paid' ? 'paid' : 'SUCCESS';
    } else if (rawStatus === 'FAILED' || rawStatus === 'FAILURE' || rawStatus === 'USER_DROPPED') {
      targetStatus = status === 'failed' ? 'failed' : 'FAILED';
    } else if (rawStatus === 'CANCELLED' || rawStatus === 'CANCELED') {
      targetStatus = status === 'cancelled' ? 'cancelled' : 'CANCELLED';
    } else if (rawStatus === 'REFUNDED') {
      targetStatus = 'refunded';
    } else if (rawStatus === 'PARTIALLY_REFUNDED') {
      targetStatus = 'partially_refunded';
    } else if (rawStatus === 'AUTHORIZED') {
      targetStatus = 'authorized';
    } else if (rawStatus === 'INITIATED') {
      targetStatus = 'initiated';
    } else {
      targetStatus = status || 'PENDING';
    }

    // 2. Normalize payment_method (support uppercase UPI or normalized methods)
    let targetMethod = extraFields.paymentMethod ? String(extraFields.paymentMethod) : null;
    const providerPaymentId = extraFields.providerPaymentId || null;
    const failureReason = extraFields.failureReason || null;

    // 3. Update table 'payments' with status, method, providerPaymentId, and failure_reason
    const updatePaymentSql = `
      UPDATE payments
      SET status = $1::varchar,
          payment_method = COALESCE($2::varchar, payment_method),
          provider_payment_id = COALESCE($3::varchar, provider_payment_id),
          failure_reason = COALESCE($4::text, failure_reason),
          paid_at = (CASE WHEN $1::varchar IN ('paid', 'SUCCESS') THEN COALESCE(paid_at, CURRENT_TIMESTAMP) ELSE paid_at END),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $5::uuid
      RETURNING *
    `;

    let res;
    try {
      res = await runner.query(updatePaymentSql, [
        targetStatus,
        targetMethod,
        providerPaymentId,
        failureReason,
        id,
      ]);
    } catch (dbErr) {
      // If check constraint fails on uppercase or method, fall back to lowercase schema
      if (dbErr.message && (dbErr.message.includes('check constraint') || dbErr.message.includes('chk_payments'))) {
        const fallbackStatus = (targetStatus === 'SUCCESS') ? 'paid' : (targetStatus === 'FAILED' ? 'failed' : targetStatus.toLowerCase());
        const fallbackMethod = targetMethod ? targetMethod.toLowerCase() : null;
        res = await runner.query(updatePaymentSql, [
          fallbackStatus,
          fallbackMethod,
          providerPaymentId,
          failureReason,
          id,
        ]);
      } else {
        throw dbErr;
      }
    }

    if (!res.rows[0]) return null;

    // 4. Update table 'payment_attempts' if record exists (where failure_reason is supported)
    if (providerPaymentId || extraFields.failureReason) {
      try {
        await runner.query(`
          UPDATE payment_attempts
          SET gateway_payment_id = COALESCE($1::varchar, gateway_payment_id),
              failure_reason = COALESCE($2::text, failure_reason),
              status = (CASE WHEN $3::varchar = 'paid' THEN 'captured' WHEN $3::varchar = 'failed' THEN 'failed' ELSE status END),
              completed_at = CURRENT_TIMESTAMP
          WHERE payment_id = $4::uuid
        `, [
          providerPaymentId,
          extraFields.failureReason || null,
          targetStatus,
          id,
        ]);
      } catch {
        // Non-fatal if payment_attempts table schema differs
      }
    }

    return PaymentRepository.mapPaymentDto({
      ...res.rows[0],
      provider_payment_id: providerPaymentId || res.rows[0].provider_payment_id,
      failure_reason: extraFields.failureReason || null,
    });
  }
}

module.exports = PaymentRepository;
