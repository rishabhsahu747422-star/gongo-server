'use strict';

const crypto = require('crypto');
const SupportTicketRepository = require('../repositories/support-ticket.repository');
const PartnerRepository = require('../repositories/partner.repository');
const auditService = require('./audit.service');
const { NotFoundError, ForbiddenError, BadRequestError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class SupportTicketService {
  constructor(
    supportTicketRepo = new SupportTicketRepository(),
    partnerRepo = new PartnerRepository(),
  ) {
    this.supportTicketRepository = supportTicketRepo;
    this.partnerRepository = partnerRepo;
  }

  /**
   * Generates a cryptographically random, collision-resistant ticket number.
   * Format: TKT-YYYYMM-XXXXXX
   *
   * @private
   * @returns {string}
   */
  _generateTicketNumber() {
    const dateStr = new Date().toISOString().slice(0, 7).replace('-', '');
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `TKT-${dateStr}-${rand}`;
  }

  /**
   * Formats a raw database ticket entity into standard API response.
   *
   * @private
   * @param {object} t
   * @returns {object}
   */
  _formatTicket(t) {
    return {
      id: t.id,
      partnerId: t.partner_id,
      userId: t.user_id,
      ticketNumber: t.ticket_number,
      category: t.category,
      subject: t.subject,
      description: t.description,
      message: t.description,
      status: t.status,
      priority: t.priority,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      messageCount: t.message_count !== undefined ? Number(t.message_count) : undefined,
      lastMessageAt: t.last_message_at || undefined,
      partner: (t.partner_name || t.business_name) ? {
        name: t.partner_name,
        businessName: t.business_name,
        phone: t.partner_phone,
        email: t.partner_email,
      } : undefined,
      messages: Array.isArray(t.messages)
        ? t.messages.map((m) => {
          let atts = m.attachments;
          if (typeof atts === 'string') {
            try { atts = JSON.parse(atts); } catch { atts = []; }
          }
          return {
            id: m.id,
            ticketId: m.ticket_id,
            senderType: m.sender_type,
            senderId: m.sender_id,
            message: m.message,
            attachments: Array.isArray(atts) ? atts : [],
            createdAt: m.created_at,
          };
        })
        : undefined,
    };
  }

  /**
   * Partner creates a new support ticket.
   *
   * @param {string} partnerId
   * @param {object} data
   * @param {string} [requestId]
   * @returns {Promise<object>}
   */
  async createTicket(partnerId, data, requestId = null) {
    const partner = await this.partnerRepository.findById(partnerId);
    if (!partner) {
      throw new NotFoundError('Partner account not found', ERROR_CODES.NOT_FOUND);
    }
    if (partner.is_active === false) {
      throw new ForbiddenError('Partner account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    const userId = data.userId || partner.userId || partner.user_id || partner.id;

    const ticketNumber = this._generateTicketNumber();

    const created = await this.supportTicketRepository.createTicketWithInitialMessage({
      partnerId,
      userId,
      ticketNumber,
      category: data.category,
      subject: data.subject,
      description: data.message,
      priority: data.priority,
      message: data.message,
      attachments: data.attachments,
    });

    auditService.logEvent({
      actorId: partnerId,
      actorRole: 'PARTNER',
      action: 'SUPPORT_TICKET_CREATED',
      entityType: 'SUPPORT_TICKET',
      entityId: created.id,
      requestId,
      metadata: {
        ticketNumber: created.ticket_number,
        category: created.category,
        priority: created.priority,
      },
    });

    return this._formatTicket(created);
  }

  /**
   * Partner lists their support tickets.
   *
   * @param {string} partnerId
   * @param {object} options
   * @returns {Promise<object>}
   */
  async getPartnerTickets(partnerId, options = {}) {
    const { rows, total } = await this.supportTicketRepository.findTicketsByPartnerId(
      partnerId,
      options,
    );

    const items = rows.map((r) => this._formatTicket(r));
    const page = options.page || 1;
    const limit = options.limit || 20;
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      pagination: {
        page,
        limit,
        totalItems: total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Partner gets details and message thread of their ticket (strict BOLA).
   *
   * @param {string} partnerId
   * @param {string} ticketId
   * @returns {Promise<object>}
   */
  async getPartnerTicketById(partnerId, ticketId) {
    const ticket = await this.supportTicketRepository.findTicketByIdAndPartnerId(
      ticketId,
      partnerId,
    );

    if (!ticket) {
      throw new NotFoundError(
        'Support ticket not found or unauthorized',
        ERROR_CODES.NOT_FOUND,
      );
    }

    return this._formatTicket(ticket);
  }

  /**
   * Partner replies to an existing ticket.
   *
   * @param {string} partnerId
   * @param {string} ticketId
   * @param {object} data
   * @param {string} [requestId]
   * @returns {Promise<object>}
   */
  async addPartnerMessage(partnerId, ticketId, data, requestId = null) {
    const ticket = await this.supportTicketRepository.findTicketByIdAndPartnerId(
      ticketId,
      partnerId,
    );

    if (!ticket) {
      throw new NotFoundError(
        'Support ticket not found or unauthorized',
        ERROR_CODES.NOT_FOUND,
      );
    }

    if (ticket.status === 'CLOSED') {
      throw new BadRequestError(
        'Cannot reply to a closed ticket. This support ticket has been closed.',
        ERROR_CODES.TICKET_CLOSED || 'TICKET_CLOSED',
      );
    }

    // If ticket was resolved, partner replying re-opens it to IN_PROGRESS
    const reopenStatus = ticket.status === 'RESOLVED' ? 'IN_PROGRESS' : null;

    const message = await this.supportTicketRepository.addMessage({
      ticketId,
      senderType: 'PARTNER',
      senderId: ticket.user_id || partnerId,
      message: data.message,
      attachments: data.attachments,
      reopenStatus,
    });

    auditService.logEvent({
      actorId: partnerId,
      actorRole: 'PARTNER',
      action: 'SUPPORT_TICKET_MESSAGE_ADDED',
      entityType: 'SUPPORT_TICKET_MESSAGE',
      entityId: message.id,
      requestId,
      metadata: {
        ticketId,
        reopened: Boolean(reopenStatus),
      },
    });

    let atts = message.attachments;
    if (typeof atts === 'string') {
      try { atts = JSON.parse(atts); } catch { atts = []; }
    }

    return {
      id: message.id,
      ticketId: message.ticket_id,
      senderType: message.sender_type,
      senderId: message.sender_id,
      message: message.message,
      attachments: Array.isArray(atts) ? atts : [],
      createdAt: message.created_at,
    };
  }

  /**
   * Admin lists all tickets across all partners.
   *
   * @param {object} options
   * @returns {Promise<object>}
   */
  async getAdminTickets(options = {}) {
    const { rows, total } = await this.supportTicketRepository.findAllTicketsAdmin(options);

    const items = rows.map((r) => this._formatTicket(r));
    const page = options.page || 1;
    const limit = options.limit || 20;
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      pagination: {
        page,
        limit,
        totalItems: total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Admin gets full ticket details with all messages and partner context.
   *
   * @param {string} ticketId
   * @returns {Promise<object>}
   */
  async getAdminTicketById(ticketId) {
    const ticket = await this.supportTicketRepository.findTicketByIdAdmin(ticketId);
    if (!ticket) {
      throw new NotFoundError('Support ticket not found', ERROR_CODES.NOT_FOUND);
    }
    return this._formatTicket(ticket);
  }

  /**
   * Admin updates ticket status and/or priority.
   *
   * @param {string} ticketId
   * @param {object} updates
   * @param {string} adminId
   * @param {string} [requestId]
   * @returns {Promise<object>}
   */
  async updateAdminTicketStatus(ticketId, updates, adminId, requestId = null) {
    const existing = await this.supportTicketRepository.findById(ticketId);
    if (!existing) {
      throw new NotFoundError('Support ticket not found', ERROR_CODES.NOT_FOUND);
    }

    const updated = await this.supportTicketRepository.updateTicketStatus(ticketId, updates);

    auditService.logEvent({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'SUPPORT_TICKET_STATUS_UPDATED',
      entityType: 'SUPPORT_TICKET',
      entityId: ticketId,
      requestId,
      metadata: {
        oldStatus: existing.status,
        newStatus: updated.status,
        oldPriority: existing.priority,
        newPriority: updated.priority,
      },
    });

    return this._formatTicket(updated);
  }

  /**
   * Admin adds a response message to a ticket.
   *
   * @param {string} adminId
   * @param {string} ticketId
   * @param {object} data
   * @param {string} [requestId]
   * @returns {Promise<object>}
   */
  async addAdminMessage(adminId, ticketId, data, requestId = null) {
    const ticket = await this.supportTicketRepository.findById(ticketId);
    if (!ticket) {
      throw new NotFoundError('Support ticket not found', ERROR_CODES.NOT_FOUND);
    }

    const message = await this.supportTicketRepository.addMessage({
      ticketId,
      senderType: 'SUPPORT',
      senderId: adminId,
      message: data.message,
      attachments: data.attachments,
    });

    auditService.logEvent({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'SUPPORT_TICKET_ADMIN_REPLIED',
      entityType: 'SUPPORT_TICKET_MESSAGE',
      entityId: message.id,
      requestId,
      metadata: { ticketId },
    });

    return {
      id: message.id,
      ticketId: message.ticket_id,
      senderType: message.sender_type,
      senderId: message.sender_id,
      message: message.message,
      attachments: message.attachments || [],
      createdAt: message.created_at,
    };
  }
}

module.exports = new SupportTicketService();
