'use strict';

const firebaseProvider = require('../../../src/services/notification/providers/firebase.provider');
const { setMockFirebaseMessaging } = require('../../../src/config/firebase');
const {
  NOTIFICATION_SOUNDS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
} = require('../../../src/constants/notification');
const SupportService = require('../../../src/services/support.service');
const { TICKET_STATUS, TICKET_SENDER_TYPE } = require('../../../src/constants/support');

describe('GONGO Custom Notification Sound & Support Notifications — Phase 12', () => {
  afterEach(() => {
    firebaseProvider.setMockDelegate(null);
    setMockFirebaseMessaging(null);
  });

  describe('Notification Sound & Channel Constants', () => {
    it('1. defines branded sound constants with default gongo_tune', () => {
      expect(NOTIFICATION_SOUNDS).toBeDefined();
      expect(NOTIFICATION_SOUNDS.DEFAULT).toBe('gongo_tune');
      expect(NOTIFICATION_SOUNDS.NONE).toBe('default');
    });

    it('2. defines notification channels for rentals and support', () => {
      expect(NOTIFICATION_CHANNELS).toBeDefined();
      expect(NOTIFICATION_CHANNELS.DEFAULT).toBe('gongo_rental_notifications');
      expect(NOTIFICATION_CHANNELS.SUPPORT).toBe('gongo_support_notifications');
    });

    it('3. defines SUPPORT_REPLY notification type', () => {
      expect(NOTIFICATION_TYPES.SUPPORT_REPLY).toBe('SUPPORT_REPLY');
    });
  });

  describe('FCM Provider Payload Configuration for Sound & Channel', () => {
    it('4. configures default gongo_tune sound and channel on Android and APNs', async () => {
      let capturedMessage = null;

      const mockMessaging = {
        sendEachForMulticast: jest.fn().mockImplementation(async (message) => {
          capturedMessage = message;
          return {
            successCount: 1,
            failureCount: 0,
            responses: [{ success: true }],
          };
        }),
      };
      setMockFirebaseMessaging(mockMessaging);

      const result = await firebaseProvider.sendMulticast({
        tokens: ['device_token_abc'],
        title: 'Booking Confirmed',
        body: 'Your ride is ready',
      });

      expect(result.successCount).toBe(1);
      expect(capturedMessage).not.toBeNull();

      // Android configuration
      expect(capturedMessage.android).toBeDefined();
      expect(capturedMessage.android.notification).toBeDefined();
      expect(capturedMessage.android.notification.sound).toBe('gongo_tune');
      expect(capturedMessage.android.notification.channelId).toBe('gongo_rental_notifications');

      // iOS APNs configuration (.wav extension required for iOS)
      expect(capturedMessage.apns).toBeDefined();
      expect(capturedMessage.apns.payload).toBeDefined();
      expect(capturedMessage.apns.payload.aps).toBeDefined();
      expect(capturedMessage.apns.payload.aps.sound).toBe('gongo_tune.wav');
    });

    it('5. accepts explicit support channel and custom sound', async () => {
      let capturedMessage = null;

      const mockMessaging = {
        sendEachForMulticast: jest.fn().mockImplementation(async (message) => {
          capturedMessage = message;
          return {
            successCount: 1,
            failureCount: 0,
            responses: [{ success: true }],
          };
        }),
      };
      setMockFirebaseMessaging(mockMessaging);

      await firebaseProvider.sendMulticast({
        tokens: ['device_token_xyz'],
        title: 'Support Update',
        body: 'Agent replied to your ticket',
        sound: NOTIFICATION_SOUNDS.DEFAULT,
        channelId: NOTIFICATION_CHANNELS.SUPPORT,
      });

      expect(capturedMessage.android.notification.sound).toBe('gongo_tune');
      expect(capturedMessage.android.notification.channelId).toBe('gongo_support_notifications');
      expect(capturedMessage.apns.payload.aps.sound).toBe('gongo_tune.wav');
    });

    it('6. avoids appending double .wav extension if sound already has .wav', async () => {
      let capturedMessage = null;

      const mockMessaging = {
        sendEachForMulticast: jest.fn().mockImplementation(async (message) => {
          capturedMessage = message;
          return {
            successCount: 1,
            failureCount: 0,
            responses: [{ success: true }],
          };
        }),
      };
      setMockFirebaseMessaging(mockMessaging);

      await firebaseProvider.sendMulticast({
        tokens: ['device_token_xyz'],
        title: 'Alert',
        body: 'Test alert',
        sound: 'alert_sound.wav',
      });

      expect(capturedMessage.apns.payload.aps.sound).toBe('alert_sound.wav');
    });
  });

  describe('Support Service Notification Dispatch', () => {
    it('7. dispatches push notification with gongo_tune sound and support channel on reply', async () => {
      const mockTicket = {
        id: '11111111-1111-4111-8111-111111111111',
        ticketNumber: 'TKT-20260919-ABC',
        customerId: '22222222-2222-4222-8222-222222222222',
        subject: 'Query on rental deposit',
        status: TICKET_STATUS.OPEN,
      };

      const mockTicketRepo = {
        findById: jest.fn().mockResolvedValue(mockTicket),
        transaction: jest.fn().mockImplementation(async (callback) => callback({})),
        updateStatus: jest.fn().mockResolvedValue({
          ...mockTicket,
          status: TICKET_STATUS.WAITING_FOR_CUSTOMER,
        }),
      };

      const mockMessage = {
        id: '33333333-3333-4333-8333-333333333333',
        ticketId: mockTicket.id,
        senderType: TICKET_SENDER_TYPE.SUPPORT,
        senderId: '44444444-4444-4444-8444-444444444444',
        message: 'Your refund has been initiated.',
        attachments: [],
        createdAt: new Date().toISOString(),
      };

      const mockMessageRepo = {
        create: jest.fn().mockResolvedValue(mockMessage),
      };

      const mockNotifService = {
        sendNotification: jest.fn().mockResolvedValue({ id: 'notif-1', status: 'SENT' }),
      };

      const supportService = new SupportService.constructor(
        mockTicketRepo,
        mockMessageRepo,
        {},
        mockNotifService,
      );

      const reply = await supportService.addSupportReply(mockTicket.id, {
        supportAgentId: '44444444-4444-4444-8444-444444444444',
        message: 'Your refund has been initiated.',
      });

      expect(reply.id).toBe(mockMessage.id);
      expect(mockNotifService.sendNotification).toHaveBeenCalledWith({
        customerId: mockTicket.customerId,
        type: NOTIFICATION_TYPES.SUPPORT_REPLY,
        title: `Support Update: ${mockTicket.subject}`,
        body: 'Your refund has been initiated.',
        data: {
          ticketId: mockTicket.id,
          ticketNumber: mockTicket.ticketNumber,
        },
        sound: NOTIFICATION_SOUNDS.DEFAULT,
        channelId: NOTIFICATION_CHANNELS.SUPPORT,
      });
    });
  });
});
