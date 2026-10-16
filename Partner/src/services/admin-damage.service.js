'use strict';

const DamageReportRepository = require('../repositories/damage-report.repository');
const outboxService = require('./outbox.service');
const { NotFoundError, BadRequestError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

class AdminDamageService {
  constructor(damageRepo = new DamageReportRepository()) {
    this.damageReportRepository = damageRepo;
  }

  /**
   * List all damage reports across the platform (Admin).
   *
   * @param {object} options
   * @returns {Promise<object>}
   */
  async listDamages(options = {}) {
    const { rows, total } = await this.damageReportRepository.findPaginated(options);

    const items = rows.map((row) => this._formatDamage(row));
    const page = options.page || 1;
    const limit = options.limit || 20;
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      pagination: {
        page,
        limit,
        totalItems: total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Get single damage report details with joined booking and vehicle data.
   *
   * @param {string} damageId
   * @returns {Promise<object>}
   */
  async getDamageById(damageId) {
    const damage = await this.damageReportRepository.findById(damageId);
    if (!damage) {
      throw new NotFoundError(
        'Damage report not found',
        ERROR_CODES.NOT_FOUND,
      );
    }
    return this._formatDamage(damage);
  }

  /**
   * Moves a damage report to UNDER_REVIEW.
   *
   * @param {string} damageId
   * @returns {Promise<object>}
   */
  async markUnderReview(damageId) {
    const damage = await this.damageReportRepository.findById(damageId);
    if (!damage) {
      throw new NotFoundError('Damage report not found', ERROR_CODES.NOT_FOUND);
    }

    if (damage.status !== 'REPORTED') {
      throw new BadRequestError(
        `Damage report cannot be marked under review from status '${damage.status}'`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const updated = await this.damageReportRepository.updateStatus(damageId, {
      status: 'UNDER_REVIEW',
    });

    return this._formatDamage(updated);
  }

  /**
   * Approves a damage report with authoritative approvedAmount.
   *
   * @param {string} damageId
   * @param {object} payload
   * @param {number} payload.approvedAmount
   * @returns {Promise<object>}
   */
  async approveDamage(damageId, payload) {
    const { approvedAmount } = payload;
    const damage = await this.damageReportRepository.findById(damageId);
    if (!damage) {
      throw new NotFoundError('Damage report not found', ERROR_CODES.NOT_FOUND);
    }

    if (!['REPORTED', 'UNDER_REVIEW'].includes(damage.status)) {
      throw new BadRequestError(
        `Damage report in status '${damage.status}' cannot be approved`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const updated = await this.damageReportRepository.updateStatus(damageId, {
      status: 'APPROVED',
      approvedAmount,
    });

    return this._formatDamage(updated);
  }

  /**
   * Rejects a damage report.
   *
   * @param {string} damageId
   * @param {object} payload
   * @param {string} [payload.reason]
   * @returns {Promise<object>}
   */
  async rejectDamage(damageId, _payload = {}) {
    const damage = await this.damageReportRepository.findById(damageId);
    if (!damage) {
      throw new NotFoundError('Damage report not found', ERROR_CODES.NOT_FOUND);
    }

    if (!['REPORTED', 'UNDER_REVIEW'].includes(damage.status)) {
      throw new BadRequestError(
        `Damage report in status '${damage.status}' cannot be rejected`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const updated = await this.damageReportRepository.updateStatus(damageId, {
      status: 'REJECTED',
    });

    return this._formatDamage(updated);
  }

  /**
   * Settles an approved damage report.
   *
   * @param {string} damageId
   * @returns {Promise<object>}
   */
  async settleDamage(damageId) {
    const damage = await this.damageReportRepository.findById(damageId);
    if (!damage) {
      throw new NotFoundError('Damage report not found', ERROR_CODES.NOT_FOUND);
    }

    if (damage.status !== 'APPROVED') {
      throw new BadRequestError(
        `Damage report must be in 'APPROVED' status before it can be settled (current: '${damage.status}')`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const updated = await this.damageReportRepository.updateStatus(damageId, {
      status: 'SETTLED',
    });

    await outboxService.recordEvent({
      eventType: 'DAMAGE_SETTLED',
      aggregateType: 'DAMAGE_REPORT',
      aggregateId: damage.id,
      payload: {
        partnerId: damage.partner_id,
        damageId: damage.id,
        bookingId: damage.booking_id,
        approvedAmount: damage.approved_amount,
      },
    }).catch(() => {});

    return this._formatDamage(updated);
  }

  _formatDamage(row) {
    const approvedAmount = row.approved_amount !== null
      ? Number(Number(row.approved_amount).toFixed(2))
      : null;

    return {
      id: row.id,
      bookingId: row.booking_id,
      bookingNumber: row.booking_number || null,
      vehicleId: row.vehicle_id,
      vehicle: row.registration_number ? {
        registrationNumber: row.registration_number,
        brand: row.brand,
        model: row.model,
      } : null,
      reportedBy: row.reported_by,
      damageType: row.damage_type,
      description: row.description,
      estimatedAmount: Number(Number(row.estimated_amount || 0).toFixed(2)),
      approvedAmount,
      status: row.status,
      photos: row.photos || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new AdminDamageService();
