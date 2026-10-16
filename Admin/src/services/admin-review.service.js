'use strict';

const adminReviewRepository = require('../repositories/admin-review.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const auditService = require('./audit.service');
const { ValidationError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class AdminReviewService {
  async listReviews(query = {}) {
    return adminReviewRepository.listReviews(query);
  }

  async getReviewById(id) {
    if (!id) throw new ValidationError('Review ID is required');
    const review = await adminReviewRepository.findReviewById(id);
    if (!review) throw new NotFoundError('Review not found', ERROR_CODES.NOT_FOUND);
    return { review };
  }

  async updateReviewStatus(id, body = {}, auditContext = {}) {
    if (!id) throw new ValidationError('Review ID is required');
    const status = body.status;
    if (!status) throw new ValidationError('status is required');

    const current = await adminReviewRepository.findReviewById(id);
    if (!current) throw new NotFoundError('Review not found', ERROR_CODES.NOT_FOUND);

    const updated = await adminReviewRepository.updateReviewStatus(id, status);

    await adminActionRepository.createAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: 'reviews.update',
      action: 'REVIEW_STATUS_CHANGED',
      targetResource: 'REVIEW',
      targetResourceId: id,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState: { status: current.status },
      afterState: { status },
      metadata: { reason: body.reason },
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      action: 'REVIEW_STATUS_CHANGED',
      targetResource: 'REVIEW',
      targetResourceId: id,
      metadata: { from: current.status, to: status, reason: body.reason },
    });

    return { review: updated };
  }

  async listReviewReports(query = {}) {
    return adminReviewRepository.listReviewReports(query);
  }

  async resolveReviewReport(id, body = {}, auditContext = {}) {
    if (!id) throw new ValidationError('Report ID is required');
    const resolutionNote = body.resolutionNote || body.resolution_note || 'Resolved by admin';
    const newStatus = body.status || 'resolved';

    const updated = await adminReviewRepository.resolveReviewReport(id, {
      resolvedBy: auditContext.actorId || null,
      resolutionNote,
      newStatus,
    });

    if (!updated) {
      throw new NotFoundError('Review report not found', ERROR_CODES.NOT_FOUND);
    }

    await adminActionRepository.createAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: 'reviews.resolve_report',
      action: 'REVIEW_REPORT_RESOLVED',
      targetResource: 'REVIEW_REPORT',
      targetResourceId: id,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      afterState: updated,
      metadata: { resolutionNote, newStatus },
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      action: 'REVIEW_REPORT_RESOLVED',
      targetResource: 'REVIEW_REPORT',
      targetResourceId: id,
      metadata: { resolutionNote, newStatus },
    });

    return { report: updated };
  }
}

module.exports = new AdminReviewService();
