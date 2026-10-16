'use strict';

const crypto = require('crypto');
const adminPaymentRepository = require('../repositories/admin-payment.repository');
const auditService = require('./audit.service');
const logger = require('../config/logger');
const { resolveFinancialActorId } = require('../security/financial-actor');

/**
 * Customer stores successful payments as 'paid' (PAYMENT_STATUS.SUCCESS = 'paid');
 * older/admin paths use 'SUCCESS'. Both satisfy chk_payments_status.
 *
 * @param {string} status
 * @returns {boolean}
 */
const isSuccessfulPaymentStatus = (status) => ['PAID', 'SUCCESS'].includes(String(status || '').toUpperCase());
const cashfreeProvider = require('../providers/cashfree');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require('../errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(id, fieldName = 'ID') {
  if (!id || typeof id !== 'string' || !UUID_REGEX.test(id)) {
    throw new BadRequestError(`Invalid ${fieldName}: must be a valid RFC 4122 UUID v4`);
  }
}

function validateDateRange(startDate, endDate) {
  if (!startDate && !endDate) return;

  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  if (start && Number.isNaN(start.getTime())) {
    throw new BadRequestError('Invalid startDate format; expected ISO 8601 string');
  }
  if (end && Number.isNaN(end.getTime())) {
    throw new BadRequestError('Invalid endDate format; expected ISO 8601 string');
  }
  if (start && end && start > end) {
    throw new BadRequestError('startDate cannot be after endDate');
  }

  if (start && end) {
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 366) {
      throw new BadRequestError('Date range cannot exceed 366 days');
    }
  }
}

class AdminPaymentService {
  // ══════════════════════════════════════════════════════════════════════════════
  // PAYMENTS
  // ══════════════════════════════════════════════════════════════════════════════

