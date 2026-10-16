'use strict';

const AdminSupportRepository = require('../../src/repositories/admin-support.repository');

const TEST_TICKET_ID = 't0000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'c0000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'p0000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'b0000001-0000-4000-a000-000000000001';
const TEST_ADMIN_ID = 'adm00001-0000-4000-a000-000000000001';

describe('Unit: Admin Support Repository', () => {
  let repository;
  let mockQuery;

  beforeEach(() => {
    repository = new AdminSupportRepository();
    mockQuery = jest.fn();
    AdminSupportRepository.setMockSupportResolver((text, params) => mockQuery(text, params));
  });

  afterEach(() => {
    AdminSupportRepository.resetMockSupportResolver();
    jest.restoreAllMocks();
  });

  describe('1. listTickets', () => {
    it('executes parameterized count and data queries with filters, search, and pagination', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: 1 }] }) // Count query
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_TICKET_ID,
              ticket_number: 'TKT-20260901-ABC123',
              customer_id: TEST_CUSTOMER_ID,
              partner_id: TEST_PARTNER_ID,
              booking_id: TEST_BOOKING_ID,
              category: 'BOOKING',
              subject: 'Issue with booking extension',
              status: 'OPEN',
              priority: 'HIGH',
              assigned_to: TEST_ADMIN_ID,
              assigned_at: new Date('2026-09-01T10:00:00Z'),
              created_at: new Date('2026-09-01T09:00:00Z'),
              updated_at: new Date('2026-09-01T10:00:00Z'),
              customer_name: 'John Customer',
              customer_phone: '+919999999991',
              customer_email: 'john@customer.com',
              partner_business_name: 'Fast Wheels Partner',
              partner_owner_name: 'Partner Owner',
              partner_phone: '+919888888881',
              booking_number: 'BK-1001',
              booking_status: 'ACTIVE',
              assigned_admin_name: 'Admin User',
              assigned_admin_email: 'admin@gongo.in',
              message_count: 3,
              last_message_at: new Date('2026-09-01T10:30:00Z'),
            },
          ],
        }); // Data query

      const result = await repository.listTickets({
        search: 'booking',
        status: 'OPEN',
        priority: 'HIGH',
        category: 'BOOKING',
        assignedTo: TEST_ADMIN_ID,
        customerId: TEST_CUSTOMER_ID,
        partnerId: TEST_PARTNER_ID,
        bookingId: TEST_BOOKING_ID,
        startDate: new Date('2026-09-01'),
        endDate: new Date('2026-09-02'),
        limit: 10,
        offset: 0,
        sortBy: 'priority',
        sortOrder: 'DESC',
      });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(1);
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].id).toBe(TEST_TICKET_ID);
      expect(result.tickets[0].ticket_number).toBe('TKT-20260901-ABC123');
    });

    it('defaults sort to created_at DESC if unknown sort column is passed', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.listTickets({
        sortBy: 'malicious_column_injection; DROP TABLE users;',
        sortOrder: 'ASC',
      });

      const dataQueryCall = mockQuery.mock.calls[1];
      expect(dataQueryCall[0]).toContain('ORDER BY t.created_at ASC');
    });
  });

  describe('2. getTicketById', () => {
    it('executes parameterized join query and returns complete ticket details', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_TICKET_ID,
            ticket_number: 'TKT-20260901-ABC123',
            customer_id: TEST_CUSTOMER_ID,
            partner_id: TEST_PARTNER_ID,
            booking_id: TEST_BOOKING_ID,
            category: 'PAYMENT',
            subject: 'Double charge inquiry',
            status: 'IN_PROGRESS',
            priority: 'URGENT',
            assigned_to: TEST_ADMIN_ID,
            customer_name: 'John Customer',
            customer_is_active: true,
            partner_business_name: 'Fast Wheels Partner',
            partner_city: 'Bangalore',
            booking_number: 'BK-1001',
            booking_status: 'ACTIVE',
            booking_total_amount: '5000.00',
            vehicle_id: 'v0000001-0000-4000-a000-000000000001',
            vehicle_make: 'Hyundai',
            vehicle_model: 'Creta',
            vehicle_registration_number: 'KA-01-AB-1234',
            vehicle_category: 'SUV',
            assigned_admin_name: 'Admin User',
            message_count: 5,
          },
        ],
      });

      const ticket = await repository.getTicketById(TEST_TICKET_ID);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][1]).toEqual([TEST_TICKET_ID]);
      expect(ticket).toBeDefined();
      expect(ticket.id).toBe(TEST_TICKET_ID);
      expect(ticket.vehicle_model).toBe('Creta');
    });

    it('returns null when ticket does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const ticket = await repository.getTicketById(TEST_TICKET_ID);
      expect(ticket).toBeNull();
    });
  });

  describe('3. getTicketForUpdate', () => {
    it('executes SELECT FOR UPDATE on client for transaction row locking', async () => {
      const mockClient = { query: jest.fn().mockResolvedValueOnce({ rows: [{ id: TEST_TICKET_ID, status: 'OPEN' }] }) };

      // Testing direct client query behavior
      AdminSupportRepository.resetMockSupportResolver();
      const ticket = await repository.getTicketForUpdate(mockClient, TEST_TICKET_ID);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE'),
        [TEST_TICKET_ID],
      );
      expect(ticket.status).toBe('OPEN');
    });
  });

  describe('4. getTicketMessages & createMessage', () => {
    it('getTicketMessages retrieves chronological messages with sender details', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'm1',
            ticket_id: TEST_TICKET_ID,
            sender_type: 'CUSTOMER',
            sender_id: TEST_CUSTOMER_ID,
            message: 'Hello I need help',
            attachments: null,
            created_at: new Date('2026-09-01T10:00:00Z'),
            sender_name: 'John Customer',
            sender_role: 'CUSTOMER',
          },
        ],
      });

      const messages = await repository.getTicketMessages(TEST_TICKET_ID);
      expect(messages).toHaveLength(1);
      expect(messages[0].sender_type).toBe('CUSTOMER');
    });

    it('createMessage inserts message record and returns created row', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'm2',
            ticket_id: TEST_TICKET_ID,
            sender_type: 'SUPPORT',
            sender_id: TEST_ADMIN_ID,
            message: 'We are looking into this',
            attachments: ['support/att1.jpg'],
            created_at: new Date('2026-09-01T10:05:00Z'),
          },
        ],
      });

      const msg = await repository.createMessage(null, {
        ticketId: TEST_TICKET_ID,
        senderType: 'SUPPORT',
        senderId: TEST_ADMIN_ID,
        message: 'We are looking into this',
        attachments: ['support/att1.jpg'],
      });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(msg.sender_type).toBe('SUPPORT');
      expect(msg.message).toBe('We are looking into this');
    });
  });

  describe('5. getTicketCustomer, getTicketPartner, getTicketBooking', () => {
    it('getTicketCustomer returns safe customer ownership view', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_CUSTOMER_ID,
            name: 'John Customer',
            phone: '+919999999991',
            email: 'john@customer.com',
            role: 'CUSTOMER',
            is_active: true,
            total_bookings: 4,
            total_tickets: 2,
          },
        ],
      });

      const customer = await repository.getTicketCustomer(TEST_TICKET_ID);
      expect(customer).toBeDefined();
      expect(customer.name).toBe('John Customer');
      expect(customer.total_bookings).toBe(4);
    });

    it('getTicketPartner returns partner business context', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_PARTNER_ID,
            business_name: 'Fast Wheels Partner',
            city: 'Bangalore',
            partner_status: 'ONLINE',
            kyc_status: 'VERIFIED',
            owner_name: 'Partner Owner',
            active_vehicles: 5,
          },
        ],
      });

      const partner = await repository.getTicketPartner(TEST_TICKET_ID);
      expect(partner).toBeDefined();
      expect(partner.business_name).toBe('Fast Wheels Partner');
      expect(partner.active_vehicles).toBe(5);
    });

    it('getTicketBooking returns linked booking details', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_BOOKING_ID,
            booking_number: 'BK-1001',
            booking_status: 'ACTIVE',
            payment_status: 'PAID',
            total_amount: '3500.00',
            vehicle_make: 'Maruti',
            vehicle_model: 'Swift',
          },
        ],
      });

      const booking = await repository.getTicketBooking(TEST_TICKET_ID);
      expect(booking).toBeDefined();
      expect(booking.booking_number).toBe('BK-1001');
      expect(booking.vehicle_model).toBe('Swift');
    });
  });

  describe('6. getActiveAdminUser & getTicketAuditLogs', () => {
    it('getActiveAdminUser queries users table for admin verification', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_ADMIN_ID,
            name: 'Admin User',
            email: 'admin@gongo.in',
            role: 'ADMIN',
            is_active: true,
          },
        ],
      });

      const admin = await repository.getActiveAdminUser(TEST_ADMIN_ID);
      expect(admin).toBeDefined();
      expect(admin.role).toBe('ADMIN');
      expect(admin.is_active).toBe(true);
    });

    it('getTicketAuditLogs returns audit records for SUPPORT_TICKET target', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'act1',
            actor_id: TEST_ADMIN_ID,
            action: 'SUPPORT_TICKET_RESOLVED',
            target_resource: 'SUPPORT_TICKET',
            target_resource_id: TEST_TICKET_ID,
            created_at: new Date('2026-09-01T12:00:00Z'),
          },
        ],
      });

      const logs = await repository.getTicketAuditLogs(TEST_TICKET_ID);
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('SUPPORT_TICKET_RESOLVED');
    });
  });
});
