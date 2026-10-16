'use strict';

const express = require('express');
const storageController = require('../controllers/storage.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { rejectMassAssignment } = require('../middlewares/massAssignment');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const { idempotency } = require('../middlewares/idempotency');
const { ROLES } = require('../constants/roles');
const { PROTECTED_SERVER_FIELDS } = require('../constants/fields');

const ACCESS_URL_PROTECTED_FIELDS = PROTECTED_SERVER_FIELDS.filter((f) => f.toLowerCase() !== 'storagekey');

const router = express.Router();

const storagePresignLimiter = createRateLimiter({
  max: 30,
  windowMs: 60 * 1000,
  prefix: 'rl:storage:presign',
});

const storageCompleteLimiter = createRateLimiter({
  max: 30,
  windowMs: 60 * 1000,
  prefix: 'rl:storage:complete',
});

const storageAccessLimiter = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  prefix: 'rl:storage:access',
});

// All storage routes require authenticated PARTNER role
router.use(authenticate);
router.use(requireRole(ROLES.PARTNER));

/**
 * POST /api/v1/storage/presign
 * Generates direct S3 upload URL.
 */
router.post(
  '/presign',
  storagePresignLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => storageController.presign(req, res, next),
);

router.post(
  '/presign-upload',
  storagePresignLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => storageController.presign(req, res, next),
);

/**
 * POST /api/v1/storage/complete
 * Verifies S3 binary existence and syncs database.
 */
router.post(
  '/complete',
  storageCompleteLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => storageController.complete(req, res, next),
);

/**
 * POST /api/v1/storage/access-url
 * Generates short-lived GET presigned URL for private file access.
 */
router.post(
  '/access-url',
  storageAccessLimiter,
  rejectMassAssignment(ACCESS_URL_PROTECTED_FIELDS),
  (req, res, next) => storageController.accessUrl(req, res, next),
);

module.exports = router;
