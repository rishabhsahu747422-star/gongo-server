'use strict';

const authService = require('../services/auth.service');
const otpService = require('../services/otp.service');
const { sendSuccess } = require('../utils/response');
const { HTTP_STATUS } = require('../constants/http');

/**
 * Controller managing HTTP endpoints for partner authentication and session.
 */
class AuthController {
  /**
   * POST /api/v1/auth/check-phone
   */
  async checkPhone(req, res, next) {
    try {
      const { phone } = req.body;
      const result = await authService.checkPhone({ phone });
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/auth/session
   */
  async session(req, res, next) {
    try {
      const result = await authService.createSession({
        authUser: req.user,
        requestId: req.id,
      });
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/auth/register
   */
  async register(req, res, next) {
    try {
      const token = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.split(' ')[1]
        : null;
      const result = await authService.registerPartner({
        authUser: req.user,
        registrationData: req.body,
        requestId: req.id,
      });

      if (token && result.partner) {
        try {
          const { redisClient } = require('../providers/redis');
          const sessionPayload = JSON.stringify({
            uid: req.user.authId || req.user.id,
            userId: result.user.id,
            phone: result.user.phone ? result.user.phone.replace(/[^0-9]/g, '').slice(-10) : req.user.phone,
            email: result.user.email || null,
            role: 'PARTNER',
            partnerId: result.partner.id,
            createdAt: new Date().toISOString(),
          });
          // Only enrich an existing server-issued session, keeping its expiry. Never turn
          // the caller's bearer (e.g. a Supabase JWT) into a new 30-day session that would
          // outlive the JWT's own expiry and revocation.
          const sessionKey = `auth:session:${token}`;
          const ttl = await redisClient.ttl(sessionKey);
          if (ttl > 0) {
            await redisClient.set(sessionKey, sessionPayload, 'EX', ttl);
          }
        } catch {
          // Non-critical session caching error
        }
      }

      // Invalidate caches immediately so new partner never shares or leaks cached data
      try {
        const { invalidateAuthCache } = require('../middlewares/auth');
        const partnerService = require('../services/partner.service');
        if (req.user?.authId || req.user?.id) {
          invalidateAuthCache(req.user.authId || req.user.id);
        }
        if (result.partner?.id) {
          invalidateAuthCache(result.partner.id);
          partnerService.invalidateDashboardCache(result.partner.id);
        }
      } catch {
        // Non-critical cache invalidation error
      }

      return sendSuccess(res, { ...result, token: token || undefined }, HTTP_STATUS.CREATED);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/auth/me
   */
  async getMe(req, res, next) {
    try {
      const result = await authService.getMe({
        userId: req.user.userId,
        partnerId: req.user.partnerId,
        requestId: req.id,
      });
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/auth/logout
   */
  async logout(req, res, next) {
    try {
      const token = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.split(' ')[1]
        : null;
      const result = await authService.logout({
        authUser: req.user,
        requestId: req.id,
        token,
      });

      // Clear all cached credentials and dashboard metrics for the logged-out partner
      try {
        const { invalidateAuthCache } = require('../middlewares/auth');
        const partnerService = require('../services/partner.service');
        if (req.user?.authId || req.user?.id) {
          invalidateAuthCache(req.user.authId || req.user.id);
        }
        if (req.user?.partnerId) {
          invalidateAuthCache(req.user.partnerId);
          partnerService.invalidateDashboardCache(req.user.partnerId);
        }
      } catch {
        // Non-critical cache cleanup
      }

      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/auth/partner/send-otp
   */
  async partnerSendOtp(req, res, next) {
    try {
      const { phone } = req.body || {};
      const result = await otpService.sendPartnerOtp({ phone });
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/auth/partner/verify-otp
   */
  async partnerVerifyOtp(req, res, next) {
    try {
      const { phone, otp } = req.body || {};
      const requireExisting = req.body?.requireExisting !== false;
      const result = await otpService.verifyPartnerOtp({ phone, otp, requireExisting });
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/auth/partner/dev-login
   */
  async partnerDevLogin(req, res, next) {
    try {
      const { phone, devCode } = req.body || {};
      const result = await authService.partnerDevLogin({ phone, devCode });
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * POST /api/v1/auth/dev-login
   */
  async devLogin(req, res, next) {
    try {
      const { authId, phone } = req.body || {};
      const result = await authService.devLogin({ authId, phone });
      return sendSuccess(res, result, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * GET /api/v1/auth/consents
   */
  async getConsents(req, res, next) {
    try {
      const partnerId = req.user?.partnerId || req.user?.id;
      const userId = req.user?.userId || req.user?.id;
      const consents = await authService.getPartnerConsents({ partnerId, userId });
      return sendSuccess(res, consents, HTTP_STATUS.OK);
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new AuthController();
