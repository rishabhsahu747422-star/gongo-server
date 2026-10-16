'use strict';

const express = require('express');
const adminSupportController = require('../controllers/admin-support.controller');
const { requirePermission } = require('../middlewares/permission');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { PERMISSIONS } = require('../constants/permissions');

const supportRouter = express.Router();

// 1. Support ticket listing
supportRouter.get(
  '/',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.listTickets(req, res, next),
);
supportRouter.get(
  '/tickets',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.listTickets(req, res, next),
);

// 2. Ticket Detail
supportRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketById(req, res, next),
);
supportRouter.get(
  '/tickets/:id',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketById(req, res, next),
);

// 3. Ticket Messages
supportRouter.get(
  '/:id/messages',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketMessages(req, res, next),
);
supportRouter.get(
  '/tickets/:id/messages',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketMessages(req, res, next),
);

// 4. Ticket Timeline
supportRouter.get(
  '/:id/timeline',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketTimeline(req, res, next),
);
supportRouter.get(
  '/tickets/:id/timeline',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketTimeline(req, res, next),
);

// 5. Ticket Customer
supportRouter.get(
  '/:id/customer',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketCustomer(req, res, next),
);
supportRouter.get(
  '/tickets/:id/customer',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketCustomer(req, res, next),
);

// 6. Ticket Partner
supportRouter.get(
  '/:id/partner',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketPartner(req, res, next),
);
supportRouter.get(
  '/tickets/:id/partner',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketPartner(req, res, next),
);

// 7. Ticket Booking
supportRouter.get(
  '/:id/booking',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketBooking(req, res, next),
);
supportRouter.get(
  '/tickets/:id/booking',
  requirePermission(PERMISSIONS.SUPPORT_READ),
  (req, res, next) => adminSupportController.getTicketBooking(req, res, next),
);

// 8. Ticket Status
supportRouter.patch(
  '/:id/status',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.updateStatus(req, res, next),
);
supportRouter.patch(
  '/tickets/:id/status',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.updateStatus(req, res, next),
);

// 9. Ticket Priority
supportRouter.patch(
  '/:id/priority',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.updatePriority(req, res, next),
);
supportRouter.patch(
  '/tickets/:id/priority',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.updatePriority(req, res, next),
);

// 10. Ticket Category
supportRouter.patch(
  '/:id/category',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.updateCategory(req, res, next),
);
supportRouter.patch(
  '/tickets/:id/category',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.updateCategory(req, res, next),
);

// 11. Ticket Assignment
supportRouter.post(
  '/:id/assign',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.assignTicket(req, res, next),
);
supportRouter.patch(
  '/:id/assign',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.assignTicket(req, res, next),
);
supportRouter.post(
  '/tickets/:id/assign',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.assignTicket(req, res, next),
);
supportRouter.patch(
  '/tickets/:id/assign',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.assignTicket(req, res, next),
);

// 12. Ticket Reply
supportRouter.post(
  '/:id/reply',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.replyTicket(req, res, next),
);
supportRouter.post(
  '/tickets/:id/reply',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.replyTicket(req, res, next),
);
supportRouter.post(
  '/:id/messages',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.replyTicket(req, res, next),
);
supportRouter.post(
  '/tickets/:id/messages',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.replyTicket(req, res, next),
);

// 13. Ticket Resolution
supportRouter.post(
  '/:id/resolve',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.resolveTicket(req, res, next),
);
supportRouter.post(
  '/tickets/:id/resolve',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.resolveTicket(req, res, next),
);

// 14. Ticket Closure
supportRouter.post(
  '/:id/close',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.closeTicket(req, res, next),
);
supportRouter.post(
  '/tickets/:id/close',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.closeTicket(req, res, next),
);

// 15. Ticket Reopening
supportRouter.post(
  '/:id/reopen',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.reopenTicket(req, res, next),
);
supportRouter.post(
  '/tickets/:id/reopen',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.SUPPORT_UPDATE),
  (req, res, next) => adminSupportController.reopenTicket(req, res, next),
);

module.exports = {
  supportRouter,
};
