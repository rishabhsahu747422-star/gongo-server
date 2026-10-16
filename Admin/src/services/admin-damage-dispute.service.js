'use strict';

const crypto = require('crypto');
const adminDamageDisputeRepository = require('../repositories/admin-damage-dispute.repository');
const adminPaymentRepository = require('../repositories/admin-payment.repository');
const adminWalletRepository = require('../repositories/admin-wallet.repository');
const s3Provider = require('../providers/s3');
const auditService = require('./audit.service');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(id, fieldName = 'ID') {
  if (!id || typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new BadRequestError(`Invalid ${fieldName}: must be a valid RFC 4122 UUID v4`, ERROR_CODES.VALIDATION_ERROR);
  }
  return id;
}

function validateDateRange(startDate, endDate) {
  if (!startDate && !endDate) return;

  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  if (start && Number.isNaN(start.getTime())) {
    throw new BadRequestError('Invalid startDate format; expected ISO 8601 string', ERROR_CODES.VALIDATION_ERROR);
  }
  if (end && Number.isNaN(end.getTime())) {
    throw new BadRequestError('Invalid endDate format; expected ISO 8601 string', ERROR_CODES.VALIDATION_ERROR);
  }
  if (start && end && start > end) {
    throw new BadRequestError('startDate cannot be after endDate', ERROR_CODES.VALIDATION_ERROR);
  }

  if (start && end) {
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 366) {
      throw new BadRequestError('Date range cannot exceed 366 days', ERROR_CODES.VALIDATION_ERROR);
    }
  }
}

