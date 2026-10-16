'use strict';

const express = require('express');
const adminAgreementController = require('../controllers/admin-agreement.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { auditMiddleware } = require('../middlewares/audit');
const { ROLES } = require('../constants/roles');

const router = express.Router();

router.use(authenticate);
router.use(requireRole([ROLES.ADMIN, ROLES.SUPPORT_EXECUTIVE]));
router.use(auditMiddleware);

// GET /api/v1/admin/agreements
router.get('/', (req, res, next) => adminAgreementController.listAgreements(req, res, next));

// GET /api/v1/admin/agreements/:id
router.get('/:id', (req, res, next) => adminAgreementController.getAgreementById(req, res, next));

// GET /api/v1/admin/agreements/booking/:bookingId
router.get('/booking/:bookingId', (req, res, next) => adminAgreementController.getAgreementByBookingId(req, res, next));

module.exports = router;
