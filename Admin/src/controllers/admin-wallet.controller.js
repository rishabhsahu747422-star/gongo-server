'use strict';

const adminWalletService = require('../services/admin-wallet.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminWalletController {
  constructor() {
    this.listWallets = this.listWallets.bind(this);
    this.getWalletById = this.getWalletById.bind(this);
    this.listWalletTransactions = this.listWalletTransactions.bind(this);
    this.listWalletEarnings = this.listWalletEarnings.bind(this);
    this.listWalletPayouts = this.listWalletPayouts.bind(this);
    this.reconcileWallets = this.reconcileWallets.bind(this);

    this.adjustWallet = this.adjustWallet.bind(this);

    this.listBankAccounts = this.listBankAccounts.bind(this);
    this.getBankAccountById = this.getBankAccountById.bind(this);

    this.listPayouts = this.listPayouts.bind(this);
    this.getPayoutById = this.getPayoutById.bind(this);
    this.getPayoutTransactions = this.getPayoutTransactions.bind(this);
    this.getPayoutEvents = this.getPayoutEvents.bind(this);
    this.getPayoutReconciliation = this.getPayoutReconciliation.bind(this);
    this.approvePayout = this.approvePayout.bind(this);
    this.markPaid = this.markPaid.bind(this);
    this.rejectPayout = this.rejectPayout.bind(this);
    this.retryPayout = this.retryPayout.bind(this);
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
  // WALLETS
  // ══════════════════════════════════════════════════════════════════════════════

  async listWallets(req, res, next) {
    try {
      const data = await adminWalletService.listWallets(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getWalletById(req, res, next) {
    try {
      const data = await adminWalletService.getWalletById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async listWalletTransactions(req, res, next) {
    try {
      const data = await adminWalletService.listWalletTransactions(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async listWalletEarnings(req, res, next) {
    try {
      const data = await adminWalletService.listWalletEarnings(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async listWalletPayouts(req, res, next) {
    try {
      const data = await adminWalletService.listWalletPayouts(req.params.id, req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async reconcileWallets(req, res, next) {
    try {
      const data = await adminWalletService.reconcileWallets();
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async adjustWallet(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'wallets.adjust');
      const body = req.body || {};
      const data = await adminWalletService.adjustWallet(
        req.params.id,
        {
          ...body,
          idempotencyKey: body.idempotencyKey || req.get('Idempotency-Key') || undefined,
        },
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Wallet balance adjusted successfully' }, 200);
    } catch (err) {
      return next(err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // BANK ACCOUNTS
  // ══════════════════════════════════════════════════════════════════════════════

  async listBankAccounts(req, res, next) {
    try {
      const data = await adminWalletService.listBankAccounts(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getBankAccountById(req, res, next) {
    try {
      const data = await adminWalletService.getBankAccountById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PAYOUTS
  // ══════════════════════════════════════════════════════════════════════════════

  async listPayouts(req, res, next) {
    try {
      const data = await adminWalletService.listPayouts(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPayoutById(req, res, next) {
    try {
      const data = await adminWalletService.getPayoutById(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPayoutTransactions(req, res, next) {
    try {
      const data = await adminWalletService.getPayoutTransactions(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPayoutEvents(req, res, next) {
    try {
      const data = await adminWalletService.getPayoutEvents(req.params.id);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getPayoutReconciliation(req, res, next) {
    try {
      const data = await adminWalletService.getPayoutReconciliation();
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async approvePayout(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'payouts.approve');
      const data = await adminWalletService.approvePayout(
        req.params.id,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Payout approved successfully' });
    } catch (err) {
      return next(err);
    }
  }

  async markPaid(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'payouts.approve');
      const data = await adminWalletService.markPaid(
        req.params.id,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Payout marked as paid and wallet balance deducted successfully' });
    } catch (err) {
      return next(err);
    }
  }

  async rejectPayout(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'payouts.approve');
      const data = await adminWalletService.rejectPayout(
        req.params.id,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Payout rejected and wallet balance restored' });
    } catch (err) {
      return next(err);
    }
  }

  async retryPayout(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'payouts.approve');
      const data = await adminWalletService.retryPayout(
        req.params.id,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data, { message: 'Payout queued for retry' });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminWalletController();
