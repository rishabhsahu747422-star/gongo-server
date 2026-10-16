'use strict';

const idempotencyService = require('../services/idempotency.service');
const { ConflictError, ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

/**
 * Middleware factory for request idempotency.
 *
 * @param {object} [options={}]
 * @param {boolean} [options.required=false] Whether idempotency key is mandatory
 * @returns {import('express').RequestHandler}
 */
function idempotency(options = {}) {
  const isRequired = options.required || false;

  return async (req, res, next) => {
    const rawKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
    const key = typeof rawKey === 'string' ? rawKey.trim() : null;

    if (!key) {
      if (isRequired) {
        return next(
          new ValidationError(
            'Idempotency-Key or X-Idempotency-Key header is required for this operation',
            null,
            ERROR_CODES.IDEMPOTENCY_KEY_MISSING,
          ),
        );
      }
      return next();
    }

    // Scope to authenticated actor to prevent cross-account key collisions
    const actorId = (req.user && req.user.partnerId) || (req.user && req.user.id) || req.ip || 'anonymous';

    try {
      const existing = await idempotencyService.getRecord(actorId, key);

      if (existing) {
        if (existing.status === 'PROCESSING') {
          throw new ConflictError(
            'An operation with this idempotency key is currently processing. Please wait.',
            ERROR_CODES.IDEMPOTENCY_CONFLICT,
          );
        }

        if (existing.status === 'COMPLETED') {
          res.setHeader('X-Idempotency-Replay', 'true');
          return res.status(existing.statusCode).json(existing.body);
        }
      }

      const locked = await idempotencyService.acquireLock(actorId, key);
      if (!locked) {
        throw new ConflictError(
          'An operation with this idempotency key is currently processing. Please wait.',
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
        );
      }

      // Intercept response to store result or release lock
      const originalJson = res.json.bind(res);

      res.json = (body) => {
        const statusCode = res.statusCode || 200;

        if (statusCode < 400) {
          // Success: save response for future idempotent replay
          idempotencyService.saveResponse(actorId, key, statusCode, body).catch(() => {});
        } else {
          // Error response: release lock to allow retry with corrected input
          idempotencyService.releaseLock(actorId, key).catch(() => {});
        }

        return originalJson(body);
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { idempotency };
