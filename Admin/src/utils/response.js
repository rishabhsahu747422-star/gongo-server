'use strict';

const { HTTP_STATUS } = require('../constants/http');

/**
 * Sends a standardized success response.
 *
 * Format:
 * {
 *   "success": true,
 *   "data": { ... },
 *   "meta": { ... }
 * }
 *
 * @param {import('express').Response} res Express response object
 * @param {*} [data={}] Response payload
 * @param {object|null} [meta=null] Pagination or operational metadata
 * @param {number} [statusCode=HTTP_STATUS.OK] HTTP status code
 */
function sendSuccess(res, data = {}, meta = null, statusCode = HTTP_STATUS.OK) {
  const payload = {
    success: true,
    data,
  };

  if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
    payload.meta = meta;
  }

  return res.status(statusCode).json(payload);
}

/**
 * Formats a standardized error payload.
 *
 * Format:
 * {
 *   "success": false,
 *   "error": {
 *     "code": "ERROR_CODE",
 *     "message": "Human readable message",
 *     "details": {}
 *   },
 *   "requestId": "uuid"
 * }
 *
 * @param {string} code Stable machine-readable error code
 * @param {string} message Safe human-readable error message
 * @param {string|null} requestId Unique request identifier
 * @param {Array|object|null} [details=null] Optional validation or field-level details
 * @returns {object} Formatted error object
 */
function formatErrorPayload(code, message, requestId = null, details = null) {
  const errorObj = {
    code,
    message,
  };

  if (details && (Array.isArray(details) ? details.length > 0 : Object.keys(details).length > 0)) {
    errorObj.details = details;
  }

  return {
    success: false,
    message,
    error: errorObj,
    requestId: requestId || null,
  };
}

module.exports = {
  sendSuccess,
  formatErrorPayload,
};
