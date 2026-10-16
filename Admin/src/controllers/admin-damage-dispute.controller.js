'use strict';

const adminDamageDisputeService = require('../services/admin-damage-dispute.service');
const { getClientIp } = require('../middlewares/rateLimiter');
const { sendSuccess } = require('../utils/response');

class AdminDamageDisputeController {
  constructor() {
    this.listDamages = this.listDamages.bind(this);
    this.getDamageById = this.getDamageById.bind(this);
    this.getDamageEvidence = this.getDamageEvidence.bind(this);
    this.getDamageBooking = this.getDamageBooking.bind(this);
    this.getDamageVehicle = this.getDamageVehicle.bind(this);
    this.getDamagePartner = this.getDamagePartner.bind(this);
    this.getDamageCustomer = this.getDamageCustomer.bind(this);
    this.getDamageInspections = this.getDamageInspections.bind(this);
    this.reviewDamage = this.reviewDamage.bind(this);
    this.assessDamage = this.assessDamage.bind(this);
    this.rejectDamage = this.rejectDamage.bind(this);
    this.settleDamage = this.settleDamage.bind(this);

    this.listDisputes = this.listDisputes.bind(this);
    this.getDisputeById = this.getDisputeById.bind(this);
    this.getDisputeEvidence = this.getDisputeEvidence.bind(this);
    this.getDisputeTimeline = this.getDisputeTimeline.bind(this);
    this.assignDispute = this.assignDispute.bind(this);
    this.resolveDispute = this.resolveDispute.bind(this);
    this.rejectDispute = this.rejectDispute.bind(this);
    this.createDispute = this.createDispute.bind(this);
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
  // DAMAGE REPORTS
  // ══════════════════════════════════════════════════════════════════════════════

  async listDamages(req, res, next) {
    try {
      const data = await adminDamageDisputeService.listDamages(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getDamageById(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const data = await adminDamageDisputeService.getDamageById(damageId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getDamageEvidence(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const data = await adminDamageDisputeService.getDamageEvidence(damageId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getDamageBooking(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const data = await adminDamageDisputeService.getDamageBooking(damageId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getDamageVehicle(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const data = await adminDamageDisputeService.getDamageVehicle(damageId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getDamagePartner(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const data = await adminDamageDisputeService.getDamagePartner(damageId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getDamageCustomer(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const data = await adminDamageDisputeService.getDamageCustomer(damageId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getDamageInspections(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const data = await adminDamageDisputeService.getDamageInspections(damageId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async reviewDamage(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const auditMeta = this._buildAuditContext(req, res, 'damages.update');
      const data = await adminDamageDisputeService.reviewDamage(damageId, req.user, auditMeta);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async assessDamage(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const auditMeta = this._buildAuditContext(req, res, 'damages.update');
      const data = await adminDamageDisputeService.assessDamage(
        damageId,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async rejectDamage(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const auditMeta = this._buildAuditContext(req, res, 'damages.update');
      const data = await adminDamageDisputeService.rejectDamage(
        damageId,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async settleDamage(req, res, next) {
    try {
      const damageId = req.params.id || req.params.damageId;
      const auditMeta = this._buildAuditContext(req, res, 'damages.update');
      const data = await adminDamageDisputeService.settleDamage(
        damageId,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // DISPUTES
  // ══════════════════════════════════════════════════════════════════════════════

  async listDisputes(req, res, next) {
    try {
      const data = await adminDamageDisputeService.listDisputes(req.query);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getDisputeById(req, res, next) {
    try {
      const disputeId = req.params.id || req.params.disputeId;
      const data = await adminDamageDisputeService.getDisputeById(disputeId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getDisputeEvidence(req, res, next) {
    try {
      const disputeId = req.params.id || req.params.disputeId;
      const data = await adminDamageDisputeService.getDisputeEvidence(disputeId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async getDisputeTimeline(req, res, next) {
    try {
      const disputeId = req.params.id || req.params.disputeId;
      const data = await adminDamageDisputeService.getDisputeTimeline(disputeId);
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async assignDispute(req, res, next) {
    try {
      const disputeId = req.params.id || req.params.disputeId;
      const auditMeta = this._buildAuditContext(req, res, 'disputes.resolve');
      const data = await adminDamageDisputeService.assignDispute(
        disputeId,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async resolveDispute(req, res, next) {
    try {
      const disputeId = req.params.id || req.params.disputeId;
      const auditMeta = this._buildAuditContext(req, res, 'disputes.resolve');
      const data = await adminDamageDisputeService.resolveDispute(
        disputeId,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async rejectDispute(req, res, next) {
    try {
      const disputeId = req.params.id || req.params.disputeId;
      const auditMeta = this._buildAuditContext(req, res, 'disputes.resolve');
      const data = await adminDamageDisputeService.rejectDispute(
        disputeId,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }

  async createDispute(req, res, next) {
    try {
      const auditMeta = this._buildAuditContext(req, res, 'disputes.resolve');
      const data = await adminDamageDisputeService.createDispute(req.body, req.user, auditMeta);
      return sendSuccess(res, data, null, 201);
    } catch (err) {
      return next(err);
    }
  }

  async updateDisputeStatus(req, res, next) {
    try {
      const disputeId = req.params.id || req.params.disputeId;
      const auditMeta = this._buildAuditContext(req, res, 'disputes.resolve');
      const data = await adminDamageDisputeService.updateDisputeStatus(
        disputeId,
        req.body,
        req.user,
        auditMeta,
      );
      return sendSuccess(res, data);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AdminDamageDisputeController();
