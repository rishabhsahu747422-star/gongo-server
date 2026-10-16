'use strict';

const adminDashboardRepository = require('../repositories/admin-dashboard.repository');
const { ValidationError } = require('../errors');
const logger = require('../config/logger');

const VALID_PRESETS = new Set([
  'today',
  'yesterday',
  '7d',
  'last_7_days',
  'last 7 days',
  '30d',
  'last_30_days',
  'last 30 days',
  'month',
  'current_month',
  'this_month',
  'previous_month',
  'last_month',
]);

class AdminDashboardService {
  /**
   * Strictly parses and validates query parameters into inclusive startDate and exclusive endDate.
   *
   * @param {object} [query={}]
   * @param {boolean} [requireRange=false] If true, falls back to '30d' when no params provided.
   * @returns {{ startDate: Date|null, endDate: Date|null, preset: string|null }}
   */
  parseDateRange(query = {}, requireRange = false) {
    const rawPreset = query.preset || query.range;
    const rawStart = query.startDate || query.from;
    const rawEnd = query.endDate || query.to;

    if (rawPreset) {
      const normalizedPreset = String(rawPreset).toLowerCase().trim();
      if (!VALID_PRESETS.has(normalizedPreset)) {
        throw new ValidationError(
          `Unknown date preset: '${rawPreset}'. Allowed presets: today, yesterday, 7d, 30d, current_month, previous_month`,
          [{ field: 'preset', message: 'Invalid preset value' }],
        );
      }

      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth();
      const date = now.getUTCDate();

      let startDate;
      let endDate;

      switch (normalizedPreset) {
        case 'today':
          startDate = new Date(Date.UTC(year, month, date, 0, 0, 0, 0));
          endDate = new Date(Date.UTC(year, month, date + 1, 0, 0, 0, 0));
          break;
        case 'yesterday':
          startDate = new Date(Date.UTC(year, month, date - 1, 0, 0, 0, 0));
          endDate = new Date(Date.UTC(year, month, date, 0, 0, 0, 0));
          break;
        case '7d':
        case 'last_7_days':
        case 'last 7 days':
          startDate = new Date(Date.UTC(year, month, date - 7, 0, 0, 0, 0));
          endDate = new Date(Date.UTC(year, month, date + 1, 0, 0, 0, 0));
          break;
        case '30d':
        case 'last_30_days':
        case 'last 30 days':
          startDate = new Date(Date.UTC(year, month, date - 30, 0, 0, 0, 0));
          endDate = new Date(Date.UTC(year, month, date + 1, 0, 0, 0, 0));
          break;
        case 'month':
        case 'current_month':
        case 'this_month':
          startDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
          endDate = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
          break;
        case 'previous_month':
        case 'last_month':
          startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
          endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
          break;
        default:
          startDate = null;
          endDate = null;
      }

      return { startDate, endDate, preset: normalizedPreset };
    }

    if (rawStart || rawEnd) {
      if (!rawStart) {
        throw new ValidationError('startDate is required when endDate is provided', [
          { field: 'startDate', message: 'startDate parameter is required' },
        ]);
      }
      if (!rawEnd) {
        throw new ValidationError('endDate is required when startDate is provided', [
          { field: 'endDate', message: 'endDate parameter is required' },
        ]);
      }

      const strStart = String(rawStart).trim();
      const strEnd = String(rawEnd).trim();

      const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?)?$/i;
      if (!isoDatePattern.test(strStart)) {
        throw new ValidationError('Invalid startDate format. Expected YYYY-MM-DD or ISO 8601', [
          { field: 'startDate', message: 'Invalid format' },
        ]);
      }
      if (!isoDatePattern.test(strEnd)) {
        throw new ValidationError('Invalid endDate format. Expected YYYY-MM-DD or ISO 8601', [
          { field: 'endDate', message: 'Invalid format' },
        ]);
      }

      const parsedStart = new Date(strStart);
      const parsedEnd = new Date(strEnd);

      if (Number.isNaN(parsedStart.getTime())) {
        throw new ValidationError('Invalid startDate: unable to parse date value', [
          { field: 'startDate', message: 'Unparseable date' },
        ]);
      }
      if (Number.isNaN(parsedEnd.getTime())) {
        throw new ValidationError('Invalid endDate: unable to parse date value', [
          { field: 'endDate', message: 'Unparseable date' },
        ]);
      }

      let adjustedEnd = parsedEnd;
      if (/^\d{4}-\d{2}-\d{2}$/.test(strEnd)) {
        // Exclusive boundary for date-only query encompasses the full day
        adjustedEnd = new Date(parsedEnd.getTime() + 24 * 60 * 60 * 1000);
      }

      if (parsedStart >= adjustedEnd) {
        throw new ValidationError('startDate must be before endDate', [
          { field: 'startDate', message: 'startDate must precede endDate' },
        ]);
      }

      const rangeDurationMs = adjustedEnd.getTime() - parsedStart.getTime();
      const maxAllowedMs = 366 * 24 * 60 * 60 * 1000;
      if (rangeDurationMs > maxAllowedMs) {
        throw new ValidationError('Requested date range exceeds maximum allowed limit of 366 days', [
          { field: 'dateRange', message: 'Exceeds 366 days' },
        ]);
      }

      return {
        startDate: parsedStart,
        endDate: adjustedEnd,
        preset: 'custom',
      };
    }

