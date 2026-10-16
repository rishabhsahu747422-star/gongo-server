'use strict';

const notificationValidator = require('../../src/validators/notification.validator');
const { ValidationError } = require('../../src/errors');

describe('Unit: NotificationValidator', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = { query: {}, params: {}, body: {} };
    res = {};
    next = jest.fn();
  });

  describe('validateNotificationListQuery', () => {
    it('applies default pagination', () => {
      notificationValidator.validateNotificationListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery).toEqual({
        page: 1,
        limit: 20,
        offset: 0,
      });
    });

    it('parses valid isRead boolean filter', () => {
      req.query = { isRead: 'true' };
      notificationValidator.validateNotificationListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedQuery.isRead).toBe(true);

      req.query = { isRead: 'false' };
      next.mockClear();
      notificationValidator.validateNotificationListQuery(req, res, next);
      expect(req.validatedQuery.isRead).toBe(false);
    });

    it('rejects invalid isRead value', () => {
      req.query = { isRead: 'maybe' };
      notificationValidator.validateNotificationListQuery(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('validateNotificationIdParam', () => {
    it('accepts a valid UUID string', () => {
      req.params = { notificationId: '123e4567-e89b-12d3-a456-426614174000' };
      notificationValidator.validateNotificationIdParam(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('rejects non-UUID identifiers', () => {
      req.params = { notificationId: 'not-a-uuid' };
      notificationValidator.validateNotificationIdParam(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('validateDeviceTokenPayload', () => {
    it('accepts valid device token payload', () => {
      req.body = { token: 'fcm-token-123', platform: 'android' };
      notificationValidator.validateDeviceTokenPayload(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.validatedBody).toEqual({
        token: 'fcm-token-123',
        platform: 'android',
      });
    });

    it('rejects missing or empty token', () => {
      req.body = { token: '' };
      notificationValidator.validateDeviceTokenPayload(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('rejects invalid platform', () => {
      req.body = { token: 'fcm-token-123', platform: 'windows' };
      notificationValidator.validateDeviceTokenPayload(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });
});
