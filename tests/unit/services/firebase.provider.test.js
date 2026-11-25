'use strict';

const NotificationProvider = require('../../../src/services/notification/providers/notification.provider');
const firebaseProvider = require('../../../src/services/notification/providers/firebase.provider');
const { setMockFirebaseMessaging } = require('../../../src/config/firebase');

describe('Notification Provider Unit Tests — Phase 11', () => {
  afterEach(() => {
    firebaseProvider.setMockDelegate(null);
    setMockFirebaseMessaging(null);
  });

  describe('NotificationProvider (Abstract Class)', () => {
    it('1. throws error when sendMulticast is called directly on base class', async () => {
      const baseProvider = new NotificationProvider();
      await expect(baseProvider.sendMulticast({ tokens: [] })).rejects.toThrow(
        'NotificationProvider.sendMulticast must be implemented by subclass',
      );
    });
  });

  describe('FirebaseNotificationProvider.formatPayloadData', () => {
    it('2. converts all data values strictly to strings for FCM compatibility', () => {
      const input = {
        bookingId: '12345',
        amount: 500,
        isActive: true,
        nested: { key: 'val' },
      };

      const formatted = firebaseProvider.constructor.formatPayloadData(input);
      expect(formatted).toEqual({
        bookingId: '12345',
        amount: '500',
        isActive: 'true',
        nested: '{"key":"val"}',
      });
    });

    it('3. filters out sensitive fields from push notification payload data', () => {
      const input = {
        bookingId: '12345',
        password: 'supersecretpassword',
        otp: '123456',
        token: 'auth-jwt-token',
        secret: 'cf_secret',
        credentials: 'rsa-key',
      };

      const formatted = firebaseProvider.constructor.formatPayloadData(input);
      expect(formatted).toEqual({
        bookingId: '12345',
      });
      expect(formatted.password).toBeUndefined();
      expect(formatted.otp).toBeUndefined();
      expect(formatted.secret).toBeUndefined();
    });

    it('4. returns empty object when data is null or non-object', () => {
      expect(firebaseProvider.constructor.formatPayloadData(null)).toEqual({});
      expect(firebaseProvider.constructor.formatPayloadData(undefined)).toEqual({});
      expect(firebaseProvider.constructor.formatPayloadData('string')).toEqual({});
    });
  });

  describe('FirebaseNotificationProvider.sendMulticast', () => {
    it('5. returns zero counts when tokens array is empty without calling provider', async () => {
      const res = await firebaseProvider.sendMulticast({
        tokens: [],
        title: 'Hello',
        body: 'World',
      });

      expect(res).toEqual({
        successCount: 0,
        failureCount: 0,
        invalidTokens: [],
      });
    });

    it('6. delegates to mockDelegate when delegate is provided', async () => {
      const mockDelegate = {
        sendMulticast: jest.fn().mockResolvedValue({
          successCount: 2,
          failureCount: 0,
          invalidTokens: [],
        }),
      };
      firebaseProvider.setMockDelegate(mockDelegate);

      const res = await firebaseProvider.sendMulticast({
        tokens: ['token1', 'token2'],
        title: 'Test Title',
        body: 'Test Body',
      });

      expect(mockDelegate.sendMulticast).toHaveBeenCalledWith({
        tokens: ['token1', 'token2'],
        title: 'Test Title',
        body: 'Test Body',
        data: {},
        sound: 'gongo_tune',
        channelId: 'gongo_rental_notifications',
      });
      expect(res.successCount).toBe(2);
    });

    it('7. returns FCM_NOT_INITIALIZED when messaging client is not initialized', async () => {
      setMockFirebaseMessaging(null);

      const res = await firebaseProvider.sendMulticast({
        tokens: ['token1'],
        title: 'Test',
        body: 'Test',
      });

      expect(res.reason).toBe('FCM_NOT_INITIALIZED');
      expect(res.failureCount).toBe(1);
    });

    it('8. parses FCM response and extracts invalid/unregistered tokens', async () => {
      const mockMessaging = {
        sendEachForMulticast: jest.fn().mockResolvedValue({
          successCount: 1,
          failureCount: 2,
          responses: [
            { success: true, messageId: 'msg-1' },
            {
              success: false,
              error: { code: 'messaging/invalid-registration-token', message: 'Token is invalid' },
            },
            {
              success: false,
              error: { code: 'messaging/registration-token-not-registered', message: 'Unregistered' },
            },
          ],
        }),
      };
      setMockFirebaseMessaging(mockMessaging);

      const res = await firebaseProvider.sendMulticast({
        tokens: ['valid_tok', 'invalid_tok_1', 'unregistered_tok_2'],
        title: 'Test',
        body: 'Test',
      });

      expect(res.successCount).toBe(1);
      expect(res.failureCount).toBe(2);
      expect(res.invalidTokens).toEqual(['invalid_tok_1', 'unregistered_tok_2']);
    });

    it('9. safely catches thrown exceptions without crashing and returns failure count', async () => {
      const mockMessaging = {
        sendEachForMulticast: jest.fn().mockRejectedValue(new Error('Network timeout connecting to FCM')),
      };
      setMockFirebaseMessaging(mockMessaging);

      const res = await firebaseProvider.sendMulticast({
        tokens: ['tok1', 'tok2'],
        title: 'Test',
        body: 'Test',
      });

      expect(res.successCount).toBe(0);
      expect(res.failureCount).toBe(2);
      expect(res.reason).toBe('Network timeout connecting to FCM');
    });
  });
});
