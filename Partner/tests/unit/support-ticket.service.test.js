'use strict';

const SupportTicketService = require('../../src/services/support-ticket.service');
const { NotFoundError, ForbiddenError, BadRequestError } = require('../../src/errors');

describe('Unit: SupportTicketService', () => {
  let mockTicketRepo;
  let mockPartnerRepo;
  let service;

  const partnerId = '11111111-1111-4111-a111-111111111111';
  const ticketId = '22222222-2222-4222-a222-222222222222';

  beforeEach(() => {
    mockTicketRepo = {
      createTicketWithInitialMessage: jest.fn(),
      findTicketsByPartnerId: jest.fn(),
      findTicketByIdAndPartnerId: jest.fn(),
      addMessage: jest.fn(),
      updateTicketStatus: jest.fn(),
      findAllTicketsAdmin: jest.fn(),
      findTicketByIdAdmin: jest.fn(),
      findById: jest.fn(),
    };

    mockPartnerRepo = {
      findById: jest.fn(),
    };

    // Instantiate with injected repos
    service = new SupportTicketService.constructor(mockTicketRepo, mockPartnerRepo);
  });

  describe('createTicket', () => {
    it('creates ticket and returns formatted representation', async () => {
      mockPartnerRepo.findById.mockResolvedValue({ id: partnerId, is_active: true });
      mockTicketRepo.createTicketWithInitialMessage.mockResolvedValue({
        id: ticketId,
        partner_id: partnerId,
        ticket_number: 'TKT-202609-XYZ123',
        category: 'PAYOUT',
        subject: 'Payout pending for 3 days',
        status: 'OPEN',
        priority: 'HIGH',
        created_at: '2026-09-22T00:00:00.000Z',
        updated_at: '2026-09-22T00:00:00.000Z',
        messages: [
          {
            id: 'msg-1',
            ticket_id: ticketId,
            sender_type: 'PARTNER',
            sender_id: partnerId,
            message: 'Where is my payout?',
            attachments: [],
            created_at: '2026-09-22T00:00:00.000Z',
          },
        ],
      });

      const res = await service.createTicket(partnerId, {
        category: 'PAYOUT',
        subject: 'Payout pending for 3 days',
        priority: 'HIGH',
        message: 'Where is my payout?',
      });

      expect(res.id).toBe(ticketId);
      expect(res.ticketNumber).toBe('TKT-202609-XYZ123');
      expect(res.messages).toHaveLength(1);
    });

    it('throws ForbiddenError if partner account is deactivated', async () => {
      mockPartnerRepo.findById.mockResolvedValue({ id: partnerId, is_active: false });

      await expect(service.createTicket(partnerId, { subject: 'Help', message: 'Hello' }))
        .rejects.toThrow(ForbiddenError);
    });

    it('throws NotFoundError if partner account does not exist', async () => {
      mockPartnerRepo.findById.mockResolvedValue(null);

      await expect(service.createTicket(partnerId, { subject: 'Help', message: 'Hello' }))
        .rejects.toThrow(NotFoundError);
    });
  });

  describe('addPartnerMessage', () => {
    it('reopens resolved ticket to IN_PROGRESS when partner replies', async () => {
      mockTicketRepo.findTicketByIdAndPartnerId.mockResolvedValue({
        id: ticketId,
        partner_id: partnerId,
        status: 'RESOLVED',
      });
      mockTicketRepo.addMessage.mockResolvedValue({
        id: 'msg-2',
        ticket_id: ticketId,
        sender_type: 'PARTNER',
        sender_id: partnerId,
        message: 'Still having this issue.',
        attachments: [],
        created_at: '2026-09-22T01:00:00.000Z',
      });

      const res = await service.addPartnerMessage(partnerId, ticketId, {
        message: 'Still having this issue.',
      });

      expect(res.message).toBe('Still having this issue.');
      expect(mockTicketRepo.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          reopenStatus: 'IN_PROGRESS',
        }),
      );
    });

    it('throws BadRequestError when partner tries to reply to a closed ticket', async () => {
      mockTicketRepo.findTicketByIdAndPartnerId.mockResolvedValue({
        id: ticketId,
        partner_id: partnerId,
        status: 'CLOSED',
      });

      await expect(service.addPartnerMessage(partnerId, ticketId, { message: 'Still having this issue.' }))
        .rejects.toThrow(BadRequestError);
    });

    it('throws NotFoundError if ticket does not belong to partner', async () => {
      mockTicketRepo.findTicketByIdAndPartnerId.mockResolvedValue(null);

      await expect(service.addPartnerMessage(partnerId, ticketId, { message: 'Hello' }))
        .rejects.toThrow(NotFoundError);
    });
  });
});
