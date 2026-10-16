'use strict';

const adminReportsService = require('../services/admin-reports.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminReportsController {
  constructor(reportsService = adminReportsService) {
    this.reportsService = reportsService;

    this.getReportCatalog = this.getReportCatalog.bind(this);
    this.getOperationalSummary = this.getOperationalSummary.bind(this);
    this.getBookingsReport = this.getBookingsReport.bind(this);
    this.getCustomersReport = this.getCustomersReport.bind(this);
    this.getPartnersReport = this.getPartnersReport.bind(this);
    this.getVehiclesReport = this.getVehiclesReport.bind(this);
    this.getPaymentsReport = this.getPaymentsReport.bind(this);
    this.getRefundsReport = this.getRefundsReport.bind(this);
    this.getCommissionsReport = this.getCommissionsReport.bind(this);
    this.getWalletsReport = this.getWalletsReport.bind(this);
    this.getPayoutsReport = this.getPayoutsReport.bind(this);
    this.getKycReport = this.getKycReport.bind(this);
    this.getSupportReport = this.getSupportReport.bind(this);
    this.getDisputesReport = this.getDisputesReport.bind(this);
    this.getNotificationsReport = this.getNotificationsReport.bind(this);
    this.exportReport = this.exportReport.bind(this);
  }

  _buildAuditContext(req, res, permission) {
    return {
      actorId: req.user ? req.user.id : 'unknown-admin',
      actorRole: req.user ? req.user.role : 'ADMIN',
      permission,
      requestId: req.id || (res.locals && res.locals.requestId) || null,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
      user: req.user,
    };
  }

  /**
   * GET /api/v1/admin/reports
   * Returns metadata catalog of supported reports.
   */
  async getReportCatalog(req, res, next) {
    try {
      const data = this.reportsService.getReportCatalog();
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/summary
   * Returns aggregated platform operational summary metrics.
   */
  async getOperationalSummary(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getOperationalSummary(req.query, ctx);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/bookings
   */
  async getBookingsReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getBookingsReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/customers
   */
  async getCustomersReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getCustomersReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/partners
   */
  async getPartnersReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getPartnersReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/vehicles
   */
  async getVehiclesReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getVehiclesReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/payments
   */
  async getPaymentsReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getPaymentsReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/refunds
   */
  async getRefundsReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getRefundsReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/commissions
   * Internal company data - requires commissions.read or SUPER_ADMIN
   */
  async getCommissionsReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'commissions.read');
      const data = await this.reportsService.getCommissionsReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/wallets
   */
  async getWalletsReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getWalletsReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/payouts
   */
  async getPayoutsReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getPayoutsReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/kyc
   */
  async getKycReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getKycReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/support
   */
  async getSupportReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getSupportReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/disputes
   */
  async getDisputesReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getDisputesReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/reports/notifications
   */
  async getNotificationsReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.read');
      const data = await this.reportsService.getNotificationsReport(req.query, ctx);
      return sendSuccess(res, data.items, {
        ...data.pagination,
        pagination: data.pagination,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/reports/export
   * Exports data in CSV format with formula injection defense.
   */
  async exportReport(req, res, next) {
    try {
      const ctx = this._buildAuditContext(req, res, 'reports.export');
      const data = await this.reportsService.exportReport(req.body, ctx);

      if (req.query.raw === 'true' || req.headers.accept === 'text/csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${data.filename}"`);
        return res.status(200).send(data.csv);
      }

      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

const instance = new AdminReportsController();
instance.AdminReportsController = AdminReportsController;

module.exports = instance;
