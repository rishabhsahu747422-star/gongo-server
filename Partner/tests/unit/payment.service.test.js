'use strict';

const PaymentService = require('../../src/services/payment.service');
const {
  PAYMENT_STATUS,
  PAYMENT_TYPE,
  SETTLEMENT_STATUS,
} = require('../../src/constants/payment');
const { NotFoundError, BadRequestError } = require('../../src/errors');

const { pool } = require('../../src/db/pool');

describe('Unit: PaymentService', () => {
  let mockBookingRepo;
  let mockPaymentRepo;
  let mockCashfreeProvider;
  let mockWalletRepo;
  let mockWalletTxRepo;
  let mockEarningsRepo;
  let mockPayoutRepo;
  let mockNotificationRepo;
  let mockClient;
  let paymentService;

  const partnerId = '11111111-1111-4111-a111-111111111111';
  const bookingId = '22222222-2222-4222-a222-222222222222';

  beforeEach(() => {
    mockBookingRepo = {
      findPartnerBookingById: jest.fn(),
      findReturnVerificationByBookingId: jest.fn(),
      findDamageReportsByBookingId: jest.fn(),
    };

    mockClient = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: bookingId, partner_id: partnerId, booking_number: 'BK-100' }],
      }),
      release: jest.fn(),
    };

    jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);

    mockPaymentRepo = {
      findLatestByBookingAndType: jest.fn(),
      findAllByBookingId: jest.fn(),
      isEventProcessed: jest.fn(),
      lockByProviderOrderId: jest.fn(),
      recordEvent: jest.fn(),
      updateStatus: jest.fn(),
      withTransaction: jest.fn((callback) => callback(mockClient)),
    };

    mockCashfreeProvider = {
      verifyWebhookSignature: jest.fn(),
    };

    mockWalletRepo = {
      findByPartnerId: jest.fn(),
      findByPartnerIdForUpdate: jest.fn(),
      createWallet: jest.fn(),
      updateBalances: jest.fn(),
      creditWallet: jest.fn().mockResolvedValue({
        wallet: {
          id: 'wal-01',
          partner_id: partnerId,
          available_balance: '1350.00',
          total_credited: '1350.00',
        },
        previousAvailable: 1000.00,
        newAvailable: 1350.00,
        creditAmount: 350.00,
      }),
      reverseDebitWallet: jest.fn(),
    };

    mockWalletTxRepo = {
      createLedgerEntry: jest.fn().mockResolvedValue({ id: 'tx-01' }),
      findByReference: jest.fn().mockResolvedValue(null),
    };

    mockEarningsRepo = {
      recordBookingEarning: jest.fn(),
    };

    mockPayoutRepo = {
      findByTransferOrReferenceIdForUpdate: jest.fn(),
      updateStatus: jest.fn(),
    };

    mockNotificationRepo = {
      createNotification: jest.fn(),
    };

    // Instantiate with mock dependencies
    paymentService = new PaymentService.constructor(
      mockBookingRepo,
      mockPaymentRepo,
      mockCashfreeProvider,
      mockWalletRepo,
      mockWalletTxRepo,
      mockEarningsRepo,
      mockPayoutRepo,
      mockNotificationRepo,
    );
  });

  describe('getSettlementDetails', () => {
    it('throws NotFoundError if booking does not exist or BOLA ownership fails', async () => {
      mockBookingRepo.findPartnerBookingById.mockResolvedValue(null);

      await expect(paymentService.getSettlementDetails(partnerId, bookingId)).rejects.toThrow(
        NotFoundError,
      );
      expect(mockBookingRepo.findPartnerBookingById).toHaveBeenCalledWith(partnerId, bookingId);
    });

    it('returns NO_CHARGE when returned on-time with zero fees', async () => {
      mockBookingRepo.findPartnerBookingById.mockResolvedValue({
        id: bookingId,
        booking_number: 'BK-101',
        vehicle_id: 'veh-1',
        registration_number: 'KA01AB1234',
      });
      mockBookingRepo.findReturnVerificationByBookingId.mockResolvedValue({
        returned_at: '2026-09-25T10:00:00.000Z',
        odometer_end: '1250.00',
        late_minutes: 0,
        late_fee: '0.00',
        extra_km: '0.00',
        extra_km_fee: '0.00',
        return_status: 'ON_TIME',
      });
      mockBookingRepo.findDamageReportsByBookingId.mockResolvedValue([]);
      mockPaymentRepo.findLatestByBookingAndType.mockResolvedValue(null);

      const result = await paymentService.getSettlementDetails(partnerId, bookingId);

      expect(result.settlementStatus).toBe(SETTLEMENT_STATUS.NO_CHARGE);
      expect(result.charges.lateFee).toBe(0);
      expect(result.charges.extraKmFee).toBe(0);
      expect(result.charges.totalSettlementPayable).toBe(0);
      expect(result.damageReports).toHaveLength(0);
    });

    it('calculates totalSettlementPayable strictly from late_fee + extra_km_fee, excluding damage estimates', async () => {
      mockBookingRepo.findPartnerBookingById.mockResolvedValue({
        id: bookingId,
        booking_number: 'BK-102',
        vehicle_id: 'veh-1',
        registration_number: 'KA01AB1234',
      });
      mockBookingRepo.findReturnVerificationByBookingId.mockResolvedValue({
        returned_at: '2026-09-25T12:00:00.000Z',
        odometer_end: '1350.00',
        late_minutes: 75,
        late_fee: '280.00',
        extra_km: '20.00',
        extra_km_fee: '300.00',
        return_status: 'LATE',
      });
      // Partner reported damage with estimatedAmount 5000.00
      mockBookingRepo.findDamageReportsByBookingId.mockResolvedValue([
        {
          id: 'dmg-1',
          damage_type: 'SCRATCH',
          description: 'Deep scratch on rear fender',
          estimated_amount: '5000.00',
          status: 'REPORTED',
        },
      ]);
      mockPaymentRepo.findLatestByBookingAndType.mockResolvedValue(null);

      const result = await paymentService.getSettlementDetails(partnerId, bookingId);

      // Expected payable is ONLY 280.00 + 300.00 = 580.00.
      // The 5000.00 damage estimate MUST NOT be added!
      expect(result.charges.lateFee).toBe(280.00);
      expect(result.charges.extraKmFee).toBe(300.00);
      expect(result.charges.approvedDamageFee).toBe(0.00);
      expect(result.charges.totalSettlementPayable).toBe(580.00);
      expect(result.settlementStatus).toBe(SETTLEMENT_STATUS.UNPAID);

      // Verify damage report metadata
      expect(result.damageReports).toHaveLength(1);
      expect(result.damageReports[0].estimatedAmount).toBe(5000.00);
      expect(result.damageReports[0].action).toBe('DEFERRED_APPROVAL');
    });

    it('reports settlementStatus as PAID when post-rental settlement payment is SUCCESS', async () => {
      mockBookingRepo.findPartnerBookingById.mockResolvedValue({
        id: bookingId,
        booking_number: 'BK-103',
      });
      mockBookingRepo.findReturnVerificationByBookingId.mockResolvedValue({
        late_fee: '150.00',
        extra_km_fee: '0.00',
      });
      mockBookingRepo.findDamageReportsByBookingId.mockResolvedValue([]);
      mockPaymentRepo.findLatestByBookingAndType.mockResolvedValue({
        id: 'pay-1',
        payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        amount: '150.00',
        currency: 'INR',
        status: PAYMENT_STATUS.SUCCESS,
        provider_order_id: 'cf_settle_103',
      });

      const result = await paymentService.getSettlementDetails(partnerId, bookingId);

      expect(result.settlementStatus).toBe(SETTLEMENT_STATUS.PAID);
      expect(result.payment.status).toBe(PAYMENT_STATUS.SUCCESS);
      expect(result.charges.totalSettlementPayable).toBe(150.00);
    });

    it('reports settlementStatus as PAYMENT_PENDING when post-rental payment is PENDING', async () => {
      mockBookingRepo.findPartnerBookingById.mockResolvedValue({
        id: bookingId,
        booking_number: 'BK-104',
      });
      mockBookingRepo.findReturnVerificationByBookingId.mockResolvedValue({
        late_fee: '150.00',
        extra_km_fee: '0.00',
      });
      mockBookingRepo.findDamageReportsByBookingId.mockResolvedValue([]);
      mockPaymentRepo.findLatestByBookingAndType.mockResolvedValue({
        id: 'pay-2',
        payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        amount: '150.00',
        currency: 'INR',
        status: PAYMENT_STATUS.PENDING,
        provider_order_id: 'cf_settle_104',
      });

      const result = await paymentService.getSettlementDetails(partnerId, bookingId);

      expect(result.settlementStatus).toBe(SETTLEMENT_STATUS.PAYMENT_PENDING);
    });
  });

  describe('getBookingPayments', () => {
    it('throws NotFoundError if booking does not exist or BOLA ownership fails', async () => {
      mockBookingRepo.findPartnerBookingById.mockResolvedValue(null);

      await expect(paymentService.getBookingPayments(partnerId, bookingId)).rejects.toThrow(
        NotFoundError,
      );
    });

    it('returns chronological payments array for partner booking', async () => {
      mockBookingRepo.findPartnerBookingById.mockResolvedValue({
        id: bookingId,
        booking_number: 'BK-105',
      });
      mockPaymentRepo.findAllByBookingId.mockResolvedValue([
        {
          id: 'pay-adv',
          payment_type: PAYMENT_TYPE.BOOKING_ADVANCE,
          provider: 'CASHFREE',
          provider_order_id: 'cf_adv_01',
          amount: '2000.00',
          currency: 'INR',
          status: PAYMENT_STATUS.SUCCESS,
          created_at: '2026-09-20T10:00:00.000Z',
        },
        {
          id: 'pay-set',
          payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
          provider: 'CASHFREE',
          provider_order_id: 'cf_set_01',
          amount: '350.00',
          currency: 'INR',
          status: PAYMENT_STATUS.SUCCESS,
          created_at: '2026-09-22T11:00:00.000Z',
        },
      ]);

      const result = await paymentService.getBookingPayments(partnerId, bookingId);

      expect(result.bookingId).toBe(bookingId);
      expect(result.totalPayments).toBe(2);
      expect(result.payments[0].paymentType).toBe(PAYMENT_TYPE.BOOKING_ADVANCE);
      expect(result.payments[0].amount).toBe(2000.00);
      expect(result.payments[1].paymentType).toBe(PAYMENT_TYPE.POST_RENTAL_SETTLEMENT);
      expect(result.payments[1].amount).toBe(350.00);
    });
  });

  describe('processCashfreeWebhook', () => {
    const validHeaders = {
      'x-webhook-timestamp': '1700000000',
      'x-webhook-signature': 'mock_sig==',
    };
    const rawBody = JSON.stringify({ data: { order: { order_id: 'cf_ord_1' } } });

    it('rejects webhook with invalid cryptographic signature', async () => {
      mockCashfreeProvider.verifyWebhookSignature.mockReturnValue(false);

      await expect(
        paymentService.processCashfreeWebhook(validHeaders, rawBody, {}),
      ).rejects.toThrow(BadRequestError);
    });

    it('safely skips already processed event (idempotency via payment_events)', async () => {
      mockCashfreeProvider.verifyWebhookSignature.mockReturnValue(true);
      mockPaymentRepo.isEventProcessed.mockResolvedValue(true);

      const payload = {
        data: {
          order: { order_id: 'cf_ord_1' },
          payment: { cf_payment_id: 'evt-123' },
        },
      };

      const result = await paymentService.processCashfreeWebhook(validHeaders, rawBody, payload);

      expect(result.processed).toBe(true);
      expect(result.duplicate).toBe(true);
      expect(mockPaymentRepo.lockByProviderOrderId).not.toHaveBeenCalled();
    });

    it('reconciles amount and throws BadRequestError on amount mismatch', async () => {
      mockCashfreeProvider.verifyWebhookSignature.mockReturnValue(true);
      mockPaymentRepo.isEventProcessed.mockResolvedValue(false);

      const lockedPayment = {
        id: 'pay-mismatch',
        amount: '500.00',
        currency: 'INR',
        status: PAYMENT_STATUS.PENDING,
      };
      mockPaymentRepo.lockByProviderOrderId.mockResolvedValue(lockedPayment);

      const payload = {
        data: {
          order: { order_id: 'cf_ord_1', order_amount: 100.00 }, // Discrepancy! Expected 500, received 100
          payment: { cf_payment_id: 'evt-456', payment_status: 'SUCCESS', payment_amount: 100.00 },
        },
      };

      await expect(
        paymentService.processCashfreeWebhook(validHeaders, rawBody, payload),
      ).rejects.toThrow(BadRequestError);

      expect(mockPaymentRepo.updateStatus).toHaveBeenCalledWith(
        'pay-mismatch',
        PAYMENT_STATUS.FAILED,
        expect.objectContaining({
          metadata: expect.objectContaining({ failureReason: 'AMOUNT_MISMATCH' }),
        }),
        expect.anything(),
      );
    });

    it('reconciles currency and throws BadRequestError on currency mismatch', async () => {
      mockCashfreeProvider.verifyWebhookSignature.mockReturnValue(true);
      mockPaymentRepo.isEventProcessed.mockResolvedValue(false);

      const lockedPayment = {
        id: 'pay-cur-mismatch',
        amount: '500.00',
        currency: 'INR',
        status: PAYMENT_STATUS.PENDING,
      };
      mockPaymentRepo.lockByProviderOrderId.mockResolvedValue(lockedPayment);

      const payload = {
        data: {
          order: { order_id: 'cf_ord_1', order_amount: 500.00 },
          payment: {
            cf_payment_id: 'evt-457',
            payment_status: 'SUCCESS',
            payment_amount: 500.00,
            payment_currency: 'USD', // Currency mismatch!
          },
        },
      };

      await expect(
        paymentService.processCashfreeWebhook(validHeaders, rawBody, payload),
      ).rejects.toThrow(BadRequestError);

      expect(mockPaymentRepo.updateStatus).toHaveBeenCalledWith(
        'pay-cur-mismatch',
        PAYMENT_STATUS.FAILED,
        expect.objectContaining({
          metadata: expect.objectContaining({ failureReason: 'CURRENCY_MISMATCH' }),
        }),
        expect.anything(),
      );
    });

    it('marks payment SUCCESS on valid successful gateway event', async () => {
      mockCashfreeProvider.verifyWebhookSignature.mockReturnValue(true);
      mockPaymentRepo.isEventProcessed.mockResolvedValue(false);

      const lockedPayment = {
        id: 'pay-success',
        booking_id: bookingId,
        payment_type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        amount: '350.00',
        currency: 'INR',
        status: PAYMENT_STATUS.PENDING,
      };
      mockPaymentRepo.lockByProviderOrderId.mockResolvedValue(lockedPayment);

      const payload = {
        data: {
          order: { order_id: 'cf_ord_succ', order_amount: 350.00 },
          payment: {
            cf_payment_id: 'cf_pay_999',
            payment_status: 'SUCCESS',
            payment_amount: 350.00,
            payment_currency: 'INR',
          },
        },
      };

      const result = await paymentService.processCashfreeWebhook(validHeaders, rawBody, payload);

      expect(result.processed).toBe(true);
      expect(result.status).toBe(PAYMENT_STATUS.SUCCESS);
      expect(mockPaymentRepo.updateStatus).toHaveBeenCalledWith(
        'pay-success',
        PAYMENT_STATUS.SUCCESS,
        expect.objectContaining({ providerPaymentId: 'cf_pay_999' }),
        expect.anything(),
      );
    });
  });

  describe('processCashfreePayoutWebhook', () => {
    const validHeaders = { 'x-webhook-timestamp': '1700000000', 'x-webhook-signature': 'valid_sig' };
    const rawBody = '{"event":"TRANSFER_SUCCESS"}';

    it('throws BadRequestError on invalid HMAC signature', async () => {
      mockCashfreeProvider.verifyWebhookSignature.mockReturnValue(false);

      await expect(
        paymentService.processCashfreePayoutWebhook({
          headers: validHeaders,
          rawBody,
          payload: { event: 'TRANSFER_SUCCESS' },
        }),
      ).rejects.toThrow(BadRequestError);
    });

    it('returns duplicate: true when event was already processed', async () => {
      mockCashfreeProvider.verifyWebhookSignature.mockReturnValue(true);
      mockPaymentRepo.isEventProcessed.mockResolvedValue(true);

      const res = await paymentService.processCashfreePayoutWebhook({
        headers: validHeaders,
        rawBody,
        payload: { event: 'TRANSFER_SUCCESS', event_id: 'evt_123' },
      });

      expect(res.processed).toBe(true);
      expect(res.duplicate).toBe(true);
    });

    it('marks payout COMPLETED and notifies partner on TRANSFER_SUCCESS', async () => {
      mockCashfreeProvider.verifyWebhookSignature.mockReturnValue(true);
      mockPaymentRepo.isEventProcessed.mockResolvedValue(false);
      mockPaymentRepo.recordEvent.mockResolvedValue({});
      mockPayoutRepo.findByTransferOrReferenceIdForUpdate.mockResolvedValue({
        id: 'payout-1',
        partner_id: partnerId,
        amount: '500.00',
        status: 'PROCESSING',
      });
      mockPayoutRepo.updateStatus.mockResolvedValue({});
      mockNotificationRepo.createNotification.mockResolvedValue({});

      const res = await paymentService.processCashfreePayoutWebhook({
        headers: validHeaders,
        rawBody,
        payload: {
          event: 'TRANSFER_SUCCESS',
          data: { transfer_id: 'tr_1', reference_id: 'payout-1' },
        },
      });

      expect(res.processed).toBe(true);
      expect(res.status).toBe('COMPLETED');
      expect(mockPayoutRepo.updateStatus).toHaveBeenCalledWith(
        'payout-1',
        expect.objectContaining({ status: 'COMPLETED', providerTransferId: 'tr_1' }),
        mockClient,
      );
      expect(mockNotificationRepo.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ partnerId, type: 'PAYOUT_COMPLETED' }),
      );
    });

    it('reverses debit, appends ledger entry, and marks FAILED on TRANSFER_FAILED', async () => {
      mockCashfreeProvider.verifyWebhookSignature.mockReturnValue(true);
      mockPaymentRepo.isEventProcessed.mockResolvedValue(false);
      mockPaymentRepo.recordEvent.mockResolvedValue({});
      mockPayoutRepo.findByTransferOrReferenceIdForUpdate.mockResolvedValue({
        id: 'payout-2',
        partner_id: partnerId,
        amount: '750.00',
        status: 'PROCESSING',
      });
      mockWalletRepo.reverseDebitWallet.mockResolvedValue({
        wallet: { id: 'wal-01' },
        newAvailable: 1750.00,
      });
      mockWalletTxRepo.createLedgerEntry.mockResolvedValue({});
      mockPayoutRepo.updateStatus.mockResolvedValue({});
      mockNotificationRepo.createNotification.mockResolvedValue({});

      const res = await paymentService.processCashfreePayoutWebhook({
        headers: validHeaders,
        rawBody,
        payload: {
          event: 'TRANSFER_FAILED',
          data: {
            transfer_id: 'tr_2',
            reference_id: 'payout-2',
            reason: 'Bank network failure',
          },
        },
      });

      expect(res.processed).toBe(true);
      expect(res.status).toBe('FAILED');
      expect(mockWalletRepo.reverseDebitWallet).toHaveBeenCalledWith(
        partnerId,
        750.00,
        mockClient,
      );
      expect(mockWalletTxRepo.createLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: 'PAYOUT_REVERSAL',
          direction: 'CREDIT',
          amount: 750.00,
        }),
        mockClient,
      );
      expect(mockPayoutRepo.updateStatus).toHaveBeenCalledWith(
        'payout-2',
        expect.objectContaining({ status: 'FAILED', failureReason: 'Bank network failure' }),
        mockClient,
      );
    });
  });
});
