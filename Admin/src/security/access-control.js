'use strict';

const { validate: uuidValidate } = require('uuid');
const {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { ROLES } = require('../constants/roles');

const UUID_FORMAT_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUIDFormat(str) {
  return uuidValidate(str) || UUID_FORMAT_REGEX.test(str);
}

/**
 * Validates a resource identifier format to prevent injection, traversal, or malformed input.
 *
 * @param {*} id Value to validate
 * @param {string} [paramName='id'] Name of parameter for error reporting
 * @param {object} [options={}]
 * @param {boolean} [options.allowInteger=true] Whether integer string IDs are acceptable
 * @param {boolean} [options.requireUUID=false] Whether UUID v4 format is strictly required
 * @returns {string} Sanitized ID string
 */
function validateResourceId(id, paramName = 'id', options = {}) {
  if (id === null || id === undefined) {
    throw new ValidationError(`Missing required resource parameter '${paramName}'`);
  }

  const idStr = String(id).trim();

  if (!idStr) {
    throw new ValidationError(`Resource parameter '${paramName}' cannot be empty`);
  }

  // Reject path traversal, null bytes, SQL control characters
  if (/[\0/\\]|\.\./.test(idStr)) {
    throw new ValidationError(`Invalid characters in resource parameter '${paramName}'`);
  }

  if (options.requireUUID) {
    if (!isUUIDFormat(idStr)) {
      throw new ValidationError(`Resource parameter '${paramName}' must be a valid UUID`);
    }
    return idStr;
  }

  const isUUID = isUUIDFormat(idStr);
  const isPositiveInt = /^[1-9]\d{0,18}$/.test(idStr);

  if (isUUID) {
    return idStr;
  }

  if (options.allowInteger !== false && isPositiveInt) {
    return idStr;
  }

  // Check if safe alphanumeric token (e.g. booking reference, prefixed ID like 'BK_12345')
  if (/^[A-Za-z0-9_-]{1,64}$/.test(idStr)) {
    return idStr;
  }

  throw new ValidationError(`Malformed resource identifier for '${paramName}'`);
}

/**
 * Asserts that the request carries a verified server-side authenticated user.
 *
 * @param {import('express').Request} req
 * @returns {object} Verified user record
 */
function assertAuthenticated(req) {
  if (!req || !req.user || !req.user.id) {
    throw new UnauthorizedError('Authentication required', ERROR_CODES.AUTH_REQUIRED);
  }

  if (req.user.is_active === false) {
    throw new ForbiddenError('User account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
  }

  return req.user;
}

/**
 * Asserts that the authenticated user possesses an allowed administrative role.
 *
 * @param {object} user Authenticated user record
 * @param {string|string[]} [allowedRoles=ROLES.ADMIN] Allowed roles
 */
function assertAdminRole(user, allowedRoles = ROLES.ADMIN) {
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  if (!user || !user.role || !allowed.includes(user.role)) {
    throw new ForbiddenError(
      'Access forbidden: insufficient role permissions',
      ERROR_CODES.FORBIDDEN,
    );
  }
}

/**
 * Asserts that the admin user possesses required granular permissions.
 * SUPER_ADMIN role or permission grants full access.
 *
 * @param {object} user Authenticated user record
 * @param {string|string[]} requiredPermissions Permission or array of permissions
 */
function assertPermission(user, requiredPermissions) {
  if (!user) {
    throw new ForbiddenError('Access forbidden: unauthenticated', ERROR_CODES.FORBIDDEN);
  }

  const userPerms = Array.isArray(user.permissions) ? user.permissions : [];

  // SUPER_ADMIN has full permissions
  if (userPerms.includes('SUPER_ADMIN') || user.is_super_admin === true) {
    return;
  }

  const required = Array.isArray(requiredPermissions)
    ? requiredPermissions
    : [requiredPermissions];
  const hasMatch = required.some((perm) => userPerms.includes(perm));

  if (!hasMatch) {
    throw new ForbiddenError(
      `Access forbidden: required permission [${required.join(', ')}]`,
      ERROR_CODES.INSUFFICIENT_PERMISSIONS,
    );
  }
}

/**
 * Safely looks up a resource and performs BOLA authorization checks.
 * If the resource does not exist OR if the actor is unauthorized to access it,
 * it returns a consistent 404 Not Found error by default to prevent IDOR existence probing.
 *
 * @param {Function} lookupFn Async function taking identifier and returning resource
 * @param {string} identifier Identifier to look up
 * @param {object} options
 * @param {object} options.actor Authenticated user object
 * @param {string} [options.resourceName='Resource'] Human-friendly resource name
 * @param {Function} [options.authorizeFn] Callback `(actor, resource) => boolean`
 * @param {boolean} [options.hideUnauthorized=true] Return 404 instead of 403 on auth failure
 * @returns {Promise<object>} Resolved resource
 */
async function safeResourceLookup(lookupFn, identifier, options = {}) {
  const {
    actor,
    resourceName = 'Resource',
    authorizeFn,
    hideUnauthorized = true,
  } = options;

  const resource = await lookupFn(identifier);

  if (!resource) {
    throw new NotFoundError(`${resourceName} not found`);
  }

  if (typeof authorizeFn === 'function' && actor) {
    const isAuthorized = await authorizeFn(actor, resource);
    if (!isAuthorized) {
      if (hideUnauthorized) {
        // Prevent IDOR enumeration by returning 404 instead of 403
        throw new NotFoundError(`${resourceName} not found`);
      }
      throw new ForbiddenError(
        `Access forbidden: you are not authorized to access this ${resourceName.toLowerCase()}`,
        ERROR_CODES.FORBIDDEN,
      );
    }
  }

  return resource;
}

/**
 * Express middleware factory enforcing safe, BOLA-hardened resource access.
 *
 * @param {Function} lookupFn Async function (id, client) returning resource
 * @param {object} options
 * @param {string} [options.paramName='id'] Name of route parameter
 * @param {string} [options.resourceName='Resource'] Resource label for error messages
 * @param {Function} [options.authorizeFn] Authorization predicate `(actor, resource) => boolean`
 * @param {string} [options.attachProperty='resource'] Request property to attach resource to
 * @param {boolean} [options.requireUUID=false] Whether UUID is required
 * @param {boolean} [options.hideUnauthorized=true] Return 404 on authorization failure
 * @returns {import('express').RequestHandler}
 */
function requireResourceAccess(lookupFn, options = {}) {
  const {
    paramName = 'id',
    resourceName = 'Resource',
    authorizeFn,
    attachProperty = 'resource',
    requireUUID = false,
    hideUnauthorized = true,
  } = options;

  return async function resourceAccessMiddleware(req, res, next) {
    try {
      const rawId = req.params[paramName];
      const sanitizedId = validateResourceId(rawId, paramName, { requireUUID });

      const actor = req.user || null;
      const resource = await safeResourceLookup(lookupFn, sanitizedId, {
        actor,
        resourceName,
        authorizeFn,
        hideUnauthorized,
      });

      req[attachProperty] = resource;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  validateResourceId,
  assertAuthenticated,
  assertAdminRole,
  assertPermission,
  safeResourceLookup,
  requireResourceAccess,
};
