'use strict';

const { HTTP_STATUS } = require('../constants/http');

/**
 * Sends a standardized success response.
 *
 * Format:
 * {
 *   "success": true,
 *   "data": { ... }
 * }
 *
 * @param {import('express').Response} res Express response object
 * @param {*} [data={}] Response payload
 * @param {number} [statusCode=HTTP_STATUS.OK] HTTP status code
 */
function sendSuccess(res, data = {}, statusCode = HTTP_STATUS.OK) {
  return res.status(statusCode).json({
    success: true,
    data,
  });
}

/**
 * Formats a standardized error payload.
 *
 * Format:
 * {
 *   "success": false,
 *   "error": {
 *     "code": "ERROR_CODE",
 *     "message": "Safe message"
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
function formatErrorPayload(code, message, requestId = null, details = null, data = null) {
  const errorObj = {
    code,
    message,
  };

  if (details && (Array.isArray(details) ? details.length > 0 : Object.keys(details).length > 0)) {
    errorObj.details = details;
  }

  const payload = {
    success: false,
    code,
    message,
    error: errorObj,
    requestId: requestId || null,
  };

  if (data !== null && data !== undefined) {
    payload.data = data;
  }

  return payload;
}

module.exports = {
  sendSuccess,
  formatErrorPayload,
};
