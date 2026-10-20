'use strict';

const express = require('express');
const bannerController = require('../controllers/banner.controller');

const router = express.Router();

// GET /api/v1/banners/active and /api/v1/banners
router.get('/active', bannerController.getActiveBanners);
router.get('/', bannerController.getActiveBanners);

module.exports = router;
