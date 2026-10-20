'use strict';

const bannerService = require('../services/banner.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

class BannerController {
  constructor(service = bannerService) {
    this.service = service;
    this.getActiveBanners = this.getActiveBanners.bind(this);
  }

  /**
   * GET /api/v1/banners/active or /api/v1/customer/banners/active
   * Returns active banner configurations with revision-based caching headers.
   */
  async getActiveBanners(req, res, next) {
    try {
      const data = await this.service.getActiveBanners();
      const etag = `W/"banner-rev-${data.revision}"`;

      // Set client caching headers (5 minutes default client cache TTL)
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
      res.setHeader('ETag', etag);

      // Check conditional request for 304 Not Modified
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch.includes(data.revision))) {
        return res.status(304).end();
      }

      return sendSuccess(res, data, 'Active banners retrieved', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new BannerController();
