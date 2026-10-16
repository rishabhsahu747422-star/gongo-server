'use strict';

const express = require('express');
const vehicleController = require('../controllers/vehicle.controller');
const pricingController = require('../controllers/pricing.controller');
const availabilityController = require('../controllers/availability.controller');
const ratingController = require('../controllers/rating.controller');
const { rejectMassAssignment } = require('../middlewares/massAssignment');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const { idempotency } = require('../middlewares/idempotency');

const router = express.Router();

const vehicleMutationLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:vehicle:mutate',
});

// Vehicle Inventory CRUD
router.post(
  '/',
  vehicleMutationLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => vehicleController.createVehicle(req, res, next),
);

router.get('/', (req, res, next) => vehicleController.getVehicles(req, res, next));

router.get('/:vehicleId', (req, res, next) => vehicleController.getVehicleById(req, res, next));

router.get('/:vehicleId/ratings', (req, res, next) => ratingController.getVehicleSummary(req, res, next));

router.get('/:vehicleId/history', (req, res, next) => vehicleController.getVehicleHistory(req, res, next));

router.patch(
  '/:vehicleId',
  vehicleMutationLimiter,
  rejectMassAssignment(),
  (req, res, next) => vehicleController.updateVehicle(req, res, next),
);

const { PROTECTED_SERVER_FIELDS } = require('../constants/fields');

const STATUS_UPDATE_PROTECTED_FIELDS = PROTECTED_SERVER_FIELDS.filter(
  (f) => f.toLowerCase() !== 'status' && f.toLowerCase() !== 'reason',
);

router.patch(
  '/:vehicleId/status',
  vehicleMutationLimiter,
  rejectMassAssignment(STATUS_UPDATE_PROTECTED_FIELDS),
  (req, res, next) => vehicleController.updateVehicleStatus(req, res, next),
);

router.delete(
  '/:vehicleId',
  vehicleMutationLimiter,
  (req, res, next) => vehicleController.archiveVehicle(req, res, next),
);

// Vehicle Images
router.get('/:vehicleId/images', (req, res, next) => vehicleController.getVehicleImages(req, res, next));

router.patch(
  '/:vehicleId/images/:imageId/cover',
  vehicleMutationLimiter,
  (req, res, next) => vehicleController.setCoverImage(req, res, next),
);

router.delete(
  '/:vehicleId/images/:imageId',
  vehicleMutationLimiter,
  (req, res, next) => vehicleController.deleteVehicleImage(req, res, next),
);

router.post(
  '/:vehicleId/images/:imageId/replace',
  vehicleMutationLimiter,
  (req, res, next) => vehicleController.replaceVehicleImage(req, res, next),
);

// Vehicle Documents
router.post(
  '/:vehicleId/documents',
  vehicleMutationLimiter,
  (req, res, next) => vehicleController.createVehicleDocument(req, res, next),
);

router.get('/:vehicleId/documents', (req, res, next) => vehicleController.getVehicleDocuments(req, res, next));

router.delete(
  '/:vehicleId/documents/:documentId',
  vehicleMutationLimiter,
  (req, res, next) => vehicleController.deleteVehicleDocument(req, res, next),
);

// Vehicle Pricing
router.get(
  '/:vehicleId/pricing',
  (req, res, next) => pricingController.getPricing(req, res, next),
);

router.put(
  '/:vehicleId/pricing',
  vehicleMutationLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => pricingController.updatePricing(req, res, next),
);

router.get(
  '/:vehicleId/pricing/history',
  (req, res, next) => pricingController.getPricingHistory(req, res, next),
);

// Vehicle Availability Blocks
router.get(
  '/:vehicleId/availability',
  (req, res, next) => availabilityController.getAvailability(req, res, next),
);

router.post(
  '/:vehicleId/availability',
  vehicleMutationLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => availabilityController.createBlock(req, res, next),
);

router.patch(
  '/:vehicleId/availability/:blockId',
  vehicleMutationLimiter,
  rejectMassAssignment(),
  (req, res, next) => availabilityController.updateBlock(req, res, next),
);

router.delete(
  '/:vehicleId/availability/:blockId',
  vehicleMutationLimiter,
  (req, res, next) => availabilityController.deleteBlock(req, res, next),
);

module.exports = router;
