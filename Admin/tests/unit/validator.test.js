'use strict';

const { validate } = require('../../src/validators');
const { ValidationError } = require('../../src/errors');

describe('Unit: Input Validator Middleware', () => {
  it('calls next without error when validation succeeds', () => {
    const mockValidator = jest.fn().mockReturnValue({ isValid: true });
    const middleware = validate(mockValidator, 'body');

    const req = { body: { name: 'Admin User' } };
    const res = {};
    const next = jest.fn();

    middleware(req, res, next);

    expect(mockValidator).toHaveBeenCalledWith({ name: 'Admin User' });
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next with ValidationError when validation fails', () => {
    const mockErrors = [{ field: 'email', message: 'Email is required' }];
    const mockValidator = jest.fn().mockReturnValue({ isValid: false, errors: mockErrors });
    const middleware = validate(mockValidator, 'body');

    const req = { body: {} };
    const res = {};
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    const passedError = next.mock.calls[0][0];
    expect(passedError.details).toEqual(mockErrors);
  });
});
