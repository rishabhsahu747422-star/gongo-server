'use strict';

const express = require('express');
const publicVehicleController = require('../controllers/public-vehicle.controller');
const franchiseController = require('../controllers/franchise.controller');
const { validatePublicVehicleSearch } = require('../validators/public-vehicle.validator');
const { validateCreateFranchiseApplication } = require('../validators/franchise.validator');
const { createRateLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

const publicSubmissionLimiter = createRateLimiter({
  max: 15,
  windowMs: 60 * 1000,
  prefix: 'rl-public-submit',
  message: 'Too many submissions. Please wait a moment before trying again.',
});

// ── Categories & Cities Discovery ───────────────────────────────────────────
router.get('/categories', (req, res, next) => publicVehicleController.getCategories(req, res, next));
router.get('/cities', (req, res, next) => publicVehicleController.getCities(req, res, next));

// ── Vehicles Discovery & Dynamic Search ─────────────────────────────────────
router.get('/search', validatePublicVehicleSearch, (req, res, next) => publicVehicleController.searchVehicles(req, res, next));
router.get('/vehicles/categories', (req, res, next) => publicVehicleController.getCategories(req, res, next));
router.get('/vehicles/cities', (req, res, next) => publicVehicleController.getCities(req, res, next));
router.get('/vehicles/search', validatePublicVehicleSearch, (req, res, next) => publicVehicleController.searchVehicles(req, res, next));
router.get('/vehicles', validatePublicVehicleSearch, (req, res, next) => publicVehicleController.searchVehicles(req, res, next));

// ── Public Franchise Territory Application ─────────────────────────────────
router.post(
  '/franchise-application',
  publicSubmissionLimiter,
  validateCreateFranchiseApplication,
  (req, res, next) => franchiseController.submitApplication(req, res, next),
);

router.post(
  '/franchise-applications',
  publicSubmissionLimiter,
  validateCreateFranchiseApplication,
  (req, res, next) => franchiseController.submitApplication(req, res, next),
);

module.exports = router;
