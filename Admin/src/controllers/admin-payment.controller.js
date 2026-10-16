'use strict';

const adminPaymentService = require('../services/admin-payment.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminPaymentController {
  constructor() {
    this.listPayments = this.listPayments.bind(this);
    this.getPaymentById = this.getPaymentById.bind(this);
    this.getPaymentBooking = this.getPaymentBooking.bind(this);
    this.getPaymentCustomer = this.getPaymentCustomer.bind(this);
    this.getPaymentPartner = this.getPaymentPartner.bind(this);
    this.getPaymentTimeline = this.getPaymentTimeline.bind(this);
    this.getPaymentAttempts = this.getPaymentAttempts.bind(this);
    this.getPaymentTransactions = this.getPaymentTransactions.bind(this);
    this.getPaymentWebhooks = this.getPaymentWebhooks.bind(this);
    this.reconcilePayment = this.reconcilePayment.bind(this);
    this.createPaymentRefund = this.createPaymentRefund.bind(this);

    this.listRefunds = this.listRefunds.bind(this);
    this.getRefundById = this.getRefundById.bind(this);
    this.approveRefund = this.approveRefund.bind(this);
    this.rejectRefund = this.rejectRefund.bind(this);
    this.processRefund = this.processRefund.bind(this);

    this.listCommissions = this.listCommissions.bind(this);
    this.getCommissionById = this.getCommissionById.bind(this);
    this.listCommissionRules = this.listCommissionRules.bind(this);
    this.getCommissionRuleById = this.getCommissionRuleById.bind(this);
    this.createCommissionRule = this.createCommissionRule.bind(this);
    this.updateCommissionRule = this.updateCommissionRule.bind(this);
    this.deleteCommissionRule = this.deleteCommissionRule.bind(this);
    this.listCommissionTransactions = this.listCommissionTransactions.bind(this);
    this.getCommissionTransactionById = this.getCommissionTransactionById.bind(this);

    this.getFinancialSummary = this.getFinancialSummary.bind(this);
  }

  _buildAuditContext(req, res, permission) {
    return {
      actorId: req.user ? req.user.id : 'unknown-admin',
      actorRole: req.user ? req.user.role : 'ADMIN',
      permission,
      requestId: req.id || (res.locals && res.locals.requestId) || null,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PAYMENTS
  // ══════════════════════════════════════════════════════════════════════════════

  async listPayments(req, res, next) {
    try {
      const data = await adminPaymentService.listPayments(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPaymentById(req, res, next) {
    try {
      const data = await adminPaymentService.getPaymentById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPaymentBooking(req, res, next) {
    try {
      const data = await adminPaymentService.getPaymentBooking(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPaymentCustomer(req, res, next) {
    try {
      const data = await adminPaymentService.getPaymentCustomer(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPaymentPartner(req, res, next) {
    try {
      const data = await adminPaymentService.getPaymentPartner(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPaymentTimeline(req, res, next) {
    try {
      const data = await adminPaymentService.getPaymentTimeline(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPaymentAttempts(req, res, next) {
    try {
      const data = await adminPaymentService.getPaymentAttempts(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPaymentTransactions(req, res, next) {
    try {
      const data = await adminPaymentService.getPaymentTransactions(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPaymentWebhooks(req, res, next) {
    try {
      const data = await adminPaymentService.getPaymentWebhooks(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async reconcilePayment(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'payments.update');
      const data = await adminPaymentService.reconcilePayment(req.params.id, req.user, auditMeta);
      return sendSuccess(res, data, { message: 'Payment status reconciled with payment gateway' }, 200);
    } catch (err) {
      return next(err);
    }
  }

  async createPaymentRefund(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'payments.refund');
      const data = await adminPaymentService.createPaymentRefund(
        req.params.id,
        req.body,
        req.user,
        auditMeta,
      );
      const statusCode = data.idempotentReplay ? 200 : 201;
      const message = data.idempotentReplay
        ? 'Refund already processed for this idempotency key'
        : 'Refund initiated and completed successfully';
      return sendSuccess(res, data, { message }, statusCode);
    } catch (err) {
      return next(err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // REFUNDS
  // ══════════════════════════════════════════════════════════════════════════════

  async listRefunds(req, res, next) {
    try {
      const data = await adminPaymentService.listRefunds(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getRefundById(req, res, next) {
    try {
      const data = await adminPaymentService.getRefundById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async approveRefund(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'refunds.approve');
      const data = await adminPaymentService.approveRefund(
        req.params.id,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Refund approved and executed successfully' }, 200);
    } catch (err) {
      return next(err);
    }
  }

  async rejectRefund(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'refunds.approve');
      const data = await adminPaymentService.rejectRefund(
        req.params.id,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Refund rejected successfully' }, 200);
    } catch (err) {
      return next(err);
    }
  }

  async processRefund(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'refunds.approve');
      const decision = (req.body?.decision || req.body?.action || '').toLowerCase();
      if (decision === 'reject' || decision === 'declined') {
        const data = await adminPaymentService.rejectRefund(
          req.params.id,
          req.body,
          req.user,
          auditMeta,
        );
        return sendSuccess(res, data, { message: 'Refund rejected successfully' }, 200);
      }
      const data = await adminPaymentService.approveRefund(
        req.params.id,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Refund processed successfully' }, 200);
    } catch (err) {
      return next(err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // COMMISSIONS & RULES
  // ══════════════════════════════════════════════════════════════════════════════

  async listCommissions(req, res, next) {
    try {
      const data = await adminPaymentService.listCommissions(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getCommissionById(req, res, next) {
    try {
      const data = await adminPaymentService.getCommissionById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async listCommissionRules(req, res, next) {
    try {
      const data = await adminPaymentService.listCommissionRules(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getCommissionRuleTargets(req, res, next) {
    try {
      const data = await adminPaymentService.getCommissionRuleTargets();
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getCommissionRuleById(req, res, next) {
    try {
      const data = await adminPaymentService.getCommissionRuleById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async createCommissionRule(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'commissions.update');
      const data = await adminPaymentService.createCommissionRule(
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Commission rule created successfully' }, 201);
    } catch (err) {
      return next(err);
    }
  }

  async updateCommissionRule(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'commissions.update');
      const data = await adminPaymentService.updateCommissionRule(
        req.params.id,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Commission rule updated successfully' }, 200);
    } catch (err) {
      return next(err);
    }
  }

  async deleteCommissionRule(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'commissions.update');
      const data = await adminPaymentService.deleteCommissionRule(
        req.params.id,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Commission rule deleted successfully' }, 200);
    } catch (err) {
      return next(err);
    }
  }

  async listCommissionTransactions(req, res, next) {
    try {
      const data = await adminPaymentService.listCommissionTransactions(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getCommissionTransactionById(req, res, next) {
    try {
      const data = await adminPaymentService.getCommissionTransactionById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // FINANCIAL OVERVIEW & SUMMARY
  // ══════════════════════════════════════════════════════════════════════════════

  async getFinancialSummary(req, res, next) {
    try {
      const data = await adminPaymentService.getFinancialSummary(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminPaymentController();
module.exports.AdminPaymentController = AdminPaymentController;
