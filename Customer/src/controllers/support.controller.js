'use strict';

const supportService = require('../services/support.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * SupportController — HTTP adapter for customer support tickets and conversations.
 */
class SupportController {
  /**
   * POST /api/v1/customers/me/support/tickets
   */
  async createTicket(req, res, next) {
    try {
      const ticket = await supportService.createTicket(req.user.id, req.body);
      return sendSuccess(
        res,
        { ticket },
        'Support ticket created successfully',
        HTTP_STATUS.CREATED,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/support/tickets
   */
  async listTickets(req, res, next) {
    try {
      const result = await supportService.listTickets(req.user.id, req.query);
      return sendSuccess(
        res,
        result,
        'Support tickets retrieved successfully',
        HTTP_STATUS.OK,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/customers/me/support/tickets/:ticketId
   */
  async getTicket(req, res, next) {
    try {
      const { ticketId } = req.params;
      const ticket = await supportService.getTicketById(req.user.id, ticketId);
      return sendSuccess(
        res,
        { ticket },
        'Support ticket retrieved successfully',
        HTTP_STATUS.OK,
      );
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/customers/me/support/tickets/:ticketId/messages
   */
  async addMessage(req, res, next) {
    try {
      const { ticketId } = req.params;
      const message = await supportService.addCustomerMessage(req.user.id, ticketId, req.body);
      return sendSuccess(
        res,
        { message },
        'Message sent successfully',
        HTTP_STATUS.CREATED,
      );
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new SupportController();
