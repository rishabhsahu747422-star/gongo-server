'use strict';

const express = require('express');
const { createApp: createPartnerApp } = require('../../Partner/src/app');

const partnerApp = createPartnerApp();
const router = express.Router();

// Mount Partner sub-app with clean path normalization
router.use((req, res, next) => {
  let url = req.url;

  // Strip duplicate /partner prefixes if present
  if (url.startsWith('/partner/')) {
    url = url.replace(/^\/partner/, '') || '/';
  } else if (url === '/partner') {
    url = '/';
  }

  // Health endpoint: /api/v1/partner/health or /api/v1/partner
  if (url === '/' || url === '/health' || url.startsWith('/health/')) {
    req.url = url === '/' ? '/api/v1' : (url.startsWith('/health') ? `/api/v1${url}` : '/api/v1/health');
    return partnerApp(req, res, next);
  }

  // Auth routes: /auth/...
  if (url.startsWith('/auth')) {
    req.url = `/api/v1${url}`;
    return partnerApp(req, res, next);
  }

  // Storage routes: /storage/...
  if (url.startsWith('/storage')) {
    req.url = `/api/v1${url}`;
    return partnerApp(req, res, next);
  }

  // Payments routes: /payments/...
  if (url.startsWith('/payments')) {
    req.url = `/api/v1${url}`;
    return partnerApp(req, res, next);
  }

  // Partner domain routes (/vehicles, /profile, /bookings, /earnings, /dashboard/stats, /kyc, etc.)
  // Inside partnerApp, these are mounted under /api/v1/partner/...
  if (!url.startsWith('/api/v1/partner')) {
    if (url.startsWith('/api/v1/')) {
      url = url.replace('/api/v1/', '/api/v1/partner/');
    } else {
      url = `/api/v1/partner${url.startsWith('/') ? '' : '/'}${url}`;
    }
  }

  req.url = url;
  partnerApp(req, res, next);
});

module.exports = router;
module.exports.partnerApp = partnerApp;