    if (requireRange) {
      // Default to last 30 days for trend-series APIs if no parameters supplied
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth();
      const date = now.getUTCDate();

      const startDate = new Date(Date.UTC(year, month, date - 30, 0, 0, 0, 0));
      const endDate = new Date(Date.UTC(year, month, date + 1, 0, 0, 0, 0));

      return { startDate, endDate, preset: '30d' };
    }

    return { startDate: null, endDate: null, preset: null };
  }

  /**
   * GET /api/v1/admin/dashboard
   * Returns comprehensive cross-domain operational overview and recent administrative activity.
   *
   * @param {object} [query={}]
   * @returns {Promise<object>}
   */
  async getOverview(query = {}) {
    const { startDate, endDate, preset } = this.parseDateRange(query, false);

    logger.info('Fetching admin dashboard overview', {
      preset,
      startDate: startDate ? startDate.toISOString() : null,
      endDate: endDate ? endDate.toISOString() : null,
    });

    const [stats, recentActivity] = await Promise.all([
      adminDashboardRepository.getOverviewStats(startDate, endDate),
      adminDashboardRepository.getRecentActivity(10, 0),
    ]);

    const overview = {
      totalBookings: stats.bookings?.total ?? 0,
      activeBookings: stats.bookings?.active ?? 0,
      activePartners: stats.partners?.active ?? 0,
      totalCustomers: stats.customers?.total ?? 0,
      totalVehicles: stats.vehicles?.total ?? 0,
      activeVehicles: stats.vehicles?.active ?? stats.vehicles?.idle ?? 0,
      totalRevenue: stats.payments?.grossVolume ?? stats.financial?.grossVolume ?? 0,
      platformCommission: stats.commission?.totalCommission ?? stats.financial?.platformCommission ?? 0,
      todayBookings: stats.bookings?.inRange ?? stats.bookings?.today ?? 0,
      todayRevenue: stats.financial?.todayGrossVolume ?? 0,
      pendingKycRequests: stats.partners?.pendingKyc ?? 0,
      pendingRefunds: stats.refunds?.pendingAmount ?? 0,
    };

    const domainStats = {
      customers: stats.customers || {},
      partners: stats.partners || {},
      shops: stats.shops || {},
      vehicles: stats.vehicles || {},
      bookings: stats.bookings || {},
    };

    return {
      customers: stats.customers || {},
      partners: stats.partners || {},
      shops: stats.shops || {},
      vehicles: stats.vehicles || {},
      bookings: stats.bookings || {},
      domainStats,
      payments: stats.payments || {},
      refunds: stats.refunds || {},
      revenue: stats.revenue || {},
      commission: stats.commission || {},
      wallets: stats.wallets || {},
      payouts: stats.payouts || {},
      support: stats.support || {},
      disputes: stats.disputes || {},
      overview,
      financial: stats.financial || {},
      recentActivity,
      filter: {
        preset,
        startDate: startDate ? startDate.toISOString() : null,
        endDate: endDate ? endDate.toISOString() : null,
      },
    };
  }

  /**
   * GET /api/v1/admin/dashboard/stats
   * Returns detailed domain statistics and status-wise breakdowns.
   *
   * @param {object} [query={}]
   * @returns {Promise<object>}
   */
  async getStats(query = {}) {
    const { startDate, endDate, preset } = this.parseDateRange(query, false);

    logger.info('Fetching admin dashboard domain statistics', {
      preset,
      startDate: startDate ? startDate.toISOString() : null,
      endDate: endDate ? endDate.toISOString() : null,
    });

    const stats = await adminDashboardRepository.getDomainStats(startDate, endDate);

    return {
      ...stats,
      filter: {
        preset,
        startDate: startDate ? startDate.toISOString() : null,
        endDate: endDate ? endDate.toISOString() : null,
      },
    };
  }

  /**
   * GET /api/v1/admin/dashboard/revenue
   * Returns financial volume metrics and daily revenue trend series.
   *
   * @param {object} [query={}]
   * @returns {Promise<object>}
   */
  async getRevenue(query = {}) {
    const { startDate, endDate, preset } = this.parseDateRange(query, true);

    logger.info('Fetching admin dashboard revenue metrics', {
      preset,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    });

    const data = await adminDashboardRepository.getRevenueMetrics(startDate, endDate);

    return {
      ...data,
      filter: {
        preset,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
    };
  }

  /**
   * GET /api/v1/admin/dashboard/bookings
   * Returns booking metrics and daily booking trend series.
   *
   * @param {object} [query={}]
   * @returns {Promise<object>}
   */
  async getBookings(query = {}) {
    const { startDate, endDate, preset } = this.parseDateRange(query, true);

    logger.info('Fetching admin dashboard booking metrics', {
      preset,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    });

    const data = await adminDashboardRepository.getBookingMetrics(startDate, endDate);

    return {
      ...data,
      filter: {
        preset,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
    };
  }

  /**
   * GET /api/v1/admin/dashboard/activity
   * Returns paginated recent administrative actions.
   *
   * @param {object} [query={}]
   * @returns {Promise<object>}
   */
  async getActivity(query = {}) {
    const rawLimit = query.limit !== undefined ? parseInt(query.limit, 10) : 10;
    const rawOffset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    if (Number.isNaN(rawLimit) || rawLimit < 1) {
      throw new ValidationError('limit must be a positive integer between 1 and 50', [
        { field: 'limit', message: 'Invalid limit' },
      ]);
    }

    if (Number.isNaN(rawOffset) || rawOffset < 0) {
      throw new ValidationError('offset must be a non-negative integer', [
        { field: 'offset', message: 'Invalid offset' },
      ]);
    }

    const limit = Math.min(rawLimit, 50);
    const offset = rawOffset;

    const activity = await adminDashboardRepository.getRecentActivity(limit, offset);

    return {
      activity,
      pagination: {
        limit,
        offset,
        count: activity.length,
      },
    };
  }

  /**
   * GET /api/v1/admin/dashboard/category-distribution
   * Returns vehicle category distribution.
   */
  async getCategoryDistribution() {
    const distribution = await adminDashboardRepository.getCategoryDistribution();
    return { distribution };
  }

  /**
   * GET /api/v1/admin/dashboard/urgent-alerts
   * Returns counts of pending partner KYC and vehicle documents.
   */
  async getUrgentAlerts() {
    const alerts = await adminDashboardRepository.getUrgentAlerts();
    return alerts;
  }
}

module.exports = new AdminDashboardService();
