'use strict';

const offerService = require('../services/offer.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

class OfferController {
  constructor(service = offerService) {
    this.service = service;
    this.getActiveOffers = this.getActiveOffers.bind(this);
  }

  /**
   * GET /api/v1/offers/active or /api/v1/customer/offers/active
   * Returns active, valid offers with revision-based caching headers.
   */
  async getActiveOffers(req, res, next) {
    try {
      const data = await this.service.getActiveOffers();
      const etag = `W/"offer-rev-${data.revision}"`;

      // Set client caching headers (5 minutes default client cache TTL)
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
      res.setHeader('ETag', etag);

      // Check conditional request for 304 Not Modified
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch.includes(data.revision))) {
        return res.status(304).end();
      }

      return sendSuccess(res, data, 'Active offers retrieved', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new OfferController();
