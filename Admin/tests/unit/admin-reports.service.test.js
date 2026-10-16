'use strict';

const adminReportsService = require('../../src/services/admin-reports.service');
const { PERMISSIONS } = require('../../src/constants/permissions');

describe('Unit: AdminReportsService', () => {
  let mockReportsRepo;
  let mockAudit;
  let service;

  beforeEach(() => {
    mockReportsRepo = {
      getOperationalSummary: jest.fn(),
      getBookingsReport: jest.fn(),
      getCustomersReport: jest.fn(),
      getPartnersReport: jest.fn(),
      getVehiclesReport: jest.fn(),
      getPaymentsReport: jest.fn(),
      getRefundsReport: jest.fn(),
      getCommissionsReport: jest.fn(),
      getWalletsReport: jest.fn(),
      getPayoutsReport: jest.fn(),
      getKycReport: jest.fn(),
      getSupportReport: jest.fn(),
      getDisputesReport: jest.fn(),
      getNotificationsReport: jest.fn(),
    };

    mockAudit = {
      recordAction: jest.fn().mockResolvedValue({}),
    };

    service = new adminReportsService.AdminReportsService(mockReportsRepo, mockAudit);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('1. getReportCatalog', () => {
    it('returns complete array of supported report definitions', () => {
      const catalog = service.getReportCatalog();
      expect(Array.isArray(catalog)).toBe(true);
      expect(catalog.length).toBeGreaterThanOrEqual(14);

      const keys = catalog.map((r) => r.key);
      expect(keys).toContain('summary');
      expect(keys).toContain('bookings');
      expect(keys).toContain('customers');
      expect(keys).toContain('partners');
      expect(keys).toContain('vehicles');
      expect(keys).toContain('payments');
      expect(keys).toContain('refunds');
      expect(keys).toContain('commissions');
      expect(keys).toContain('wallets');
      expect(keys).toContain('payouts');
      expect(keys).toContain('kyc');
      expect(keys).toContain('support');
      expect(keys).toContain('disputes');
      expect(keys).toContain('notifications');
    });
  });

  describe('2. Date Range & Parameter Validations', () => {
    it('rejects invalid ISO date format', async () => {
      await expect(service.getBookingsReport({ startDate: 'not-a-date' }))
        .rejects.toThrow('Invalid startDate: must be a valid ISO-8601 date string');
    });

    it('rejects date range where startDate is after endDate', async () => {
      await expect(service.getBookingsReport({
        startDate: '2026-09-10T00:00:00Z',
        endDate: '2026-09-01T00:00:00Z',
      })).rejects.toThrow('startDate must be before or equal to endDate');
    });

    it('rejects date range exceeding 90 days limit for operational reports', async () => {
      await expect(service.getBookingsReport({
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-06-01T00:00:00Z',
      })).rejects.toThrow('Date range exceeds maximum allowed limit of 90 days');
    });

    it('rejects malformed partner UUID filter', async () => {
      await expect(service.getBookingsReport({ partnerId: 'not-a-uuid' }))
        .rejects.toThrow('Invalid partnerId: must be a valid UUID');
    });
  });

  describe('3. Operational Summary', () => {
    it('successfully fetches summary and records audit action', async () => {
      mockReportsRepo.getOperationalSummary.mockResolvedValueOnce({
        customers: { total: 100 },
        bookings: { total: 50 },
      });

      const res = await service.getOperationalSummary({}, { actorId: 'admin-1' });
      expect(res.customers.total).toBe(100);
      expect(mockReportsRepo.getOperationalSummary).toHaveBeenCalled();
      expect(mockAudit.recordAction).toHaveBeenCalledWith(expect.objectContaining({
        action: 'REPORT_VIEWED',
        targetResourceId: 'summary',
      }));
    });
  });

  describe('4. Commission Report Security (Internal Company Data)', () => {
    it('throws ForbiddenError when user lacks commissions.read permission', async () => {
      const context = {
        user: { role: 'ADMIN', permissions: [PERMISSIONS.REPORTS_READ] },
      };

      await expect(service.getCommissionsReport({}, context))
        .rejects.toThrow('Insufficient permissions to view internal commission data');
      expect(mockReportsRepo.getCommissionsReport).not.toHaveBeenCalled();
    });

    it('allows access when user has commissions.read permission', async () => {
      const context = {
        user: { role: 'ADMIN', permissions: [PERMISSIONS.COMMISSIONS_READ] },
      };
      mockReportsRepo.getCommissionsReport.mockResolvedValueOnce({ items: [] });

      await service.getCommissionsReport({}, context);
      expect(mockReportsRepo.getCommissionsReport).toHaveBeenCalled();
      expect(mockAudit.recordAction).toHaveBeenCalledWith(expect.objectContaining({
        action: 'REPORT_FINANCIAL_VIEWED',
        targetResourceId: 'commissions',
      }));
    });

    it('allows access when user has SUPER_ADMIN role', async () => {
      const context = {
        user: { role: 'SUPER_ADMIN', permissions: [] },
      };
      mockReportsRepo.getCommissionsReport.mockResolvedValueOnce({ items: [] });

      await service.getCommissionsReport({}, context);
      expect(mockReportsRepo.getCommissionsReport).toHaveBeenCalled();
    });
  });

  describe('5. exportReport (CSV Export)', () => {
    it('rejects export if reportType is missing', async () => {
      await expect(service.exportReport({}))
        .rejects.toThrow('reportType is required');
    });

    it('rejects export for unsupported reportType', async () => {
      await expect(service.exportReport({ reportType: 'unknown_type' }))
        .rejects.toThrow("Unsupported reportType: 'unknown_type'");
    });

    it('rejects export for unsupported format like PDF', async () => {
      await expect(service.exportReport({ reportType: 'bookings', format: 'pdf' }))
        .rejects.toThrow("Only 'csv' format is supported for data export");
    });

    it('denies commission export when user lacks commissions.read permission', async () => {
      const context = {
        user: { role: 'ADMIN', permissions: [PERMISSIONS.REPORTS_EXPORT] },
      };

      await expect(service.exportReport({ reportType: 'commissions' }, context))
        .rejects.toThrow('Insufficient permissions to export internal commission data');
    });

    it('successfully generates CSV for bookings report with formula protection', async () => {
      mockReportsRepo.getBookingsReport.mockResolvedValueOnce({
        items: [
          {
            bookingId: 'b0000000-0000-0000-0000-000000000001',
            bookingNumber: '=cmd|calc!A0', // formula injection attempt
            customerName: 'Alice',
            customerPhone: '+919876543210',
            partnerBusinessName: 'Swift, Rentals',
            vehicleRegistration: 'MH01AB1234',
            vehicleBrand: 'Tata',
            vehicleModel: 'Nexon',
            city: 'Mumbai',
            bookingStatus: 'COMPLETED',
            paymentStatus: 'PAID',
            totalAmount: 4500,
            durationHours: 24,
            startDatetime: '2026-09-01T10:00:00.000Z',
            endDatetime: '2026-09-02T10:00:00.000Z',
            cancellationReason: null,
            createdAt: '2026-08-30T10:00:00.000Z',
          },
        ],
      });

      const res = await service.exportReport({ reportType: 'bookings' }, { actorId: 'admin-1' });

      expect(res.filename).toMatch(/^report-bookings-\d{4}-\d{2}-\d{2}T.*\.csv$/);
      expect(res.rowCount).toBe(1);
      expect(res.csv).toContain('Booking ID,Booking Number,Customer Name');
      // Formula injection must be safely escaped with single quote
      expect(res.csv).toContain("'=cmd|calc!A0");
      // Values with commas must be quoted
      expect(res.csv).toContain('"Swift, Rentals"');
      expect(mockAudit.recordAction).toHaveBeenCalledWith(expect.objectContaining({
        action: 'REPORT_EXPORTED',
        targetResourceId: 'bookings',
      }));
    });

    it('successfully exports operational summary metrics', async () => {
      mockReportsRepo.getOperationalSummary.mockResolvedValueOnce({
        customers: { total: 10, active: 8 },
        partners: { total: 5, verified: 4, pendingKyc: 1 },
        vehicles: { total: 20, active: 15 },
        bookings: { total: 30, completed: 25, cancelled: 3, grossBookingValue: 50000 },
        payments: { collected: 45000 },
        refunds: { totalRefunded: 2000 },
        payouts: { completed: 30000 },
        support: { open: 2 },
        notifications: { sent: 100 },
      });

      const res = await service.exportReport({ reportType: 'summary' }, { actorId: 'admin-1' });

      expect(res.filename).toContain('report-summary-');
      expect(res.rowCount).toBeGreaterThan(0);
      expect(res.csv).toContain('Metric Category,Metric,Value');
      expect(res.csv).toContain('Customers,Total Customers,10');
    });
  });
});
