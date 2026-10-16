'use strict';

const logger = require('../config/logger');

const AUDIT_SENSITIVE_KEYS = [
  'password',
  'token',
  'secret',
  'otp',
  'authorization',
  'privatekey',
  'card',
  'cvv',
  'bankaccount',
  'accountnumber',
  'documentcontent',
  'kycdata',
];

function sanitizeAuditMetadata(meta) {
  if (!meta || typeof meta !== 'object') {
    return meta;
  }

  if (Array.isArray(meta)) {
    return meta.map(sanitizeAuditMetadata);
  }

  const clean = {};
  Object.keys(meta).forEach((key) => {
    const lower = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isSensitive = AUDIT_SENSITIVE_KEYS.some((s) => lower.includes(s));

    if (isSensitive) {
      clean[key] = '[REDACTED]';
    } else if (typeof meta[key] === 'object' && meta[key] !== null) {
      clean[key] = sanitizeAuditMetadata(meta[key]);
    } else {
      clean[key] = meta[key];
    }
  });

  return clean;
}

class AuditService {
  /**
   * Emits a structured security/compliance audit event.
   *
   * @param {object} event
   * @param {string} event.actorId Identifies who performed the action
   * @param {string} [event.actorRole='PARTNER'] Role of the actor
   * @param {string} event.action Action performed (e.g. VEHICLE_CREATE, HANDOVER_VERIFY)
   * @param {string} event.entityType Target entity type (e.g. VEHICLE, BOOKING, WALLET)
   * @param {string} event.entityId Target entity ID
   * @param {string} [event.requestId] Trace request ID
   * @param {object} [event.metadata={}] Additional contextual metadata (auto-sanitized)
   * @returns {object} Structured audit event record
   */
  logEvent({
    actorId,
    actorRole = 'PARTNER',
    action,
    entityType,
    entityId,
    requestId = null,
    metadata = {},
  }) {
    if (!actorId || !action || !entityType || !entityId) {
      throw new Error('Audit event requires actorId, action, entityType, and entityId');
    }

    const auditRecord = {
      isAuditEvent: true,
      actorId,
      actorRole,
      action,
      entityType,
      entityId,
      requestId,
      timestamp: new Date().toISOString(),
      metadata: sanitizeAuditMetadata(metadata),
    };

    logger.info('AUDIT_EVENT', auditRecord);

    return auditRecord;
  }
}

module.exports = new AuditService();
