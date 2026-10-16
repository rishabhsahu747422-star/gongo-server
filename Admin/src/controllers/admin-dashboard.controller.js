'use strict';

const adminDashboardService = require('../services/admin-dashboard.service');
const { sendSuccess } = require('../utils/response');

class AdminDashboardController {
  /**
   * GET /api/v1/admin/dashboard
   * Returns cross-domain platform overview and recent administrative activity.
   */
  async getOverview(req, res, next) {
    try {
      const data = await adminDashboardService.getOverview(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/dashboard/stats
   * Returns domain-specific metrics and status breakdowns.
   */
  async getStats(req, res, next) {
    try {
      const data = await adminDashboardService.getStats(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/dashboard/revenue
   * Returns financial volumes, platform commissions, payouts, and revenue trend series.
   */
  async getRevenue(req, res, next) {
    try {
      const data = await adminDashboardService.getRevenue(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/dashboard/bookings
   * Returns booking volumes, completion rates, and booking trend series.
   */
  async getBookings(req, res, next) {
    try {
      const data = await adminDashboardService.getBookings(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/dashboard/activity
   * Returns paginated recent administrative actions.
   */
  async getActivity(req, res, next) {
    try {
      const data = await adminDashboardService.getActivity(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/dashboard/category-distribution
   */
  async getCategoryDistribution(req, res, next) {
    try {
      const data = await adminDashboardService.getCategoryDistribution();
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/dashboard/urgent-alerts
   */
  async getUrgentAlerts(req, res, next) {
    try {
      const data = await adminDashboardService.getUrgentAlerts();
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminDashboardController();
