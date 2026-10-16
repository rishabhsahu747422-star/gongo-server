'use strict';

const { handleNotificationEvent } = require('./notification.handler');
const { handleReconciliationEvent } = require('./reconciliation.handler');
const { handleCleanupEvent } = require('./cleanup.handler');

/**
 * Routes an outbox event to its corresponding domain handler.
 *
 * @param {object} event Outbox event record
 * @returns {Promise<object>} Handler execution result
 */
async function dispatchEvent(event) {
  const eventType = String(event.event_type || '').toUpperCase();
  const aggregateType = String(event.aggregate_type || '').toUpperCase();

  // 1. Notification Events
  if (
    aggregateType === 'NOTIFICATION'
    || eventType.startsWith('NOTIFICATION_')
    || eventType === 'SEND_PUSH'
  ) {
    return handleNotificationEvent(event);
  }

  // 2. Financial Reconciliation Events
  if (
    eventType.includes('RECONCIL')
    || eventType.includes('WALLET_AUDIT')
    || eventType === 'PAYOUT_CHECK'
  ) {
    return handleReconciliationEvent(event);
  }

  // 3. Operational Cleanup Events
  if (
    eventType.includes('CLEANUP')
    || eventType.includes('PURGE')
    || eventType === 'EXPIRED_SESSIONS'
  ) {
    return handleCleanupEvent(event);
  }

  // 4. Unknown event type -> Non-retryable permanent error
  const err = new Error(`Unhandled outbox event type: ${event.event_type}`);
  err.isRetryable = false;
  throw err;
}

module.exports = {
  dispatchEvent,
};
