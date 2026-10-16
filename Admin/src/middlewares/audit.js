'use strict';

const auditService = require('../services/audit.service');

/**
 * Middleware that provides an audit helper on req.audit
 * Automatically captures actor, request ID, IP address, user-agent, and timestamps.
 */
function auditMiddleware(req, res, next) {
  req.audit = function recordAudit({
    action,
    targetResource,
    targetResourceId = null,
    permission = null,
    beforeState = null,
    afterState = null,
    metadata = {},
  }) {
    const actorId = req.user ? req.user.id : 'system';
    const actorRole = req.user ? req.user.role : 'UNKNOWN';
    const requestId = req.id || (res.locals && res.locals.requestId) || null;
    const ipAddress = req.ip || req.connection?.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;

    return auditService.logAdminAction({
      actorId,
      actorRole,
      permission,
      action,
      targetResource,
      targetResourceId,
      requestId,
      ipAddress,
      userAgent,
      beforeState,
      afterState,
      metadata,
    });
  };

  next();
}

module.exports = { auditMiddleware };
