'use strict';

const winston = require('winston');
const env = require('./env');

const { combine, timestamp, json, colorize, printf, errors } = winston.format;

/**
 * Human-readable format for development.
 */
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${ts} [${level}]: ${stack || message}${metaStr}`;
  }),
);

/**
 * Structured JSON format for production.
 * Consumed by log aggregators (e.g. CloudWatch, Datadog, GCP Logging).
 */
const prodFormat = combine(
  timestamp(),
  errors({ stack: false }), // Never include stack traces in production logs
  json(),
);

const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    // Local debugging only: in production the platform collects stdout, and an
    // unrotated file in the app directory fails on read-only/non-root containers.
    ...(env.NODE_ENV === 'production'
      ? []
      : [new winston.transports.File({ filename: require('path').join(__dirname, '../../server.log') })]),
  ],
  // Do not exit on handled exceptions
  exitOnError: false,
});

/**
 * Stream interface for Morgan HTTP request logging.
 * Writes to the logger at 'http' level.
 */
logger.stream = {
  write: (message) => {
    logger.http(message.trim());
  },
};

module.exports = logger;
