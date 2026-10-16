'use strict';

const express = require('express');
const supportTicketController = require('../controllers/support-ticket.controller');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const { idempotency } = require('../middlewares/idempotency');
const { rejectMassAssignment } = require('../middlewares/massAssignment');

const router = express.Router();

const ticketCreationLimiter = createRateLimiter({
  max: 20,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:support:create',
});

const ticketMessageLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:support:msg',
});

const ticketReadLimiter = createRateLimiter({
  max: 120,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:support:read',
});

// Partner Support Tickets CRUD & Message Threads
router.post(
  '/',
  ticketCreationLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => supportTicketController.createTicket(req, res, next),
);

router.get(
  '/',
  ticketReadLimiter,
  (req, res, next) => supportTicketController.getTickets(req, res, next),
);

router.get(
  '/:ticketId',
  ticketReadLimiter,
  (req, res, next) => supportTicketController.getTicketById(req, res, next),
);

router.post(
  '/:ticketId/messages',
  ticketMessageLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => supportTicketController.addMessage(req, res, next),
);

module.exports = router;
