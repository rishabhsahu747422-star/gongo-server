'use strict';

const {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  RateLimitError,
} = require('../../src/errors');
const { errorHandler } = require('../../src/middlewares/errorHandler');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Unit: Error Handler & AppError Hierarchy', () => {
  let mockReq;
  let mockRes;
  let mockNext;

  beforeEach(() => {
    mockReq = {
      id: 'test-req-id-1234',
      method: 'GET',
      originalUrl: '/test',
      headers: {},
    };
    mockRes = {
      locals: { requestId: 'test-req-id-1234' },
      statusCode: 500,
      status: jest.fn(function setStatus(code) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn(function sendJson(body) {
        this.body = body;
        return this;
      }),
    };
    mockNext = jest.fn();
  });

  it('handles ValidationError with status 400 and validation details', () => {
    const err = new ValidationError('Invalid inputs', [{ field: 'email', message: 'Invalid format' }]);
    errorHandler(err, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.body.success).toBe(false);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(mockRes.body.error.message).toBe('Invalid inputs');
    expect(mockRes.body.error.details).toEqual([{ field: 'email', message: 'Invalid format' }]);
    expect(mockRes.body.requestId).toBe('test-req-id-1234');
  });

  it('handles UnauthorizedError with status 401', () => {
    const err = new UnauthorizedError('Custom auth error', ERROR_CODES.AUTH_REQUIRED);
    errorHandler(err, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
    expect(mockRes.body.requestId).toBe('test-req-id-1234');
  });

  it('handles ForbiddenError with status 403', () => {
    const err = new ForbiddenError('Not allowed', ERROR_CODES.FORBIDDEN);
    errorHandler(err, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('handles NotFoundError with status 404', () => {
    const err = new NotFoundError('Asset not found', ERROR_CODES.NOT_FOUND);
    errorHandler(err, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('handles ConflictError with status 409', () => {
    const err = new ConflictError('Record already exists', ERROR_CODES.CONFLICT);
    errorHandler(err, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.CONFLICT);
  });

  it('handles PayloadTooLargeError with status 413', () => {
    const err = new PayloadTooLargeError();
    errorHandler(err, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(413);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
  });

  it('handles RateLimitError with status 429', () => {
    const err = new RateLimitError();
    errorHandler(err, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(429);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
  });

  it('normalizes PostgreSQL 23505 duplicate key error to safe 409 Conflict', () => {
    const pgErr = new Error('duplicate key value violates unique constraint "partners_phone_key"');
    pgErr.code = '23505';

    errorHandler(pgErr, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.CONFLICT);
    expect(mockRes.body.error.message).not.toContain('partners_phone_key');
  });

  it('masks unknown programmer errors to generic 500 INTERNAL_ERROR', () => {
    const secretDbPassword = 'super_secret_db_password_123';
    const unexpectedErr = new Error(`Connection failed with password: ${secretDbPassword}`);

    errorHandler(unexpectedErr, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(mockRes.body.error.message).toBe('An unexpected internal error occurred');
    expect(JSON.stringify(mockRes.body)).not.toContain(secretDbPassword);
  });
});
