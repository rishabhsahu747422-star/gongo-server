'use strict';

const SupportTicketRepository = require('../repositories/support-ticket.repository');
const SupportTicketMessageRepository = require('../repositories/support-ticket-message.repository');
const BookingRepository = require('../repositories/booking.repository');
const notificationService = require('./notification.service');
const {
  TICKET_CATEGORY,
  TICKET_PRIORITY,
  TICKET_STATUS,
  TICKET_SENDER_TYPE,
  SUPPORT_ERROR_CODES,
} = require('../constants/support');
const {
  NOTIFICATION_TYPES,
  NOTIFICATION_SOUNDS,
  NOTIFICATION_CHANNELS,
} = require('../constants/notification');
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require('../errors');
const logger = require('../config/logger');

/**
 * SupportService — business logic orchestration for customer support ticketing,
 * conversation threads, IDOR verification, and notification integration.
 */
class SupportService {
  constructor(
    ticketRepo = new SupportTicketRepository(),
    messageRepo = new SupportTicketMessageRepository(),
    bookingRepo = new BookingRepository(),
    notifService = notificationService,
  ) {
    this.ticketRepository = ticketRepo;
    this.messageRepository = messageRepo;
    this.bookingRepository = bookingRepo;
    this.notificationService = notifService;
  }

  /**
   * Creates a new support ticket and its initial message within a managed transaction.
   *
   * @param {string} customerId
   * @param {object} params
   * @param {string} params.category
   * @param {string} params.subject
   * @param {string} params.message
   * @param {string} [params.bookingId]
   * @param {string} [params.priority]
   * @param {Array<object>} [params.attachments]
   * @returns {Promise<object>}
   */
  async createTicket(customerId, {
    category,
    subject,
    message,
    bookingId = null,
    priority = TICKET_PRIORITY.MEDIUM,
    attachments = [],
  }) {
    // 1. Validate category
    const normalizedCategory = typeof category === 'string' ? category.toUpperCase().trim() : category;
    const validCategories = Object.values(TICKET_CATEGORY).map((c) => (typeof c === 'string' ? c.toUpperCase() : c));
    if (!validCategories.includes(normalizedCategory) && !Object.values(TICKET_CATEGORY).includes(category)) {
      throw new BadRequestError('Invalid support ticket category', SUPPORT_ERROR_CODES.INVALID_CATEGORY);
    }

    // 2. Validate subject
    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      throw new BadRequestError('Subject is required', SUPPORT_ERROR_CODES.EMPTY_MESSAGE);
    }

    // 3. Validate message
    if (!message || typeof message !== 'string' || !message.trim()) {
      throw new BadRequestError('Message cannot be empty', SUPPORT_ERROR_CODES.EMPTY_MESSAGE);
    }

    // 4. Validate priority if provided
    const normalizedPriority = typeof priority === 'string' ? priority.toUpperCase().trim() : priority;
    const validPriorities = Object.values(TICKET_PRIORITY).map((p) => (typeof p === 'string' ? p.toUpperCase() : p));
    if (priority && !validPriorities.includes(normalizedPriority) && !Object.values(TICKET_PRIORITY).includes(priority)) {
      throw new BadRequestError('Invalid priority level', SUPPORT_ERROR_CODES.INVALID_PRIORITY);
    }

