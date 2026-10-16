'use strict';

const request = require('supertest');


// Mock logger
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  http: jest.fn(),
}));

const userRepository = require('../../src/repositories/user.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminReportsRepository = require('../../src/repositories/admin-reports.repository');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { UnauthorizedError } = require('../../src/errors');
const { createApp } = require('../../src/app');

const app = createApp();

// ── Test User Fixtures ────────────────────────────────────────────────────────

const SUPER_ADMIN_USER = {
  id: 'a0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-super-admin',
  role: 'ADMIN',
  name: 'Super Admin',
  email: 'superadmin@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const REPORTS_READ_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-reports-read-admin',
  role: 'ADMIN',
  name: 'Reports Read Admin',
  email: 'reportsread@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.REPORTS_READ],
};

const REPORTS_EXPORT_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-reports-export-admin',
  role: 'ADMIN',
  name: 'Reports Export Admin',
  email: 'reportsexport@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.REPORTS_READ, PERMISSIONS.REPORTS_EXPORT],
};

const COMMISSIONS_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-commissions-admin',
  role: 'ADMIN',
  name: 'Commissions Finance Admin',
  email: 'commissions@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.REPORTS_READ, PERMISSIONS.COMMISSIONS_READ, PERMISSIONS.REPORTS_EXPORT],
};

const NO_PERM_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000005',
  auth_id: 'sup-noperm-admin',
  role: 'ADMIN',
  name: 'No Perm Admin',
  email: 'noperm@gongo.in',
  is_active: true,
  permissions: [],
};

const DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000006',
  auth_id: 'sup-deactivated-admin',
  role: 'ADMIN',
  name: 'Deactivated Admin',
  email: 'deactivated@gongo.in',
  is_active: false,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const NON_ADMIN_CUSTOMER = {
  id: 'c0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-customer-user',
  role: 'CUSTOMER',
  name: 'Customer User',
  email: 'customer@gmail.com',
  is_active: true,
  permissions: [],
};

const SESSIONS = {
  superAdmin: 'sess-super-admin-token-19',
  reportsRead: 'sess-reports-read-token-19',
  reportsExport: 'sess-reports-export-token-19',
  commissions: 'sess-commissions-token-19',
  noPerm: 'sess-no-perm-token-19',
  deactivated: 'sess-deactivated-token-19',
  customer: 'sess-customer-token-19',
};

