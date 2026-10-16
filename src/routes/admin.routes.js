'use strict';

const express = require('express');
const { createApp: createAdminApp } = require('../../Admin/src/app');

const adminApp = createAdminApp();
const router = express.Router();

// Mount Admin sub-app with clean path normalization
router.use((req, res, next) => {
  let url = req.url;

  // Strip duplicate /admin prefixes if present
  if (url.startsWith('/admin/')) {
    url = url.replace(/^\/admin/, '') || '/';
  } else if (url === '/admin') {
    url = '/';
  }

  // Health endpoint: /api/v1/admin/health or /api/v1/admin
  if (url === '/' || url === '/health' || url.startsWith('/health/')) {
    req.url = url === '/' ? '/api/v1' : (url.startsWith('/health') ? `/api/v1${url}` : '/api/v1/health');
    return adminApp(req, res, next);
  }

  // Public landing routes. /franchise-applications falls through to the authenticated
  // admin router (list/detail/status); public submissions use /public/franchise-applications.
  if (url.startsWith('/public')) {
    req.url = `/api/v1${url}`;
    return adminApp(req, res, next);
  }

  // Default admin domain routes (/dashboard, /partners, /customers, /vehicles, /bookings, /auth, etc.)
  // Inside adminApp, these are mounted under /api/v1/admin/...
  if (!url.startsWith('/api/v1/admin')) {
    if (url.startsWith('/api/v1/')) {
      url = url.replace('/api/v1/', '/api/v1/admin/');
    } else {
      url = `/api/v1/admin${url.startsWith('/') ? '' : '/'}${url}`;
    }
  }

  req.url = url;
  adminApp(req, res, next);
});

module.exports = router;
module.exports.adminApp = adminApp;