    // 5. Booking verification (if bookingId provided)
    let validatedBookingId = null;
    let validatedBookingRef = null;
    if (bookingId) {
      const ownedBooking = await this.bookingRepository.findByIdAndCustomerId(
        bookingId,
        customerId,
      );
      if (!ownedBooking) {
        // Distinguish between not found vs not owned
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(bookingId).trim());
        const anyBooking = isUuid
          ? await this.bookingRepository.query(
            'SELECT id FROM bookings WHERE id = $1 LIMIT 1',
            [bookingId],
          )
          : await this.bookingRepository.query(
            'SELECT id FROM bookings WHERE booking_reference = $1 OR booking_number = $1 LIMIT 1',
            [bookingId],
          );
        if (anyBooking.rows.length > 0) {
          throw new ForbiddenError(
            'Booking does not belong to customer',
            SUPPORT_ERROR_CODES.BOOKING_NOT_OWNED,
          );
        }
        throw new NotFoundError(
          'Booking not found',
          SUPPORT_ERROR_CODES.BOOKING_NOT_FOUND,
        );
      }
      validatedBookingId = ownedBooking.id;
      validatedBookingRef = ownedBooking.bookingReference || ownedBooking.bookingNumber;
    }

    // 6. Create ticket and initial message in transaction
    return this.ticketRepository.transaction(async (client) => {
      const ticket = await this.ticketRepository.create(
        {
          customerId,
          bookingId: validatedBookingId || null,
          category: normalizedCategory,
          subject: subject.trim(),
          description: message.trim(),
          priority: normalizedPriority || TICKET_PRIORITY.MEDIUM,
          status: TICKET_STATUS.OPEN,
        },
        client,
      );

      const firstMessage = await this.messageRepository.create(
        {
          ticketId: ticket.id,
          senderType: TICKET_SENDER_TYPE.CUSTOMER,
          senderId: customerId,
          message: message.trim(),
          attachments: Array.isArray(attachments) ? attachments : [],
        },
        client,
      );

      logger.info('Support ticket created', {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        customerId,
        category,
      });

      return {
        ...ticket,
        messages: [firstMessage],
      };
    });
  }

  /**
   * Lists customer support tickets with pagination and optional filters.
   *
   * @param {string} customerId
   * @param {object} query
   * @returns {Promise<{tickets: object[], pagination: object}>}
   */
  async listTickets(customerId, query = {}) {
    const result = await this.ticketRepository.findByCustomerId(customerId, query);
    return {
      tickets: result.data,
      pagination: result.pagination,
    };
  }

  /**
   * Retrieves a single support ticket and its message history.
   * IDOR Protection: returns 404 if ticket does not belong to customer.
   *
   * @param {string} customerId
   * @param {string} ticketId
   * @returns {Promise<object>}
   */
  async getTicketById(customerId, ticketId) {
    const ticket = await this.ticketRepository.findById(ticketId);

    if (!ticket || ticket.customerId !== customerId) {
      throw new NotFoundError('Support ticket not found', SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);
    }

    const messages = await this.messageRepository.findByTicketId(ticketId);

    return {
      ...ticket,
      messages,
    };
  }

  /**
   * Adds a customer reply to an existing support ticket.
   * Reopens ticket to IN_PROGRESS if previously WAITING_FOR_CUSTOMER or RESOLVED.
   * Rejects if ticket is CLOSED.
   *
   * @param {string} customerId
   * @param {string} ticketId
   * @param {object} params
   * @param {string} params.message
   * @param {Array<object>} [params.attachments]
   * @returns {Promise<object>}
   */
  async addCustomerMessage(customerId, ticketId, { message, attachments = [] }) {
    if (!message || typeof message !== 'string' || !message.trim()) {
      throw new BadRequestError('Message cannot be empty', SUPPORT_ERROR_CODES.EMPTY_MESSAGE);
    }

    const ticket = await this.ticketRepository.findById(ticketId);

    if (!ticket || ticket.customerId !== customerId) {
      throw new NotFoundError('Support ticket not found', SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);
    }

    const currentStatus = (ticket.status || '').toLowerCase();
    if (currentStatus === 'closed') {
      throw new BadRequestError('Cannot reply to a closed ticket', SUPPORT_ERROR_CODES.TICKET_CLOSED);
    }

    return this.ticketRepository.transaction(async (client) => {
      // Reopen if waiting for customer or resolved
      if (
        currentStatus === 'waiting_for_customer'
        || currentStatus === 'waiting_for_user'
        || currentStatus === 'resolved'
      ) {
        await this.ticketRepository.updateStatus(ticketId, TICKET_STATUS.IN_PROGRESS, {}, client);
      }

      const msg = await this.messageRepository.create(
        {
          ticketId,
          senderType: TICKET_SENDER_TYPE.CUSTOMER,
          senderId: customerId,
          message: message.trim(),
          attachments: Array.isArray(attachments) ? attachments : [],
        },
        client,
      );

      logger.info('Customer message appended to ticket', {
        ticketId,
        customerId,
        messageId: msg.id,
      });

      return msg;
    });
  }

  /**
   * Adds a support staff reply to a customer ticket.
   * Updates ticket status to WAITING_FOR_CUSTOMER and fires push notification with custom sound.
   *
   * @param {string} ticketId
   * @param {object} params
   * @param {string} params.supportAgentId
   * @param {string} params.message
   * @param {Array<object>} [params.attachments]
   * @returns {Promise<object>}
   */
  async addSupportReply(ticketId, { supportAgentId, message, attachments = [] }) {
    if (!message || typeof message !== 'string' || !message.trim()) {
      throw new BadRequestError('Message cannot be empty', SUPPORT_ERROR_CODES.EMPTY_MESSAGE);
    }

    const ticket = await this.ticketRepository.findById(ticketId);
    if (!ticket) {
      throw new NotFoundError('Support ticket not found', SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);
    }

    const replyStatus = (ticket.status || '').toLowerCase();
    if (replyStatus === 'closed') {
      throw new BadRequestError('Cannot reply to a closed ticket', SUPPORT_ERROR_CODES.TICKET_CLOSED);
    }

    const msg = await this.ticketRepository.transaction(async (client) => {
      await this.ticketRepository.updateStatus(
        ticketId,
        TICKET_STATUS.WAITING_FOR_CUSTOMER,
        {},
        client,
      );

      return this.messageRepository.create(
        {
          ticketId,
          senderType: TICKET_SENDER_TYPE.SUPPORT,
          senderId: supportAgentId,
          message: message.trim(),
          attachments: Array.isArray(attachments) ? attachments : [],
        },
        client,
      );
    });

    // Send push notification with branded custom sound
    try {
      await this.notificationService.sendNotification({
        customerId: ticket.customerId,
        type: NOTIFICATION_TYPES.SUPPORT_REPLY,
        title: `Support Update: ${ticket.subject}`,
        body: message.length > 100 ? `${message.substring(0, 97)}...` : message,
        data: {
          ticketId: ticket.id,
          ticketNumber: ticket.ticketNumber,
        },
        sound: NOTIFICATION_SOUNDS.DEFAULT,
        channelId: NOTIFICATION_CHANNELS.SUPPORT,
      });
    } catch (notifErr) {
      logger.warn('Failed to dispatch support reply notification', {
        ticketId,
        error: notifErr.message,
      });
    }

    return msg;
  }

  /**
   * Resolves a support ticket.
   *
   * @param {string} ticketId
   * @returns {Promise<object>}
   */
  async resolveTicket(ticketId) {
    const ticket = await this.ticketRepository.findById(ticketId);
    if (!ticket) {
      throw new NotFoundError('Support ticket not found', SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);
    }
    return this.ticketRepository.updateStatus(ticketId, TICKET_STATUS.RESOLVED, {
      resolvedAt: new Date().toISOString(),
    });
  }

  /**
   * Closes a support ticket.
   *
   * @param {string} ticketId
   * @returns {Promise<object>}
   */
  async closeTicket(ticketId) {
    const ticket = await this.ticketRepository.findById(ticketId);
    if (!ticket) {
      throw new NotFoundError('Support ticket not found', SUPPORT_ERROR_CODES.TICKET_NOT_FOUND);
    }
    return this.ticketRepository.updateStatus(ticketId, TICKET_STATUS.CLOSED, {
      closedAt: new Date().toISOString(),
    });
  }
}

module.exports = new SupportService();
