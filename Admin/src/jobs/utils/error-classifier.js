'use strict';

/**
 * Known transient network and system error codes.
 */
const TRANSIENT_SYSTEM_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
]);

/**
 * Known transient PostgreSQL error codes (deadlocks, serialization, connection).
 */
const TRANSIENT_PG_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

/**
 * HTTP status codes considered transient.
 */
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Classifies an error as transient (retryable) or permanent (terminal).
 *
 * @param {Error|object|string} error
 * @returns {{ isRetryable: boolean, category: string, message: string }}
 */
function classifyError(error) {
  if (!error) {
    return {
      isRetryable: false,
      category: 'UNKNOWN',
      message: 'Unknown error',
    };
  }

  const rawMessage = error instanceof Error ? error.message : String(error.message || error);
  const code = error.code ? String(error.code) : '';
  const status = error.status || error.statusCode || (error.response && error.response.status);

  // 1. Explicit retryable flag on custom error
  if (typeof error.isRetryable === 'boolean') {
    return {
      isRetryable: error.isRetryable,
      category: error.category || (error.isRetryable ? 'TRANSIENT' : 'PERMANENT'),
      message: rawMessage,
    };
  }

  // 2. Check transient PostgreSQL codes
  if (TRANSIENT_PG_CODES.has(code)) {
    return {
      isRetryable: true,
      category: 'DATABASE_TRANSIENT',
      message: `Database transient error (${code}): ${rawMessage}`,
    };
  }

  // 3. Check transient OS / network codes
  if (TRANSIENT_SYSTEM_CODES.has(code)) {
    return {
      isRetryable: true,
      category: 'NETWORK_TRANSIENT',
      message: `Network transient error (${code}): ${rawMessage}`,
    };
  }

  // 4. Check transient HTTP status
  if (status && TRANSIENT_HTTP_STATUSES.has(Number(status))) {
    return {
      isRetryable: true,
      category: 'PROVIDER_TEMPORARY',
      message: `Provider status ${status}: ${rawMessage}`,
    };
  }

  // 5. Keyword heuristic for timeouts / rate limits in error message
  const lowerMsg = rawMessage.toLowerCase();
  if (
    lowerMsg.includes('timeout')
    || lowerMsg.includes('timed out')
    || lowerMsg.includes('rate limit')
    || lowerMsg.includes('too many requests')
    || lowerMsg.includes('temporarily unavailable')
    || lowerMsg.includes('econnreset')
    || lowerMsg.includes('deadlock')
  ) {
    return {
      isRetryable: true,
      category: 'TRANSIENT_HEURISTIC',
      message: rawMessage,
    };
  }

  // 6. Default: Permanent failure (terminal, not retried)
  return {
    isRetryable: false,
    category: 'PERMANENT_ERROR',
    message: rawMessage,
  };
}

module.exports = {
  classifyError,
  TRANSIENT_SYSTEM_CODES,
  TRANSIENT_PG_CODES,
  TRANSIENT_HTTP_STATUSES,
};
