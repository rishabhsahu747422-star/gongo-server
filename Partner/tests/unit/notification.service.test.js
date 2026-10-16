'use strict';

const NotificationService = require('../../src/services/notification.service').constructor;
const { NotFoundError } = require('../../src/errors');

describe('Unit: NotificationService', () => {
  let mockNotificationRepo;
  let notificationService;

  beforeEach(() => {
    mockNotificationRepo = {
      findPaginatedByPartnerId: jest.fn(),
      getUnreadCountByPartnerId: jest.fn(),
      markAsReadByIdAndPartnerId: jest.fn(),
      markAllAsReadByPartnerId: jest.fn(),
      upsertDeviceToken: jest.fn(),
      removeDeviceToken: jest.fn(),
      createNotification: jest.fn(),
    };
    notificationService = new NotificationService(mockNotificationRepo);
  });

  describe('getNotifications', () => {
    it('returns formatted notifications with pagination metadata', async () => {
      mockNotificationRepo.findPaginatedByPartnerId.mockResolvedValue({
        rows: [
          {
            id: 'notif-1',
            partner_id: 'partner-1',
            type: 'POST_RENTAL_SETTLEMENT_SUCCESS',
            title: 'Settlement Received',
            body: 'Charges of ₹300 collected',
            payload: { bookingId: 'b-1' },
            read_at: null,
            event_key: 'key-1',
            created_at: '2026-03-01T10:00:00.000Z',
          },
        ],
        total: 1,
      });

      const res = await notificationService.getNotifications('partner-1', { page: 1, limit: 20 });
      expect(res.items).toHaveLength(1);
      expect(res.items[0].id).toBe('notif-1');
      expect(res.items[0].isRead).toBe(false);
      expect(res.pagination.totalItems).toBe(1);
    });
  });

  describe('getUnreadCount', () => {
    it('returns unread notification count', async () => {
      mockNotificationRepo.getUnreadCountByPartnerId.mockResolvedValue(5);

      const res = await notificationService.getUnreadCount('partner-1');
      expect(res.unreadCount).toBe(5);
    });
  });

  describe('markAsRead', () => {
    it('marks notification as read', async () => {
      mockNotificationRepo.markAsReadByIdAndPartnerId.mockResolvedValue({
        id: 'notif-1',
        partner_id: 'partner-1',
        type: 'SETTLEMENT',
        title: 'Title',
        body: 'Body',
        payload: {},
        read_at: '2026-03-01T11:00:00.000Z',
        created_at: '2026-03-01T10:00:00.000Z',
      });

      const res = await notificationService.markAsRead('partner-1', 'notif-1');
      expect(res.id).toBe('notif-1');
      expect(res.isRead).toBe(true);
    });

    it('throws NotFoundError if notification not found or unowned (BOLA)', async () => {
      mockNotificationRepo.markAsReadByIdAndPartnerId.mockResolvedValue(null);

      await expect(
        notificationService.markAsRead('partner-1', 'notif-foreign'),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('registerDeviceToken & removeDeviceToken', () => {
    it('registers FCM device token', async () => {
      mockNotificationRepo.upsertDeviceToken.mockResolvedValue({
        id: 'token-1',
        partner_id: 'partner-1',
        platform: 'android',
        is_active: true,
        updated_at: '2026-03-01T10:00:00.000Z',
      });

      const res = await notificationService.registerDeviceToken('partner-1', {
        token: 'fcm-token-123',
        platform: 'android',
      });

      expect(res.id).toBe('token-1');
      expect(res.isActive).toBe(true);
    });

    it('removes device token', async () => {
      mockNotificationRepo.removeDeviceToken.mockResolvedValue(true);

      const res = await notificationService.removeDeviceToken('partner-1', {
        token: 'fcm-token-123',
      });

      expect(res.removed).toBe(true);
    });
  });
});
