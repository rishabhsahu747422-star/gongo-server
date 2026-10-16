'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const availabilityRepository = require('../../src/repositories/availability.repository');
const pool = require('../../src/db/pool');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Vehicle Calendar Availability API', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-1111-1111-111111111111';
  const partner2Id = '22222222-2222-2222-2222-222222222222';
  const vehicle1Id = 'aaaa1111-1111-1111-1111-111111111111';
  const block1Id = 'bbbb1111-1111-1111-1111-111111111111';

  const futureStart = new Date(Date.now() + 86400000).toISOString();
  const futureEnd = new Date(Date.now() + 2 * 86400000).toISOString();

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'partner-1-token') {
          return { uid: 'uid-partner-1', phone_number: '+919876543210' };
        }
        if (token === 'partner-2-token') {
          return { uid: 'uid-partner-2', phone_number: '+919876543211' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === 'uid-partner-1' || idOrAuth === partner1Id) {
        return {
          id: partner1Id,
          partnerId: partner1Id,
          userId: 'user-partner-1',
          auth_id: 'uid-partner-1',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      if (idOrAuth === 'uid-partner-2' || idOrAuth === partner2Id) {
        return {
          id: partner2Id,
          partnerId: partner2Id,
          userId: 'user-partner-2',
          auth_id: 'uid-partner-2',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      return null;
    });
  });

  // ── GET /api/v1/partner/vehicles/:vehicleId/availability ───────────
  describe('GET /api/v1/partner/vehicles/:vehicleId/availability', () => {
    it('returns 200 with availability blocks for owned vehicle', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
      });

      jest.spyOn(availabilityRepository, 'findBlocksByVehicleId').mockResolvedValue([
        {
          id: block1Id,
          vehicle_id: vehicle1Id,
          start_time: futureStart,
          end_time: futureEnd,
          reason: 'Maintenance',
          is_active: true,
          created_by: partner1Id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/availability`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].id).toBe(block1Id);
      expect(res.body.data[0].reason).toBe('Maintenance');
    });

    it('returns 404 when partner attempts to access another partner availability (BOLA)', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicle1Id}/availability`)
        .set('Authorization', 'Bearer partner-2-token');

      expect(res.status).toBe(404);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get(`/api/v1/partner/vehicles/${vehicle1Id}/availability`);
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/v1/partner/vehicles/:vehicleId/availability ──────────
  describe('POST /api/v1/partner/vehicles/:vehicleId/availability', () => {
    const validBlockPayload = {
      startTime: futureStart,
      endTime: futureEnd,
      reason: 'Service',
    };

    it('creates an availability block successfully and returns 201', async () => {
      const mockClient = {};
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb(mockClient));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        is_archived: false,
      });

      jest.spyOn(availabilityRepository, 'findOverlappingBlocks').mockResolvedValue(null);
      jest.spyOn(availabilityRepository, 'createBlock').mockResolvedValue({
        id: block1Id,
        vehicle_id: vehicle1Id,
        start_time: futureStart,
        end_time: futureEnd,
        reason: 'Service',
        is_active: true,
        created_by: partner1Id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await request(app)
        .post(`/api/v1/partner/vehicles/${vehicle1Id}/availability`)
        .set('Authorization', 'Bearer partner-1-token')
        .send(validBlockPayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(block1Id);
      expect(res.body.data.reason).toBe('Service');
    });

    it('returns 409 Conflict when block overlaps with an existing active block', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        is_archived: false,
      });

      jest.spyOn(availabilityRepository, 'findOverlappingBlocks').mockResolvedValue({
        id: 'existing-block-id',
      });

      const res = await request(app)
        .post(`/api/v1/partner/vehicles/${vehicle1Id}/availability`)
        .set('Authorization', 'Bearer partner-1-token')
        .send(validBlockPayload);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when endTime <= startTime', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/vehicles/${vehicle1Id}/availability`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          startTime: futureEnd,
          endTime: futureStart,
          reason: 'Service',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('returns 400 when reason is outside allowed taxonomy', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/vehicles/${vehicle1Id}/availability`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          startTime: futureStart,
          endTime: futureEnd,
          reason: 'Road Trip Holiday',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('rejects mass-assignment attempts (injecting id or created_by)', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/vehicles/${vehicle1Id}/availability`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          ...validBlockPayload,
          created_by: 'some-user',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });

    it('returns 409 Conflict when attempting to block an archived vehicle', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
        is_archived: true,
      });

      const res = await request(app)
        .post(`/api/v1/partner/vehicles/${vehicle1Id}/availability`)
        .set('Authorization', 'Bearer partner-1-token')
        .send(validBlockPayload);

      expect(res.status).toBe(409);
    });
  });

  // ── PATCH /api/v1/partner/vehicles/:vehicleId/availability/:blockId ─
  describe('PATCH /api/v1/partner/vehicles/:vehicleId/availability/:blockId', () => {
    it('updates block successfully and returns 200', async () => {
      const mockClient = {};
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb(mockClient));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
      });

      jest.spyOn(availabilityRepository, 'findBlockByIdAndVehicleId').mockResolvedValue({
        id: block1Id,
        vehicle_id: vehicle1Id,
        start_time: futureStart,
        end_time: futureEnd,
        reason: 'Maintenance',
        is_active: true,
      });

      jest.spyOn(availabilityRepository, 'findOverlappingBlocks').mockResolvedValue(null);
      jest.spyOn(availabilityRepository, 'updateBlock').mockResolvedValue({
        id: block1Id,
        vehicle_id: vehicle1Id,
        start_time: futureStart,
        end_time: futureEnd,
        reason: 'Damage',
        is_active: true,
      });

      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}/availability/${block1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({ reason: 'Damage' });

      expect(res.status).toBe(200);
      expect(res.body.data.reason).toBe('Damage');
    });

    it('returns 404 when block does not exist', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
      });

      jest.spyOn(availabilityRepository, 'findBlockByIdAndVehicleId').mockResolvedValue(null);

      const res = await request(app)
        .patch(`/api/v1/partner/vehicles/${vehicle1Id}/availability/${block1Id}`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({ reason: 'Damage' });

      expect(res.status).toBe(404);
    });
  });

  // ── DELETE /api/v1/partner/vehicles/:vehicleId/availability/:blockId ──
  describe('DELETE /api/v1/partner/vehicles/:vehicleId/availability/:blockId', () => {
    it('soft-deletes availability block and returns 200', async () => {
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerIdForUpdate').mockResolvedValue({
        id: vehicle1Id,
        partner_id: partner1Id,
      });

      jest.spyOn(availabilityRepository, 'findBlockByIdAndVehicleId').mockResolvedValue({
        id: block1Id,
        vehicle_id: vehicle1Id,
        start_time: futureStart,
        end_time: futureEnd,
      });

      jest.spyOn(availabilityRepository, 'deactivateBlock').mockResolvedValue({
        id: block1Id,
        is_active: false,
      });

      const res = await request(app)
        .delete(`/api/v1/partner/vehicles/${vehicle1Id}/availability/${block1Id}`)
        .set('Authorization', 'Bearer partner-1-token');

      expect(res.status).toBe(200);
      expect(res.body.data.blockId).toBe(block1Id);
      expect(res.body.data.message).toBe('Availability block removed successfully');
    });
  });
});
