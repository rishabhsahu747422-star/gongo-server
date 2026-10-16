'use strict';

const express = require('express');
const adminDamageDisputeController = require('../controllers/admin-damage-dispute.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { requirePermission } = require('../middlewares/permission');
const { auditMiddleware } = require('../middlewares/audit');
const { sensitiveOpLimiter } = require('../middlewares/rateLimiter');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');

// ══════════════════════════════════════════════════════════════════════════════
// 1. DAMAGE REPORTS ROUTER (/api/v1/admin/damages)
// ══════════════════════════════════════════════════════════════════════════════
const damageRouter = express.Router();
damageRouter.use(authenticate);
damageRouter.use(requireRole(ROLES.ADMIN));
damageRouter.use(auditMiddleware);

// GET /api/v1/admin/damages (List damage reports with filters & pagination)
damageRouter.get(
  '/',
  requirePermission(PERMISSIONS.DAMAGES_READ),
  (req, res, next) => adminDamageDisputeController.listDamages(req, res, next),
);

// GET /api/v1/admin/damages/:id (Single damage report details)
damageRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.DAMAGES_READ),
  (req, res, next) => adminDamageDisputeController.getDamageById(req, res, next),
);

// GET /api/v1/admin/damages/:id/evidence (Damage photos with signed S3 URLs)
damageRouter.get(
  '/:id/evidence',
  requirePermission(PERMISSIONS.DAMAGES_READ),
  (req, res, next) => adminDamageDisputeController.getDamageEvidence(req, res, next),
);

// GET /api/v1/admin/damages/:id/booking (Associated booking)
damageRouter.get(
  '/:id/booking',
  requirePermission(PERMISSIONS.DAMAGES_READ),
  (req, res, next) => adminDamageDisputeController.getDamageBooking(req, res, next),
);

// GET /api/v1/admin/damages/:id/vehicle (Associated vehicle)
damageRouter.get(
  '/:id/vehicle',
  requirePermission(PERMISSIONS.DAMAGES_READ),
  (req, res, next) => adminDamageDisputeController.getDamageVehicle(req, res, next),
);

// GET /api/v1/admin/damages/:id/partner (Associated partner)
damageRouter.get(
  '/:id/partner',
  requirePermission(PERMISSIONS.DAMAGES_READ),
  (req, res, next) => adminDamageDisputeController.getDamagePartner(req, res, next),
);

// GET /api/v1/admin/damages/:id/customer (Associated customer)
damageRouter.get(
  '/:id/customer',
  requirePermission(PERMISSIONS.DAMAGES_READ),
  (req, res, next) => adminDamageDisputeController.getDamageCustomer(req, res, next),
);

// GET /api/v1/admin/damages/:id/inspections (Pickup & return verification evidence)
damageRouter.get(
  '/:id/inspections',
  requirePermission(PERMISSIONS.DAMAGES_READ),
  (req, res, next) => adminDamageDisputeController.getDamageInspections(req, res, next),
);

// POST & PATCH /api/v1/admin/damages/:id/review (Mark under review)
damageRouter.post(
  '/:id/review',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DAMAGES_UPDATE),
  (req, res, next) => adminDamageDisputeController.reviewDamage(req, res, next),
);
damageRouter.patch(
  '/:id/review',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DAMAGES_UPDATE),
  (req, res, next) => adminDamageDisputeController.reviewDamage(req, res, next),
);

// POST & PATCH /api/v1/admin/damages/:id/assess (Approve damage assessment)
damageRouter.post(
  '/:id/assess',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DAMAGES_UPDATE),
  (req, res, next) => adminDamageDisputeController.assessDamage(req, res, next),
);
damageRouter.patch(
  '/:id/approve',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DAMAGES_UPDATE),
  (req, res, next) => adminDamageDisputeController.assessDamage(req, res, next),
);

