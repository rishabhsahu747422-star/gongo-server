'use strict';

const { ValidationError } = require('../errors');
const { isValidUuid } = require('./index');

const ALLOWED_CATEGORIES = Object.freeze([
  'OTHER',
  'BOOKING',
  'PAYOUT',
  'PAYMENT',
  'DAMAGE',
  'VEHICLE',
  'ACCOUNT',
  'REFUND',
  'DOCUMENT',
  'TECHNICAL',
]);

const ALLOWED_STATUSES = Object.freeze([
  'OPEN',
  'IN_PROGRESS',
  'WAITING_FOR_CUSTOMER',
  'WAITING_FOR_USER',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
]);

const ALLOWED_PRIORITIES = Object.freeze([
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT',
]);

class SupportTicketValidator {
  /**
   * Validates payload for creating a new support ticket.
   *
   * @param {object} body
   * @returns {object} Validated ticket data
   */
  validateCreateTicket(body = {}) {
    const errors = [];

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body must be an object');
    }

    // 1. subject (required, 3-200 chars)
    let { subject } = body;
    if (typeof subject !== 'string' || !subject.trim()) {
      errors.push({ field: 'subject', message: 'Subject is required' });
    } else {
      subject = subject.trim();
      if (subject.length < 3 || subject.length > 200) {
        errors.push({
          field: 'subject',
          message: 'Subject must be between 3 and 200 characters',
        });
      }
    }

    // 2. category (optional, default 'OTHER')
    let category = 'OTHER';
    if (body.category !== undefined && body.category !== null) {
      if (typeof body.category !== 'string') {
        errors.push({ field: 'category', message: 'Category must be a string' });
      } else {
        const normCat = body.category.trim().toUpperCase();
        if (!ALLOWED_CATEGORIES.includes(normCat)) {
          errors.push({
            field: 'category',
            message: `Category must be one of: [${ALLOWED_CATEGORIES.join(', ')}]`,
          });
        } else {
          category = normCat;
        }
      }
    }

    // 3. priority (optional, default 'MEDIUM')
    let priority = 'MEDIUM';
    if (body.priority !== undefined && body.priority !== null) {
      if (typeof body.priority !== 'string') {
        errors.push({ field: 'priority', message: 'Priority must be a string' });
      } else {
        const normPri = body.priority.trim().toUpperCase();
        if (!ALLOWED_PRIORITIES.includes(normPri)) {
          errors.push({
            field: 'priority',
            message: `Priority must be one of: [${ALLOWED_PRIORITIES.join(', ')}]`,
          });
        } else {
          priority = normPri;
        }
      }
    }

    // 4. message (required, 1-5000 chars)
    let { message } = body;
    if (typeof message !== 'string' || !message.trim()) {
      errors.push({ field: 'message', message: 'Initial message is required' });
    } else {
      message = message.trim();
      if (message.length < 1 || message.length > 5000) {
        errors.push({
          field: 'message',
          message: 'Message must be between 1 and 5000 characters',
        });
      }
    }

    // 5. attachments (optional, array of url/storage key strings)
    let attachments = [];
    if (body.attachments !== undefined && body.attachments !== null) {
      if (!Array.isArray(body.attachments)) {
        errors.push({ field: 'attachments', message: 'Attachments must be an array of strings' });
      } else {
        const valid = body.attachments.every((a) => typeof a === 'string' && a.trim().length > 0);
        if (!valid) {
          errors.push({
            field: 'attachments',
            message: 'All attachment items must be non-empty strings',
          });
        } else {
          attachments = body.attachments.map((a) => a.trim());
        }
      }
    }

    if (errors.length > 0) {
      throw new ValidationError('Support ticket validation failed', errors);
    }

