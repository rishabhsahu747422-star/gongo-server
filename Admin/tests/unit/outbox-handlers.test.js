'use strict';

const { handleNotificationEvent } = require('../../src/jobs/handlers/notification.handler');
const { handleReconciliationEvent } = require('../../src/jobs/handlers/reconciliation.handler');
const { handleCleanupEvent } = require('../../src/jobs/handlers/cleanup.handler');
const { dispatchEvent } = require('../../src/jobs/handlers');

const adminNotificationRepository = require('../../src/repositories/admin-notification.repository');
const adminNotificationService = require('../../src/services/admin-notification.service');
const adminWalletService = require('../../src/services/admin-wallet.service');
const adminPaymentService = require('../../src/services/admin-payment.service');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminOutboxRepository = require('../../src/repositories/admin-outbox.repository');

describe('Phase 20 Unit: Outbox Event Handlers & Dispatcher', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Notification Handler', () => {
    it('throws non-retryable error when notification ID is missing', async () => {
      await expect(handleNotificationEvent({ aggregate_id: null, payload: {} })).rejects.toThrow(
        /missing aggregate_id/i,
      );
    });

    it('throws non-retryable error when notification record is not found', async () => {
      jest.spyOn(adminNotificationRepository, 'findNotificationById').mockResolvedValueOnce(null);

      await expect(
        handleNotificationEvent({ aggregate_id: 'non-existent-id', payload: {} }),
      ).rejects.toThrow(/not found/i);
    });

    it('idempotency guard: skips duplicate push send if notification already SENT', async () => {
      jest.spyOn(adminNotificationRepository, 'findNotificationById').mockResolvedValueOnce({
        id: 'notif-1',
        status: 'SENT',
      });
      const pushSpy = jest.spyOn(adminNotificationService.pushProvider, 'sendMulticast');

      const res = await handleNotificationEvent({
        id: 'outbox-1',
        aggregate_id: 'notif-1',
        payload: {},
      });

      expect(res.skipped).toBe(true);
      expect(res.reason).toBe('ALREADY_DELIVERED');
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('handles recipient with no device tokens safely without infinite retries', async () => {
      jest.spyOn(adminNotificationRepository, 'findNotificationById').mockResolvedValueOnce({
        id: 'notif-2',
        status: 'PENDING',
        channel: 'PUSH',
        recipient: { id: 'cust-1' },
        recipientType: 'CUSTOMER',
      });
      jest.spyOn(adminNotificationRepository, 'findRecipientDeviceTokens').mockResolvedValueOnce([]);
      const updateDeliverySpy = jest
        .spyOn(adminNotificationRepository, 'updateNotificationDelivery')
        .mockResolvedValueOnce({});

      const res = await handleNotificationEvent({
        id: 'outbox-2',
        aggregate_id: 'notif-2',
        payload: { recipientId: 'cust-1' },
      });

      expect(res.skipped).toBe(true);
      expect(res.reason).toBe('NO_ACTIVE_DEVICE_TOKENS');
      expect(updateDeliverySpy).toHaveBeenCalledWith('notif-2', {
        status: 'FAILED',
        failureReason: 'No active device tokens found for recipient',
      });
    });

    it('delivers push notification successfully and marks delivery as SENT', async () => {
      jest.spyOn(adminNotificationRepository, 'findNotificationById').mockResolvedValueOnce({
        id: 'notif-3',
        status: 'PENDING',
        channel: 'PUSH',
        title: 'Ride update',
        body: 'Driver is arriving',
        recipient: { id: 'cust-2' },
        recipientType: 'CUSTOMER',
      });
      jest
        .spyOn(adminNotificationRepository, 'findRecipientDeviceTokens')
        .mockResolvedValueOnce(['token-abc-123']);
      jest.spyOn(adminNotificationService.pushProvider, 'sendMulticast').mockResolvedValueOnce({
        successCount: 1,
        failureCount: 0,
        invalidTokens: [],
      });
      const updateDeliverySpy = jest
        .spyOn(adminNotificationRepository, 'updateNotificationDelivery')
        .mockResolvedValueOnce({});

      const res = await handleNotificationEvent({
        id: 'outbox-3',
        aggregate_id: 'notif-3',
        payload: { recipientId: 'cust-2' },
      });

      expect(res.success).toBe(true);
      expect(res.successCount).toBe(1);
      expect(updateDeliverySpy).toHaveBeenCalledWith(
        'notif-3',
        expect.objectContaining({ status: 'SENT' }),
      );
    });

    it('soft-deactivates stale/invalid device tokens reported by provider', async () => {
      jest.spyOn(adminNotificationRepository, 'findNotificationById').mockResolvedValueOnce({
        id: 'notif-4',
        status: 'PENDING',
        channel: 'PUSH',
        recipient: { id: 'cust-3' },
        recipientType: 'CUSTOMER',
      });
      jest
        .spyOn(adminNotificationRepository, 'findRecipientDeviceTokens')
        .mockResolvedValueOnce(['stale-token-1']);
      jest.spyOn(adminNotificationService.pushProvider, 'sendMulticast').mockResolvedValueOnce({
        successCount: 0,
        failureCount: 1,
        invalidTokens: ['stale-token-1'],
        reason: 'Token unregistered',
      });
      const deactivateSpy = jest
        .spyOn(adminNotificationRepository, 'deactivateDeviceTokens')
        .mockResolvedValueOnce(1);
      jest.spyOn(adminNotificationRepository, 'updateNotificationDelivery').mockResolvedValueOnce({});

      await expect(
        handleNotificationEvent({
          id: 'outbox-4',
          aggregate_id: 'notif-4',
          payload: { recipientId: 'cust-3' },
        }),
      ).rejects.toThrow(/Token unregistered/);

      expect(deactivateSpy).toHaveBeenCalledWith(['stale-token-1'], 'CUSTOMER');
    });
  });

  describe('2. Reconciliation Handler', () => {
    it('executes wallet reconciliation and flags discrepancies without mutating ledger', async () => {
      const mockReconciliation = {
        totalWallets: 50,
        reconciledWallets: 48,
        discrepancyCount: 2,
        hasDiscrepancy: true,
        discrepancies: [
          { walletId: 'w-1', storedBalance: 100, ledgerBalance: 80, difference: 20 },
        ],
      };
      jest.spyOn(adminWalletService, 'reconcileWallets').mockResolvedValueOnce(mockReconciliation);
      jest.spyOn(adminWalletService, 'getPayoutReconciliation').mockResolvedValueOnce({
        totalPayouts: 10,
        requestedCount: 2,
      });

      const res = await handleReconciliationEvent({
        id: 'rec-1',
        event_type: 'RECONCILIATION_RUN',
        payload: {},
      });

      expect(res.walletReconciliation.discrepancyCount).toBe(2);
      expect(res.walletReconciliation.hasDiscrepancy).toBe(true);
      expect(res.payoutSummary.totalPayouts).toBe(10);
    });

    it('executes single payment reconciliation when paymentId is provided', async () => {
      jest.spyOn(adminPaymentService, 'reconcilePayment').mockResolvedValueOnce({
        paymentId: 'pay-123',
        reconciled: true,
        status: 'SUCCESS',
      });

      const res = await handleReconciliationEvent({
        id: 'rec-2',
        event_type: 'PAYMENT_RECONCILIATION',
        payload: { paymentId: 'pay-123' },
      });

      expect(res.paymentReconcileResult.status).toBe('SUCCESS');
    });
  });

  describe('3. Cleanup Handler', () => {
    it('purges expired sessions and old processed outbox records', async () => {
      jest.spyOn(adminSessionRepository, 'cleanupExpiredSessions').mockResolvedValueOnce(15);
      jest.spyOn(adminOutboxRepository, 'cleanupProcessedEvents').mockResolvedValueOnce(85);

      const res = await handleCleanupEvent({
        id: 'clean-1',
        payload: { retentionDays: 30 },
      });

      expect(res.purgedSessionsCount).toBe(15);
      expect(res.purgedOutboxCount).toBe(85);
      expect(res.retentionDays).toBe(30);
    });
  });

  describe('4. Dispatcher Routing', () => {
    it('routes NOTIFICATION events to notification handler', async () => {
      jest.spyOn(adminNotificationRepository, 'findNotificationById').mockResolvedValueOnce({
        id: 'n-routed',
        status: 'SENT',
      });

      const res = await dispatchEvent({
        event_type: 'NOTIFICATION_DISPATCH_REQUESTED',
        aggregate_type: 'NOTIFICATION',
        aggregate_id: 'n-routed',
      });

      expect(res.skipped).toBe(true);
    });

    it('routes RECONCILIATION events to reconciliation handler', async () => {
      jest.spyOn(adminWalletService, 'reconcileWallets').mockResolvedValueOnce({
        totalWallets: 10,
        reconciledWallets: 10,
        discrepancyCount: 0,
        hasDiscrepancy: false,
      });
      jest.spyOn(adminWalletService, 'getPayoutReconciliation').mockResolvedValueOnce({});

      const res = await dispatchEvent({
        event_type: 'RECONCILIATION_RUN',
        aggregate_type: 'SYSTEM',
      });

      expect(res.walletReconciliation.hasDiscrepancy).toBe(false);
    });

    it('routes CLEANUP events to cleanup handler', async () => {
      jest.spyOn(adminSessionRepository, 'cleanupExpiredSessions').mockResolvedValueOnce(5);
      jest.spyOn(adminOutboxRepository, 'cleanupProcessedEvents').mockResolvedValueOnce(20);

      const res = await dispatchEvent({
        event_type: 'CLEANUP_JOB',
        aggregate_type: 'SYSTEM',
      });

      expect(res.purgedSessionsCount).toBe(5);
    });

    it('throws non-retryable error for unknown event type', async () => {
      await expect(
        dispatchEvent({
          event_type: 'UNKNOWN_MAGIC_JOB',
          aggregate_type: 'STRANGE',
        }),
      ).rejects.toThrow(/Unhandled outbox event type/i);
    });
  });
});
