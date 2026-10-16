'use strict';

const { sendSuccess } = require('../../../src/utils/response');

/**
 * Creates a minimal mock Express response object for unit testing.
 * We cannot use supertest here because we're testing the utility function directly.
 */
function createMockRes(requestId = 'test-request-id') {
  const res = {
    locals: { requestId },
    _statusCode: null,
    _body: null,
    status(code) {
      this._statusCode = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
  };
  return res;
}

describe('sendSuccess', () => {
  it('should return a 200 response with correct shape', () => {
    const res = createMockRes();
    sendSuccess(res, { id: 1 }, 'Fetched');

    expect(res._statusCode).toBe(200);
    expect(res._body).toMatchObject({
      success: true,
      message: 'Fetched',
      data: { id: 1 },
      requestId: 'test-request-id',
    });
  });

  it('should use status code 201 when passed', () => {
    const res = createMockRes();
    sendSuccess(res, { id: 2 }, 'Created', 201);

    expect(res._statusCode).toBe(201);
  });

  it('should default message to "Success"', () => {
    const res = createMockRes();
    sendSuccess(res, null);

    expect(res._body.message).toBe('Success');
  });

  it('should default data to null', () => {
    const res = createMockRes();
    sendSuccess(res);

    expect(res._body.data).toBeNull();
  });

  it('should always set success to true', () => {
    const res = createMockRes();
    sendSuccess(res, {}, 'OK');

    expect(res._body.success).toBe(true);
  });

  it('should include requestId from res.locals', () => {
    const res = createMockRes('my-unique-id');
    sendSuccess(res, {}, 'OK');

    expect(res._body.requestId).toBe('my-unique-id');
  });

  it('should set requestId to null when not set in locals', () => {
    const res = createMockRes();
    res.locals = {};
    sendSuccess(res, {}, 'OK');

    expect(res._body.requestId).toBeNull();
  });
});
