'use strict';

const adminSupportService = require('../services/admin-support.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminSupportController {
  constructor() {
    this.listTickets = this.listTickets.bind(this);
    this.getTicketById = this.getTicketById.bind(this);
    this.getTicketMessages = this.getTicketMessages.bind(this);
    this.getTicketTimeline = this.getTicketTimeline.bind(this);
    this.getTicketCustomer = this.getTicketCustomer.bind(this);
    this.getTicketPartner = this.getTicketPartner.bind(this);
    this.getTicketBooking = this.getTicketBooking.bind(this);
    this.updateStatus = this.updateStatus.bind(this);
    this.updatePriority = this.updatePriority.bind(this);
    this.updateCategory = this.updateCategory.bind(this);
    this.assignTicket = this.assignTicket.bind(this);
    this.replyTicket = this.replyTicket.bind(this);
    this.resolveTicket = this.resolveTicket.bind(this);
    this.closeTicket = this.closeTicket.bind(this);
    this.reopenTicket = this.reopenTicket.bind(this);
  }

  _buildAuditContext(req, res, permission) {
    return {
      actorId: req.user ? req.user.id : 'unknown-admin',
      actorRole: req.user ? req.user.role : 'ADMIN',
      permission,
      requestId: req.id || (res.locals && res.locals.requestId) || null,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    };
  }

  /**
   * GET /api/v1/admin/support/tickets
   */
  async listTickets(req, res, next) {
    try {
      const data = await adminSupportService.listTickets(req.query);
      return sendSuccess(res, data.tickets, {
        pagination: data.pagination,
      }, 200);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/support/tickets/:id
   */
  async getTicketById(req, res, next) {
    try {
      const ticketId = req.params.id;
      const data = await adminSupportService.getTicketById(ticketId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/support/tickets/:id/messages
   */
  async getTicketMessages(req, res, next) {
    try {
      const ticketId = req.params.id;
      const data = await adminSupportService.getTicketMessages(ticketId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/support/tickets/:id/timeline
   */
  async getTicketTimeline(req, res, next) {
    try {
      const ticketId = req.params.id;
      const data = await adminSupportService.getTicketTimeline(ticketId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/support/tickets/:id/customer
   */
  async getTicketCustomer(req, res, next) {
    try {
      const ticketId = req.params.id;
      const data = await adminSupportService.getTicketCustomer(ticketId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/support/tickets/:id/partner
   */
  async getTicketPartner(req, res, next) {
    try {
      const ticketId = req.params.id;
      const data = await adminSupportService.getTicketPartner(ticketId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/support/tickets/:id/booking
   */
  async getTicketBooking(req, res, next) {
    try {
      const ticketId = req.params.id;
      const data = await adminSupportService.getTicketBooking(ticketId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/support/tickets/:id/status
   */
  async updateStatus(req, res, next) {
    try {
      const ticketId = req.params.id;
      const auditMeta = this._buildAuditContext(req, res, 'support.update');
      const data = await adminSupportService.updateStatus(ticketId, req.body, req.user, auditMeta);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/support/tickets/:id/priority
   */
  async updatePriority(req, res, next) {
    try {
      const ticketId = req.params.id;
      const auditMeta = this._buildAuditContext(req, res, 'support.update');
      const data = await adminSupportService.updatePriority(
        ticketId,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/support/tickets/:id/category
   */
  async updateCategory(req, res, next) {
    try {
      const ticketId = req.params.id;
      const auditMeta = this._buildAuditContext(req, res, 'support.update');
      const data = await adminSupportService.updateCategory(
        ticketId,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/support/tickets/:id/assign
   */
  async assignTicket(req, res, next) {
    try {
      const ticketId = req.params.id;
      const auditMeta = this._buildAuditContext(req, res, 'support.update');
      const data = await adminSupportService.assignTicket(ticketId, req.body, req.user, auditMeta);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/support/tickets/:id/reply
   */
  async replyTicket(req, res, next) {
    try {
      const ticketId = req.params.id;
      const auditMeta = this._buildAuditContext(req, res, 'support.update');
      const data = await adminSupportService.replyTicket(ticketId, req.body, req.user, auditMeta);
      return sendSuccess(res, data, null, 201);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/support/tickets/:id/resolve
   */
  async resolveTicket(req, res, next) {
    try {
      const ticketId = req.params.id;
      const auditMeta = this._buildAuditContext(req, res, 'support.update');
      const data = await adminSupportService.resolveTicket(ticketId, req.body, req.user, auditMeta);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/support/tickets/:id/close
   */
  async closeTicket(req, res, next) {
    try {
      const ticketId = req.params.id;
      const auditMeta = this._buildAuditContext(req, res, 'support.update');
      const data = await adminSupportService.closeTicket(ticketId, req.body, req.user, auditMeta);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/support/tickets/:id/reopen
   */
  async reopenTicket(req, res, next) {
    try {
      const ticketId = req.params.id;
      const auditMeta = this._buildAuditContext(req, res, 'support.update');
      const data = await adminSupportService.reopenTicket(ticketId, req.body, req.user, auditMeta);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminSupportController();
