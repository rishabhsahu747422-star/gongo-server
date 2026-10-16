'use strict';

const {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  RateLimitError,
  ServiceUnavailableError,
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
      originalUrl: '/api/v1/admin/test',
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

  it('handles ServiceUnavailableError with status 503', () => {
    const err = new ServiceUnavailableError('Database offline');
    errorHandler(err, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(503);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
  });

  it('maps PostgreSQL duplicate key (23505) error to 409 Conflict', () => {
    const pgErr = new Error('duplicate key value violates unique constraint');
    pgErr.code = '23505';
    errorHandler(pgErr, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.CONFLICT);
  });

  it('maps PostgreSQL foreign key (23503) error to 409 Conflict', () => {
    const pgErr = new Error('insert or update violates foreign key constraint');
    pgErr.code = '23503';
    errorHandler(pgErr, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.CONFLICT);
  });

  it('maps malformed JSON syntax error to 400 Bad Request', () => {
    const parseErr = new SyntaxError('Unexpected token } in JSON');
    parseErr.type = 'entity.parse.failed';
    errorHandler(parseErr, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.INVALID_JSON);
  });

  it('maps payload too large parsing error to 413 Payload Too Large', () => {
    const sizeErr = new Error('request entity too large');
    sizeErr.type = 'entity.too.large';
    errorHandler(sizeErr, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(413);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
  });

  it('maps CORS origin rejection to 403 Forbidden', () => {
    const corsErr = new Error("Origin 'https://evil.com' not allowed by CORS");
    errorHandler(corsErr, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('handles unexpected errors with status 500 without leaking stack traces to the client', () => {
    const unhandledErr = new Error('Secret database password leaked in internal error');
    errorHandler(unhandledErr, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.body.success).toBe(false);
    expect(mockRes.body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(mockRes.body.error.message).toBe('An unexpected internal error occurred');
    expect(mockRes.body.error.details).toBeUndefined();
    expect(JSON.stringify(mockRes.body)).not.toContain('Secret database password');
  });
});
