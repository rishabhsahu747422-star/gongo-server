'use strict';

const supportTicketService = require('../services/support-ticket.service');
const supportTicketValidator = require('../validators/support-ticket.validator');
const { sendSuccess } = require('../utils/response');

class AdminSupportController {
  /**
   * GET /api/v1/admin/support/tickets
   */
  async getTickets(req, res, next) {
    try {
      const options = supportTicketValidator.validateTicketListQuery(req.query);
      const result = await supportTicketService.getAdminTickets(options);
      return sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/support/tickets/:ticketId
   */
  async getTicketById(req, res, next) {
    try {
      const ticket = await supportTicketService.getAdminTicketById(req.params.ticketId);
      return sendSuccess(res, ticket, 200);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/support/tickets/:ticketId/status
   */
  async updateTicketStatus(req, res, next) {
    try {
      const updates = supportTicketValidator.validateStatusUpdate(req.body);
      const updated = await supportTicketService.updateAdminTicketStatus(
        req.params.ticketId,
        updates,
        req.user.userId || req.user.partnerId || req.user.auth_id,
        req.id,
      );
      return sendSuccess(res, updated, 200);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/admin/support/tickets/:ticketId/messages
   */
  async addAdminMessage(req, res, next) {
    try {
      const validated = supportTicketValidator.validateAddMessage(req.body);
      const message = await supportTicketService.addAdminMessage(
        req.user.userId || req.user.partnerId || req.user.auth_id,
        req.params.ticketId,
        validated,
        req.id,
      );
      return sendSuccess(res, message, 201);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminSupportController();
