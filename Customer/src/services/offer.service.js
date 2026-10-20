'use strict';

const crypto = require('crypto');
const offerRepository = require('../repositories/offer.repository');

class OfferService {
  constructor(offerRepo = offerRepository) {
    this.offerRepo = offerRepo;
  }

  /**
   * Retrieves all active offers with a stable configuration revision identifier for ETag support.
   */
  async getActiveOffers() {
    const rows = await this.offerRepo.getActiveOffers();

    // Map public fields (do not leak internal administrative metadata or storage paths)
    const offers = rows.map((row) => ({
      id: row.id,
      name: row.name || '',
      title: row.name || '', // Alias for UI components expecting title
      description: row.description || '',
      offerType: row.offer_type || 'discount',
      offer_type: row.offer_type || 'discount',
      discountType: row.discount_type || 'percentage',
      discount_type: row.discount_type || 'percentage',
      discountValue: row.discount_value !== null ? Number(row.discount_value) : null,
      discount_value: row.discount_value !== null ? Number(row.discount_value) : null,
      maxDiscountAmount: row.max_discount_amount !== null ? Number(row.max_discount_amount) : null,
      max_discount_amount: row.max_discount_amount !== null ? Number(row.max_discount_amount) : null,
      minBookingAmount: row.min_booking_amount !== null ? Number(row.min_booking_amount) : null,
      min_booking_amount: row.min_booking_amount !== null ? Number(row.min_booking_amount) : null,
      code: row.code || null,
      imageUrl: row.image_url || null,
      image_url: row.image_url || null,
      displayOrder: row.display_order || 0,
      display_order: row.display_order || 0,
      ctaLabel: row.cta_label || null,
      cta_label: row.cta_label || null,
      ctaDestination: row.cta_destination || null,
      cta_destination: row.cta_destination || null,
      metadata: typeof row.metadata === 'object' && row.metadata !== null ? row.metadata : {},
      validFrom: row.valid_from ? new Date(row.valid_from).toISOString() : null,
      valid_from: row.valid_from ? new Date(row.valid_from).toISOString() : null,
      validUntil: row.valid_until ? new Date(row.valid_until).toISOString() : null,
      valid_until: row.valid_until ? new Date(row.valid_until).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    }));

    // Calculate a deterministic revision hash across all active offers
    const revisionInput = offers
      .map((o) => `${o.id}:${o.code || ''}:${o.discountValue || ''}:${o.validUntil || ''}:${o.updatedAt || ''}`)
      .join('|');
    const revision = crypto
      .createHash('sha256')
      .update(revisionInput || 'empty-active-offers')
      .digest('hex')
      .slice(0, 16);

    return {
      offers,
      items: offers,
      revision,
      count: offers.length,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = new OfferService();