  async listPayments(queryParams = {}) {
    const {
      search,
      bookingId,
      bookingNumber,
      customerId,
      partnerId,
      paymentType,
      status,
      provider,
      providerPaymentId,
      providerOrderId,
      amountMin,
      amountMax,
      currency,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    } = queryParams;

    if (bookingId) assertUuid(bookingId, 'bookingId');
    if (customerId) assertUuid(customerId, 'customerId');
    if (partnerId) assertUuid(partnerId, 'partnerId');

    validateDateRange(startDate, endDate);

    if (amountMin !== undefined && amountMin !== null) {
      const min = Number(amountMin);
      if (Number.isNaN(min) || min < 0) {
        throw new BadRequestError('amountMin must be a non-negative number');
      }
    }

    if (amountMax !== undefined && amountMax !== null) {
      const max = Number(amountMax);
      if (Number.isNaN(max) || max < 0) {
        throw new BadRequestError('amountMax must be a non-negative number');
      }
    }

    if (
      amountMin !== undefined
      && amountMax !== undefined
      && Number(amountMin) > Number(amountMax)
    ) {
      throw new BadRequestError('amountMin cannot exceed amountMax');
    }

    return adminPaymentRepository.listPayments({
      search,
      bookingId,
      bookingNumber,
      customerId,
      partnerId,
      paymentType,
      status,
      provider,
      providerPaymentId,
      providerOrderId,
      amountMin,
      amountMax,
      currency,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  async getPaymentById(id) {
    assertUuid(id, 'paymentId');
    const payment = await adminPaymentRepository.getPaymentById(id);
    if (!payment) {
      throw new NotFoundError('Payment record not found');
    }
    return payment;
  }

  async getPaymentBooking(paymentId) {
    assertUuid(paymentId, 'paymentId');
    const booking = await adminPaymentRepository.getPaymentBooking(paymentId);
    if (!booking) {
      throw new NotFoundError('Associated booking not found for this payment');
    }
    return booking;
  }

  async getPaymentCustomer(paymentId) {
    assertUuid(paymentId, 'paymentId');
    const customer = await adminPaymentRepository.getPaymentCustomer(paymentId);
    if (!customer) {
      throw new NotFoundError('Associated customer not found for this payment');
    }
    return customer;
  }

  async getPaymentPartner(paymentId) {
    assertUuid(paymentId, 'paymentId');
    const partner = await adminPaymentRepository.getPaymentPartner(paymentId);
    if (!partner) {
      throw new NotFoundError('Associated partner not found for this payment');
    }
    return partner;
  }

  async getPaymentTimeline(paymentId) {
    assertUuid(paymentId, 'paymentId');
    const timeline = await adminPaymentRepository.getPaymentTimeline(paymentId);
    if (!timeline) {
      throw new NotFoundError('Payment record not found');
    }
    return timeline;
  }

  async getPaymentTransactions(paymentId) {
    assertUuid(paymentId, 'paymentId');
    const transactions = await adminPaymentRepository.getPaymentTransactions(paymentId);
    if (!transactions) {
      throw new NotFoundError('Payment record not found');
    }
    return transactions;
  }

  async getPaymentAttempts(paymentId) {
    assertUuid(paymentId, 'paymentId');
    const attempts = await adminPaymentRepository.getPaymentAttempts(paymentId);
    return {
      paymentId,
      attempts,
    };
  }

  async getPaymentWebhooks(paymentId) {
    assertUuid(paymentId, 'paymentId');
    const webhooks = await adminPaymentRepository.getPaymentWebhooks(paymentId);
    if (webhooks === null) {
      throw new NotFoundError('Payment record not found');
    }
    return webhooks;
  }

  async reconcilePayment(paymentId, adminUser, auditMeta = {}) {
    assertUuid(paymentId, 'paymentId');

    return adminPaymentRepository.executeInTransaction(async (client) => {
      const payment = await adminPaymentRepository.getPaymentForUpdate(client, paymentId);
      if (!payment) {
        throw new NotFoundError('Payment record not found');
      }

      // Query Cashfree PG status
      const providerStatus = await cashfreeProvider.getOrderStatus(payment.provider_order_id);
      const prevStatus = payment.status;
      let newStatus = prevStatus;
      let updatedPayment = payment;

      // Reconcile status according to provider
      if (['PAID', 'SUCCESS'].includes(providerStatus.orderStatus)) {
        if (!isSuccessfulPaymentStatus(payment.status)) {
          newStatus = 'SUCCESS';
          updatedPayment = await adminPaymentRepository.updatePaymentStatus(client, paymentId, {
            status: 'SUCCESS',
            providerPaymentId: providerStatus.cfOrderId || payment.provider_payment_id,
            failureReason: null,
          });
        }
      } else if (['FAILED', 'USER_DROPPED', 'CANCELLED'].includes(providerStatus.orderStatus)) {
        if (payment.status !== 'FAILED' && payment.status !== 'CANCELLED') {
          newStatus = 'FAILED';
          updatedPayment = await adminPaymentRepository.updatePaymentStatus(client, paymentId, {
            status: 'FAILED',
            failureReason: `Reconciled from gateway status: ${providerStatus.orderStatus}`,
          });
        }
      }

      // Record audit action
      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'payments.update',
        action: 'PAYMENT_RECONCILE',
        targetResource: 'payments',
        targetResourceId: paymentId,
        beforeState: { status: prevStatus },
        afterState: {
          status: newStatus,
          providerOrderStatus: providerStatus.orderStatus,
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: { reason: 'Payment status reconciliation via Cashfree Payment Gateway' },
      });

      return {
        paymentId,
        previousStatus: prevStatus,
        currentStatus: newStatus,
        providerOrderStatus: providerStatus.orderStatus,
        reconciled: prevStatus !== newStatus,
        payment: updatedPayment,
      };
    });
  }

  async createPaymentRefund(paymentId, payload, adminUser, auditMeta = {}) {
    assertUuid(paymentId, 'paymentId');

    const body = payload || {};
    const { amount, reason, idempotencyKey } = body;

    if (
      amount === undefined
      || amount === null
      || Number.isNaN(Number(amount))
      || Number(amount) <= 0
    ) {
      throw new BadRequestError('Refund amount must be a positive number greater than 0');
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      throw new BadRequestError('Refund reason is mandatory and must be at least 3 characters');
    }
    if (reason.trim().length > 500) {
      throw new BadRequestError('Refund reason cannot exceed 500 characters');
    }

    const cleanAmount = Math.round(Number(amount) * 100) / 100;

    return adminPaymentRepository.executeInTransaction(async (client) => {
      const payment = await adminPaymentRepository.getPaymentForUpdate(client, paymentId);
      if (!payment) {
        throw new NotFoundError('Payment record not found');
      }

      if (!isSuccessfulPaymentStatus(payment.status)) {
        throw new BadRequestError(
          `Cannot refund payment with status '${payment.status}'. Only 'SUCCESS' payments are refundable.`,
        );
      }

      // Idempotency check
      if (idempotencyKey) {
        const existing = await adminPaymentRepository.getRefundByIdempotencyKey(idempotencyKey);
        if (existing) {
          return {
            refund: existing,
            idempotentReplay: true,
          };
        }
      }

      // Calculate remaining refundable balance
      const refundsSummary = await adminPaymentRepository.getPaymentRefundsSummary(
        paymentId,
        client,
      );
      const totalAlreadyRefunded = refundsSummary.completedRefundAmount
        + refundsSummary.pendingRefundAmount;
      const remainingRefundable = Math.round(
        (Number(payment.amount) - totalAlreadyRefunded) * 100,
      ) / 100;

      if (cleanAmount > remainingRefundable) {
        throw new BadRequestError(
          `Requested refund amount (${cleanAmount}) exceeds remaining refundable amount (${remainingRefundable})`,
        );
      }

      const refundNumber = `REF-GG-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const uniqueRefundId = idempotencyKey || refundNumber;

      // Execute provider refund call
      const providerRes = await cashfreeProvider.createRefund({
        orderId: payment.provider_order_id,
        refundAmount: cleanAmount,
        refundId: uniqueRefundId,
        refundNote: reason.trim(),
      });

      const refundRecord = await adminPaymentRepository.createRefund(client, {
        refundNumber,
        bookingId: payment.booking_id,
        paymentId: payment.id,
        customerId: payment.customer_id,
        requestedAmount: cleanAmount,
        approvedAmount: cleanAmount,
        refundedAmount: cleanAmount,
        currency: payment.currency || 'INR',
        reason: reason.trim(),
        status: 'COMPLETED',
        provider: 'CASHFREE',
        providerRefundId: providerRes.providerRefundId,
        idempotencyKey: idempotencyKey || null,
        processedBy: adminUser.id,
        processedAt: new Date(),
      });

      // Audit trail
      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'payments.refund',
        action: 'PAYMENT_REFUND',
        targetResource: 'payments',
        targetResourceId: paymentId,
        beforeState: {
          paymentStatus: payment.status,
          remainingRefundable,
        },
        afterState: {
          refundId: refundRecord.id,
          refundNumber,
          refundedAmount: cleanAmount,
          providerRefundId: providerRes.providerRefundId,
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: { reason: reason.trim() },
      });

      return {
        refund: refundRecord,
        idempotentReplay: false,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // REFUNDS
  // ══════════════════════════════════════════════════════════════════════════════

  async listRefunds(queryParams = {}) {
    const {
      search,
      bookingId,
      customerId,
      paymentId,
      status,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    } = queryParams;

    if (bookingId) assertUuid(bookingId, 'bookingId');
    if (customerId) assertUuid(customerId, 'customerId');
    if (paymentId) assertUuid(paymentId, 'paymentId');

    validateDateRange(startDate, endDate);

    return adminPaymentRepository.listRefunds({
      search,
      bookingId,
      customerId,
      paymentId,
      status,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  async getRefundById(id) {
    assertUuid(id, 'refundId');
    const refund = await adminPaymentRepository.getRefundById(id);
    if (!refund) {
      throw new NotFoundError('Refund record not found');
    }
    return refund;
  }

  /**
   * Acting admin's users.id for processed_by. Never substitutes another admin; refuses
   * the action if the actor cannot be resolved (see security/financial-actor).
   */
  async _resolveAdminUserId(client, adminUser) {
    return resolveFinancialActorId(client, adminUser);
  }

  async approveRefund(refundId, payload, adminUser, auditMeta = {}) {
    assertUuid(refundId, 'refundId');
    const body = payload || {};

    return adminPaymentRepository.executeInTransaction(async (client) => {
      const refund = await adminPaymentRepository.getRefundForUpdate(client, refundId);
      if (!refund) {
        throw new NotFoundError('Refund record not found');
      }

      const currentStatus = String(refund.status || '').toUpperCase();
      if (['COMPLETED', 'REJECTED', 'FAILED', 'PAID', 'CANCELLED'].includes(currentStatus)) {
        throw new ConflictError(
          `Cannot approve refund in terminal status '${refund.status}'.`,
        );
      }

      const payment = await adminPaymentRepository.getPaymentForUpdate(client, refund.payment_id);
      if (!payment) {
        throw new NotFoundError('Associated payment not found');
      }

      let approveAmount;
      if (body.approvedAmount !== undefined && body.approvedAmount !== null && body.approvedAmount !== '') {
        approveAmount = Math.round(Number(body.approvedAmount) * 100) / 100;
        if (Number.isNaN(approveAmount) || approveAmount <= 0) {
          throw new BadRequestError('Approved amount must be greater than zero');
        }
        const maxRefundable = Number(refund.requested_amount);
        if (approveAmount > maxRefundable) {
          throw new BadRequestError(
            `Approved amount (₹${approveAmount}) exceeds requested refundable amount (₹${maxRefundable})`,
          );
        }
      } else {
        approveAmount = Math.round(Number(refund.requested_amount) * 100) / 100;
        if (approveAmount <= 0) {
          throw new BadRequestError('Approved amount must be greater than zero. No payable refund for this request.');
        }
      }

      // Check payment limit
      const summary = await adminPaymentRepository.getPaymentRefundsSummary(
        refund.payment_id,
        client,
      );
      const otherRefundsTotal = summary.completedRefundAmount;
      const remainingBalance = Math.round((Number(payment.amount) - otherRefundsTotal) * 100) / 100;

      if (approveAmount > remainingBalance) {
        throw new BadRequestError(
          `Approved amount (${approveAmount}) exceeds remaining refundable balance (${remainingBalance})`,
        );
      }

      const method = String(body.refundMethod || body.paymentMethod || 'GATEWAY').toUpperCase();
      let providerRefundId = null;
      let utr = null;
      let paymentMethod = 'GATEWAY';
      const notes = (body.notes || body.reason || '').trim() || null;

      if (method === 'MANUAL') {
        utr = (body.utr || body.paymentReference || '').trim();
        if (!utr || utr.length < 3) {
          throw new BadRequestError('UTR / transaction reference is mandatory for manual refund and must be at least 3 characters');
        }
        if (utr.length > 100) {
          throw new BadRequestError('UTR / transaction reference cannot exceed 100 characters');
        }
        paymentMethod = 'MANUAL';
        providerRefundId = utr;
      } else if (method === 'GATEWAY') {
        paymentMethod = 'GATEWAY';
        // Call Cashfree PG refund API
        const providerRes = await cashfreeProvider.createRefund({
          orderId: payment.provider_order_id,
          refundAmount: approveAmount,
          refundId: refund.refund_number,
          refundNote: refund.reason || 'Admin initiated refund',
        });
        providerRefundId = providerRes.providerRefundId;
      } else {
        throw new BadRequestError(`Unsupported refund method '${method}'. Allowed methods: GATEWAY, MANUAL`);
      }

      const processedByUserId = await this._resolveAdminUserId(client, adminUser);

      const updated = await adminPaymentRepository.updateRefundStatus(client, refundId, {
        status: 'COMPLETED',
        approvedAmount: approveAmount,
        refundedAmount: approveAmount,
        providerRefundId,
        utr,
        paymentMethod,
        notes,
        processedBy: processedByUserId,
        processedAt: new Date(),
      });

      // Synchronize booking_cancellations refund_status if linked
      if (refund.cancellation_id) {
        await client.query(
          `UPDATE booking_cancellations 
           SET refund_status = 'completed', updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [refund.cancellation_id],
        ).catch((err) => {
          logger.warn('Failed to update booking_cancellations on refund approval', { error: err.message });
        });
      }

      // Audit trail
      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'refunds.approve',
        action: method === 'MANUAL' ? 'REFUND_MANUAL_PAY' : 'REFUND_APPROVE',
        targetResource: 'refunds',
        targetResourceId: refundId,
        beforeState: {
          status: refund.status,
          requestedAmount: Number(refund.requested_amount),
        },
        afterState: {
          status: 'COMPLETED',
          approvedAmount: approveAmount,
          method: paymentMethod,
          utr,
          providerRefundId,
        },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: {
          reason: body.reason || (method === 'MANUAL' ? 'Manual bank/UPI refund marked with UTR' : 'Admin refund approved and gateway executed'),
          utr,
          method: paymentMethod,
          notes,
        },
      });

      return updated;
    });
  }

  async rejectRefund(refundId, payload, adminUser, auditMeta = {}) {
    assertUuid(refundId, 'refundId');

    const body = payload || {};
    const { reason } = body;
    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      throw new BadRequestError('Rejection reason is mandatory and must be at least 3 characters');
    }
    if (reason.trim().length > 500) {
      throw new BadRequestError('Rejection reason cannot exceed 500 characters');
    }

    return adminPaymentRepository.executeInTransaction(async (client) => {
      const refund = await adminPaymentRepository.getRefundForUpdate(client, refundId);
      if (!refund) {
        throw new NotFoundError('Refund record not found');
      }

      const currentStatus = String(refund.status || '').toUpperCase();
      if (['COMPLETED', 'REJECTED', 'FAILED', 'PAID', 'CANCELLED'].includes(currentStatus)) {
        throw new ConflictError(
          `Cannot reject refund in terminal status '${refund.status}'.`,
        );
      }

      const processedByUserId = await this._resolveAdminUserId(client, adminUser);

      const updated = await adminPaymentRepository.updateRefundStatus(client, refundId, {
        status: 'REJECTED',
        rejectionReason: reason.trim(),
        processedBy: processedByUserId,
        processedAt: new Date(),
      });

      // Synchronize booking_cancellations refund_status if linked
      if (refund.cancellation_id) {
        await client.query(
          `UPDATE booking_cancellations 
           SET refund_status = 'failed', updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [refund.cancellation_id],
        ).catch((err) => {
          logger.warn('Failed to update booking_cancellations on refund rejection', { error: err.message });
        });
      }

      // Audit trail
      await auditService.logAdminAction({
        actorId: adminUser.id || 'system-admin',
        actorRole: adminUser.role || 'ADMIN',
        permission: auditMeta.permission || 'refunds.approve',
        action: 'REFUND_REJECT',
        targetResource: 'refunds',
        targetResourceId: refundId,
        beforeState: { status: refund.status },
        afterState: { status: 'REJECTED', rejectionReason: reason.trim() },
        requestId: auditMeta.requestId || null,
        ipAddress: auditMeta.ipAddress || null,
        userAgent: auditMeta.userAgent || null,
        metadata: { reason: reason.trim() },
      });

      return updated;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // COMMISSIONS & RULES
  // ══════════════════════════════════════════════════════════════════════════════

  async listCommissions(queryParams = {}) {
    const {
      bookingId,
      partnerId,
      status,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    } = queryParams;

    if (bookingId) assertUuid(bookingId, 'bookingId');
    if (partnerId) assertUuid(partnerId, 'partnerId');
    validateDateRange(startDate, endDate);

    return adminPaymentRepository.listCommissions({
      bookingId,
      partnerId,
      status,
      startDate,
      endDate,
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  async getCommissionById(id) {
    assertUuid(id, 'commissionId');
    const record = await adminPaymentRepository.getCommissionById(id);
    if (!record) {
      throw new NotFoundError('Commission record not found');
    }
    return record;
  }

  async listCommissionRules(queryParams = {}) {
    const { ruleScope, isActive, page, limit } = queryParams;
    return adminPaymentRepository.listCommissionRules({ ruleScope, isActive, page, limit });
  }

  async getCommissionRuleTargets() {
    return adminPaymentRepository.getCommissionRuleTargets();
  }

  async createCommissionRule(payload, adminUser, auditMeta = {}) {
    const body = payload || {};
    const {
      name,
      ruleScope = 'default',
      commissionType = 'percentage',
      commissionValue,
      priority = 0,
      targetId = null,
      categoryId = null,
      partnerId = null,
      vehicleId = null,
      effectiveFrom = null,
      effectiveUntil = null,
      isActive = true,
    } = body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      throw new BadRequestError('Rule name must be at least 2 characters');
    }

    const validScopes = ['default', 'category', 'partner', 'vehicle'];
    if (!validScopes.includes(ruleScope)) {
      throw new BadRequestError(`Invalid ruleScope. Allowed: ${validScopes.join(', ')}`);
    }

    const validTypes = ['percentage', 'flat', 'fixed'];
    if (!validTypes.includes(commissionType)) {
      throw new BadRequestError(`Invalid commissionType. Allowed: ${validTypes.join(', ')}`);
    }

    if (
      commissionValue === undefined
      || commissionValue === null
      || Number.isNaN(Number(commissionValue))
      || Number(commissionValue) < 0
    ) {
      throw new BadRequestError('commissionValue must be a non-negative number');
    }

    if (commissionType === 'percentage' && Number(commissionValue) > 100) {
      throw new BadRequestError('Percentage commission value cannot exceed 100%');
    }

    const effectiveTargetId = targetId || categoryId || partnerId || vehicleId || null;
    if (effectiveTargetId) {
      assertUuid(effectiveTargetId, 'targetId');
    }

    const rule = await adminPaymentRepository.createCommissionRule({
      name: name.trim(),
      ruleScope,
      commissionType,
      commissionValue: Number(commissionValue),
      priority: Number(priority) || 0,
      targetId: effectiveTargetId,
      categoryId: categoryId || (ruleScope === 'category' ? effectiveTargetId : null),
      partnerId: partnerId || (ruleScope === 'partner' ? effectiveTargetId : null),
      vehicleId: vehicleId || (ruleScope === 'vehicle' ? effectiveTargetId : null),
      effectiveFrom: effectiveFrom || null,
      effectiveUntil: effectiveUntil || null,
      isActive: Boolean(isActive),
      createdBy: adminUser ? adminUser.id : null,
    });

    await auditService.logAdminAction({
      actorId: (adminUser && adminUser.id) || 'system-admin',
      actorRole: (adminUser && adminUser.role) || 'ADMIN',
      permission: auditMeta.permission || 'commissions.update',
      action: 'COMMISSION_RULE_CREATE',
      targetResource: 'commission_rules',
      targetResourceId: rule.id,
      beforeState: null,
      afterState: rule,
      requestId: auditMeta.requestId || null,
      ipAddress: auditMeta.ipAddress || null,
      userAgent: auditMeta.userAgent || null,
      metadata: { reason: 'Created new commission rule' },
    });

    return rule;
  }

  async updateCommissionRule(ruleId, payload, adminUser, auditMeta = {}) {
    assertUuid(ruleId, 'ruleId');

    const existing = await adminPaymentRepository.getCommissionRuleById(ruleId);
    if (!existing) {
      throw new NotFoundError('Commission rule not found');
    }

    const body = payload || {};
    const {
      name,
      ruleScope,
      commissionType,
      commissionValue,
      priority,
      targetId,
      categoryId,
      partnerId,
      vehicleId,
      effectiveFrom,
      effectiveUntil,
      isActive,
    } = body;

    if (
      commissionValue !== undefined
      && (Number.isNaN(Number(commissionValue)) || Number(commissionValue) < 0)
    ) {
      throw new BadRequestError('commissionValue must be a non-negative number');
    }

    if (
      (commissionType === 'percentage' || (!commissionType && existing.commission_type === 'percentage'))
      && commissionValue !== undefined
      && Number(commissionValue) > 100
    ) {
      throw new BadRequestError('Percentage commission value cannot exceed 100%');
    }

    const effectiveTargetId = targetId !== undefined ? targetId : (categoryId || partnerId || vehicleId);
    if (effectiveTargetId) {
      assertUuid(effectiveTargetId, 'targetId');
    }

    const updated = await adminPaymentRepository.updateCommissionRule(ruleId, {
      name: name !== undefined ? String(name).trim() : undefined,
      ruleScope: ruleScope !== undefined ? ruleScope : undefined,
      commissionType: commissionType !== undefined ? commissionType : undefined,
      commissionValue: commissionValue !== undefined ? Number(commissionValue) : undefined,
      priority: priority !== undefined ? Number(priority) : undefined,
      targetId: effectiveTargetId !== undefined ? effectiveTargetId : undefined,
      categoryId: categoryId !== undefined ? categoryId : undefined,
      partnerId: partnerId !== undefined ? partnerId : undefined,
      vehicleId: vehicleId !== undefined ? vehicleId : undefined,
      effectiveFrom: effectiveFrom !== undefined ? effectiveFrom : undefined,
      effectiveUntil: effectiveUntil !== undefined ? effectiveUntil : undefined,
      isActive: isActive !== undefined ? Boolean(isActive) : undefined,
    });

    await auditService.logAdminAction({
      actorId: (adminUser && adminUser.id) || 'system-admin',
      actorRole: (adminUser && adminUser.role) || 'ADMIN',
      permission: auditMeta.permission || 'commissions.update',
      action: 'COMMISSION_RULE_UPDATE',
      targetResource: 'commission_rules',
      targetResourceId: ruleId,
      beforeState: existing,
      afterState: updated,
      requestId: auditMeta.requestId || null,
      ipAddress: auditMeta.ipAddress || null,
      userAgent: auditMeta.userAgent || null,
      metadata: { reason: 'Updated commission rule' },
    });

    return updated;
  }

  async getCommissionRuleById(ruleId) {
    assertUuid(ruleId, 'ruleId');
    const rule = await adminPaymentRepository.getCommissionRuleById(ruleId);
    if (!rule) throw new NotFoundError('Commission rule not found');
    return rule;
  }

  async deleteCommissionRule(ruleId, adminUser, auditMeta = {}) {
    assertUuid(ruleId, 'ruleId');
    const existing = await adminPaymentRepository.getCommissionRuleById(ruleId);
    if (!existing) throw new NotFoundError('Commission rule not found');

    const res = await adminPaymentRepository.deleteCommissionRule(ruleId);

    await auditService.logAdminAction({
      actorId: adminUser.id || 'system-admin',
      actorRole: adminUser.role || 'ADMIN',
      permission: auditMeta.permission || 'commissions.update',
      action: 'COMMISSION_RULE_DELETE',
      targetResource: 'commission_rules',
      targetResourceId: ruleId,
      beforeState: existing,
      afterState: null,
      requestId: auditMeta.requestId || null,
      ipAddress: auditMeta.ipAddress || null,
      userAgent: auditMeta.userAgent || null,
      metadata: { reason: 'Deleted commission rule' },
    });

    return res;
  }

  async listCommissionTransactions(queryParams = {}) {
    return this.listCommissions(queryParams);
  }

  async getCommissionTransactionById(transactionId) {
    assertUuid(transactionId, 'transactionId');
    const item = await adminPaymentRepository.getCommissionTransactionById(transactionId);
    if (!item) throw new NotFoundError('Commission transaction not found');
    return item;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // FINANCIAL SUMMARY
  // ══════════════════════════════════════════════════════════════════════════════

  async getFinancialSummary(queryParams = {}) {
    const { startDate, endDate } = queryParams;
    validateDateRange(startDate, endDate);
    return adminPaymentRepository.getFinancialSummary({ startDate, endDate });
  }
}

module.exports = new AdminPaymentService();
module.exports.AdminPaymentService = AdminPaymentService;
