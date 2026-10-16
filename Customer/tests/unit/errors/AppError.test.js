'use strict';

const AppError = require('../../../src/errors/AppError');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  InternalServerError,
  ServiceUnavailableError,
} = require('../../../src/errors/HttpErrors');

describe('AppError', () => {
  describe('Base AppError', () => {
    it('should construct with all required fields', () => {
      const err = new AppError('Something failed', 400, 'TEST_ERROR');

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AppError);
      expect(err.message).toBe('Something failed');
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('TEST_ERROR');
      expect(err.isOperational).toBe(true);
      expect(err.name).toBe('AppError');
    });

    it('should default isOperational to true', () => {
      const err = new AppError('Oops', 422, 'OOPS');
      expect(err.isOperational).toBe(true);
    });

    it('should allow isOperational = false for programmer errors', () => {
      const err = new AppError('Bug', 500, 'BUG', false);
      expect(err.isOperational).toBe(false);
    });

    it('should capture a stack trace', () => {
      const err = new AppError('Stack test', 500, 'STACK_TEST');
      expect(err.stack).toBeDefined();
      expect(typeof err.stack).toBe('string');
    });

    it('should be an instance of Error', () => {
      const err = new AppError('test', 400, 'TEST');
      expect(err instanceof Error).toBe(true);
    });
  });

  describe('BadRequestError', () => {
    it('should have statusCode 400', () => {
      const err = new BadRequestError();
      expect(err.statusCode).toBe(400);
      expect(err.isOperational).toBe(true);
    });

    it('should accept a custom message', () => {
      const err = new BadRequestError('Invalid phone number', 'INVALID_PHONE');
      expect(err.message).toBe('Invalid phone number');
      expect(err.code).toBe('INVALID_PHONE');
    });

    it('should use default message and code', () => {
      const err = new BadRequestError();
      expect(err.message).toBe('Bad request');
      expect(err.code).toBe('BAD_REQUEST');
    });
  });

  describe('NotFoundError', () => {
    it('should have statusCode 404', () => {
      const err = new NotFoundError();
      expect(err.statusCode).toBe(404);
      expect(err.isOperational).toBe(true);
    });

    it('should use default message', () => {
      const err = new NotFoundError();
      expect(err.message).toBe('The requested resource was not found');
    });
  });

  describe('ConflictError', () => {
    it('should have statusCode 409', () => {
      const err = new ConflictError();
      expect(err.statusCode).toBe(409);
      expect(err.isOperational).toBe(true);
    });
  });

  describe('UnprocessableEntityError', () => {
    it('should have statusCode 422', () => {
      const err = new UnprocessableEntityError();
      expect(err.statusCode).toBe(422);
      expect(err.isOperational).toBe(true);
    });

    it('should carry field-level errors array', () => {
      const fieldErrors = [{ field: 'email', message: 'Invalid email' }];
      const err = new UnprocessableEntityError('Validation failed', 'VALIDATION_ERROR', fieldErrors);
      expect(err.errors).toEqual(fieldErrors);
    });

    it('should default to empty errors array', () => {
      const err = new UnprocessableEntityError();
      expect(err.errors).toEqual([]);
    });
  });

  describe('InternalServerError', () => {
    it('should have statusCode 500 and isOperational false', () => {
      const err = new InternalServerError();
      expect(err.statusCode).toBe(500);
      expect(err.isOperational).toBe(false);
    });
  });

  describe('ServiceUnavailableError', () => {
    it('should have statusCode 503 and isOperational true', () => {
      const err = new ServiceUnavailableError();
      expect(err.statusCode).toBe(503);
      expect(err.isOperational).toBe(true);
    });
  });
});
