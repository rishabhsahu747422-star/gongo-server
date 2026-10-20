'use strict';

const BaseRepository = require('./base.repository');

class OfferRepository extends BaseRepository {
  /**
   * Retrieves all currently active and valid offers for customers.
   * Customer endpoints MUST only return active offers within their validity window.
   */
  async getActiveOffers() {
    const sql = `
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
    const res = await this.query(sql);
    return res.rows;
  }
}

module.exports = new OfferRepository();
