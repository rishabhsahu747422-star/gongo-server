'use strict';

const adminDashboardService = require('../../src/services/admin-dashboard.service');
const adminDashboardRepository = require('../../src/repositories/admin-dashboard.repository');
const { ValidationError } = require('../../src/errors');

describe('Unit: AdminDashboardService', () => {
  describe('parseDateRange', () => {
    it('parses "today" preset correctly', () => {
      const res = adminDashboardService.parseDateRange({ preset: 'today' });
      expect(res.preset).toBe('today');
      expect(res.startDate).toBeInstanceOf(Date);
      expect(res.endDate).toBeInstanceOf(Date);
      expect(res.endDate.getTime() - res.startDate.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it('parses "yesterday" preset correctly', () => {
      const res = adminDashboardService.parseDateRange({ preset: 'yesterday' });
      expect(res.preset).toBe('yesterday');
      expect(res.startDate).toBeInstanceOf(Date);
      expect(res.endDate).toBeInstanceOf(Date);
      expect(res.endDate.getTime() - res.startDate.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it('parses "7d" preset correctly', () => {
      const res = adminDashboardService.parseDateRange({ preset: '7d' });
      expect(res.preset).toBe('7d');
      expect(res.startDate).toBeInstanceOf(Date);
      expect(res.endDate).toBeInstanceOf(Date);
      expect(res.endDate.getTime() - res.startDate.getTime()).toBe(8 * 24 * 60 * 60 * 1000);
    });

    it('parses "30d" preset correctly', () => {
      const res = adminDashboardService.parseDateRange({ preset: '30d' });
      expect(res.preset).toBe('30d');
      expect(res.startDate).toBeInstanceOf(Date);
      expect(res.endDate).toBeInstanceOf(Date);
      expect(res.endDate.getTime() - res.startDate.getTime()).toBe(31 * 24 * 60 * 60 * 1000);
    });

    it('parses "current_month" preset correctly', () => {
      const res = adminDashboardService.parseDateRange({ preset: 'current_month' });
      expect(res.preset).toBe('current_month');
      expect(res.startDate.getUTCDate()).toBe(1);
      expect(res.endDate.getUTCDate()).toBe(1);
      expect(res.startDate < res.endDate).toBe(true);
    });

    it('parses "previous_month" preset correctly', () => {
      const res = adminDashboardService.parseDateRange({ preset: 'previous_month' });
      expect(res.preset).toBe('previous_month');
      expect(res.startDate.getUTCDate()).toBe(1);
      expect(res.endDate.getUTCDate()).toBe(1);
      expect(res.startDate < res.endDate).toBe(true);
    });

    it('throws ValidationError on unknown preset', () => {
      expect(() => {
        adminDashboardService.parseDateRange({ preset: 'invalid_preset' });
      }).toThrow(ValidationError);
    });

    it('parses custom date range with YYYY-MM-DD and makes end date exclusive next-day', () => {
      const res = adminDashboardService.parseDateRange({
        startDate: '2026-09-01',
        endDate: '2026-09-10',
      });
      expect(res.preset).toBe('custom');
      expect(res.startDate.toISOString()).toContain('2026-09-01T00:00:00.000Z');
      expect(res.endDate.toISOString()).toContain('2026-09-11T00:00:00.000Z');
    });

    it('parses full ISO-8601 timestamps', () => {
      const res = adminDashboardService.parseDateRange({
        startDate: '2026-09-01T10:00:00.000Z',
        endDate: '2026-09-05T18:00:00.000Z',
      });
      expect(res.preset).toBe('custom');
      expect(res.startDate.toISOString()).toBe('2026-09-01T10:00:00.000Z');
      expect(res.endDate.toISOString()).toBe('2026-09-05T18:00:00.000Z');
    });

    it('throws ValidationError if only startDate provided', () => {
      expect(() => {
        adminDashboardService.parseDateRange({ startDate: '2026-09-01' });
      }).toThrow(ValidationError);
    });

    it('throws ValidationError if only endDate provided', () => {
      expect(() => {
        adminDashboardService.parseDateRange({ endDate: '2026-09-10' });
      }).toThrow(ValidationError);
    });

    it('throws ValidationError on malformed startDate format', () => {
      expect(() => {
        adminDashboardService.parseDateRange({
          startDate: '01/09/2026',
          endDate: '2026-09-10',
        });
      }).toThrow(ValidationError);
    });

    it('throws ValidationError on malformed endDate format', () => {
      expect(() => {
        adminDashboardService.parseDateRange({
          startDate: '2026-09-01',
          endDate: 'not-a-date',
        });
      }).toThrow(ValidationError);
    });

    it('throws ValidationError if startDate is after endDate', () => {
      expect(() => {
        adminDashboardService.parseDateRange({
          startDate: '2026-09-20',
          endDate: '2026-09-10',
        });
      }).toThrow(ValidationError);
    });

    it('throws ValidationError if range exceeds 366 days', () => {
      expect(() => {
        adminDashboardService.parseDateRange({
          startDate: '2024-01-01',
          endDate: '2026-01-01',
        });
      }).toThrow(ValidationError);
    });

    it('returns nulls when no date parameters and requireRange=false', () => {
      const res = adminDashboardService.parseDateRange({}, false);
      expect(res.startDate).toBeNull();
      expect(res.endDate).toBeNull();
      expect(res.preset).toBeNull();
    });

    it('returns default 30d range when no date parameters and requireRange=true', () => {
      const res = adminDashboardService.parseDateRange({}, true);
      expect(res.preset).toBe('30d');
      expect(res.startDate).toBeInstanceOf(Date);
      expect(res.endDate).toBeInstanceOf(Date);
    });
  });

  describe('getOverview', () => {
    beforeEach(() => {
      jest.restoreAllMocks();
    });

    it('aggregates operational stats and recent activity', async () => {
      const mockStats = {
        customers: { total: 100, active: 80, newInRange: 10 },
        partners: {
          total: 20,
          active: 18,
          online: 12,
          offline: 6,
          verified: 15,
          pendingKyc: 3,
        },
        vehicles: { total: 50, active: 40, idle: 25, booked: 15 },
        bookings: {
          total: 200,
          upcoming: 10,
          active: 20,
          completed: 160,
          cancelled: 10,
          inRange: 15,
        },
        financial: {
          grossVolume: 50000,
          pendingVolume: 2000,
          totalPayments: 200,
          successfulPayments: 180,
          totalCommission: 5000,
          completedPayouts: 30000,
          pendingPayouts: 5000,
        },
        support: { total: 30, openTickets: 5, resolvedTickets: 25 },
      };

      const mockActivity = [
        {
          id: 'act-1',
          action: 'KYC_APPROVE',
          actorRole: 'ADMIN',
          createdAt: '2026-09-25T10:00:00.000Z',
        },
      ];

      jest.spyOn(adminDashboardRepository, 'getOverviewStats').mockResolvedValue(mockStats);
      jest.spyOn(adminDashboardRepository, 'getRecentActivity').mockResolvedValue(mockActivity);

      const res = await adminDashboardService.getOverview({ preset: '7d' });

      expect(res.customers.total).toBe(100);
      expect(res.partners.total).toBe(20);
      expect(res.vehicles.total).toBe(50);
      expect(res.bookings.total).toBe(200);
      expect(res.financial.grossVolume).toBe(50000);
      expect(res.support.total).toBe(30);
      expect(res.recentActivity).toHaveLength(1);
      expect(res.filter.preset).toBe('7d');
    });
  });

  describe('getStats', () => {
    beforeEach(() => {
      jest.restoreAllMocks();
    });

    it('returns domain stats and breakdowns', async () => {
      const mockDomainStats = {
        overview: { customers: { total: 50 } },
        breakdowns: {
          partnerKyc: { VERIFIED: 10, PENDING: 2 },
          vehicleCategories: { SEDAN: 20, SUV: 10 },
          vehicleRentalStatus: { IDLE: 15, ACTIVE: 15 },
          bookingStatus: { COMPLETED: 80, CANCELLED: 5 },
          bookingPaymentStatus: { COMPLETED: 80, PENDING: 5 },
          supportStatus: { OPEN: 2, RESOLVED: 10 },
          supportPriority: { HIGH: 3, MEDIUM: 9 },
        },
      };

      jest.spyOn(adminDashboardRepository, 'getDomainStats').mockResolvedValue(mockDomainStats);

      const res = await adminDashboardService.getStats({ preset: 'today' });

      expect(res.overview.customers.total).toBe(50);
      expect(res.breakdowns.partnerKyc.VERIFIED).toBe(10);
      expect(res.breakdowns.bookingStatus.COMPLETED).toBe(80);
      expect(res.filter.preset).toBe('today');
    });
  });

  describe('getRevenue', () => {
    beforeEach(() => {
      jest.restoreAllMocks();
    });

    it('returns financial metrics and daily trends', async () => {
      const mockRevenue = {
        summary: {
          grossVolume: 125000,
          pendingVolume: 5000,
          totalPayments: 100,
          successfulPayments: 95,
          pendingPayments: 3,
          failedPayments: 1,
          cancelledPayments: 1,
          totalCommission: 12500,
          settledCommission: 10000,
          completedPayouts: 80000,
          pendingPayouts: 15000,
        },
        trends: [
          { date: '2026-09-24', totalPayments: 40, successfulPayments: 38, grossAmount: 50000 },
          { date: '2026-09-25', totalPayments: 60, successfulPayments: 57, grossAmount: 75000 },
        ],
      };

      jest.spyOn(adminDashboardRepository, 'getRevenueMetrics').mockResolvedValue(mockRevenue);

      const res = await adminDashboardService.getRevenue({});

      expect(res.summary.grossVolume).toBe(125000);
      expect(res.trends).toHaveLength(2);
      expect(res.filter.preset).toBe('30d');
    });
  });

  describe('getBookings', () => {
    beforeEach(() => {
      jest.restoreAllMocks();
    });

    it('returns booking metrics and daily trends', async () => {
      const mockBookings = {
        summary: {
          total: 100,
          upcoming: 10,
          active: 20,
          completed: 65,
          cancelled: 5,
          completionRate: 65.0,
        },
        trends: [
          { date: '2026-09-24', total: 40, completed: 30, cancelled: 2 },
          { date: '2026-09-25', total: 60, completed: 35, cancelled: 3 },
        ],
      };

      jest.spyOn(adminDashboardRepository, 'getBookingMetrics').mockResolvedValue(mockBookings);

      const res = await adminDashboardService.getBookings({});

      expect(res.summary.total).toBe(100);
      expect(res.summary.completionRate).toBe(65.0);
      expect(res.trends).toHaveLength(2);
    });
  });

  describe('getActivity', () => {
    beforeEach(() => {
      jest.restoreAllMocks();
    });

    it('returns paginated activity', async () => {
      const mockActivity = [
        { id: 'act-1', action: 'KYC_APPROVE', actorRole: 'ADMIN', createdAt: '2026-09-25T10:00:00.000Z' },
        { id: 'act-2', action: 'VEHICLE_APPROVE', actorRole: 'ADMIN', createdAt: '2026-09-25T11:00:00.000Z' },
      ];

      jest.spyOn(adminDashboardRepository, 'getRecentActivity').mockResolvedValue(mockActivity);

      const res = await adminDashboardService.getActivity({ limit: '10', offset: '0' });

      expect(res.activity).toHaveLength(2);
      expect(res.pagination.limit).toBe(10);
      expect(res.pagination.offset).toBe(0);
      expect(res.pagination.count).toBe(2);
    });

    it('throws ValidationError on invalid limit or offset', async () => {
      await expect(adminDashboardService.getActivity({ limit: '-5' })).rejects.toThrow(ValidationError);
      await expect(adminDashboardService.getActivity({ offset: '-1' })).rejects.toThrow(ValidationError);
      await expect(adminDashboardService.getActivity({ limit: 'abc' })).rejects.toThrow(ValidationError);
    });
  });
});
