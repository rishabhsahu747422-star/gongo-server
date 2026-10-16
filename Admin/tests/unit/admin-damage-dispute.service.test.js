'use strict';

const adminDamageDisputeService = require('../../src/services/admin-damage-dispute.service');
const adminDamageDisputeRepository = require('../../src/repositories/admin-damage-dispute.repository');
const adminPaymentRepository = require('../../src/repositories/admin-payment.repository');
const adminWalletRepository = require('../../src/repositories/admin-wallet.repository');
const auditService = require('../../src/services/audit.service');
const s3Provider = require('../../src/providers/s3');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../../src/errors');

const TEST_DAMAGE_ID = 'a0000001-0000-4000-a000-000000000001';
const TEST_DISPUTE_ID = 'd0000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'b0000001-0000-4000-a000-000000000001';
const TEST_VEHICLE_ID = 'e0000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'f0000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'c0000001-0000-4000-a000-000000000001';
const TEST_ADMIN_ID = 'a0000002-0000-4000-a000-000000000001';
const TEST_PAYMENT_ID = 'a0000003-0000-4000-a000-000000000001';
const TEST_WALLET_ID = 'a0000004-0000-4000-a000-000000000001';

const ADMIN_USER = {
  id: TEST_ADMIN_ID,
  role: 'ADMIN',
  name: 'Admin Test',
  email: 'admin@gongo.in',
};

const AUDIT_META = {
  requestId: 'req-test-123',
  ipAddress: '127.0.0.1',
  userAgent: 'JestTestRunner',
};