function assertReason(reason, fieldName = 'Reason', minLen = 3, maxLen = 500) {
  if (typeof reason !== 'string' || reason.trim().length < minLen) {
    throw new BadRequestError(
      `${fieldName} must be at least ${minLen} characters long`,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  if (reason.trim().length > maxLen) {
    throw new BadRequestError(
      `${fieldName} cannot exceed ${maxLen} characters`,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  return reason.trim();
}

async function signEvidencePhotos(photos = []) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return [];
  }

  const validPhotos = photos.filter((p) => p && typeof p === 'string');
  return Promise.all(
    validPhotos.map(async (photo) => {
      if (photo.startsWith('http://') || photo.startsWith('https://')) {
        return {
          key: photo,
          downloadUrl: photo,
          expiresInSeconds: 900,
        };
      }
      try {
        const res = await s3Provider.createPresignedGetUrl({
          key: photo,
          expiresInSeconds: 900,
        });
        return {
          key: photo,
          downloadUrl: res.downloadUrl,
          expiresInSeconds: 900,
        };
      } catch (_) {
        return {
          key: photo,
          downloadUrl: null,
        };
      }
    }),
  );
}

class AdminDamageDisputeService {
  // ══════════════════════════════════════════════════════════════════════════════
  // DAMAGE REPORTS
  // ══════════════════════════════════════════════════════════════════════════════

  async listDamages(queryParams = {}) {
    const {
      search,
      damageId,
      bookingId,
      bookingNumber,
      vehicleId,
      registrationNumber,
      partnerId,
      customerId,
      status,
      damageType,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    } = queryParams;

    if (damageId) assertUuid(damageId, 'damageId');
    if (bookingId) assertUuid(bookingId, 'bookingId');
    if (vehicleId) assertUuid(vehicleId, 'vehicleId');
    if (partnerId) assertUuid(partnerId, 'partnerId');
    if (customerId) assertUuid(customerId, 'customerId');

    validateDateRange(startDate, endDate);

    return adminDamageDisputeRepository.listDamages({
      search,
      damageId,
      bookingId,
      bookingNumber,
      vehicleId,
      registrationNumber,
      partnerId,
      customerId,
      status,
      damageType,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  async getDamageById(id) {
    const validId = assertUuid(id, 'damageId');
    const damage = await adminDamageDisputeRepository.getDamageById(validId);
    if (!damage) {
      throw new NotFoundError('Damage report not found', ERROR_CODES.NOT_FOUND);
    }
    return damage;
  }

  async getDamageEvidence(id) {
    const validId = assertUuid(id, 'damageId');
    const damage = await adminDamageDisputeRepository.getDamageById(validId);
    if (!damage) {
      throw new NotFoundError('Damage report not found', ERROR_CODES.NOT_FOUND);
    }

    const signedPhotos = await signEvidencePhotos(damage.photos);

    return {
      damageId: damage.id,
      bookingId: damage.bookingId,
      photos: signedPhotos,
    };
  }

  async getDamageBooking(id) {
    const damage = await this.getDamageById(id);
    if (!damage.booking) {
      throw new NotFoundError('Associated booking not found', ERROR_CODES.NOT_FOUND);
    }
    return damage.booking;
  }

  async getDamageVehicle(id) {
    const damage = await this.getDamageById(id);
    if (!damage.vehicle) {
      throw new NotFoundError('Associated vehicle not found', ERROR_CODES.NOT_FOUND);
    }
    return damage.vehicle;
  }

  async getDamagePartner(id) {
    const damage = await this.getDamageById(id);
    if (!damage.partner) {
      throw new NotFoundError('Associated partner not found', ERROR_CODES.NOT_FOUND);
    }
    return damage.partner;
  }

  async getDamageCustomer(id) {
    const damage = await this.getDamageById(id);
    if (!damage.customer) {
      throw new NotFoundError('Associated customer not found', ERROR_CODES.NOT_FOUND);
    }
    return damage.customer;
  }

  async getDamageInspections(id) {
    const damage = await this.getDamageById(id);
    const inspections = await adminDamageDisputeRepository.getDamageInspections(damage.bookingId);

    const [pickupPhotos, returnPhotos] = await Promise.all([
      inspections.pickup?.photos ? signEvidencePhotos(inspections.pickup.photos) : [],
      inspections.return?.photos ? signEvidencePhotos(inspections.return.photos) : [],
    ]);

    return {
      damageId: damage.id,
      bookingId: damage.bookingId,
      pickup: inspections.pickup ? {
        ...inspections.pickup,
        photos: pickupPhotos,
      } : null,
      return: inspections.return ? {
        ...inspections.return,
        photos: returnPhotos,
      } : null,
    };
  }

  async reviewDamage(id, adminUser, auditMeta = {}) {
    const validId = assertUuid(id, 'damageId');

    return adminDamageDisputeRepository.executeInTransaction(async (client) => {
      const damage = await adminDamageDisputeRepository.getDamageForUpdate(client, validId);
      if (!damage) {
        throw new NotFoundError('Damage report not found', ERROR_CODES.NOT_FOUND);
      }

      if (damage.status !== 'REPORTED') {
        throw new ConflictError(
          `Cannot mark damage report under review from status '${damage.status}'. Current status must be 'REPORTED'.`,
          ERROR_CODES.CONFLICT,
        );
      }

      await adminDamageDisputeRepository.updateDamageStatus(client, validId, {
        status: 'UNDER_REVIEW',
      });

      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'damages.update',
        action: 'DAMAGE_STATUS_UPDATE',
        targetResource: 'DAMAGE_REPORT',
        targetResourceId: validId,
        beforeState: { status: damage.status },
        afterState: { status: 'UNDER_REVIEW' },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: { action: 'MARK_UNDER_REVIEW' },
      });

      return this.getDamageById(validId, client);
    });
  }

  async assessDamage(id, payload, adminUser, auditMeta = {}) {
    const validId = assertUuid(id, 'damageId');
    const body = payload || {};
    const { approvedAmount, notes, reason } = body;

    if (
      approvedAmount === undefined
      || approvedAmount === null
      || Number.isNaN(Number(approvedAmount))
    ) {
      throw new BadRequestError(
        'approvedAmount must be a valid non-negative number',
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const cleanAmount = Math.round(Number(approvedAmount) * 100) / 100;
    if (cleanAmount < 0) {
      throw new BadRequestError('approvedAmount cannot be negative', ERROR_CODES.VALIDATION_ERROR);
    }

    let cleanReason = 'Damage assessment approved by admin';
    if (reason) {
      cleanReason = assertReason(reason, 'Assessment reason', 3, 500);
    } else if (notes) {
      cleanReason = String(notes).trim();
    }

    return adminDamageDisputeRepository.executeInTransaction(async (client) => {
      const damage = await adminDamageDisputeRepository.getDamageForUpdate(client, validId);
      if (!damage) {
        throw new NotFoundError('Damage report not found', ERROR_CODES.NOT_FOUND);
      }

      if (!['REPORTED', 'UNDER_REVIEW'].includes(damage.status)) {
        throw new ConflictError(
          `Damage report in status '${damage.status}' cannot be assessed. Current status must be 'REPORTED' or 'UNDER_REVIEW'.`,
          ERROR_CODES.CONFLICT,
        );
      }

      await adminDamageDisputeRepository.updateDamageStatus(client, validId, {
        status: 'APPROVED',
        approvedAmount: cleanAmount,
      });

      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'damages.update',
        action: 'DAMAGE_ASSESS',
        targetResource: 'DAMAGE_REPORT',
        targetResourceId: validId,
        beforeState: {
          status: damage.status,
          approvedAmount: damage.approved_amount,
        },
        afterState: {
          status: 'APPROVED',
          approvedAmount: cleanAmount,
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: {
          reason: cleanReason,
          estimatedAmount: damage.estimated_amount,
          assessedAmount: cleanAmount,
        },
      });

      return this.getDamageById(validId, client);
    });
  }

  async rejectDamage(id, payload, adminUser, auditMeta = {}) {
    const validId = assertUuid(id, 'damageId');
    const body = payload || {};
    const { reason } = body;
    const cleanReason = assertReason(reason, 'Rejection reason', 3, 500);

    return adminDamageDisputeRepository.executeInTransaction(async (client) => {
      const damage = await adminDamageDisputeRepository.getDamageForUpdate(client, validId);
      if (!damage) {
        throw new NotFoundError('Damage report not found', ERROR_CODES.NOT_FOUND);
      }

      if (!['REPORTED', 'UNDER_REVIEW'].includes(damage.status)) {
        throw new ConflictError(
          `Damage report in terminal or settled status '${damage.status}' cannot be rejected.`,
          ERROR_CODES.CONFLICT,
        );
      }

      await adminDamageDisputeRepository.updateDamageStatus(client, validId, {
        status: 'REJECTED',
      });

      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'damages.update',
        action: 'DAMAGE_REJECT',
        targetResource: 'DAMAGE_REPORT',
        targetResourceId: validId,
        beforeState: { status: damage.status },
        afterState: { status: 'REJECTED' },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: { reason: cleanReason },
      });

      return this.getDamageById(validId, client);
    });
  }

  async settleDamage(id, payload, adminUser, auditMeta = {}) {
    const validId = assertUuid(id, 'damageId');
    const body = payload || {};
    const { notes } = body;

    return adminDamageDisputeRepository.executeInTransaction(async (client) => {
      const damage = await adminDamageDisputeRepository.getDamageForUpdate(client, validId);
      if (!damage) {
        throw new NotFoundError('Damage report not found', ERROR_CODES.NOT_FOUND);
      }

      if (damage.status !== 'APPROVED') {
        throw new ConflictError(
          `Damage report must be in 'APPROVED' status before it can be settled (current: '${damage.status}').`,
          ERROR_CODES.CONFLICT,
        );
      }

      await adminDamageDisputeRepository.updateDamageStatus(client, validId, {
        status: 'SETTLED',
      });

      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'damages.update',
        action: 'DAMAGE_SETTLE',
        targetResource: 'DAMAGE_REPORT',
        targetResourceId: validId,
        beforeState: { status: damage.status },
        afterState: { status: 'SETTLED' },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: {
          approvedAmount: damage.approved_amount,
          notes: notes ? String(notes).trim() : null,
        },
      });

      return this.getDamageById(validId, client);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // DISPUTES
  // ══════════════════════════════════════════════════════════════════════════════

  async listDisputes(queryParams = {}) {
    const {
      search,
      disputeId,
      disputeNumber,
      bookingId,
      customerId,
      partnerId,
      vehicleId,
      damageReportId,
      status,
      disputeType,
      priority,
      assignedTo,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    } = queryParams;

    if (disputeId) assertUuid(disputeId, 'disputeId');
    if (bookingId) assertUuid(bookingId, 'bookingId');
    if (customerId) assertUuid(customerId, 'customerId');
    if (partnerId) assertUuid(partnerId, 'partnerId');
    if (vehicleId) assertUuid(vehicleId, 'vehicleId');
    if (damageReportId) assertUuid(damageReportId, 'damageReportId');
    if (assignedTo) assertUuid(assignedTo, 'assignedTo');

    validateDateRange(startDate, endDate);

    return adminDamageDisputeRepository.listDisputes({
      search,
      disputeId,
      disputeNumber,
      bookingId,
      customerId,
      partnerId,
      vehicleId,
      damageReportId,
      status,
      disputeType,
      priority,
      assignedTo,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  async getDisputeById(id) {
    const validId = assertUuid(id, 'disputeId');
    const dispute = await adminDamageDisputeRepository.getDisputeById(validId);
    if (!dispute) {
      throw new NotFoundError('Dispute not found', ERROR_CODES.NOT_FOUND);
    }
    return dispute;
  }

  async getDisputeEvidence(id) {
    const validId = assertUuid(id, 'disputeId');
    const dispute = await adminDamageDisputeRepository.getDisputeById(validId);
    if (!dispute) {
      throw new NotFoundError('Dispute not found', ERROR_CODES.NOT_FOUND);
    }

    const signedEvidence = await signEvidencePhotos(dispute.evidence);

    return {
      disputeId: dispute.id,
      disputeNumber: dispute.disputeNumber,
      evidence: signedEvidence,
    };
  }

  async getDisputeTimeline(id) {
    const validId = assertUuid(id, 'disputeId');
    const dispute = await adminDamageDisputeRepository.getDisputeById(validId);
    if (!dispute) {
      throw new NotFoundError('Dispute not found', ERROR_CODES.NOT_FOUND);
    }

    const timelineActions = await adminDamageDisputeRepository.getDisputeTimeline(validId);

    const milestones = [
      {
        milestone: 'CREATED',
        timestamp: dispute.createdAt,
        actor: dispute.claimant?.name || 'Customer/Partner',
        description: `Dispute created with status '${dispute.status}' and priority '${dispute.priority}'`,
      },
    ];

    if (dispute.assignedAt) {
      milestones.push({
        milestone: 'ASSIGNED',
        timestamp: dispute.assignedAt,
        actor: dispute.assignedAdmin?.name || 'Admin',
        description: `Dispute assigned to ${dispute.assignedAdmin?.name || dispute.assignedTo}`,
      });
    }

    if (dispute.resolvedAt) {
      milestones.push({
        milestone: dispute.status === 'RESOLVED' ? 'RESOLVED' : 'REJECTED',
        timestamp: dispute.resolvedAt,
        actor: dispute.resolver?.name || 'Admin Resolver',
        description: dispute.resolution || dispute.rejectionReason || `Dispute ${dispute.status.toLowerCase()}`,
      });
    }

    return {
      disputeId: dispute.id,
      disputeNumber: dispute.disputeNumber,
      status: dispute.status,
      milestones,
      auditEvents: timelineActions,
    };
  }

  async assignDispute(id, payload, adminUser, auditMeta = {}) {
    const validId = assertUuid(id, 'disputeId');
    const body = payload || {};
    const { adminUserId, reason } = body;
    const targetUserId = assertUuid(adminUserId, 'adminUserId');

    const targetUser = await adminDamageDisputeRepository.getActiveAdminUser(targetUserId);
    if (!targetUser) {
      throw new NotFoundError('Target admin user not found', ERROR_CODES.NOT_FOUND);
    }

    if (targetUser.role !== 'ADMIN' || !targetUser.is_active) {
      throw new ForbiddenError(
        'Disputes can only be assigned to active ADMIN users',
        ERROR_CODES.FORBIDDEN,
      );
    }

    return adminDamageDisputeRepository.executeInTransaction(async (client) => {
      const dispute = await adminDamageDisputeRepository.getDisputeForUpdate(client, validId);
      if (!dispute) {
        throw new NotFoundError('Dispute not found', ERROR_CODES.NOT_FOUND);
      }

      if (['RESOLVED', 'REJECTED', 'CLOSED'].includes(dispute.status)) {
        throw new ConflictError(
          `Cannot assign or reassign dispute in terminal status '${dispute.status}'.`,
          ERROR_CODES.CONFLICT,
        );
      }

      const previousAssignee = dispute.assigned_to;
      const assignedAt = new Date();

      await adminDamageDisputeRepository.assignDispute(client, validId, {
        assignedTo: targetUserId,
        assignedAt,
      });

      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'disputes.resolve',
        action: 'DISPUTE_ASSIGN',
        targetResource: 'DISPUTE',
        targetResourceId: validId,
        beforeState: {
          assignedTo: previousAssignee,
          status: dispute.status,
        },
        afterState: {
          assignedTo: targetUserId,
          assignedToName: targetUser.name,
          status: dispute.status === 'OPEN' ? 'UNDER_INVESTIGATION' : dispute.status,
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: {
          previousAssignee,
          newAssignee: targetUserId,
          newAssigneeName: targetUser.name,
          reason: reason ? String(reason).trim() : null,
        },
      });

      return this.getDisputeById(validId, client);
    });
  }

  async resolveDispute(id, payload, adminUser, auditMeta = {}) {
    const validId = assertUuid(id, 'disputeId');
    const body = payload || {};
    const {
      resolution,
      resolutionReason,
      settledAmount,
      financialAction = 'NONE',
      financialNotes,
    } = body;

    const cleanResolution = assertReason(resolution, 'Resolution', 3, 200);
    const cleanReason = assertReason(resolutionReason, 'Resolution reason', 3, 500);

    const validActions = ['NONE', 'REFUND_CUSTOMER', 'ADJUST_WALLET'];
    if (!validActions.includes(financialAction)) {
      throw new BadRequestError(
        `Invalid financialAction '${financialAction}'. Must be one of: ${validActions.join(', ')}`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    let cleanSettledAmount = 0.00;
    if (settledAmount !== undefined && settledAmount !== null) {
      if (Number.isNaN(Number(settledAmount)) || Number(settledAmount) < 0) {
        throw new BadRequestError('settledAmount must be a non-negative number', ERROR_CODES.VALIDATION_ERROR);
      }
      cleanSettledAmount = Math.round(Number(settledAmount) * 100) / 100;
    }

    return adminDamageDisputeRepository.executeInTransaction(async (client) => {
      const dispute = await adminDamageDisputeRepository.getDisputeForUpdate(client, validId);
      if (!dispute) {
        throw new NotFoundError('Dispute not found', ERROR_CODES.NOT_FOUND);
      }

      if (['RESOLVED', 'REJECTED', 'CLOSED'].includes(dispute.status)) {
        throw new ConflictError(
          `Dispute is already in terminal status '${dispute.status}' and cannot be resolved again.`,
          ERROR_CODES.CONFLICT,
        );
      }

      let financialReferenceId = null;

      // ── Financial Consequence Integration ─────────────────────────────────────
      if (financialAction === 'REFUND_CUSTOMER' && cleanSettledAmount > 0) {
        // Find successful payment for the booking
        const payRes = await client.query(`
          SELECT * FROM payments
          WHERE booking_id = $1 AND status = 'SUCCESS'
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE;
        `, [dispute.booking_id]);

        const payment = payRes.rows[0];
        if (!payment) {
          throw new BadRequestError(
            'Cannot issue customer refund: no successful payment found for this booking.',
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        const refundSummary = await adminPaymentRepository.getPaymentRefundsSummary(
          payment.id,
          client,
        );
        const totalAlreadyRefunded = refundSummary.completedRefundAmount
          + refundSummary.pendingRefundAmount;
        const remainingRefundable = Math.round(
          (Number(payment.amount) - totalAlreadyRefunded) * 100,
        ) / 100;

        if (cleanSettledAmount > remainingRefundable) {
          throw new BadRequestError(
            `Settled refund amount (${cleanSettledAmount}) exceeds remaining refundable amount `
            + `(${remainingRefundable}) on payment ${payment.id}.`,
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        const refundNumber = `REF-DSP-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        const refundRecord = await adminPaymentRepository.createRefund(client, {
          refundNumber,
          bookingId: dispute.booking_id,
          paymentId: payment.id,
          customerId: dispute.customer_id,
          requestedAmount: cleanSettledAmount,
          approvedAmount: cleanSettledAmount,
          refundedAmount: cleanSettledAmount,
          currency: dispute.currency || 'INR',
          reason: `Dispute ${dispute.dispute_number} resolution: ${cleanReason}`,
          status: 'COMPLETED',
          provider: 'CASHFREE',
          providerRefundId: `MANUAL-${refundNumber}`,
          processedBy: adminUser.id,
          processedAt: new Date(),
        });

        financialReferenceId = refundRecord.id;

        await auditService.logAdminAction({
          actorId: adminUser.id || 'system-admin',
          actorRole: adminUser.role || 'ADMIN',
          permission: auditMeta.permission || 'disputes.resolve',
          action: 'DISPUTE_FINANCIAL_ACTION',
          targetResource: 'DISPUTE',
          targetResourceId: validId,
          beforeState: { remainingRefundable },
          afterState: {
            refundId: refundRecord.id,
            refundNumber,
            refundedAmount: cleanSettledAmount,
          },
          requestId: auditMeta.requestId || null,
          ipAddress: auditMeta.ipAddress || null,
          userAgent: auditMeta.userAgent || null,
          metadata: {
            disputeId: validId,
            financialAction: 'REFUND_CUSTOMER',
            paymentId: payment.id,
            amount: cleanSettledAmount,
          },
        });
      } else if (financialAction === 'ADJUST_WALLET' && cleanSettledAmount > 0) {
        // Repository signature is (client, partnerId)
        const wallet = await adminWalletRepository.getWalletByPartnerIdForUpdate(
          client,
          dispute.partner_id,
        );
        if (!wallet) {
          throw new NotFoundError(
            `Partner wallet not found for partner ${dispute.partner_id}`,
            ERROR_CODES.NOT_FOUND,
          );
        }

        const currentBalance = Number(wallet.available_balance || 0);
        const newBalance = Math.max(
          0,
          Math.round((currentBalance - cleanSettledAmount) * 100) / 100,
        );
        const deducted = Math.round((currentBalance - newBalance) * 100) / 100;

        // A dispute deduction is an admin-initiated wallet debit: recorded like a manual
        // adjustment so (1) it satisfies the live ledger CHECKs (transaction_type
        // 'admin_adjustment', reference_type 'admin' — 'debit'/'dispute_resolution' were
        // rejected), (2) it is written once to wallets and copied to the partner_wallets
        // mirror, and (3) Partner's wallet recalculation includes it instead of erasing it.
        if (deducted > 0) {
          await adminWalletRepository.adjustAvailableBalance(client, dispute.partner_id, -deducted);
        }

        const txn = deducted > 0 ? await adminWalletRepository.createWalletTransaction(client, {
          walletId: wallet.id,
          partnerId: dispute.partner_id,
          transactionType: 'ADMIN_ADJUSTMENT',
          direction: 'DEBIT',
          amount: deducted,
          balanceBefore: currentBalance,
          balanceAfter: newBalance,
          referenceType: 'ADMIN',
          referenceId: validId,
          status: 'COMPLETED',
          description: `Dispute ${dispute.dispute_number} resolution deduction: ${cleanReason}`,
          metadata: {
            kind: 'DISPUTE_RESOLUTION',
            disputeId: validId,
            disputeNumber: dispute.dispute_number,
            requestedAmount: cleanSettledAmount,
          },
        }) : null;

        financialReferenceId = txn ? txn.id : null;

        await auditService.logAdminAction({
          actorId: adminUser.id || 'system-admin',
          actorRole: adminUser.role || 'ADMIN',
          permission: auditMeta.permission || 'disputes.resolve',
          action: 'DISPUTE_FINANCIAL_ACTION',
          targetResource: 'DISPUTE',
          targetResourceId: validId,
          beforeState: {
            walletId: wallet.id,
            availableBalance: currentBalance,
          },
          afterState: {
            walletId: wallet.id,
            availableBalance: newBalance,
            transactionId: txn ? txn.id : null,
          },
          requestId: auditMeta.requestId || null,
          ipAddress: auditMeta.ipAddress || null,
          userAgent: auditMeta.userAgent || null,
          metadata: {
            disputeId: validId,
            financialAction: 'ADJUST_WALLET',
            walletId: wallet.id,
            amount: cleanSettledAmount,
          },
        });
      }

      const resolvedAt = new Date();
      await adminDamageDisputeRepository.updateDisputeStatus(client, validId, {
        status: 'RESOLVED',
        resolution: cleanResolution,
        resolutionReason: cleanReason,
        settledAmount: cleanSettledAmount,
        resolvedBy: adminUser.id,
        resolvedAt,
        financialAction,
        financialReferenceId,
        metadata: {
          financialNotes: financialNotes ? String(financialNotes).trim() : null,
        },
      });

      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'disputes.resolve',
        action: 'DISPUTE_RESOLVE',
        targetResource: 'DISPUTE',
        targetResourceId: validId,
        beforeState: { status: dispute.status },
        afterState: {
          status: 'RESOLVED',
          settledAmount: cleanSettledAmount,
          financialAction,
          financialReferenceId,
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: {
          resolution: cleanResolution,
          reason: cleanReason,
          settledAmount: cleanSettledAmount,
          financialAction,
        },
      });

      return this.getDisputeById(validId, client);
    });
  }

  async rejectDispute(id, payload, adminUser, auditMeta = {}) {
    const validId = assertUuid(id, 'disputeId');
    const body = payload || {};
    const { rejectionReason } = body;
    const cleanReason = assertReason(rejectionReason, 'Rejection reason', 3, 500);

    return adminDamageDisputeRepository.executeInTransaction(async (client) => {
      const dispute = await adminDamageDisputeRepository.getDisputeForUpdate(client, validId);
      if (!dispute) {
        throw new NotFoundError('Dispute not found', ERROR_CODES.NOT_FOUND);
      }

      if (['RESOLVED', 'REJECTED', 'CLOSED'].includes(dispute.status)) {
        throw new ConflictError(
          `Dispute is already in terminal status '${dispute.status}' and cannot be rejected again.`,
          ERROR_CODES.CONFLICT,
        );
      }

      const resolvedAt = new Date();
      await adminDamageDisputeRepository.updateDisputeStatus(client, validId, {
        status: 'REJECTED',
        rejectionReason: cleanReason,
        resolvedBy: adminUser.id,
        resolvedAt,
      });

      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'disputes.resolve',
        action: 'DISPUTE_REJECT',
        targetResource: 'DISPUTE',
        targetResourceId: validId,
        beforeState: { status: dispute.status },
        afterState: {
          status: 'REJECTED',
          rejectionReason: cleanReason,
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: { rejectionReason: cleanReason },
      });

      return this.getDisputeById(validId, client);
    });
  }

  /**
   * Operational helper to create dispute (e.g. for testing / seed).
   */
  async createDispute(payload, adminUser, auditMeta = {}) {
    const {
      bookingId,
      customerId,
      partnerId,
      vehicleId,
      damageReportId,
      claimantId,
      respondentId,
      disputeType = 'GENERAL',
      priority = 'MEDIUM',
      disputedAmount = 0.00,
      description,
      evidence = [],
      metadata = {},
    } = payload;

    assertUuid(bookingId, 'bookingId');
    assertUuid(customerId, 'customerId');
    assertUuid(partnerId, 'partnerId');
    assertUuid(claimantId, 'claimantId');
    if (vehicleId) assertUuid(vehicleId, 'vehicleId');
    if (damageReportId) assertUuid(damageReportId, 'damageReportId');
    if (respondentId) assertUuid(respondentId, 'respondentId');

    const cleanDescription = assertReason(description, 'Description', 3, 2000);
    const disputeNumber = `DSP-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    const dispute = await adminDamageDisputeRepository.createDispute({
      disputeNumber,
      bookingId,
      customerId,
      partnerId,
      vehicleId: vehicleId || null,
      damageReportId: damageReportId || null,
      claimantId,
      respondentId: respondentId || null,
      disputeType,
      status: 'OPEN',
      priority,
      disputedAmount: Number(disputedAmount || 0),
      currency: 'INR',
      description: cleanDescription,
      evidence: Array.isArray(evidence) ? evidence : [],
      metadata,
    });

    if (auditMeta && auditMeta.requestId) {
      await auditService.logAdminAction({
        actorId: adminUser?.id || 'system-admin',
        actorRole: adminUser?.role || 'ADMIN',
        permission: auditMeta.permission || 'disputes.resolve',
        action: 'DISPUTE_CREATE',
        targetResource: 'DISPUTE',
        targetResourceId: dispute.id,
        beforeState: null,
        afterState: {
          disputeId: dispute.id,
          disputeNumber,
          status: 'OPEN',
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: { disputeNumber },
      });
    }

    return this.getDisputeById(dispute.id);
  }

  async updateDisputeStatus(id, payload, adminUser, auditMeta = {}) {
    const validId = assertUuid(id, 'disputeId');
    const { status, reason } = payload || {};
    if (!status) throw new BadRequestError('status is required', ERROR_CODES.VALIDATION_ERROR);

    return adminDamageDisputeRepository.executeInTransaction(async (client) => {
      const dispute = await adminDamageDisputeRepository.getDisputeForUpdate(client, validId);
      if (!dispute) throw new NotFoundError('Dispute not found', ERROR_CODES.NOT_FOUND);

      const beforeStatus = dispute.status;
      await client.query(`UPDATE disputes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [status, validId]);

      await auditService.logAdminAction({
        actorId: adminUser?.id || 'system-admin',
        actorRole: adminUser?.role || 'ADMIN',
        permission: auditMeta.permission || 'disputes.resolve',
        action: 'DISPUTE_STATUS_CHANGED',
        targetResource: 'DISPUTE',
        targetResourceId: validId,
        beforeState: { status: beforeStatus },
        afterState: { status },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: { reason },
      });

      return this.getDisputeById(validId, client);
    });
  }
}

const adminDamageDisputeService = new AdminDamageDisputeService();

module.exports = adminDamageDisputeService;
module.exports.AdminDamageDisputeService = AdminDamageDisputeService;
