'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const notificationService = require('../../src/services/notification.service');

describe('Integration: Partner Notifications & Device Token APIs (Phase 13)', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const notif1Id = '66666666-6666-4666-a666-666666666666';

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
        };
      }
      return null;
    });
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  describe('GET /api/v1/partner/notifications', () => {
    it('returns paginated list of notifications for authenticated partner', async () => {
      jest.spyOn(notificationService, 'getNotifications').mockResolvedValue({
        items: [
          {
            id: notif1Id,
            partnerId: partner1Id,
            type: 'POST_RENTAL_SETTLEMENT_SUCCESS',
            title: 'Settlement Received',
            body: 'Charges received',
            payload: {},
            readAt: null,
            isRead: false,
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
        .get('/api/v1/partner/notifications')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].id).toBe(notif1Id);
    });

    it('rejects unauthenticated requests with 401', async () => {
      await request(app)
        .get('/api/v1/partner/notifications')
        .expect(401);
    });
  });

  describe('GET /api/v1/partner/notifications/unread-count', () => {
    it('returns unread count', async () => {
      jest.spyOn(notificationService, 'getUnreadCount').mockResolvedValue({ unreadCount: 3 });

      const res = await request(app)
        .get('/api/v1/partner/notifications/unread-count')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.unreadCount).toBe(3);
    });
  });

  describe('PATCH /api/v1/partner/notifications/:notificationId/read', () => {
    it('marks notification as read', async () => {
      jest.spyOn(notificationService, 'markAsRead').mockResolvedValue({
        id: notif1Id,
        partnerId: partner1Id,
        isRead: true,
      });

      const res = await request(app)
        .patch(`/api/v1/partner/notifications/${notif1Id}/read`)
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.isRead).toBe(true);
    });
  });

  describe('PATCH /api/v1/partner/notifications/read-all', () => {
    it('marks all notifications as read', async () => {
      jest.spyOn(notificationService, 'markAllAsRead').mockResolvedValue({ updatedCount: 5 });

      const res = await request(app)
        .patch('/api/v1/partner/notifications/read-all')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.updatedCount).toBe(5);
    });
  });

  describe('Device Token APIs', () => {
    it('POST /api/v1/partner/notifications/device-token registers FCM device token', async () => {
      jest.spyOn(notificationService, 'registerDeviceToken').mockResolvedValue({
        id: 'tok-1',
        partnerId: partner1Id,
        platform: 'android',
        isActive: true,
      });

      const res = await request(app)
        .post('/api/v1/partner/notifications/device-token')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ token: 'test-fcm-token', platform: 'android' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('tok-1');
    });

    it('DELETE /api/v1/partner/notifications/device-token removes token', async () => {
      jest.spyOn(notificationService, 'removeDeviceToken').mockResolvedValue({ removed: true });

      const res = await request(app)
        .delete('/api/v1/partner/notifications/device-token')
        .set('Authorization', 'Bearer partner-1-token')
        .send({ token: 'test-fcm-token' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.removed).toBe(true);
    });
  });
});
