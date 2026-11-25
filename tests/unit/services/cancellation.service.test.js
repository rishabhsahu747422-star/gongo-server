'use strict';

const cancellationService = require('../../../src/services/cancellation.service');
const { CancellationService } = cancellationService;

describe('CancellationService - Security Deposit Exclusion & Refund Calculations', () => {
  const baseTime = new Date('2026-10-10T12:00:00.000Z');

  describe('Pure Policy Calculation (Test Scenarios A to E & Edge Cases)', () => {
    // TEST A: Online payment = ₹1000, Security deposit = ₹500, Policy = 0%
    // Expected refund: ₹0 (NOT ₹500, NOT ₹1000, NOT ₹1500)
    it('TEST A: 0% refund window excludes security deposit and yields ₹0 refund', () => {
      // 2 hours before pickup for BIKE -> 0% refund
      const pickupTime = new Date(baseTime.getTime() + 2 * 60 * 60 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: baseTime,
        vehicleCategory: 'BIKE',
        originalPaidAmount: 1000,
        securityDeposit: 500,
      });

      expect(res.refundPercentage).toBe(0);
      expect(res.refundAmount).toBe(0);
      expect(res.securityDeposit).toBe(500);
      expect(res.securityDepositRefundable).toBe(false);
      expect(res.isRefundable).toBe(false);
    });

    // TEST B: Online payment = ₹1000, Security deposit = ₹500, Policy = 50%
    // Expected refund: ₹500 (NOT ₹750)
    it('TEST B: 50% refund window applies strictly to online payment, excluding security deposit', () => {
      // 8 hours before pickup for BIKE -> 50% refund
      const pickupTime = new Date(baseTime.getTime() + 8 * 60 * 60 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: baseTime,
        vehicleCategory: 'BIKE',
        originalPaidAmount: 1000,
        securityDeposit: 500,
      });

      expect(res.refundPercentage).toBe(50);
      expect(res.refundAmount).toBe(500); // 1000 * 50% = 500 (NOT 750)
      expect(res.securityDeposit).toBe(500);
      expect(res.securityDepositRefundable).toBe(false);
      expect(res.isRefundable).toBe(true);
    });

    // TEST C: Online payment = ₹1000, Security deposit = ₹500, Policy = 100%
    // Expected refund: ₹1000 (NOT ₹1500)
    it('TEST C: 100% refund window refunds strictly online payment, security deposit remains non-refundable', () => {
      // 15 hours before pickup for BIKE -> 100% refund
      const pickupTime = new Date(baseTime.getTime() + 15 * 60 * 60 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: baseTime,
        vehicleCategory: 'BIKE',
        originalPaidAmount: 1000,
        securityDeposit: 500,
      });

      expect(res.refundPercentage).toBe(100);
      expect(res.refundAmount).toBe(1000); // 1000 * 100% = 1000 (NOT 1500)
      expect(res.securityDeposit).toBe(500);
      expect(res.securityDepositRefundable).toBe(false);
      expect(res.isRefundable).toBe(true);
    });

    // TEST D: Online payment = ₹4, Security deposit = ₹1, Policy = 50%
    // Expected refund: ₹2 (NOT ₹2.50)
    it('TEST D: Micro amounts - ₹4 online payment and ₹1 security deposit at 50% yields ₹2', () => {
      const pickupTime = new Date(baseTime.getTime() + 8 * 60 * 60 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: baseTime,
        vehicleCategory: 'BIKE',
        originalPaidAmount: 4,
        securityDeposit: 1,
      });

      expect(res.refundPercentage).toBe(50);
      expect(res.refundAmount).toBe(2); // 4 * 50% = 2 (NOT 2.5)
      expect(res.securityDeposit).toBe(1);
      expect(res.securityDepositRefundable).toBe(false);
      expect(res.isRefundable).toBe(true);
    });

    // TEST E: Online payment = ₹4, Security deposit = ₹1, Policy = 100%
    // Expected refund: ₹4 (NOT ₹5)
    it('TEST E: Micro amounts - ₹4 online payment and ₹1 security deposit at 100% yields ₹4', () => {
      const pickupTime = new Date(baseTime.getTime() + 15 * 60 * 60 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: baseTime,
        vehicleCategory: 'BIKE',
        originalPaidAmount: 4,
        securityDeposit: 1,
      });

      expect(res.refundPercentage).toBe(100);
      expect(res.refundAmount).toBe(4); // 4 * 100% = 4 (NOT 5)
      expect(res.securityDeposit).toBe(1);
      expect(res.securityDepositRefundable).toBe(false);
      expect(res.isRefundable).toBe(true);
    });

    // IMPORTANT EDGE CASE: If online booking payment is ₹0 and security deposit is ₹500
    // Cancellation refund must be ₹0. Security deposit must NOT become refundable.
    it('EDGE CASE: Zero online booking payment with ₹500 security deposit yields ₹0 refund at 100% tier', () => {
      const pickupTime = new Date(baseTime.getTime() + 25 * 60 * 60 * 1000);
      const res = CancellationService.calculatePolicy({
        pickupTime,
        serverTime: baseTime,
        vehicleCategory: 'CAR',
        originalPaidAmount: 0,
        securityDeposit: 500,
      });

      expect(res.refundPercentage).toBe(100);
      expect(res.refundAmount).toBe(0);
      expect(res.securityDeposit).toBe(500);
      expect(res.securityDepositRefundable).toBe(false);
      expect(res.isRefundable).toBe(false);
    });
  });

  describe('determinePaidAmount method', () => {
    it('prefers booking subtotal (online payment amount) excluding security deposit', async () => {
      const mockBooking = {
        id: 'b-1',
        subtotal: 1000,
        total_amount: 1500,
        security_deposit: 500,
        status: 'CONFIRMED',
      };

      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{ id: 'pay-1', amount: 1500, payment_type: 'BOOKING_ADVANCE' }],
        }),
      };

      const service = new CancellationService();
      // Even if payments table has legacy totalAmount = 1500, it clamps to subtotal = 1000
      const paid = await service.determinePaidAmount(mockBooking, mockClient);
      expect(paid.amount).toBe(1000);
      expect(paid.paymentId).toBe('pay-1');
    });

    it('returns exact payment amount if payment was for subtotal', async () => {
      const mockBooking = {
        id: 'b-2',
        subtotal: 4,
        total_amount: 5,
        security_deposit: 1,
        status: 'CONFIRMED',
      };

      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{ id: 'pay-2', amount: 4, payment_type: 'BOOKING_ADVANCE' }],
        }),
      };

      const service = new CancellationService();
      const paid = await service.determinePaidAmount(mockBooking, mockClient);
      expect(paid.amount).toBe(4);
      expect(paid.paymentId).toBe('pay-2');
    });

    it('falls back to subtotal for confirmed booking if no payment row exists yet', async () => {
      const mockBooking = {
        id: 'b-3',
        subtotal: 4,
        total_amount: 5,
        security_deposit: 1,
        status: 'CONFIRMED',
      };

      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
      };

      const service = new CancellationService();
      const paid = await service.determinePaidAmount(mockBooking, mockClient);
      expect(paid.amount).toBe(4); // Excludes ₹1 security deposit
    });
  });
});
