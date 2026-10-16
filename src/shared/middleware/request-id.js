'use strict';

const crypto = require('crypto');
const { API_CONSTANTS } = require('../constants/api.constants');

/**
 * Attaches or validates an x-request-id correlation identifier on every request.
 */
function requestId(req, res, next) {
  const incoming = req.headers[API_CONSTANTS.REQUEST_ID_HEADER];
  const id = incoming && typeof incoming === 'string' && incoming.trim() !== ''
    ? incoming.trim()
    : crypto.randomUUID();

  req.id = id;
  res.setHeader(API_CONSTANTS.REQUEST_ID_HEADER, id);
  next();
}

module.exports = { requestId };
