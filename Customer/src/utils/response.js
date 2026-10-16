'use strict';

const { HTTP_STATUS } = require('../constants/http');

/**
 * Sends a standard success response.
 *
 * All success responses share this shape:
 * {
 *   "success": true,
 *   "message": "...",
 *   "data": { ... },
 *   "requestId": "uuid"
 * }
 *
 * Route handlers MUST use this function — never call res.json() directly.
 * This keeps the response shape consistent across the entire API.
 *
 * @param {import('express').Response} res - Express response object.
 * @param {object|null} data - The response payload (null for empty responses).
 * @param {string} [message='Success'] - Human-readable success message.
 * @param {number} [statusCode=200] - HTTP status code.
 */
function sendSuccess(res, data = null, message = 'Success', statusCode = HTTP_STATUS.OK) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    requestId: res.locals.requestId || null,
  });
}

module.exports = { sendSuccess };
