'use strict';

const express = require('express');
const adminOfferController = require('../controllers/admin-offer.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');

const router = express.Router();

router.use(authenticate);
router.use(requireRole(ROLES.ADMIN));
router.use(auditMiddleware);

// GET /api/v1/admin/offers
router.get('/', (req, res, next) => adminOfferController.listOffers(req, res, next));

// POST /api/v1/admin/offers
router.post('/', sensitiveOpLimiter, (req, res, next) => adminOfferController.createOffer(req, res, next));

// GET /api/v1/admin/offers/:id
router.get('/:id', (req, res, next) => adminOfferController.getOfferDetail(req, res, next));

// PATCH /api/v1/admin/offers/:id
router.patch('/:id', sensitiveOpLimiter, (req, res, next) => adminOfferController.updateOffer(req, res, next));

// DELETE /api/v1/admin/offers/:id
router.delete('/:id', sensitiveOpLimiter, (req, res, next) => adminOfferController.deleteOffer(req, res, next));

// POST /api/v1/admin/offers/:id/vehicles
router.post('/:id/vehicles', sensitiveOpLimiter, (req, res, next) => adminOfferController.addVehicleToOffer(req, res, next));

// DELETE /api/v1/admin/offers/:id/vehicles/:vehicleId
router.delete('/:id/vehicles/:vehicleId', sensitiveOpLimiter, (req, res, next) => adminOfferController.removeVehicleFromOffer(req, res, next));

// POST /api/v1/admin/offers/:id/shops
router.post('/:id/shops', sensitiveOpLimiter, (req, res, next) => adminOfferController.addShopToOffer(req, res, next));

// DELETE /api/v1/admin/offers/:id/shops/:shopId
router.delete('/:id/shops/:shopId', sensitiveOpLimiter, (req, res, next) => adminOfferController.removeShopFromOffer(req, res, next));

module.exports = router;
