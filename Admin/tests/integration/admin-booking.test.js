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
const adminBookingRepository = require('../../src/repositories/admin-booking.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const auditService = require('../../src/services/audit.service');
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

const BOOKINGS_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-bookings-admin',
  role: 'ADMIN',
  name: 'Bookings Admin',
  email: 'bookingsadmin@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.BOOKINGS_READ,
    PERMISSIONS.BOOKINGS_UPDATE,
    PERMISSIONS.BOOKINGS_CANCEL,
  ],
};

const READ_ONLY_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-read-admin',
  role: 'ADMIN',
  name: 'Read Only Admin',
  email: 'readonly@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.BOOKINGS_READ],
};

const UNAUTHORIZED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-unauth-admin',
  role: 'ADMIN',
  name: 'No Bookings Admin',
  email: 'nobookings@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.CUSTOMERS_READ],
};

const DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000005',
  auth_id: 'sup-deactivated-admin',
  role: 'ADMIN',
  name: 'Deactivated Admin',
  email: 'deactivated@gongo.in',
  is_active: false,
  permissions: [PERMISSIONS.BOOKINGS_READ],
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

const TEST_BOOKING_ID = 'e1111111-1111-4111-a111-111111111111';
const TEST_CUSTOMER_ID = 'c1111111-1111-4111-a111-111111111111';
const TEST_PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';
const TEST_VEHICLE_ID = 'd1111111-1111-4111-a111-111111111111';

const TEST_BOOKING = {
  id: TEST_BOOKING_ID,
  bookingNumber: 'BK-2026-0001',
  customerId: TEST_CUSTOMER_ID,
  partnerId: TEST_PARTNER_ID,
  vehicleId: TEST_VEHICLE_ID,
  startAt: '2026-09-01T10:00:00.000Z',
  expectedReturnAt: '2026-09-03T10:00:00.000Z',
  bookingStatus: 'CONFIRMED',
  paymentStatus: 'COMPLETED',
  pickupLocation: 'Indiranagar Hub, Bengaluru',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
  customer: {
    id: TEST_CUSTOMER_ID,
    name: 'Rajesh Kumar',
    phone: '9876543210',
    email: 'rajesh@example.com',
  },
  partner: {
    id: TEST_PARTNER_ID,
    businessName: 'Apex Mobility',
    ownerName: 'Suresh Patel',
  },
  vehicle: {
    id: TEST_VEHICLE_ID,
    registrationNumber: 'KA-01-MJ-9999',
    brand: 'Tata',
    model: 'Nexon EV',
    category: 'SUV',
    rentalStatus: 'IDLE',
  },
  pricing: {
    totalCustomerAmount: 4000,
    currency: 'INR',
  },
};

const sessionsByHash = new Map();

function createMockSession(user) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const session = {
    id: `sess-${user.id}`,
    user_id: user.id,
    session_token: tokenHash,
    is_active: user.is_active !== false,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    last_active_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ip_address: '127.0.0.1',
    user_agent: 'Jest/Supertest',
  };

  sessionsByHash.set(tokenHash, session);
  return rawToken;
}

