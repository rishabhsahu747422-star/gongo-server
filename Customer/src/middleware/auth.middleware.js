'use strict';

const redisService = require('../services/redis.service');
const supabaseProvider = require('../providers/supabase');
const { UserRepository } = require('../repositories');
const { UnauthorizedError, ForbiddenError } = require('../errors');

const userRepository = new UserRepository();

/**
 * Authentication Middleware.
 *
 * Verifies Bearer credentials via Firebase Admin SDK, resolves the trusted
 * GONGO user from PostgreSQL, checks active status and revocation state,
 * and attaches trusted identity to `req.user`.
 *
 * Identity resolution strategy (in priority order):
 *
 *   1. Custom claim `gongoUserId` — set by backend when minting the custom token.
 *      Resolves directly by primary key. Used when the token was minted by this
 *      backend (i.e. after OTP verification).
 *
 *   2. Firebase UID (`decodedToken.uid`) — the primary external identity key.
 *      Used for tokens not carrying a `gongoUserId` claim (e.g. tokens from a
 *      fresh Firebase sign-in without a custom claim update).
 *
 * The +91 phone-number fallback that existed previously has been REMOVED because:
 *   - It hardcoded a country code assumption (+91) that breaks for any non-Indian user.
 *   - It introduced a potential cross-account association risk if two users share
 *     the same phone_number claim from different identity providers.
 *   - auth_id (Firebase UID) is the correct and sufficient primary identity key.
 *
 * NEVER trusts req.body.userId or client-supplied parameters for identity.
 *
 * Fails CLOSED on Redis errors to prevent revoked sessions from passing through.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authentication token is required', 'AUTH_MISSING_CREDENTIAL');
    }

    const token = authHeader.split(' ')[1];
    if (!token || token.trim() === '') {
      throw new UnauthorizedError('Malformed authorization header', 'AUTH_INVALID_CREDENTIAL');
    }

    // 1. Verify token via Supabase Auth (authoritative identity provider)
    const decodedToken = await supabaseProvider.verifyIdToken(token);

    // 2. Resolve GONGO user using external auth identity (auth.users.id -> public.users)
    let user;
    if (decodedToken.gongoUserId) {
      user = await userRepository.findById(decodedToken.gongoUserId);
      if (user && user.authId && user.authId !== decodedToken.uid) {
        user = null;
      }
    }

    if (!user && decodedToken.uid) {
      // First check auth_provider = 'supabase'
      user = await userRepository.findByAuthId('supabase', decodedToken.uid);
      // Fallback check auth_provider = 'firebase'
      if (!user) {
        user = await userRepository.findByAuthId('firebase', decodedToken.uid);
      }
      // Fallback check by phone - only if user does not belong to another external identity
      if (!user && decodedToken.phone_number) {
        const phoneUser = await userRepository.findByPhone(decodedToken.phone_number);
        if (phoneUser && (!phoneUser.authId || phoneUser.authId === decodedToken.uid)) {
          user = phoneUser;
        }
      }
    }

    // Auto-provision user record for authentic Supabase Auth identity if not yet registered
    if (!user && decodedToken.uid) {
      // Customer accounts are keyed by verified phone; a made-up placeholder number could
      // collide with a real customer's number and hand their later OTP login this account.
      if (!decodedToken.phone_number) {
        throw new UnauthorizedError(
          'A verified phone number is required to create a customer account',
          'AUTH_PHONE_REQUIRED',
        );
      }
      try {
        const phone = decodedToken.phone_number;
        user = await userRepository.create({
          role: 'customer',
          name: decodedToken.user_metadata?.full_name || decodedToken.user_metadata?.name || null,
          phone,
          email: decodedToken.email || null,
          authProvider: 'supabase',
          authId: decodedToken.uid,
          isActive: true,
        });
      } catch (provisionErr) {
        // In case of duplicate phone or concurrency race, retry findByPhone
        if (decodedToken.phone_number) {
          user = await userRepository.findByPhone(decodedToken.phone_number);
        }
      }
    }

    if (!user) {
      throw new UnauthorizedError('User account not found', 'AUTH_USER_NOT_FOUND');
    }

    // 3. Verify user session has not been revoked (e.g. after logout).
    const tokenIssuedAtMs = (decodedToken.auth_time || decodedToken.iat || 0) * 1000;
    const isRevoked = await redisService.isUserSessionRevoked(user.id, tokenIssuedAtMs);
    if (isRevoked) {
      throw new UnauthorizedError('Authentication session has been revoked. Please log in again.', 'AUTH_SESSION_REVOKED');
    }

    // 4. Verify user account is active
    if (!user.isActive) {
      throw new ForbiddenError('Your account has been deactivated. Please contact support.', 'AUTH_USER_INACTIVE');
    }

    // 5. Attach strictly trusted user information to req.user
    req.user = {
      id: user.id,
      role: typeof (decodedToken.role || user.role || 'customer') === 'string'
        ? (decodedToken.role || user.role || 'customer').trim().toLowerCase()
        : 'customer',
      authId: user.authId,
      phone: user.phone,
      countryCode: user.countryCode || '+91',
      email: user.email,
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = authenticate;
