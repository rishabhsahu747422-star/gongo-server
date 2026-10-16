'use strict';

const { NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

function notFound(req, res, next) {
  const err = new NotFoundError(`Endpoint not found: ${req.method} ${req.originalUrl}`, ERROR_CODES.NOT_FOUND);
  next(err);
}

module.exports = { notFound };
