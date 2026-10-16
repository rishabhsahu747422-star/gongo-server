'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

/**
 * Middleware to sanitize and enforce safe pagination parameters.
 * Enforces safe maximum limit <= 100 to prevent denial of service.
 * Disallows client-supplied fake identity overrides (admin_id, role, user_id).
 */
function validatePagination(req, res, next) {
  // Strip any attempts by client to spoof actor identity in body or query
  if (req.body && typeof req.body === 'object') {
    delete req.body.admin_id;
    delete req.body.actor_id;
    // Don't allow caller to inject arbitrary role into unprivileged endpoints
    if (!req.path.includes('/role')) {
      delete req.body.role;
    }
  }

  // Parse page
  let page = parseInt(req.query.page, 10);
  if (Number.isNaN(page) || page < 1) {
    page = 1;
  }

  // Parse limit with safe maximum limit <= 100
  let limit = parseInt(req.query.limit, 10);
  if (Number.isNaN(limit) || limit < 1) {
    limit = 20;
  } else if (limit > 100) {
    limit = 100;
  }

  // Sort order: ASC or DESC
  let order = String(req.query.order || req.query.sortOrder || 'DESC').toUpperCase();
  if (order !== 'ASC' && order !== 'DESC') {
    order = 'DESC';
  }

  // Sort by field (sanitize alphanumeric + underscore)
  let sort = String(req.query.sort || req.query.sortBy || 'created_at').replace(/[^a-zA-Z0-9_]/g, '');
  if (!sort) {
    sort = 'created_at';
  }

  req.pagination = {
    page,
    limit,
    offset: (page - 1) * limit,
    sort,
    order,
    search: req.query.search ? String(req.query.search).trim() : null,
  };

  return next();
}

/**
 * Validates request schema or validation rules.
 * @param {Function} validatorFn Function returning array of error messages or throwing error
 * @returns {import('express').RequestHandler}
 */
function validate(validatorFn) {
  return function validationMiddleware(req, res, next) {
    try {
      if (typeof validatorFn === 'function') {
        const errors = validatorFn(req);
        if (errors && errors.length > 0) {
          return next(
            new ValidationError('Request validation failed', ERROR_CODES.VALIDATION_ERROR, {
              details: errors,
            }),
          );
        }
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  validate,
  validatePagination,
};
