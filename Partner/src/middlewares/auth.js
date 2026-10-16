'use strict';

const { verifyIdToken } = require('../providers/supabase');
const PartnerRepository = require('../repositories/partner.repository');
const { UnauthorizedError, ForbiddenError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

const partnerRepository = new PartnerRepository();

// In-memory cache for resolved partner identities to eliminate 1,000ms network round-trip per request
const authCache = new Map();
const AUTH_CACHE_TTL_MS = 60000; // 60s TTL

function getCachedPartner(uid) {
  const entry = authCache.get(uid);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    authCache.delete(uid);
    return null;
  }
  return entry.partner;
}

function setCachedPartner(uid, partner) {
  authCache.set(uid, {
    partner,
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
  });
}

function invalidateAuthCache(identifier = null) {
  if (!identifier) {
    authCache.clear();
    return;
  }
  authCache.delete(identifier);
  for (const [key, val] of authCache.entries()) {
    if (val.partner && (val.partner.auth_id === identifier || val.partner.id === identifier || val.partner.partnerId === identifier)) {
      authCache.delete(key);
    }
  }
}

/**
 * Authentication Middleware.
 *
 * Enforces:
 *   1. Authorization header present in 'Bearer <token>' format.
 *   2. Token cryptographically verified via Supabase Auth.
 *   3. Authoritative backend identity resolution (never blindly trusts token claims
 *      or client body).
 *   4. Active account verification.
 *   5. Strict attachment of trusted backend identity to req.user.
 *
 * Client-controlled inputs (req.body.partnerId, req.query.role, etc.) are NEVER trusted.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedError('Authentication token is required', ERROR_CODES.AUTH_REQUIRED);
    }

    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Malformed authorization header. Expected format: Bearer <token>', ERROR_CODES.INVALID_TOKEN);
    }

    const token = authHeader.split(' ')[1];
    if (!token || token.trim() === '') {
      throw new UnauthorizedError('Authentication token cannot be empty', ERROR_CODES.INVALID_TOKEN);
    }

    // 1. Verify token cryptographically
    const decodedToken = await verifyIdToken(token, true);

    // 2. Resolve authoritative backend partner identity (with cache check to eliminate duplicate DB round-trips)
    let partner = process.env.NODE_ENV !== 'test' ? getCachedPartner(decodedToken.uid) : null;
    if (!partner) {
      partner = await partnerRepository.findByAuthId(decodedToken.uid);
      if (partner && process.env.NODE_ENV !== 'test') {
        setCachedPartner(decodedToken.uid, partner);
      }
    }

    if (partner) {
      // Check active status
      if (partner.is_active === false) {
        throw new ForbiddenError('Partner account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
      }

      req.user = {
        id: partner.id,
        partnerId: partner.partnerId || partner.id,
        userId: partner.userId || partner.id,
        authId: partner.auth_id || decodedToken.uid,
        role: partner.role ? String(partner.role).toUpperCase() : null,
        name: partner.name || null,
        phone: partner.phone || decodedToken.phone_number || null,
        email: partner.email || decodedToken.email || null,
        status: partner.status || 'ACTIVE',
        partnerStatus: partner.partner_status || 'OFFLINE',
        kycStatus: partner.kyc_status || 'PENDING',
        isActive: partner.is_active,
      };
    } else {
      // Token is valid Supabase identity, but partner profile is not yet linked/created in DB
      req.user = {
        id: decodedToken.uid,
        partnerId: null,
        userId: null,
        authId: decodedToken.uid,
        role: null,
        phone: decodedToken.phone_number || null,
        email: decodedToken.email || null,
        status: 'UNREGISTERED',
      };
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authenticate, invalidateAuthCache };
