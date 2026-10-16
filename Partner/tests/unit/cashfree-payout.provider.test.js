'use strict';

const crypto = require('crypto');
const cashfreePayoutProvider = require('../../src/providers/cashfree-payout.provider');
const { ServiceUnavailableError, BadRequestError } = require('../../src/errors');

describe('Unit: CashfreePayoutProvider (Payouts v2)', () => {
  const secretKey = 'TEST_CASHFREE_SECRET_KEY_1234567890';
  const originalSecret = cashfreePayoutProvider.secretKey;

  beforeAll(() => {
    cashfreePayoutProvider.secretKey = secretKey;
  });

  afterAll(() => {
    cashfreePayoutProvider.secretKey = originalSecret;
    cashfreePayoutProvider.resetMockDelegate();
  });

  afterEach(() => {
    cashfreePayoutProvider.resetMockDelegate();
  });

  describe('verifyWebhookSignature', () => {
    function generateValidSignature(timestamp, rawBody, key = secretKey) {
      const dataToSign = `${timestamp}${rawBody}`;
      return crypto.createHmac('sha256', key).update(dataToSign).digest('base64');
    }

    it('validates a correct HMAC-SHA256 signature and fresh timestamp', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({
        event: 'TRANSFER_SUCCESS',
        data: { transfer_id: 'cf_tr_123', status: 'SUCCESS' },
      });
      const signature = generateValidSignature(nowSec, rawBody);

      const isValid = cashfreePayoutProvider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(nowSec),
          'x-webhook-signature': signature,
        },
        rawBody,
      );

      expect(isValid).toBe(true);
    });

    it('rejects signature when raw body has been tampered with', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const originalBody = JSON.stringify({ amount: 500 });
      const tamperedBody = JSON.stringify({ amount: 100 });
      const signature = generateValidSignature(nowSec, originalBody);

      const isValid = cashfreePayoutProvider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(nowSec),
          'x-webhook-signature': signature,
        },
        tamperedBody,
      );

      expect(isValid).toBe(false);
    });

    it('rejects signature signed with an incorrect secret key', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({ amount: 500 });
      const invalidSignature = generateValidSignature(nowSec, rawBody, 'WRONG_SECRET');

      const isValid = cashfreePayoutProvider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(nowSec),
          'x-webhook-signature': invalidSignature,
        },
        rawBody,
      );

      expect(isValid).toBe(false);
    });

    it('rejects timestamp outside acceptable clock skew window (> 600s in past)', () => {
      const pastSec = Math.floor(Date.now() / 1000) - 700;
      const rawBody = JSON.stringify({ amount: 500 });
      const signature = generateValidSignature(pastSec, rawBody);

      const isValid = cashfreePayoutProvider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(pastSec),
          'x-webhook-signature': signature,
        },
        rawBody,
      );

      expect(isValid).toBe(false);
    });

    it('rejects timestamp outside acceptable clock skew window (> 300s in future)', () => {
      const futureSec = Math.floor(Date.now() / 1000) + 400;
      const rawBody = JSON.stringify({ amount: 500 });
      const signature = generateValidSignature(futureSec, rawBody);

      const isValid = cashfreePayoutProvider.verifyWebhookSignature(
        {
          'x-webhook-timestamp': String(futureSec),
          'x-webhook-signature': signature,
        },
        rawBody,
      );

      expect(isValid).toBe(false);
    });

    it('returns false if headers or rawBody are missing or non-string', () => {
      expect(cashfreePayoutProvider.verifyWebhookSignature(null, '{}')).toBe(false);
      expect(cashfreePayoutProvider.verifyWebhookSignature({}, null)).toBe(false);
      expect(cashfreePayoutProvider.verifyWebhookSignature({}, {})).toBe(false);
      expect(cashfreePayoutProvider.verifyWebhookSignature({}, '')).toBe(false);
    });
  });

  describe('Beneficiary Management with mockDelegate', () => {
    it('creates beneficiary via mockDelegate', async () => {
      cashfreePayoutProvider.setMockDelegate({
        createBeneficiary: jest.fn().mockResolvedValue({
          beneficiaryId: 'BENE_123',
          status: 'CREATED',
        }),
      });

      const res = await cashfreePayoutProvider.createBeneficiary({
        beneficiaryId: 'BENE_123',
        beneficiaryName: 'Rishabh Partner',
        accountNumber: '123456789012',
        ifscCode: 'HDFC0001234',
      });

      expect(res.beneficiaryId).toBe('BENE_123');
      expect(res.status).toBe('CREATED');
    });

    it('retrieves beneficiary via mockDelegate', async () => {
      cashfreePayoutProvider.setMockDelegate({
        getBeneficiary: jest.fn().mockResolvedValue({
          beneficiary_id: 'BENE_123',
          beneficiary_name: 'Rishabh Partner',
        }),
      });

      const res = await cashfreePayoutProvider.getBeneficiary('BENE_123');
      expect(res.beneficiary_id).toBe('BENE_123');
    });
  });

  describe('Transfer Operations with mockDelegate', () => {
    it('initiates transfer via mockDelegate', async () => {
      cashfreePayoutProvider.setMockDelegate({
        initiateTransfer: jest.fn().mockResolvedValue({
          transferId: 'PO-TEST-1',
          cfTransferId: 'CF-TR-999',
          status: 'RECEIVED',
          statusDescription: 'Transfer received by Cashfree',
        }),
      });

      const res = await cashfreePayoutProvider.initiateTransfer({
        transferId: 'PO-TEST-1',
        amount: 500,
        beneficiaryId: 'BENE_123',
      });

      expect(res.transferId).toBe('PO-TEST-1');
      expect(res.cfTransferId).toBe('CF-TR-999');
      expect(res.status).toBe('RECEIVED');
    });

    it('retrieves transfer status via mockDelegate', async () => {
      cashfreePayoutProvider.setMockDelegate({
        getTransferStatus: jest.fn().mockResolvedValue({
          transferId: 'PO-TEST-1',
          cfTransferId: 'CF-TR-999',
          status: 'SUCCESS',
          utr: 'UTR123456789',
        }),
      });

      const res = await cashfreePayoutProvider.getTransferStatus('PO-TEST-1');
      expect(res.transferId).toBe('PO-TEST-1');
      expect(res.status).toBe('SUCCESS');
      expect(res.utr).toBe('UTR123456789');
    });

    it('propagates ServiceUnavailableError on network failure', async () => {
      cashfreePayoutProvider.setMockDelegate({
        initiateTransfer: jest.fn().mockRejectedValue(
          new ServiceUnavailableError('Payout gateway temporarily unreachable'),
        ),
      });

      await expect(
        cashfreePayoutProvider.initiateTransfer({
          transferId: 'PO-TEST-FAIL',
          amount: 500,
          beneficiaryId: 'BENE_123',
        }),
      ).rejects.toThrow(ServiceUnavailableError);
    });

    it('propagates BadRequestError on provider validation rejection', async () => {
      cashfreePayoutProvider.setMockDelegate({
        initiateTransfer: jest.fn().mockRejectedValue(
          new BadRequestError('Beneficiary bank account inactive'),
        ),
      });

      await expect(
        cashfreePayoutProvider.initiateTransfer({
          transferId: 'PO-TEST-REJECT',
          amount: 500,
          beneficiaryId: 'BENE_123',
        }),
      ).rejects.toThrow(BadRequestError);
    });
  });
});
