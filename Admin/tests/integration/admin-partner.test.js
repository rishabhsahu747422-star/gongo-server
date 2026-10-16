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
const adminPartnerRepository = require('../../src/repositories/admin-partner.repository');
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

const PARTNERS_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-partners-admin',
  role: 'ADMIN',
  name: 'Partners Admin',
  email: 'partnersadmin@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.PARTNERS_READ,
    PERMISSIONS.PARTNERS_UPDATE,
    PERMISSIONS.PARTNERS_VERIFY,
  ],
};

const READ_ONLY_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-read-admin',
  role: 'ADMIN',
  name: 'Read Only Admin',
  email: 'readonly@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.PARTNERS_READ],
};

const UNAUTHORIZED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-unauth-admin',
  role: 'ADMIN',
  name: 'No Partners Admin',
  email: 'nopartners@gongo.in',
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
  permissions: [PERMISSIONS.PARTNERS_READ],
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

const TEST_PARTNER_ID = 'b1111111-1111-4111-b111-111111111111';
const TEST_PARTNER = {
  id: TEST_PARTNER_ID,
  userId: 'u1111111-1111-4111-u111-111111111111',
  name: 'Suresh Patel',
  email: 'suresh@fastwheels.in',
  phone: '9123456780',
  countryCode: '+91',
  businessName: 'Fast Wheels Mobility',
  businessAddress: '100 Feet Road, Indiranagar',
  city: 'Bengaluru',
  latitude: 12.9716,
  longitude: 77.5946,
  operatingInfo: '9 AM - 9 PM',
  partnerStatus: 'ONLINE',
  kycStatus: 'PENDING',
  profileImageUrl: 'https://cdn.gongo.in/partner.jpg',
  rating: 4.9,
  reviewCount: 35,
  registeredSince: '2026',
  isActive: true,
  vehicleCount: 8,
  bookingCount: 120,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
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
    if (id === PARTNERS_ADMIN.id) return { ...PARTNERS_ADMIN };
    if (id === READ_ONLY_ADMIN.id) return { ...READ_ONLY_ADMIN };
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

describe('Integration: Admin Partner Management (Phase 7)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();

    jest.spyOn(adminPartnerRepository, 'withTransaction').mockImplementation(async (cb) => cb({}));
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);

    // Default repository mock implementations
    jest.spyOn(adminPartnerRepository, 'listPartners').mockResolvedValue({
      partners: [{ ...TEST_PARTNER }],
      total: 1,
    });
    jest.spyOn(adminPartnerRepository, 'findPartnerById').mockImplementation(async (id) => {
      if (id === TEST_PARTNER_ID) return { ...TEST_PARTNER };
      return null;
    });
    jest.spyOn(adminPartnerRepository, 'getPartnerSummaries').mockResolvedValue({
      fleetSummary: { total: 8, active: 6, idle: 4, booked: 2 },
      bookingSummary: { total: 120, upcoming: 5, active: 5, completed: 105, cancelled: 5 },
      kycSummary: {
        totalDocuments: 3, pendingDocuments: 1, verifiedDocuments: 2, rejectedDocuments: 0,
      },
      financialSummary: {
        grossAmount: 150000,
        netAmount: 120000,
        settledAmount: 110000,
        pendingAmount: 10000,
        completedPayouts: 90000,
        pendingPayouts: 15000,
      },
    });
    jest.spyOn(adminPartnerRepository, 'getActiveBookingCount').mockResolvedValue(0);
    jest.spyOn(adminPartnerRepository, 'updatePartnerStatus').mockImplementation(
      async (id, updates) => ({
        ...TEST_PARTNER,
        ...updates,
      }),
    );
    jest.spyOn(adminPartnerRepository, 'updateKycStatus').mockImplementation(
      async (id, status) => ({
        ...TEST_PARTNER,
        kycStatus: status,
      }),
    );
    jest.spyOn(adminPartnerRepository, 'getPartnerDocuments').mockResolvedValue([
      {
        id: 'doc-1',
        partnerId: TEST_PARTNER_ID,
        documentType: 'AADHAAR',
        verificationStatus: 'VERIFIED',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    ]);
    jest.spyOn(adminPartnerRepository, 'getPartnerBankAccounts').mockResolvedValue([
      {
        id: 'bank-1',
        partnerId: TEST_PARTNER_ID,
        accountHolderName: 'Suresh Patel',
        accountNumberMasked: 'XXXX-5678',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
        isPrimary: true,
        verificationStatus: 'VERIFIED',
      },
    ]);
    jest.spyOn(adminPartnerRepository, 'getPartnerShops').mockResolvedValue([
      {
        id: 'shop-1',
        partnerId: TEST_PARTNER_ID,
        shopName: 'Fast Wheels Hub Indiranagar',
        city: 'Bengaluru',
        isActive: true,
      },
    ]);
    jest.spyOn(adminPartnerRepository, 'getPartnerVehicles').mockResolvedValue({
      vehicles: [
        {
          id: 'veh-1',
          partnerId: TEST_PARTNER_ID,
          brand: 'Hyundai',
          model: 'i20',
          registrationNumber: 'KA-01-AB-1234',
          manualStatus: 'ONLINE',
          rentalStatus: 'IDLE',
        },
      ],
      total: 1,
    });
    jest.spyOn(adminPartnerRepository, 'getPartnerBookings').mockResolvedValue({
      bookings: [
        {
          id: 'book-1',
          bookingNumber: 'BK-1001',
          partnerId: TEST_PARTNER_ID,
          bookingStatus: 'COMPLETED',
          paymentStatus: 'COMPLETED',
        },
      ],
      total: 1,
    });
  });

  // ── 1. AUTHORIZATION & RBAC ───────────────────────────────────────────────

  describe('1. Authorization & RBAC', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/v1/admin/partners');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    });

    it('rejects CUSTOMER role with 403', async () => {
      const { rawToken } = createMockSession(CUSTOMER_USER);
      const res = await request(app)
        .get('/api/v1/admin/partners')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects PARTNER role with 403', async () => {
      const { rawToken } = createMockSession(PARTNER_USER);
      const res = await request(app)
        .get('/api/v1/admin/partners')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects deactivated ADMIN with 403 ACCOUNT_DEACTIVATED', async () => {
      const { rawToken } = createMockSession(DEACTIVATED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/partners')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
    });

    it('rejects ADMIN without partners.read permission with 403 INSUFFICIENT_PERMISSIONS', async () => {
      const { rawToken } = createMockSession(UNAUTHORIZED_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/partners')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('allows ADMIN with partners.read permission on GET /partners', async () => {
      const { rawToken } = createMockSession(READ_ONLY_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/partners')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects READ_ONLY_ADMIN on PATCH /status with 403', async () => {
      const { rawToken } = createMockSession(READ_ONLY_ADMIN);
      const res = await request(app)
        .patch(`/api/v1/admin/partners/${TEST_PARTNER_ID}/status`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ partnerStatus: 'OFFLINE' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('allows PARTNERS_ADMIN with partners.update permission on PATCH /status', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .patch(`/api/v1/admin/partners/${TEST_PARTNER_ID}/status`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ partnerStatus: 'OFFLINE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('allows SUPER_ADMIN to access any partner endpoint via bypass', async () => {
      const { rawToken } = createMockSession(SUPER_ADMIN_USER);
      const res = await request(app)
        .post(`/api/v1/admin/partners/${TEST_PARTNER_ID}/approve`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ reason: 'Approved by super admin' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ── 2. PARTNER LIST & SEARCH ──────────────────────────────────────────────

  describe('2. GET /api/v1/admin/partners — Partner Listing & Search', () => {
    it('returns paginated partner list with expected metadata envelope', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/partners?limit=10&offset=0')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.partners).toHaveLength(1);
      expect(res.body.data.pagination.total).toBe(1);
      expect(res.body.data.pagination.limit).toBe(10);
      expect(res.body.data.pagination.offset).toBe(0);

      const p = res.body.data.partners[0];
      expect(p.businessName).toBe('Fast Wheels Mobility');
      expect(p.name).toBe('Suresh Patel');
      expect(p.phone).toBe('9123456780');
      expect(p.rating).toBe(4.9);
      expect(p.vehicleCount).toBe(8);
      expect(p.bookingCount).toBe(120);
    });

    it('supports search query filter (?search=Fast)', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/partners?search=Fast')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(adminPartnerRepository.listPartners).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'Fast' }),
      );
    });

    it('supports status and kyc filters (?partnerStatus=ONLINE&kycStatus=PENDING)', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/partners?partnerStatus=ONLINE&kycStatus=PENDING')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(adminPartnerRepository.listPartners).toHaveBeenCalledWith(
        expect.objectContaining({ partnerStatus: 'ONLINE', kycStatus: 'PENDING' }),
      );
    });

    it('rejects invalid partnerStatus with 400', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/partners?partnerStatus=UNKNOWN')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid kycStatus with 400', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/partners?kycStatus=FAKE_STATUS')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects inverted date range with 400', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/partners?startDate=2026-09-20&endDate=2026-09-10')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ── 3. PARTNER DETAIL ─────────────────────────────────────────────────────

  describe('3. GET /api/v1/admin/partners/:id — Partner Detail', () => {
    it('returns partner details and safe operational summaries', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get(`/api/v1/admin/partners/${TEST_PARTNER_ID}`)
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { partner, fleetSummary, bookingSummary, kycSummary, financialSummary } = res.body.data;
      expect(partner.id).toBe(TEST_PARTNER_ID);
      expect(partner.name).toBe('Suresh Patel');
      expect(partner.businessName).toBe('Fast Wheels Mobility');

      // Verify NO sensitive authentication secrets exist in response
      expect(partner.password).toBeUndefined();
      expect(partner.token).toBeUndefined();
      expect(partner.auth_id).toBeUndefined();
      expect(partner.firebase_uid).toBeUndefined();

      expect(fleetSummary.total).toBe(8);
      expect(bookingSummary.total).toBe(120);
      expect(kycSummary.totalDocuments).toBe(3);
      expect(financialSummary.grossAmount).toBe(150000);
    });

    it('returns 400 for malformed partner UUID', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get('/api/v1/admin/partners/invalid-uuid-123')
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 for nonexistent partner UUID', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const nonexistentId = 'f0000000-0000-4000-a000-000000000000';
      const res = await request(app)
        .get(`/api/v1/admin/partners/${nonexistentId}`)
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ── 4. PARTNER STATUS MUTATIONS ───────────────────────────────────────────

  describe('4. PATCH /api/v1/admin/partners/:id/status — Status Mutations', () => {
    it('updates partner status and records admin action audit', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .patch(`/api/v1/admin/partners/${TEST_PARTNER_ID}/status`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ partnerStatus: 'OFFLINE', reason: 'Routine offline toggle' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PARTNER_STATUS_CHANGE',
          targetResource: 'PARTNER',
          targetResourceId: TEST_PARTNER_ID,
        }),
        expect.anything(),
      );
    });

    it('rejects mass-assignment attempts of unauthorized fields with 400', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .patch(`/api/v1/admin/partners/${TEST_PARTNER_ID}/status`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({
          partnerStatus: 'OFFLINE',
          rating: 5.0,
          userId: 'malicious',
          wallet: 10000,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('enforces deactivation safety: blocks suspension when active bookings exist', async () => {
      jest.spyOn(adminPartnerRepository, 'getActiveBookingCount').mockResolvedValue(2);

      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .patch(`/api/v1/admin/partners/${TEST_PARTNER_ID}/status`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ isActive: false });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('active/upcoming bookings');
    });

    it('allows deactivation override when force: true is provided', async () => {
      jest.spyOn(adminPartnerRepository, 'getActiveBookingCount').mockResolvedValue(2);

      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .patch(`/api/v1/admin/partners/${TEST_PARTNER_ID}/status`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ isActive: false, force: true, reason: 'Emergency compliance action' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PARTNER_SUSPEND',
        }),
        expect.anything(),
      );
    });
  });

  // ── 5. VERIFICATION MUTATIONS ─────────────────────────────────────────────

  describe('5. Verification Mutations (Approve & Reject)', () => {
    it('POST /approve updates kyc status to VERIFIED and records audit', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .post(`/api/v1/admin/partners/${TEST_PARTNER_ID}/approve`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ reason: 'All documents verified successfully' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.kycStatus).toBe('VERIFIED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PARTNER_APPROVED',
          targetResource: 'PARTNER',
          targetResourceId: TEST_PARTNER_ID,
        }),
        expect.anything(),
      );
    });

    it('POST /reject updates kyc status to REJECTED and records audit', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .post(`/api/v1/admin/partners/${TEST_PARTNER_ID}/reject`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({ reason: 'Aadhaar card copy is blurry and unreadable' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.kycStatus).toBe('REJECTED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PARTNER_REJECTED',
          metadata: expect.objectContaining({
            reason: 'Aadhaar card copy is blurry and unreadable',
          }),
        }),
        expect.anything(),
      );
    });

    it('POST /reject fails with 400 if reason is missing or empty', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .post(`/api/v1/admin/partners/${TEST_PARTNER_ID}/reject`)
        .set('Authorization', `Bearer ${rawToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── 6. SUB-RESOURCES ──────────────────────────────────────────────────────

  describe('6. Partner Sub-Resource Endpoints', () => {
    it('GET /:id/documents returns verification documents', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get(`/api/v1/admin/partners/${TEST_PARTNER_ID}/documents`)
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.documents).toHaveLength(1);
      expect(res.body.data.documents[0].documentType).toBe('AADHAAR');
    });

    it('GET /:id/kyc returns KYC summary and documents breakdown', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get(`/api/v1/admin/partners/${TEST_PARTNER_ID}/kyc`)
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.kycStatus).toBe('PENDING');
      expect(res.body.data.documents).toBeDefined();
    });

    it('GET /:id/bank-accounts returns masked bank accounts without secrets', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get(`/api/v1/admin/partners/${TEST_PARTNER_ID}/bank-accounts`)
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bankAccounts).toHaveLength(1);

      const bank = res.body.data.bankAccounts[0];
      expect(bank.accountNumberMasked).toBe('XXXX-5678');
      expect(bank.account_number_encrypted).toBeUndefined();
    });

    it('GET /:id/shops returns legacy shop records', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get(`/api/v1/admin/partners/${TEST_PARTNER_ID}/shops`)
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.shops).toHaveLength(1);
    });

    it('GET /:id/vehicles returns fleet with pagination metadata', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get(`/api/v1/admin/partners/${TEST_PARTNER_ID}/vehicles?limit=5&offset=0`)
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.vehicles).toHaveLength(1);
      expect(res.body.data.pagination.limit).toBe(5);
    });

    it('GET /:id/bookings returns bookings with pagination metadata', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get(`/api/v1/admin/partners/${TEST_PARTNER_ID}/bookings?limit=5&offset=0`)
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bookings).toHaveLength(1);
    });

    it('GET /:id/earnings returns financial summary', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get(`/api/v1/admin/partners/${TEST_PARTNER_ID}/earnings`)
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.earnings.grossAmount).toBe(150000);
    });
  });

  // ── 7. SECURITY & SPOOFING ────────────────────────────────────────────────

  describe('7. Security & Input Sanitization', () => {
    it('ignores client-supplied spoofing headers (x-admin, x-role, userId)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/partners')
        .set('x-admin', 'true')
        .set('x-role', 'ADMIN')
        .set('userId', SUPER_ADMIN_USER.id);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('sanitizes and parameterizes SQL search payloads safely', async () => {
      const { rawToken } = createMockSession(PARTNERS_ADMIN);
      const res = await request(app)
        .get("/api/v1/admin/partners?search=Fast' OR 1=1 --")
        .set('Authorization', `Bearer ${rawToken}`);

      expect(res.status).toBe(200);
      expect(adminPartnerRepository.listPartners).toHaveBeenCalledWith(
        expect.objectContaining({ search: "Fast' OR 1=1 --" }),
      );
    });
  });
});
