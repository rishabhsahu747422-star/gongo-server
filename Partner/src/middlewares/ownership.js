'use strict';

const { ForbiddenError, NotFoundError, UnauthorizedError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

/**
 * Asserts that a target resource belongs to the trusted partner.
 *
 * @param {string} trustedPartnerId Authenticated partner's ID from req.user
 * @param {string} resourcePartnerId Owner partner ID on the target entity
 * @param {object} [options={}] Configuration options
 * @param {boolean} [options.hideForbiddenAsNotFound=false] Return 404 instead of 403
 *   to prevent IDOR enumeration
 */
function assertPartnerOwnership(trustedPartnerId, resourcePartnerId, options = {}) {
  if (!trustedPartnerId) {
    throw new UnauthorizedError('Authenticated partner identity missing', ERROR_CODES.AUTH_REQUIRED);
  }

  if (!resourcePartnerId || String(trustedPartnerId) !== String(resourcePartnerId)) {
    if (options.hideForbiddenAsNotFound) {
      throw new NotFoundError('Resource not found', ERROR_CODES.NOT_FOUND);
    }
    throw new ForbiddenError('Access denied: You do not own this resource', ERROR_CODES.FORBIDDEN);
  }
}

/**
 * Middleware factory for verifying partner ownership of a resource.
 * Prevents Broken Object Level Authorization (BOLA / IDOR).
 *
 * Pattern:
 *   Authenticated Identity (req.user)
 *     ↓
 *   Trusted Partner ID (req.user.partnerId)
 *     ↓
 *   Resource Lookup (via lookupFn)
 *     ↓
 *   Ownership Verification (resource.partnerId === req.user.partnerId)
 *     ↓
 *   Next / 403 Forbidden / 404 Not Found
 *
 * @param {(req: import('express').Request) => Promise<object|null>} lookupFn Lookup function
 * @param {object} [options={}] Options
 * @param {boolean} [options.hideForbiddenAsNotFound=false] Disguise ownership denial
 *   as 404 to avoid enumeration
 * @returns {import('express').RequestHandler}
 */
function verifyOwnership(lookupFn, options = {}) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.partnerId) {
        throw new UnauthorizedError('Authenticated partner identity required', ERROR_CODES.AUTH_REQUIRED);
      }

      const resource = await lookupFn(req);

      if (!resource) {
        throw new NotFoundError('Resource not found', ERROR_CODES.NOT_FOUND);
      }

      const ownerId = resource.partnerId || resource.partner_id || resource.partnerIdFk;

      assertPartnerOwnership(req.user.partnerId, ownerId, options);

      // Attach verified resource to request for downstream handlers
      req.resource = resource;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  assertPartnerOwnership,
  verifyOwnership,
};
