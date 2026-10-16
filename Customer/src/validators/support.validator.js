'use strict';

const { BadRequestError } = require('../errors');
const {
  TICKET_CATEGORY,
  TICKET_PRIORITY,
  TICKET_STATUS,
  SUPPORT_ERROR_CODES,
} = require('../constants/support');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORBIDDEN_CREATE_TICKET_FIELDS = new Set([
  'customerId',
  'customer_id',
  'userId',
  'user_id',
  'id',
  'status',
  'ticketNumber',
  'ticket_number',
  'resolvedAt',
  'resolved_at',
  'closedAt',
  'closed_at',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
]);

const FORBIDDEN_CREATE_MESSAGE_FIELDS = new Set([
  'id',
  'ticketId',
  'ticket_id',
  'senderType',
  'sender_type',
  'senderId',
  'sender_id',
  'createdAt',
  'created_at',
]);

/**
 * Validates ticket creation: POST /api/v1/customers/me/support/tickets
 */
function validateCreateTicket(req, res, next) {
  const { body } = req;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(new BadRequestError('Request body must be a JSON object', 'VALIDATION_ERROR'));
  }

  // Mass assignment rejection
  const keys = Object.keys(body);
  const forbidden = keys.filter((k) => FORBIDDEN_CREATE_TICKET_FIELDS.has(k));
  if (forbidden.length > 0) {
    return next(new BadRequestError(
      `Field(s) not allowed: ${forbidden.join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  const { category, subject, message, bookingId, priority, attachments } = body;

  if (!category || typeof category !== 'string') {
    return next(new BadRequestError('category is required and must be a string', SUPPORT_ERROR_CODES.INVALID_CATEGORY));
  }

  const normalizedCategory = category.toUpperCase().trim();
  const validCategories = Object.values(TICKET_CATEGORY).map((c) => c.toUpperCase());
  if (!validCategories.includes(normalizedCategory)) {
    return next(new BadRequestError(
      `category must be one of: ${Object.values(TICKET_CATEGORY).join(', ')}`,
      SUPPORT_ERROR_CODES.INVALID_CATEGORY,
    ));
  }
  req.body.category = normalizedCategory;

  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    return next(new BadRequestError('subject is required and cannot be empty', 'VALIDATION_ERROR'));
  }
  if (subject.trim().length > 255) {
    return next(new BadRequestError('subject cannot exceed 255 characters', 'VALIDATION_ERROR'));
  }
  req.body.subject = subject.trim();

  if (!message || typeof message !== 'string' || !message.trim()) {
    return next(new BadRequestError('message is required and cannot be empty', SUPPORT_ERROR_CODES.EMPTY_MESSAGE));
  }
  if (message.trim().length > 5000) {
    return next(new BadRequestError('message cannot exceed 5000 characters', 'VALIDATION_ERROR'));
  }
  req.body.message = message.trim();

  if (bookingId !== undefined && bookingId !== null && bookingId !== '') {
    if (typeof bookingId !== 'string' || !UUID_REGEX.test(bookingId)) {
      return next(new BadRequestError('bookingId must be a valid UUID', 'VALIDATION_ERROR'));
    }
    req.body.bookingId = bookingId.trim();
  } else {
    req.body.bookingId = null;
  }

  if (priority !== undefined && priority !== null) {
    if (typeof priority !== 'string') {
      return next(new BadRequestError('priority must be a string', SUPPORT_ERROR_CODES.INVALID_PRIORITY));
    }
    const normalizedPriority = priority.toUpperCase().trim();
    const validPriorities = Object.values(TICKET_PRIORITY).map((p) => p.toUpperCase());
    if (!validPriorities.includes(normalizedPriority)) {
      return next(new BadRequestError(
        `priority must be one of: ${Object.values(TICKET_PRIORITY).join(', ')}`,
        SUPPORT_ERROR_CODES.INVALID_PRIORITY,
      ));
    }
    req.body.priority = normalizedPriority;
  } else {
    req.body.priority = TICKET_PRIORITY.MEDIUM;
  }

  if (attachments !== undefined && attachments !== null) {
    if (!Array.isArray(attachments)) {
      return next(new BadRequestError('attachments must be an array', 'VALIDATION_ERROR'));
    }
    if (attachments.length > 5) {
      return next(new BadRequestError('Maximum 5 attachments allowed per message', 'VALIDATION_ERROR'));
    }
  }

  return next();
}

/**
 * Validates ticket list query params: GET /api/v1/customers/me/support/tickets
 */
function validateListTickets(req, res, next) {
  const { page, limit, status, category } = req.query;

  if (page !== undefined) {
    const pageNum = Number(page);
    if (!Number.isInteger(pageNum) || pageNum < 1) {
      return next(new BadRequestError('page must be an integer >= 1', 'VALIDATION_ERROR'));
    }
    req.query.page = pageNum;
  }

  if (limit !== undefined) {
    const limitNum = Number(limit);
    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 50) {
      return next(new BadRequestError('limit must be an integer between 1 and 50', 'VALIDATION_ERROR'));
    }
    req.query.limit = limitNum;
  }

  if (status !== undefined) {
    const normalizedStatus = String(status).toLowerCase().trim();
    const validStatuses = Object.values(TICKET_STATUS).map((s) => s.toLowerCase());
    if (!validStatuses.includes(normalizedStatus)) {
      return next(new BadRequestError(
        `status must be one of: ${Object.values(TICKET_STATUS).join(', ')}`,
        'VALIDATION_ERROR',
      ));
    }
    req.query.status = normalizedStatus;
  }

  if (category !== undefined) {
    const normalizedCategory = String(category).toLowerCase().trim();
    const validCategories = Object.values(TICKET_CATEGORY).map((c) => c.toLowerCase());
    if (!validCategories.includes(normalizedCategory)) {
      return next(new BadRequestError(
        `category must be one of: ${Object.values(TICKET_CATEGORY).join(', ')}`,
        SUPPORT_ERROR_CODES.INVALID_CATEGORY,
      ));
    }
    req.query.category = normalizedCategory;
  }

  return next();
}

/**
 * Validates ticketId UUID path parameter.
 */
function validateTicketId(req, res, next) {
  const { ticketId } = req.params;
  if (!ticketId || !UUID_REGEX.test(ticketId)) {
    return next(new BadRequestError('Invalid ticket ID format (must be UUID)', 'VALIDATION_ERROR'));
  }
  return next();
}

/**
 * Validates message creation: POST /api/v1/customers/me/support/tickets/:ticketId/messages
 */
function validateCreateMessage(req, res, next) {
  const { body } = req;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(new BadRequestError('Request body must be a JSON object', 'VALIDATION_ERROR'));
  }

  // Mass assignment rejection
  const keys = Object.keys(body);
  const forbidden = keys.filter((k) => FORBIDDEN_CREATE_MESSAGE_FIELDS.has(k));
  if (forbidden.length > 0) {
    return next(new BadRequestError(
      `Field(s) not allowed: ${forbidden.join(', ')}`,
      'VALIDATION_ERROR',
    ));
  }

  const { message, attachments } = body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return next(new BadRequestError('message is required and cannot be empty', SUPPORT_ERROR_CODES.EMPTY_MESSAGE));
  }
  if (message.trim().length > 5000) {
    return next(new BadRequestError('message cannot exceed 5000 characters', 'VALIDATION_ERROR'));
  }
  req.body.message = message.trim();

  if (attachments !== undefined && attachments !== null) {
    if (!Array.isArray(attachments)) {
      return next(new BadRequestError('attachments must be an array', 'VALIDATION_ERROR'));
    }
    if (attachments.length > 5) {
      return next(new BadRequestError('Maximum 5 attachments allowed per message', 'VALIDATION_ERROR'));
    }
  }

  return next();
}

module.exports = {
  validateCreateTicket,
  validateListTickets,
  validateTicketId,
  validateCreateMessage,
};
