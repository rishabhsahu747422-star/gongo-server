'use strict';

const { ValidationError } = require('../errors/AppError');

/**
 * Generic schema validation middleware factory.
 *
 * @param {Function} validateFn Validation function returning { error, value }
 * @param {'body'|'query'|'params'} [target='body'] Request property to validate
 */
function validate(validateFn, target = 'body') {
  return (req, res, next) => {
    const result = validateFn(req[target]);
    if (result && result.error) {
      return next(new ValidationError('Request validation failed', result.error.details || result.error.message));
    }
    if (result && result.value) {
      req[target] = result.value;
    }
    return next();
  };
}

module.exports = { validate };
