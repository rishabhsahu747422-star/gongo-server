'use strict';

const adminCustomerService = require('../services/admin-customer.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminCustomerController {
  /**
   * Helper to build audit context from request state.
   * @private
   */
  _buildAuditContext(req, res, permission) {
    return {
      actorId: req.user ? req.user.id : 'unknown-admin',
      actorRole: req.user ? req.user.role : 'ADMIN',
      permission,
      requestId: req.id || (res.locals && res.locals.requestId) || null,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    };
  }

  /**
   * GET /api/v1/admin/customers
   * Lists customers with search, filtering, and bounded pagination.
   */
  async listCustomers(req, res, next) {
    try {
      const data = await adminCustomerService.listCustomers(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/customers/:id
   * Retrieves single customer details + booking/payment/document/address summaries.
   */
  async getCustomerDetail(req, res, next) {
    try {
      const data = await adminCustomerService.getCustomerDetail(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/customers/:id/status
   * Updates customer active/inactive status with deactivation safety and audit logging.
   */
  async updateCustomerStatus(req, res, next) {
    try {
      const auditCtx = this._buildAuditContext(req, res, 'customers.update');
      const data = await adminCustomerService.updateCustomerStatus(
        req.params.id,
        req.body,
        auditCtx,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/customers/:id/bookings
   * Retrieves paginated bookings history for a specific customer.
   */
  async getCustomerBookings(req, res, next) {
    try {
      const data = await adminCustomerService.getCustomerBookings(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/customers/:id/payments
   * Retrieves paginated payments history for a specific customer.
   */
  async getCustomerPayments(req, res, next) {
    try {
      const data = await adminCustomerService.getCustomerPayments(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/customers/:id/documents
   * Retrieves customer identity and KYC documents metadata safely.
   */
  async getCustomerDocuments(req, res, next) {
    try {
      const data = await adminCustomerService.getCustomerDocuments(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/customers/:id/addresses
   * Retrieves customer saved addresses.
   */
  async getCustomerAddresses(req, res, next) {
    try {
      const data = await adminCustomerService.getCustomerAddresses(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/customers/:id/verifications
   * Retrieves identity verification attempts and provider status for customer.
   */
  async getCustomerVerifications(req, res, next) {
    try {
      const data = await adminCustomerService.getCustomerVerifications(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/customers/:id/support-tickets
   * Retrieves support tickets created by customer.
   */
  async getCustomerSupportTickets(req, res, next) {
    try {
      const data = await adminCustomerService.getCustomerSupportTickets(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/customers/:id/activity
   * Retrieves administrative audit actions performed on the customer.
   */
  async getCustomerActivity(req, res, next) {
    try {
      const data = await adminCustomerService.getCustomerActivity(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminCustomerController();