describe('Integration: Admin Reports & Data Export (Phase 19)', () => {
  beforeEach(() => {
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (tokenHash) => {
      const match = Object.entries(SESSIONS).find(
        ([, rawToken]) => hashSessionToken(rawToken) === tokenHash,
      );
      if (!match) return null;
      const key = match[0];
      const userMap = {
        superAdmin: SUPER_ADMIN_USER,
        reportsRead: REPORTS_READ_ADMIN,
        reportsExport: REPORTS_EXPORT_ADMIN,
        commissions: COMMISSIONS_ADMIN,
        noPerm: NO_PERM_ADMIN,
        deactivated: DEACTIVATED_ADMIN,
        customer: NON_ADMIN_CUSTOMER,
      };
      const user = userMap[key];
      if (!user) return null;

      return {
        id: `sess-${key}-id`,
        user_id: user.id,
        is_active: true,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        last_active_at: new Date().toISOString(),
      };
    });

    jest.spyOn(userRepository, 'findById').mockImplementation(async (userId) => {
      const users = [
        SUPER_ADMIN_USER,
        REPORTS_READ_ADMIN,
        REPORTS_EXPORT_ADMIN,
        COMMISSIONS_ADMIN,
        NO_PERM_ADMIN,
        DEACTIVATED_ADMIN,
        NON_ADMIN_CUSTOMER,
      ];
      return users.find((u) => u.id === userId) || null;
    });

    adminReportsRepository.query = jest.fn().mockResolvedValue({ rows: [] });
    adminReportsRepository.constructor.resetMockReportsResolver();

  });

  afterEach(() => {
    jest.restoreAllMocks();
    adminReportsRepository.constructor.resetMockReportsResolver();
  });

  // ── 1. Authentication & RBAC Access Control ─────────────────────────────────

  describe('1. Authentication & RBAC Access Control', () => {
    it('returns 401 when no session token is provided', async () => {
      const res = await request(app).get('/api/v1/admin/reports');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 when invalid session token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/admin/reports')
        .set('Authorization', 'Bearer invalid-token');
      expect(res.status).toBe(401);
    });

    it('returns 403 when admin user is deactivated', async () => {
      const res = await request(app)
        .get('/api/v1/admin/reports')
        .set('Authorization', `Bearer ${SESSIONS.deactivated}`);
      expect(res.status).toBe(403);
    });

    it('returns 403 when user is not an ADMIN role (e.g. CUSTOMER)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/reports')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);
      expect(res.status).toBe(403);
    });

    it('returns 403 when admin lacks reports permissions', async () => {
      const res = await request(app)
        .get('/api/v1/admin/reports')
        .set('Authorization', `Bearer ${SESSIONS.noPerm}`);
      expect(res.status).toBe(403);
    });

    it('returns 200 when admin has reports.read permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/reports')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 200 when admin is SUPER_ADMIN (permission bypass)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/reports')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── 2. Report Catalog ───────────────────────────────────────────────────────

  describe('2. GET /api/v1/admin/reports (Catalog)', () => {
    it('returns complete catalog with all 14 report definitions', async () => {
      const res = await request(app)
        .get('/api/v1/admin/reports')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);

      const keys = res.body.data.map((r) => r.key);
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
      expect(keys).toContain('summary');
    });
  });

  // ── 3. Operational Summary Report ───────────────────────────────────────────

  describe('3. GET /api/v1/admin/reports/summary', () => {
    it('returns operational platform summary metrics', async () => {
      adminReportsRepository.query
        .mockResolvedValueOnce({ rows: [{ total: 10, active: 8, in_range: 2 }] })
        .mockResolvedValueOnce({ rows: [{ total: 5, online: 3, verified: 4, pending_kyc: 1 }] })
        .mockResolvedValueOnce({ rows: [{ total: 20, active: 15, idle: 10, booked: 5 }] })
        .mockResolvedValueOnce({
          rows: [{
            total: 50,
            completed: 40,
            cancelled: 5,
            active: 5,
            gross_booking_value: '250000.00',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            total: 60,
            successful: 55,
            collected: '280000.00',
            pending: '5000.00',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: 4, completed: 3, total_refunded: '12000.00' }] })
        .mockResolvedValueOnce({ rows: [{ total_commission: '35000.00' }] })
        .mockResolvedValueOnce({ rows: [{ completed: '150000.00', pending: '10000.00' }] })
        .mockResolvedValueOnce({ rows: [{ total: 12, open_tickets: 3, resolved_tickets: 9 }] })
        .mockResolvedValueOnce({ rows: [{ total: 200, sent: 195, failed: 5 }] });

      const res = await request(app)
        .get('/api/v1/admin/reports/summary')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.customers.total).toBe(10);
      expect(res.body.data.bookings.completed).toBe(40);
      expect(res.body.data.payments.collected).toBe(280000);
      expect(res.body.data.commissions.totalCommissionEarned).toBe(35000);
    });

    it('rejects date range where startDate is after endDate with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/reports/summary?startDate=2026-09-10T00:00:00Z&endDate=2026-09-01T00:00:00Z')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects date range exceeding 366 days for summary with 400', async () => {
      const res = await request(app)
        .get('/api/v1/admin/reports/summary?startDate=2024-01-01T00:00:00Z&endDate=2026-01-01T00:00:00Z')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(400);
    });
  });

  // ── 4. Domain Report Endpoints ───────────────────────────────────────────────

  describe('4. Domain Report Endpoints', () => {
    it('GET /api/v1/admin/reports/bookings returns paginated reservations', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            bookingId: 'b0000000-0000-4000-a000-000000000001',
            bookingNumber: 'BKG-1001',
            customerName: 'Alice',
            customerPhone: '+919876543210',
            partnerBusinessName: 'Swift Rentals',
            vehicleRegistration: 'MH01AB1234',
            vehicleBrand: 'Tata',
            vehicleModel: 'Nexon',
            city: 'Mumbai',
            bookingStatus: 'COMPLETED',
            paymentStatus: 'PAID',
            totalAmount: '4500.00',
            startDatetime: new Date('2026-09-01T10:00:00Z'),
            endDatetime: new Date('2026-09-02T10:00:00Z'),
            durationHours: '24.0',
            cancellationReason: null,
            createdAt: new Date('2026-08-30T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/bookings?status=COMPLETED&city=Mumbai')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].bookingNumber).toBe('BKG-1001');
      expect(res.body.data[0].totalAmount).toBe(4500);
    });

    it('GET /api/v1/admin/reports/customers returns customer metrics', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            customerId: 'c0000000-0000-4000-a000-000000000001',
            name: 'John Doe',
            email: 'john@example.com',
            phone: '+919999999999',
            accountStatus: 'ACTIVE',
            registrationDate: new Date('2026-01-15T00:00:00Z'),
            totalBookings: 12,
            completedBookings: 10,
            cancelledBookings: 2,
            totalSpend: '36000.00',
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/customers')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].totalSpend).toBe(36000);
    });

    it('GET /api/v1/admin/reports/partners returns partner fleet metrics', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            partnerId: 'p0000000-0000-4000-a000-000000000001',
            businessName: 'Royal Motors',
            ownerName: 'Robert',
            email: 'robert@royal.com',
            phone: '+918888888888',
            city: 'Delhi',
            partnerStatus: 'ONLINE',
            kycStatus: 'VERIFIED',
            totalVehicles: 8,
            activeVehicles: 7,
            totalBookings: 45,
            completedBookings: 40,
            registrationDate: new Date('2026-02-01T00:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/partners?city=Delhi')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].businessName).toBe('Royal Motors');
    });

    it('GET /api/v1/admin/reports/vehicles returns fleet inventory metrics', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            vehicleId: 'v0000000-0000-4000-a000-000000000001',
            registrationNumber: 'DL01XY9999',
            partnerBusinessName: 'Royal Motors',
            brand: 'Hyundai',
            model: 'Creta',
            city: 'Delhi',
            verificationStatus: 'VERIFIED',
            rentalStatus: 'IDLE',
            manualStatus: 'ONLINE',
            totalBookings: 15,
            completedBookings: 14,
            totalRevenue: '56000.00',
            createdAt: new Date('2026-02-10T00:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/vehicles')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].totalRevenue).toBe(56000);
    });

    it('GET /api/v1/admin/reports/payments returns payment transactions', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            paymentId: 'py000000-0000-4000-a000-000000000001',
            bookingId: 'b0000000-0000-4000-a000-000000000001',
            bookingNumber: 'BKG-1001',
            customerName: 'Alice',
            partnerBusinessName: 'Swift Rentals',
            amount: '4500.00',
            currency: 'INR',
            paymentType: 'CARD',
            provider: 'CASHFREE',
            providerReference: 'cf_pay_9988',
            status: 'SUCCESS',
            createdAt: new Date('2026-09-01T10:00:00Z'),
            updatedAt: new Date('2026-09-01T10:05:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/payments?status=SUCCESS')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].provider).toBe('CASHFREE');
    });

    it('GET /api/v1/admin/reports/refunds returns refund disbursements', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            refundId: 'rf000000-0000-4000-a000-000000000001',
            refundNumber: 'RF-5001',
            paymentId: 'py000000-0000-4000-a000-000000000001',
            bookingId: 'b0000000-0000-4000-a000-000000000001',
            bookingNumber: 'BKG-1001',
            customerName: 'Alice',
            requestedAmount: '1000.00',
            approvedAmount: '1000.00',
            refundedAmount: '1000.00',
            currency: 'INR',
            status: 'COMPLETED',
            reason: 'Deposit refund',
            provider: 'CASHFREE',
            providerRefundId: 'cf_ref_1122',
            processedAt: new Date('2026-09-03T10:00:00Z'),
            createdAt: new Date('2026-09-02T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/refunds')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].refundNumber).toBe('RF-5001');
    });

    it('GET /api/v1/admin/reports/wallets returns ledger transactions', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            transactionId: 'wt000000-0000-4000-a000-000000000001',
            walletId: 'w0000000-0000-4000-a000-000000000001',
            partnerBusinessName: 'Swift Rentals',
            transactionType: 'EARNING_CREDIT',
            amount: '3825.00',
            balanceAfter: '15000.00',
            referenceType: 'BOOKING',
            referenceId: 'b0000000-0000-4000-a000-000000000001',
            description: 'Rental earnings',
            createdAt: new Date('2026-09-02T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/wallets')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].transactionType).toBe('EARNING_CREDIT');
    });

    it('GET /api/v1/admin/reports/payouts returns payouts with masked bank accounts', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            payoutId: 'po000000-0000-4000-a000-000000000001',
            partnerId: 'p0000000-0000-4000-a000-000000000001',
            partnerBusinessName: 'Swift Rentals',
            amount: '10000.00',
            status: 'COMPLETED',
            accountHolderName: 'Swift Rentals Ltd',
            bankName: 'HDFC Bank',
            accountNumberMasked: 'XXXXXX1234',
            ifscCode: 'HDFC0001234',
            requestedAt: new Date('2026-09-03T10:00:00Z'),
            processedAt: new Date('2026-09-03T14:00:00Z'),
            failureReason: null,
            createdAt: new Date('2026-09-03T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/payouts')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].accountNumberMasked).toBe('XXXXXX1234');
    });

    it('GET /api/v1/admin/reports/kyc returns verification documents metadata', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            documentId: 'd0000000-0000-4000-a000-000000000001',
            entityType: 'PARTNER',
            entityId: 'p0000000-0000-4000-a000-000000000001',
            entityName: 'Swift Rentals',
            documentType: 'GST',
            documentName: 'GST Certificate',
            verificationStatus: 'VERIFIED',
            validTill: null,
            rejectionReason: null,
            submittedAt: new Date('2026-08-01T00:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/kyc')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].documentType).toBe('GST');
    });

    it('GET /api/v1/admin/reports/support returns support tickets with durations', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            ticketId: 'st000000-0000-4000-a000-000000000001',
            ticketNumber: 'TKT-901',
            category: 'BILLING',
            priority: 'HIGH',
            status: 'RESOLVED',
            customerName: 'Alice',
            partnerBusinessName: 'Swift Rentals',
            bookingNumber: 'BKG-1001',
            assignedAdminName: 'Support Agent Bob',
            createdAt: new Date('2026-09-01T10:00:00Z'),
            resolvedAt: new Date('2026-09-01T12:30:00Z'),
            closedAt: null,
            resolutionDurationMinutes: '150.0',
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/support')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].resolutionDurationMinutes).toBe(150);
    });

    it('GET /api/v1/admin/reports/disputes returns damages and dispute claims', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'dp000000-0000-4000-a000-000000000001',
            reportType: 'DISPUTE',
            bookingNumber: 'BKG-1001',
            customerName: 'Alice',
            partnerBusinessName: 'Swift Rentals',
            status: 'SETTLED',
            amount: '2500.00',
            reasonOrDescription: 'Fuel charge dispute',
            createdAt: new Date('2026-09-02T10:00:00Z'),
            resolvedAt: new Date('2026-09-02T16:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/disputes')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].reportType).toBe('DISPUTE');
    });

    it('GET /api/v1/admin/reports/notifications returns delivery records', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            notificationId: 'nt000000-0000-4000-a000-000000000001',
            recipientRole: 'CUSTOMER',
            recipientName: 'Alice',
            channel: 'SMS',
            title: 'Booking Confirmed',
            status: 'SENT',
            sentAt: new Date('2026-09-01T10:01:00Z'),
            failedAt: null,
            createdAt: new Date('2026-09-01T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/notifications')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].channel).toBe('SMS');
    });
  });

  // ── 5. Commission Report Security (Internal Company Data) ───────────────────

  describe('5. Commission Report Security', () => {
    it('denies access (403) when admin only has reports.read but lacks commissions.read', async () => {
      const res = await request(app)
        .get('/api/v1/admin/reports/commissions')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('grants access (200) when admin has commissions.read permission', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            commissionId: 'cm000000-0000-4000-a000-000000000001',
            bookingId: 'b0000000-0000-4000-a000-000000000001',
            bookingNumber: 'BKG-1001',
            partnerBusinessName: 'Swift Rentals',
            commissionType: 'percentage',
            commissionRate: 15,
            grossBookingAmount: '4500.00',
            commissionAmount: '675.00',
            partnerPayableAmount: '3825.00',
            status: 'CALCULATED',
            createdAt: new Date('2026-09-01T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .get('/api/v1/admin/reports/commissions')
        .set('Authorization', `Bearer ${SESSIONS.commissions}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data[0].commissionAmount).toBe(675);
    });

    it('grants access (200) when admin is SUPER_ADMIN', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/v1/admin/reports/commissions')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── 6. POST /api/v1/admin/reports/export ────────────────────────────────────

  describe('6. POST /api/v1/admin/reports/export (CSV Data Export)', () => {
    it('returns 403 when admin lacks reports.export permission', async () => {
      const res = await request(app)
        .post('/api/v1/admin/reports/export')
        .set('Authorization', `Bearer ${SESSIONS.reportsRead}`) // only has read, not export
        .send({ reportType: 'bookings' });

      expect(res.status).toBe(403);
    });

    it('returns 400 when reportType is missing', async () => {
      const res = await request(app)
        .post('/api/v1/admin/reports/export')
        .set('Authorization', `Bearer ${SESSIONS.reportsExport}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('reportType is required');
    });

    it('returns 400 when format is unsupported (e.g. PDF)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/reports/export')
        .set('Authorization', `Bearer ${SESSIONS.reportsExport}`)
        .send({ reportType: 'bookings', format: 'pdf' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("Only 'csv' format is supported");
    });

    it('denies commission export (403) when admin lacks commissions.read', async () => {
      const res = await request(app)
        .post('/api/v1/admin/reports/export')
        .set('Authorization', `Bearer ${SESSIONS.reportsExport}`) // has reports.export, but lacks commissions.read
        .send({ reportType: 'commissions' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('Insufficient permissions to export internal commission data');
    });

    it('successfully generates CSV with formula injection defense for bookings export', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            bookingId: 'b0000000-0000-4000-a000-000000000001',
            bookingNumber: '=cmd|calc!A0', // formula injection payload
            customerName: 'Alice',
            customerPhone: '+919876543210',
            partnerBusinessName: 'Swift, Rentals Ltd', // comma requires quoting
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
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .post('/api/v1/admin/reports/export')
        .set('Authorization', `Bearer ${SESSIONS.reportsExport}`)
        .send({ reportType: 'bookings' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.filename).toMatch(/^report-bookings-.*\.csv$/);
      expect(res.body.data.rowCount).toBe(1);
      // Formula prefix protected with single quote
      expect(res.body.data.csv).toContain("'=cmd|calc!A0");
      // Escaped with double quotes for comma
      expect(res.body.data.csv).toContain('"Swift, Rentals Ltd"');
    });

    it('supports direct raw CSV download when ?raw=true is provided', async () => {
      adminReportsRepository.query.mockResolvedValueOnce({
        rows: [
          {
            bookingId: 'b0000000-0000-4000-a000-000000000001',
            bookingNumber: 'BKG-1001',
            customerName: 'Alice',
            customerPhone: '+919876543210',
            partnerBusinessName: 'Swift Rentals',
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
            full_count: 1,
          },
        ],
      });

      const res = await request(app)
        .post('/api/v1/admin/reports/export?raw=true')
        .set('Authorization', `Bearer ${SESSIONS.reportsExport}`)
        .send({ reportType: 'bookings' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment; filename="report-bookings-');
      expect(res.text).toContain('Booking ID,Booking Number,Customer Name');
    });
  });

  // ── 7. Immutability & Modification Denial ───────────────────────────────────

  describe('7. Immutability & Modification Denial', () => {
    it('denies POST to /api/v1/admin/reports (direct mutation denied)', async () => {
      const res = await request(app)
        .post('/api/v1/admin/reports')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({ fake: 'data' });

      expect([404, 405]).toContain(res.status);
    });

    it('denies PUT to /api/v1/admin/reports/summary (modification denied)', async () => {
      const res = await request(app)
        .put('/api/v1/admin/reports/summary')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`)
        .send({ metrics: 'override' });

      expect([404, 405]).toContain(res.status);
    });

    it('denies DELETE to /api/v1/admin/reports/bookings (deletion denied)', async () => {
      const res = await request(app)
        .delete('/api/v1/admin/reports/bookings')
        .set('Authorization', `Bearer ${SESSIONS.superAdmin}`);

      expect([404, 405]).toContain(res.status);
    });
  });
});
