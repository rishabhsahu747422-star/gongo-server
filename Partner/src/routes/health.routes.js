'use strict';

const express = require('express');
const healthController = require('../health/health.controller');

const router = express.Router();

router.get('/live', (req, res, next) => healthController.live(req, res, next));
router.get('/ready', (req, res, next) => healthController.ready(req, res, next));
router.get('/', (req, res, next) => healthController.health(req, res, next));

module.exports = router;
