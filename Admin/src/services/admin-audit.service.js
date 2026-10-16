'use strict';

const { validate: uuidValidate } = require('uuid');

const adminActionRepository = require('../repositories/admin-action.repository');
const userRepository = require('../repositories/user.repository');
const { BadRequestError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_WINDOW_DAYS = 90;

function assertUuid(id, fieldName = 'ID') {
  if (!id || typeof id !== 'string' || (!uuidValidate(id) && !UUID_REGEX.test(id))) {
    throw new BadRequestError(`Invalid ${fieldName}: must be a valid RFC 4122 UUID v4`, ERROR_CODES.VALIDATION_ERROR);
  }
  return id;
}

class AdminAuditService {
  constructor(
    actionRepo = adminActionRepository,
    userRepo = userRepository,
  ) {
    this.actionRepo = actionRepo;
    this.userRepo = userRepo;
  }

  /**
   * Lists administrative audit actions with comprehensive filtering and pagination.
   *
   * @param {object} query
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async listAudit(query = {}) {
    const { startDate, endDate, from, to, actorId, adminId } = query;

    const targetActorId = actorId || adminId;
    if (targetActorId) {
      assertUuid(targetActorId, 'actorId');
    }

    const { start, end } = this._validateDateRange(startDate || from, endDate || to);

    return this.actionRepo.listAuditActions({
      ...query,
      actorId: targetActorId,
      startDate: start ? start.toISOString() : undefined,
      endDate: end ? end.toISOString() : undefined,
    });
  }

  /**
   * Retrieves single audit action detail by UUID with BOLA/IDOR protection.
   *
   * @param {string} id
   * @returns {Promise<object>}
   */
  async getAuditDetail(id) {
    const actionId = assertUuid(id, 'auditId');
    const record = await this.actionRepo.findActionById(actionId);

    if (!record) {
      throw new NotFoundError(`Audit record '${actionId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    return record;
  }

  /**
   * Retrieves catalog of distinct recorded actions, resources, and security categories.
   *
   * @returns {Promise<{ actions: string[], resources: string[], categories: string[] }>}
   */
  async getDistinctActions() {
    return this.actionRepo.getDistinctActionsAndResources();
  }

  /**
   * Retrieves security-specific audit events.
   *
   * @param {object} query
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async getSecurityEvents(query = {}) {
    const { startDate, endDate, from, to, category } = query;

    if (category && typeof category === 'string') {
      const validCategories = adminActionRepository.SECURITY_CATEGORIES || {};
      const allowedCategories = new Set(Object.keys(validCategories));
      if (!allowedCategories.has(category.trim().toUpperCase())) {
        throw new BadRequestError(
          `Invalid security category: '${category}'. Allowed: ${Array.from(allowedCategories).join(', ')}`,
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
    }

    const { start, end } = this._validateDateRange(startDate || from, endDate || to);

    return this.actionRepo.findSecurityEvents({
      ...query,
      startDate: start ? start.toISOString() : undefined,
      endDate: end ? end.toISOString() : undefined,
    });
  }

  /**
   * Retrieves audit trail for a specific administrator.
   *
   * @param {string} adminId
   * @param {object} query
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async getAuditByAdmin(adminId, query = {}) {
    const cleanAdminId = assertUuid(adminId, 'adminId');

    const adminUser = await this.userRepo.findById(cleanAdminId);
    if (!adminUser) {
      throw new NotFoundError(`Admin user '${cleanAdminId}' not found`, ERROR_CODES.NOT_FOUND);
    }
    if (adminUser.role !== 'ADMIN') {
      throw new BadRequestError(`User '${cleanAdminId}' is not an administrator`, ERROR_CODES.VALIDATION_ERROR);
    }

    const { start, end } = this._validateDateRange(
      query.startDate || query.from,
      query.endDate || query.to,
    );

    return this.actionRepo.findActionsByActor(cleanAdminId, {
      ...query,
      startDate: start ? start.toISOString() : undefined,
      endDate: end ? end.toISOString() : undefined,
    });
  }

  /**
   * Retrieves chronological audit history for a specific resource entity.
   *
   * @param {string} resourceType
   * @param {string} resourceId
   * @param {object} query
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async getAuditByResource(resourceType, resourceId, query = {}) {
    if (!resourceType || typeof resourceType !== 'string' || !resourceType.trim()) {
      throw new BadRequestError('resourceType is required', ERROR_CODES.VALIDATION_ERROR);
    }
    if (!resourceId || typeof resourceId !== 'string' || !resourceId.trim()) {
      throw new BadRequestError('resourceId is required', ERROR_CODES.VALIDATION_ERROR);
    }

    const cleanResourceType = resourceType.trim().toUpperCase();
    const cleanResourceId = resourceId.trim();

    const { start, end } = this._validateDateRange(
      query.startDate || query.from,
      query.endDate || query.to,
    );

    return this.actionRepo.findActionsByResource(cleanResourceType, cleanResourceId, {
      ...query,
      startDate: start ? start.toISOString() : undefined,
      endDate: end ? end.toISOString() : undefined,
    });
  }

  /**
   * Computes operational security summary metrics within a bounded date window.
   *
   * @param {object} query
   * @returns {Promise<object>}
   */
  async getSecuritySummary(query = {}) {
    const now = new Date();
    const defaultStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24h default

    const { start, end } = this._validateDateRange(
      query.startDate || query.from || defaultStart,
      query.endDate || query.to || now,
    );

    return this.actionRepo.getSecuritySummary({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    });
  }

  /**
   * Validates date range parameters ensuring valid date format, start <= end,
   * and bounded historical query window (max 90 days).
   *
   * @param {string|Date} [startDate]
   * @param {string|Date} [endDate]
   * @returns {{ start: Date|null, end: Date|null }}
   * @private
   */
  _validateDateRange(startDate, endDate) {
    let start = null;
    let end = null;

    if (startDate) {
      start = new Date(startDate);
      if (Number.isNaN(start.getTime())) {
        throw new BadRequestError(`Invalid startDate: '${startDate}'`, ERROR_CODES.VALIDATION_ERROR);
      }
    }

    if (endDate) {
      end = new Date(endDate);
      if (Number.isNaN(end.getTime())) {
        throw new BadRequestError(`Invalid endDate: '${endDate}'`, ERROR_CODES.VALIDATION_ERROR);
      }
    }

    if (start && end) {
      if (start > end) {
        throw new BadRequestError('startDate must be before or equal to endDate', ERROR_CODES.VALIDATION_ERROR);
      }

      const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
      if (diffDays > MAX_QUERY_WINDOW_DAYS) {
        throw new BadRequestError(
          `Date query window exceeds maximum allowed ${MAX_QUERY_WINDOW_DAYS} days`,
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
    }

    return { start, end };
  }
}

const instance = new AdminAuditService();
instance.AdminAuditService = AdminAuditService;

module.exports = instance;
