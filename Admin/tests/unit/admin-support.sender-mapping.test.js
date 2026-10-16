'use strict';

const adminSupportService = require('../../src/services/admin-support.service');
const AdminSupportRepository = require('../../src/repositories/admin-support.repository');

describe('Admin Support — Sender Type Identification and Subject/Description Mapping', () => {
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

  describe('1. Earliest Message Sender Type Identification', () => {
    it('1. A ticket whose original message has sender_type = PARTNER resolves to Partner', async () => {
      const mockRow = {
        id: '11111111-1111-4111-a111-111111111111',
        ticket_number: 'TKT-20261001-001',
        subject: 'Vehicle Maintenance Inquiry',
        description: 'Brake pads replacement needed before next trip.',
        category: 'VEHICLE',
        status: 'OPEN',
        priority: 'MEDIUM',
        partner_id: 'p1111111-1111-4111-a111-111111111111',
        partner_business_name: 'Metro Fleet Rentals',
        partner_owner_name: 'Vikram Joshi',
        original_sender_type: 'PARTNER',
        original_sender_id: 'u1111111-1111-4111-a111-111111111111',
        original_message_at: new Date('2026-10-01T09:00:00Z'),
      };

      const mapped = adminSupportService._mapTicketDetail(mockRow);
      expect(mapped.senderType).toBe('PARTNER');
      expect(mapped.raisedBy).toBe('PARTNER');
      expect(mapped.submitterName).toBe('Metro Fleet Rentals');
    });

    it('2. A ticket whose original message has sender_type = CUSTOMER resolves to Customer', async () => {
      const mockRow = {
        id: '22222222-2222-4222-a222-222222222222',
        ticket_number: 'TKT-20261001-002',
        subject: 'Refund request for cancelled trip',
        description: 'Trip was cancelled due to heavy rain. Please process refund.',
        category: 'PAYMENT',
        status: 'OPEN',
        priority: 'HIGH',
        customer_id: 'c1111111-1111-4111-a111-111111111111',
        customer_name: 'Sneha Rao',
        customer_phone: '+919988776655',
        original_sender_type: 'CUSTOMER',
        original_sender_id: 'c1111111-1111-4111-a111-111111111111',
        original_message_at: new Date('2026-10-01T10:00:00Z'),
      };

      const mapped = adminSupportService._mapTicketDetail(mockRow);
      expect(mapped.senderType).toBe('CUSTOMER');
      expect(mapped.raisedBy).toBe('CUSTOMER');
      expect(mapped.submitterName).toBe('Sneha Rao');
    });

    it('3. Later Admin replies do NOT change the ticket raisers badge', async () => {
      // Earliest message is CUSTOMER, even if last reply was ADMIN
      const mockRow = {
        id: '33333333-3333-4333-a333-333333333333',
        ticket_number: 'TKT-20261001-003',
        subject: 'Helmet not provided with bike',
        description: 'Partner did not provide helmet at pickup.',
        category: 'BOOKING',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
        customer_id: 'c1111111-1111-4111-a111-111111111111',
        customer_name: 'Amit Patel',
        // Earliest message is CUSTOMER
        original_sender_type: 'CUSTOMER',
        original_sender_id: 'c1111111-1111-4111-a111-111111111111',
        original_message_at: new Date('2026-10-01T08:00:00Z'),
        // Message stats indicates multiple messages
        message_count: 4,
        last_message_at: new Date('2026-10-01T12:00:00Z'),
      };

      const mapped = adminSupportService._mapTicketSummary(mockRow);
      expect(mapped.senderType).toBe('CUSTOMER');
      expect(mapped.raisedBy).toBe('CUSTOMER');
      expect(mapped.submitterName).toBe('Amit Patel');
    });

    it('4. Later customer/partner replies do NOT change the original raiser badge', async () => {
      // Ticket originally created by PARTNER
      const mockRow = {
        id: '44444444-4444-4444-a444-444444444444',
        ticket_number: 'TKT-20261001-004',
        subject: 'Customer damaged bike side mirror',
        description: 'Mirror was cracked during rental return.',
        category: 'VEHICLE',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        partner_id: 'p1111111-1111-4111-a111-111111111111',
        partner_business_name: 'Apex Wheels',
        original_sender_type: 'PARTNER',
        original_sender_id: 'u1111111-1111-4111-a111-111111111111',
        original_message_at: new Date('2026-10-01T07:00:00Z'),
        message_count: 5,
        last_message_at: new Date('2026-10-01T14:00:00Z'),
      };

      const mapped = adminSupportService._mapTicketSummary(mockRow);
      expect(mapped.senderType).toBe('PARTNER');
      expect(mapped.raisedBy).toBe('PARTNER');
      expect(mapped.submitterName).toBe('Apex Wheels');
    });

    it('maps missing or unrecognized sender_type to UNKNOWN or falls back to authoritative relationship', () => {
      const rowNoMsgWithCustomer = {
        id: '55555555-5555-4555-a555-555555555555',
        ticket_number: 'TKT-20261001-005',
        customer_id: 'c1111111-1111-4111-a111-111111111111',
        customer_name: 'Karan Mehra',
        original_sender_type: null,
      };
      const resCustomer = adminSupportService._resolveTicketRaiserType(rowNoMsgWithCustomer);
      expect(resCustomer).toBe('CUSTOMER');

      const rowNoMsgWithPartner = {
        id: '66666666-6666-4666-a666-666666666666',
        ticket_number: 'TKT-20261001-006',
        partner_id: 'p1111111-1111-4111-a111-111111111111',
        partner_business_name: 'Rapid Rides',
        original_sender_type: null,
      };
      const resPartner = adminSupportService._resolveTicketRaiserType(rowNoMsgWithPartner);
      expect(resPartner).toBe('PARTNER');

      const rowUnknown = {
        id: '77777777-7777-4777-a777-777777777777',
        ticket_number: 'TKT-20261001-007',
        original_sender_type: null,
      };
      const resUnknown = adminSupportService._resolveTicketRaiserType(rowUnknown);
      expect(resUnknown).toBe('UNKNOWN');
    });
  });

  describe('2. Subject and Description Correct Mapping', () => {
    it('5. The original description is separate from conversation messages and mapped from support_tickets.description', () => {
      const ticketRow = {
        id: '88888888-8888-4888-a888-888888888888',
        ticket_number: 'TKT-20261001-008',
        subject: 'Billing discrepancy for GST',
        description: 'The GST calculation on invoice INV-902 appears higher than 18%.',
        category: 'PAYMENT',
        status: 'OPEN',
        priority: 'MEDIUM',
      };

      const mappedDetail = adminSupportService._mapTicketDetail(ticketRow);
      expect(mappedDetail.subject).toBe('Billing discrepancy for GST');
      expect(mappedDetail.description).toBe('The GST calculation on invoice INV-902 appears higher than 18%.');

      // Ensure subject is NOT swapped with description
      expect(mappedDetail.subject).not.toBe(mappedDetail.description);
    });

    it('6. SQL query selects both t.subject and t.description distinctly', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: 1 }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: '88888888-8888-4888-a888-888888888888',
              ticket_number: 'TKT-20261001-008',
              subject: 'Incorrect pricing on weekend',
              description: 'Weekend rates were billed on Monday.',
              status: 'OPEN',
              priority: 'LOW',
              category: 'OTHER',
            },
          ],
        });

      await repository.listTickets({ limit: 10, offset: 0 });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      const dataSql = mockQuery.mock.calls[1][0];
      expect(dataSql).toContain('t.subject,');
      expect(dataSql).toContain('t.description,');
      expect(dataSql).toContain('orig_msg.sender_type AS original_sender_type');
      expect(dataSql).toContain('ORDER BY ticket_id, created_at ASC, id ASC');
    });
  });

  describe('3. Conversation Messages & Replies', () => {
    it('7. replyTicket accepts message or text and creates a SUPPORT message without modifying ticket description', async () => {
      const mockTicket = {
        id: '99999999-9999-4999-a999-999999999999',
        status: 'OPEN',
        subject: 'Original Subject',
        description: 'Original Description Remains Untouched',
      };

      jest.spyOn(adminSupportService.supportRepo, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportService.supportRepo, 'getTicketForUpdate').mockResolvedValue(mockTicket);
      jest.spyOn(adminSupportService.supportRepo, 'createMessage').mockResolvedValue({
        id: 'm-reply-101',
        ticket_id: mockTicket.id,
        sender_type: 'SUPPORT',
        sender_id: 'a0000001-0000-4000-a000-000000000001',
        message: 'We have received your issue and are reviewing the telemetry.',
        created_at: new Date(),
      });
      jest.spyOn(adminSupportService.supportRepo, 'updateTicket').mockResolvedValue({});

      const replyResult = await adminSupportService.replyTicket(
        mockTicket.id,
        { text: 'We have received your issue and are reviewing the telemetry.' },
        { id: 'a0000001-0000-4000-a000-000000000001', name: 'Desk Admin', role: 'ADMIN' },
      );

      expect(replyResult.message.message).toBe('We have received your issue and are reviewing the telemetry.');
      expect(replyResult.message.senderType).toBe('SUPPORT');
      expect(replyResult.ticketStatus).toBe('WAITING_FOR_CUSTOMER');

      // The original description of the ticket was not overwritten
      expect(mockTicket.description).toBe('Original Description Remains Untouched');
    });
  });
});
