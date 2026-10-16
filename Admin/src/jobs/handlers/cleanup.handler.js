'use strict';

const logger = require('../../config/logger');
const adminSessionRepository = require('../../repositories/admin-session.repository');
const adminOutboxRepository = require('../../repositories/admin-outbox.repository');

/**
 * Background Handler for Operational Cleanup Jobs.
 *
 * Guarantees:
 * - Safely removes expired admin sessions and stale processed outbox records
 * - NEVER deletes immutable business records:
 *   (wallets, ledger transactions, bookings, payments, refunds, payouts, audit logs, KYC)
 */
async function handleCleanupEvent(event) {
  const payload = event.payload || {};
  const retentionDays = Math.max(7, parseInt(payload.retentionDays, 10) || 30);

  logger.info('Executing operational cleanup job', {
    eventId: event.id,
    retentionDays,
  });

  // 1. Clean up expired admin sessions
  const now = new Date();
  const purgedSessionsCount = await adminSessionRepository.cleanupExpiredSessions(now);

  // 2. Clean up old processed outbox events
  const purgedOutboxCount = await adminOutboxRepository.cleanupProcessedEvents(retentionDays);

  const result = {
    purgedSessionsCount,
    purgedOutboxCount,
    retentionDays,
    completedAt: new Date().toISOString(),
  };

  logger.info('Operational cleanup completed successfully', result);
  return result;
}

module.exports = {
  handleCleanupEvent,
};
