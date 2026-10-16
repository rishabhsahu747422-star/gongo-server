'use strict';

const express = require('express');
const ratingController = require('../controllers/rating.controller');
const { createRateLimiter } = require('../middlewares/rateLimiter');

const router = express.Router();

const ratingsLimiter = createRateLimiter({
  max: 120,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:ratings',
});

// Overall partner ratings summary & star distribution
router.get('/summary', ratingsLimiter, (req, res, next) => ratingController.getSummary(req, res, next));

// Vehicle-wise ratings overview across all partner vehicles
router.get('/vehicles', ratingsLimiter, (req, res, next) => ratingController.getVehicleRatingsOverview(req, res, next));

// Specific vehicle rating summary
router.get('/vehicles/:vehicleId', ratingsLimiter, (req, res, next) => ratingController.getVehicleSummary(req, res, next));

// Paginated ratings and review history
router.get('/', ratingsLimiter, (req, res, next) => ratingController.getReviews(req, res, next));

// Security: Partners cannot create, alter or delete ratings
router.post('*', (req, res, next) => ratingController.rejectPartnerMutation(req, res, next));
router.put('*', (req, res, next) => ratingController.rejectPartnerMutation(req, res, next));
router.patch('*', (req, res, next) => ratingController.rejectPartnerMutation(req, res, next));
router.delete('*', (req, res, next) => ratingController.rejectPartnerMutation(req, res, next));

module.exports = router;
