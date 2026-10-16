'use strict';

const express = require('express');
const partnerController = require('../controllers/partner.controller');
const vehicleController = require('../controllers/vehicle.controller');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/role');
const { rejectMassAssignment } = require('../middlewares/massAssignment');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const { idempotency } = require('../middlewares/idempotency');
const { ROLES } = require('../constants/roles');
const vehicleRoutes = require('./vehicle.routes');
const bookingRoutes = require('./booking.routes');
const walletRoutes = require('./wallet.routes');
const earningsRoutes = require('./earnings.routes');
const bankAccountRoutes = require('./bank-account.routes');
const payoutRoutes = require('./payout.routes');
const notificationRoutes = require('./notification.routes');
const supportRoutes = require('./support.routes');
const storageRoutes = require('./storage.routes');
const ratingRoutes = require('./rating.routes');

const router = express.Router();

const dashboardStatsLimiter = createRateLimiter({
  max: 120,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:dashboard:stats',
});

const profileMutationLimiter = createRateLimiter({
  max: 30,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:profile',
});

const shopMutationLimiter = createRateLimiter({
  max: 30,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:shop',
});

const kycSubmissionLimiter = createRateLimiter({
  max: 20,
  windowMs: 60 * 1000,
  prefix: 'rl:partner:kyc',
});

// All partner routes enforce authentication + PARTNER role
router.use(authenticate);
router.use(requireRole(ROLES.PARTNER));

// Partner Dashboard Overview & Aggregate Metrics
router.get(
  '/dashboard/stats',
  dashboardStatsLimiter,
  (req, res, next) => partnerController.getDashboardStats(req, res, next),
);
router.get(
  '/stats',
  dashboardStatsLimiter,
  (req, res, next) => partnerController.getDashboardStats(req, res, next),
);

// Partner Profile
router.get('/profile', (req, res, next) => partnerController.getProfile(req, res, next));
router.patch(
  '/profile',
  profileMutationLimiter,
  rejectMassAssignment(),
  (req, res, next) => partnerController.updateProfile(req, res, next),
);

// Shop & Location
router.get('/shop', (req, res, next) => partnerController.getShop(req, res, next));
router.patch(
  '/shop',
  shopMutationLimiter,
  rejectMassAssignment(),
  (req, res, next) => partnerController.updateShop(req, res, next),
);

// KYC Overview & Documents
router.get('/kyc', (req, res, next) => partnerController.getKyc(req, res, next));
router.post(
  '/kyc/documents',
  kycSubmissionLimiter,
  idempotency({ required: false }),
  rejectMassAssignment(),
  (req, res, next) => partnerController.submitKycDocument(req, res, next),
);
router.get('/kyc/documents/:id', (req, res, next) => partnerController.getKycDocumentById(req, res, next));

// Vehicle Inventory Management
router.use('/vehicles', vehicleRoutes);

// Vehicle Compliance Documents Direct Routes
router.post(
  '/vehicle-documents',
  (req, res, next) => vehicleController.createVehicleDocument(req, res, next),
);
router.get(
  '/vehicle-documents/:id',
  (req, res, next) => vehicleController.getVehicleDocumentById(req, res, next),
);

// Booking Operations
router.use('/bookings', bookingRoutes);

// Wallet & Financial Ledger Operations
router.use('/wallet', walletRoutes);

// Partner Earnings Operations
router.use('/earnings', earningsRoutes);

// Partner Bank Account Operations
router.use('/bank-account', bankAccountRoutes);

// Partner Payout Operations
router.use('/payouts', payoutRoutes);

// Partner Notifications Operations
router.use('/notifications', notificationRoutes);

// Partner Support Ticket Operations
router.use('/support/tickets', supportRoutes);

// Storage Operations
router.use('/storage', storageRoutes);

// Partner Rating & Review Operations
router.use('/ratings', ratingRoutes);

module.exports = router;
