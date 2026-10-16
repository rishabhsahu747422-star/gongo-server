'use strict';

const request = require('supertest');
const crypto = require('crypto');


// Mock logger to suppress console noise during testing
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  http: jest.fn(),
}));

const userRepository = require('../../src/repositories/user.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminPermissionRepository = require('../../src/repositories/admin-permission.repository');
const adminDashboardRepository = require('../../src/repositories/admin-dashboard.repository');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
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

const AUTHORIZED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-auth-admin',
  role: 'ADMIN',
  name: 'Dashboard Admin',
  email: 'dashadmin@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.DASHBOARD_READ],
};

const UNAUTHORIZED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-unauth-admin',
  role: 'ADMIN',
  name: 'No Dashboard Admin',
  email: 'nodash@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.CUSTOMERS_READ], // missing DASHBOARD_READ
};

const DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-deactivated-admin',
  role: 'ADMIN',
  name: 'Deactivated Admin',
  email: 'deactivated@gongo.in',
  is_active: false,
  permissions: [PERMISSIONS.DASHBOARD_READ],
};

const CUSTOMER_USER = {
  id: 'c0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-customer',
  role: 'CUSTOMER',
  name: 'Customer User',
  email: 'customer@gongo.in',
  is_active: true,
};

const PARTNER_USER = {
  id: 'b0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-partner',
  role: 'PARTNER',
  name: 'Partner User',
  email: 'partner@gongo.in',
  is_active: true,
};

function createMockSession(user) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const session = {
    id: `sess-${user.id}`,
    user_id: user.id,
    session_token: tokenHash,
    is_active: true,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    last_active_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ip_address: '127.0.0.1',
    user_agent: 'Jest/Supertest',
  };

  jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (hash) => {
    if (hash === tokenHash) return session;
    return null;
  });

  jest.spyOn(adminSessionRepository, 'touchSession').mockResolvedValue(true);

  jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
    if (id === user.id) return { ...user };
    if (id === SUPER_ADMIN_USER.id) return { ...SUPER_ADMIN_USER };
    if (id === AUTHORIZED_ADMIN.id) return { ...AUTHORIZED_ADMIN };
    if (id === UNAUTHORIZED_ADMIN.id) return { ...UNAUTHORIZED_ADMIN };
    if (id === DEACTIVATED_ADMIN.id) return { ...DEACTIVATED_ADMIN };
    if (id === CUSTOMER_USER.id) return { ...CUSTOMER_USER };
    if (id === PARTNER_USER.id) return { ...PARTNER_USER };
    return null;
  });

  jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(async (id) => {
    if (id === user.id) return [...(user.permissions || [])];
    return [];
  });

  return { rawToken, tokenHash, session };
}

