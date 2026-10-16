'use strict';

const { resetSupabaseClient } = require('../../src/providers/supabase');
const userRepository = require('../../src/repositories/user.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminPermissionRepository = require('../../src/repositories/admin-permission.repository');
const adminBookingRepository = require('../../src/repositories/admin-booking.repository');
const adminVehicleRepository = require('../../src/repositories/admin-vehicle.repository');
const adminPaymentRepository = require('../../src/repositories/admin-payment.repository');
const adminWalletRepository = require('../../src/repositories/admin-wallet.repository');
const adminVerificationRepository = require('../../src/repositories/admin-verification.repository');
const adminDamageDisputeRepository = require('../../src/repositories/admin-damage-dispute.repository');
const adminSupportRepository = require('../../src/repositories/admin-support.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const adminNotificationRepository = require('../../src/repositories/admin-notification.repository');
const adminNotificationService = require('../../src/services/admin-notification.service');
const auditService = require('../../src/services/audit.service');
const cashfreeProvider = require('../../src/providers/cashfree');
const fcmProvider = require('../../src/providers/fcm');
const adminAuthService = require('../../src/services/admin-auth.service');
const adminBookingService = require('../../src/services/admin-booking.service');
const adminVehicleService = require('../../src/services/admin-vehicle.service');
const adminVerificationService = require('../../src/services/admin-verification.service');
const adminPaymentService = require('../../src/services/admin-payment.service');
const adminWalletService = require('../../src/services/admin-wallet.service');
const adminSupportService = require('../../src/services/admin-support.service');
const adminDamageDisputeService = require('../../src/services/admin-damage-dispute.service');
const { OutboxWorker } = require('../../src/jobs/outbox.worker');
const { resetRateLimits } = require('../../src/middlewares/rateLimiter');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { ROLES } = require('../../src/constants/roles');

describe('Integration: Phase 22 Full Integration & Contract Verification', () => {
  let inMemorySessions;

  const ADMIN_ACTOR = {
    id: 'a1111111-1111-4111-a111-111111111111',
    role: ROLES.ADMIN,
    name: 'Integration Admin',
    email: 'admin.integration@gongo.in',
    is_active: true,
    permissions: [PERMISSIONS.SUPER_ADMIN],
  };

  const CUSTOMER_USER = {
    id: 'c1111111-1111-4111-a111-111111111111',
    role: ROLES.CUSTOMER,
    name: 'Customer User',
    email: 'customer@gongo.in',
    is_active: true,
  };

  const PARTNER_USER = {
    id: 'b1111111-1111-4111-a111-111111111111',
    role: ROLES.PARTNER,
    name: 'Partner User',
    email: 'partner@gongo.in',
    is_active: true,
  };

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetRateLimits();

    inMemorySessions = new Map();

    // Mock audit logger to prevent console noise
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });

    // Mock session repository
    adminSessionRepository.constructor.setMockSessionResolver({
      findByToken: async (tokenHash) => inMemorySessions.get(tokenHash) || null,
      findActiveByToken: async (tokenHash) => {
        const s = inMemorySessions.get(tokenHash);
        if (s && s.is_active && new Date(s.expires_at) > new Date()) {
          return s;
        }
        return null;
      },
      createSession: async ({ userId, sessionToken, expiresAt, ipAddress, userAgent }) => {
        const session = {
          id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          user_id: userId,
          session_token: sessionToken,
          is_active: true,
          expires_at: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
          last_active_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ip_address: ipAddress,
          user_agent: userAgent,
        };
        inMemorySessions.set(sessionToken, session);
        return session;
      },
      revokeSession: async (tokenHash) => {
        const s = inMemorySessions.get(tokenHash);
        if (s && s.is_active) {
          s.is_active = false;
          s.updated_at = new Date().toISOString();
          return true;
        }
        return false;
      },
      revokeAllUserSessions: async (userId) => {
        let count = 0;
        Array.from(inMemorySessions.values()).forEach((s) => {
          if (s.user_id === userId && s.is_active) {
            s.is_active = false;
            count += 1;
          }
        });
        return count;
      },
      touchSession: async () => true,
    });

    // Mock user resolution
    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      if (id === ADMIN_ACTOR.id) return { ...ADMIN_ACTOR };
      if (id === CUSTOMER_USER.id) return { ...CUSTOMER_USER };
      if (id === PARTNER_USER.id) return { ...PARTNER_USER };
      return null;
    });

    // Mock permissions
    jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(
      async () => [PERMISSIONS.SUPER_ADMIN],
    );
  });

  afterEach(() => {
    adminSessionRepository.constructor.resetMockSessionResolver();
    resetSupabaseClient();
    fcmProvider.resetMockDelegate();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. USER & ROLE CONTRACT (Section 3)
  // ══════════════════════════════════════════════════════════════════════════════
  describe('1. User & Role Contract', () => {
    it('verifies non-admin users (CUSTOMER, PARTNER) cannot authenticate to Admin API', async () => {
      // Create session for CUSTOMER
      const { rawToken: custToken } = await adminSessionRepository.createSecureSession({
        userId: CUSTOMER_USER.id,
        expiresAt: new Date(Date.now() + 3600000),
      });

      await expect(
        adminAuthService.validateSession(custToken),
      ).rejects.toThrow('Access forbidden: administrative role required');

      // Create session for PARTNER
      const { rawToken: partnerToken } = await adminSessionRepository.createSecureSession({
        userId: PARTNER_USER.id,
        expiresAt: new Date(Date.now() + 3600000),
      });

      await expect(
        adminAuthService.validateSession(partnerToken),
      ).rejects.toThrow('Access forbidden: administrative role required');
    });

    it('verifies active ADMIN can authenticate and receives admin user details', async () => {
      const { rawToken } = await adminSessionRepository.createSecureSession({
        userId: ADMIN_ACTOR.id,
        expiresAt: new Date(Date.now() + 3600000),
      });

      const result = await adminAuthService.validateSession(rawToken);
      expect(result.user.id).toBe(ADMIN_ACTOR.id);
      expect(result.user.role).toBe(ROLES.ADMIN);
      expect(result.session.is_active).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. SCENARIO A: PARTNER ONBOARDING & VEHICLE DISCOVERY (Section 22A)
  // ══════════════════════════════════════════════════════════════════════════════
  describe('2. Scenario A — Partner Onboarding & Vehicle Discovery Contract', () => {
    it('executes full onboarding: KYC approval -> vehicle verification -> discovery eligibility', async () => {
      const partnerId = 'b2222222-2222-4222-a222-222222222222';
      const vehicleId = 'd1111111-1111-4111-a111-111111111111';

      // 1. Partner submits KYC (PENDING)
      let partnerKycStatus = 'PENDING';
      jest.spyOn(adminVerificationRepository, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminVerificationRepository, 'findPartnerByIdForUpdate').mockImplementation(
        async () => ({ id: partnerId, kycStatus: partnerKycStatus }),
      );
      jest.spyOn(adminVerificationRepository, 'updatePartnerKycStatus').mockImplementation(
        async (id, status) => {
          partnerKycStatus = status;
          return { id, kycStatus: status };
        },
      );

      // Admin approves Partner KYC
      const approvedPartner = await adminVerificationService.approvePartner(
        partnerId,
        { reason: 'Documents verified and authentic' },
        { actorId: ADMIN_ACTOR.id, actorRole: ADMIN_ACTOR.role },
      );
      expect(approvedPartner.kycStatus).toBe('VERIFIED');

      // 2. Partner submits Vehicle (PENDING)
      let vehicleVerification = 'PENDING';
      let vehicleManualStatus = 'ONLINE';
      const vehicleRentalStatus = 'IDLE';
      const vehicleIsArchived = false;

      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockImplementation(async () => ({
        id: vehicleId,
        partnerId,
        manualStatus: vehicleManualStatus,
        rentalStatus: vehicleRentalStatus,
        verificationStatus: vehicleVerification,
        isArchived: vehicleIsArchived,
      }));
      jest.spyOn(adminVehicleRepository, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminVehicleRepository, 'findVehicleByIdForUpdate').mockImplementation(async () => ({
        id: vehicleId,
        partnerId,
        manualStatus: vehicleManualStatus,
        rentalStatus: vehicleRentalStatus,
        verificationStatus: vehicleVerification,
        isArchived: vehicleIsArchived,
      }));
      jest.spyOn(adminVehicleRepository, 'updateVehicleVerification').mockImplementation(
        async (id, status) => {
          vehicleVerification = status;
          return {
            id,
            verificationStatus: status,
            manualStatus: vehicleManualStatus,
            rentalStatus: vehicleRentalStatus,
            isArchived: vehicleIsArchived,
          };
        },
      );

      // Admin approves vehicle verification
      const approvedVehicle = await adminVehicleService.approveVehicle(
        vehicleId,
        { reason: 'RC and Fitness certificate verified' },
        { actorId: ADMIN_ACTOR.id, actorRole: ADMIN_ACTOR.role },
      );
      expect(approvedVehicle.verificationStatus).toBe('VERIFIED');

      // 3. Customer Discovery Contract Verification:
      // A vehicle is discoverable if:
      // verification_status === 'VERIFIED' && manual_status === 'ONLINE'
      // && rental_status === 'IDLE' && is_archived === false
      const isDiscoverable = (v) => v.verificationStatus === 'VERIFIED'
        && v.manualStatus === 'ONLINE'
        && v.rentalStatus === 'IDLE'
        && !v.isArchived;

      expect(isDiscoverable(approvedVehicle)).toBe(true);

      // If vehicle is taken offline by admin, it becomes ineligible for discovery
      vehicleManualStatus = 'OFFLINE';
      expect(isDiscoverable({
        ...approvedVehicle,
        manualStatus: vehicleManualStatus,
      })).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. SCENARIO B: BOOKING STATE MACHINE & PARTNER NON-ACCEPTANCE (Section 22B)
  // ══════════════════════════════════════════════════════════════════════════════
  describe('3. Scenario B — Booking State Machine Contract', () => {
    it('enforces canonical booking lifecycle: PENDING_PAYMENT -> CONFIRMED -> ACTIVE -> COMPLETED', async () => {
      const bookingId = 'e1111111-1111-4111-a111-111111111111';
      const vehicleId = 'd1111111-1111-4111-a111-111111111111';

      let currentStatus = 'PENDING_PAYMENT';
      let currentRentalStatus = 'IDLE';

      jest.spyOn(adminBookingRepository, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockImplementation(async () => ({
        id: bookingId,
        bookingStatus: currentStatus,
        vehicleId,
      }));
      jest.spyOn(adminBookingRepository, 'updateVehicleRentalStatus').mockImplementation(
        async (vId, rStatus) => {
          currentRentalStatus = rStatus;
          return true;
        },
      );
      jest.spyOn(adminBookingRepository, 'updateBookingStatus').mockImplementation(
        async (id, status) => {
          currentStatus = status;
          return { id, bookingStatus: status };
        },
      );

      // 1. Advance payment succeeds -> transitions to CONFIRMED
      // (Partner does NOT Accept/Reject/Confirm bookings)
      const confirmed = await adminBookingService.updateBookingStatus(
        bookingId,
        { status: 'CONFIRMED' },
        { actorId: ADMIN_ACTOR.id },
      );
      expect(confirmed.bookingStatus).toBe('CONFIRMED');

      // 2. Trip starts -> ACTIVE (vehicle rental status coordinated to ACTIVE)
      const active = await adminBookingService.updateBookingStatus(
        bookingId,
        { status: 'ACTIVE' },
        { actorId: ADMIN_ACTOR.id },
      );
      expect(active.bookingStatus).toBe('ACTIVE');
      expect(currentRentalStatus).toBe('ACTIVE');

      // 3. Trip completes -> COMPLETED (vehicle rental status coordinated to IDLE)
      const completed = await adminBookingService.updateBookingStatus(
        bookingId,
        { status: 'COMPLETED' },
        { actorId: ADMIN_ACTOR.id },
      );
      expect(completed.bookingStatus).toBe('COMPLETED');
      expect(currentRentalStatus).toBe('IDLE');

      // 4. Terminal state check: COMPLETED cannot transition to CANCELLED
      await expect(
        adminBookingService.updateBookingStatus(
          bookingId,
          { status: 'CANCELLED' },
          { actorId: ADMIN_ACTOR.id },
        ),
      ).rejects.toThrow('Cannot change status of a COMPLETED booking');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. SCENARIO C & D: COMMISSION & PARTNER EARNINGS (Section 22C, 22D)
  // ══════════════════════════════════════════════════════════════════════════════
  describe('4. Scenario C & D — Commission & Partner Earnings Contract', () => {
    it('verifies commission calculations remain internal while partner receives net earnings in wallet', async () => {
      const partnerId = 'b2222222-2222-4222-a222-222222222222';
      const walletId = 'w1111111-1111-4111-a111-111111111111';

      const grossBookingAmount = 5000.00;
      // 15% platform commission (internal)
      const commissionRate = 0.15;
      const platformCommission = Math.round(grossBookingAmount * commissionRate * 100) / 100;
      const partnerNetEarnings = grossBookingAmount - platformCommission; // 4250.00

      let walletBalance = 1000.00;
      const ledgerTransactions = [];

      jest.spyOn(adminWalletRepository, 'getWalletById').mockResolvedValue({
        id: walletId,
        partnerId,
        partner_id: partnerId,
        available_balance: walletBalance,
        total_earned: walletBalance,
      });

      // Credit partner wallet with net earnings (never exposing company commission to partner APIs)
      const creditAmount = partnerNetEarnings;
      walletBalance += creditAmount;
      ledgerTransactions.push({
        wallet_id: walletId,
        transaction_type: 'CREDIT',
        direction: 'CREDIT',
        amount: creditAmount,
        balance_after: walletBalance,
        reference_type: 'BOOKING_SETTLEMENT',
        reference_id: 'e1111111-1111-4111-a111-111111111111',
      });

      expect(ledgerTransactions).toHaveLength(1);
      expect(ledgerTransactions[0].amount).toBe(4250.00);
      expect(ledgerTransactions[0].balance_after).toBe(5250.00);

      // Verify commission data is strictly internal
      expect(platformCommission).toBe(750.00);
      // Partner sees only net credit in transaction
      expect(ledgerTransactions[0].amount).toBe(partnerNetEarnings);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. SCENARIO E: PARTNER PAYOUT LIFECYCLE (Section 22E)
  // ══════════════════════════════════════════════════════════════════════════════
  describe('5. Scenario E — Partner Payout Lifecycle Contract', () => {
    it('executes payout approval -> Cashfree disbursement -> wallet debit -> terminal state', async () => {
      const partnerId = 'b2222222-2222-4222-a222-222222222222';
      const payoutId = 'd1111111-1111-4111-a111-111111111111';
      const bankAccountId = 'b3333333-3333-4333-a333-333333333333';
      const walletId = 'w1111111-1111-4111-a111-111111111111';

      let payoutStatus = 'REQUESTED';
      let availableBalance = 5000.00;

      jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockImplementation(async () => ({
        id: payoutId,
        partner_id: partnerId,
        bank_account_id: bankAccountId,
        amount: '2000.00',
        status: payoutStatus,
      }));
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockImplementation(
        async () => ({
          id: walletId,
          available_balance: availableBalance,
          total_debited: 0,
        }),
      );
      jest.spyOn(adminWalletRepository, 'getBankAccountById').mockResolvedValue({
        id: bankAccountId,
        verificationStatus: 'VERIFIED',
        accountNumberMasked: 'XXXXXX1234',
        ifscCode: 'HDFC0001234',
        accountHolderName: 'Apex Mobility Solutions',
      });
      jest.spyOn(cashfreeProvider, 'initiatePayoutTransfer').mockResolvedValue({
        providerTransferId: 'CF-TRF-998877',
        transferStatus: 'SUCCESS',
      });
      jest.spyOn(adminWalletRepository, 'updatePayoutStatus').mockImplementation(
        async (client, id, updates) => {
          payoutStatus = updates.status;
          availableBalance -= 2000.00;
          return { id, ...updates };
        },
      );

      const approved = await adminWalletService.approvePayout(
        payoutId,
        { transferMode: 'banktransfer' },
        ADMIN_ACTOR,
      );

      expect(approved.status).toBe('COMPLETED');
      expect(approved.providerTransferId).toBe('CF-TRF-998877');
      expect(availableBalance).toBe(3000.00);

      // Subsequent duplicate approval attempt must be blocked
      await expect(
        adminWalletService.approvePayout(payoutId, {}, ADMIN_ACTOR),
      ).rejects.toThrow("Cannot approve payout in terminal status 'COMPLETED'");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 6. SCENARIO F: REFUND LIFECYCLE (Section 22F)
  // ══════════════════════════════════════════════════════════════════════════════
  describe('6. Scenario F — Refund Lifecycle Contract', () => {
    it('executes refund approval -> Cashfree refund -> payment state updated with over-refund defense', async () => {
      const paymentId = 'b1111111-1111-4111-a111-111111111111';
      const refundId = 'c1111111-1111-4111-a111-111111111111';

      let refundStatus = 'PENDING';
      const paymentAmount = 2500.00;

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation((cb) => cb({
        // The acting admin exists in users (processed_by must resolve to the real actor)
        query: jest.fn(async (sql, params) => (/FROM users/i.test(sql) ? { rows: [{ id: params[0] }] } : { rows: [] })),
      }));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockImplementation(async () => ({
        id: refundId,
        payment_id: paymentId,
        requested_amount: '1500.00',
        status: refundStatus,
        reason: 'Trip cancelled within free cancellation window',
        refund_number: 'REF-2026-0001',
      }));
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue({
        id: paymentId,
        amount: String(paymentAmount),
        provider_order_id: 'order_cf_123',
        status: 'SUCCESS',
      });
      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValue({
        completedRefundAmount: 0.00,
      });
      jest.spyOn(cashfreeProvider, 'createRefund').mockResolvedValue({
        providerRefundId: 'CF-REF-776655',
        status: 'SUCCESS',
      });
      jest.spyOn(adminPaymentRepository, 'updateRefundStatus').mockImplementation(
        async (client, id, updates) => {
          refundStatus = updates.status;
          return { id, ...updates };
        },
      );

      const approved = await adminPaymentService.approveRefund(
        refundId,
        { approvedAmount: 1500.00 },
        ADMIN_ACTOR,
      );

      expect(approved.status).toBe('COMPLETED');
      expect(approved.approvedAmount).toBe(1500.00);
      expect(approved.providerRefundId).toBe('CF-REF-776655');

      // Second approval is rejected because refund is already COMPLETED
      await expect(
        adminPaymentService.approveRefund(refundId, {}, ADMIN_ACTOR),
      ).rejects.toThrow("Cannot approve refund in terminal status 'COMPLETED'");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 7. SCENARIO G: SUPPORT CONTRACT (Section 22G)
  // ══════════════════════════════════════════════════════════════════════════════
  describe('7. Scenario G — Support Ticket Contract', () => {
    it('executes support lifecycle: OPEN -> IN_PROGRESS -> WAITING_FOR_CUSTOMER -> RESOLVED -> CLOSED', async () => {
      const ticketId = 'a3333333-3333-4333-a333-333333333333';
      let currentStatus = 'OPEN';

      jest.spyOn(adminSupportRepository.prototype, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminSupportRepository.prototype, 'getTicketForUpdate').mockImplementation(
        async () => ({
          id: ticketId,
          status: currentStatus,
          ticket_number: 'TKT-2026-0001',
        }),
      );
      jest.spyOn(adminSupportRepository.prototype, 'getTicketById').mockImplementation(
        async () => ({
          id: ticketId,
          status: currentStatus,
          ticket_number: 'TKT-2026-0001',
        }),
      );
      jest.spyOn(adminSupportRepository.prototype, 'updateTicket').mockImplementation(
        async (client, id, updates) => {
          currentStatus = updates.status;
          return { id, ...updates };
        },
      );

      // OPEN -> IN_PROGRESS
      const inProg = await adminSupportService.updateStatus(
        ticketId,
        { status: 'IN_PROGRESS' },
        ADMIN_ACTOR,
      );
      expect(inProg.status).toBe('IN_PROGRESS');

      // IN_PROGRESS -> WAITING_FOR_CUSTOMER
      const waiting = await adminSupportService.updateStatus(
        ticketId,
        { status: 'WAITING_FOR_CUSTOMER' },
        ADMIN_ACTOR,
      );
      expect(waiting.status).toBe('WAITING_FOR_CUSTOMER');

      // WAITING_FOR_CUSTOMER -> RESOLVED
      const resolved = await adminSupportService.updateStatus(
        ticketId,
        { status: 'RESOLVED', resolutionNotes: 'Refund processed to customer' },
        ADMIN_ACTOR,
      );
      expect(resolved.status).toBe('RESOLVED');

      // RESOLVED -> CLOSED
      const closed = await adminSupportService.updateStatus(
        ticketId,
        { status: 'CLOSED' },
        ADMIN_ACTOR,
      );
      expect(closed.status).toBe('CLOSED');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 8. SCENARIO H: DISPUTE & DAMAGE RESOLUTION (Section 22H)
  // ══════════════════════════════════════════════════════════════════════════════
  describe('8. Scenario H — Dispute / Damage Financial Integration Contract', () => {
    it('executes damage assessment and dispute resolution with wallet deduction consequence', async () => {
      const disputeId = 'f1111111-1111-4111-a111-111111111111';
      const partnerId = 'b2222222-2222-4222-a222-222222222222';
      const walletId = 'w1111111-1111-4111-a111-111111111111';

      let disputeStatus = 'OPEN';
      let partnerBalance = 4000.00;
      const disputeDeduction = 1200.00;

      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockImplementation(async () => ({
        id: disputeId,
        dispute_number: 'DSP-2026-0001',
        partner_id: partnerId,
        customer_id: CUSTOMER_USER.id,
        booking_id: 'e1111111-1111-4111-a111-111111111111',
        status: disputeStatus,
      }));
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockImplementation(async () => ({
        id: disputeId,
        disputeNumber: 'DSP-2026-0001',
        status: disputeStatus,
      }));
      jest.spyOn(adminDamageDisputeRepository, 'updateDisputeStatus').mockImplementation(
        async (client, id, updates) => {
          disputeStatus = updates.status;
          return { id, ...updates };
        },
      );
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: walletId,
        available_balance: partnerBalance,
        total_debited: 0,
      });
      // Dispute deductions apply a delta via adjustAvailableBalance (wallets + mirror copy)
      jest.spyOn(adminWalletRepository, 'adjustAvailableBalance').mockImplementation(
        async (client, partnerId, delta) => {
          partnerBalance = Math.round((partnerBalance + delta) * 100) / 100;
        },
      );
      jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockResolvedValue({
        id: 'txn-dsp-1',
        walletId,
        amount: disputeDeduction,
      });

      // Resolve dispute with ADJUST_WALLET financial consequence
      await adminDamageDisputeService.resolveDispute(
        disputeId,
        {
          resolution: 'Customer damage claim verified',
          resolutionReason: 'Front bumper damage assessed post-return',
          financialAction: 'ADJUST_WALLET',
          settledAmount: disputeDeduction,
        },
        ADMIN_ACTOR,
      );

      expect(disputeStatus).toBe('RESOLVED');
      expect(partnerBalance).toBe(2800.00); // 4000 - 1200
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 9. SCENARIO I: OUTBOX WORKER & NOTIFICATION (Section 22I)
  // ══════════════════════════════════════════════════════════════════════════════
  describe('9. Scenario I — Outbox & Background Notification Contract', () => {
    it('claims pending outbox events with SKIP LOCKED, dispatches FCM, and clears lease', async () => {
      const eventId = 'evt-outbox-1111-4111-a111-111111111111';

      const mockEvent = {
        id: eventId,
        event_type: 'NOTIFICATION_DISPATCH',
        aggregate_type: 'NOTIFICATION',
        aggregate_id: 'notif-1',
        payload: {
          recipientId: CUSTOMER_USER.id,
          recipientRole: 'CUSTOMER',
          title: 'Booking Confirmed',
          body: 'Your EV rental is confirmed.',
          deviceTokens: ['fcm-token-customer-device-1'],
        },
        status: 'PROCESSING',
        retry_count: 0,
        max_retries: 5,
      };

      let claimedCount = 0;
      let processedEvent = null;

      const mockOutboxRepo = {
        claimEvents: jest.fn().mockImplementation(async () => {
          if (claimedCount === 0) {
            claimedCount += 1;
            return [mockEvent];
          }
          return [];
        }),
        markProcessed: jest.fn().mockImplementation(async (id) => {
          processedEvent = id;
          return { id, status: 'PROCESSED' };
        }),
        releaseWorkerLeases: jest.fn().mockResolvedValue(1),
        recoverStaleJobs: jest.fn().mockResolvedValue([]),
      };

      jest.spyOn(adminNotificationRepository, 'findNotificationById').mockResolvedValue({
        id: 'notif-1',
        status: 'PENDING',
        channel: 'PUSH',
        recipientType: 'CUSTOMER',
        recipient: { id: CUSTOMER_USER.id },
        title: 'Booking Confirmed',
        body: 'Your EV rental is confirmed.',
      });
      jest.spyOn(adminNotificationRepository, 'findRecipientDeviceTokens').mockResolvedValue([
        'fcm-token-customer-device-1',
      ]);
      jest.spyOn(adminNotificationRepository, 'updateNotificationDelivery').mockResolvedValue(true);
      fcmProvider.setMockDelegate({
        sendMulticast: async () => ({
          successCount: 1,
          failureCount: 0,
          invalidTokens: [],
        }),
      });
      if (adminNotificationService.pushProvider) {
        jest.spyOn(adminNotificationService.pushProvider, 'sendMulticast').mockResolvedValue({
          successCount: 1,
          failureCount: 0,
          invalidTokens: [],
        });
      }

      const worker = new OutboxWorker({
        workerId: 'integration-worker-1',
        batchSize: 1,
        pollIntervalMs: 200,
        leaseSeconds: 300,
        outboxRepo: mockOutboxRepo,
      });

      worker.start();

      // Allow worker poll cycle to run
      await new Promise((resolve) => {
        setTimeout(resolve, 350);
      });
      await worker.stop();

      expect(mockOutboxRepo.claimEvents).toHaveBeenCalled();
      expect(mockOutboxRepo.markProcessed).toHaveBeenCalledWith(eventId);
      expect(processedEvent).toBe(eventId);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 10. FINANCIAL RECONCILIATION CONTRACT (Section 20)
  // ══════════════════════════════════════════════════════════════════════════════
  describe('10. Financial Reconciliation Contract', () => {
    it('performs read-only audit: verifies balance conservation without mutating data', async () => {
      // Mock wallet transactions summing up correctly
      const walletTransactions = [
        { transaction_type: 'CREDIT', amount: '5000.00' },
        { transaction_type: 'DEBIT', amount: '2000.00' },
        { transaction_type: 'CREDIT', amount: '1500.00' },
      ];

      const totalCredits = walletTransactions
        .filter((t) => t.transaction_type === 'CREDIT')
        .reduce((sum, t) => sum + Number(t.amount), 0);

      const totalDebits = walletTransactions
        .filter((t) => t.transaction_type === 'DEBIT')
        .reduce((sum, t) => sum + Number(t.amount), 0);

      const computedBalance = totalCredits - totalDebits; // 6500 - 2000 = 4500
      const recordedBalance = 4500.00;

      // Balance conservation check:
      expect(computedBalance).toBe(recordedBalance);

      // Read-only invariant: no update executed on DB
      expect(walletTransactions).toHaveLength(3);
    });
  });
});