describe('Integration: Admin Booking Management (Phase 10)', () => {
  let superAdminToken;
  let bookingsAdminToken;
  let readOnlyAdminToken;
  let unauthorizedAdminToken;
  let deactivatedAdminToken;
  let customerToken;
  let partnerToken;

  beforeEach(() => {
    jest.restoreAllMocks();
    sessionsByHash.clear();

    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(
      async (hash) => sessionsByHash.get(hash) || null,
    );

    jest.spyOn(adminSessionRepository, 'touchSession').mockResolvedValue(true);

    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      const allUsers = [
        SUPER_ADMIN_USER,
        BOOKINGS_ADMIN,
        READ_ONLY_ADMIN,
        UNAUTHORIZED_ADMIN,
        DEACTIVATED_ADMIN,
        CUSTOMER_USER,
        PARTNER_USER,
      ];
      const match = allUsers.find((x) => x.id === id);
      return match ? { ...match } : null;
    });

    jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(
      async (adminId) => {
        const allUsers = [
          SUPER_ADMIN_USER,
          BOOKINGS_ADMIN,
          READ_ONLY_ADMIN,
          UNAUTHORIZED_ADMIN,
          DEACTIVATED_ADMIN,
          CUSTOMER_USER,
          PARTNER_USER,
        ];
        const match = allUsers.find((x) => x.id === adminId);
        return match ? [...(match.permissions || [])] : [];
      },
    );

    superAdminToken = createMockSession(SUPER_ADMIN_USER);
    bookingsAdminToken = createMockSession(BOOKINGS_ADMIN);
    readOnlyAdminToken = createMockSession(READ_ONLY_ADMIN);
    unauthorizedAdminToken = createMockSession(UNAUTHORIZED_ADMIN);
    deactivatedAdminToken = createMockSession(DEACTIVATED_ADMIN);
    customerToken = createMockSession(CUSTOMER_USER);
    partnerToken = createMockSession(PARTNER_USER);

    // Default repository mocks
    jest.spyOn(adminBookingRepository, 'withTransaction').mockImplementation(async (cb) => cb({}));
    jest.spyOn(adminBookingRepository, 'listBookings').mockResolvedValue({
      bookings: [TEST_BOOKING],
      total: 1,
    });
    jest.spyOn(adminBookingRepository, 'findBookingById').mockImplementation(async (id) => {
      if (id === TEST_BOOKING_ID) return { ...TEST_BOOKING };
      return null;
    });
    jest.spyOn(adminBookingRepository, 'getBookingSummaries').mockResolvedValue({
      pricingSnapshot: { totalCustomerAmount: 4000 },
      pickupVerification: { isVerified: true, verifiedAt: '2026-09-01T10:05:00.000Z' },
      returnVerification: null,
    });
    jest.spyOn(adminBookingRepository, 'getBookingPayments').mockResolvedValue([
      { id: 'pay-1', amount: 4000, currency: 'INR', provider: 'RAZORPAY', status: 'SUCCESS' },
    ]);
    jest.spyOn(adminBookingRepository, 'getBookingDamages').mockResolvedValue([]);
    jest.spyOn(adminBookingRepository, 'getBookingCommission').mockResolvedValue({
      commissionRate: 15,
      commissionAmount: 450,
      partnerPayableAmount: 2550,
    });
    jest.spyOn(adminBookingRepository, 'getBookingSettlement').mockResolvedValue({
      grossAmount: 3000,
      partnerNetAmount: 2550,
      settlementStatus: 'PENDING',
    });
    jest.spyOn(adminBookingRepository, 'getBookingAdminActions').mockResolvedValue([]);
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
  });

  // ── Authentication & RBAC Tests ─────────────────────────────────────────────

  describe('Authentication & Role Guards', () => {
    it('returns 401 Unauthorized when Authorization header is missing', async () => {
      const res = await request(app).get('/api/v1/admin/bookings');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when Customer token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/admin/bookings')
        .set('Authorization', `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when Partner token is provided', async () => {
      const res = await request(app)
        .get('/api/v1/admin/bookings')
        .set('Authorization', `Bearer ${partnerToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 Unauthorized when Admin account is deactivated', async () => {
      const res = await request(app)
        .get('/api/v1/admin/bookings')
        .set('Authorization', `Bearer ${deactivatedAdminToken}`);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when Admin lacks bookings.read permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/bookings')
        .set('Authorization', `Bearer ${unauthorizedAdminToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 200 OK for Admin with bookings.read permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/bookings')
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bookings).toHaveLength(1);
    });

    it('returns 200 OK for SUPER_ADMIN (permission bypass)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/bookings')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── Anti-Spoofing & BOLA / IDOR Tests ───────────────────────────────────────

  describe('Anti-Spoofing & BOLA / IDOR Guards', () => {
    it('ignores client spoofing headers (x-admin, x-role, customerId)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/bookings')
        .set('Authorization', `Bearer ${readOnlyAdminToken}`)
        .set('x-admin', 'true')
        .set('x-role', 'SUPER_ADMIN')
        .set('customerId', 'c9999999-9999-4999-a999-999999999999');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 400 Bad Request when booking ID is not a valid UUID', async () => {
      const res = await request(app)
        .get('/api/v1/admin/bookings/not-a-valid-uuid')
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Invalid id');
    });

    it('returns 404 Not Found when booking does not exist', async () => {
      const nonExistentId = 'f9999999-9999-4999-a999-999999999999';
      const res = await request(app)
        .get(`/api/v1/admin/bookings/${nonExistentId}`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ── List Bookings Endpoint Tests ───────────────────────────────────────────

  describe('GET /api/v1/admin/bookings', () => {
    it('lists bookings with pagination, search, and filters', async () => {
      const res = await request(app)
        .get('/api/v1/admin/bookings')
        .query({
          search: 'Rajesh',
          bookingStatus: 'CONFIRMED',
          paymentStatus: 'COMPLETED',
          limit: 10,
          offset: 0,
        })
        .set('Authorization', `Bearer ${bookingsAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bookings).toHaveLength(1);
      expect(res.body.data.pagination).toEqual({
        total: 1,
        limit: 10,
        offset: 0,
        pages: 1,
      });
    });

    it('rejects invalid limit or offset parameters', async () => {
      const res = await request(app)
        .get('/api/v1/admin/bookings')
        .query({ limit: 0 })
        .set('Authorization', `Bearer ${bookingsAdminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ── Booking Detail Endpoint Tests ──────────────────────────────────────────

  describe('GET /api/v1/admin/bookings/:id', () => {
    it('returns safe projection of booking detail without secrets', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/bookings/${TEST_BOOKING_ID}`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.booking.id).toBe(TEST_BOOKING_ID);
      expect(res.body.data.booking.customer.name).toBe('Rajesh Kumar');
      expect(res.body.data.pricingSnapshot.totalCustomerAmount).toBe(4000);
      expect(res.body.data.payments).toHaveLength(1);

      // Verify no sensitive fields leaked
      expect(res.body.data.booking.password_hash).toBeUndefined();
      expect(res.body.data.booking.session_token).toBeUndefined();
    });
  });

  // ── Status Update Mutation Tests ───────────────────────────────────────────

  describe('PATCH /api/v1/admin/bookings/:id/status', () => {
    it('returns 403 Forbidden when admin lacks bookings.update permission', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/status`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`)
        .send({ status: 'ACTIVE' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects unapproved fields (mass assignment guard)', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/status`)
        .set('Authorization', `Bearer ${bookingsAdminToken}`)
        .send({
          status: 'ACTIVE',
          arbitraryField: 'attack-value',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain("Field 'arbitraryField' is not allowed");
    });

    it('rejects invalid state transition without force', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...TEST_BOOKING,
        bookingStatus: 'CONFIRMED',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/status`)
        .set('Authorization', `Bearer ${bookingsAdminToken}`)
        .send({ status: 'COMPLETED' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Invalid booking status transition');
    });

    it('successfully updates booking status with valid transition', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...TEST_BOOKING,
        bookingStatus: 'CONFIRMED',
      });
      jest.spyOn(adminBookingRepository, 'updateVehicleRentalStatus').mockResolvedValue(true);
      jest.spyOn(adminBookingRepository, 'updateBookingStatus').mockResolvedValue({
        ...TEST_BOOKING,
        bookingStatus: 'ACTIVE',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/status`)
        .set('Authorization', `Bearer ${bookingsAdminToken}`)
        .send({ status: 'ACTIVE', reason: 'Customer arrived and picked up vehicle' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bookingStatus).toBe('ACTIVE');
      expect(adminActionRepository.createAction).toHaveBeenCalled();
    });
  });

  // ── Cancellation Mutation Tests ────────────────────────────────────────────

  describe('POST /api/v1/admin/bookings/:id/cancel', () => {
    it('returns 403 Forbidden when admin lacks bookings.cancel permission', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/cancel`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`)
        .send({ reason: 'Admin cancel' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects cancellation when reason is missing or too short', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/cancel`)
        .set('Authorization', `Bearer ${bookingsAdminToken}`)
        .send({ reason: 'no' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Cancellation reason is required');
    });

    it('rejects cancellation on COMPLETED booking', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...TEST_BOOKING,
        bookingStatus: 'COMPLETED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/cancel`)
        .set('Authorization', `Bearer ${bookingsAdminToken}`)
        .send({ reason: 'Customer requested refund after completion' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Cannot cancel a COMPLETED booking');
    });

    it('successfully cancels booking, restores vehicle to IDLE, and audits action', async () => {
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        ...TEST_BOOKING,
        bookingStatus: 'UPCOMING',
      });
      const updateVehicleSpy = jest.spyOn(
        adminBookingRepository,
        'updateVehicleRentalStatus',
      ).mockResolvedValue(true);
      jest.spyOn(adminBookingRepository, 'updateBookingStatus').mockResolvedValue({
        ...TEST_BOOKING,
        bookingStatus: 'CANCELLED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/cancel`)
        .set('Authorization', `Bearer ${bookingsAdminToken}`)
        .send({ reason: 'Customer cancelled trip in advance' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bookingStatus).toBe('CANCELLED');
      expect(updateVehicleSpy).toHaveBeenCalledWith(TEST_VEHICLE_ID, 'IDLE', expect.anything());
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'BOOKING_CANCELLED' }),
        expect.anything(),
      );
    });
  });

  // ── Timeline & Auxiliary Endpoints Tests ───────────────────────────────────

  describe('Timeline & Operational Auxiliary Endpoints', () => {
    it('GET /api/v1/admin/bookings/:id/timeline returns chronological events', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/timeline`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.timeline).toBeDefined();
      expect(res.body.data.bookingId).toBe(TEST_BOOKING_ID);
    });

    it('GET /api/v1/admin/bookings/:id/payment returns associated payments', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/payment`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payments).toHaveLength(1);
    });

    it('GET /api/v1/admin/bookings/:id/payments alias returns associated payments', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/payments`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payments).toHaveLength(1);
    });

    it('GET /api/v1/admin/bookings/:id/commission returns commission record', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/commission`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.commission.commissionAmount).toBe(450);
    });

    it('GET /api/v1/admin/bookings/:id/settlement returns partner earnings and settlement', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/settlement`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.settlement.settlementStatus).toBe('PENDING');
    });

    it('GET /api/v1/admin/bookings/:id/tracking returns pickup and return tracking', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/bookings/${TEST_BOOKING_ID}/tracking`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pickup.isVerified).toBe(true);
    });
  });
});
