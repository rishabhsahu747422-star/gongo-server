'use strict';

const winston = require('winston');

// Sensitive field patterns to sanitize recursively
const SENSITIVE_KEYS = [
  'password',
  'token',
  'authorization',
  'auth',
  'bearer',
  'secret',
  'privatekey',
  'private_key',
  'otp',
  'cvv',
  'cvc',
  'pin',
  'pan',
  'aadhaar',
  'accountnumber',
  'bankaccount',
  'ifsc',
  'document',
  'kyc',
  'commission',
  'commissionrate',
  'commissionamount',
  'encryptionkey',
  'encryption_key',
  'signature',
  'clientsecret',
  'client_secret',
  'database_url',
  'databaseurl',
  'redis_url',
  'redisurl',
  'cashfree',
  'msg91',
  'aws_secret',
  'aws_access_key',
  'accesskeyid',
  'secretaccesskey',
  'session_token',
  'sessiontoken',
  'id_token',
  'idtoken',
  'cookie',
  'setcookie',
  'card',
  'cardnumber',
];

/**
 * Redacts embedded credentials from connection strings and URIs.
 * @param {string} str
 * @returns {string}
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/:\/\/([^:]+):([^@]+)@/g, '://$1:[REDACTED]@');
}

/**
 * Recursively redacts sensitive keys from log metadata.
 * @param {object} obj Target object
 * @returns {object} Sanitized copy
 */
function sanitizeMeta(obj) {
  if (!obj || typeof obj !== 'object') {
    return typeof obj === 'string' ? sanitizeString(obj) : obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeMeta);
  }

  const sanitized = {};
  Object.keys(obj).forEach((key) => {
    const lowerKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isSensitive = SENSITIVE_KEYS.some((sensitive) => lowerKey.includes(sensitive));

    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      sanitized[key] = sanitizeMeta(obj[key]);
    } else if (typeof obj[key] === 'string') {
      sanitized[key] = sanitizeString(obj[key]);
    } else {
      sanitized[key] = obj[key];
    }
  });

  const symbols = Object.getOwnPropertySymbols(obj);
  symbols.forEach((sym) => {
    sanitized[sym] = obj[sym];
  });

  return sanitized;
}

const sanitizeFormat = winston.format((info) => {
  const sanitized = sanitizeMeta(info);
  return sanitized;
});

const traceFormat = winston.format((info) => {
  if (!info.requestId) {
    try {
      // eslint-disable-next-line global-require
      const { getRequestId } = require('../utils/context');
      const reqId = getRequestId();
      if (reqId) {
        info.requestId = reqId;
      }
    } catch (_) {
      // Context not initialized
    }
  }
  return info;
});

const logLevel = process.env.LOG_LEVEL || 'info';

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    traceFormat(),
    sanitizeFormat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'development'
      ? winston.format.combine(winston.format.colorize(), winston.format.simple())
      : winston.format.json(),
  ),
  defaultMeta: { service: 'gongo-admin-backend' },
  transports: [
    new winston.transports.Console({
      silent: process.env.NODE_ENV === 'test' && !process.env.DEBUG_TESTS,
    }),
  ],
});

logger.sanitizeMeta = sanitizeMeta;

module.exports = logger;