// POST & PATCH /api/v1/admin/damages/:id/reject (Reject damage report)
damageRouter.post(
  '/:id/reject',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DAMAGES_UPDATE),
  (req, res, next) => adminDamageDisputeController.rejectDamage(req, res, next),
);
damageRouter.patch(
  '/:id/reject',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DAMAGES_UPDATE),
  (req, res, next) => adminDamageDisputeController.rejectDamage(req, res, next),
);

// POST & PATCH /api/v1/admin/damages/:id/settle (Settle approved damage report)
damageRouter.post(
  '/:id/settle',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DAMAGES_UPDATE),
  (req, res, next) => adminDamageDisputeController.settleDamage(req, res, next),
);
damageRouter.patch(
  '/:id/settle',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DAMAGES_UPDATE),
  (req, res, next) => adminDamageDisputeController.settleDamage(req, res, next),
);

// ══════════════════════════════════════════════════════════════════════════════
// 2. DISPUTES ROUTER (/api/v1/admin/disputes)
// ══════════════════════════════════════════════════════════════════════════════
const disputeRouter = express.Router();
disputeRouter.use(authenticate);
disputeRouter.use(requireRole(ROLES.ADMIN));
disputeRouter.use(auditMiddleware);

// GET /api/v1/admin/disputes (List disputes with filters & pagination)
disputeRouter.get(
  '/',
  requirePermission(PERMISSIONS.DISPUTES_READ),
  (req, res, next) => adminDamageDisputeController.listDisputes(req, res, next),
);

// POST /api/v1/admin/disputes (Create dispute)
disputeRouter.post(
  '/',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DISPUTES_RESOLVE),
  (req, res, next) => adminDamageDisputeController.createDispute(req, res, next),
);

// GET /api/v1/admin/disputes/:id (Single dispute details)
disputeRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.DISPUTES_READ),
  (req, res, next) => adminDamageDisputeController.getDisputeById(req, res, next),
);

// GET /api/v1/admin/disputes/:id/evidence (Dispute evidence with signed S3 URLs)
disputeRouter.get(
  '/:id/evidence',
  requirePermission(PERMISSIONS.DISPUTES_READ),
  (req, res, next) => adminDamageDisputeController.getDisputeEvidence(req, res, next),
);

// GET /api/v1/admin/disputes/:id/timeline (Dispute audit lifecycle & milestones)
disputeRouter.get(
  '/:id/timeline',
  requirePermission(PERMISSIONS.DISPUTES_READ),
  (req, res, next) => adminDamageDisputeController.getDisputeTimeline(req, res, next),
);

// POST & PATCH /api/v1/admin/disputes/:id/assign (Assign / reassign dispute to Admin)
disputeRouter.post(
  '/:id/assign',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DISPUTES_RESOLVE),
  (req, res, next) => adminDamageDisputeController.assignDispute(req, res, next),
);
disputeRouter.patch(
  '/:id/assign',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DISPUTES_RESOLVE),
  (req, res, next) => adminDamageDisputeController.assignDispute(req, res, next),
);

// PATCH /api/v1/admin/disputes/:id/status (Update dispute status)
disputeRouter.patch(
  '/:id/status',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DISPUTES_RESOLVE),
  (req, res, next) => adminDamageDisputeController.updateDisputeStatus(req, res, next),
);

// POST /api/v1/admin/disputes/:id/resolve (Resolve dispute with optional financial consequence)
disputeRouter.post(
  '/:id/resolve',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DISPUTES_RESOLVE),
  (req, res, next) => adminDamageDisputeController.resolveDispute(req, res, next),
);

// POST /api/v1/admin/disputes/:id/reject (Reject dispute with reason)
disputeRouter.post(
  '/:id/reject',
  sensitiveOpLimiter,
  requirePermission(PERMISSIONS.DISPUTES_RESOLVE),
  (req, res, next) => adminDamageDisputeController.rejectDispute(req, res, next),
);

module.exports = {
  damageRouter,
  disputeRouter,
};
