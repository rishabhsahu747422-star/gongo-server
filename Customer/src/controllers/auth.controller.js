'use strict';

const authService = require('../services/auth.service');
const customerAuthService = require('../services/customer-auth.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * AuthController manages HTTP endpoints for customer authentication.
 * Controllers remain thin and delegate all business logic to authService.
 */
class AuthController {
  /**
   * POST /api/v1/auth/customer/send-otp
   */
  async customerSendOtp(req, res, next) {
    try {
      console.log('[CUSTOMER_AUTH_CONTROLLER] Entered customerSendOtp. RequestId:', req.id);
      const { phone } = req.body || {};
      const ipAddress = req.ip || req.connection?.remoteAddress;

      console.log('[CUSTOMER_AUTH_CONTROLLER] Calling customerAuthService.sendOtp...');
      const result = await customerAuthService.sendOtp({
        phone,
        ipAddress,
      });

      console.log('[CUSTOMER_AUTH_CONTROLLER] sendOtp succeeded. Sending HTTP response...');
      return sendSuccess(res, result, 'OTP sent successfully', HTTP_STATUS.OK);
    } catch (err) {
      console.error('[CUSTOMER_AUTH_CONTROLLER_ERROR]', {
        message: err.message,
        code: err.code,
        statusCode: err.statusCode,
      });
      next(err);
    }
  }

  /**
   * POST /api/v1/auth/customer/verify-otp
   */
  async customerVerifyOtp(req, res, next) {
    try {
      const { phone, otp } = req.body || {};

      const result = await customerAuthService.verifyOtp({
        phone,
        otp,
      });

      return sendSuccess(res, result, 'Login successful', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }
  /**
   * POST /api/v1/auth/send-otp
   */
  async sendOtp(req, res, next) {
    try {
      const { phone, countryCode } = req.body;
      const ipAddress = req.ip || req.connection.remoteAddress;

      const result = await authService.sendOtp({
        phone,
        countryCode,
        ipAddress,
      });

      return sendSuccess(res, result, 'OTP sent successfully', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/auth/verify-otp
   */
  async verifyOtp(req, res, next) {
    try {
      const { verificationId, otp } = req.body;

      const result = await authService.verifyOtp({
        verificationId,
        otp,
      });

      return sendSuccess(res, result, 'Authentication successful', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/auth/refresh
   */
  async refresh(req, res, next) {
    try {
      const { token, refreshToken } = req.body;

      const result = await authService.refreshSession({
        token: token || refreshToken,
      });

      return sendSuccess(res, result, 'Session refreshed successfully', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/auth/me
   */
  async getMe(req, res, next) {
    try {
      const result = await authService.getMe(req.user.id);
      return sendSuccess(res, result, 'Current user profile retrieved', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/auth/logout
   */
  async logout(req, res, next) {
    try {
      const authHeader = req.headers.authorization || '';
      const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      await authService.logout(req.user, rawToken);
      return sendSuccess(res, null, 'Logged out successfully', HTTP_STATUS.OK);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AuthController();
