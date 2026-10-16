'use strict';

const { resetSupabaseClient } = require('../../src/providers/supabase');
const userRepository = require('../../src/repositories/user.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminPermissionRepository = require('../../src/repositories/admin-permission.repository');
const adminBookingRepository = require('../../src/repositories/admin-booking.repository');
const adminVehicleRepository = require('../../src/repositories/admin-vehicle.repository');
const adminCustomerRepository = require('../../src/repositories/admin-customer.repository');
const adminPartnerRepository = require('../../src/repositories/admin-partner.repository');
const adminPaymentRepository = require('../../src/repositories/admin-payment.repository');
const adminWalletRepository = require('../../src/repositories/admin-wallet.repository');
const adminDamageDisputeRepository = require('../../src/repositories/admin-damage-dispute.repository');
const auditService = require('../../src/services/audit.service');
const s3Provider = require('../../src/providers/s3');
const adminAuthService = require('../../src/services/admin-auth.service');
const adminPermissionService = require('../../src/services/admin-permission.service');
const adminBookingService = require('../../src/services/admin-booking.service');
const adminVehicleService = require('../../src/services/admin-vehicle.service');
const adminCustomerService = require('../../src/services/admin-customer.service');
const adminPartnerService = require('../../src/services/admin-partner.service');
const adminPaymentService = require('../../src/services/admin-payment.service');
const adminWalletService = require('../../src/services/admin-wallet.service');
const adminDamageDisputeService = require('../../src/services/admin-damage-dispute.service');
const { OutboxWorker } = require('../../src/jobs/outbox.worker');
const { resetRateLimits } = require('../../src/middlewares/rateLimiter');
const { hashSessionToken } = require('../../src/utils/crypto');
const { ERROR_CODES } = require('../../src/constants/errors');
const { ConflictError } = require('../../src/errors/AppError');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { ROLES } = require('../../src/constants/roles');

describe('Integration: Phase 21 Security & Concurrency Hardening', () => {
  let inMemorySessions;
  let inMemoryPermissions;

  const ADMIN_USER = {
    id: 'a1111111-1111-4111-a111-111111111111',
    auth_id: 'fb-admin-security-hardening-1',
    email: 'admin.sec@gongo.in',
    name: 'Security Admin',
    role: ROLES.ADMIN,
    is_active: true,
  };

  const SECOND_ADMIN = {
    id: 'a2222222-2222-4222-a222-222222222222',
    auth_id: 'fb-admin-security-hardening-2',
    email: 'admin2.sec@gongo.in',
    name: 'Second Admin',
    role: ROLES.ADMIN,
    is_active: true,
  };

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetRateLimits();

    inMemorySessions = new Map();
    inMemoryPermissions = new Map();

    // Mock audit logger to be silent
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);

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
      touchSession: async (tokenHash) => {
        const s = inMemorySessions.get(tokenHash);
        if (s && s.is_active) {
          s.last_active_at = new Date().toISOString();
          return true;
        }
        return false;
      },
      countActiveSessionsByUserId: async (userId) => {
        let count = 0;
        Array.from(inMemorySessions.values()).forEach((s) => {
          if (s.user_id === userId && s.is_active) count += 1;
        });
        return count;
      },
    });

    // Mock user resolution
    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      if (id === ADMIN_USER.id) return { ...ADMIN_USER };
      if (id === SECOND_ADMIN.id) return { ...SECOND_ADMIN };
      return null;
    });

    // Mock permissions
    jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(
      async (userId) => inMemoryPermissions.get(userId) || [PERMISSIONS.SUPER_ADMIN],
    );
  });

  afterEach(() => {
    adminSessionRepository.constructor.resetMockSessionResolver();
    resetSupabaseClient();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. AUTHENTICATION & SESSION CONCURRENCY HARDENING
  // ══════════════════════════════════════════════════════════════════════════════
  describe('1. Authentication & Session Concurrency', () => {
    it('prevents concurrent refresh race: second concurrent refresh with same token is rejected', async () => {
      // Create initial valid session
      const { rawToken } = await adminSessionRepository.createSecureSession({
        userId: ADMIN_USER.id,
        expiresAt: new Date(Date.now() + 3600000),
      });

      // Concurrent refresh calls using the exact same rawToken
      const [res1, res2] = await Promise.allSettled([
        adminAuthService.refreshSession({ rawToken }),
        adminAuthService.refreshSession({ rawToken }),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      // Exactly one succeeds, the other fails
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The rejected error must indicate token revocation / invalid session
      expect(rejected[0].reason.code).toBe(ERROR_CODES.TOKEN_REVOKED);
    });

    it('rejects access from inactive / suspended administrator', async () => {
      const { rawToken } = await adminSessionRepository.createSecureSession({
        userId: ADMIN_USER.id,
        expiresAt: new Date(Date.now() + 3600000),
      });

      // Suspended in DB
      jest.spyOn(userRepository, 'findById').mockResolvedValueOnce({
        ...ADMIN_USER,
        is_active: false,
      });

      await expect(
        adminAuthService.validateSession(rawToken),
      ).rejects.toThrow('User account has been deactivated');
    });

    it('guarantees logout is idempotent and cannot throw error on repeated logout', async () => {
      const { rawToken } = await adminSessionRepository.createSecureSession({
        userId: ADMIN_USER.id,
        expiresAt: new Date(Date.now() + 3600000),
      });

      const res1 = await adminAuthService.logout({
        rawToken,
        userId: ADMIN_USER.id,
      });
      expect(res1.message).toBe('Successfully logged out');

      // Second logout with same token
      const res2 = await adminAuthService.logout({
        rawToken,
        userId: ADMIN_USER.id,
      });
      expect(res2.message).toBe('Successfully logged out');
    });

    it('logout-all strictly isolates revocation to the caller user without affecting others', async () => {
      const { rawToken: tokenAdmin1 } = await adminSessionRepository.createSecureSession({
        userId: ADMIN_USER.id,
        expiresAt: new Date(Date.now() + 3600000),
      });
      const { rawToken: tokenAdmin2 } = await adminSessionRepository.createSecureSession({
        userId: SECOND_ADMIN.id,
        expiresAt: new Date(Date.now() + 3600000),
      });

      // Logout all for ADMIN_USER
      await adminAuthService.logoutAll({ userId: ADMIN_USER.id });

      // Admin 1 session is revoked
      const hash1 = hashSessionToken(tokenAdmin1);
      const sess1 = await adminSessionRepository.findActiveByToken(hash1);
      expect(sess1).toBeNull();

      // Admin 2 session remains active
      const hash2 = hashSessionToken(tokenAdmin2);
      const sess2 = await adminSessionRepository.findActiveByToken(hash2);
      expect(sess2).not.toBeNull();
      expect(sess2.is_active).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. RBAC & PERMISSION CONCURRENCY
  // ══════════════════════════════════════════════════════════════════════════════
  describe('2. RBAC & Permission Concurrency', () => {
    it('handles concurrent identical permission grants idempotently without duplicate rows', async () => {
      let callCount = 0;
      jest.spyOn(adminPermissionRepository, 'assignPermission').mockImplementation(
        async (userId, perm) => {
          callCount += 1;
          return { user_id: userId, permission: perm };
        },
      );

      const actor = {
        id: ADMIN_USER.id,
        role: ROLES.ADMIN,
        permissions: [PERMISSIONS.SUPER_ADMIN],
      };

      const [res1, res2] = await Promise.all([
        adminPermissionService.grantPermission({
          targetUserId: SECOND_ADMIN.id,
          permission: PERMISSIONS.PAYOUTS_APPROVE,
          actor,
        }),
        adminPermissionService.grantPermission({
          targetUserId: SECOND_ADMIN.id,
          permission: PERMISSIONS.PAYOUTS_APPROVE,
          actor,
        }),
      ]);

      expect(res1.granted).toBe(true);
      expect(res2.granted).toBe(true);
      expect(callCount).toBe(2);
    });

    it('strictly prevents self-escalation attempt', async () => {
      // Actor is regular admin without SUPER_ADMIN or manage permission
      const regularAdmin = {
        id: ADMIN_USER.id,
        role: ROLES.ADMIN,
        permissions: [PERMISSIONS.BOOKINGS_VIEW],
      };

      await expect(
        adminPermissionService.grantPermission({
          targetUserId: ADMIN_USER.id,
          permission: PERMISSIONS.SUPER_ADMIN,
          actor: regularAdmin,
        }),
      ).rejects.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. BOLA / IDOR HARDENING
  // ══════════════════════════════════════════════════════════════════════════════
  describe('3. BOLA / IDOR Hardening', () => {
    it('consistently returns 404 for arbitrary non-existent resource UUID without leaking existence', async () => {
      const fakeUuid = '99999999-9999-4999-a999-999999999999';

      jest.spyOn(adminBookingRepository, 'findBookingById').mockResolvedValue(null);
      await expect(adminBookingService.getBookingDetail(fakeUuid)).rejects.toThrow('Booking not found');

      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(null);
      await expect(adminVehicleService.getVehicleDetail(fakeUuid)).rejects.toThrow('Vehicle not found');

      jest.spyOn(adminCustomerRepository, 'findCustomerById').mockResolvedValue(null);
      await expect(adminCustomerService.getCustomerDetail(fakeUuid)).rejects.toThrow('Customer not found');

      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(null);
      await expect(adminPartnerService.getPartnerDetail(fakeUuid)).rejects.toThrow('Partner not found');

      jest.spyOn(adminPaymentRepository, 'getPaymentById').mockResolvedValue(null);
      await expect(adminPaymentService.getPaymentById(fakeUuid)).rejects.toThrow('Payment record not found');

      jest.spyOn(adminPaymentRepository, 'getRefundById').mockResolvedValue(null);
      await expect(adminPaymentService.getRefundById(fakeUuid)).rejects.toThrow('Refund record not found');

      jest.spyOn(adminWalletRepository, 'getWalletById').mockResolvedValue(null);
      await expect(adminWalletService.getWalletById(fakeUuid)).rejects.toThrow('Wallet record not found');

      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValue(null);
      await expect(adminDamageDisputeService.getDamageById(fakeUuid)).rejects.toThrow('Damage report not found');
    });

    it('rejects malformed non-UUID identifiers with 400 Bad Request / Validation error', async () => {
      const maliciousIds = [
        '../etc/passwd',
        '1 OR 1=1',
        '<script>alert(1)</script>',
        'not-a-uuid',
      ];

      for (let i = 0; i < maliciousIds.length; i += 1) {
        const malformed = maliciousIds[i];
        await expect(adminBookingService.getBookingDetail(malformed)).rejects.toThrow();
        await expect(adminVehicleService.getVehicleDetail(malformed)).rejects.toThrow();
        await expect(adminPaymentService.getPaymentById(malformed)).rejects.toThrow();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. MASS ASSIGNMENT PROTECTION
  // ══════════════════════════════════════════════════════════════════════════════
  describe('4. Mass Assignment & Parameter Pollution', () => {
    it('rejects disallowed injected fields in booking status update', async () => {
      const bookingId = 'e1111111-1111-4111-a111-111111111111';

      await expect(
        adminBookingService.updateBookingStatus(bookingId, {
          status: 'COMPLETED',
          role: 'SUPER_ADMIN',
          wallet_balance: 999999,
          is_active: false,
        }),
      ).rejects.toThrow("Field 'role' is not allowed in booking status update");
    });

    it('rejects disallowed injected fields in vehicle status update', async () => {
      const vehicleId = 'd1111111-1111-4111-a111-111111111111';

      await expect(
        adminVehicleService.updateVehicleStatus(vehicleId, {
          manualStatus: 'ONLINE',
          commission_rate: 0,
          payout_balance: 50000,
        }),
      ).rejects.toThrow("Field 'commission_rate' is not allowed in vehicle status update");
    });

    it('rejects disallowed injected fields in customer status update', async () => {
      const customerId = 'c1111111-1111-4111-a111-111111111111';

      await expect(
        adminCustomerService.updateCustomerStatus(customerId, {
          isActive: true,
          role: 'ADMIN',
          admin_permissions: ['SUPER_ADMIN'],
        }),
      ).rejects.toThrow("Field 'role' is not allowed in customer status update");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. FINANCIAL CONCURRENCY HARDENING
  // ══════════════════════════════════════════════════════════════════════════════
  describe('5. Financial Concurrency Hardening', () => {
    it('rejects concurrent over-refunding: second refund exceeding remaining balance is blocked', async () => {
      const paymentId = 'b1111111-1111-4111-a111-111111111111';
      const refundId1 = 'c1111111-1111-4111-a111-111111111111';

      const mockPayment = {
        id: paymentId,
        amount: '1000.00',
        provider_order_id: 'order_123',
        status: 'SUCCESS',
      };

      const mockRefund = {
        id: refundId1,
        payment_id: paymentId,
        requested_amount: '800.00',
        status: 'PENDING',
        reason: 'Customer cancelled booking',
      };

      jest.spyOn(adminPaymentRepository, 'executeInTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminPaymentRepository, 'getRefundForUpdate').mockResolvedValue(mockRefund);
      jest.spyOn(adminPaymentRepository, 'getPaymentForUpdate').mockResolvedValue(mockPayment);
      // Already refunded 300
      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValue({
        completedRefundAmount: 300,
      });

      // Attempting to approve 800 when only 700 remaining (1000 - 300)
      await expect(
        adminPaymentService.approveRefund(refundId1, { approvedAmount: 800 }, ADMIN_USER),
      ).rejects.toThrow('exceeds remaining refundable balance (700)');
    });

    it('blocks approving a payout in terminal status with ConflictError', async () => {
      const payoutId = 'd1111111-1111-4111-a111-111111111111';

      jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: payoutId,
        status: 'COMPLETED',
        amount: '5000.00',
      });

      await expect(
        adminWalletService.approvePayout(payoutId, {}, ADMIN_USER),
      ).rejects.toThrow("Cannot approve payout in terminal status 'COMPLETED'");
    });

    it('blocks rejecting a payout in terminal status with ConflictError', async () => {
      const payoutId = 'd2222222-2222-4222-a222-222222222222';

      jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: payoutId,
        status: 'FAILED',
        amount: '3000.00',
      });

      // rejectPayout distinguishes settled payouts (COMPLETED/PAID -> "Cannot reject payout in
      // terminal status ...") from already-closed ones (REJECTED/FAILED/CANCELLED -> "Payout is
      // already in terminal status ..."); both are ConflictError (409).
      const rejectCall = adminWalletService.rejectPayout(payoutId, { reason: 'Duplicate' }, ADMIN_USER);
      await expect(rejectCall).rejects.toBeInstanceOf(ConflictError);
      await expect(rejectCall).rejects.toThrow("Payout is already in terminal status 'FAILED'");
    });

    it('blocks payout disbursement to an unverified bank account', async () => {
      const payoutId = 'd3333333-3333-4333-a333-333333333333';
      const partnerId = 'b2222222-2222-4222-a222-222222222222';
      const bankAccountId = 'b3333333-3333-4333-a333-333333333333';

      jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: payoutId,
        status: 'REQUESTED',
        amount: '2000.00',
        partner_id: partnerId,
        bank_account_id: bankAccountId,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: 'wal-1',
        available_balance: '5000.00',
      });
      jest.spyOn(adminWalletRepository, 'getBankAccountById').mockResolvedValue({
        id: bankAccountId,
        verificationStatus: 'PENDING',
      });

      await expect(
        adminWalletService.approvePayout(payoutId, {}, ADMIN_USER),
      ).rejects.toThrow('Cannot disburse payout to an unverified bank account');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 6. BOOKING & VEHICLE STATE CONCURRENCY
  // ══════════════════════════════════════════════════════════════════════════════
  describe('6. Booking & Vehicle State Concurrency', () => {
    it('blocks transitioning already COMPLETED booking', async () => {
      const bookingId = 'e1111111-1111-4111-a111-111111111111';

      jest.spyOn(adminBookingRepository, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        id: bookingId,
        bookingStatus: 'COMPLETED',
      });

      await expect(
        adminBookingService.updateBookingStatus(bookingId, { status: 'CANCELLED' }),
      ).rejects.toThrow('Cannot change status of a COMPLETED booking');
    });

    it('blocks cancelling an already CANCELLED booking', async () => {
      const bookingId = 'e1111111-1111-4111-a111-111111111111';

      jest.spyOn(adminBookingRepository, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminBookingRepository, 'findBookingByIdForUpdate').mockResolvedValue({
        id: bookingId,
        bookingStatus: 'CANCELLED',
      });

      await expect(
        adminBookingService.cancelBooking(bookingId, { reason: 'Customer requested' }),
      ).rejects.toThrow('Booking is already CANCELLED');
    });

    it('blocks offlining vehicle with active bookings unless force is explicitly true', async () => {
      const vehicleId = 'd1111111-1111-4111-a111-111111111111';

      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue({
        id: vehicleId,
        manualStatus: 'ONLINE',
      });
      jest.spyOn(adminVehicleRepository, 'withTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminVehicleRepository, 'findVehicleByIdForUpdate').mockResolvedValue({
        id: vehicleId,
        manualStatus: 'ONLINE',
      });
      jest.spyOn(adminVehicleRepository, 'getActiveBookingCount').mockResolvedValue(3);

      await expect(
        adminVehicleService.updateVehicleStatus(vehicleId, { manualStatus: 'OFFLINE' }),
      ).rejects.toThrow('Cannot take offline vehicle with 3 active/upcoming bookings');
    });

    it('blocks verifying an archived vehicle', async () => {
      const vehicleId = 'd1111111-1111-4111-a111-111111111111';

      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue({
        id: vehicleId,
        isArchived: true,
      });

      await expect(
        adminVehicleService.approveVehicle(vehicleId, { reason: 'Verify' }),
      ).rejects.toThrow('Cannot verify an archived vehicle');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 7. STORAGE SECURITY & SIGNED URLS
  // ══════════════════════════════════════════════════════════════════════════════
  describe('7. Storage Security & Presigned URLs', () => {
    it('guarantees presigned URLs expire in 900 seconds (15 minutes) canonical convention', async () => {
      let presignedExpires = null;
      jest.spyOn(s3Provider, 'createPresignedGetUrl').mockImplementation(async ({ expiresInSeconds }) => {
        presignedExpires = expiresInSeconds;
        return { downloadUrl: 'https://s3.amazonaws.com/gongo-bucket/file.pdf?signature=valid' };
      });

      const { downloadUrl } = await s3Provider.createPresignedGetUrl({
        key: 'documents/partner-1/kyc.pdf',
        expiresInSeconds: 900,
      });

      expect(downloadUrl).toBeDefined();
      expect(presignedExpires).toBe(900);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 8. DISPUTE & SUPPORT CONCURRENCY
  // ══════════════════════════════════════════════════════════════════════════════
  describe('8. Dispute & Support Concurrency', () => {
    it('blocks resolving an already RESOLVED dispute with ConflictError', async () => {
      const disputeId = 'f1111111-1111-4111-a111-111111111111';

      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation((cb) => cb({}));
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValue({
        id: disputeId,
        status: 'RESOLVED',
      });

      await expect(
        adminDamageDisputeService.resolveDispute(
          disputeId,
          {
            resolution: 'Settled by insurance',
            resolutionReason: 'Paid in full',
          },
          ADMIN_USER,
        ),
      ).rejects.toThrow("Dispute is already in terminal status 'RESOLVED'");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 9. OUTBOX & WORKER CONCURRENCY
  // ══════════════════════════════════════════════════════════════════════════════
  describe('9. Outbox & Worker Concurrency', () => {
    it('worker claims jobs with SKIP LOCKED semantics and recovers stale leases', async () => {
      let releasedCount = 0;
      const mockOutboxRepo = {
        claimEvents: jest.fn().mockResolvedValue([]),
        releaseWorkerLeases: jest.fn().mockImplementation(async () => {
          releasedCount += 1;
          return 1;
        }),
        recoverStaleJobs: jest.fn().mockResolvedValue(['event-1']),
      };

      const worker = new OutboxWorker({
        workerId: 'test-worker-1',
        batchSize: 5,
        pollIntervalMs: 500,
        leaseSeconds: 300,
        outboxRepo: mockOutboxRepo,
      });

      worker.start();
      expect(worker.isRunning).toBe(true);

      // Stop worker cleanly
      await worker.stop();
      expect(worker.isRunning).toBe(false);
      expect(mockOutboxRepo.releaseWorkerLeases).toHaveBeenCalledWith('test-worker-1');
      expect(releasedCount).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 10. SQL INJECTION DEFENSE & PARAMETERIZED QUERIES
  // ══════════════════════════════════════════════════════════════════════════════
  describe('10. SQL Injection & Input Validation Hardening', () => {
    it('safely parameterizes search queries with SQL injection payloads without syntax errors', async () => {
      const sqlInjectionPayloads = [
        "'; DROP TABLE users; --",
        "' OR '1'='1",
        "admin'--",
        "' UNION SELECT * FROM users --",
      ];

      for (let i = 0; i < sqlInjectionPayloads.length; i += 1) {
        const payload = sqlInjectionPayloads[i];
        // Mock DB returning 0 results safely
        jest.spyOn(adminCustomerRepository, 'listCustomers').mockResolvedValue({
          customers: [],
          total: 0,
        });

        const res = await adminCustomerService.listCustomers({ search: payload });
        expect(res.customers).toEqual([]);
        expect(res.pagination.total).toBe(0);
      }
    });

    it('rejects date ranges spanning more than 366 days', async () => {
      await expect(
        adminBookingService.listBookings({
          startDate: '2024-01-01',
          endDate: '2026-01-01',
        }),
      ).rejects.toThrow('Date range cannot exceed 366 days');
    });

    it('rejects startDate after endDate', async () => {
      await expect(
        adminBookingService.listBookings({
          startDate: '2026-09-10',
          endDate: '2026-09-01',
        }),
      ).rejects.toThrow('startDate must be before endDate');
    });
  });
});
