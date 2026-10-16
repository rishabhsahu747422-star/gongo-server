'use strict';

const adminDamageService = require('../services/admin-damage.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

class AdminDamageController {
  /**
   * GET /api/v1/admin/damages
   * List all damage reports.
   */
  async listDamages(req, res, next) {
    try {
      const result = await adminDamageService.listDamages(req.validatedQuery);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/admin/damages/:damageId
   * Inspect single damage report.
   */
  async getDamageById(req, res, next) {
    try {
      const { damageId } = req.params;
      const result = await adminDamageService.getDamageById(damageId);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/damages/:damageId/review
   * Mark damage report as UNDER_REVIEW.
   */
  async markUnderReview(req, res, next) {
    try {
      const { damageId } = req.params;
      const result = await adminDamageService.markUnderReview(damageId);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/damages/:damageId/approve
   * Approve damage report with approvedAmount.
   */
  async approveDamage(req, res, next) {
    try {
      const { damageId } = req.params;
      const result = await adminDamageService.approveDamage(damageId, req.validatedBody);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/damages/:damageId/reject
   * Reject damage report.
   */
  async rejectDamage(req, res, next) {
    try {
      const { damageId } = req.params;
      const result = await adminDamageService.rejectDamage(damageId, req.validatedBody);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/damages/:damageId/settle
   * Settle damage report.
   */
  async settleDamage(req, res, next) {
    try {
      const { damageId } = req.params;
      const result = await adminDamageService.settleDamage(damageId);
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminDamageController();
