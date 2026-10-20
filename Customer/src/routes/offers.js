'use strict';

const express = require('express');
const offerController = require('../controllers/offer.controller');

const router = express.Router();

// GET /api/v1/offers/active and /api/v1/offers
router.get('/active', offerController.getActiveOffers);
router.get('/', offerController.getActiveOffers);

module.exports = router;
