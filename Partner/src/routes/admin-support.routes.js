'use strict';

const express = require('express');
const adminSupportController = require('../controllers/admin-support.controller');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const { rejectMassAssignment } = require('../middlewares/massAssignment');
const { PROTECTED_SERVER_FIELDS } = require('../constants/fields');

const router = express.Router();

const STATUS_UPDATE_PROTECTED_FIELDS = PROTECTED_SERVER_FIELDS.filter(
  (f) => f.toLowerCase() !== 'status' && f.toLowerCase() !== 'priority',
);

const adminSupportReadLimiter = createRateLimiter({
  max: 120,
  windowMs: 60 * 1000,
  prefix: 'rl:admin:support:read',
});

const adminSupportMutateLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:admin:support:mutate',
});

// Admin Support Ticket Management
router.get(
  '/',
  adminSupportReadLimiter,
  (req, res, next) => adminSupportController.getTickets(req, res, next),
);

router.get(
  '/:ticketId',
  adminSupportReadLimiter,
  (req, res, next) => adminSupportController.getTicketById(req, res, next),
);

router.patch(
  '/:ticketId/status',
  adminSupportMutateLimiter,
  rejectMassAssignment(STATUS_UPDATE_PROTECTED_FIELDS),
  (req, res, next) => adminSupportController.updateTicketStatus(req, res, next),
);

router.post(
  '/:ticketId/messages',
  adminSupportMutateLimiter,
  rejectMassAssignment(),
  (req, res, next) => adminSupportController.addAdminMessage(req, res, next),
);

module.exports = router;
