'use strict';

const { AdminNotificationRepository } = require('../../src/repositories/admin-notification.repository');

const TEST_NOTIFICATION_ID = 'n0000001-0000-4000-a000-000000000001';
const TEST_TEMPLATE_ID = 't0000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'c0000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'p0000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'b0000001-0000-4000-a000-000000000001';
const TEST_ADMIN_ID = 'adm00001-0000-4000-a000-000000000001';

describe('Unit: AdminNotificationRepository', () => {
  let repository;
  let mockQuery;

  beforeEach(() => {
    repository = new AdminNotificationRepository();
    mockQuery = jest.fn();
    repository.query = mockQuery;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Notification Queries & Listings', () => {
    it('listNotifications executes count and items queries with filters', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '1' }] }) // count query
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_NOTIFICATION_ID,
              customer_id: TEST_CUSTOMER_ID,
              partner_id: null,
              recipient_type: 'CUSTOMER',
              title: 'Ride Confirmed',
              body: 'Your ride is confirmed.',
              channel: 'PUSH',
              type: 'BOOKING_UPDATE',
              status: 'SENT',
              sent_by: TEST_ADMIN_ID,
              template_id: TEST_TEMPLATE_ID,
              booking_id: TEST_BOOKING_ID,
              data: { bookingId: TEST_BOOKING_ID },
              metadata: {},
              failure_reason: null,
              sent_at: new Date('2026-09-01T10:00:00Z'),
              delivered_at: new Date('2026-09-01T10:00:05Z'),
              failed_at: null,
              created_at: new Date('2026-09-01T09:59:50Z'),
              updated_at: new Date('2026-09-01T10:00:05Z'),
              customer_name: 'John Customer',
              customer_email: 'john@example.com',
              customer_phone: '+919999999991',
              partner_business_name: null,
              partner_phone: null,
              admin_name: 'Super Admin',
              admin_email: 'admin@gongo.in',
              template_key: 'RIDE_CONFIRMED',
            },
          ],
        }); // items query

      const result = await repository.listNotifications({
        search: 'Confirmed',
        recipientId: TEST_CUSTOMER_ID,
        recipientType: 'CUSTOMER',
        channel: 'PUSH',
        type: 'BOOKING_UPDATE',
        status: 'SENT',
        templateId: TEST_TEMPLATE_ID,
        bookingId: TEST_BOOKING_ID,
        startDate: '2026-09-01T00:00:00Z',
        endDate: '2026-09-02T00:00:00Z',
        page: 1,
        limit: 10,
        sortBy: 'created_at',
        sortOrder: 'DESC',
      });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(10);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(TEST_NOTIFICATION_ID);
      expect(result.items[0].recipient.type).toBe('CUSTOMER');
      expect(result.items[0].recipient.id).toBe(TEST_CUSTOMER_ID);
      expect(result.items[0].recipient.name).toBe('John Customer');
    });

    it('listNotifications handles partner notifications', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_NOTIFICATION_ID,
              customer_id: null,
              partner_id: TEST_PARTNER_ID,
              recipient_type: 'PARTNER',
              title: 'Payout Processed',
              body: 'Payout done.',
              channel: 'PUSH',
              type: 'PAYMENT_RECEIVED',
              status: 'SENT',
              sent_by: TEST_ADMIN_ID,
              template_id: null,
              booking_id: null,
              data: {},
              metadata: {},
              failure_reason: null,
              sent_at: new Date('2026-09-01T10:00:00Z'),
              delivered_at: null,
              failed_at: null,
              created_at: new Date('2026-09-01T09:59:50Z'),
              updated_at: new Date('2026-09-01T10:00:00Z'),
              customer_name: null,
              customer_email: null,
              customer_phone: null,
              partner_name: 'Fast Auto',
              partner_phone: '+918888888882',
              admin_name: 'Super Admin',
              admin_email: 'admin@gongo.in',
              template_key: null,
            },
          ],
        });

      const result = await repository.listNotifications({
        recipientType: 'PARTNER',
        sortBy: 'invalid_col',
      });

      expect(result.items[0].recipient.type).toBe('PARTNER');
      expect(result.items[0].recipient.id).toBe(TEST_PARTNER_ID);
      expect(result.items[0].recipient.name).toBe('Fast Auto');
    });

    it('findNotificationById returns formatted notification', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_NOTIFICATION_ID,
            customer_id: TEST_CUSTOMER_ID,
            partner_id: null,
            recipient_type: 'CUSTOMER',
            title: 'Welcome',
            body: 'Welcome to Gongo',
            channel: 'PUSH',
            type: 'SYSTEM_ALERT',
            status: 'SENT',
            sent_by: TEST_ADMIN_ID,
            template_id: null,
            booking_id: null,
            data: {},
            metadata: {},
            failure_reason: null,
            sent_at: new Date(),
            delivered_at: null,
            failed_at: null,
            created_at: new Date(),
            updated_at: new Date(),
            customer_name: 'John Customer',
            customer_email: 'john@example.com',
            customer_phone: '+919999999991',
            partner_business_name: null,
            partner_phone: null,
            admin_name: 'Super Admin',
            admin_email: 'admin@gongo.in',
            template_key: null,
          },
        ],
      });

      const notification = await repository.findNotificationById(TEST_NOTIFICATION_ID);
      expect(notification).not.toBeNull();
      expect(notification.id).toBe(TEST_NOTIFICATION_ID);
      expect(notification.title).toBe('Welcome');
      expect(notification.recipient.id).toBe(TEST_CUSTOMER_ID);
    });

    it('findNotificationById returns null if not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const notification = await repository.findNotificationById(TEST_NOTIFICATION_ID);
      expect(notification).toBeNull();
    });

    it('findByEventKey returns existing notification by eventKey', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_NOTIFICATION_ID,
            title: 'Welcome',
            status: 'SENT',
          },
        ],
      });

      const notification = await repository.findByEventKey('evt-12345');
      expect(notification).not.toBeNull();
      expect(notification.id).toBe(TEST_NOTIFICATION_ID);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE event_key = $1'),
        ['evt-12345'],
      );
    });
  });

  describe('2. Notification Creation & Status Updates', () => {
    it('createNotification inserts row and returns it', async () => {
      const mockRow = {
        id: TEST_NOTIFICATION_ID,
        title: 'Alert',
        status: 'PENDING',
      };
      mockQuery.mockResolvedValueOnce({ rows: [mockRow] });

      const row = await repository.createNotification({
        customerId: TEST_CUSTOMER_ID,
        recipientType: 'CUSTOMER',
        title: 'Alert',
        body: 'Alert body',
        channel: 'PUSH',
        type: 'SYSTEM_ALERT',
        status: 'PENDING',
        sentBy: TEST_ADMIN_ID,
      });

      expect(row.id).toBe(TEST_NOTIFICATION_ID);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO notifications'),
        expect.any(Array),
      );
    });

    it('createPartnerNotification inserts into partner_notifications', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'pn-1', partner_id: TEST_PARTNER_ID }],
      });

      const row = await repository.createPartnerNotification({
        partnerId: TEST_PARTNER_ID,
        title: 'Partner Notice',
        message: 'Partner message',
        type: 'SYSTEM_ALERT',
        data: { test: true },
      });

      expect(row.id).toBe('pn-1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO partner_notifications'),
        expect.any(Array),
      );
    });

    it('updateNotificationDelivery updates status, timestamps, and failure reason', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_NOTIFICATION_ID,
            status: 'FAILED',
            failure_reason: 'FCM timeout',
          },
        ],
      });

      const updated = await repository.updateNotificationDelivery(TEST_NOTIFICATION_ID, {
        status: 'FAILED',
        failureReason: 'FCM timeout',
        failedAt: new Date(),
      });

      expect(updated.status).toBe('FAILED');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE notifications'),
        expect.any(Array),
      );
    });
  });

  describe('3. Recipient & Booking Validations', () => {
    it('getRecipientUser returns customer record', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_CUSTOMER_ID,
            role: 'CUSTOMER',
            is_active: true,
            name: 'John Customer',
          },
        ],
      });

      const customer = await repository.getRecipientUser(TEST_CUSTOMER_ID);
      expect(customer).not.toBeNull();
      expect(customer.name).toBe('John Customer');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1'),
        [TEST_CUSTOMER_ID],
      );
    });

    it('getRecipientPartner returns partner profile', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_PARTNER_ID,
            is_active: true,
            status: 'VERIFIED',
            business_name: 'Fast Auto',
          },
        ],
      });

      const partner = await repository.getRecipientPartner(TEST_PARTNER_ID);
      expect(partner).not.toBeNull();
      expect(partner.business_name).toBe('Fast Auto');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1'),
        [TEST_PARTNER_ID],
      );
    });

    it('getBookingForRecipient validates customer booking relationship', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: TEST_BOOKING_ID, customer_id: TEST_CUSTOMER_ID, booking_number: 'BK-1001' }],
      });

      const booking = await repository.getBookingForRecipient(
        TEST_BOOKING_ID,
        TEST_CUSTOMER_ID,
        'CUSTOMER',
      );
      expect(booking).not.toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1 AND customer_id = $2'),
        [TEST_BOOKING_ID, TEST_CUSTOMER_ID],
      );
    });

    it('getBookingForRecipient validates partner booking relationship', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: TEST_BOOKING_ID, partner_id: TEST_PARTNER_ID, booking_number: 'BK-1001' }],
      });

      const booking = await repository.getBookingForRecipient(
        TEST_BOOKING_ID,
        TEST_PARTNER_ID,
        'PARTNER',
      );
      expect(booking).not.toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1 AND partner_id = $2'),
        [TEST_BOOKING_ID, TEST_PARTNER_ID],
      );
    });
  });

  describe('4. Device Tokens', () => {
    it('findRecipientDeviceTokens returns customer device tokens', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { device_token: 'fcm_token_1' },
          { device_token: 'fcm_token_2' },
        ],
      });

      const tokens = await repository.findRecipientDeviceTokens(TEST_CUSTOMER_ID, 'CUSTOMER');
      expect(tokens).toEqual(['fcm_token_1', 'fcm_token_2']);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM customer_device_tokens'),
        [TEST_CUSTOMER_ID],
      );
    });

    it('findRecipientDeviceTokens returns partner device tokens', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ device_token: 'fcm_partner_token' }],
      });

      const tokens = await repository.findRecipientDeviceTokens(TEST_PARTNER_ID, 'PARTNER');
      expect(tokens).toEqual(['fcm_partner_token']);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM partner_device_tokens'),
        [TEST_PARTNER_ID],
      );
    });

    it('deactivateDeviceTokens deactivates customer device tokens', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await repository.deactivateDeviceTokens(['fcm_token_1'], 'CUSTOMER');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE\s+customer_device_tokens\s+SET\s+is_active\s*=\s*false/),
        [['fcm_token_1']],
      );
    });

    it('deactivateDeviceTokens deactivates partner device tokens', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await repository.deactivateDeviceTokens(['fcm_partner_token'], 'PARTNER');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE\s+partner_device_tokens\s+SET\s+is_active\s*=\s*false/),
        [['fcm_partner_token']],
      );
    });
  });

  describe('5. Template Operations', () => {
    it('listTemplates executes count and items queries with filters', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_TEMPLATE_ID,
              template_key: 'RIDE_CONFIRMED',
              title: 'Ride Confirmed',
              body: 'Your ride with {{partnerName}} is confirmed.',
              notification_type: 'BOOKING_UPDATE',
              channel: 'PUSH',
              target_audience: 'CUSTOMER',
              variables: ['partnerName'],
              is_active: true,
              created_by: TEST_ADMIN_ID,
              updated_by: TEST_ADMIN_ID,
              created_at: new Date(),
              updated_at: new Date(),
              creator_name: 'Super Admin',
              updater_name: 'Super Admin',
            },
          ],
        });

      const result = await repository.listTemplates({
        search: 'Ride',
        notificationType: 'BOOKING_UPDATE',
        channel: 'PUSH',
        targetAudience: 'CUSTOMER',
        isActive: true,
        page: 1,
        limit: 10,
      });

      expect(result.pagination.total).toBe(1);
      expect(result.items[0].templateKey).toBe('RIDE_CONFIRMED');
      expect(result.items[0].variables).toEqual(['partnerName']);
    });

    it('findTemplateById returns formatted template', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_TEMPLATE_ID,
            template_key: 'RIDE_CONFIRMED',
            title: 'Ride Confirmed',
            body: 'Body',
            notification_type: 'BOOKING_UPDATE',
            channel: 'PUSH',
            target_audience: 'CUSTOMER',
            variables: [],
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const template = await repository.findTemplateById(TEST_TEMPLATE_ID);
      expect(template.id).toBe(TEST_TEMPLATE_ID);
      expect(template.templateKey).toBe('RIDE_CONFIRMED');
    });

    it('findTemplateByKey returns template by key', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_TEMPLATE_ID,
            template_key: 'RIDE_CONFIRMED',
            title: 'Ride Confirmed',
            body: 'Body',
            notification_type: 'BOOKING_UPDATE',
            channel: 'PUSH',
            target_audience: 'CUSTOMER',
            variables: [],
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const template = await repository.findTemplateByKey('RIDE_CONFIRMED');
      expect(template.templateKey).toBe('RIDE_CONFIRMED');
    });

    it('createTemplate inserts row and throws on duplicate key', async () => {
      mockQuery.mockRejectedValueOnce({ code: '23505' });

      await expect(
        repository.createTemplate({
          templateKey: 'EXISTING_KEY',
          title: 'Title',
          body: 'Body',
          notificationType: 'SYSTEM_ALERT',
          channel: 'PUSH',
          targetAudience: 'CUSTOMER',
          variables: [],
          isActive: true,
          createdBy: TEST_ADMIN_ID,
        }),
      ).rejects.toThrow('already exists');
    });

    it('updateTemplate updates fields dynamically', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_TEMPLATE_ID,
            template_key: 'RIDE_CONFIRMED',
            title: 'Updated Title',
            body: 'Updated Body',
            notification_type: 'BOOKING_UPDATE',
            channel: 'PUSH',
            target_audience: 'CUSTOMER',
            variables: [],
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const updated = await repository.updateTemplate(TEST_TEMPLATE_ID, {
        title: 'Updated Title',
        body: 'Updated Body',
        updatedBy: TEST_ADMIN_ID,
      });

      expect(updated.title).toBe('Updated Title');
    });

    it('setTemplateActiveState activates or deactivates template', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_TEMPLATE_ID,
            template_key: 'RIDE_CONFIRMED',
            title: 'Title',
            body: 'Body',
            notification_type: 'BOOKING_UPDATE',
            channel: 'PUSH',
            target_audience: 'CUSTOMER',
            variables: [],
            is_active: false,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const deactivated = await repository.setTemplateActiveState(
        TEST_TEMPLATE_ID,
        false,
        TEST_ADMIN_ID,
      );
      expect(deactivated.isActive).toBe(false);
    });
  });

  describe('6. Outbox Operations', () => {
    it('createOutboxEvent inserts row into outbox_events', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'outbox-1', event_name: 'NOTIFICATION_SENT' }],
      });

      const event = await repository.createOutboxEvent({
        eventName: 'NOTIFICATION_SENT',
        aggregateType: 'NOTIFICATION',
        aggregateId: TEST_NOTIFICATION_ID,
        payload: { test: true },
      });

      expect(event.id).toBe('outbox-1');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO outbox_events'),
        expect.any(Array),
      );
    });

    it('updateOutboxEventStatus updates status of outbox event', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await repository.updateOutboxEventStatus(TEST_NOTIFICATION_ID, 'PROCESSED');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE outbox_events'),
        [TEST_NOTIFICATION_ID, 'PROCESSED', null],
      );
    });
  });
});
