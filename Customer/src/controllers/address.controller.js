'use strict';

const addressService = require('../services/address.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * AddressController handles HTTP requests for customer saved addresses.
 * Stays thin by delegating all business logic to AddressService.
 *
 * Security: userId is ALWAYS sourced from req.user.id (set by auth middleware),
 * never from req.params, req.query, or req.body.
 */
class AddressController {
  /**
   * POST /api/v1/customers/me/addresses
   */
  async createAddress(req, res, next) {
    try {
      const address = await addressService.createAddress(req.user.id, req.body);
      return sendSuccess(res, address, 'Address created successfully', HTTP_STATUS.CREATED);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/addresses
   */
  async listAddresses(req, res, next) {
    try {
      const addresses = await addressService.listAddresses(req.user.id);
      return sendSuccess(res, addresses, 'Addresses retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/addresses/:id
   */
  async getAddress(req, res, next) {
    try {
      const address = await addressService.getAddress(req.user.id, req.params.id);
      return sendSuccess(res, address, 'Address retrieved successfully', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/customers/me/addresses/:id
   */
  async updateAddress(req, res, next) {
    try {
      const address = await addressService.updateAddress(req.user.id, req.params.id, req.body);
      return sendSuccess(res, address, 'Address updated successfully', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/customers/me/addresses/:id
   */
  async deleteAddress(req, res, next) {
    try {
      await addressService.deleteAddress(req.user.id, req.params.id);
      return sendSuccess(res, null, 'Address deleted successfully', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/customers/me/addresses/:id/default
   */
  async setDefaultAddress(req, res, next) {
    try {
      const address = await addressService.setDefaultAddress(req.user.id, req.params.id);
      return sendSuccess(res, address, 'Default address updated successfully', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AddressController();
