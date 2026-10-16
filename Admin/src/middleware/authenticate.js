'use strict';

const {
  authenticate,
  authenticateSession,
  extractToken,
  validateAdminAccount,
} = require('../middlewares/auth');

module.exports = {
  authenticate,
  authenticateSession,
  extractToken,
  validateAdminAccount,
  normalizeRole: (role) => String(role || '').toLowerCase().trim(),
};
