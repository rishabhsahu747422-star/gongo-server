'use strict';

const supportTicketService = require('../services/support-ticket.service');
const supportTicketValidator = require('../validators/support-ticket.validator');
const { sendSuccess } = require('../utils/response');

class SupportTicketController {
  /**
   * POST /api/v1/partner/support/tickets
   */
  async createTicket(req, res, next) {
    try {
      const validated = supportTicketValidator.validateCreateTicket(req.body);
      const ticket = await supportTicketService.createTicket(
        req.user.partnerId,
        {
          ...validated,
          userId: req.user.userId,
        },
        req.id,
      );
      return sendSuccess(res, ticket, 201);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/support/tickets
   */
  async getTickets(req, res, next) {
    try {
      const options = supportTicketValidator.validateTicketListQuery(req.query);
      const result = await supportTicketService.getPartnerTickets(
        req.user.partnerId,
        options,
      );
      return sendSuccess(res, result, 200);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/partner/support/tickets/:ticketId
   */
  async getTicketById(req, res, next) {
    try {
      const ticket = await supportTicketService.getPartnerTicketById(
        req.user.partnerId,
        req.params.ticketId,
      );
      return sendSuccess(res, ticket, 200);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/partner/support/tickets/:ticketId/messages
   */
  async addMessage(req, res, next) {
    try {
      const validated = supportTicketValidator.validateAddMessage(req.body);
      const message = await supportTicketService.addPartnerMessage(
        req.user.partnerId,
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

module.exports = new SupportTicketController();
