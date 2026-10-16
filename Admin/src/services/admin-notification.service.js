'use strict';

const { validate: uuidValidate } = require('uuid');

const adminNotificationRepository = require('../repositories/admin-notification.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const auditService = require('./audit.service');
const fcmProvider = require('../providers/fcm');
const logger = require('../config/logger');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(id, fieldName = 'ID') {
  if (!id || typeof id !== 'string' || (!uuidValidate(id) && !UUID_REGEX.test(id))) {
    throw new BadRequestError(`Invalid ${fieldName}: must be a valid RFC 4122 UUID v4`, ERROR_CODES.VALIDATION_ERROR);
  }
  return id;
}

const ALLOWED_CHANNELS = new Set(['PUSH', 'IN_APP', 'SMS', 'EMAIL']);
const ALLOWED_AUDIENCES = new Set(['CUSTOMER', 'PARTNER', 'ALL']);
const ALLOWED_RECIPIENT_TYPES = new Set(['CUSTOMER', 'PARTNER']);
const TEMPLATE_KEY_REGEX = /^[a-z0-9_-]{3,100}$/;

class AdminNotificationService {
  constructor(
    notificationRepo = adminNotificationRepository,
    actionRepo = adminActionRepository,
    pushProvider = fcmProvider,
  ) {
    this.notificationRepo = notificationRepo;
    this.actionRepo = actionRepo;
    this.pushProvider = pushProvider;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. Notification Querying & Visibility
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Retrieves paginated notifications with filters.
   *
   * @param {object} query
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async listNotifications(query = {}) {
    if (query.channel && !ALLOWED_CHANNELS.has(query.channel.toUpperCase())) {
      throw new BadRequestError(`Invalid channel filter: '${query.channel}'`, ERROR_CODES.VALIDATION_ERROR);
    }
    if (query.recipientType && !ALLOWED_RECIPIENT_TYPES.has(query.recipientType.toUpperCase())) {
      throw new BadRequestError(`Invalid recipientType filter: '${query.recipientType}'`, ERROR_CODES.VALIDATION_ERROR);
    }
    if (query.recipientId) {
      assertUuid(query.recipientId, 'recipientId');
    }
    if (query.bookingId) {
      assertUuid(query.bookingId, 'bookingId');
    }
    if (query.templateId) {
      assertUuid(query.templateId, 'templateId');
    }

    return this.notificationRepo.listNotifications(query);
  }

  /**
   * Retrieves single notification by ID.
   *
   * @param {string} id
   * @returns {Promise<object>}
   */
  async getNotificationById(id) {
    const notificationId = assertUuid(id, 'notificationId');
    const notification = await this.notificationRepo.findNotificationById(notificationId);
    if (!notification) {
      throw new NotFoundError(`Notification '${notificationId}' not found`, ERROR_CODES.NOT_FOUND);
    }
    return notification;
  }

  /**
   * Retrieves delivery status of a notification.
   *
   * @param {string} id
   * @returns {Promise<object>}
   */
  async getNotificationStatus(id) {
    const notification = await this.getNotificationById(id);
    return {
      id: notification.id,
      recipientType: notification.recipientType,
      recipientId: notification.recipient?.id,
      channel: notification.channel,
      status: notification.status,
      readAt: notification.readAt,
      sentAt: notification.sentAt,
      deliveredAt: notification.deliveredAt,
      failedAt: notification.failedAt,
      failureReason: notification.failureReason,
      createdAt: notification.createdAt,
      updatedAt: notification.updatedAt,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. Notification Templates Management
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Lists notification templates with pagination.
   *
   * @param {object} query
   * @returns {Promise<{ items: object[], pagination: object }>}
   */
  async listTemplates(query = {}) {
    if (query.channel && !ALLOWED_CHANNELS.has(query.channel.toUpperCase())) {
      throw new BadRequestError(`Invalid channel filter: '${query.channel}'`, ERROR_CODES.VALIDATION_ERROR);
    }
    if (query.targetAudience && !ALLOWED_AUDIENCES.has(query.targetAudience.toUpperCase())) {
      throw new BadRequestError(`Invalid targetAudience filter: '${query.targetAudience}'`, ERROR_CODES.VALIDATION_ERROR);
    }
    return this.notificationRepo.listTemplates(query);
  }

  /**
   * Retrieves notification template by UUID or key.
   *
   * @param {string} idOrKey
   * @returns {Promise<object>}
   */
  async getTemplateById(idOrKey) {
    if (!idOrKey || typeof idOrKey !== 'string') {
      throw new BadRequestError('Template identifier is required', ERROR_CODES.VALIDATION_ERROR);
    }

    const isUuid = uuidValidate(idOrKey) || UUID_REGEX.test(idOrKey);
    const template = isUuid
      ? await this.notificationRepo.findTemplateById(idOrKey)
      : await this.notificationRepo.findTemplateByKey(idOrKey.trim().toLowerCase());

    if (!template) {
      throw new NotFoundError(`Notification template '${idOrKey}' not found`, ERROR_CODES.NOT_FOUND);
    }

    return template;
  }

  /**
   * Alias for getTemplateById.
   */
  async getTemplateByIdOrKey(idOrKey) {
    return this.getTemplateById(idOrKey);
  }

  /**
   * Creates a new notification template.
   *
   * @param {object} payload
   * @param {object} adminUser
   * @param {object} [auditMeta={}]
   * @returns {Promise<object>}
   */
  async createTemplate(payload, adminUser, auditMeta = {}) {
    const {
      templateKey,
      title,
      body,
      notificationType,
      channel = 'PUSH',
      targetAudience = 'ALL',
      variables = [],
      metadata = {},
    } = payload || {};

    if (!templateKey || typeof templateKey !== 'string' || !TEMPLATE_KEY_REGEX.test(templateKey.trim().toLowerCase())) {
      throw new BadRequestError(
        'Invalid templateKey: must be 3-100 characters alphanumeric with hyphens or underscores',
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0 || title.trim().length > 255) {
      throw new BadRequestError('Title is required and must not exceed 255 characters', ERROR_CODES.VALIDATION_ERROR);
    }

    if (!body || typeof body !== 'string' || body.trim().length === 0 || body.trim().length > 4000) {
      throw new BadRequestError('Body is required and must not exceed 4000 characters', ERROR_CODES.VALIDATION_ERROR);
    }

    if (!notificationType || typeof notificationType !== 'string' || notificationType.trim().length === 0) {
      throw new BadRequestError('Notification type is required', ERROR_CODES.VALIDATION_ERROR);
    }

    const normalizedChannel = channel.toUpperCase().trim();
    if (!ALLOWED_CHANNELS.has(normalizedChannel)) {
      throw new BadRequestError(`Invalid channel: '${channel}'. Allowed: PUSH, IN_APP, SMS, EMAIL`, ERROR_CODES.VALIDATION_ERROR);
    }

    const normalizedAudience = targetAudience.toUpperCase().trim();
    if (!ALLOWED_AUDIENCES.has(normalizedAudience)) {
      throw new BadRequestError(`Invalid targetAudience: '${targetAudience}'. Allowed: CUSTOMER, PARTNER, ALL`, ERROR_CODES.VALIDATION_ERROR);
    }

    const normalizedKey = templateKey.trim().toLowerCase();

    // Check key uniqueness
    const existing = await this.notificationRepo.findTemplateByKey(normalizedKey);
    if (existing) {
      throw new ConflictError(`Notification template with key '${normalizedKey}' already exists`, ERROR_CODES.CONFLICT);
    }

    const created = await this.notificationRepo.createTemplate({
      templateKey: normalizedKey,
      title: title.trim(),
      body: body.trim(),
      notificationType: notificationType.trim().toUpperCase(),
      channel: normalizedChannel,
      targetAudience: normalizedAudience,
      isActive: true,
      variables: Array.isArray(variables) ? variables.map((v) => String(v).trim()) : [],
      metadata,
      createdBy: adminUser.id,
    });

    auditService.logAdminAction({
      actorId: adminUser.id,
      actorRole: adminUser.role || 'ADMIN',
      permission: auditMeta.permission || 'notifications.manage',
      action: 'NOTIFICATION_TEMPLATE_CREATED',
      targetResource: 'NOTIFICATION_TEMPLATE',
      targetResourceId: created.id,
      requestId: auditMeta.requestId,
      ipAddress: auditMeta.ipAddress,
      userAgent: auditMeta.userAgent,
      metadata: { templateKey: created.templateKey, channel: created.channel },
    });

    await this.actionRepo.createAction({
      actorId: adminUser.id,
      actorRole: adminUser.role || 'ADMIN',
      permission: auditMeta.permission || 'notifications.manage',
      action: 'NOTIFICATION_TEMPLATE_CREATED',
      targetResource: 'NOTIFICATION_TEMPLATE',
      targetResourceId: created.id,
      requestId: auditMeta.requestId,
      ipAddress: auditMeta.ipAddress,
      userAgent: auditMeta.userAgent,
      metadata: { templateKey: created.templateKey, channel: created.channel },
    });

    return created;
  }

  /**
   * Updates an existing notification template.
   *
   * @param {string} id
   * @param {object} payload
   * @param {object} adminUser
   * @param {object} [auditMeta={}]
   * @returns {Promise<object>}
   */
  async updateTemplate(id, payload, adminUser, auditMeta = {}) {
    const templateId = assertUuid(id, 'templateId');
    const existing = await this.notificationRepo.findTemplateById(templateId);
    if (!existing) {
      throw new NotFoundError(`Notification template '${templateId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    const updates = {};
    if (payload.title !== undefined) {
      if (typeof payload.title !== 'string' || payload.title.trim().length === 0 || payload.title.trim().length > 255) {
        throw new BadRequestError('Title must not exceed 255 characters', ERROR_CODES.VALIDATION_ERROR);
      }
      updates.title = payload.title.trim();
    }

    if (payload.body !== undefined) {
      if (typeof payload.body !== 'string' || payload.body.trim().length === 0 || payload.body.trim().length > 4000) {
        throw new BadRequestError('Body must not exceed 4000 characters', ERROR_CODES.VALIDATION_ERROR);
      }
      updates.body = payload.body.trim();
    }

    if (payload.channel !== undefined) {
      const normalizedChannel = payload.channel.toUpperCase().trim();
      if (!ALLOWED_CHANNELS.has(normalizedChannel)) {
        throw new BadRequestError(`Invalid channel: '${payload.channel}'`, ERROR_CODES.VALIDATION_ERROR);
      }
      updates.channel = normalizedChannel;
    }

    if (payload.targetAudience !== undefined) {
      const normalizedAudience = payload.targetAudience.toUpperCase().trim();
      if (!ALLOWED_AUDIENCES.has(normalizedAudience)) {
        throw new BadRequestError(`Invalid targetAudience: '${payload.targetAudience}'`, ERROR_CODES.VALIDATION_ERROR);
      }
      updates.targetAudience = normalizedAudience;
    }

    if (payload.notificationType !== undefined) {
      if (typeof payload.notificationType !== 'string' || payload.notificationType.trim().length === 0) {
        throw new BadRequestError('Notification type cannot be empty', ERROR_CODES.VALIDATION_ERROR);
      }
      updates.notificationType = payload.notificationType.trim().toUpperCase();
    }

    if (payload.variables !== undefined) {
      if (!Array.isArray(payload.variables)) {
        throw new BadRequestError('Variables must be an array of strings', ERROR_CODES.VALIDATION_ERROR);
      }
      updates.variables = payload.variables.map((v) => String(v).trim());
    }

    if (payload.metadata !== undefined) {
      updates.metadata = typeof payload.metadata === 'object' && payload.metadata !== null ? payload.metadata : {};
    }

    updates.updatedBy = adminUser.id;

    const updated = await this.notificationRepo.updateTemplate(templateId, updates);

    auditService.logAdminAction({
      actorId: adminUser.id,
      actorRole: adminUser.role || 'ADMIN',
      permission: auditMeta.permission || 'notifications.manage',
      action: 'NOTIFICATION_TEMPLATE_UPDATED',
      targetResource: 'NOTIFICATION_TEMPLATE',
      targetResourceId: templateId,
      requestId: auditMeta.requestId,
      ipAddress: auditMeta.ipAddress,
      userAgent: auditMeta.userAgent,
      beforeState: {
        title: existing.title,
        channel: existing.channel,
        variables: existing.variables,
      },
      afterState: {
        title: updated.title,
        channel: updated.channel,
        variables: updated.variables,
      },
    });

    await this.actionRepo.createAction({
      actorId: adminUser.id,
      actorRole: adminUser.role || 'ADMIN',
      permission: auditMeta.permission || 'notifications.manage',
      action: 'NOTIFICATION_TEMPLATE_UPDATED',
      targetResource: 'NOTIFICATION_TEMPLATE',
      targetResourceId: templateId,
      requestId: auditMeta.requestId,
      ipAddress: auditMeta.ipAddress,
      userAgent: auditMeta.userAgent,
      beforeState: { title: existing.title, channel: existing.channel },
      afterState: { title: updated.title, channel: updated.channel },
    });

    return updated;
  }

  /**
   * Activates a template.
   *
   * @param {string} id
   * @param {object} adminUser
   * @param {object} [auditMeta={}]
   * @returns {Promise<object>}
   */
  async activateTemplate(id, adminUser, auditMeta = {}) {
    const templateId = assertUuid(id, 'templateId');
    const existing = await this.notificationRepo.findTemplateById(templateId);
    if (!existing) {
      throw new NotFoundError(`Notification template '${templateId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    if (existing.isActive) {
      return existing; // Idempotent
    }

    const updated = await this.notificationRepo.setTemplateActiveState(
      templateId,
      true,
      adminUser.id,
    );

    auditService.logAdminAction({
      actorId: adminUser.id,
      actorRole: adminUser.role || 'ADMIN',
      permission: auditMeta.permission || 'notifications.manage',
      action: 'NOTIFICATION_TEMPLATE_ACTIVATED',
      targetResource: 'NOTIFICATION_TEMPLATE',
      targetResourceId: templateId,
      requestId: auditMeta.requestId,
      ipAddress: auditMeta.ipAddress,
      userAgent: auditMeta.userAgent,
      beforeState: { isActive: false },
      afterState: { isActive: true },
    });

    await this.actionRepo.createAction({
      actorId: adminUser.id,
      actorRole: adminUser.role || 'ADMIN',
      permission: auditMeta.permission || 'notifications.manage',
      action: 'NOTIFICATION_TEMPLATE_ACTIVATED',
      targetResource: 'NOTIFICATION_TEMPLATE',
      targetResourceId: templateId,
      requestId: auditMeta.requestId,
      ipAddress: auditMeta.ipAddress,
      userAgent: auditMeta.userAgent,
      beforeState: { isActive: false },
      afterState: { isActive: true },
    });

    return updated;
  }

  /**
   * Deactivates a template.
   *
   * @param {string} id
   * @param {object} adminUser
   * @param {object} [auditMeta={}]
   * @returns {Promise<object>}
   */
  async deactivateTemplate(id, adminUser, auditMeta = {}) {
    const templateId = assertUuid(id, 'templateId');
    const existing = await this.notificationRepo.findTemplateById(templateId);
    if (!existing) {
      throw new NotFoundError(`Notification template '${templateId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    if (!existing.isActive) {
      return existing; // Idempotent
    }

    const updated = await this.notificationRepo.setTemplateActiveState(
      templateId,
      false,
      adminUser.id,
    );

    auditService.logAdminAction({
      actorId: adminUser.id,
      actorRole: adminUser.role || 'ADMIN',
      permission: auditMeta.permission || 'notifications.manage',
      action: 'NOTIFICATION_TEMPLATE_DEACTIVATED',
      targetResource: 'NOTIFICATION_TEMPLATE',
      targetResourceId: templateId,
      requestId: auditMeta.requestId,
      ipAddress: auditMeta.ipAddress,
      userAgent: auditMeta.userAgent,
      beforeState: { isActive: true },
      afterState: { isActive: false },
    });

    await this.actionRepo.createAction({
      actorId: adminUser.id,
      actorRole: adminUser.role || 'ADMIN',
      permission: auditMeta.permission || 'notifications.manage',
      action: 'NOTIFICATION_TEMPLATE_DEACTIVATED',
      targetResource: 'NOTIFICATION_TEMPLATE',
      targetResourceId: templateId,
      requestId: auditMeta.requestId,
      ipAddress: auditMeta.ipAddress,
      userAgent: auditMeta.userAgent,
      beforeState: { isActive: true },
      afterState: { isActive: false },
    });

    return updated;
  }

  /**
   * Sets template active state (true or false).
   */
  async setTemplateActive(id, isActive, adminUser, auditMeta = {}) {
    return isActive
      ? this.activateTemplate(id, adminUser, auditMeta)
      : this.deactivateTemplate(id, adminUser, auditMeta);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. Admin-Triggered Notification Dispatch
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Sends a targeted notification to a customer or partner.
   * Enforces recipient validation, BOLA/IDOR booking verification, template validation,
   * safe variable substitution, transactional persistence, outbox queuing, and push delivery.
   *
   * @param {object} payload
   * @param {object} adminUser
   * @param {object} [auditMeta={}]
   * @returns {Promise<object>}
   */
  async sendNotification(payload, adminUser, auditMeta = {}) {
    const {
      recipientId,
      customerId,
      partnerId,
      recipientType,
      templateId,
      templateKey,
      title: customTitle,
      body: customBody,
      type: customType,
      channel = 'PUSH',
      bookingId,
      variables = {},
      data = {},
      idempotencyKey,
      eventKey,
    } = payload || {};

    // 0. Idempotency Check: early interception
    const cleanEventKey = idempotencyKey || eventKey || null;
    if (cleanEventKey && typeof cleanEventKey === 'string' && cleanEventKey.trim()) {
      const existing = await this.notificationRepo.findByEventKey(cleanEventKey.trim());
      if (existing) {
        logger.info('Duplicate notification send request intercepted (idempotency key matched)', {
          eventKey: cleanEventKey,
          notificationId: existing.id,
        });
        const fullNotification = await this.notificationRepo.findNotificationById(existing.id);
        return fullNotification || existing;
      }
    }

    // 1. Resolve recipient ID and target type
    const targetRecipientId = recipientId || customerId || partnerId;
    if (!targetRecipientId) {
      throw new BadRequestError('Recipient ID (recipientId, customerId, or partnerId) is required', ERROR_CODES.VALIDATION_ERROR);
    }
    const cleanRecipientId = assertUuid(targetRecipientId, 'recipientId');

    const resolvedType = (recipientType || (partnerId ? 'PARTNER' : 'CUSTOMER')).toUpperCase().trim();
    if (!ALLOWED_RECIPIENT_TYPES.has(resolvedType)) {
      throw new BadRequestError(`Invalid recipientType: '${recipientType}'. Allowed: CUSTOMER, PARTNER`, ERROR_CODES.VALIDATION_ERROR);
    }

    const resolvedChannel = channel.toUpperCase().trim();
    if (!ALLOWED_CHANNELS.has(resolvedChannel)) {
      throw new BadRequestError(`Invalid channel: '${channel}'. Allowed: PUSH, IN_APP, SMS, EMAIL`, ERROR_CODES.VALIDATION_ERROR);
    }

    // 2. Resolve & Validate Recipient Entity
    let recipientEntity = null;
    if (resolvedType === 'CUSTOMER') {
      recipientEntity = await this.notificationRepo.getRecipientUser(cleanRecipientId);
      if (!recipientEntity) {
        throw new NotFoundError(`Customer with ID '${cleanRecipientId}' not found`, ERROR_CODES.NOT_FOUND);
      }
      if (String(recipientEntity.role || '').toUpperCase() !== 'CUSTOMER') {
        throw new BadRequestError(`User '${cleanRecipientId}' is not a customer (role: ${recipientEntity.role})`, ERROR_CODES.VALIDATION_ERROR);
      }
      if (!recipientEntity.is_active) {
        throw new ForbiddenError(`Customer '${cleanRecipientId}' is deactivated`, ERROR_CODES.FORBIDDEN);
      }
    } else {
      recipientEntity = await this.notificationRepo.getRecipientPartner(cleanRecipientId);
      if (!recipientEntity) {
        throw new NotFoundError(`Partner with ID '${cleanRecipientId}' not found`, ERROR_CODES.NOT_FOUND);
      }
      if (recipientEntity.is_active === false) {
        throw new ForbiddenError(`Partner '${cleanRecipientId}' is deactivated`, ERROR_CODES.FORBIDDEN);
      }
    }

    // 3. Booking Ownership Verification (BOLA / IDOR Protection)
    let cleanBookingId = null;
    if (bookingId) {
      cleanBookingId = assertUuid(bookingId, 'bookingId');
      const booking = await this.notificationRepo.getBookingForRecipient(
        cleanBookingId,
        cleanRecipientId,
        resolvedType,
      );
      if (!booking) {
        throw new ForbiddenError(
          `Booking '${cleanBookingId}' does not belong to recipient '${cleanRecipientId}'`,
          ERROR_CODES.FORBIDDEN,
        );
      }
    }

    // 4. Resolve Template & Perform Safe Variable Substitution
    let matchedTemplate = null;
    let finalTitle = customTitle ? customTitle.trim() : null;
    let finalBody = customBody ? customBody.trim() : null;
    let finalType = customType ? customType.trim().toUpperCase() : 'ADMIN_NOTIFICATION';

    if (templateId || templateKey) {
      matchedTemplate = templateId
        ? await this.notificationRepo.findTemplateById(assertUuid(templateId, 'templateId'))
        : await this.notificationRepo.findTemplateByKey(templateKey.trim().toLowerCase());

      if (!matchedTemplate) {
        throw new NotFoundError(`Notification template '${templateId || templateKey}' not found`, ERROR_CODES.NOT_FOUND);
      }

      if (!matchedTemplate.isActive) {
        throw new BadRequestError(`Notification template '${matchedTemplate.templateKey}' is deactivated`, ERROR_CODES.VALIDATION_ERROR);
      }

      // Check audience alignment
      if (matchedTemplate.targetAudience !== 'ALL' && matchedTemplate.targetAudience !== resolvedType) {
        throw new BadRequestError(
          `Template audience '${matchedTemplate.targetAudience}' cannot be sent to '${resolvedType}'`,
          ERROR_CODES.VALIDATION_ERROR,
        );
      }

      finalTitle = finalTitle || matchedTemplate.title;
      finalBody = finalBody || matchedTemplate.body;
      finalType = customType ? customType.trim().toUpperCase() : matchedTemplate.notificationType;

      // Variable substitution
      finalTitle = this._substituteVariables(finalTitle, variables, matchedTemplate.variables);
      finalBody = this._substituteVariables(finalBody, variables, matchedTemplate.variables);
    }

    if (!finalTitle || finalTitle.length === 0 || finalTitle.length > 255) {
      throw new BadRequestError('Notification title is required and must not exceed 255 characters', ERROR_CODES.VALIDATION_ERROR);
    }
    if (!finalBody || finalBody.length === 0 || finalBody.length > 4000) {
      throw new BadRequestError('Notification body is required and must not exceed 4000 characters', ERROR_CODES.VALIDATION_ERROR);
    }

    // 6. Transactional Persistence (DB record + Outbox event + Action log)
    const { createdNotification } = await this.notificationRepo.withTransaction(async (client) => {
      const notifData = {
        customerId: resolvedType === 'CUSTOMER' ? cleanRecipientId : null,
        partnerId: resolvedType === 'PARTNER' ? cleanRecipientId : null,
        recipientType: resolvedType,
        type: finalType,
        title: finalTitle,
        body: finalBody,
        data: typeof data === 'object' && data !== null ? data : {},
        channel: resolvedChannel,
        status: 'PENDING',
        templateId: matchedTemplate ? matchedTemplate.id : null,
        bookingId: cleanBookingId,
        sentBy: adminUser.id,
        eventKey: cleanEventKey ? cleanEventKey.trim() : null,
        metadata: {
          operatorEmail: adminUser.email,
          dispatchedAt: new Date().toISOString(),
        },
      };

      const record = await this.notificationRepo.createNotification(notifData, client);

      // If targeting partner, also insert partner in-app notification record
      if (resolvedType === 'PARTNER') {
        await this.notificationRepo.createPartnerNotification({
          partnerId: cleanRecipientId,
          type: finalType,
          title: finalTitle,
          body: finalBody,
          payload: { ...data, notificationId: record.id, bookingId: cleanBookingId },
          eventKey: cleanEventKey ? cleanEventKey.trim() : null,
        }, client);
      }

      // Transactional Outbox Event
      await this.notificationRepo.createOutboxEvent({
        eventType: 'NOTIFICATION_DISPATCH_REQUESTED',
        aggregateType: 'NOTIFICATION',
        aggregateId: record.id,
        payload: {
          notificationId: record.id,
          recipientId: cleanRecipientId,
          recipientType: resolvedType,
          channel: resolvedChannel,
          title: finalTitle,
          body: finalBody,
          data,
        },
        status: 'PENDING',
      }, client);

      // Action Audit
      auditService.logAdminAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'notifications.send',
        action: 'NOTIFICATION_SEND_REQUESTED',
        targetResource: 'NOTIFICATION',
        targetResourceId: record.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        metadata: {
          recipientId: cleanRecipientId,
          recipientType: resolvedType,
          channel: resolvedChannel,
          templateKey: matchedTemplate ? matchedTemplate.templateKey : null,
        },
      });

      await this.actionRepo.createAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'notifications.send',
        action: 'NOTIFICATION_SEND_REQUESTED',
        targetResource: 'NOTIFICATION',
        targetResourceId: record.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        metadata: {
          recipientId: cleanRecipientId,
          recipientType: resolvedType,
          channel: resolvedChannel,
          templateKey: matchedTemplate ? matchedTemplate.templateKey : null,
        },
      }, client);

      return { createdNotification: record };
    });

    // 7. Asynchronous Push Dispatch via FCM (Post-Commit)
    // Failure in provider never invalidates or rolls back the persistent notification record.
    if (resolvedChannel === 'PUSH') {
      try {
        const tokens = await this.notificationRepo.findRecipientDeviceTokens(
          cleanRecipientId,
          resolvedType,
        );

        if (tokens.length > 0) {
          const pushResult = await this.pushProvider.sendMulticast({
            tokens,
            title: finalTitle,
            body: finalBody,
            data: { ...data, notificationId: createdNotification.id },
          });

          // Soft-deactivate any stale/invalid tokens reported by FCM
          if (Array.isArray(pushResult.invalidTokens) && pushResult.invalidTokens.length > 0) {
            try {
              await this.notificationRepo.deactivateDeviceTokens(
                pushResult.invalidTokens,
                resolvedType,
              );
            } catch (deactivateErr) {
              logger.warn('Failed to deactivate invalid tokens', { error: deactivateErr.message });
            }
          }

          if (pushResult.successCount > 0) {
            await this.notificationRepo.updateNotificationDelivery(createdNotification.id, {
              status: 'SENT',
              sentAt: new Date().toISOString(),
            });
            await this.notificationRepo.updateOutboxEventStatus(createdNotification.id, 'PROCESSED');
          } else {
            await this.notificationRepo.updateNotificationDelivery(createdNotification.id, {
              status: 'FAILED',
              failureReason: pushResult.reason || 'All device deliveries failed',
              failedAt: new Date().toISOString(),
            });
            await this.notificationRepo.updateOutboxEventStatus(
              createdNotification.id,
              'FAILED',
              pushResult.reason || 'All device deliveries failed',
            );
          }
        } else {
          logger.info('Recipient has no active device tokens; notification preserved as PENDING', {
            recipientId: cleanRecipientId,
            notificationId: createdNotification.id,
          });
        }
      } catch (err) {
        logger.error('Unexpected push dispatch error', {
          notificationId: createdNotification.id,
          error: err.message,
        });

        try {
          await this.notificationRepo.updateNotificationDelivery(createdNotification.id, {
            status: 'FAILED',
            failureReason: err.message,
          });
        } catch (deliveryErr) {
          logger.debug('Failed to update notification delivery status', { error: deliveryErr.message });
        }
        try {
          await this.notificationRepo.updateOutboxEventStatus(
            createdNotification.id,
            'FAILED',
            err.message,
          );
        } catch (outboxErr) {
          logger.debug('Failed to update outbox status', { error: outboxErr.message });
        }
      }
    }

    return this.notificationRepo.findNotificationById(createdNotification.id);
  }

  /**
   * Retries delivery of a pending or failed notification.
   *
   * @param {string} id
   * @param {object} adminUser
   * @param {object} [auditMeta={}]
   * @returns {Promise<object>}
   */
  async retryNotification(id, adminUser, auditMeta = {}) {
    const notificationId = assertUuid(id, 'notificationId');
    const notification = await this.getNotificationById(notificationId);

    // Idempotency: if already SENT or DELIVERED, return without duplicate push
    if (notification.status === 'SENT' || notification.status === 'DELIVERED') {
      return notification;
    }

    const recipientId = notification.recipient?.id;
    const { recipientType } = notification;

    if (notification.channel === 'PUSH' && recipientId) {
      const tokens = await this.notificationRepo.findRecipientDeviceTokens(
        recipientId,
        recipientType,
      );

      if (tokens.length > 0) {
        const pushResult = await this.pushProvider.sendMulticast({
          tokens,
          title: notification.title,
          body: notification.body,
          data: { ...notification.data, notificationId: notification.id },
        });

        if (pushResult.successCount > 0) {
          await this.notificationRepo.updateNotificationDelivery(notification.id, {
            status: 'SENT',
            sentAt: new Date().toISOString(),
          });
          await this.notificationRepo.updateOutboxEventStatus(notification.id, 'PROCESSED');
        } else {
          await this.notificationRepo.updateNotificationDelivery(notification.id, {
            status: 'FAILED',
            failureReason: pushResult.reason || 'All device deliveries failed on retry',
          });
        }
      }
    }

    auditService.logAdminAction({
      actorId: adminUser.id,
      actorRole: adminUser.role || 'ADMIN',
      permission: auditMeta.permission || 'notifications.send',
      action: 'NOTIFICATION_RESENT',
      targetResource: 'NOTIFICATION',
      targetResourceId: notificationId,
      requestId: auditMeta.requestId,
      ipAddress: auditMeta.ipAddress,
      userAgent: auditMeta.userAgent,
    });

    return this.getNotificationById(notificationId);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Internal Helpers (Safe Variable Substitution)
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Safely substitutes template variables without evaluating arbitrary code.
   * Replaces placeholders like {{customerName}} and {customerName}.
   *
   * @param {string} text
   * @param {Record<string, any>} [values={}]
   * @param {string[]} [allowedVariables=[]]
   * @returns {string}
   */
  _substituteVariables(text, values = {}, allowedVariables = []) {
    if (!text || typeof text !== 'string') return '';
    if (!values || typeof values !== 'object') return text;

    const allowedSet = Array.isArray(allowedVariables) && allowedVariables.length > 0
      ? new Set(allowedVariables)
      : null;

    const disallowedKeys = new Set(['__proto__', 'constructor', 'prototype']);

    return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}|\{\s*([a-zA-Z0-9_]+)\s*\}/g, (match, p1, p2) => {
      const key = p1 || p2;
      if (disallowedKeys.has(key)) return '';

      if (allowedSet && !allowedSet.has(key)) {
        return match; // Keep unresolved if variable not in allowed set
      }

      if (values[key] !== undefined && values[key] !== null) {
        return String(values[key]);
      }

      return match;
    });
  }

  /**
   * Public alias for variable substitution.
   */
  substituteVariables(text, values = {}, allowedVariables = []) {
    return this._substituteVariables(text, values, allowedVariables);
  }
}

const instance = new AdminNotificationService();
instance.AdminNotificationService = AdminNotificationService;
module.exports = instance;
