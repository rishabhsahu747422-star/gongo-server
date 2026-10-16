'use strict';

const logger = require('../config/logger');

const AUDIT_SENSITIVE_KEYS = [
  'password',
  'passwordhash',
  'hash',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'sessionhash',
  'bearertoken',
  'supabasetoken',
  'idtoken',
  'fcmtoken',
  'devicetoken',
  'secret',
  'privatekey',
  'private_key',
  'apikey',
  'otp',
  'authorization',
  'authheader',
  'cookie',
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
  constructor(actionRepo = null) {
    this.actionRepo = actionRepo;
  }

  _getActionRepo() {
    if (!this.actionRepo) {
      try {
        // eslint-disable-next-line global-require
        this.actionRepo = require('../repositories/admin-action.repository');
      } catch (_) {
        this.actionRepo = null;
      }
    }
    return this.actionRepo;
  }

  /**
   * Records an admin action audit event.
   * Logs structured record and attempts background persistence into admin_actions.
   *
   * @param {object} event
   * @param {string} event.actorId Identifies who performed the action
   * @param {string} [event.actorRole='ADMIN'] Role of the actor
   * @param {string} [event.permission] Admin permission used (e.g. SUPER_ADMIN)
   * @param {string} event.action Action performed (e.g. APPROVE_KYC, SUSPEND_PARTNER)
   * @param {string} event.targetResource Target resource type (e.g. PARTNER, BOOKING, VEHICLE)
   * @param {string} [event.targetResourceId] Target resource ID
   * @param {string} [event.requestId] Trace request ID
   * @param {string} [event.ipAddress] Client IP address
   * @param {string} [event.userAgent] Client user-agent
   * @param {object} [event.beforeState] Previous state before mutation
   * @param {object} [event.afterState] New state after mutation
   * @param {object} [event.metadata={}] Additional contextual metadata (auto-sanitized)
   * @returns {object} Structured audit event record
   */
  logAdminAction({
    actorId,
    actorRole = 'ADMIN',
    permission = null,
    action,
    targetResource,
    targetResourceId = null,
    requestId = null,
    ipAddress = null,
    userAgent = null,
    beforeState = null,
    afterState = null,
    metadata = {},
  }) {
    if (!actorId || !action || !targetResource) {
      throw new Error('Audit record requires actorId, action, and targetResource');
    }

    const auditRecord = {
      isAuditEvent: true,
      actorId,
      actorRole,
      permission,
      action,
      targetResource,
      targetResourceId,
      requestId,
      ipAddress,
      userAgent,
      timestamp: new Date().toISOString(),
      beforeState: beforeState ? sanitizeAuditMetadata(beforeState) : null,
      afterState: afterState ? sanitizeAuditMetadata(afterState) : null,
      metadata: sanitizeAuditMetadata(metadata),
    };

    logger.info('ADMIN_AUDIT_ACTION', auditRecord);

    return auditRecord;
  }

  /**
   * Explicitly persists and awaits an audit action record.
   *
   * @param {object} params
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async recordAction(params, client = null) {
    const record = this.logAdminAction(params);
    const repo = this._getActionRepo();
    if (repo && typeof repo.createAction === 'function') {
      return repo.createAction({
        ...params,
        beforeState: record.beforeState,
        afterState: record.afterState,
        metadata: record.metadata,
      }, client);
    }
    return record;
  }
}

const instance = new AuditService();
instance.AuditService = AuditService;
instance.sanitizeAuditMetadata = sanitizeAuditMetadata;
instance.AUDIT_SENSITIVE_KEYS = AUDIT_SENSITIVE_KEYS;

module.exports = instance;
