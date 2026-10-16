'use strict';

const { ForbiddenError, NotFoundError, UnauthorizedError } = require('../errors/AppError');
const { ERROR_CODES } = require('../constants/error-codes.enum');

/**
 * Asserts that a target resource owner ID matches the trusted authenticated entity ID.
 *
 * @param {string} trustedId Authenticated entity ID (req.user.id or req.user.partnerId)
 * @param {string} resourceOwnerId Owner ID on the target entity
 * @param {object} [options={}] Options
 * @param {boolean} [options.hideForbiddenAsNotFound=false] Return 404 instead of 403 to prevent IDOR enumeration
 */
function assertOwnership(trustedId, resourceOwnerId, options = {}) {
  if (!trustedId) {
    throw new UnauthorizedError('Authenticated identity required', ERROR_CODES.AUTH_REQUIRED);
  }

  if (!resourceOwnerId || String(trustedId) !== String(resourceOwnerId)) {
    if (options.hideForbiddenAsNotFound) {
      throw new NotFoundError('Resource not found', ERROR_CODES.NOT_FOUND);
    }
    throw new ForbiddenError('Access denied: You do not own this resource', ERROR_CODES.FORBIDDEN);
  }
}

/**
 * Resource Ownership Middleware Factory.
 * Prevents Broken Object Level Authorization (BOLA / IDOR).
 *
 * @param {(req: import('express').Request) => Promise<object|null>} lookupFn Async function to resolve resource
 * @param {object} [options={}] Options
 * @param {'partner'|'customer'|'auto'} [options.type='auto'] Identity type to match against
 * @param {boolean} [options.hideForbiddenAsNotFound=false] Return 404 instead of 403
 * @returns {import('express').RequestHandler}
 */
function verifyOwnership(lookupFn, options = {}) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
      }

      const resource = await lookupFn(req);
      if (!resource) {
        throw new NotFoundError('Resource not found', ERROR_CODES.NOT_FOUND);
      }

      let trustedId = req.user.id;
      if (options.type === 'partner') {
        trustedId = req.user.partnerId || req.user.id;
      }

      const ownerId = resource.partnerId
        || resource.partner_id
        || resource.customerId
        || resource.customer_id
        || resource.userId
        || resource.user_id;

      assertOwnership(trustedId, ownerId, options);

      req.resource = resource;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  assertOwnership,
  verifyOwnership,
};
