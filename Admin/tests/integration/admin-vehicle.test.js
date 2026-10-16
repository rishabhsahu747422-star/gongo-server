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
const adminVehicleRepository = require('../../src/repositories/admin-vehicle.repository');
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

const VEHICLES_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-vehicles-admin',
  role: 'ADMIN',
  name: 'Vehicles Admin',
  email: 'vehiclesadmin@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.VEHICLES_READ,
    PERMISSIONS.VEHICLES_UPDATE,
    PERMISSIONS.VEHICLES_VERIFY,
  ],
};

const READ_ONLY_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-read-admin',
  role: 'ADMIN',
  name: 'Read Only Admin',
  email: 'readonly@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.VEHICLES_READ],
};

const UNAUTHORIZED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-unauth-admin',
  role: 'ADMIN',
  name: 'No Vehicles Admin',
  email: 'novehicles@gongo.in',
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
  permissions: [PERMISSIONS.VEHICLES_READ],
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

const TEST_VEHICLE_ID = 'e1111111-1111-4111-a111-111111111111';
const TEST_PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';

const TEST_VEHICLE = {
  id: TEST_VEHICLE_ID,
  partnerId: TEST_PARTNER_ID,
  shopId: null,
  category: 'CAR',
  brand: 'Hyundai',
  model: 'i20',
  variant: 'Asta',
  registrationNumber: 'KA-01-AB-1234',
  year: 2023,
  fuelType: 'Petrol',
  transmission: 'Manual',
  seats: 5,
  description: 'Well-maintained hatchback',
  manualStatus: 'ONLINE',
  rentalStatus: 'IDLE',
  verificationStatus: 'VERIFIED',
  isArchived: false,
  offlineReason: null,
  partner: {
    id: TEST_PARTNER_ID,
    businessName: 'Fast Wheels Mobility',
    city: 'Bengaluru',
    ownerName: 'Suresh Patel',
    ownerEmail: 'suresh@fastwheels.in',
    ownerPhone: '9123456780',
  },
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
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

describe('Integration: Admin Vehicle & Fleet Management (Phase 9)', () => {
  let superAdminToken;
  let vehiclesAdminToken;
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
        VEHICLES_ADMIN,
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
          VEHICLES_ADMIN,
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
    vehiclesAdminToken = createMockSession(VEHICLES_ADMIN);
    readOnlyAdminToken = createMockSession(READ_ONLY_ADMIN);
    unauthorizedAdminToken = createMockSession(UNAUTHORIZED_ADMIN);
    deactivatedAdminToken = createMockSession(DEACTIVATED_ADMIN);
    customerToken = createMockSession(CUSTOMER_USER);
    partnerToken = createMockSession(PARTNER_USER);

    // Default repository mocks
    jest.spyOn(adminVehicleRepository, 'withTransaction').mockImplementation(async (cb) => cb({}));
    jest.spyOn(adminVehicleRepository, 'listVehicles').mockResolvedValue({
      vehicles: [{ ...TEST_VEHICLE, pricePerDay: 2500, bookingCount: 8 }],
      total: 1,
    });
    jest.spyOn(adminVehicleRepository, 'findVehicleById').mockImplementation(async (id) => {
      if (id === TEST_VEHICLE_ID) return { ...TEST_VEHICLE };
      return null;
    });
    jest.spyOn(adminVehicleRepository, 'getVehicleSummaries').mockResolvedValue({
      bookingSummary: { total: 20, upcoming: 1, active: 1, completed: 16, cancelled: 2 },
      documentsSummary: { total: 4, verified: 4, pending: 0, rejected: 0 },
      imagesCount: 5,
      pricing: { pricePerHour: 150, pricePerDay: 2500, currency: 'INR' },
      availability: { activeBlocksCount: 0 },
    });
    jest.spyOn(adminVehicleRepository, 'getActiveBookingCount').mockResolvedValue(0);
    jest.spyOn(adminVehicleRepository, 'updateVehicleStatus').mockResolvedValue({
      ...TEST_VEHICLE,
      manualStatus: 'OFFLINE',
    });
    jest.spyOn(adminVehicleRepository, 'updateVehicleVerification').mockResolvedValue({
      ...TEST_VEHICLE,
      verificationStatus: 'VERIFIED',
    });
    jest.spyOn(adminVehicleRepository, 'getVehicleDocuments').mockResolvedValue([
      {
        id: 'doc-1',
        vehicleId: TEST_VEHICLE_ID,
        documentType: 'RC',
        verificationStatus: 'VERIFIED',
      },
    ]);
    jest.spyOn(adminVehicleRepository, 'getVehicleImages').mockResolvedValue([
      {
        id: 'img-1',
        vehicleId: TEST_VEHICLE_ID,
        imageUrl: 'https://cdn.gongo.in/car.jpg',
        isCover: true,
      },
    ]);
    jest.spyOn(adminVehicleRepository, 'getVehicleBookings').mockResolvedValue({
      bookings: [
        {
          id: 'bk-1',
          bookingNumber: 'BK-1001',
          vehicleId: TEST_VEHICLE_ID,
          bookingStatus: 'COMPLETED',
        },
      ],
      total: 1,
    });
    jest.spyOn(adminVehicleRepository, 'getVehicleAvailability').mockResolvedValue([
      {
        id: 'avail-1',
        vehicleId: TEST_VEHICLE_ID,
        reason: 'Maintenance',
      },
    ]);
    jest.spyOn(adminVehicleRepository, 'getVehiclePricing').mockResolvedValue({
      vehicleId: TEST_VEHICLE_ID,
      pricePerHour: 150,
      pricePerDay: 2500,
      currency: 'INR',
      isActive: true,
    });
    jest.spyOn(adminVehicleRepository, 'getVehicleEarnings').mockResolvedValue({
      totalPayments: 12,
      grossRevenue: 36000,
      successfulBookings: 12,
      refundedBookings: 0,
    });
    jest.spyOn(adminVehicleRepository, 'getVehicleHistory').mockResolvedValue({
      history: [
        {
          id: 'act-1',
          action: 'VEHICLE_STATUS_CHANGE',
          actorId: VEHICLES_ADMIN.id,
        },
      ],
      total: 1,
    });

    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
  });

  // ==========================================================================
  // 1. GET /api/v1/admin/vehicles (List)
  // ==========================================================================
  describe('GET /api/v1/admin/vehicles', () => {
    it('returns 200 with vehicle list for authorized admin', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles')
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.vehicles).toHaveLength(1);
      expect(res.body.data.vehicles[0].id).toBe(TEST_VEHICLE_ID);
      expect(res.body.data.pagination.total).toBe(1);
    });

    it('returns 200 for SUPER_ADMIN bypass', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles')
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 403 when admin lacks vehicles.read permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles')
        .set('Authorization', `Bearer ${unauthorizedAdminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('returns 403 when customer token is used', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles')
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.status).toBe(403);
    });

    it('returns 403 when partner token is used', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles')
        .set('Authorization', `Bearer ${partnerToken}`);

      expect(res.status).toBe(403);
    });

    it('returns 401 when deactivated admin tries to access', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles')
        .set('Authorization', `Bearer ${deactivatedAdminToken}`);

      expect(res.status).toBe(401);
    });

    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/v1/admin/vehicles');
      expect(res.status).toBe(401);
    });

    it('supports search query parameter', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles?search=Hyundai')
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(adminVehicleRepository.listVehicles).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'Hyundai' }),
      );
    });

    it('supports category and status filters', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles?category=CAR&manualStatus=ONLINE&isArchived=false')
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(adminVehicleRepository.listVehicles).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'CAR',
          manualStatus: 'ONLINE',
          isArchived: false,
        }),
      );
    });

    it('returns 400 for invalid category filter', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles?category=BOAT')
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 for invalid date range (start >= end)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles?startDate=2026-09-20&endDate=2026-09-10')
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(400);
    });

    it('clamps excessive limit to 50', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles?limit=500')
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(adminVehicleRepository.listVehicles).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
    });
  });

  // ==========================================================================
  // 2. GET /api/v1/admin/vehicles/:id (Detail)
  // ==========================================================================
  describe('GET /api/v1/admin/vehicles/:id', () => {
    it('returns 200 with vehicle detail and summaries for authorized admin', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.vehicle.id).toBe(TEST_VEHICLE_ID);
      expect(res.body.data.vehicle.partner.businessName).toBe('Fast Wheels Mobility');
      expect(res.body.data.bookingSummary.total).toBe(20);
      expect(res.body.data.documentsSummary.verified).toBe(4);
      expect(res.body.data.pricing.pricePerDay).toBe(2500);
    });

    it('returns 404 when vehicle does not exist', async () => {
      const nonExistentId = 'e9999999-9999-4999-a999-999999999999';
      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${nonExistentId}`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 when id is malformed (not UUID)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles/not-a-uuid')
        .set('Authorization', `Bearer ${readOnlyAdminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 403 when admin lacks vehicles.read permission', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}`)
        .set('Authorization', `Bearer ${unauthorizedAdminToken}`);

      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  // 3. PATCH /api/v1/admin/vehicles/:id/status (Mutation)
  // ==========================================================================
  describe('PATCH /api/v1/admin/vehicles/:id/status', () => {
    it('returns 200 and updates status with audit log for authorized admin', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/status`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ manualStatus: 'OFFLINE', offlineReason: 'Scheduled Service' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.manualStatus).toBe('OFFLINE');

      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: VEHICLES_ADMIN.id,
          action: 'VEHICLE_STATUS_CHANGE',
          targetResource: 'VEHICLE',
          targetResourceId: TEST_VEHICLE_ID,
        }),
        expect.anything(),
      );
      expect(auditService.logAdminAction).toHaveBeenCalled();
    });

    it('returns 400 when taking offline with active bookings without force', async () => {
      jest.spyOn(adminVehicleRepository, 'getActiveBookingCount').mockResolvedValue(2);

      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/status`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ manualStatus: 'OFFLINE' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('active/upcoming bookings');
    });

    it('returns 200 when taking offline with active bookings with force: true', async () => {
      jest.spyOn(adminVehicleRepository, 'getActiveBookingCount').mockResolvedValue(2);

      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/status`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ manualStatus: 'OFFLINE', force: true });

      expect(res.status).toBe(200);
      expect(res.body.data.manualStatus).toBe('OFFLINE');
    });

    it('returns 403 when admin has read-only permission', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/status`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`)
        .send({ manualStatus: 'OFFLINE' });

      expect(res.status).toBe(403);
    });

    it('rejects mass-assignment attempts with extra fields', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/status`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ manualStatus: 'OFFLINE', partnerId: 'fake', category: 'BIKE' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Field \'partnerId\' is not allowed');
    });

    describe('lifecycle invariants: generic status cannot bypass block/deactivate/verification', () => {
      const lockAs = (overrides) => jest
        .spyOn(adminVehicleRepository, 'findVehicleByIdForUpdate')
        .mockResolvedValue({
          ...TEST_VEHICLE, verificationStatus: 'VERIFIED', isActive: true, isArchived: false, ...overrides,
        });

      it.each([
        ['blocked', { isActive: false, isArchived: false }, { manualStatus: 'ONLINE' }],
        ['deactivated', { isActive: false, isArchived: true }, { manualStatus: 'ONLINE' }],
        ['deactivated (un-archive + ONLINE)', { isActive: false, isArchived: true }, { isArchived: false, manualStatus: 'ONLINE' }],
        ['blocked (isArchived=false would clear the block)', { isActive: false, isArchived: false }, { isArchived: false }],
        ['PENDING', { verificationStatus: 'PENDING' }, { manual_status: 'ONLINE' }],
        ['REJECTED', { verificationStatus: 'REJECTED' }, { manualStatus: 'online' }],
      ])('returns 409 for a %s vehicle and does not write', async (_label, lockState, body) => {
        lockAs(lockState);
        const res = await request(app)
          .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/status`)
          .set('Authorization', `Bearer ${vehiclesAdminToken}`)
          .send(body);

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
        expect(adminVehicleRepository.updateVehicleStatus).not.toHaveBeenCalled();
      });

      it('returns 200 and sets ONLINE for an active, non-archived VERIFIED vehicle', async () => {
        lockAs({ manualStatus: 'OFFLINE' });
        adminVehicleRepository.updateVehicleStatus.mockResolvedValue({
          ...TEST_VEHICLE, verificationStatus: 'VERIFIED', manualStatus: 'ONLINE',
        });
        const res = await request(app)
          .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/status`)
          .set('Authorization', `Bearer ${vehiclesAdminToken}`)
          .send({ manualStatus: 'ONLINE' });

        expect(res.status).toBe(200);
        expect(res.body.data.manualStatus).toBe('ONLINE');
      });
    });
  });

  // ==========================================================================
  // 4. Verification Mutations (approve, reject, patch verification)
  // ==========================================================================
  describe('Verification Mutations', () => {
    it('POST /approve approves vehicle verification and logs action', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/approve`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ reason: 'All documents verified' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.verificationStatus).toBe('VERIFIED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'VEHICLE_APPROVED' }),
        expect.anything(),
      );
    });

    it('POST /reject rejects vehicle verification with reason', async () => {
      jest.spyOn(adminVehicleRepository, 'updateVehicleVerification').mockResolvedValue({
        ...TEST_VEHICLE,
        verificationStatus: 'REJECTED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/reject`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ reason: 'Insurance document expired' });

      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('REJECTED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'VEHICLE_REJECTED' }),
        expect.anything(),
      );
    });

    it('POST /reject returns 400 when reason is missing', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/reject`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Rejection reason is required');
    });

    it('PATCH /verification updates verification status directly', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/verification`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ status: 'VERIFIED', reason: 'Checked' });

      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('VERIFIED');
    });

    it('rejects verification mutation when admin lacks vehicles.verify permission', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/approve`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`)
        .send({});

      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  // 5. Subresources (documents, images, bookings, availability, pricing, earnings, history)
  // ==========================================================================
  describe('Subresources', () => {
    it('GET /documents returns vehicle documents safely', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/documents`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.documents).toHaveLength(1);
      expect(res.body.data.documents[0].documentType).toBe('RC');
    });

    it('GET /documents/:documentId returns specific document with presigned URL', async () => {
      const docId = 'd0000001-0000-4000-a000-000000000001';
      jest.spyOn(adminVehicleRepository, 'findVehicleDocumentById').mockResolvedValue({
        id: docId,
        vehicleId: TEST_VEHICLE_ID,
        documentType: 'RC',
        storageKey: 'partners/p-1/vehicles/v-1/documents/rc/test.pdf',
        verificationStatus: 'VERIFIED',
      });

      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/documents/${docId}`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(docId);
      expect(res.body.data.mimeType).toBe('application/pdf');
    });

    it('GET /documents/:documentId returns 404 when document does not belong to vehicle', async () => {
      const docId = 'd0000001-0000-4000-a000-000000000001';
      jest.spyOn(adminVehicleRepository, 'findVehicleDocumentById').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/documents/${docId}`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(404);
    });

    it('GET /images returns gallery images', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/images`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.images).toHaveLength(1);
      expect(res.body.data.images[0].isCover).toBe(true);
    });

    it('GET /bookings returns vehicle bookings with pagination', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/bookings`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.bookings).toHaveLength(1);
      expect(res.body.data.pagination.total).toBe(1);
    });

    it('GET /availability returns availability blocks', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/availability`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.vehicleId).toBe(TEST_VEHICLE_ID);
      expect(res.body.data.availabilityBlocks).toHaveLength(1);
    });

    it('GET /pricing returns pricing rates', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/pricing`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.pricing.pricePerDay).toBe(2500);
    });

    it('GET /earnings returns revenue and booking aggregates', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/earnings`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.grossRevenue).toBe(36000);
    });

    it('GET /history returns audit trail', async () => {
      const res = await request(app)
        .get(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/history`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.history).toHaveLength(1);
      expect(res.body.data.history[0].action).toBe('VEHICLE_STATUS_CHANGE');
    });
  });

  // ==========================================================================
  // 6. Security & Hardening Tests
  // ==========================================================================
  describe('Security & Hardening Protection', () => {
    it('ignores spoofed x-admin or x-role headers', async () => {
      const res = await request(app)
        .get('/api/v1/admin/vehicles')
        .set('Authorization', `Bearer ${unauthorizedAdminToken}`)
        .set('x-admin', 'true')
        .set('x-role', 'ADMIN');

      expect(res.status).toBe(403);
    });

    it('ignores vehicleId / partnerId in body for BOLA/IDOR protection', async () => {
      const otherId = 'e2222222-2222-4222-a222-222222222222';
      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/status`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ id: otherId, vehicleId: otherId, partnerId: otherId, manualStatus: 'ONLINE' });

      // Mass assignment kicks in and rejects unapproved fields
      expect(res.status).toBe(400);
    });

    it('rejects prototype pollution attempts', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/status`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send(JSON.parse('{"manualStatus": "ONLINE", "constructor": {"admin": true}}'));

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ==========================================================================
  // Lifecycle: PATCH /:id/block, /:id/activate, /:id/deactivate
  // ==========================================================================
  describe('PATCH /api/v1/admin/vehicles/:id/{block,activate,deactivate}', () => {
    const lockAs = (overrides) => jest
      .spyOn(adminVehicleRepository, 'findVehicleByIdForUpdate')
      .mockResolvedValue({ ...TEST_VEHICLE, isActive: true, ...overrides });

    it('block returns 200 and writes a temporary hold (is_active=false, is_archived=false)', async () => {
      lockAs({});
      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/block`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ reason: 'Compliance hold' });

      expect(res.status).toBe(200);
      expect(adminVehicleRepository.findVehicleByIdForUpdate).toHaveBeenCalled();
      expect(adminVehicleRepository.updateVehicleStatus).toHaveBeenCalledWith(
        TEST_VEHICLE_ID,
        expect.objectContaining({
          manualStatus: 'OFFLINE', isActive: false, isArchived: false, offlineReason: 'Compliance hold',
        }),
        expect.anything(),
      );
    });

    it('activate returns 409 for a REJECTED vehicle', async () => {
      lockAs({ verificationStatus: 'REJECTED', manualStatus: 'OFFLINE', isActive: false });
      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/activate`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ reason: 'Try' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(adminVehicleRepository.updateVehicleStatus).not.toHaveBeenCalled();
    });

    it('activate returns 200 but keeps a PENDING vehicle OFFLINE', async () => {
      lockAs({ verificationStatus: 'PENDING', manualStatus: 'OFFLINE', isArchived: true, isActive: false });
      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/activate`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(adminVehicleRepository.updateVehicleStatus).toHaveBeenCalledWith(
        TEST_VEHICLE_ID,
        expect.objectContaining({ manualStatus: 'OFFLINE', isActive: true, isArchived: false }),
        expect.anything(),
      );
    });

    it('deactivate succeeds with active bookings (kept intact) and archives the vehicle', async () => {
      lockAs({});
      adminVehicleRepository.getActiveBookingCount.mockResolvedValue(2);

      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/deactivate`)
        .set('Authorization', `Bearer ${vehiclesAdminToken}`)
        .send({ reason: 'Exit' });
      expect(res.status).toBe(200);
      expect(adminVehicleRepository.updateVehicleStatus).toHaveBeenCalledWith(
        TEST_VEHICLE_ID,
        expect.objectContaining({ manualStatus: 'OFFLINE', isActive: false, isArchived: true }),
        expect.anything(),
      );
    });

    it('returns 403 for a read-only admin', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/vehicles/${TEST_VEHICLE_ID}/block`)
        .set('Authorization', `Bearer ${readOnlyAdminToken}`)
        .send({});
      expect(res.status).toBe(403);
    });
  });
});
