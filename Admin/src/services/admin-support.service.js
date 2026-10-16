'use strict';

const { validate: uuidValidate } = require('uuid');

const AdminSupportRepository = require('../repositories/admin-support.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const adminNotificationService = require('./admin-notification.service');
const auditService = require('./audit.service');
const s3Provider = require('../providers/s3');
const logger = require('../config/logger');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_NUMBER_REGEX = /^TKT-[0-9]{6}-[0-9A-F]{6}$/i;

function isUuid(id) {
  return Boolean(id && typeof id === 'string' && (uuidValidate(id) || UUID_REGEX.test(id)));
}

function assertUuid(id, fieldName = 'ID') {
  if (!id || typeof id !== 'string' || (!uuidValidate(id) && !UUID_REGEX.test(id))) {
    throw new BadRequestError(`Invalid ${fieldName}: must be a valid RFC 4122 UUID v4`, ERROR_CODES.VALIDATION_ERROR);
  }
  return id;
}

function assertTicketIdentifier(id, fieldName = 'ticketId') {
  if (!id || typeof id !== 'string') {
    throw new BadRequestError(`Invalid ${fieldName}: must be a valid RFC 4122 UUID v4 or ticket number`, ERROR_CODES.VALIDATION_ERROR);
  }
  const trimmed = id.trim();
  if (isUuid(trimmed) || TICKET_NUMBER_REGEX.test(trimmed) || trimmed.startsWith('TKT-')) {
    return trimmed;
  }
  throw new BadRequestError(`Invalid ${fieldName}: must be a valid RFC 4122 UUID v4`, ERROR_CODES.VALIDATION_ERROR);
}

const VALID_STATUSES = new Set([
  'OPEN',
  'IN_PROGRESS',
  'WAITING_FOR_CUSTOMER',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
]);

const VALID_PRIORITIES = new Set([
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT',
]);

const VALID_CATEGORIES = new Set([
  'BOOKING',
  'PAYMENT',
  'PAYOUT',
  'VEHICLE',
  'DAMAGE',
  'PARTNER',
  'ACCOUNT',
  'DOCUMENT',
  'TECHNICAL',
  'OTHER',
]);

/**
 * Strict state machine allowed transitions.
 * Terminal status 'CLOSED' cannot transition to other statuses except 'REOPENED'.
 * Status transitions must strictly follow this table.
 */
const ALLOWED_STATUS_TRANSITIONS = {
  OPEN: new Set(['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED']),
  IN_PROGRESS: new Set(['WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED']),
  WAITING_FOR_CUSTOMER: new Set(['IN_PROGRESS', 'RESOLVED', 'CLOSED']),
  RESOLVED: new Set(['CLOSED', 'REOPENED', 'IN_PROGRESS']),
  CLOSED: new Set(['REOPENED']),
  REOPENED: new Set(['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED']),
};

async function signAttachmentUrls(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  return Promise.all(
    attachments.map(async (att) => {
      const key = typeof att === 'string' ? att : att?.url || att?.key;
      if (!key || typeof key !== 'string') return null;

      if (key.startsWith('http://') || key.startsWith('https://')) {
        return {
          key,
          url: key,
          downloadUrl: key,
          filename: typeof att === 'object' ? att.filename : null,
          mimeType: typeof att === 'object' ? att.mimeType : null,
          size: typeof att === 'object' ? att.size : null,
        };
      }

      try {
        const presigned = await s3Provider.createPresignedGetUrl({
          key,
          expiresInSeconds: 900,
        });
        return {
          key,
          url: presigned.downloadUrl,
          downloadUrl: presigned.downloadUrl,
          expiresInSeconds: 900,
          filename: typeof att === 'object' ? att.filename : null,
          mimeType: typeof att === 'object' ? att.mimeType : null,
          size: typeof att === 'object' ? att.size : null,
        };
      } catch (_) {
        return {
          key,
          url: null,
          downloadUrl: null,
          filename: typeof att === 'object' ? att.filename : null,
        };
      }
    }),
  ).then((results) => results.filter(Boolean));
}

class AdminSupportService {
  constructor() {
    this.supportRepo = new AdminSupportRepository();
    this.actionRepo = adminActionRepository;
    this.notificationService = adminNotificationService;
  }

  /**
   * Resolves the original ticket raiser's sender type strictly from the earliest message
   * or cross-checks with authoritative ticket creator relationships.
   */
  _resolveTicketRaiserType(row) {
    if (!row) return 'UNKNOWN';
    const rawSender = (row.original_sender_type || '').toUpperCase().trim();
    if (rawSender === 'PARTNER') return 'PARTNER';
    if (rawSender === 'CUSTOMER') return 'CUSTOMER';
    if (rawSender === 'SUPPORT' || rawSender === 'ADMIN') return 'ADMIN';
    if (rawSender === 'SYSTEM') return 'SYSTEM';

    // If no message found yet, cross-check with ticket's authoritative relationships
    if (row.partner_id) return 'PARTNER';
    if (row.customer_id) return 'CUSTOMER';

    if (rawSender) return rawSender;
    return 'UNKNOWN';
  }

  /**
   * Resolves the human-readable submitter name for the ticket.
   */
  _resolveSubmitterName(row, senderType) {
    if (!row) return null;
    if (senderType === 'PARTNER') {
      return row.partner_business_name || row.partner_owner_name || null;
    }
    if (senderType === 'CUSTOMER') {
      return row.customer_name || null;
    }
    if (senderType === 'ADMIN') {
      return row.assigned_admin_name || 'Admin / Support';
    }
    return row.customer_name || row.partner_business_name || row.partner_owner_name || null;
  }

  /**
   * Safe ticket projection filtering out internal sensitive fields.
   */
  _mapTicketSummary(row) {
    if (!row) return null;
    const senderType = this._resolveTicketRaiserType(row);
    const submitterName = this._resolveSubmitterName(row, senderType);

    return {
      id: row.id,
      ticketNumber: row.ticket_number,
      customerId: row.customer_id,
      partnerId: row.partner_id,
      bookingId: row.booking_id,
      category: row.category,
      subject: row.subject,
      description: row.description || '',
      status: row.status,
      priority: row.priority,
      senderType,
      raisedBy: senderType,
      submitterName,
      assignedTo: row.assigned_to,
      assignedAt: row.assigned_at,
      resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at,
      closedAt: row.closed_at,
      resolutionNotes: row.resolution_notes,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      user: row.partner_id ? (row.partner_business_name || row.partner_owner_name || 'Partner') : (row.customer_name || 'Customer'),
      userName: row.partner_id ? (row.partner_business_name || row.partner_owner_name || 'Partner') : (row.customer_name || 'Customer'),
      userType: row.partner_id ? 'Partner' : (row.customer_id ? 'Customer' : 'User'),
      customer: row.customer_id ? {
        id: row.customer_id,
        name: row.customer_name,
        phone: row.customer_phone,
        email: row.customer_email,
      } : null,
      partner: row.partner_id ? {
        id: row.partner_id,
        businessName: row.partner_business_name,
        ownerName: row.partner_owner_name,
        phone: row.partner_phone,
      } : null,
      booking: row.booking_id ? {
        id: row.booking_id,
        bookingNumber: row.booking_number,
        bookingStatus: row.booking_status,
      } : null,
      assignedAdmin: row.assigned_to ? {
        id: row.assigned_to,
        name: row.assigned_admin_name,
        email: row.assigned_admin_email,
      } : null,
      resolvedByAdmin: row.resolved_by ? {
        id: row.resolved_by,
        name: row.resolved_by_admin_name,
      } : null,
      messageCount: parseInt(row.message_count, 10) || 0,
      lastMessageAt: row.last_message_at,
    };
  }

  /**
   * Safe ticket detail projection with nested summaries.
   */
  _mapTicketDetail(row) {
    if (!row) return null;
    const senderType = this._resolveTicketRaiserType(row);
    const submitterName = this._resolveSubmitterName(row, senderType);

    return {
      id: row.id,
      ticketNumber: row.ticket_number,
      customerId: row.customer_id,
      partnerId: row.partner_id,
      bookingId: row.booking_id,
      category: row.category,
      subject: row.subject,
      description: row.description || '',
      status: row.status,
      priority: row.priority,
      senderType,
      raisedBy: senderType,
      submitterName,
      assignedTo: row.assigned_to,
      assignedAt: row.assigned_at,
      resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at,
      closedAt: row.closed_at,
      resolutionNotes: row.resolution_notes,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      customer: row.customer_id ? {
        id: row.customer_id,
        name: row.customer_name,
        phone: row.customer_phone,
        email: row.customer_email,
        isActive: row.customer_is_active,
      } : null,
      partner: row.partner_id ? {
        id: row.partner_id,
        businessName: row.partner_business_name,
        city: row.partner_city,
        kycStatus: row.partner_kyc_status,
        ownerName: row.partner_owner_name,
        ownerPhone: row.partner_phone,
        ownerEmail: row.partner_email,
      } : null,
      booking: row.booking_id ? {
        id: row.booking_id,
        bookingNumber: row.booking_number,
        bookingStatus: row.booking_status,
        paymentStatus: row.booking_payment_status,
        startDate: row.booking_start_date,
        endDate: row.booking_end_date,
        totalAmount: row.booking_total_amount,
        vehicleId: row.booking_vehicle_id,
        vehicle: row.vehicle_id ? {
          id: row.vehicle_id,
          make: row.vehicle_make,
          model: row.vehicle_model,
          registrationNumber: row.vehicle_registration_number,
          category: row.vehicle_category,
        } : null,
      } : null,
      assignedAdmin: row.assigned_to ? {
        id: row.assigned_to,
        name: row.assigned_admin_name,
        email: row.assigned_admin_email,
      } : null,
      resolvedByAdmin: row.resolved_by ? {
        id: row.resolved_by,
        name: row.resolved_by_admin_name,
        email: row.resolved_by_admin_email,
      } : null,
      messageCount: parseInt(row.message_count, 10) || 0,
      lastMessageAt: row.last_message_at,
    };
  }

  /**
   * 1. Support ticket listing with rich filters, search, pagination, and sorting.
   */
  async listTickets(query = {}) {
    const {
      search,
      status,
      priority,
      category,
      assignedTo,
      customerId,
      partnerId,
      bookingId,
      startDate,
      endDate,
      updatedStartDate,
      updatedEndDate,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
    } = query;

    if (assignedTo) assertUuid(assignedTo, 'assignedTo');
    if (customerId) assertUuid(customerId, 'customerId');
    if (partnerId) assertUuid(partnerId, 'partnerId');
    if (bookingId) assertUuid(bookingId, 'bookingId');

    if (status && !VALID_STATUSES.has(status.toUpperCase())) {
      throw new BadRequestError(`Invalid status filter: '${status}'`, ERROR_CODES.VALIDATION_ERROR);
    }
    if (priority && !VALID_PRIORITIES.has(priority.toUpperCase())) {
      throw new BadRequestError(`Invalid priority filter: '${priority}'`, ERROR_CODES.VALIDATION_ERROR);
    }
    if (category && !VALID_CATEGORIES.has(category.toUpperCase())) {
      throw new BadRequestError(`Invalid category filter: '${category}'`, ERROR_CODES.VALIDATION_ERROR);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const res = await this.supportRepo.listTickets({
      search,
      status: status ? status.toUpperCase() : null,
      priority: priority ? priority.toUpperCase() : null,
      category: category ? category.toUpperCase() : null,
      assignedTo,
      customerId,
      partnerId,
      bookingId,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      updatedStartDate: updatedStartDate ? new Date(updatedStartDate) : null,
      updatedEndDate: updatedEndDate ? new Date(updatedEndDate) : null,
      limit: limitNum,
      offset,
      sortBy,
      sortOrder,
    });

    return {
      tickets: res.tickets.map((t) => this._mapTicketSummary(t)),
      pagination: {
        total: res.total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(res.total / limitNum) || 1,
      },
    };
  }

  /**
   * 2. Ticket Detail by ID.
   */
  async getTicketById(id) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const ticket = await this.supportRepo.getTicketById(ticketId);
    if (!ticket) {
      throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
    }
    return this._mapTicketDetail(ticket);
  }

  /**
   * 3. Ticket messages history.
   */
  async getTicketMessages(id) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const ticket = await this.supportRepo.getTicketById(ticketId);
    if (!ticket) {
      throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    const messages = await this.supportRepo.getTicketMessages(ticketId);
    const mapped = await Promise.all(
      messages.map(async (m) => {
        let atts = m.attachments;
        if (typeof atts === 'string') {
          try {
            atts = JSON.parse(atts);
          } catch {
            atts = [];
          }
        }
        const signed = await signAttachmentUrls(Array.isArray(atts) ? atts : []);
        return {
          id: m.id,
          ticketId: m.ticket_id,
          senderType: m.sender_type,
          senderId: m.sender_id,
          message: m.message,
          attachments: signed,
          createdAt: m.created_at,
          sender: m.sender_id ? {
            id: m.sender_id,
            name: m.sender_name,
            role: m.sender_role,
            email: m.sender_email,
          } : null,
        };
      }),
    );

    return {
      ticketId: ticket.id,
      ticketNumber: ticket.ticket_number,
      status: ticket.status,
      messages: mapped,
    };
  }

  /**
   * 4. Ticket timeline history.
   */
  async getTicketTimeline(id) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const ticket = await this.supportRepo.getTicketById(ticketId);
    if (!ticket) {
      throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    const [messages, auditLogs] = await Promise.all([
      this.supportRepo.getTicketMessages(ticketId),
      this.supportRepo.getTicketAuditLogs(ticketId),
    ]);

    const events = [];

    // 1. Creation milestone
    events.push({
      eventType: 'TICKET_CREATED',
      timestamp: ticket.created_at,
      actor: ticket.customer_name || ticket.partner_owner_name || 'System',
      description: `Support ticket #${ticket.ticket_number} created with status '${ticket.status}' and priority '${ticket.priority}'`,
      metadata: {
        category: ticket.category,
        subject: ticket.subject,
        description: ticket.description || '',
      },
    });

    // 2. Assignment milestone if present
    if (ticket.assigned_at) {
      events.push({
        eventType: 'TICKET_ASSIGNED',
        timestamp: ticket.assigned_at,
        actor: ticket.assigned_admin_name || 'Admin',
        description: `Ticket assigned to admin ${ticket.assigned_admin_name || ticket.assigned_to}`,
        metadata: {
          assignedTo: ticket.assigned_to,
        },
      });
    }

    // 3. Resolution milestone if present
    if (ticket.resolved_at) {
      events.push({
        eventType: 'TICKET_RESOLVED',
        timestamp: ticket.resolved_at,
        actor: ticket.resolved_by_admin_name || 'Admin Resolver',
        description: `Ticket resolved: ${ticket.resolution_notes || 'Issue marked as resolved'}`,
        metadata: {
          resolvedBy: ticket.resolved_by,
          resolutionNotes: ticket.resolution_notes,
        },
      });
    }

    // 4. Closure milestone if present
    if (ticket.closed_at) {
      events.push({
        eventType: 'TICKET_CLOSED',
        timestamp: ticket.closed_at,
        actor: 'Admin/System',
        description: 'Support ticket closed.',
      });
    }

    // 5. Add audit actions
    auditLogs.forEach((log) => {
      events.push({
        eventType: log.action,
        timestamp: log.created_at,
        actor: log.actor_name || log.actor_role || 'ADMIN',
        description: `Admin action: ${log.action}`,
        beforeState: log.before_state,
        afterState: log.after_state,
        metadata: log.metadata,
      });
    });

    // 6. Add messages summary
    messages.forEach((msg) => {
      events.push({
        eventType: 'MESSAGE_SENT',
        timestamp: msg.created_at,
        actor: msg.sender_name || msg.sender_type,
        description: `[${msg.sender_type}] ${msg.message.length > 80 ? `${msg.message.substring(0, 80)}...` : msg.message}`,
        metadata: {
          messageId: msg.id,
          senderType: msg.sender_type,
          senderId: msg.sender_id,
        },
      });
    });

    // Sort chronologically
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return {
      ticketId: ticket.id,
      ticketNumber: ticket.ticket_number,
      status: ticket.status,
      priority: ticket.priority,
      timeline: events,
    };
  }

  /**
   * 5. Customer ownership details for a ticket.
   */
  async getTicketCustomer(id) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const ticket = await this.supportRepo.getTicketById(ticketId);
    if (!ticket) {
      throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    if (!ticket.customer_id) {
      return {
        ticketId: ticket.id,
        customer: null,
      };
    }

    const customer = await this.supportRepo.getTicketCustomer(ticketId);
    return {
      ticketId: ticket.id,
      customer: customer ? {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        role: customer.role,
        isActive: customer.is_active,
        createdAt: customer.created_at,
        totalBookings: customer.total_bookings || 0,
        totalTickets: customer.total_tickets || 0,
      } : null,
    };
  }

  /**
   * 6. Partner ownership details for a ticket.
   */
  async getTicketPartner(id) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const ticket = await this.supportRepo.getTicketById(ticketId);
    if (!ticket) {
      throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    if (!ticket.partner_id) {
      return {
        ticketId: ticket.id,
        partner: null,
      };
    }

    const partner = await this.supportRepo.getTicketPartner(ticketId);
    return {
      ticketId: ticket.id,
      partner: partner ? {
        id: partner.id,
        userId: partner.user_id,
        businessName: partner.business_name,
        businessAddress: partner.business_address,
        city: partner.city,
        partnerStatus: partner.partner_status,
        kycStatus: partner.kyc_status,
        ownerName: partner.owner_name,
        ownerPhone: partner.owner_phone,
        ownerEmail: partner.owner_email,
        ownerIsActive: partner.owner_is_active,
        createdAt: partner.created_at,
        activeVehicles: partner.active_vehicles || 0,
        totalBookings: partner.total_bookings || 0,
        totalTickets: partner.total_tickets || 0,
      } : null,
    };
  }

  /**
   * 7. Booking linkage details for a ticket.
   */
  async getTicketBooking(id) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const ticket = await this.supportRepo.getTicketById(ticketId);
    if (!ticket) {
      throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
    }

    if (!ticket.booking_id) {
      return {
        ticketId: ticket.id,
        booking: null,
      };
    }

    const booking = await this.supportRepo.getTicketBooking(ticketId);
    return {
      ticketId: ticket.id,
      booking: booking ? {
        id: booking.id,
        bookingNumber: booking.booking_number,
        customerId: booking.customer_id,
        partnerId: booking.partner_id,
        vehicleId: booking.vehicle_id,
        bookingStatus: booking.booking_status,
        paymentStatus: booking.payment_status,
        startDate: booking.start_date,
        endDate: booking.end_date,
        baseFare: booking.base_fare,
        totalAmount: booking.total_amount,
        securityDeposit: booking.security_deposit,
        createdAt: booking.created_at,
        customer: {
          name: booking.customer_name,
          phone: booking.customer_phone,
          email: booking.customer_email,
        },
        partner: {
          businessName: booking.partner_business_name,
          ownerName: booking.partner_owner_name,
          phone: booking.partner_phone,
        },
        vehicle: booking.vehicle_id ? {
          make: booking.vehicle_make,
          model: booking.vehicle_model,
          registrationNumber: booking.vehicle_registration_number,
          category: booking.vehicle_category,
        } : null,
      } : null,
    };
  }

  /**
   * 8. Update Ticket Status (State Machine Enforced + Transactional + Audited).
   */
  async updateStatus(id, payload, adminUser, auditMeta = {}) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const { status, reason } = payload || {};

    if (!status || typeof status !== 'string') {
      throw new BadRequestError('Status is required', ERROR_CODES.VALIDATION_ERROR);
    }
    const targetStatus = status.toUpperCase().trim();
    if (!VALID_STATUSES.has(targetStatus)) {
      throw new BadRequestError(`Invalid status: '${status}'`, ERROR_CODES.VALIDATION_ERROR);
    }

    const result = await this.supportRepo.withTransaction(async (client) => {
      const ticket = await this.supportRepo.getTicketForUpdate(client, ticketId);
      if (!ticket) {
        throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
      }

      // Idempotency: if already in target status, return cleanly without duplicating audit
      if (ticket.status === targetStatus) {
        const currentDetail = await this.supportRepo.getTicketById(ticket.id, client);
        return { detail: this._mapTicketDetail(currentDetail), ticket, isNoop: true };
      }

      const allowedNext = ALLOWED_STATUS_TRANSITIONS[ticket.status] || new Set();
      if (!allowedNext.has(targetStatus)) {
        throw new ConflictError(
          `Invalid state transition: Cannot transition ticket from '${ticket.status}' to '${targetStatus}'.`,
          ERROR_CODES.CONFLICT,
        );
      }

      let changerId = (adminUser?.id && isUuid(adminUser.id)) ? adminUser.id : null;
      if (!changerId) {
        try {
          const fallbackAdmin = await this.supportRepo.findFallbackAdminUser(adminUser?.email || adminUser?.auth_id, client);
          if (fallbackAdmin) changerId = fallbackAdmin.id;
        } catch (_) {}
      }
      if (!changerId) changerId = adminUser?.id;

      const updates = { status: targetStatus };
      if (targetStatus === 'RESOLVED') {
        updates.resolved_by = changerId;
        updates.resolved_at = new Date();
        if (reason) updates.resolution_notes = reason.trim();
      } else if (targetStatus === 'CLOSED') {
        updates.closed_at = new Date();
      }

      await this.supportRepo.updateTicket(client, ticket.id, updates);
      await this.supportRepo.recordStatusHistory(client, {
        ticketId: ticket.id,
        oldStatus: ticket.status,
        newStatus: targetStatus,
        changedBy: changerId,
        reason: reason || null,
      });

      // Audit log
      auditService.logAdminAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.update',
        action: `SUPPORT_TICKET_STATUS_${targetStatus}`,
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { status: ticket.status },
        afterState: { status: targetStatus },
        metadata: { reason: reason || null },
      });

      await this.actionRepo.createAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.update',
        action: `SUPPORT_TICKET_STATUS_${targetStatus}`,
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { status: ticket.status },
        afterState: { status: targetStatus },
        metadata: { reason: reason || null },
      }, client);

      const freshDetail = await this.supportRepo.getTicketById(ticket.id, client);
      return { detail: this._mapTicketDetail(freshDetail), ticket, isNoop: false };
    });

    if (!result.isNoop && (targetStatus === 'RESOLVED' || targetStatus === 'CLOSED')) {
      try {
        const ticket = result.ticket;
        const isPartner = Boolean(ticket.partner_id);
        const recipientId = isPartner ? ticket.partner_id : ticket.customer_id;
        const recipientType = isPartner ? 'PARTNER' : 'CUSTOMER';

        if (recipientId && this.notificationService && typeof this.notificationService.sendNotification === 'function') {
          const isClosed = targetStatus === 'CLOSED';
          await this.notificationService.sendNotification(
            {
              recipientId,
              recipientType,
              channel: 'PUSH',
              title: isClosed ? 'Your support ticket has been closed' : 'Your support ticket has been resolved',
              body: reason
                ? `Reason: ${reason.substring(0, 100)}`
                : (isClosed
                  ? 'Your support ticket has been closed. Thank you for contacting GONGO Support.'
                  : 'Your support ticket has been marked as resolved by GONGO Support.'),
              type: isClosed ? 'SUPPORT_TICKET_CLOSED' : 'SUPPORT_TICKET_RESOLVED',
              data: {
                ticketId: ticket.id,
                ticketNumber: ticket.ticket_number,
                screen: 'SupportScreen',
              },
              bookingId: ticket.booking_id || null,
            },
            adminUser,
            auditMeta,
          );
        }
      } catch (notifErr) {
        logger.warn('Non-blocking: Failed to dispatch notification for support status update', {
          ticketId: result.ticket.id,
          error: notifErr.message,
        });
      }
    }

    return result.detail;
  }

  /**
   * 9. Update Ticket Priority.
   */
  async updatePriority(id, payload, adminUser, auditMeta = {}) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const { priority, reason } = payload || {};

    if (!priority || typeof priority !== 'string') {
      throw new BadRequestError('Priority is required', ERROR_CODES.VALIDATION_ERROR);
    }
    const targetPriority = priority.toUpperCase().trim();
    if (!VALID_PRIORITIES.has(targetPriority)) {
      throw new BadRequestError(`Invalid priority: '${priority}'`, ERROR_CODES.VALIDATION_ERROR);
    }

    return this.supportRepo.withTransaction(async (client) => {
      const ticket = await this.supportRepo.getTicketForUpdate(client, ticketId);
      if (!ticket) {
        throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
      }

      if (ticket.status === 'CLOSED') {
        throw new ConflictError('Cannot change priority of a CLOSED ticket', ERROR_CODES.CONFLICT);
      }

      if (ticket.priority === targetPriority) {
        const currentDetail = await this.supportRepo.getTicketById(ticket.id, client);
        return this._mapTicketDetail(currentDetail);
      }

      await this.supportRepo.updateTicket(client, ticket.id, { priority: targetPriority });

      auditService.logAdminAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.update',
        action: 'SUPPORT_TICKET_PRIORITY_CHANGED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { priority: ticket.priority },
        afterState: { priority: targetPriority },
        metadata: { reason: reason || null },
      });

      await this.actionRepo.createAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.update',
        action: 'SUPPORT_TICKET_PRIORITY_CHANGED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { priority: ticket.priority },
        afterState: { priority: targetPriority },
        metadata: { reason: reason || null },
      }, client);

      const freshDetail = await this.supportRepo.getTicketById(ticket.id, client);
      return this._mapTicketDetail(freshDetail);
    });
  }

  /**
   * 10. Update Ticket Category.
   */
  async updateCategory(id, payload, adminUser, auditMeta = {}) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const { category, reason } = payload || {};

    if (!category || typeof category !== 'string') {
      throw new BadRequestError('Category is required', ERROR_CODES.VALIDATION_ERROR);
    }
    const targetCategory = category.toUpperCase().trim();
    if (!VALID_CATEGORIES.has(targetCategory)) {
      throw new BadRequestError(`Invalid category: '${category}'`, ERROR_CODES.VALIDATION_ERROR);
    }

    return this.supportRepo.withTransaction(async (client) => {
      const ticket = await this.supportRepo.getTicketForUpdate(client, ticketId);
      if (!ticket) {
        throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
      }

      if (ticket.status === 'CLOSED') {
        throw new ConflictError('Cannot change category of a CLOSED ticket', ERROR_CODES.CONFLICT);
      }

      if (ticket.category === targetCategory) {
        const currentDetail = await this.supportRepo.getTicketById(ticket.id, client);
        return this._mapTicketDetail(currentDetail);
      }

      await this.supportRepo.updateTicket(client, ticket.id, { category: targetCategory });

      auditService.logAdminAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.update',
        action: 'SUPPORT_TICKET_CATEGORY_CHANGED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { category: ticket.category },
        afterState: { category: targetCategory },
        metadata: { reason: reason || null },
      });

      await this.actionRepo.createAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.update',
        action: 'SUPPORT_TICKET_CATEGORY_CHANGED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { category: ticket.category },
        afterState: { category: targetCategory },
        metadata: { reason: reason || null },
      }, client);

      const freshDetail = await this.supportRepo.getTicketById(ticket.id, client);
      return this._mapTicketDetail(freshDetail);
    });
  }

  /**
   * 11. Assign Ticket to Admin.
   */
  async assignTicket(id, payload, adminUser, auditMeta = {}) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const { adminUserId, reason } = payload || {};

    const targetAdminId = assertUuid(adminUserId, 'adminUserId');

    // Verify target user is active ADMIN
    const targetUser = await this.supportRepo.getActiveAdminUser(targetAdminId);
    if (!targetUser) {
      throw new NotFoundError(`Target admin user '${targetAdminId}' not found`, ERROR_CODES.NOT_FOUND);
    }
    if (targetUser.role !== 'ADMIN' || !targetUser.is_active) {
      throw new ForbiddenError('Tickets can only be assigned to active ADMIN users', ERROR_CODES.FORBIDDEN);
    }

    return this.supportRepo.withTransaction(async (client) => {
      const ticket = await this.supportRepo.getTicketForUpdate(client, ticketId);
      if (!ticket) {
        throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
      }

      if (ticket.status === 'CLOSED') {
        throw new ConflictError('Cannot assign a CLOSED ticket', ERROR_CODES.CONFLICT);
      }

      // If already assigned to same user, return idempotently
      if (ticket.assigned_to === targetAdminId) {
        const currentDetail = await this.supportRepo.getTicketById(ticket.id, client);
        return this._mapTicketDetail(currentDetail);
      }

      const assignedAt = new Date();
      const updates = {
        assigned_to: targetAdminId,
        assigned_at: assignedAt,
      };
      if (ticket.status === 'OPEN') {
        updates.status = 'IN_PROGRESS';
      }

      await this.supportRepo.updateTicket(client, ticket.id, updates);

      auditService.logAdminAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.assign',
        action: 'SUPPORT_TICKET_ASSIGNED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { assignedTo: ticket.assigned_to, status: ticket.status },
        afterState: { assignedTo: targetAdminId, status: updates.status || ticket.status },
        metadata: { reason: reason || null, assignedToName: targetUser.name },
      });

      await this.actionRepo.createAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.assign',
        action: 'SUPPORT_TICKET_ASSIGNED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { assignedTo: ticket.assigned_to, status: ticket.status },
        afterState: { assignedTo: targetAdminId, status: updates.status || ticket.status },
        metadata: { reason: reason || null, assignedToName: targetUser.name },
      }, client);

      const freshDetail = await this.supportRepo.getTicketById(ticket.id, client);
      return this._mapTicketDetail(freshDetail);
    });
  }

  /**
   * 12. Admin Reply / Message to Ticket.
   */
  async replyTicket(id, payload, adminUser, auditMeta = {}) {
    const cleanId = assertTicketIdentifier(id, 'ticketId');
    const { message, text, attachments = [] } = payload || {};
    const messageContent = typeof message === 'string' && message.trim().length > 0
      ? message.trim()
      : typeof text === 'string'
      ? text.trim()
      : '';

    if (!messageContent || messageContent.length === 0) {
      throw new BadRequestError('Message body cannot be empty', ERROR_CODES.VALIDATION_ERROR);
    }
    if (messageContent.length > 4000) {
      throw new BadRequestError('Message body cannot exceed 4000 characters', ERROR_CODES.VALIDATION_ERROR);
    }

    const result = await this.supportRepo.withTransaction(async (client) => {
      const ticket = await this.supportRepo.getTicketForUpdate(client, cleanId);
      if (!ticket) {
        throw new NotFoundError(`Support ticket '${cleanId}' not found`, ERROR_CODES.NOT_FOUND);
      }

      const ticketId = ticket.id; // Canonical UUID

      if (ticket.status === 'CLOSED') {
        throw new ConflictError('Cannot reply to a CLOSED support ticket. Reopen ticket first.', ERROR_CODES.CONFLICT);
      }

      // Resolve valid sender_id (preserve authenticated admin UUID or resolve fallback)
      let senderId = (adminUser?.id && isUuid(adminUser.id)) ? adminUser.id : null;
      if (!senderId) {
        try {
          const fallbackAdmin = await this.supportRepo.findFallbackAdminUser(adminUser?.email || adminUser?.auth_id, client);
          if (fallbackAdmin) {
            senderId = fallbackAdmin.id;
          }
        } catch (_) {
          // Ignore DB lookup error in unit tests without live pool
        }
      }
      if (!senderId) {
        senderId = adminUser?.id;
      }

      // Create message with senderType: 'ADMIN'
      const createdMessage = await this.supportRepo.createMessage(client, {
        ticketId,
        senderType: 'ADMIN',
        senderId,
        message: messageContent,
        attachments: Array.isArray(attachments) ? attachments : [],
      });

      // Update ticket status to WAITING_FOR_CUSTOMER if currently OPEN/IN_PROGRESS/REOPENED
      const ticketUpdates = {};
      if (['OPEN', 'IN_PROGRESS', 'REOPENED'].includes(ticket.status)) {
        ticketUpdates.status = 'WAITING_FOR_CUSTOMER';
      }
      if (!ticket.assigned_to && senderId && isUuid(senderId)) {
        ticketUpdates.assigned_to = senderId;
        ticketUpdates.assigned_at = new Date();
      }

      if (Object.keys(ticketUpdates).length > 0) {
        await this.supportRepo.updateTicket(client, ticketId, ticketUpdates);
      }

      // Audit reply
      auditService.logAdminAction({
        actorId: adminUser?.id || senderId,
        actorRole: adminUser?.role || 'ADMIN',
        permission: auditMeta.permission || 'support.reply',
        action: 'SUPPORT_TICKET_ADMIN_REPLY',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticketId,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { status: ticket.status },
        afterState: { status: ticketUpdates.status || ticket.status },
        metadata: {
          messageId: createdMessage.id,
          messageSnippet: messageContent.substring(0, 100),
          attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
        },
      });

      await this.actionRepo.createAction({
        actorId: adminUser?.id || senderId,
        actorRole: adminUser?.role || 'ADMIN',
        permission: auditMeta.permission || 'support.reply',
        action: 'SUPPORT_TICKET_ADMIN_REPLY',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticketId,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { status: ticket.status },
        afterState: { status: ticketUpdates.status || ticket.status },
        metadata: {
          messageId: createdMessage.id,
          messageSnippet: messageContent.substring(0, 100),
          attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
        },
      }, client);

      return {
        createdMessage,
        ticket,
        ticketUpdates,
      };
    });

    const { createdMessage, ticket, ticketUpdates } = result;

    // POST-COMMIT: Trigger customer/partner notification using existing notification infrastructure
    try {
      const isPartner = Boolean(ticket.partner_id);
      const recipientId = isPartner ? ticket.partner_id : ticket.customer_id;
      const recipientType = isPartner ? 'PARTNER' : 'CUSTOMER';

      if (recipientId && this.notificationService && typeof this.notificationService.sendNotification === 'function') {
        await this.notificationService.sendNotification(
          {
            recipientId,
            recipientType,
            channel: 'PUSH',
            title: 'GONGO Support replied to your ticket',
            body: messageContent.length > 120 ? `${messageContent.substring(0, 120)}...` : messageContent,
            type: 'SUPPORT_TICKET_REPLY',
            data: {
              ticketId: ticket.id,
              ticketNumber: ticket.ticket_number,
              messageId: createdMessage.id,
              screen: 'SupportScreen',
            },
            bookingId: ticket.booking_id || null,
          },
          adminUser,
          auditMeta,
        );
      }
    } catch (notifErr) {
      logger.warn('Non-blocking: Failed to dispatch notification for support reply', {
        ticketId: ticket.id,
        error: notifErr.message,
      });
    }

    return {
      message: {
        id: createdMessage.id,
        ticketId: createdMessage.ticket_id,
        senderType: createdMessage.sender_type,
        senderId: createdMessage.sender_id,
        message: createdMessage.message,
        attachments: createdMessage.attachments || [],
        createdAt: createdMessage.created_at,
        sender: {
          id: createdMessage.sender_id,
          name: adminUser?.name || 'Support Admin',
          role: adminUser?.role || 'ADMIN',
        },
      },
      ticketStatus: ticketUpdates.status || ticket.status,
    };
  }

  /**
   * 13. Resolve Ticket.
   */
  async resolveTicket(id, payload, adminUser, auditMeta = {}) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const { resolutionNotes, reason } = payload || {};

    const result = await this.supportRepo.withTransaction(async (client) => {
      const ticket = await this.supportRepo.getTicketForUpdate(client, ticketId);
      if (!ticket) {
        throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
      }

      if (ticket.status === 'CLOSED') {
        throw new ConflictError('Cannot resolve a CLOSED ticket', ERROR_CODES.CONFLICT);
      }

      // Idempotency: if already RESOLVED, return cleanly
      if (ticket.status === 'RESOLVED') {
        const currentDetail = await this.supportRepo.getTicketById(ticket.id, client);
        return { detail: this._mapTicketDetail(currentDetail), ticket, isNoop: true };
      }

      let resolverId = (adminUser?.id && isUuid(adminUser.id)) ? adminUser.id : null;
      if (!resolverId) {
        try {
          const fallbackAdmin = await this.supportRepo.findFallbackAdminUser(adminUser?.email || adminUser?.auth_id, client);
          if (fallbackAdmin) resolverId = fallbackAdmin.id;
        } catch (_) {}
      }
      if (!resolverId) resolverId = adminUser?.id;

      const resolvedAt = new Date();
      await this.supportRepo.updateTicket(client, ticket.id, {
        status: 'RESOLVED',
        resolved_by: resolverId,
        resolved_at: resolvedAt,
        resolution_notes: resolutionNotes ? resolutionNotes.trim() : (reason ? reason.trim() : null),
      });

      await this.supportRepo.recordStatusHistory(client, {
        ticketId: ticket.id,
        oldStatus: ticket.status,
        newStatus: 'RESOLVED',
        changedBy: resolverId,
        reason: reason || resolutionNotes || null,
      });

      auditService.logAdminAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.resolve',
        action: 'SUPPORT_TICKET_RESOLVED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { status: ticket.status },
        afterState: { status: 'RESOLVED' },
        metadata: {
          resolutionNotes: resolutionNotes || null,
          reason: reason || null,
        },
      });

      await this.actionRepo.createAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.resolve',
        action: 'SUPPORT_TICKET_RESOLVED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { status: ticket.status },
        afterState: { status: 'RESOLVED' },
        metadata: {
          resolutionNotes: resolutionNotes || null,
          reason: reason || null,
        },
      }, client);

      const freshDetail = await this.supportRepo.getTicketById(ticket.id, client);
      return { detail: this._mapTicketDetail(freshDetail), ticket, isNoop: false };
    });

    if (!result.isNoop) {
      try {
        const ticket = result.ticket;
        const isPartner = Boolean(ticket.partner_id);
        const recipientId = isPartner ? ticket.partner_id : ticket.customer_id;
        const recipientType = isPartner ? 'PARTNER' : 'CUSTOMER';

        if (recipientId && this.notificationService && typeof this.notificationService.sendNotification === 'function') {
          await this.notificationService.sendNotification(
            {
              recipientId,
              recipientType,
              channel: 'PUSH',
              title: 'Your support ticket has been resolved',
              body: resolutionNotes
                ? `Resolution: ${resolutionNotes.substring(0, 100)}`
                : 'Your support ticket has been marked as resolved by GONGO Support.',
              type: 'SUPPORT_TICKET_RESOLVED',
              data: {
                ticketId: ticket.id,
                ticketNumber: ticket.ticket_number,
                screen: 'SupportScreen',
              },
              bookingId: ticket.booking_id || null,
            },
            adminUser,
            auditMeta,
          );
        }
      } catch (notifErr) {
        logger.warn('Non-blocking: Failed to dispatch notification for support resolve', {
          ticketId: result.ticket.id,
          error: notifErr.message,
        });
      }
    }

    return result.detail;
  }

  /**
   * 14. Close Ticket.
   */
  async closeTicket(id, payload, adminUser, auditMeta = {}) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const { reason } = payload || {};

    const result = await this.supportRepo.withTransaction(async (client) => {
      const ticket = await this.supportRepo.getTicketForUpdate(client, ticketId);
      if (!ticket) {
        throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
      }

      // Idempotency: if already CLOSED, return cleanly
      if (ticket.status === 'CLOSED') {
        const currentDetail = await this.supportRepo.getTicketById(ticket.id, client);
        return { detail: this._mapTicketDetail(currentDetail), ticket, isNoop: true };
      }

      let closerId = (adminUser?.id && isUuid(adminUser.id)) ? adminUser.id : null;
      if (!closerId) {
        try {
          const fallbackAdmin = await this.supportRepo.findFallbackAdminUser(adminUser?.email || adminUser?.auth_id, client);
          if (fallbackAdmin) closerId = fallbackAdmin.id;
        } catch (_) {}
      }
      if (!closerId) closerId = adminUser?.id;

      const closedAt = new Date();
      await this.supportRepo.updateTicket(client, ticket.id, {
        status: 'CLOSED',
        closed_at: closedAt,
      });

      await this.supportRepo.recordStatusHistory(client, {
        ticketId: ticket.id,
        oldStatus: ticket.status,
        newStatus: 'CLOSED',
        changedBy: closerId,
        reason: reason || null,
      });

      auditService.logAdminAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.close',
        action: 'SUPPORT_TICKET_CLOSED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { status: ticket.status },
        afterState: { status: 'CLOSED' },
        metadata: { reason: reason || null },
      });

      await this.actionRepo.createAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.close',
        action: 'SUPPORT_TICKET_CLOSED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { status: ticket.status },
        afterState: { status: 'CLOSED' },
        metadata: { reason: reason || null },
      }, client);

      const freshDetail = await this.supportRepo.getTicketById(ticket.id, client);
      return { detail: this._mapTicketDetail(freshDetail), ticket, isNoop: false };
    });

    if (!result.isNoop) {
      try {
        const ticket = result.ticket;
        const isPartner = Boolean(ticket.partner_id);
        const recipientId = isPartner ? ticket.partner_id : ticket.customer_id;
        const recipientType = isPartner ? 'PARTNER' : 'CUSTOMER';

        if (recipientId && this.notificationService && typeof this.notificationService.sendNotification === 'function') {
          await this.notificationService.sendNotification(
            {
              recipientId,
              recipientType,
              channel: 'PUSH',
              title: 'Your support ticket has been closed',
              body: reason
                ? `Reason: ${reason.substring(0, 100)}`
                : 'Your support ticket has been closed. Thank you for contacting GONGO Support.',
              type: 'SUPPORT_TICKET_CLOSED',
              data: {
                ticketId: ticket.id,
                ticketNumber: ticket.ticket_number,
                screen: 'SupportScreen',
              },
              bookingId: ticket.booking_id || null,
            },
            adminUser,
            auditMeta,
          );
        }
      } catch (notifErr) {
        logger.warn('Non-blocking: Failed to dispatch notification for support close', {
          ticketId: result.ticket.id,
          error: notifErr.message,
        });
      }
    }

    return result.detail;
  }

  /**
   * 15. Reopen Ticket (if state machine permits).
   */
  async reopenTicket(id, payload, adminUser, auditMeta = {}) {
    const ticketId = assertTicketIdentifier(id, 'ticketId');
    const { reason } = payload || {};

    return this.supportRepo.withTransaction(async (client) => {
      const ticket = await this.supportRepo.getTicketForUpdate(client, ticketId);
      if (!ticket) {
        throw new NotFoundError(`Support ticket '${ticketId}' not found`, ERROR_CODES.NOT_FOUND);
      }

      if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) {
        throw new ConflictError(
          `Cannot reopen ticket in status '${ticket.status}'. Only RESOLVED or CLOSED tickets can be reopened.`,
          ERROR_CODES.CONFLICT,
        );
      }

      let reopenerId = (adminUser?.id && isUuid(adminUser.id)) ? adminUser.id : null;
      if (!reopenerId) {
        try {
          const fallbackAdmin = await this.supportRepo.findFallbackAdminUser(adminUser?.email || adminUser?.auth_id, client);
          if (fallbackAdmin) reopenerId = fallbackAdmin.id;
        } catch (_) {}
      }
      if (!reopenerId) reopenerId = adminUser?.id;

      await this.supportRepo.updateTicket(client, ticket.id, {
        status: 'REOPENED',
      });

      await this.supportRepo.recordStatusHistory(client, {
        ticketId: ticket.id,
        oldStatus: ticket.status,
        newStatus: 'REOPENED',
        changedBy: reopenerId,
        reason: reason || null,
      });

      auditService.logAdminAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.update',
        action: 'SUPPORT_TICKET_REOPENED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { status: ticket.status },
        afterState: { status: 'REOPENED' },
        metadata: { reason: reason || null },
      });

      await this.actionRepo.createAction({
        actorId: adminUser.id,
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'support.update',
        action: 'SUPPORT_TICKET_REOPENED',
        targetResource: 'SUPPORT_TICKET',
        targetResourceId: ticket.id,
        requestId: auditMeta.requestId,
        ipAddress: auditMeta.ipAddress,
        userAgent: auditMeta.userAgent,
        beforeState: { status: ticket.status },
        afterState: { status: 'REOPENED' },
        metadata: { reason: reason || null },
      }, client);

      const freshDetail = await this.supportRepo.getTicketById(ticket.id, client);
      return this._mapTicketDetail(freshDetail);
    });
  }
}

module.exports = new AdminSupportService();
