'use strict';

const express = require('express');
const { createApp: createCustomerApp } = require('../../Customer/src/app');

const customerApp = createCustomerApp();
const router = express.Router();

// Mount Customer sub-app with path normalization
router.use((req, res, next) => {
  let url = req.url;

  // Strip duplicate or legacy /customer prefixes
  if (url.startsWith('/customer/')) {
    url = url.replace(/^\/customer/, '') || '/';
  } else if (url === '/customer') {
    url = '/';
  }

  // Direct health probe routing
  if (url === '/health' || url.startsWith('/health/')) {
    req.url = url;
    return customerApp(req, res, next);
  }

  // Ensure Customer sub-app receives /api/v1/...
  if (!url.startsWith('/api/v1')) {
    url = `/api/v1${url.startsWith('/') ? '' : '/'}${url}`;
  }

  req.url = url;
  customerApp(req, res, next);
});

module.exports = router;
module.exports.customerApp = customerApp;
