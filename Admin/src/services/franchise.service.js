'use strict';

const franchiseRepository = require('../repositories/franchise.repository');
const { NotFoundError, ConflictError } = require('../errors');
const logger = require('../config/logger');

class FranchiseService {
  /**
   * Submits a public franchise application with spam/duplicate detection.
   */
  async submitApplication(data, clientIp = null) {
    // 1. Spam / duplicate detection: Check if application with same phone/email was submitted within 10 min
    const recent = await franchiseRepository.findRecentDuplicate(data.phone, data.email, 10);
    if (recent) {
      throw new ConflictError(
        'An application with this contact details was recently submitted. Our team will contact you shortly.',
        'DUPLICATE_APPLICATION',
      );
    }

    // 2. Persist to database
    const created = await franchiseRepository.createApplication(data);

    logger.info('Franchise application received and persisted', {
      applicationId: created.id,
      city: created.city,
      email: created.email,
      ip: clientIp,
    });

    return {
      id: created.id,
      applicantName: created.applicant_name,
      phone: created.phone,
      email: created.email,
      city: created.city,
      state: created.state,
      investmentCapacity: created.investment_capacity,
      businessExperience: created.business_experience,
      status: created.status,
      createdAt: created.created_at,
    };
  }

  /**
   * Lists franchise applications with pagination and filters for Admin Portal.
   */
  async listApplications({ page = 1, limit = 10, status = 'all', search = null, sortBy = 'created_at', sortOrder = 'DESC' } = {}) {
    const offset = (page - 1) * limit;

    const { items, total } = await franchiseRepository.listApplications({
      search,
      status,
      limit,
      offset,
      sortBy,
      sortOrder,
    });

    const formattedItems = items.map(this._formatApplication);

    return {
      items: formattedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Retrieves single franchise application detail by UUID.
   */
  async getApplicationById(id) {
    const record = await franchiseRepository.getApplicationById(id);
    if (!record) {
      throw new NotFoundError('Franchise application not found', 'FRANCHISE_APPLICATION_NOT_FOUND');
    }
    return this._formatApplication(record);
  }

  /**
   * Updates application status with administrative audit trail.
   */
  async updateApplicationStatus(id, { status, adminNotes = null } = {}, auditContext = {}) {
    const existing = await franchiseRepository.getApplicationById(id);
    if (!existing) {
      throw new NotFoundError('Franchise application not found', 'FRANCHISE_APPLICATION_NOT_FOUND');
    }

    const reviewerId = auditContext.actorId || null;
    const updated = await franchiseRepository.updateStatus(id, {
      status,
      adminNotes,
      reviewedBy: reviewerId,
    });

    if (auditContext.audit && typeof auditContext.audit === 'function') {
      auditContext.audit({
        action: 'FRANCHISE_APPLICATION_STATUS_UPDATE',
        targetResource: 'franchise_applications',
        targetResourceId: id,
        beforeState: { status: existing.status, adminNotes: existing.admin_notes },
        afterState: { status: updated.status, adminNotes: updated.admin_notes },
        metadata: {
          applicantName: existing.applicant_name,
          city: existing.city,
          reviewerId,
        },
      });
    }

    logger.info('Franchise application status updated', {
      applicationId: id,
      previousStatus: existing.status,
      newStatus: status,
      reviewedBy: reviewerId,
    });

    return this._formatApplication(updated);
  }

  _formatApplication(r) {
    if (!r) return null;
    return {
      id: r.id,
      applicantName: r.applicant_name,
      phone: r.phone,
      email: r.email,
      city: r.city,
      state: r.state || '',
      investmentCapacity: r.investment_capacity || '',
      businessExperience: r.business_experience || '',
      message: r.message || '',
      status: r.status,
      adminNotes: r.admin_notes || '',
      reviewedBy: r.reviewed_by || null,
      reviewedAt: r.reviewed_at || null,
      reviewerEmail: r.reviewer_email || null,
      reviewerName: r.reviewer_name || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

module.exports = new FranchiseService();
