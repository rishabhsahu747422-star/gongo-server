'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const CLOCK_SKEW_SECONDS = 60;
const JWKS_MIN_REFRESH_MS = 60 * 1000;
const JWKS_DEFAULT_TTL_MS = 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10000;

let fetchImpl = (...args) => fetch(...args);
let jwksCache = { keys: null, expiresAt: 0, fetchedAt: 0 };
let configOverride = null;

/**
 * @returns {{
 *   clientId: string, clientSecret: string, callbackUrl: string, portalRedirectUrl: string
 * }}
 */
function getConfig() {
  if (configOverride) return configOverride;
  return {
    clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
    callbackUrl: (env.GOOGLE_CALLBACK_URL || '').trim(),
    portalRedirectUrl: (env.ADMIN_OAUTH_REDIRECT_URL || '').trim(),
  };
}

/** Error carrying a stable, non-sensitive reason code for audit/redirects. */
class GoogleOAuthError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'GoogleOAuthError';
    this.reason = reason;
  }
}

/** @returns {boolean} whether all Google OAuth settings are present */
function isConfigured() {
  const cfg = getConfig();
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.callbackUrl && cfg.portalRedirectUrl);
}

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** @returns {{ verifier: string, challenge: string }} PKCE S256 pair */
function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * @param {object} params
 * @param {string} params.state
 * @param {string} params.nonce
 * @param {string} params.codeChallenge
 * @returns {string}
 */
function buildAuthorizationUrl({ state, nonce, codeChallenge }) {
  const cfg = getConfig();
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

async function httpRequest(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchanges an authorization code (with its PKCE verifier) for tokens.
 *
 * @param {object} params
 * @param {string} params.code
 * @param {string} params.codeVerifier
 * @returns {Promise<{ idToken: string }>}
 */
async function exchangeCode({ code, codeVerifier }) {
  const cfg = getConfig();
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.callbackUrl,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  let res;
  try {
    res = await httpRequest(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (err) {
    throw new GoogleOAuthError('token_exchange_unreachable', `Google token endpoint unreachable: ${err.name}`);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch (_) {
    payload = null;
  }
  if (!res.ok || !payload || typeof payload.id_token !== 'string') {
    // Only Google's error code is logged; the response may contain tokens.
    throw new GoogleOAuthError(
      'token_exchange_failed',
      `Google token exchange failed (${res.status}${payload && payload.error ? `: ${payload.error}` : ''})`,
    );
  }
  return { idToken: payload.id_token };
}

async function loadJwks(force = false) {
  const now = Date.now();
  if (!force && jwksCache.keys && now < jwksCache.expiresAt) return jwksCache.keys;
  const refreshedRecently = now - jwksCache.fetchedAt < JWKS_MIN_REFRESH_MS;
  if (force && jwksCache.keys && refreshedRecently) return jwksCache.keys;

  let res;
  try {
    res = await httpRequest(JWKS_ENDPOINT, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new GoogleOAuthError('jwks_unreachable', `Google JWKS unreachable: ${err.name}`);
  }
  const body = res.ok ? await res.json().catch(() => null) : null;
  if (!body || !Array.isArray(body.keys)) {
    throw new GoogleOAuthError('jwks_invalid', `Google JWKS fetch failed (${res.status})`);
  }

  let ttl = JWKS_DEFAULT_TTL_MS;
  const cacheControl = res.headers && typeof res.headers.get === 'function' ? res.headers.get('cache-control') : null;
  const maxAge = cacheControl && /max-age=(\d+)/.exec(cacheControl);
  if (maxAge) ttl = Math.min(Number(maxAge[1]) * 1000, 24 * JWKS_DEFAULT_TTL_MS);

  jwksCache = { keys: body.keys, expiresAt: now + ttl, fetchedAt: now };
  return body.keys;
}

function decodeSegment(segment, what) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch (_) {
    throw new GoogleOAuthError('id_token_malformed', `ID token ${what} is not valid JSON`);
  }
}

/**
 * Verifies a Google ID token: RS256 signature against Google's published keys, issuer,
 * audience/azp, expiry, issued-at, nonce, subject, and verified email.
 *
 * @param {string} idToken
 * @param {object} expected
 * @param {string} expected.nonce Nonce bound to the OAuth state
 * @returns {Promise<{
 *   sub: string, email: string|null, emailVerified: boolean, name: string|null
 * }>}
 */
async function verifyIdToken(idToken, { nonce }) {
  if (typeof idToken !== 'string') throw new GoogleOAuthError('id_token_missing');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleOAuthError('id_token_malformed', 'ID token is not a JWS');

  const header = decodeSegment(parts[0], 'header');
  const claims = decodeSegment(parts[1], 'payload');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new GoogleOAuthError('id_token_bad_alg', 'ID token must be RS256 with a key id');
  }

  let keys = await loadJwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await loadJwks(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk || jwk.kty !== 'RSA') throw new GoogleOAuthError('id_token_unknown_key', 'ID token signing key not found');

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch (_) {
    throw new GoogleOAuthError('id_token_unknown_key', 'Google signing key is unusable');
  }
  const signatureValid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], 'base64url'),
  );
  if (!signatureValid) throw new GoogleOAuthError('id_token_bad_signature', 'ID token signature is invalid');

  const now = Math.floor(Date.now() / 1000);
  if (!VALID_ISSUERS.includes(claims.iss)) throw new GoogleOAuthError('id_token_bad_issuer', 'Unexpected ID token issuer');

  const { clientId } = getConfig();
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) throw new GoogleOAuthError('id_token_bad_audience', 'ID token audience mismatch');
  if (audiences.length > 1 && claims.azp !== clientId) {
    throw new GoogleOAuthError('id_token_bad_audience', 'ID token authorized party mismatch');
  }
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw new GoogleOAuthError('id_token_expired', 'ID token has expired');
  }
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > now) {
    throw new GoogleOAuthError('id_token_bad_iat', 'ID token issued in the future');
  }
  const nonceOk = typeof claims.nonce === 'string' && typeof nonce === 'string'
    && claims.nonce.length === nonce.length
    && crypto.timingSafeEqual(Buffer.from(claims.nonce), Buffer.from(nonce));
  if (!nonceOk) throw new GoogleOAuthError('id_token_bad_nonce', 'ID token nonce mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) {
    throw new GoogleOAuthError('id_token_bad_subject', 'ID token subject missing');
  }
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  if (!emailVerified) throw new GoogleOAuthError('email_not_verified', 'Google account email is not verified');

  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
    emailVerified,
    name: typeof claims.name === 'string' ? claims.name : null,
  };
}

/** Test seam: override Google configuration (null restores env). */
function setConfigOverride(cfg) {
  configOverride = cfg;
}

/** Test seam: replace the HTTP client used for Google endpoints. */
function setFetchImplementation(fn) {
  fetchImpl = fn;
  jwksCache = { keys: null, expiresAt: 0, fetchedAt: 0 };
}

function resetFetchImplementation() {
  fetchImpl = (...args) => fetch(...args);
  jwksCache = { keys: null, expiresAt: 0, fetchedAt: 0 };
}

if (!isConfigured()) {
  logger.info('Google OAuth for Admin Portal is not configured; Google sign-in endpoints will return 503');
}

module.exports = {
  GoogleOAuthError,
  isConfigured,
  getConfig,
  setConfigOverride,
  createPkcePair,
  buildAuthorizationUrl,
  exchangeCode,
  verifyIdToken,
  setFetchImplementation,
  resetFetchImplementation,
  base64url,
};