    return {
      subject,
      category,
      priority,
      message,
      attachments,
    };
  }

  /**
   * Validates payload for adding a message to an existing ticket.
   *
   * @param {object} body
   * @returns {object} Validated message data
   */
  validateAddMessage(body = {}) {
    const errors = [];

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body must be an object');
    }

    let { message } = body;
    if (typeof message !== 'string' || !message.trim()) {
      errors.push({ field: 'message', message: 'Message text is required' });
    } else {
      message = message.trim();
      if (message.length < 1 || message.length > 5000) {
        errors.push({
          field: 'message',
          message: 'Message must be between 1 and 5000 characters',
        });
      }
    }

    let attachments = [];
    if (body.attachments !== undefined && body.attachments !== null) {
      if (!Array.isArray(body.attachments)) {
        errors.push({ field: 'attachments', message: 'Attachments must be an array of strings' });
      } else {
        const valid = body.attachments.every((a) => typeof a === 'string' && a.trim().length > 0);
        if (!valid) {
          errors.push({
            field: 'attachments',
            message: 'All attachment items must be non-empty strings',
          });
        } else {
          attachments = body.attachments.map((a) => a.trim());
        }
      }
    }

    if (errors.length > 0) {
      throw new ValidationError('Message validation failed', errors);
    }

    return {
      message,
      attachments,
    };
  }

  /**
   * Validates query parameters for listing support tickets.
   *
   * @param {object} [query={}]
   * @returns {object} Sanitized query options
   */
  validateTicketListQuery(query = {}) {
    const errors = [];
    const options = {
      page: 1,
      limit: 20,
      offset: 0,
    };

    if (query.status !== undefined && query.status !== null && query.status !== '') {
      const normStatus = String(query.status).trim().toUpperCase();
      if (!ALLOWED_STATUSES.includes(normStatus) && normStatus !== 'ALL') {
        errors.push({
          field: 'status',
          message: `Status must be one of: [${ALLOWED_STATUSES.join(', ')}, ALL]`,
        });
      } else if (normStatus !== 'ALL') {
        options.status = normStatus;
      }
    }

    if (query.category !== undefined && query.category !== null && query.category !== '') {
      const normCat = String(query.category).trim().toUpperCase();
      if (!ALLOWED_CATEGORIES.includes(normCat) && normCat !== 'ALL') {
        errors.push({
          field: 'category',
          message: `Category must be one of: [${ALLOWED_CATEGORIES.join(', ')}, ALL]`,
        });
      } else if (normCat !== 'ALL') {
        options.category = normCat;
      }
    }

    if (query.priority !== undefined && query.priority !== null && query.priority !== '') {
      const normPri = String(query.priority).trim().toUpperCase();
      if (!ALLOWED_PRIORITIES.includes(normPri) && normPri !== 'ALL') {
        errors.push({
          field: 'priority',
          message: `Priority must be one of: [${ALLOWED_PRIORITIES.join(', ')}, ALL]`,
        });
      } else if (normPri !== 'ALL') {
        options.priority = normPri;
      }
    }

    if (query.partnerId !== undefined && query.partnerId !== null && query.partnerId !== '') {
      if (!isValidUuid(query.partnerId)) {
        errors.push({ field: 'partnerId', message: 'partnerId must be a valid UUID' });
      } else {
        options.partnerId = query.partnerId;
      }
    }

    const parsedPage = parseInt(query.page, 10);
    if (!Number.isNaN(parsedPage)) {
      if (parsedPage < 1) {
        errors.push({ field: 'page', message: 'page must be >= 1' });
      } else {
        options.page = parsedPage;
      }
    }

    const parsedLimit = parseInt(query.limit, 10);
    if (!Number.isNaN(parsedLimit)) {
      if (parsedLimit < 1 || parsedLimit > 100) {
        errors.push({ field: 'limit', message: 'limit must be between 1 and 100' });
      } else {
        options.limit = parsedLimit;
      }
    }

    options.offset = (options.page - 1) * options.limit;

    if (errors.length > 0) {
      throw new ValidationError('Ticket query validation failed', errors);
    }

    return options;
  }

  /**
   * Validates status/priority update from admin.
   *
   * @param {object} body
   * @returns {object} Validated updates
   */
  validateStatusUpdate(body = {}) {
    const errors = [];
    const updates = {};

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body must be an object');
    }

    if (body.status !== undefined) {
      const normStatus = String(body.status).trim().toUpperCase();
      if (!ALLOWED_STATUSES.includes(normStatus)) {
        errors.push({
          field: 'status',
          message: `Status must be one of: [${ALLOWED_STATUSES.join(', ')}]`,
        });
      } else {
        updates.status = normStatus;
      }
    }

    if (body.priority !== undefined) {
      const normPri = String(body.priority).trim().toUpperCase();
      if (!ALLOWED_PRIORITIES.includes(normPri)) {
        errors.push({
          field: 'priority',
          message: `Priority must be one of: [${ALLOWED_PRIORITIES.join(', ')}]`,
        });
      } else {
        updates.priority = normPri;
      }
    }

    if (Object.keys(updates).length === 0) {
      errors.push({
        field: 'status',
        message: 'At least one of status or priority must be provided for update',
      });
    }

    if (errors.length > 0) {
      throw new ValidationError('Status update validation failed', errors);
    }

    return updates;
  }
}

module.exports = new SupportTicketValidator();
