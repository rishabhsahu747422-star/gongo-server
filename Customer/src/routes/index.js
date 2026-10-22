'use strict';

const express = require('express');
const healthRouter = require('./health');
const authRouter = require('./auth');

const router = express.Router();

/**
 * API v1 route registry.
 *
 * All routes are mounted under /api/v1 (set in app.js).
 * Add new route modules here as features are implemented.
 */

// Foundation routes
router.use('/health', healthRouter);

// Customer Authentication
router.use('/auth', authRouter);

// Customer Profile & Account
const customerRouter = require('./customers');
const paymentController = require('../controllers/payment.controller');

router.use(['/customers', '/customer/customers'], customerRouter);

// Vehicle Discovery (Step 6)
router.use(['/vehicles', '/customer/vehicles'], require('./vehicles'));

// Public Return URL Bridge Aliases for post-payment redirects (Cashfree redirect target)
router.get(
  ['/bookings/:bookingId/payment-status', '/customer/bookings/:bookingId/payment-status'],
  (req, res, next) => paymentController.handlePaymentReturn(req, res, next),
);

// Bookings (Phase 8)
router.use(['/bookings', '/customer/bookings'], require('./bookings'));

// Pricing & Quotes (Phase 9)
router.use(['/pricing', '/customer/pricing'], require('./pricing'));

// Coupons (Phase 9)
router.use(['/coupons', '/customer/coupons'], require('./coupons'));

// Payments (Phase 10)
router.use(['/payments', '/customer/payments'], require('./payments'));

// Platform Fee (Read-only for checkout)
const platformFeeRouter = require('./platform-fee');

router.use('/customer/platform-fee', platformFeeRouter);
router.use('/platform-fee', platformFeeRouter);

// Home Banners (Dynamic Banner Management System)
router.use('/banners', require('./banners'));
router.use('/customer/banners', require('./banners'));

// Offers (Dynamic Offers Management System)
router.use('/offers', require('./offers'));
router.use('/customer/offers', require('./offers'));

module.exports = router;
