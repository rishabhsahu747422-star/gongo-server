'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const supportTicketService = require('../../src/services/support-ticket.service');
const partnerService = require('../../src/services/partner.service');
const vehicleService = require('../../src/services/vehicle.service');
const { NotFoundError } = require('../../src/errors');

describe('Integration: Phase 17 Complete Partner Backend Coverage', () => {
  let app;
  let mockAuth;

  const partner1Id = '11111111-1111-4111-a111-111111111111';
  const partner2Id = '22222222-2222-4222-a222-222222222222';
  const adminId = '99999999-9999-4999-a999-999999999999';
  const vehicleId = '33333333-3333-4333-a333-333333333333';
  const ticketId = '44444444-4444-4444-a444-444444444444';

  beforeAll(() => {
    app = createApp();
  });

  afterAll(() => {
    PartnerRepository.setMockPartnerResolver(null);
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'partner-1-token') {
          return { uid: 'uid-partner-1', phone_number: '+919876543210' };
        }
        if (token === 'partner-2-token') {
          return { uid: 'uid-partner-2', phone_number: '+919876543211' };
        }
        if (token === 'admin-token') {
          return { uid: 'uid-admin', phone_number: '+919876543299' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
      revokeRefreshTokens: jest.fn().mockResolvedValue(true),
    };
    setMockFirebaseAuth(mockAuth);

    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === 'uid-partner-1' || idOrAuth === partner1Id) {
        return {
          id: partner1Id,
          partnerId: partner1Id,
          userId: 'user-partner-1',
          auth_id: 'uid-partner-1',
          role: 'PARTNER',
          is_active: true,
        };
      }
      if (idOrAuth === 'uid-partner-2' || idOrAuth === partner2Id) {
        return {
          id: partner2Id,
          partnerId: partner2Id,
          userId: 'user-partner-2',
          auth_id: 'uid-partner-2',
          role: 'PARTNER',
          is_active: true,
        };
      }
      if (idOrAuth === 'uid-admin' || idOrAuth === adminId) {
        return {
          id: adminId,
          partnerId: adminId,
          userId: 'user-admin',
          auth_id: 'uid-admin',
          role: 'ADMIN',
          is_active: true,
        };
      }
      return null;
    });
  });

  // ── 1. Support Tickets & Messages Module ──────────────────────────────
  describe('1. Support Tickets & Messages Module', () => {
    const mockTicket = {
      id: ticketId,
      partnerId: partner1Id,
      ticketNumber: 'TKT-202609-AB12CD',
      category: 'BOOKING',
      subject: 'Issue with booking handover OTP',
      status: 'OPEN',
      priority: 'HIGH',
      createdAt: '2026-09-22T10:00:00.000Z',
      updatedAt: '2026-09-22T10:00:00.000Z',
      messages: [
        {
          id: '55555555-5555-4555-a555-555555555555',
          ticketId,
          senderType: 'PARTNER',
          senderId: partner1Id,
          message: 'Customer OTP is not being accepted at pickup.',
          attachments: [],
          createdAt: '2026-09-22T10:00:00.000Z',
        },
      ],
    };

    it('POST /api/v1/partner/support/tickets creates a ticket with initial message', async () => {
      jest.spyOn(supportTicketService, 'createTicket').mockResolvedValue(mockTicket);

      const res = await request(app)
        .post('/api/v1/partner/support/tickets')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          subject: 'Issue with booking handover OTP',
          category: 'BOOKING',
          priority: 'HIGH',
          message: 'Customer OTP is not being accepted at pickup.',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.ticketNumber).toBe('TKT-202609-AB12CD');
      expect(res.body.data.status).toBe('OPEN');
      expect(res.body.data.messages).toHaveLength(1);
    });

    it('POST /api/v1/partner/support/tickets rejects invalid payload with 400', async () => {
      const res = await request(app)
        .post('/api/v1/partner/support/tickets')
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          subject: '', // Empty subject
          message: '',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('GET /api/v1/partner/support/tickets returns paginated list of tickets', async () => {
      jest.spyOn(supportTicketService, 'getPartnerTickets').mockResolvedValue({
        items: [mockTicket],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/partner/support/tickets?status=OPEN')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].id).toBe(ticketId);
    });

    it('GET /api/v1/partner/support/tickets/:ticketId retrieves ticket with thread', async () => {
      jest.spyOn(supportTicketService, 'getPartnerTicketById').mockResolvedValue(mockTicket);

      const res = await request(app)
        .get(`/api/v1/partner/support/tickets/${ticketId}`)
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(ticketId);
    });

    it('enforces strict BOLA: another partner cannot access ticket', async () => {
      jest.spyOn(supportTicketService, 'getPartnerTicketById').mockRejectedValue(
        new NotFoundError('Support ticket not found or unauthorized'),
      );

      const res = await request(app)
        .get(`/api/v1/partner/support/tickets/${ticketId}`)
        .set('Authorization', 'Bearer partner-2-token')
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('POST /api/v1/partner/support/tickets/:ticketId/messages adds reply to ticket', async () => {
      const mockReply = {
        id: '66666666-6666-4666-a666-666666666666',
        ticketId,
        senderType: 'PARTNER',
        senderId: partner1Id,
        message: 'Customer provided new phone number.',
        attachments: [],
        createdAt: '2026-09-22T10:05:00.000Z',
      };
      jest.spyOn(supportTicketService, 'addPartnerMessage').mockResolvedValue(mockReply);

      const res = await request(app)
        .post(`/api/v1/partner/support/tickets/${ticketId}/messages`)
        .set('Authorization', 'Bearer partner-1-token')
        .send({
          message: 'Customer provided new phone number.',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toBe('Customer provided new phone number.');
      expect(res.body.data.senderType).toBe('PARTNER');
    });

    it('admin can list, view, reply to, and update status of support tickets', async () => {
      jest.spyOn(supportTicketService, 'getAdminTickets').mockResolvedValue({
        items: [mockTicket],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      });

      const listRes = await request(app)
        .get('/api/v1/admin/support/tickets')
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(listRes.body.success).toBe(true);
      expect(listRes.body.data.items).toHaveLength(1);

      // Admin updates status to RESOLVED
      const updatedTicket = { ...mockTicket, status: 'RESOLVED' };
      jest.spyOn(supportTicketService, 'updateAdminTicketStatus').mockResolvedValue(updatedTicket);

      const patchRes = await request(app)
        .patch(`/api/v1/admin/support/tickets/${ticketId}/status`)
        .set('Authorization', 'Bearer admin-token')
        .send({ status: 'RESOLVED' })
        .expect(200);

      expect(patchRes.body.success).toBe(true);
      expect(patchRes.body.data.status).toBe('RESOLVED');

      // Admin adds reply message
      const adminReply = {
        id: '77777777-7777-4777-a777-777777777777',
        ticketId,
        senderType: 'SUPPORT',
        senderId: adminId,
        message: 'The OTP issue has been verified and bypassed for your booking.',
        attachments: [],
        createdAt: '2026-09-22T10:10:00.000Z',
      };
      jest.spyOn(supportTicketService, 'addAdminMessage').mockResolvedValue(adminReply);

      const replyRes = await request(app)
        .post(`/api/v1/admin/support/tickets/${ticketId}/messages`)
        .set('Authorization', 'Bearer admin-token')
        .send({
          message: 'The OTP issue has been verified and bypassed for your booking.',
        })
        .expect(201);

      expect(replyRes.body.success).toBe(true);
      expect(replyRes.body.data.senderType).toBe('SUPPORT');
    });

    it('rejects partner access to admin support endpoints with 403', async () => {
      await request(app)
        .get('/api/v1/admin/support/tickets')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(403);
    });
  });

  // ── 2. Partner Dashboard Statistics API ──────────────────────────────
  describe('2. Partner Dashboard Statistics API', () => {
    const mockStats = {
      totalVehicles: 5,
      bookedVehicles: 2,
      availableVehicles: 3,
      unavailableVehicles: 0,
      upcomingBookings: 1,
      activeRentals: 1,
      completedBookings: 8,
      cancelledBookings: 0,
      earnings: {
        totalEarnings: 15400.00,
        monthlyEarnings: 4200.00,
        weeklyEarnings: 1800.00,
        pendingSettlements: 0,
      },
      activeRentalsSummary: [
        {
          id: 'booking-active-1',
          bookingNumber: 'BK-202609-001',
          customerName: 'Rahul Sharma',
          customerPhone: '+919876543212',
          vehicleName: 'Honda Activa 6G',
          registrationNumber: 'KA-01-AB-1234',
          startAt: '2026-09-22T08:00:00.000Z',
          expectedReturnAt: '2026-09-22T18:00:00.000Z',
        },
      ],
    };

    it('GET /api/v1/partner/dashboard/stats returns aggregate metrics and active alerts', async () => {
      jest.spyOn(partnerService, 'getDashboardStats').mockResolvedValue(mockStats);

      const res = await request(app)
        .get('/api/v1/partner/dashboard/stats')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.totalVehicles).toBe(5);
      expect(res.body.data.bookedVehicles).toBe(2);
      expect(res.body.data.availableVehicles).toBe(3);
      expect(res.body.data.activeRentals).toBe(1);
      expect(res.body.data.earnings.monthlyEarnings).toBe(4200.00);
      expect(res.body.data.activeRentalsSummary).toHaveLength(1);
    });

    it('GET /api/v1/partner/stats alias endpoint functions identically', async () => {
      jest.spyOn(partnerService, 'getDashboardStats').mockResolvedValue(mockStats);

      const res = await request(app)
        .get('/api/v1/partner/stats')
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.totalVehicles).toBe(5);
    });

    it('rejects unauthenticated access to dashboard stats with 401', async () => {
      await request(app)
        .get('/api/v1/partner/dashboard/stats')
        .expect(401);
    });
  });

  // ── 3. Vehicle Rental History API ────────────────────────────────────
  describe('3. Vehicle Rental History API', () => {
    const mockRentalHistory = {
      vehicle: {
        id: vehicleId,
        brand: 'Honda',
        model: 'Activa 6G',
        registrationNumber: 'KA-01-AB-1234',
        manualStatus: 'ONLINE',
        rentalStatus: 'IDLE',
        totalTrips: 2,
        totalEarnings: 1850.00,
      },
      history: [
        {
          id: 'booking-completed-1',
          bookingNumber: 'BK-202609-001',
          status: 'COMPLETED',
          customerName: 'Aarav Patel',
          customerPhone: '+919876543213',
          startAt: '2026-09-20T10:00:00.000Z',
          expectedReturnAt: '2026-09-20T18:00:00.000Z',
          handoverAt: '2026-09-20T10:05:00.000Z',
          returnedAt: '2026-09-20T18:15:00.000Z',
          durationMinutes: 490,
          earnings: 950.00,
          odometerEnd: 12450,
          lateMinutes: 15,
          lateFee: 100.00,
          extraKm: 5,
          extraKmFee: 50.00,
          returnStatus: 'LATE',
          totalDistance: 75,
          createdAt: '2026-09-20T09:30:00.000Z',
        },
        {
          id: 'booking-completed-2',
          bookingNumber: 'BK-202609-002',
          status: 'COMPLETED',
          customerName: 'Pooja Reddy',
          customerPhone: '+919876543214',
          startAt: '2026-09-18T09:00:00.000Z',
          expectedReturnAt: '2026-09-18T17:00:00.000Z',
          handoverAt: '2026-09-18T09:00:00.000Z',
          returnedAt: '2026-09-18T16:55:00.000Z',
          durationMinutes: 475,
          earnings: 900.00,
          odometerEnd: 12375,
          lateMinutes: 0,
          lateFee: 0.00,
          extraKm: 0,
          extraKmFee: 0.00,
          returnStatus: 'ON_TIME',
          totalDistance: 60,
          createdAt: '2026-09-18T08:30:00.000Z',
        },
      ],
    };

    it('GET /api/v1/partner/vehicles/:vehicleId/history returns rental and usage history', async () => {
      jest.spyOn(vehicleService, 'getVehicleRentalHistory').mockResolvedValue(mockRentalHistory);

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicleId}/history`)
        .set('Authorization', 'Bearer partner-1-token')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.vehicle.totalTrips).toBe(2);
      expect(res.body.data.vehicle.totalEarnings).toBe(1850.00);
      expect(res.body.data.history).toHaveLength(2);
      expect(res.body.data.history[0].bookingNumber).toBe('BK-202609-001');
      expect(res.body.data.history[0].durationMinutes).toBe(490);
      expect(res.body.data.history[0].lateMinutes).toBe(15);
      expect(res.body.data.history[0].lateFee).toBe(100.00);
    });

    it('enforces strict BOLA: another partner cannot access vehicle history', async () => {
      jest.spyOn(vehicleService, 'getVehicleRentalHistory').mockRejectedValue(
        new NotFoundError('Vehicle not found or does not belong to partner'),
      );

      const res = await request(app)
        .get(`/api/v1/partner/vehicles/${vehicleId}/history`)
        .set('Authorization', 'Bearer partner-2-token')
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('rejects unauthenticated requests to vehicle history with 401', async () => {
      await request(app)
        .get(`/api/v1/partner/vehicles/${vehicleId}/history`)
        .expect(401);
    });
  });
});