describe('Unit: Admin Damage & Dispute Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(auditService, 'logAdminAction').mockResolvedValue({});
    jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
      async (cb) => cb({
        query: jest.fn(),
      }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. DAMAGE REPORTS
  // ══════════════════════════════════════════════════════════════════════════════

  describe('1. Damage Reports', () => {
    it('listDamages validates UUID filters and delegates to repository', async () => {
      const mockResult = { damages: [], total: 0, page: 1, limit: 20, totalPages: 1 };
      jest.spyOn(adminDamageDisputeRepository, 'listDamages').mockResolvedValueOnce(mockResult);

      const res = await adminDamageDisputeService.listDamages({
        damageId: TEST_DAMAGE_ID,
        bookingId: TEST_BOOKING_ID,
        vehicleId: TEST_VEHICLE_ID,
        partnerId: TEST_PARTNER_ID,
        customerId: TEST_CUSTOMER_ID,
      });

      expect(res).toEqual(mockResult);
      expect(adminDamageDisputeRepository.listDamages).toHaveBeenCalledWith(
        expect.objectContaining({
          damageId: TEST_DAMAGE_ID,
          bookingId: TEST_BOOKING_ID,
        }),
      );
    });

    it('listDamages rejects invalid UUID format', async () => {
      await expect(
        adminDamageDisputeService.listDamages({ bookingId: 'invalid-uuid' }),
      ).rejects.toThrow(BadRequestError);
    });

    it('listDamages rejects invalid date range', async () => {
      await expect(
        adminDamageDisputeService.listDamages({
          startDate: '2026-03-10',
          endDate: '2026-03-01',
        }),
      ).rejects.toThrow(BadRequestError);
    });

    it('getDamageById returns damage when found', async () => {
      const mockDamage = { id: TEST_DAMAGE_ID, status: 'REPORTED' };
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce(mockDamage);

      const res = await adminDamageDisputeService.getDamageById(TEST_DAMAGE_ID);
      expect(res).toEqual(mockDamage);
    });

    it('getDamageById throws NotFoundError when not found', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce(null);

      await expect(
        adminDamageDisputeService.getDamageById(TEST_DAMAGE_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('getDamageEvidence generates signed URLs for S3 keys and preserves HTTP URLs', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        bookingId: TEST_BOOKING_ID,
        photos: ['s3/damage/dmg1.jpg', 'https://cdn.example.com/dmg2.jpg'],
      });

      jest.spyOn(s3Provider, 'createPresignedGetUrl').mockResolvedValueOnce({
        downloadUrl: 'https://s3.aws.com/signed-dmg1.jpg',
      });

      const res = await adminDamageDisputeService.getDamageEvidence(TEST_DAMAGE_ID);
      expect(res.photos).toHaveLength(2);
      expect(res.photos[0].downloadUrl).toBe('https://s3.aws.com/signed-dmg1.jpg');
      expect(res.photos[1].downloadUrl).toBe('https://cdn.example.com/dmg2.jpg');
    });

    it('getDamageBooking returns associated booking', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        booking: { id: TEST_BOOKING_ID, bookingNumber: 'BK-1001' },
      });

      const res = await adminDamageDisputeService.getDamageBooking(TEST_DAMAGE_ID);
      expect(res.bookingNumber).toBe('BK-1001');
    });

    it('getDamageBooking throws NotFoundError when booking not present', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        booking: null,
      });

      await expect(
        adminDamageDisputeService.getDamageBooking(TEST_DAMAGE_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('getDamageInspections returns pickup and return inspections with signed photos', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        bookingId: TEST_BOOKING_ID,
      });

      jest.spyOn(adminDamageDisputeRepository, 'getDamageInspections').mockResolvedValueOnce({
        pickup: { id: 'pk-1', photos: ['pickup.jpg'], odometerStart: 1000 },
        return: { id: 'ret-1', photos: ['return.jpg'], odometerEnd: 1100 },
      });

      jest.spyOn(s3Provider, 'createPresignedGetUrl')
        .mockResolvedValueOnce({ downloadUrl: 'https://s3.aws.com/signed-pk.jpg' })
        .mockResolvedValueOnce({ downloadUrl: 'https://s3.aws.com/signed-ret.jpg' });

      const res = await adminDamageDisputeService.getDamageInspections(TEST_DAMAGE_ID);
      expect(res.pickup.odometerStart).toBe(1000);
      expect(res.pickup.photos[0].downloadUrl).toBe('https://s3.aws.com/signed-pk.jpg');
      expect(res.return.odometerEnd).toBe(1100);
      expect(res.return.photos[0].downloadUrl).toBe('https://s3.aws.com/signed-ret.jpg');
    });

    it('reviewDamage marks REPORTED damage as UNDER_REVIEW and audits', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'REPORTED',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDamageStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'UNDER_REVIEW',
      });

      const res = await adminDamageDisputeService.reviewDamage(
        TEST_DAMAGE_ID,
        ADMIN_USER,
        AUDIT_META,
      );
      expect(res.status).toBe('UNDER_REVIEW');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DAMAGE_STATUS_UPDATE',
          targetResource: 'DAMAGE_REPORT',
        }),
      );
    });

    it('reviewDamage throws ConflictError if damage is not REPORTED', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'APPROVED',
      });

      await expect(
        adminDamageDisputeService.reviewDamage(TEST_DAMAGE_ID, ADMIN_USER, AUDIT_META),
      ).rejects.toThrow(ConflictError);
    });

    it('assessDamage approves amount and transitions to APPROVED', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'UNDER_REVIEW',
        estimated_amount: '3000.00',
        approved_amount: null,
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDamageStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'APPROVED',
        approvedAmount: 2500.00,
      });

      const res = await adminDamageDisputeService.assessDamage(
        TEST_DAMAGE_ID,
        { approvedAmount: 2500, reason: 'Assessed per authorized workshop invoice' },
        ADMIN_USER,
        AUDIT_META,
      );

      expect(res.status).toBe('APPROVED');
      expect(res.approvedAmount).toBe(2500.00);
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DAMAGE_ASSESS',
          targetResource: 'DAMAGE_REPORT',
        }),
      );
    });

    it('assessDamage rejects negative or NaN approvedAmount', async () => {
      await expect(
        adminDamageDisputeService.assessDamage(
          TEST_DAMAGE_ID,
          { approvedAmount: -100 },
          ADMIN_USER,
          AUDIT_META,
        ),
      ).rejects.toThrow(BadRequestError);

      await expect(
        adminDamageDisputeService.assessDamage(
          TEST_DAMAGE_ID,
          { approvedAmount: 'invalid' },
          ADMIN_USER,
          AUDIT_META,
        ),
      ).rejects.toThrow(BadRequestError);
    });

    it('assessDamage rejects if damage report is already APPROVED or SETTLED', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'APPROVED',
      });

      await expect(
        adminDamageDisputeService.assessDamage(
          TEST_DAMAGE_ID,
          { approvedAmount: 2000 },
          ADMIN_USER,
          AUDIT_META,
        ),
      ).rejects.toThrow(ConflictError);
    });

    it('rejectDamage rejects damage report with mandatory reason', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'REPORTED',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDamageStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'REJECTED',
      });

      const res = await adminDamageDisputeService.rejectDamage(
        TEST_DAMAGE_ID,
        { reason: 'Pre-existing damage documented in pickup photos' },
        ADMIN_USER,
        AUDIT_META,
      );

      expect(res.status).toBe('REJECTED');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DAMAGE_REJECT',
          targetResource: 'DAMAGE_REPORT',
        }),
      );
    });

    it('rejectDamage rejects reason shorter than 3 characters', async () => {
      await expect(
        adminDamageDisputeService.rejectDamage(
          TEST_DAMAGE_ID,
          { reason: 'no' },
          ADMIN_USER,
          AUDIT_META,
        ),
      ).rejects.toThrow(BadRequestError);
    });

    it('settleDamage transitions APPROVED damage to SETTLED', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'APPROVED',
        approved_amount: '2000.00',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDamageStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDamageById').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'SETTLED',
        approvedAmount: 2000.00,
      });

      const res = await adminDamageDisputeService.settleDamage(
        TEST_DAMAGE_ID,
        { notes: 'Settlement confirmed by insurance' },
        ADMIN_USER,
        AUDIT_META,
      );

      expect(res.status).toBe('SETTLED');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DAMAGE_SETTLE',
          targetResource: 'DAMAGE_REPORT',
        }),
      );
    });

    it('settleDamage rejects if status is not APPROVED', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDamageForUpdate').mockResolvedValueOnce({
        id: TEST_DAMAGE_ID,
        status: 'REPORTED',
      });

      await expect(
        adminDamageDisputeService.settleDamage(TEST_DAMAGE_ID, {}, ADMIN_USER, AUDIT_META),
      ).rejects.toThrow(ConflictError);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. DISPUTES
  // ══════════════════════════════════════════════════════════════════════════════

  describe('2. Disputes', () => {
    it('listDisputes delegates to repository with validated parameters', async () => {
      const mockResult = { disputes: [], total: 0, page: 1, limit: 20, totalPages: 1 };
      jest.spyOn(adminDamageDisputeRepository, 'listDisputes').mockResolvedValueOnce(mockResult);

      const res = await adminDamageDisputeService.listDisputes({
        disputeId: TEST_DISPUTE_ID,
        bookingId: TEST_BOOKING_ID,
        status: 'OPEN',
      });

      expect(res).toEqual(mockResult);
      expect(adminDamageDisputeRepository.listDisputes).toHaveBeenCalledWith(
        expect.objectContaining({
          disputeId: TEST_DISPUTE_ID,
          bookingId: TEST_BOOKING_ID,
          status: 'OPEN',
        }),
      );
    });

    it('getDisputeById returns dispute details', async () => {
      const mockDispute = { id: TEST_DISPUTE_ID, status: 'OPEN', disputeNumber: 'DSP-101' };
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce(mockDispute);

      const res = await adminDamageDisputeService.getDisputeById(TEST_DISPUTE_ID);
      expect(res.disputeNumber).toBe('DSP-101');
    });

    it('getDisputeById throws NotFoundError when dispute not found', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce(null);

      await expect(
        adminDamageDisputeService.getDisputeById(TEST_DISPUTE_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('getDisputeEvidence returns signed evidence URLs', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        disputeNumber: 'DSP-101',
        evidence: ['disputes/doc1.pdf'],
      });

      jest.spyOn(s3Provider, 'createPresignedGetUrl').mockResolvedValueOnce({
        downloadUrl: 'https://s3.aws.com/signed-doc1.pdf',
      });

      const res = await adminDamageDisputeService.getDisputeEvidence(TEST_DISPUTE_ID);
      expect(res.evidence).toHaveLength(1);
      expect(res.evidence[0].downloadUrl).toBe('https://s3.aws.com/signed-doc1.pdf');
    });

    it('getDisputeTimeline returns lifecycle milestones and audit actions', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        disputeNumber: 'DSP-101',
        status: 'RESOLVED',
        priority: 'HIGH',
        createdAt: new Date('2026-03-01T10:00:00Z'),
        assignedAt: new Date('2026-03-02T10:00:00Z'),
        resolvedAt: new Date('2026-03-03T10:00:00Z'),
        claimant: { name: 'Alice Customer' },
        assignedAdmin: { name: 'Support Admin' },
        resolver: { name: 'Senior Resolver' },
        resolution: 'Full refund processed',
      });

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeTimeline').mockResolvedValueOnce([
        { action: 'DISPUTE_ASSIGN', created_at: new Date('2026-03-02T10:00:00Z') },
        { action: 'DISPUTE_RESOLVE', created_at: new Date('2026-03-03T10:00:00Z') },
      ]);

      const res = await adminDamageDisputeService.getDisputeTimeline(TEST_DISPUTE_ID);
      expect(res.milestones).toHaveLength(3);
      expect(res.milestones[0].milestone).toBe('CREATED');
      expect(res.milestones[1].milestone).toBe('ASSIGNED');
      expect(res.milestones[2].milestone).toBe('RESOLVED');
      expect(res.auditEvents).toHaveLength(2);
    });

    it('assignDispute validates target admin, assigns dispute, and audits', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getActiveAdminUser').mockResolvedValueOnce({
        id: TEST_ADMIN_ID,
        role: 'ADMIN',
        is_active: true,
        name: 'Target Admin',
      });

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'OPEN',
        assigned_to: null,
      });

      jest.spyOn(adminDamageDisputeRepository, 'assignDispute').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'UNDER_INVESTIGATION',
        assignedTo: TEST_ADMIN_ID,
      });

      const res = await adminDamageDisputeService.assignDispute(
        TEST_DISPUTE_ID,
        { adminUserId: TEST_ADMIN_ID, reason: 'Assigned to tier 2 support' },
        ADMIN_USER,
        AUDIT_META,
      );

      expect(res.assignedTo).toBe(TEST_ADMIN_ID);
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DISPUTE_ASSIGN',
          targetResource: 'DISPUTE',
        }),
      );
    });

    it('assignDispute rejects non-admin or inactive assignee', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getActiveAdminUser').mockResolvedValueOnce({
        id: TEST_CUSTOMER_ID,
        role: 'CUSTOMER',
        is_active: true,
        name: 'Regular Customer',
      });

      await expect(
        adminDamageDisputeService.assignDispute(
          TEST_DISPUTE_ID,
          { adminUserId: TEST_CUSTOMER_ID },
          ADMIN_USER,
          AUDIT_META,
        ),
      ).rejects.toThrow(ForbiddenError);
    });

    it('assignDispute rejects if dispute is already in terminal state', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getActiveAdminUser').mockResolvedValueOnce({
        id: TEST_ADMIN_ID,
        role: 'ADMIN',
        is_active: true,
      });

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'RESOLVED',
      });

      await expect(
        adminDamageDisputeService.assignDispute(
          TEST_DISPUTE_ID,
          { adminUserId: TEST_ADMIN_ID },
          ADMIN_USER,
          AUDIT_META,
        ),
      ).rejects.toThrow(ConflictError);
    });

    it('resolveDispute resolves dispute without financial consequence', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'UNDER_INVESTIGATION',
        dispute_number: 'DSP-101',
      });

      jest.spyOn(adminDamageDisputeRepository, 'updateDisputeStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'RESOLVED',
        resolution: 'Dispute closed mutually',
      });

      const res = await adminDamageDisputeService.resolveDispute(
        TEST_DISPUTE_ID,
        {
          resolution: 'Dispute closed mutually',
          resolutionReason: 'Both parties agreed on mutual understanding',
          financialAction: 'NONE',
        },
        ADMIN_USER,
        AUDIT_META,
      );

      expect(res.status).toBe('RESOLVED');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DISPUTE_RESOLVE',
          targetResource: 'DISPUTE',
        }),
      );
    });

    it('resolveDispute with REFUND_CUSTOMER triggers refund record and audits financial action', async () => {
      const mockTxClient = {
        query: jest.fn().mockResolvedValueOnce({
          rows: [{ id: TEST_PAYMENT_ID, amount: '2000.00' }],
          rowCount: 1,
        }),
      };
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb(mockTxClient),
      );

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        dispute_number: 'DSP-202',
        booking_id: TEST_BOOKING_ID,
        customer_id: TEST_CUSTOMER_ID,
        status: 'UNDER_INVESTIGATION',
      });

      jest.spyOn(adminPaymentRepository, 'getPaymentRefundsSummary').mockResolvedValueOnce({
        completedRefundAmount: 0,
        pendingRefundAmount: 0,
      });

      jest.spyOn(adminPaymentRepository, 'createRefund').mockResolvedValueOnce({
        id: 'ref-new-123',
        refundNumber: 'REF-DSP-12345',
        refundedAmount: 1500.00,
      });

      jest.spyOn(adminDamageDisputeRepository, 'updateDisputeStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'RESOLVED',
        settledAmount: 1500.00,
        financialAction: 'REFUND_CUSTOMER',
      });

      const res = await adminDamageDisputeService.resolveDispute(
        TEST_DISPUTE_ID,
        {
          resolution: 'Refund granted to customer',
          resolutionReason: 'Cancellation fee waived due to medical emergency',
          settledAmount: 1500.00,
          financialAction: 'REFUND_CUSTOMER',
        },
        ADMIN_USER,
        AUDIT_META,
      );

      expect(res.status).toBe('RESOLVED');
      expect(adminPaymentRepository.createRefund).toHaveBeenCalledTimes(1);
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DISPUTE_FINANCIAL_ACTION',
          metadata: expect.objectContaining({ financialAction: 'REFUND_CUSTOMER' }),
        }),
      );
    });

    it('resolveDispute with ADJUST_WALLET updates wallet balances and records transaction', async () => {
      const mockTxClient = { query: jest.fn() };
      jest.spyOn(adminDamageDisputeRepository, 'executeInTransaction').mockImplementation(
        async (cb) => cb(mockTxClient),
      );

      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        dispute_number: 'DSP-303',
        partner_id: TEST_PARTNER_ID,
        status: 'UNDER_INVESTIGATION',
      });

      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValueOnce({
        id: TEST_WALLET_ID,
        available_balance: '5000.00',
        total_debited: '1000.00',
      });

      jest.spyOn(adminWalletRepository, 'adjustAvailableBalance').mockResolvedValueOnce();
      jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockResolvedValueOnce({
        id: 'txn-adj-1',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDisputeStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'RESOLVED',
        financialAction: 'ADJUST_WALLET',
      });

      const res = await adminDamageDisputeService.resolveDispute(
        TEST_DISPUTE_ID,
        {
          resolution: 'Damage recovery debited from partner wallet',
          resolutionReason: 'Partner accepted liability for repair costs',
          settledAmount: 1200.00,
          financialAction: 'ADJUST_WALLET',
        },
        ADMIN_USER,
        AUDIT_META,
      );

      expect(res.financialAction).toBe('ADJUST_WALLET');
      // Wallet row is locked with the repository's (client, partnerId) signature
      expect(adminWalletRepository.getWalletByPartnerIdForUpdate).toHaveBeenCalledWith(
        mockTxClient,
        expect.any(String),
      );
      // Debited once via wallets (+ mirror copy) and recorded as an admin_adjustment ledger
      // row, which the live CHECKs accept and Partner's recalculation includes (5000 -> 3800)
      expect(adminWalletRepository.adjustAvailableBalance).toHaveBeenCalledWith(
        mockTxClient,
        expect.any(String),
        -1200,
      );
      expect(adminWalletRepository.createWalletTransaction).toHaveBeenCalledWith(
        mockTxClient,
        expect.objectContaining({
          transactionType: 'ADMIN_ADJUSTMENT',
          direction: 'DEBIT',
          amount: 1200,
          balanceBefore: 5000,
          balanceAfter: 3800,
          referenceType: 'ADMIN',
          referenceId: TEST_DISPUTE_ID,
        }),
      );
    });

    it('resolveDispute prevents double resolution on already resolved dispute', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'RESOLVED',
      });

      await expect(
        adminDamageDisputeService.resolveDispute(
          TEST_DISPUTE_ID,
          {
            resolution: 'Second resolution attempt',
            resolutionReason: 'Valid reason string here',
          },
          ADMIN_USER,
          AUDIT_META,
        ),
      ).rejects.toThrow(ConflictError);
    });

    it('rejectDispute rejects dispute with mandatory reason and audits', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'OPEN',
      });
      jest.spyOn(adminDamageDisputeRepository, 'updateDisputeStatus').mockResolvedValueOnce({});
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'REJECTED',
      });

      const res = await adminDamageDisputeService.rejectDispute(
        TEST_DISPUTE_ID,
        { rejectionReason: 'Dispute lacks verifiable evidence or invoice' },
        ADMIN_USER,
        AUDIT_META,
      );

      expect(res.status).toBe('REJECTED');
      expect(auditService.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DISPUTE_REJECT',
          targetResource: 'DISPUTE',
        }),
      );
    });

    it('rejectDispute prevents rejecting already terminal dispute', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeForUpdate').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'REJECTED',
      });

      await expect(
        adminDamageDisputeService.rejectDispute(
          TEST_DISPUTE_ID,
          { rejectionReason: 'Cannot reject twice' },
          ADMIN_USER,
          AUDIT_META,
        ),
      ).rejects.toThrow(ConflictError);
    });

    it('createDispute creates a new dispute and audits', async () => {
      jest.spyOn(adminDamageDisputeRepository, 'createDispute').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
      });
      jest.spyOn(adminDamageDisputeRepository, 'getDisputeById').mockResolvedValueOnce({
        id: TEST_DISPUTE_ID,
        status: 'OPEN',
      });

      const res = await adminDamageDisputeService.createDispute(
        {
          bookingId: TEST_BOOKING_ID,
          customerId: TEST_CUSTOMER_ID,
          partnerId: TEST_PARTNER_ID,
          claimantId: TEST_CUSTOMER_ID,
          description: 'Customer claims unfair cleaning fee charge',
        },
        ADMIN_USER,
        AUDIT_META,
      );

      expect(res.id).toBe(TEST_DISPUTE_ID);
      expect(auditService.logAdminAction).toHaveBeenCalledTimes(1);
    });
  });
});
