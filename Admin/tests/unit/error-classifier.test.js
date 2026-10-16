'use strict';

const {
  classifyError,
  TRANSIENT_SYSTEM_CODES,
  TRANSIENT_PG_CODES,
  TRANSIENT_HTTP_STATUSES,
} = require('../../src/jobs/utils/error-classifier');

describe('Phase 20 Unit: Error Classifier & Retry Policy', () => {
  describe('1. Error Classifier Functionality', () => {
    it('returns unknown error categorization for null or undefined input', () => {
      const res = classifyError(null);
      expect(res.isRetryable).toBe(false);
      expect(res.category).toBe('UNKNOWN');
    });

    it('honors explicit isRetryable boolean on error objects', () => {
      const customErr = new Error('Custom transient issue');
      customErr.isRetryable = true;
      customErr.category = 'CUSTOM_TRANSIENT';

      const res = classifyError(customErr);
      expect(res.isRetryable).toBe(true);
      expect(res.category).toBe('CUSTOM_TRANSIENT');

      const permanentErr = new Error('Custom non-retryable');
      permanentErr.isRetryable = false;
      const res2 = classifyError(permanentErr);
      expect(res2.isRetryable).toBe(false);
    });

    it('classifies known PostgreSQL transient error codes as retryable', () => {
      TRANSIENT_PG_CODES.forEach((code) => {
        const err = new Error('PG issue');
        err.code = code;
        const res = classifyError(err);
        expect(res.isRetryable).toBe(true);
        expect(res.category).toBe('DATABASE_TRANSIENT');
      });
    });

    it('classifies known network/system error codes as retryable', () => {
      TRANSIENT_SYSTEM_CODES.forEach((code) => {
        const err = new Error('System socket issue');
        err.code = code;
        const res = classifyError(err);
        expect(res.isRetryable).toBe(true);
        expect(res.category).toBe('NETWORK_TRANSIENT');
      });
    });

    it('classifies transient HTTP status codes (408, 429, 500, 502, 503, 504) as retryable', () => {
      TRANSIENT_HTTP_STATUSES.forEach((status) => {
        const err = new Error('HTTP failure');
        err.status = status;
        const res = classifyError(err);
        expect(res.isRetryable).toBe(true);
        expect(res.category).toBe('PROVIDER_TEMPORARY');
      });
    });

    it('identifies transient keywords (timeout, rate limit, deadlock) in error messages', () => {
      const err1 = new Error('Connection timed out waiting for upstream gateway');
      expect(classifyError(err1).isRetryable).toBe(true);

      const err2 = new Error('FCM API rate limit exceeded');
      expect(classifyError(err2).isRetryable).toBe(true);

      const err3 = new Error('Transaction aborted due to deadlock');
      expect(classifyError(err3).isRetryable).toBe(true);
    });

    it('classifies domain/validation/auth errors as non-retryable permanent failures', () => {
      const err1 = new Error('Validation failed: invalid UUID format');
      expect(classifyError(err1).isRetryable).toBe(false);
      expect(classifyError(err1).category).toBe('PERMANENT_ERROR');

      const err2 = new Error('Partner account suspended or not found');
      expect(classifyError(err2).isRetryable).toBe(false);

      const err3 = new Error('HTTP 401 Unauthorized');
      err3.status = 401;
      expect(classifyError(err3).isRetryable).toBe(false);

      const err4 = new Error('HTTP 404 Not Found');
      err4.status = 404;
      expect(classifyError(err4).isRetryable).toBe(false);
    });
  });
});
