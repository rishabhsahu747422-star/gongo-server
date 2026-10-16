'use strict';

const adminOutboxRepository = require('../repositories/admin-outbox.repository');
const { defaultWorker } = require('../jobs/outbox.worker');
const { sendSuccess } = require('../utils/response');
const { ValidationError } = require('../errors');
const auditService = require('../services/audit.service');

/**
 * Controller for Admin Reliability & Background Job Operational Visibility.
 *
 * Exposes:
 * - Queue depth, stale counts, worker uptime, last poll/success timestamps
 * - Sanitized outbox event history (NEVER reveals tokens, secrets, or passwords)
 * - Safe on-demand scheduling of reconciliation and cleanup events
 */
class AdminJobsController {
  /**
   * GET /api/v1/admin/jobs/overview
   * Returns worker operational state and outbox queue metrics.
   */
  async getOverview(req, res, next) {
    try {
      const [workerHealth, queueStats] = await Promise.all([
        defaultWorker.getHealth(),
        adminOutboxRepository.getQueueStats(),
      ]);

      return sendSuccess(res, {
        worker: workerHealth,
        queue: queueStats,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/jobs/events
   * Lists operational outbox events with filtering and safe redaction.
   */
  async listEvents(req, res, next) {
    try {
      const { status, eventType, limit, offset } = req.query;

      const upperStatus = status ? String(status).toUpperCase() : null;
      if (upperStatus && !['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'].includes(upperStatus)) {
        throw new ValidationError(
          'Invalid job status. Must be one of PENDING, PROCESSING, PROCESSED, FAILED',
        );
      }

      const events = await adminOutboxRepository.listOperationalEvents({
        status,
        eventType: eventType ? String(eventType).replace(/[^a-zA-Z0-9_-]/g, '') : undefined,
        limit,
        offset,
      });

      return sendSuccess(res, {
        items: events,
        count: events.length,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/jobs/reconcile
   * Enqueues an on-demand background financial reconciliation run.
   */
  async triggerReconciliation(req, res, next) {
    try {
      const actorId = req.user?.id || '00000000-0000-0000-0000-000000000000';
      const event = await adminOutboxRepository.createEvent({
        eventType: 'RECONCILIATION_RUN',
        aggregateType: 'SYSTEM',
        aggregateId: actorId,
        payload: {
          triggeredBy: actorId,
          reason: req.body?.reason || 'Admin on-demand reconciliation run',
        },
      });

      auditService.logAdminAction({
        actorId,
        actorRole: req.user?.role || 'ADMIN',
        permission: 'audit.security.read',
        action: 'TRIGGER_RECONCILIATION',
        targetResource: 'SYSTEM',
        targetResourceId: event.id,
        metadata: { eventId: event.id },
      });

      return sendSuccess(res, {
        message: 'Reconciliation job enqueued successfully',
        eventId: event.id,
        status: event.status,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/jobs/cleanup
   * Enqueues an on-demand operational cleanup job.
   */
  async triggerCleanup(req, res, next) {
    try {
      const actorId = req.user?.id || '00000000-0000-0000-0000-000000000000';
      const retentionDays = parseInt(req.body?.retentionDays, 10) || 30;

      const event = await adminOutboxRepository.createEvent({
        eventType: 'CLEANUP_JOB',
        aggregateType: 'SYSTEM',
        aggregateId: actorId,
        payload: {
          triggeredBy: actorId,
          retentionDays,
        },
      });

      auditService.logAdminAction({
        actorId,
        actorRole: req.user?.role || 'ADMIN',
        permission: 'audit.security.read',
        action: 'TRIGGER_CLEANUP',
        targetResource: 'SYSTEM',
        targetResourceId: event.id,
        metadata: { eventId: event.id, retentionDays },
      });

      return sendSuccess(res, {
        message: 'Operational cleanup job enqueued successfully',
        eventId: event.id,
        status: event.status,
      });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminJobsController();
