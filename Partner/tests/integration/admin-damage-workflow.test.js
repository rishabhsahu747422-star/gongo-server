'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const adminDamageService = require('../../src/services/admin-damage.service');

describe('Integration: Admin Settlement & Damage Workflow APIs (Phase 12E)', () => {
  let app;
  let mockAuth;

  const adminUserId = '99999999-9999-4999-a999-999999999999';
  const partnerUserId = '11111111-1111-4111-a111-111111111111';
  const damage1Id = '88888888-8888-4888-a888-888888888888';

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'admin-token') {
          return { uid: 'uid-admin', phone_number: '+919999999999' };
        }
        if (token === 'partner-token') {
          return { uid: 'uid-partner', phone_number: '+919876543210' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === 'uid-admin' || idOrAuth === adminUserId) {
        return {
          id: adminUserId,
          userId: adminUserId,
          auth_id: 'uid-admin',
          role: 'ADMIN',
          is_active: true,
        };
      }
      if (idOrAuth === 'uid-partner' || idOrAuth === partnerUserId) {
        return {
          id: partnerUserId,
          partnerId: partnerUserId,
          userId: partnerUserId,
          auth_id: 'uid-partner',
          role: 'PARTNER',
          is_active: true,
        };
      }
      return null;
    });
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  describe('Role-Based Access Control (RBAC)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      await request(app)
        .get('/api/v1/admin/damages')
        .expect(401);
    });

    it('rejects PARTNER role access to admin endpoints with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/v1/admin/damages')
        .set('Authorization', 'Bearer partner-token')
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('allows ADMIN role access to admin endpoints', async () => {
      jest.spyOn(adminDamageService, 'listDamages').mockResolvedValue({
        items: [],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 0,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/admin/damages')
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  describe('Admin Damage Workflow Operations', () => {
    it('GET /api/v1/admin/damages returns paginated damages list', async () => {
      jest.spyOn(adminDamageService, 'listDamages').mockResolvedValue({
        items: [
          {
            id: damage1Id,
            bookingId: 'book-1',
            bookingNumber: 'BK-1001',
            vehicleId: 'veh-1',
            vehicle: {
              registrationNumber: 'KA01AB1234',
              brand: 'Honda',
              model: 'Activa',
            },
            reportedBy: partnerUserId,
            damageType: 'SCRATCH',
            description: 'Scratch on side panel',
            estimatedAmount: 500.00,
            approvedAmount: null,
            status: 'REPORTED',
            photos: [],
            createdAt: '2026-03-01T10:00:00.000Z',
          },
        ],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/admin/damages')
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].id).toBe(damage1Id);
    });

    it('GET /api/v1/admin/damages/:damageId returns single damage report', async () => {
      jest.spyOn(adminDamageService, 'getDamageById').mockResolvedValue({
        id: damage1Id,
        bookingId: 'book-1',
        description: 'Scratch on side panel',
        estimatedAmount: 500.00,
        status: 'REPORTED',
      });

      const res = await request(app)
        .get(`/api/v1/admin/damages/${damage1Id}`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(damage1Id);
    });

    it('PATCH /api/v1/admin/damages/:damageId/review moves to UNDER_REVIEW', async () => {
      jest.spyOn(adminDamageService, 'markUnderReview').mockResolvedValue({
        id: damage1Id,
        status: 'UNDER_REVIEW',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/damages/${damage1Id}/review`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('UNDER_REVIEW');
    });

    it('PATCH /api/v1/admin/damages/:damageId/approve approves damage with approvedAmount', async () => {
      jest.spyOn(adminDamageService, 'approveDamage').mockResolvedValue({
        id: damage1Id,
        status: 'APPROVED',
        approvedAmount: 450.00,
      });

      const res = await request(app)
        .patch(`/api/v1/admin/damages/${damage1Id}/approve`)
        .set('Authorization', 'Bearer admin-token')
        .send({ approvedAmount: 450 })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('APPROVED');
      expect(res.body.data.approvedAmount).toBe(450.00);
      expect(adminDamageService.approveDamage).toHaveBeenCalledWith(
        damage1Id,
        { approvedAmount: 450.00 },
      );
    });

    it('PATCH /api/v1/admin/damages/:damageId/reject rejects damage', async () => {
      jest.spyOn(adminDamageService, 'rejectDamage').mockResolvedValue({
        id: damage1Id,
        status: 'REJECTED',
      });

      const res = await request(app)
        .patch(`/api/v1/admin/damages/${damage1Id}/reject`)
        .set('Authorization', 'Bearer admin-token')
        .send({ reason: 'Pre-existing condition' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('REJECTED');
    });

    it('PATCH /api/v1/admin/damages/:damageId/settle marks damage SETTLED', async () => {
      jest.spyOn(adminDamageService, 'settleDamage').mockResolvedValue({
        id: damage1Id,
        status: 'SETTLED',
        approvedAmount: 450.00,
      });

      const res = await request(app)
        .patch(`/api/v1/admin/damages/${damage1Id}/settle`)
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('SETTLED');
    });
  });
});
