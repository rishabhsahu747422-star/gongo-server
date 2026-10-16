'use strict';

const logger = require('../../config/logger');
const adminNotificationRepository = require('../../repositories/admin-notification.repository');
const adminNotificationService = require('../../services/admin-notification.service');

/**
 * Background Handler for Asynchronous Notification Delivery.
 *
 * Guarantees:
 * - Strict idempotency (never sends duplicate push if already SENT or DELIVERED)
 * - Safe token handling and automated deactivation of stale FCM tokens
 * - Transient vs permanent error classification for outbox retries
 */
async function handleNotificationEvent(event) {
  const notificationId = event.aggregate_id || (event.payload && event.payload.notificationId);

  if (!notificationId) {
    const err = new Error('Notification event missing aggregate_id / notificationId');
    err.isRetryable = false;
    throw err;
  }

  // 1. Fetch persistent notification record
  const notification = await adminNotificationRepository.findNotificationById(notificationId);
  if (!notification) {
    const err = new Error(`Notification record not found for id: ${notificationId}`);
    err.isRetryable = false;
    throw err;
  }

  // 2. Idempotency Check: if already sent/delivered, do not send duplicate
  if (notification.status === 'SENT' || notification.status === 'DELIVERED') {
    logger.info('Notification already delivered, skipping duplicate send (idempotency guard)', {
      notificationId,
      status: notification.status,
      eventId: event.id,
    });
    return { skipped: true, reason: 'ALREADY_DELIVERED', notificationId };
  }

  // 3. Resolve recipient and device tokens
  const recipientId = notification.recipient?.id || event.payload?.recipientId;
  const recipientType = notification.recipientType || event.payload?.recipientType || 'CUSTOMER';

  if (!recipientId) {
    const err = new Error(`Missing recipientId for notification ${notificationId}`);
    err.isRetryable = false;
    throw err;
  }

  // Push delivery channel
  if (notification.channel === 'PUSH') {
    const tokens = await adminNotificationRepository.findRecipientDeviceTokens(
      recipientId,
      recipientType,
    );

    if (!tokens || tokens.length === 0) {
      logger.info('Recipient has no active device tokens; marking delivery failure', {
        notificationId,
        recipientId,
      });

      await adminNotificationRepository.updateNotificationDelivery(notificationId, {
        status: 'FAILED',
        failureReason: 'No active device tokens found for recipient',
      });

      // Terminal: no tokens available, retrying will not help without token registration
      return { skipped: true, reason: 'NO_ACTIVE_DEVICE_TOKENS', notificationId };
    }

    // 4. Dispatch via Push Provider (FCM)
    const { pushProvider } = adminNotificationService;
    const pushResult = await pushProvider.sendMulticast({
      tokens,
      title: notification.title,
      body: notification.body,
      data: {
        ...(notification.data || {}),
        notificationId,
      },
    });

    // 5. Soft-deactivate stale/invalid tokens reported by provider
    if (Array.isArray(pushResult.invalidTokens) && pushResult.invalidTokens.length > 0) {
      try {
        await adminNotificationRepository.deactivateDeviceTokens(
          pushResult.invalidTokens,
          recipientType,
        );
        logger.info('Deactivated invalid FCM device tokens', {
          count: pushResult.invalidTokens.length,
          recipientId,
        });
      } catch (deactivateErr) {
        logger.warn('Failed to deactivate invalid tokens', { error: deactivateErr.message });
      }
    }

    // 6. Evaluate delivery result
    if (pushResult.successCount > 0) {
      await adminNotificationRepository.updateNotificationDelivery(notificationId, {
        status: 'SENT',
        sentAt: new Date().toISOString(),
      });

      return {
        success: true,
        successCount: pushResult.successCount,
        failureCount: pushResult.failureCount || 0,
        notificationId,
      };
    }

    // All tokens failed
    const failureReason = pushResult.reason || 'All device deliveries failed';
    await adminNotificationRepository.updateNotificationDelivery(notificationId, {
      status: 'FAILED',
      failureReason,
    });

    const deliveryErr = new Error(`Push delivery failed: ${failureReason}`);
    // Check if error is temporary or retryable
    deliveryErr.isRetryable = !pushResult.isInvalidRegistration;
    throw deliveryErr;
  }

  // Non-push channels (SMS/WHATSAPP placeholder or already handled)
  return { success: true, channel: notification.channel, notificationId };
}

module.exports = {
  handleNotificationEvent,
};
