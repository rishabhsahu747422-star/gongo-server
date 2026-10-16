'use strict';

const { AdminNotificationService } = require('../../src/services/admin-notification.service');
const auditService = require('../../src/services/audit.service');
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require('../../src/errors');

const TEST_ADMIN_USER = {
  id: 'a0000001-0000-4000-a000-000000000001',
  name: 'Super Admin',
  email: 'admin@gongo.in',
  role: 'ADMIN',
  is_active: true,
};

const TEST_CUSTOMER_ID = 'c0000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'b0000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'ba000001-0000-4000-a000-000000000001';
const TEST_NOTIFICATION_ID = 'da000001-0000-4000-a000-000000000001';
const TEST_TEMPLATE_ID = 'ea000001-0000-4000-a000-000000000001';

describe('Unit: AdminNotificationService', () => {
  let service;
  let mockNotificationRepo;
  let mockActionRepo;
  let mockPushProvider;

  beforeEach(() => {
    mockNotificationRepo = {
      listNotifications: jest.fn(),
      findNotificationById: jest.fn(),
      findByEventKey: jest.fn(),
      createNotification: jest.fn(),
      createPartnerNotification: jest.fn(),
      updateNotificationDelivery: jest.fn().mockResolvedValue({}),
      getRecipientUser: jest.fn(),
      getRecipientPartner: jest.fn(),
      getBookingForRecipient: jest.fn(),
      findRecipientDeviceTokens: jest.fn(),
      deactivateDeviceTokens: jest.fn().mockResolvedValue({}),
      listTemplates: jest.fn(),
      findTemplateById: jest.fn(),
      findTemplateByKey: jest.fn(),
      createTemplate: jest.fn(),
      updateTemplate: jest.fn(),
      setTemplateActiveState: jest.fn(),
      createOutboxEvent: jest.fn(),
      updateOutboxEventStatus: jest.fn().mockResolvedValue({}),
      withTransaction: jest.fn(async (cb) => cb({})),
    };

    mockActionRepo = {
      createAction: jest.fn().mockResolvedValue({ id: 'action-1' }),
    };

    mockPushProvider = {
      sendMulticast: jest.fn().mockResolvedValue({
        success: true,
        successCount: 1,
        failureCount: 0,
        invalidTokens: [],
        messageId: 'msg-fcm-1',
      }),
    };

    jest.spyOn(auditService, 'logAdminAction').mockReturnValue({ id: 'audit-1' });

    service = new AdminNotificationService(
      mockNotificationRepo,
      mockActionRepo,
      mockPushProvider,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. Notification Querying & Visibility
  // ══════════════════════════════════════════════════════════════════════════════
  describe('1. Notification Queries', () => {
    it('listNotifications delegates to repository with sanitized params', async () => {
      mockNotificationRepo.listNotifications.mockResolvedValueOnce({
        items: [{ id: TEST_NOTIFICATION_ID }],
        pagination: { total: 1, page: 1, limit: 10 },
      });

      const res = await service.listNotifications({
        page: 1,
        limit: 10,
        search: 'alert',
        channel: 'PUSH',
      });

      expect(res.items).toHaveLength(1);
      expect(mockNotificationRepo.listNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 1,
          limit: 10,
          search: 'alert',
          channel: 'PUSH',
        }),
      );
    });

    it('getNotificationById returns formatted notification and verifies no tokens exposed', async () => {
      const mockNotif = {
        id: TEST_NOTIFICATION_ID,
        title: 'Booking Confirmed',
        body: 'Details here',
        channel: 'PUSH',
        status: 'SENT',
        recipient: { id: TEST_CUSTOMER_ID, type: 'CUSTOMER' },
      };
      mockNotificationRepo.findNotificationById.mockResolvedValueOnce(mockNotif);

      const res = await service.getNotificationById(TEST_NOTIFICATION_ID);
      expect(res.id).toBe(TEST_NOTIFICATION_ID);
      expect(res.deviceToken).toBeUndefined();
      expect(res.fcmToken).toBeUndefined();
    });

    it('getNotificationById throws BadRequestError for malformed UUID (BOLA/IDOR protection)', async () => {
      await expect(service.getNotificationById('not-a-valid-uuid')).rejects.toThrow(
        BadRequestError,
      );
    });

    it('getNotificationById throws NotFoundError if not found', async () => {
      mockNotificationRepo.findNotificationById.mockResolvedValueOnce(null);

      await expect(service.getNotificationById(TEST_NOTIFICATION_ID)).rejects.toThrow(
        NotFoundError,
      );
    });

    it('getNotificationStatus returns delivery status projection', async () => {
      mockNotificationRepo.findNotificationById.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        status: 'DELIVERED',
        channel: 'PUSH',
        sentAt: '2026-09-01T10:00:00Z',
        deliveredAt: '2026-09-01T10:00:05Z',
        failedAt: null,
        failureReason: null,
        createdAt: '2026-09-01T09:59:50Z',
        updatedAt: '2026-09-01T10:00:05Z',
        recipient: { id: TEST_CUSTOMER_ID, type: 'CUSTOMER' },
      });

      const status = await service.getNotificationStatus(TEST_NOTIFICATION_ID);
      expect(status.status).toBe('DELIVERED');
      expect(status.channel).toBe('PUSH');
      expect(status.deliveredAt).toBe('2026-09-01T10:00:05Z');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. Templates Management
  // ══════════════════════════════════════════════════════════════════════════════
  describe('2. Template Management', () => {
    it('listTemplates delegates to repository with filters', async () => {
      mockNotificationRepo.listTemplates.mockResolvedValueOnce({
        items: [{ id: TEST_TEMPLATE_ID, templateKey: 'ride_alert' }],
        pagination: { total: 1, page: 1, limit: 20 },
      });

      const res = await service.listTemplates({ search: 'ride' });
      expect(res.items).toHaveLength(1);
      expect(mockNotificationRepo.listTemplates).toHaveBeenCalled();
    });

    it('getTemplateByIdOrKey finds by UUID or key', async () => {
      mockNotificationRepo.findTemplateById.mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        templateKey: 'ride_alert',
      });

      const res = await service.getTemplateByIdOrKey(TEST_TEMPLATE_ID);
      expect(res.id).toBe(TEST_TEMPLATE_ID);
      expect(mockNotificationRepo.findTemplateById).toHaveBeenCalledWith(TEST_TEMPLATE_ID);
    });

    it('getTemplateByIdOrKey finds by key if non-UUID', async () => {
      mockNotificationRepo.findTemplateByKey.mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        templateKey: 'ride_alert',
      });

      const res = await service.getTemplateByIdOrKey('ride_alert');
      expect(res.templateKey).toBe('ride_alert');
      expect(mockNotificationRepo.findTemplateByKey).toHaveBeenCalledWith('ride_alert');
    });

    it('createTemplate validates inputs and records audit log', async () => {
      const templateData = {
        templateKey: 'ride_pickup_reminder',
        title: 'Ride Reminder',
        body: 'Driver {{driverName}} is arriving.',
        notificationType: 'BOOKING_UPDATE',
        channel: 'PUSH',
        targetAudience: 'CUSTOMER',
        variables: ['driverName'],
      };

      mockNotificationRepo.createTemplate.mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        ...templateData,
        isActive: true,
      });

      const created = await service.createTemplate(templateData, TEST_ADMIN_USER, {
        ipAddress: '127.0.0.1',
      });

      expect(created.id).toBe(TEST_TEMPLATE_ID);
      expect(mockNotificationRepo.createTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          templateKey: 'ride_pickup_reminder',
          createdBy: TEST_ADMIN_USER.id,
        }),
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'NOTIFICATION_TEMPLATE_CREATED',
          targetResource: 'NOTIFICATION_TEMPLATE',
        }),
      );
    });

    it('createTemplate rejects invalid template keys', async () => {
      await expect(
        service.createTemplate(
          {
            templateKey: 'INVALID KEY WITH SPACES',
            title: 'Test',
            body: 'Body',
            notificationType: 'SYSTEM_ALERT',
          },
          TEST_ADMIN_USER,
        ),
      ).rejects.toThrow(BadRequestError);
    });

    it('createTemplate rejects unsupported channel', async () => {
      await expect(
        service.createTemplate(
          {
            templateKey: 'valid_key',
            title: 'Test',
            body: 'Body',
            notificationType: 'SYSTEM_ALERT',
            channel: 'CARRIER_PIGEON',
          },
          TEST_ADMIN_USER,
        ),
      ).rejects.toThrow(BadRequestError);
    });

    it('updateTemplate validates and persists updates', async () => {
      mockNotificationRepo.findTemplateById.mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        templateKey: 'ride_reminder',
        title: 'Old Title',
        body: 'Old Body',
        variables: [],
      });

      mockNotificationRepo.updateTemplate.mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        templateKey: 'ride_reminder',
        title: 'New Title',
        body: 'Old Body',
        variables: [],
      });

      const updated = await service.updateTemplate(
        TEST_TEMPLATE_ID,
        { title: 'New Title' },
        TEST_ADMIN_USER,
      );

      expect(updated.title).toBe('New Title');
      expect(mockNotificationRepo.updateTemplate).toHaveBeenCalledWith(
        TEST_TEMPLATE_ID,
        expect.objectContaining({
          title: 'New Title',
          updatedBy: TEST_ADMIN_USER.id,
        }),
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'NOTIFICATION_TEMPLATE_UPDATED',
        }),
      );
    });

    it('setTemplateActive is idempotent and updates state', async () => {
      // First test: already active -> no-op
      mockNotificationRepo.findTemplateById.mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        isActive: true,
      });

      const alreadyActive = await service.setTemplateActive(
        TEST_TEMPLATE_ID,
        true,
        TEST_ADMIN_USER,
      );
      expect(alreadyActive.isActive).toBe(true);
      expect(mockNotificationRepo.setTemplateActiveState).not.toHaveBeenCalled();

      // Second test: active -> deactivating
      mockNotificationRepo.findTemplateById.mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        isActive: true,
      });
      mockNotificationRepo.setTemplateActiveState.mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        isActive: false,
      });

      const deactivated = await service.setTemplateActive(
        TEST_TEMPLATE_ID,
        false,
        TEST_ADMIN_USER,
      );
      expect(deactivated.isActive).toBe(false);
      expect(mockNotificationRepo.setTemplateActiveState).toHaveBeenCalledWith(
        TEST_TEMPLATE_ID,
        false,
        TEST_ADMIN_USER.id,
      );
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'NOTIFICATION_TEMPLATE_DEACTIVATED',
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. Admin-Triggered Send & Target Validation
  // ══════════════════════════════════════════════════════════════════════════════
  describe('3. Admin-Triggered Send', () => {
    it('sends notification to valid customer with template variable substitution', async () => {
      // Recipient check
      mockNotificationRepo.getRecipientUser.mockResolvedValueOnce({
        id: TEST_CUSTOMER_ID,
        role: 'CUSTOMER',
        is_active: true,
        name: 'Aarav Patel',
        email: 'aarav@customer.in',
      });

      // Template lookup
      mockNotificationRepo.findTemplateByKey.mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        templateKey: 'welcome_notice',
        title: 'Welcome {{customerName}}',
        body: 'Your account is verified.',
        notificationType: 'SYSTEM_ALERT',
        channel: 'PUSH',
        isActive: true,
        targetAudience: 'CUSTOMER',
        variables: ['customerName'],
      });

      // Recipient tokens
      mockNotificationRepo.findRecipientDeviceTokens.mockResolvedValueOnce([
        'fcm_customer_token_1',
      ]);

      // Persistence
      mockNotificationRepo.createNotification.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Welcome Aarav Patel',
        body: 'Your account is verified.',
        channel: 'PUSH',
        status: 'PENDING',
      });

      mockNotificationRepo.findNotificationById.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Welcome Aarav Patel',
        body: 'Your account is verified.',
        channel: 'PUSH',
        status: 'SENT',
        recipient: { id: TEST_CUSTOMER_ID, type: 'CUSTOMER' },
      });

      const result = await service.sendNotification(
        {
          recipientType: 'CUSTOMER',
          recipientId: TEST_CUSTOMER_ID,
          templateKey: 'welcome_notice',
          variables: { customerName: 'Aarav Patel' },
        },
        TEST_ADMIN_USER,
      );

      expect(result.id).toBe(TEST_NOTIFICATION_ID);
      expect(mockPushProvider.sendMulticast).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: ['fcm_customer_token_1'],
          title: 'Welcome Aarav Patel',
        }),
      );
      expect(mockNotificationRepo.updateNotificationDelivery).toHaveBeenCalledWith(
        TEST_NOTIFICATION_ID,
        expect.objectContaining({
          status: 'SENT',
        }),
      );
    });

    it('sends notification to partner and writes to partner_notifications', async () => {
      mockNotificationRepo.getRecipientPartner.mockResolvedValueOnce({
        id: TEST_PARTNER_ID,
        is_active: true,
        business_name: 'Metro Fleet',
      });

      mockNotificationRepo.findRecipientDeviceTokens.mockResolvedValueOnce([
        'fcm_partner_token',
      ]);

      mockNotificationRepo.createNotification.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Fleet Inspection',
        body: 'Please complete your quarterly inspection.',
        channel: 'PUSH',
        status: 'PENDING',
      });

      mockNotificationRepo.findNotificationById.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Fleet Inspection',
        status: 'SENT',
        recipient: { id: TEST_PARTNER_ID, type: 'PARTNER' },
      });

      const result = await service.sendNotification(
        {
          recipientType: 'PARTNER',
          recipientId: TEST_PARTNER_ID,
          title: 'Fleet Inspection',
          body: 'Please complete your quarterly inspection.',
          channel: 'PUSH',
          notificationType: 'SYSTEM_ALERT',
        },
        TEST_ADMIN_USER,
      );

      expect(result.id).toBe(TEST_NOTIFICATION_ID);
      expect(mockNotificationRepo.createPartnerNotification).toHaveBeenCalled();
    });

    it('prevents BOLA/IDOR on booking mismatch', async () => {
      mockNotificationRepo.getRecipientUser.mockResolvedValueOnce({
        id: TEST_CUSTOMER_ID,
        role: 'CUSTOMER',
        is_active: true,
      });

      // Booking check returns null (booking does not belong to this customer)
      mockNotificationRepo.getBookingForRecipient.mockResolvedValueOnce(null);

      await expect(
        service.sendNotification(
          {
            recipientType: 'CUSTOMER',
            recipientId: TEST_CUSTOMER_ID,
            bookingId: TEST_BOOKING_ID,
            title: 'Trip Update',
            body: 'Trip started.',
            channel: 'PUSH',
          },
          TEST_ADMIN_USER,
        ),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects sending to inactive recipient', async () => {
      mockNotificationRepo.getRecipientUser.mockResolvedValueOnce({
        id: TEST_CUSTOMER_ID,
        role: 'CUSTOMER',
        is_active: false,
      });

      await expect(
        service.sendNotification(
          {
            recipientType: 'CUSTOMER',
            recipientId: TEST_CUSTOMER_ID,
            title: 'Trip Update',
            body: 'Trip started.',
          },
          TEST_ADMIN_USER,
        ),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects sending with inactive template', async () => {
      mockNotificationRepo.getRecipientUser.mockResolvedValueOnce({
        id: TEST_CUSTOMER_ID,
        role: 'CUSTOMER',
        is_active: true,
      });

      mockNotificationRepo.findTemplateByKey.mockResolvedValueOnce({
        id: TEST_TEMPLATE_ID,
        templateKey: 'inactive_promo',
        isActive: false,
      });

      await expect(
        service.sendNotification(
          {
            recipientType: 'CUSTOMER',
            recipientId: TEST_CUSTOMER_ID,
            templateKey: 'inactive_promo',
          },
          TEST_ADMIN_USER,
        ),
      ).rejects.toThrow(BadRequestError);
    });

    it('idempotency: returns existing notification if eventKey already processed', async () => {
      mockNotificationRepo.findByEventKey.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        status: 'SENT',
        title: 'Already Sent',
      });
      mockNotificationRepo.findNotificationById.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        status: 'SENT',
        title: 'Already Sent',
      });

      const res = await service.sendNotification(
        {
          recipientType: 'CUSTOMER',
          recipientId: TEST_CUSTOMER_ID,
          title: 'Already Sent',
          body: 'Duplicate prevent',
          idempotencyKey: 'idemp-req-12345',
        },
        TEST_ADMIN_USER,
      );

      expect(res.id).toBe(TEST_NOTIFICATION_ID);
      expect(mockPushProvider.sendMulticast).not.toHaveBeenCalled();
      expect(mockNotificationRepo.createNotification).not.toHaveBeenCalled();
    });

    it('handles FCM provider failure safely without crashing API', async () => {
      mockNotificationRepo.getRecipientUser.mockResolvedValueOnce({
        id: TEST_CUSTOMER_ID,
        role: 'CUSTOMER',
        is_active: true,
      });

      mockNotificationRepo.findRecipientDeviceTokens.mockResolvedValueOnce([
        'token_will_fail',
      ]);

      mockNotificationRepo.createNotification.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Fail Notice',
        body: 'Fail body',
        status: 'PENDING',
      });

      // Mock push provider rejecting
      mockPushProvider.sendMulticast.mockRejectedValueOnce(
        new Error('Firebase network timeout'),
      );

      mockNotificationRepo.findNotificationById.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Fail Notice',
        status: 'FAILED',
        failureReason: 'Firebase network timeout',
      });

      const result = await service.sendNotification(
        {
          recipientType: 'CUSTOMER',
          recipientId: TEST_CUSTOMER_ID,
          title: 'Fail Notice',
          body: 'Fail body',
          channel: 'PUSH',
        },
        TEST_ADMIN_USER,
      );

      expect(result.id).toBe(TEST_NOTIFICATION_ID);
      expect(mockNotificationRepo.updateNotificationDelivery).toHaveBeenCalledWith(
        TEST_NOTIFICATION_ID,
        expect.objectContaining({
          status: 'FAILED',
          failureReason: 'Firebase network timeout',
        }),
      );
    });

    it('deactivates invalid device tokens returned by FCM', async () => {
      mockNotificationRepo.getRecipientUser.mockResolvedValueOnce({
        id: TEST_CUSTOMER_ID,
        role: 'CUSTOMER',
        is_active: true,
      });

      mockNotificationRepo.findRecipientDeviceTokens.mockResolvedValueOnce([
        'bad_token_1',
      ]);

      mockPushProvider.sendMulticast.mockResolvedValueOnce({
        success: false,
        successCount: 0,
        failureCount: 1,
        invalidTokens: ['bad_token_1'],
        error: 'Invalid registration token',
      });

      mockNotificationRepo.createNotification.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        title: 'Test Bad Token',
        status: 'PENDING',
      });

      mockNotificationRepo.findNotificationById.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        status: 'FAILED',
      });

      await service.sendNotification(
        {
          recipientType: 'CUSTOMER',
          recipientId: TEST_CUSTOMER_ID,
          title: 'Test Bad Token',
          body: 'Testing bad token',
        },
        TEST_ADMIN_USER,
      );

      expect(mockNotificationRepo.deactivateDeviceTokens).toHaveBeenCalledWith(
        ['bad_token_1'],
        'CUSTOMER',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. Retry Delivery
  // ══════════════════════════════════════════════════════════════════════════════
  describe('4. Retry Delivery', () => {
    it('returns existing notification if already SENT or DELIVERED (idempotent)', async () => {
      mockNotificationRepo.findNotificationById.mockResolvedValueOnce({
        id: TEST_NOTIFICATION_ID,
        status: 'SENT',
        title: 'Done',
      });

      const res = await service.retryNotification(TEST_NOTIFICATION_ID, TEST_ADMIN_USER);
      expect(res.status).toBe('SENT');
      expect(mockPushProvider.sendMulticast).not.toHaveBeenCalled();
    });

    it('retries push delivery for FAILED notification', async () => {
      mockNotificationRepo.findNotificationById
        .mockResolvedValueOnce({
          id: TEST_NOTIFICATION_ID,
          status: 'FAILED',
          channel: 'PUSH',
          title: 'Retry Me',
          body: 'Body',
          recipient: { id: TEST_CUSTOMER_ID },
          recipientType: 'CUSTOMER',
        })
        .mockResolvedValueOnce({
          id: TEST_NOTIFICATION_ID,
          status: 'SENT',
        });

      mockNotificationRepo.findRecipientDeviceTokens.mockResolvedValueOnce([
        'fcm_token_retry',
      ]);

      const res = await service.retryNotification(TEST_NOTIFICATION_ID, TEST_ADMIN_USER);
      expect(res.status).toBe('SENT');
      expect(mockPushProvider.sendMulticast).toHaveBeenCalled();
      expect(mockNotificationRepo.updateNotificationDelivery).toHaveBeenCalledWith(
        TEST_NOTIFICATION_ID,
        expect.objectContaining({ status: 'SENT' }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. Variable Substitution
  // ══════════════════════════════════════════════════════════════════════════════
  describe('5. Variable Substitution', () => {
    it('substitutes {{variable}} and {variable} correctly', () => {
      const template = 'Hello {{name}}, booking {bookingNumber} is confirmed.';
      const res = service.substituteVariables(template, {
        name: 'Aarav',
        bookingNumber: 'BK-1001',
      });
      expect(res).toBe('Hello Aarav, booking BK-1001 is confirmed.');
    });

    it('blocks prototype pollution keys in templates', () => {
      const template = 'Status: {{__proto__}} and {{constructor}}';
      const res = service.substituteVariables(template, {
        __proto__: 'hacked',
        constructor: 'polluted',
      });
      expect(res).toBe('Status:  and ');
    });

    it('leaves allowed variables unreplaced if not provided in values', () => {
      const template = 'Hi {{name}}, your pin is {{pin}}';
      const res = service.substituteVariables(
        template,
        { name: 'Aarav' },
        ['name', 'pin'],
      );
      expect(res).toBe('Hi Aarav, your pin is {{pin}}');
    });
  });
});