describe('Integration: Admin Dashboard & Platform Metrics (Phase 6)', () => {
  const mockOverviewData = {
    customers: { total: 150, active: 120, newInRange: 15 },
    partners: { total: 40, active: 35, online: 22, offline: 13, verified: 30, pendingKyc: 5 },
    vehicles: { total: 80, active: 65, idle: 45, booked: 20 },
    bookings: { total: 300, upcoming: 15, active: 25, completed: 240, cancelled: 20, inRange: 35 },
    financial: {
      grossVolume: 185000,
      pendingVolume: 4500,
      totalPayments: 280,
      successfulPayments: 260,
      totalCommission: 18500,
      completedPayouts: 120000,
      pendingPayouts: 15000,
    },
    support: { total: 45, openTickets: 8, resolvedTickets: 37 },
  };

  const mockDomainData = {
    overview: mockOverviewData,
    breakdowns: {
      partnerKyc: { VERIFIED: 30, PENDING: 5, UNDER_REVIEW: 3, REJECTED: 2 },
      vehicleCategories: { SEDAN: 40, SUV: 30, HATCHBACK: 10 },
      vehicleRentalStatus: { IDLE: 45, BOOKED: 20, ACTIVE: 15 },
      bookingStatus: { UPCOMING: 15, ACTIVE: 25, COMPLETED: 240, CANCELLED: 20 },
      bookingPaymentStatus: { COMPLETED: 260, PENDING: 15, FAILED: 5 },
      supportStatus: { OPEN: 8, RESOLVED: 37 },
      supportPriority: { HIGH: 5, MEDIUM: 15, LOW: 25 },
    },
  };

  const mockRevenueData = {
    summary: {
      grossVolume: 185000,
      pendingVolume: 4500,
      totalPayments: 280,
      successfulPayments: 260,
      pendingPayments: 10,
      failedPayments: 6,
      cancelledPayments: 4,
      totalCommission: 18500,
      settledCommission: 15000,
      completedPayouts: 120000,
      pendingPayouts: 15000,
    },
    trends: [
      { date: '2026-09-24', totalPayments: 30, successfulPayments: 28, grossAmount: 42000 },
      { date: '2026-09-25', totalPayments: 45, successfulPayments: 42, grossAmount: 68000 },
    ],
  };

  const mockBookingData = {
    summary: {
      total: 300,
      upcoming: 15,
      active: 25,
      completed: 240,
      cancelled: 20,
      completionRate: 80.0,
    },
    trends: [
      { date: '2026-09-24', total: 25, completed: 20, cancelled: 2 },
      { date: '2026-09-25', total: 40, completed: 35, cancelled: 3 },
    ],
  };

  const mockActivityData = [
    {
      id: 'act-001',
      actorId: SUPER_ADMIN_USER.id,
      actorRole: 'ADMIN',
      permission: 'kyc.verify',
      action: 'APPROVE',
      targetResource: 'partners',
      targetResourceId: 'p-123',
      requestId: 'req-001',
      createdAt: '2026-09-25T14:30:00.000Z',
    },
    {
      id: 'act-002',
      actorId: AUTHORIZED_ADMIN.id,
      actorRole: 'ADMIN',
      permission: 'vehicles.verify',
      action: 'APPROVE',
      targetResource: 'vehicles',
      targetResourceId: 'v-456',
      requestId: 'req-002',
      createdAt: '2026-09-25T15:00:00.000Z',
    },
  ];

  beforeEach(() => {
    jest.restoreAllMocks();

    // Default repository mock implementations
    jest.spyOn(adminDashboardRepository, 'getOverviewStats').mockResolvedValue(mockOverviewData);
    jest.spyOn(adminDashboardRepository, 'getDomainStats').mockResolvedValue(mockDomainData);
    jest.spyOn(adminDashboardRepository, 'getRevenueMetrics').mockResolvedValue(mockRevenueData);
    jest.spyOn(adminDashboardRepository, 'getBookingMetrics').mockResolvedValue(mockBookingData);
    jest.spyOn(adminDashboardRepository, 'getRecentActivity').mockResolvedValue(mockActivityData);
  });

  // ── 1. AUTHORIZATION & RBAC ───────────────────────────────────────────────

  describe('1. Authorization & RBAC', () => {
    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/v1/admin/dashboard');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('rejects CUSTOMER role with 403', async () => {
      const { rawToken } = createMockSession(CUSTOMER_USER);
      const res = await request(app)
        .get('/api/v1/admin/dashboard')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects PARTNER role with 403', async () => {
      const { rawToken } = createMockSession(PARTNER_USER);
      const res = await request(app)
        .get('/api/v1/admin/dashboard')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects deactivated ADMIN with 403 ACCOUNT_DEACTIVATED', async () => {
      const { rawToken } = createMockSession(DEACTIVATED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
    });

    it('rejects ADMIN without dashboard.read permission with 403 INSUFFICIENT_PERMISSIONS', async () => {
      const { rawToken } = createMockSession(UNAUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('allows ADMIN with dashboard.read permission', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('allows SUPER_ADMIN via full-access bypass', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      const res = await request(app)
        .get('/api/v1/admin/dashboard')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── 2. GET /api/v1/admin/dashboard (Overview) ─────────────────────────────

  describe('2. GET /api/v1/admin/dashboard — Overview Metrics', () => {
    it('returns full operational metrics across all platform domains and recent activity', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();

      const { data } = res.body;

      // Customers
      expect(data.customers.total).toBe(150);
      expect(data.customers.active).toBe(120);
      expect(data.customers.newInRange).toBe(15);

      // Partners
      expect(data.partners.total).toBe(40);
      expect(data.partners.online).toBe(22);
      expect(data.partners.verified).toBe(30);
      expect(data.partners.pendingKyc).toBe(5);

      // Vehicles
      expect(data.vehicles.total).toBe(80);
      expect(data.vehicles.active).toBe(65);
      expect(data.vehicles.idle).toBe(45);
      expect(data.vehicles.booked).toBe(20);

      // Bookings
      expect(data.bookings.total).toBe(300);
      expect(data.bookings.upcoming).toBe(15);
      expect(data.bookings.completed).toBe(240);
      expect(data.bookings.cancelled).toBe(20);

      // Financial
      expect(data.financial.grossVolume).toBe(185000);
      expect(data.financial.successfulPayments).toBe(260);
      expect(data.financial.totalCommission).toBe(18500);
      expect(data.financial.completedPayouts).toBe(120000);
      expect(data.financial.pendingPayouts).toBe(15000);

      // Support
      expect(data.support.total).toBe(45);
      expect(data.support.openTickets).toBe(8);

      // Recent Activity
      expect(data.recentActivity).toHaveLength(2);
      expect(data.recentActivity[0].action).toBe('APPROVE');
      expect(data.recentActivity[0].targetResource).toBe('partners');
    });

    it('supports date filtering presets (?preset=7d)', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard?preset=7d')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.filter.preset).toBe('7d');
      expect(adminDashboardRepository.getOverviewStats).toHaveBeenCalled();
    });

    it('supports custom date range (?startDate=2026-09-01&endDate=2026-09-20)', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard?startDate=2026-09-01&endDate=2026-09-20')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.filter.preset).toBe('custom');
      expect(res.body.data.filter.startDate).toContain('2026-09-01');
      expect(res.body.data.filter.endDate).toContain('2026-09-21');
    });
  });

  // ── 3. GET /api/v1/admin/dashboard/stats ───────────────────────────────────

  describe('3. GET /api/v1/admin/dashboard/stats — Domain Breakdowns', () => {
    it('returns domain status distributions and marketplace breakdowns', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard/stats')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { breakdowns } = res.body.data;
      expect(breakdowns.partnerKyc.VERIFIED).toBe(30);
      expect(breakdowns.partnerKyc.PENDING).toBe(5);
      expect(breakdowns.vehicleCategories.SEDAN).toBe(40);
      expect(breakdowns.vehicleRentalStatus.IDLE).toBe(45);
      expect(breakdowns.bookingStatus.COMPLETED).toBe(240);
      expect(breakdowns.bookingPaymentStatus.COMPLETED).toBe(260);
      expect(breakdowns.supportStatus.OPEN).toBe(8);
      expect(breakdowns.supportPriority.HIGH).toBe(5);
    });
  });

  // ── 4. GET /api/v1/admin/dashboard/revenue ─────────────────────────────────

  describe('4. GET /api/v1/admin/dashboard/revenue — Revenue & Financial Metrics', () => {
    it('returns financial metrics and daily revenue time series', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard/revenue')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { summary, trends } = res.body.data;
      expect(summary.grossVolume).toBe(185000);
      expect(summary.successfulPayments).toBe(260);
      expect(summary.failedPayments).toBe(6);
      expect(summary.totalCommission).toBe(18500);
      expect(summary.completedPayouts).toBe(120000);

      expect(trends).toBeInstanceOf(Array);
      expect(trends).toHaveLength(2);
      expect(trends[0].date).toBe('2026-09-24');
      expect(trends[0].grossAmount).toBe(42000);
    });
  });

  // ── 5. GET /api/v1/admin/dashboard/bookings ────────────────────────────────

  describe('5. GET /api/v1/admin/dashboard/bookings — Booking Metrics', () => {
    it('returns booking totals, completion rate, and daily trends', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard/bookings')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { summary, trends } = res.body.data;
      expect(summary.total).toBe(300);
      expect(summary.completed).toBe(240);
      expect(summary.cancelled).toBe(20);
      expect(summary.completionRate).toBe(80.0);

      expect(trends).toBeInstanceOf(Array);
      expect(trends).toHaveLength(2);
      expect(trends[0].completed).toBe(20);
    });
  });

  // ── 6. GET /api/v1/admin/dashboard/activity ────────────────────────────────

  describe('6. GET /api/v1/admin/dashboard/activity — Recent Operational Activity', () => {
    it('returns bounded paginated recent administrative actions', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard/activity?limit=10&offset=0')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.activity).toHaveLength(2);
      expect(res.body.data.pagination.limit).toBe(10);
      expect(res.body.data.pagination.offset).toBe(0);
      expect(res.body.data.pagination.count).toBe(2);
    });

    it('rejects invalid limit or offset with 400', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);

      const badLimitRes = await request(app)
        .get('/api/v1/admin/dashboard/activity?limit=-5')
        .set('Authorization', `Bearer ${rawToken}`);
      expect(badLimitRes.status).toBe(400);

      const badOffsetRes = await request(app)
        .get('/api/v1/admin/dashboard/activity?offset=invalid')
        .set('Authorization', `Bearer ${rawToken}`);
      expect(badOffsetRes.status).toBe(400);
    });
  });

  // ── 7. VALIDATION & SECURITY ──────────────────────────────────────────────

  describe('7. Validation & Query Safety', () => {
    it('rejects SQL injection attempt in preset parameter', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get("/api/v1/admin/dashboard?preset=today' OR 1=1--")
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid startDate format', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard?startDate=invalid&endDate=2026-09-20')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects startDate greater than endDate', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard?startDate=2026-09-25&endDate=2026-09-10')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects date range exceeding 366 days', async () => {
      const { rawToken } = createMockSession(AUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/dashboard?startDate=2023-01-01&endDate=2026-01-01')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('ignores client-supplied spoofing headers (x-admin, x-role, userId)', async () => {
      // Unauthenticated request with spoofed headers must still fail
      const res = await request(app)
        .get('/api/v1/admin/dashboard')
        .set('x-admin', 'true')
        .set('x-role', 'ADMIN')
        .set('userId', SUPER_ADMIN_USER.id);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
