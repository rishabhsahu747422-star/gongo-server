'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const supportTicketService = require('../../src/services/support-ticket.service');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Integration: Partner Support Ticket API', () => {
  let app;
  let mockAuth;
  const partnerId = '11111111-2222-4333-8444-555555555555';
  const userId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const ticketId = '99999999-8888-4777-8666-555555555555';

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'valid-partner-token') {
          return { uid: 'uid-partner-1', phone_number: '+919999999999', email: 'partner@gongo.in' };
        }
        if (token === 'other-partner-token') {
          return { uid: 'uid-partner-2', phone_number: '+919999999998', email: 'other@gongo.in' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === 'uid-partner-1' || idOrAuth === partnerId) {
        return {
          id: partnerId,
          partnerId,
          userId,
          auth_id: 'uid-partner-1',
          role: 'PARTNER',
          name: 'Harsh Gupta',
          phone: '9999999999',
          email: 'partner@gongo.in',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
          business_name: 'Nasir Rentals',
        };
      }
      if (idOrAuth === 'uid-partner-2') {
        return {
          id: '22222222-2222-4222-8222-222222222222',
          partnerId: '22222222-2222-4222-8222-222222222222',
          userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          auth_id: 'uid-partner-2',
          role: 'PARTNER',
          name: 'Partner B',
          phone: '9999999998',
          email: 'other@gongo.in',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      return null;
    });
  });

  afterEach(() => {
    PartnerRepository.setMockPartnerResolver(null);
    jest.restoreAllMocks();
  });

  describe('POST /api/v1/partner/support/tickets', () => {
    it('creates a support ticket with valid authenticated session (201 Created)', async () => {
      jest.spyOn(supportTicketService.supportTicketRepository, 'createTicketWithInitialMessage')
        .mockResolvedValueOnce({
          id: ticketId,
          partner_id: partnerId,
          user_id: userId,
          ticket_number: 'TKT-202610-TEST01',
          category: 'BOOKING',
          subject: 'Late return handover issue',
          description: 'Customer arrived 40 mins late without informing.',
          status: 'OPEN',
          priority: 'HIGH',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          messages: [
            {
              id: 'msg-1',
              ticket_id: ticketId,
              sender_type: 'PARTNER',
              sender_id: userId,
              message: 'Customer arrived 40 mins late without informing.',
              attachments: [],
              created_at: new Date().toISOString(),
            },
          ],
        });

      const res = await request(app)
        .post('/api/v1/partner/support/tickets')
        .set('Authorization', 'Bearer valid-partner-token')
        .send({
          subject: 'Late return handover issue',
          category: 'BOOKING',
          message: 'Customer arrived 40 mins late without informing.',
          priority: 'HIGH',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(ticketId);
      expect(res.body.data.ticketNumber).toBe('TKT-202610-TEST01');
      expect(res.body.data.status).toBe('OPEN');
      expect(res.body.data.category).toBe('BOOKING');
      expect(res.body.data.priority).toBe('HIGH');
      expect(res.body.data.description).toBe('Customer arrived 40 mins late without informing.');
    });

    it('rejects unauthenticated requests (401 Unauthorized)', async () => {
      const res = await request(app)
        .post('/api/v1/partner/support/tickets')
        .send({
          subject: 'Unauthorized ticket',
          message: 'Should fail immediately',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects invalid payload with short subject or missing message (400 Bad Request)', async () => {
      const res = await request(app)
        .post('/api/v1/partner/support/tickets')
        .set('Authorization', 'Bearer valid-partner-token')
        .send({
          subject: 'Hi',
          message: '',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });

    it('rejects mass-assignment attempts to inject partnerId or status (400 Bad Request)', async () => {
      const res = await request(app)
        .post('/api/v1/partner/support/tickets')
        .set('Authorization', 'Bearer valid-partner-token')
        .send({
          subject: 'Valid subject line',
          message: 'Valid message body text',
          partnerId: 'hacked-partner-id',
          status: 'RESOLVED',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    });
  });

  describe('GET /api/v1/partner/support/tickets', () => {
    it('returns paginated tickets list for authenticated partner (200 OK)', async () => {
      jest.spyOn(supportTicketService.supportTicketRepository, 'findTicketsByPartnerId')
        .mockResolvedValueOnce({
          rows: [
            {
              id: ticketId,
              partner_id: partnerId,
              ticket_number: 'TKT-202610-TEST01',
              category: 'BOOKING',
              subject: 'Late return handover issue',
              description: 'Customer arrived late',
              status: 'OPEN',
              priority: 'HIGH',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              message_count: 1,
            },
          ],
          total: 1,
        });

      const res = await request(app)
        .get('/api/v1/partner/support/tickets')
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.pagination.totalItems).toBe(1);
    });
  });

  describe('GET /api/v1/partner/support/tickets/:id', () => {
    it('returns ticket thread with messages for owner (200 OK)', async () => {
      jest.spyOn(supportTicketService.supportTicketRepository, 'findTicketByIdAndPartnerId')
        .mockResolvedValueOnce({
          id: ticketId,
          partner_id: partnerId,
          ticket_number: 'TKT-202610-TEST01',
          category: 'BOOKING',
          subject: 'Late return handover issue',
          description: 'Customer arrived late',
          status: 'OPEN',
          priority: 'HIGH',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          messages: [
            {
              id: 'msg-1',
              ticket_id: ticketId,
              sender_type: 'PARTNER',
              sender_id: userId,
              message: 'Initial message',
              attachments: [],
              created_at: new Date().toISOString(),
            },
          ],
        });

      const res = await request(app)
        .get(`/api/v1/partner/support/tickets/${ticketId}`)
        .set('Authorization', 'Bearer valid-partner-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(ticketId);
      expect(res.body.data.messages).toHaveLength(1);
    });

    it('returns 404 when ticket belongs to another partner (BOLA enforcement)', async () => {
      jest.spyOn(supportTicketService.supportTicketRepository, 'findTicketByIdAndPartnerId')
        .mockResolvedValueOnce(null);

      const res = await request(app)
        .get(`/api/v1/partner/support/tickets/${ticketId}`)
        .set('Authorization', 'Bearer other-partner-token');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /api/v1/partner/support/tickets/:id/messages', () => {
    it('appends a partner message to existing ticket (201 Created)', async () => {
      jest.spyOn(supportTicketService.supportTicketRepository, 'findTicketByIdAndPartnerId')
        .mockResolvedValueOnce({
          id: ticketId,
          partner_id: partnerId,
          user_id: userId,
          status: 'OPEN',
        });

      jest.spyOn(supportTicketService.supportTicketRepository, 'addMessage')
        .mockResolvedValueOnce({
          id: 'msg-2',
          ticket_id: ticketId,
          sender_type: 'PARTNER',
          sender_id: userId,
          message: 'Follow-up message with additional context',
          attachments: [],
          created_at: new Date().toISOString(),
        });

      const res = await request(app)
        .post(`/api/v1/partner/support/tickets/${ticketId}/messages`)
        .set('Authorization', 'Bearer valid-partner-token')
        .send({
          message: 'Follow-up message with additional context',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('msg-2');
      expect(res.body.data.senderType).toBe('PARTNER');
      expect(res.body.data.message).toBe('Follow-up message with additional context');
    });

    it('rejects empty reply message (400 Bad Request)', async () => {
      const res = await request(app)
        .post(`/api/v1/partner/support/tickets/${ticketId}/messages`)
        .set('Authorization', 'Bearer valid-partner-token')
        .send({
          message: '   ',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
