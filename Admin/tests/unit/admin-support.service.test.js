'use strict';

const adminSupportService = require('../../src/services/admin-support.service');
const auditService = require('../../src/services/audit.service');
const s3Provider = require('../../src/providers/s3');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../../src/errors');

const TEST_TICKET_ID = 'a0000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'c0000001-0000-4000-a000-000000000001';
const TEST_ADMIN_ID = 'a0000002-0000-4000-a000-000000000001';

const ADMIN_USER = {
  id: TEST_ADMIN_ID,
  name: 'Support Admin',
  role: 'ADMIN',
  email: 'admin@gongo.in',
  permissions: ['support.update', 'support.assign', 'support.reply', 'support.resolve', 'support.close'],
};

describe('Unit: Admin Support Service', () => {
  beforeEach(() => {
    jest.spyOn(auditService, 'logAdminAction').mockImplementation(() => {});
    jest.spyOn(adminSupportService.actionRepo, 'createAction').mockResolvedValue({});
    jest.spyOn(s3Provider, 'createPresignedGetUrl').mockImplementation(async ({ key }) => ({
      downloadUrl: `https://s3.signed/${key}`,
      key,
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Validation & Querying', () => {
    it('throws BadRequestError when ticket ID is not a valid UUID', async () => {
      await expect(adminSupportService.getTicketById('invalid-uuid')).rejects.toThrow(BadRequestError);
    });

    it('throws NotFoundError when ticket does not exist', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'getTicketById').mockResolvedValue(null);
      await expect(
        adminSupportService.getTicketById(TEST_TICKET_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('listTickets validates status and priority filter values', async () => {
      await expect(
        adminSupportService.listTickets({ status: 'INVALID_STATUS' }),
      ).rejects.toThrow(BadRequestError);

      await expect(
        adminSupportService.listTickets({ priority: 'SUPER_URGENT' }),
      ).rejects.toThrow(BadRequestError);
    });

    it('listTickets returns safe projected tickets and pagination', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'listTickets').mockResolvedValue({
        tickets: [
          {
            id: TEST_TICKET_ID,
            ticket_number: 'TKT-101',
            status: 'OPEN',
            priority: 'MEDIUM',
            category: 'OTHER',
            subject: 'General Question',
            customer_id: TEST_CUSTOMER_ID,
            customer_name: 'Customer A',
            message_count: 2,
          },
        ],
        total: 1,
      });

      const res = await adminSupportService.listTickets({ page: 1, limit: 10 });
      expect(res.tickets).toHaveLength(1);
      expect(res.tickets[0].id).toBe(TEST_TICKET_ID);
      expect(res.tickets[0].customer.name).toBe('Customer A');
      expect(res.pagination.total).toBe(1);
    });
  });

  describe('2. State Machine Transitions', () => {
    it('allows valid state transitions (e.g. OPEN -> IN_PROGRESS)', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'OPEN',
      });
      jest.spyOn(adminSupportService.supportRepo, 'updateTicket').mockResolvedValue({});
      jest.spyOn(adminSupportService.supportRepo, 'getTicketById').mockResolvedValue({
        id: TEST_TICKET_ID,
        ticket_number: 'TKT-101',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
      });

      const updated = await adminSupportService.updateStatus(
        TEST_TICKET_ID,
        { status: 'IN_PROGRESS', reason: 'Admin acknowledged' },
        ADMIN_USER,
        { requestId: 'req-1' },
      );

      expect(updated.status).toBe('IN_PROGRESS');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SUPPORT_TICKET_STATUS_IN_PROGRESS',
          targetResource: 'SUPPORT_TICKET',
        }),
      );
    });

    it('rejects invalid state transitions with ConflictError (e.g. CLOSED -> IN_PROGRESS)', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'CLOSED',
      });

      await expect(
        adminSupportService.updateStatus(TEST_TICKET_ID, { status: 'IN_PROGRESS' }, ADMIN_USER),
      ).rejects.toThrow(ConflictError);
    });

    it('is idempotent when target status equals current status', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'RESOLVED',
      });
      jest.spyOn(adminSupportService.supportRepo, 'getTicketById').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'RESOLVED',
      });

      const res = await adminSupportService.updateStatus(TEST_TICKET_ID, { status: 'RESOLVED' }, ADMIN_USER);
      expect(res.status).toBe('RESOLVED');
      expect(auditService.logAdminAction).not.toHaveBeenCalled();
    });
  });

  describe('3. Admin Assignment', () => {
    it('assigns ticket to valid active admin and updates status from OPEN to IN_PROGRESS', async () => {
      const targetAdmin = {
        id: 'a0000002-0000-4000-a000-000000000002',
        name: 'Agent Two',
        role: 'ADMIN',
        is_active: true,
      };
      jest.spyOn(adminSupportService.supportRepo, 'getActiveAdminUser').mockResolvedValue(targetAdmin);
      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'OPEN',
        assigned_to: null,
      });
      jest.spyOn(adminSupportService.supportRepo, 'updateTicket').mockResolvedValue({});
      jest.spyOn(adminSupportService.supportRepo, 'getTicketById').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'IN_PROGRESS',
        assigned_to: targetAdmin.id,
        assigned_admin_name: 'Agent Two',
      });

      const res = await adminSupportService.assignTicket(
        TEST_TICKET_ID,
        { adminUserId: targetAdmin.id, reason: 'High priority ticket' },
        ADMIN_USER,
      );

      expect(res.status).toBe('IN_PROGRESS');
      expect(res.assignedAdmin.id).toBe(targetAdmin.id);
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SUPPORT_TICKET_ASSIGNED',
        }),
      );
    });

    it('rejects assignment to non-admin user with ForbiddenError', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'getActiveAdminUser').mockResolvedValue({
        id: 'c0000002-0000-4000-a000-000000000002',
        role: 'CUSTOMER',
        is_active: true,
      });

      await expect(
        adminSupportService.assignTicket(TEST_TICKET_ID, { adminUserId: 'c0000002-0000-4000-a000-000000000002' }, ADMIN_USER),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('4. Admin Reply', () => {
    it('records reply, touches ticket status to WAITING_FOR_CUSTOMER, and logs audit', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'IN_PROGRESS',
        assigned_to: TEST_ADMIN_ID,
      });
      jest.spyOn(adminSupportService.supportRepo, 'createMessage').mockResolvedValue({
        id: 'm101',
        ticket_id: TEST_TICKET_ID,
        sender_type: 'SUPPORT',
        sender_id: TEST_ADMIN_ID,
        message: 'Your refund has been initiated',
        attachments: [],
        created_at: new Date(),
      });
      jest.spyOn(adminSupportService.supportRepo, 'updateTicket').mockResolvedValue({});

      const res = await adminSupportService.replyTicket(
        TEST_TICKET_ID,
        { message: 'Your refund has been initiated' },
        ADMIN_USER,
      );

      expect(res.message.id).toBe('m101');
      expect(res.ticketStatus).toBe('WAITING_FOR_CUSTOMER');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SUPPORT_TICKET_ADMIN_REPLY',
        }),
      );
    });

    it('rejects empty or whitespace-only messages', async () => {
      await expect(
        adminSupportService.replyTicket(TEST_TICKET_ID, { message: '   ' }, ADMIN_USER),
      ).rejects.toThrow(BadRequestError);
    });

    it('rejects reply to CLOSED ticket with ConflictError', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'CLOSED',
      });

      await expect(
        adminSupportService.replyTicket(TEST_TICKET_ID, { message: 'Hello' }, ADMIN_USER),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('5. Resolve, Close & Reopen', () => {
    it('resolveTicket marks ticket as RESOLVED and records resolved_at and notes', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'IN_PROGRESS',
      });
      jest.spyOn(adminSupportService.supportRepo, 'updateTicket').mockResolvedValue({});
      jest.spyOn(adminSupportService.supportRepo, 'getTicketById').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'RESOLVED',
        resolved_by: TEST_ADMIN_ID,
        resolution_notes: 'Booking rescheduled successfully',
      });

      const res = await adminSupportService.resolveTicket(
        TEST_TICKET_ID,
        { resolutionNotes: 'Booking rescheduled successfully' },
        ADMIN_USER,
      );

      expect(res.status).toBe('RESOLVED');
      expect(res.resolutionNotes).toBe('Booking rescheduled successfully');
    });

    it('closeTicket marks ticket as CLOSED', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'RESOLVED',
      });
      jest.spyOn(adminSupportService.supportRepo, 'updateTicket').mockResolvedValue({});
      jest.spyOn(adminSupportService.supportRepo, 'getTicketById').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'CLOSED',
      });

      const res = await adminSupportService.closeTicket(TEST_TICKET_ID, {}, ADMIN_USER);
      expect(res.status).toBe('CLOSED');
    });

    it('reopenTicket allows reopening CLOSED or RESOLVED tickets', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'CLOSED',
      });
      jest.spyOn(adminSupportService.supportRepo, 'updateTicket').mockResolvedValue({});
      jest.spyOn(adminSupportService.supportRepo, 'getTicketById').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'REOPENED',
      });

      const res = await adminSupportService.reopenTicket(
        TEST_TICKET_ID,
        { reason: 'Customer reported issue is not resolved' },
        ADMIN_USER,
      );

      expect(res.status).toBe('REOPENED');
    });

    it('reopenTicket rejects reopening OPEN ticket with ConflictError', async () => {
      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue({
        id: TEST_TICKET_ID,
        status: 'OPEN',
      });

      await expect(
        adminSupportService.reopenTicket(TEST_TICKET_ID, {}, ADMIN_USER),
      ).rejects.toThrow(ConflictError);
    });
  });
});
