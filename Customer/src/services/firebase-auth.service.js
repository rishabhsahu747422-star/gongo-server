'use strict';

const { logger } = require('../config');
const { getFirebaseAuth } = require('../config/firebase');
const { UnauthorizedError, ServiceUnavailableError } = require('../errors');

/**
 * Service encapsulating all Firebase Admin SDK authentication interactions.
 * Controllers and business services must never call Firebase Admin SDK directly.
 */
class FirebaseAuthService {
  /**
   * Retrieves the initialized Firebase Auth instance.
   *
   * @returns {import('firebase-admin/auth').Auth}
   */
  getAuthInstance() {
    const auth = getFirebaseAuth();
    if (!auth) {
      throw new ServiceUnavailableError('Firebase authentication service is not initialized');
    }
    return auth;
  }

  /**
   * Creates a Firebase Custom Token for a verified user identity.
   *
   * @param {string} uid - Unique external authentication ID (e.g. "gongo_usr_...")
   * @param {object} [claims={}] - Custom claims (e.g. { role: 'customer' })
   * @returns {Promise<string>} Minted custom token
   */
  async createCustomToken(uid, claims = {}) {
    const auth = this.getAuthInstance();
    try {
      // Force role claim to be 'customer' for customer authentication
      const safeClaims = {
        ...claims,
        role: 'customer',
      };

      const customToken = await auth.createCustomToken(uid, safeClaims);
      return customToken;
    } catch (err) {
      logger.error('Firebase createCustomToken failed', {
        code: err.code || 'FIREBASE_ERROR',
      });
      throw new ServiceUnavailableError('Authentication token generation failed', 'AUTH_TOKEN_ERROR');
    }
  }

  /**
   * Verifies a Firebase ID Token presented in Authorization header.
   *
   * @param {string} idToken - Raw JWT ID token
   * @param {boolean} [checkRevoked=true] - Verify whether token has been revoked
   * @returns {Promise<import('firebase-admin/auth').DecodedIdToken>}
   */
  async verifyIdToken(idToken, checkRevoked = true) {
    if (!idToken || typeof idToken !== 'string') {
      throw new UnauthorizedError('Authentication token is required', 'AUTH_MISSING_CREDENTIAL');
    }

    const auth = this.getAuthInstance();
    try {
      const decoded = await auth.verifyIdToken(idToken, checkRevoked);
      return decoded;
    } catch (err) {
      logger.warn('Firebase verifyIdToken failed', {
        code: err.code || 'UNKNOWN_AUTH_ERROR',
      });

      if (err.code === 'auth/id-token-expired') {
        throw new UnauthorizedError('Authentication token has expired', 'AUTH_EXPIRED_CREDENTIAL');
      }

      if (err.code === 'auth/id-token-revoked') {
        throw new UnauthorizedError('Authentication session has been revoked', 'AUTH_REVOKED_CREDENTIAL');
      }

      throw new UnauthorizedError('Invalid authentication credentials', 'AUTH_INVALID_CREDENTIAL');
    }
  }

  /**
   * Revokes all refresh tokens for a specified user in Firebase.
   *
   * @param {string} uid - Firebase user UID
   * @returns {Promise<void>}
   */
  async revokeRefreshTokens(uid) {
    if (!uid) return;
    try {
      // Inside the try: OTP-session users must still be able to log out when Firebase is unconfigured
      const auth = this.getAuthInstance();
      await auth.revokeRefreshTokens(uid);
      logger.info('Firebase refresh tokens revoked for user', {
        uidMasked: uid.substring(0, 8),
      });
    } catch (err) {
      logger.error('Firebase revokeRefreshTokens failed', {
        code: err.code || 'FIREBASE_REVOKE_ERROR',
      });
    }
  }

  /**
   * Looks up or creates a Firebase user record by phone number.
   *
   * @param {string} fullPhoneNumber - e.g. "+919876543210"
   * @returns {Promise<import('firebase-admin/auth').UserRecord>}
   */
  async getOrCreateFirebaseUser(fullPhoneNumber) {
    const auth = this.getAuthInstance();
    try {
      return await auth.getUserByPhoneNumber(fullPhoneNumber);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        try {
          return await auth.createUser({
            phoneNumber: fullPhoneNumber,
          });
        } catch (createErr) {
          logger.error('Firebase createUser failed', {
            code: createErr.code || 'FIREBASE_CREATE_USER_ERROR',
          });
          throw new ServiceUnavailableError('Unable to provision authentication identity', 'AUTH_PROVISION_ERROR');
        }
      }
      logger.error('Firebase getUserByPhoneNumber error', {
        code: err.code || 'FIREBASE_LOOKUP_ERROR',
      });
      throw new ServiceUnavailableError('Authentication identity lookup failed', 'AUTH_LOOKUP_ERROR');
    }
  }
}

module.exports = new FirebaseAuthService();
