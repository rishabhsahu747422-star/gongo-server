'use strict';

const express = require('express');
const adminDamageController = require('../controllers/admin-damage.controller');
const adminDamageValidator = require('../validators/admin-damage.validator');

const router = express.Router();

/**
 * @route   GET /api/v1/admin/damages
 * @desc    List all damage reports with filters and pagination.
 * @access  Private (Admin)
 */
router.get(
  '/',
  (req, res, next) => adminDamageValidator.validateDamageListQuery(req, res, next),
  (req, res, next) => adminDamageController.listDamages(req, res, next),
);

/**
 * @route   GET /api/v1/admin/damages/:damageId
 * @desc    Inspect single damage report details.
 * @access  Private (Admin)
 */
router.get(
  '/:damageId',
  (req, res, next) => adminDamageValidator.validateDamageIdParam(req, res, next),
  (req, res, next) => adminDamageController.getDamageById(req, res, next),
);

/**
 * @route   PATCH /api/v1/admin/damages/:damageId/review
 * @desc    Move damage report status to UNDER_REVIEW.
 * @access  Private (Admin)
 */
router.patch(
  '/:damageId/review',
  (req, res, next) => adminDamageValidator.validateDamageIdParam(req, res, next),
  (req, res, next) => adminDamageController.markUnderReview(req, res, next),
);

/**
 * @route   PATCH /api/v1/admin/damages/:damageId/approve
 * @desc    Approve damage report with authoritative approvedAmount.
 * @access  Private (Admin)
 */
router.patch(
  '/:damageId/approve',
  (req, res, next) => adminDamageValidator.validateDamageIdParam(req, res, next),
  (req, res, next) => adminDamageValidator.validateApproveDamage(req, res, next),
  (req, res, next) => adminDamageController.approveDamage(req, res, next),
);

/**
 * @route   PATCH /api/v1/admin/damages/:damageId/reject
 * @desc    Reject damage report with optional reason.
 * @access  Private (Admin)
 */
router.patch(
  '/:damageId/reject',
  (req, res, next) => adminDamageValidator.validateDamageIdParam(req, res, next),
  (req, res, next) => adminDamageValidator.validateRejectDamage(req, res, next),
  (req, res, next) => adminDamageController.rejectDamage(req, res, next),
);

/**
 * @route   PATCH /api/v1/admin/damages/:damageId/settle
 * @desc    Settle approved damage report.
 * @access  Private (Admin)
 */
router.patch(
  '/:damageId/settle',
  (req, res, next) => adminDamageValidator.validateDamageIdParam(req, res, next),
  (req, res, next) => adminDamageController.settleDamage(req, res, next),
);

module.exports = router;
