'use strict';

const BaseRepository = require('./base.repository');

class OfferRepository extends BaseRepository {
  /**
   * Retrieves all currently active and valid offers for customers.
   * Customer endpoints MUST only return active offers within their validity window.
   */
  async getActiveOffers() {
    try {
      const sql = `
        WITH active_offers AS (
          SELECT id, name, description, offer_type, discount_type, discount_value,
                 max_discount_amount, min_booking_amount, code, image_url,
                 display_order, cta_label, cta_destination, metadata,
                 valid_from, valid_until, updated_at, created_at
          FROM offers
          WHERE is_active = true
            AND (valid_from IS NULL OR valid_from <= NOW())
            AND (valid_until IS NULL OR valid_until >= NOW())
        ),
        active_coupons AS (
          SELECT c.id, c.name, c.description,
                 'coupon'::varchar AS offer_type,
                 c.discount_type, c.discount_value,
                 c.max_discount_amount, c.min_booking_amount,
                 c.code,
                 NULL::text AS image_url,
                 10 AS display_order,
                 'Book Ride Now'::varchar AS cta_label,
                 '/vehicles'::varchar AS cta_destination,
                 jsonb_build_object('source', 'coupon', 'usage_limit', c.usage_limit, 'used_count', c.used_count) AS metadata,
                 c.valid_from, c.valid_until, c.updated_at, c.created_at
          FROM coupons c
          WHERE c.is_active = true
            AND c.valid_until > NOW()
            AND (c.valid_from IS NULL OR c.valid_from <= NOW())
            AND (c.usage_limit IS NULL OR c.used_count < c.usage_limit)
            AND NOT EXISTS (
              SELECT 1 FROM active_offers ao 
              WHERE ao.code IS NOT NULL AND UPPER(ao.code) = UPPER(c.code)
            )
        )
        SELECT id, name, description, offer_type, discount_type, discount_value,
               max_discount_amount, min_booking_amount, code, image_url,
               display_order, cta_label, cta_destination, metadata,
               valid_from, valid_until, updated_at
        FROM (
          SELECT * FROM active_offers
          UNION ALL
          SELECT * FROM active_coupons
        ) combined
        ORDER BY display_order ASC, created_at DESC;
      `;
      const res = await this.query(sql);
      return res.rows;
    } catch (_) {
      // Graceful fallback to offers table only if coupons table or schema differs
      const fallbackSql = `
        SELECT id, name, description, offer_type, discount_type, discount_value,
               max_discount_amount, min_booking_amount, code, image_url,
               display_order, cta_label, cta_destination, metadata,
               valid_from, valid_until, updated_at
        FROM offers
        WHERE is_active = true
          AND (valid_from IS NULL OR valid_from <= NOW())
          AND (valid_until IS NULL OR valid_until >= NOW())
        ORDER BY display_order ASC, created_at DESC;
      `;
      const fallbackRes = await this.query(fallbackSql);
      return fallbackRes.rows;
    }
  }
}

module.exports = new OfferRepository();
