'use strict';

/**
 * Google OAuth for the Admin Portal (Authorization Code + PKCE).
 *
 * Only Google's network endpoints are faked: a locally generated RSA key plays Google's
 * signing key and a fake HTTP client serves the token + JWKS endpoints. State, PKCE,
 * browser binding, ID-token signature/claims checks, identity linking and session
 * issuance all run the production code.
 */

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn(),
}));

const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const googleOAuth = require('../../src/providers/google-oauth');
const auditService = require('../../src/services/audit.service');
const { resetRateLimits } = require('../../src/middlewares/rateLimiter');
const { ERROR_CODES } = require('../../src/constants/errors');
const env = require('../../src/config/env');
const adminGoogleAuthService = require('../../src/services/admin-google-auth.service');
const renflairProvider = require('../../src/providers/renflair.provider');
const { createAuthHarness } = require('../support/admin-auth-harness');

const PASSWORD = 'Gongo#Admin-2026!';
const CLIENT_ID = 'gongo-admin-test.apps.googleusercontent.com';
const CONFIG = {
  clientId: CLIENT_ID,
  clientSecret: 'test-client-secret',
  callbackUrl: 'http://localhost:3002/api/v1/admin/auth/google/callback',
  portalRedirectUrl: 'http://localhost:5173/auth/google/callback',
};

const b64url = (input) => Buffer.from(input).toString('base64url');

function createFakeGoogle() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

  const fake = {
    tokenRequests: [],
    claimsOverride: {},
    signWith: privateKey,
    nonce: null,
    sign(claims, key = privateKey) {
      const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
      const payload = b64url(JSON.stringify(claims));
      const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
      return `${header}.${payload}.${sig}`;
    },
    claims(overrides = {}) {
      const now = Math.floor(Date.now() / 1000);
      return {
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        azp: CLIENT_ID,
        sub: 'google-sub-super-admin',
        email: 'gongorental@gmail.com',
        email_verified: true,
        nonce: fake.nonce,
        iat: now,
        exp: now + 3600,
        ...overrides,
      };
    },
    rogue,
    fetch: async (url, options = {}) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        const params = Object.fromEntries(new URLSearchParams(options.body));
        fake.tokenRequests.push(params);
        const idToken = fake.sign(fake.claims(fake.claimsOverride), fake.signWith);
        return { ok: true, status: 200, json: async () => ({ id_token: idToken, access_token: 'ya29.secret' }) };
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return {
          ok: true, status: 200, headers: { get: () => 'public, max-age=3600' }, json: async () => ({ keys: [jwk] }),
        };
      }
      throw new Error(`unexpected URL ${url}`);
    },
  };
  return fake;
}

describe('Integration: Admin Google OAuth', () => {
  let app;
  let h;
  let google;
  let ids;
  let auditEvents;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(async () => {
    await resetRateLimits(); // also clears pending OAuth state in the (mock) Redis
    auditEvents = [];
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((e) => {
      auditEvents.push(e);
      return e;
    });

    google = createFakeGoogle();
    googleOAuth.setConfigOverride(CONFIG);
    googleOAuth.setFetchImplementation(google.fetch);

    h = createAuthHarness();
    await h.install();
    ids = {
      superAdmin: h.addUser({ email: 'gongorental@gmail.com', phone: '8989232398', role: 'super_admin' }),
      admin: h.addUser({ email: 'ops@gongo.in', phone: '9876500001', role: 'admin' }),
    };
    await h.setPassword(ids.superAdmin, PASSWORD);
    await h.setPassword(ids.admin, PASSWORD);
    adminGoogleAuthService.setRequireOtpOverride(false);
  });

  afterEach(() => {
    adminGoogleAuthService.setRequireOtpOverride(null);
    h.uninstall();
    googleOAuth.setConfigOverride(null);
    googleOAuth.resetFetchImplementation();
    jest.restoreAllMocks();
  });

  async function startLogin() {
    const res = await request(app).get('/api/v1/admin/auth/google');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    google.nonce = url.searchParams.get('nonce');
    return {
      url,
      state: url.searchParams.get('state'),
      cookie: res.headers['set-cookie'].find((c) => c.startsWith('gongo_admin_oauth=')),
    };
  }

  async function callback({ state, cookie, code = 'auth-code-123', extra = {} }) {
    const req = request(app).get('/api/v1/admin/auth/google/callback').query({ state, code, ...extra });
    if (cookie) req.set('Cookie', cookie.split(';')[0]);
    const res = await req;
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(`${loc.origin}${loc.pathname}`).toBe(CONFIG.portalRedirectUrl);
    expect(loc.search).toBe('');
    return Object.fromEntries(new URLSearchParams(loc.hash.slice(1)));
  }

  const exchange = (ticket) => request(app).post('/api/v1/admin/auth/google/exchange').send({ ticket });

  it('starts the flow with PKCE (S256), state, nonce and an HttpOnly browser-binding cookie', async () => {
    const { url, cookie } = await startLogin();
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.callbackUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(url.toString()).not.toContain(CONFIG.clientSecret);
  });

  it('9. authorized (linked) Google identity gets a one-time ticket that becomes an admin session', async () => {
    h.linkGoogle(ids.superAdmin, 'google-sub-super-admin');
    const { url, state, cookie } = await startLogin();

    const result = await callback({ state, cookie });
    expect(result.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Code exchange used the PKCE verifier matching the challenge, and the client secret
    const [tokenReq] = google.tokenRequests;
    expect(tokenReq.client_secret).toBe(CONFIG.clientSecret);
    expect(tokenReq.redirect_uri).toBe(CONFIG.callbackUrl);
    const challenge = crypto.createHash('sha256').update(tokenReq.code_verifier).digest('base64url');
    expect(challenge).toBe(url.searchParams.get('code_challenge'));

    const res = await exchange(result.ticket);
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(ids.superAdmin);
    expect(res.body.data.user.role).toBe('super_admin');

    const me = await request(app).get('/api/v1/admin/auth/me').set('Authorization', `Bearer ${res.body.data.token}`);
    expect(me.status).toBe(200);
    expect(auditEvents.some((e) => e.action === 'ADMIN_LOGIN' && e.metadata.loginMethod === 'google')).toBe(true);

    // Ticket is single-use
    const replay = await exchange(result.ticket);
    expect(replay.status).toBe(401);
  });

  describe('10. verified Google email matching & mandatory security', () => {
    it('1. existing super_admin account with a matching verified Google email is recognized and auto-linked', async () => {
      google.claimsOverride = { sub: 'google-sub-fresh-1', email: 'gongorental@gmail.com', email_verified: true };
      const { state, cookie } = await startLogin();
      const result = await callback({ state, cookie });
      expect(result.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // Verify identity was safely auto-linked to super_admin
      const identity = h.one(`SELECT * FROM admin_oauth_identities WHERE user_id = '${ids.superAdmin}'`);
      expect(identity).not.toBeNull();
      expect(identity.provider_subject).toBe('google-sub-fresh-1');

      const res = await exchange(result.ticket);
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(ids.superAdmin);
      expect(res.body.data.user.role).toBe('super_admin');
    });

    it('2. matches an existing admin account with email case differences', async () => {
      google.claimsOverride = { sub: 'google-sub-case', email: 'GongoRental@Gmail.COM', email_verified: true };
      const { state, cookie } = await startLogin();
      const result = await callback({ state, cookie });
      expect(result.ticket).toBeDefined();

      const res = await exchange(result.ticket);
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(ids.superAdmin);
    });

    it('3. matches an existing admin account with leading/trailing whitespace in stored email', async () => {
      const whitespaceId = h.addUser({ email: '  space_admin@gongo.in  ', phone: '9876500099', role: 'admin' });
      google.claimsOverride = { sub: 'google-sub-space', email: 'space_admin@gongo.in', email_verified: true };
      const { state, cookie } = await startLogin();
      const result = await callback({ state, cookie });
      expect(result.ticket).toBeDefined();

      const res = await exchange(result.ticket);
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(whitespaceId);
    });

    it('4. refuses a Google email that does not match an authorized Admin account', async () => {
      google.claimsOverride = { sub: 'google-sub-unknown', email: 'unauthorized_stranger@gmail.com', email_verified: true };
      const { state, cookie } = await startLogin();
      const result = await callback({ state, cookie });
      expect(result).toEqual({ error: 'account_not_authorized' });
      expect(h.sessions.size).toBe(0);
      expect(h.many("SELECT * FROM admin_oauth_identities WHERE provider_subject = 'google-sub-unknown'")).toHaveLength(0);
    });

    it('5. refuses an unverified Google email matching an admin account', async () => {
      google.claimsOverride = { sub: 'google-sub-unverif', email: 'gongorental@gmail.com', email_verified: false };
      const { state, cookie } = await startLogin();
      const result = await callback({ state, cookie });
      expect(result).toEqual({ error: 'email_not_verified' });
      expect(h.sessions.size).toBe(0);
    });

    it('6. refuses an inactive Admin account matching verified Google email', async () => {
      h.setUserStatus(ids.superAdmin, 'suspended');
      google.claimsOverride = { sub: 'google-sub-inactive', email: 'gongorental@gmail.com', email_verified: true };
      const { state, cookie } = await startLogin();
      const result = await callback({ state, cookie });
      expect(result).toEqual({ error: 'account_disabled' });
      expect(h.sessions.size).toBe(0);
    });

    it('7. refuses a customer user with non-admin role matching verified Google email', async () => {
      h.addUser({ email: 'customer_user@gmail.com', phone: '9876500088', role: 'customer' });
      google.claimsOverride = { sub: 'google-sub-cust', email: 'customer_user@gmail.com', email_verified: true };
      const { state, cookie } = await startLogin();
      const result = await callback({ state, cookie });
      expect(result).toEqual({ error: 'account_not_authorized' });
      expect(h.sessions.size).toBe(0);
    });

    it('8. default Google OAuth login establishes authentic Admin session directly without OTP challenge or SMS dispatch', async () => {
      let dispatchedOtp = null;
      renflairProvider.setMockSender(({ otp }) => {
        dispatchedOtp = otp;
        return { success: true, simulated: true };
      });

      google.claimsOverride = { sub: 'google-sub-direct-session', email: 'gongorental@gmail.com', email_verified: true };
      const { state, cookie } = await startLogin();
      const callbackResult = await callback({ state, cookie });
      expect(callbackResult.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const res = await exchange(callbackResult.ticket);
      expect(res.status).toBe(200);
      expect(res.body.data.step).toBe('AUTHENTICATED');
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.user.email).toBe('gongorental@gmail.com');
      expect(res.body.data.user.role).toBe('super_admin');
      expect(dispatchedOtp).toBeNull(); // No SMS OTP sent

      const me = await request(app)
        .get('/api/v1/admin/auth/me')
        .set('Authorization', `Bearer ${res.body.data.token}`);
      expect(me.status).toBe(200);
      expect(me.body.data.user.email).toBe('gongorental@gmail.com');
    });

    describe('OTP-enforced Google sign-in (when override is set)', () => {
      let dispatchedOtp;

      beforeEach(() => {
        adminGoogleAuthService.setRequireOtpOverride(true);
        dispatchedOtp = null;
        renflairProvider.setMockSender(({ otp }) => {
          dispatchedOtp = otp;
          return { success: true, simulated: true };
        });
      });

      afterEach(() => {
        adminGoogleAuthService.setRequireOtpOverride(null);
      });

      it('8. returns an OTP challenge instead of issuing session directly when OTP is required', async () => {
        google.claimsOverride = { sub: 'google-sub-otp', email: 'gongorental@gmail.com', email_verified: true };
        const { state, cookie } = await startLogin();
        const callbackResult = await callback({ state, cookie });
        expect(callbackResult.ticket).toBeDefined();

        const res = await exchange(callbackResult.ticket);
        expect(res.status).toBe(200);
        expect(res.body.data.step).toBe('OTP_PENDING');
        expect(res.body.data.challengeId).toBeDefined();
        expect(res.body.data.phoneMasked).toBe('+91 ******2398');
        expect(res.body.data.token).toBeUndefined(); // Session NOT issued yet
        expect(h.sessions.size).toBe(0);
        expect(dispatchedOtp).toMatch(/^\d{6}$/);
      });

      it('9. establishes authentic admin session upon successful OTP verification', async () => {
        google.claimsOverride = { sub: 'google-sub-otp-success', email: 'gongorental@gmail.com', email_verified: true };
        const { state, cookie } = await startLogin();
        const callbackResult = await callback({ state, cookie });

        const exchangeRes = await exchange(callbackResult.ticket);
        const { challengeId } = exchangeRes.body.data;

        const verifyRes = await request(app)
          .post('/api/v1/admin/auth/verify-2fa')
          .send({ challengeId, otp: dispatchedOtp });

        expect(verifyRes.status).toBe(200);
        expect(verifyRes.body.data.step).toBe('AUTHENTICATED');
        expect(verifyRes.body.data.token).toBeDefined();
        expect(verifyRes.body.data.user.id).toBe(ids.superAdmin);
        expect(verifyRes.body.data.user.role).toBe('super_admin');

        // Can access protected route with the issued token
        const me = await request(app)
          .get('/api/v1/admin/auth/me')
          .set('Authorization', `Bearer ${verifyRes.body.data.token}`);
        expect(me.status).toBe(200);
      });

      it('10. refuses authentication and does not issue session when OTP verification fails', async () => {
        google.claimsOverride = { sub: 'google-sub-otp-fail', email: 'gongorental@gmail.com', email_verified: true };
        const { state, cookie } = await startLogin();
        const callbackResult = await callback({ state, cookie });

        const exchangeRes = await exchange(callbackResult.ticket);
        const { challengeId } = exchangeRes.body.data;

        const verifyRes = await request(app)
          .post('/api/v1/admin/auth/verify-2fa')
          .send({ challengeId, otp: '000000' });

        expect(verifyRes.status).toBe(401);
        expect(verifyRes.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
        expect(h.sessions.size).toBe(0);
      });
    });

    it('11. prevents duplicate account linking when Google account is already linked to another admin', async () => {
      // First link superAdmin to google-sub-legit
      h.linkGoogle(ids.superAdmin, 'google-sub-legit');

      // Now a different Google sub tries to log in with superAdmin's email
      google.claimsOverride = { sub: 'google-sub-imposter', email: 'gongorental@gmail.com', email_verified: true };
      const { state, cookie } = await startLogin();
      const result = await callback({ state, cookie });
      expect(result).toEqual({ error: 'account_not_authorized' });
      expect(h.sessions.size).toBe(0);
    });

    it('12. preserves password login regression with mandatory SMS OTP', async () => {
      let dispatchedOtp = null;
      renflairProvider.setMockSender(({ otp }) => {
        dispatchedOtp = otp;
        return { success: true, simulated: true };
      });

      const loginRes = await request(app)
        .post('/api/v1/admin/auth/login')
        .send({ identifier: 'gongorental@gmail.com', password: PASSWORD });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.data.step).toBe('OTP_PENDING');
      expect(dispatchedOtp).toMatch(/^\d{6}$/);

      const verifyRes = await request(app)
        .post('/api/v1/admin/auth/verify-2fa')
        .send({ challengeId: loginRes.body.data.challengeId, otp: dispatchedOtp });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.step).toBe('AUTHENTICATED');
      expect(verifyRes.body.data.user.id).toBe(ids.superAdmin);
    });
  });

  describe('11. state validation', () => {
    beforeEach(() => h.linkGoogle(ids.superAdmin, 'google-sub-super-admin'));

    it('rejects an unknown state', async () => {
      const { cookie } = await startLogin();
      expect(await callback({ state: 'A'.repeat(43), cookie })).toEqual({ error: 'invalid_state' });
      expect(google.tokenRequests).toHaveLength(0);
    });

    it('rejects a replayed state', async () => {
      const { state, cookie } = await startLogin();
      expect((await callback({ state, cookie })).ticket).toBeDefined();
      expect(await callback({ state, cookie })).toEqual({ error: 'invalid_state' });
    });

    it('rejects a callback without the browser-binding cookie (login CSRF)', async () => {
      const { state } = await startLogin();
      expect(await callback({ state, cookie: null })).toEqual({ error: 'invalid_state' });
      expect(google.tokenRequests).toHaveLength(0);
    });

    it('rejects a callback whose cookie belongs to a different login attempt', async () => {
      const first = await startLogin();
      const second = await startLogin();
      expect(await callback({ state: first.state, cookie: second.cookie })).toEqual({ error: 'invalid_state' });
    });

    it('treats a provider error as access_denied and consumes the state', async () => {
      const { state, cookie } = await startLogin();
      expect(await callback({ state, cookie, extra: { error: 'access_denied' } })).toEqual({ error: 'access_denied' });
      expect(await callback({ state, cookie })).toEqual({ error: 'invalid_state' });
    });
  });

  describe('12/13. ID token validation', () => {
    beforeEach(() => h.linkGoogle(ids.superAdmin, 'google-sub-super-admin'));

    const cases = [
      ['wrong audience', { aud: 'someone-else.apps.googleusercontent.com' }],
      ['wrong issuer', { iss: 'https://evil.example.com' }],
      ['expired token', { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 }],
      ['future-issued token', { iat: Math.floor(Date.now() / 1000) + 3600 }],
      ['nonce mismatch', { nonce: 'not-the-nonce' }],
    ];

    it.each(cases)('rejects a token with %s', async (_label, overrides) => {
      google.claimsOverride = overrides;
      const { state, cookie } = await startLogin();
      expect(await callback({ state, cookie })).toEqual({ error: 'google_verification_failed' });
      expect(h.sessions.size).toBe(0);
    });

    it('rejects a token signed by a key that is not Google\'s', async () => {
      google.signWith = google.rogue;
      const { state, cookie } = await startLogin();
      expect(await callback({ state, cookie })).toEqual({ error: 'google_verification_failed' });
    });

    it('rejects an unverified Google email', async () => {
      google.claimsOverride = { email_verified: false };
      const { state, cookie } = await startLogin();
      expect(await callback({ state, cookie })).toEqual({ error: 'email_not_verified' });
    });
  });

  describe('14. missing configuration', () => {
    beforeEach(() => googleOAuth.setConfigOverride({ ...CONFIG, clientSecret: '' }));

    it('reports Google sign-in as disabled and fails every OAuth endpoint safely with 503', async () => {
      const status = await request(app).get('/api/v1/admin/auth/google/status');
      expect(status.body.data).toEqual({ enabled: false });

      const start = await request(app).get('/api/v1/admin/auth/google');
      const cb = await request(app).get('/api/v1/admin/auth/google/callback').query({ state: 'A'.repeat(43), code: 'x' });
      const ex = await exchange('A'.repeat(43));
      [start, cb, ex].forEach((res) => {
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe(ERROR_CODES.OAUTH_NOT_CONFIGURED);
      });
      expect(google.tokenRequests).toHaveLength(0);
    });
  });

  describe('15. account linking', () => {
    let token;
    const linkStart = (password, t = token) => request(app)
      .post('/api/v1/admin/auth/google/link')
      .set('Authorization', `Bearer ${t}`)
      .send({ password });

    async function linkCallback(authorizationUrl) {
      const url = new URL(authorizationUrl);
      google.nonce = url.searchParams.get('nonce');
      return callback({ state: url.searchParams.get('state'), cookie: null });
    }

    beforeEach(async () => {
      let dispatchedOtp = null;
      renflairProvider.setMockSender(({ otp }) => {
        dispatchedOtp = otp;
        return { success: true, simulated: true };
      });
      const login = await request(app).post('/api/v1/admin/auth/login').send({ identifier: 'ops@gongo.in', password: PASSWORD });
      const { challengeId } = login.body.data;
      const verify = await request(app).post('/api/v1/admin/auth/verify-2fa').send({ challengeId, otp: dispatchedOtp });
      token = verify.body.data.token;
      google.claimsOverride = { sub: 'google-sub-ops', email: 'ops.personal@gmail.com' };
    });

    it('requires an authenticated admin session', async () => {
      const res = await request(app).post('/api/v1/admin/auth/google/link').send({ password: PASSWORD });
      expect(res.status).toBe(401);
    });

    it('requires the current password (step-up)', async () => {
      const res = await linkStart('Wrong#Password-1');
      expect(res.status).toBe(403);
      expect(res.body.data).toBeUndefined();
    });

    it('links the Google account after password re-verification; it can then sign in', async () => {
      const res = await linkStart(PASSWORD);
      expect(res.status).toBe(200);
      expect(await linkCallback(res.body.data.authorizationUrl)).toEqual({ linked: 'google' });

      const row = h.one(`SELECT * FROM admin_oauth_identities WHERE user_id = '${ids.admin}'`);
      expect(row.provider_subject).toBe('google-sub-ops');

      const { state, cookie } = await startLogin();
      const result = await callback({ state, cookie });
      const session = await exchange(result.ticket);
      expect(session.body.data.user.id).toBe(ids.admin);
      expect(session.body.data.user.role).toBe('admin');
    });

    it('refuses to attach a Google identity already linked to another admin', async () => {
      h.linkGoogle(ids.superAdmin, 'google-sub-ops');
      const res = await linkStart(PASSWORD);
      expect(await linkCallback(res.body.data.authorizationUrl)).toEqual({ error: 'identity_already_linked' });
      expect(h.one(`SELECT * FROM admin_oauth_identities WHERE user_id = '${ids.admin}'`)).toBeNull();
    });

    it('refuses to complete linking after the initiating session was revoked', async () => {
      const res = await linkStart(PASSWORD);
      await request(app).post('/api/v1/admin/auth/logout').set('Authorization', `Bearer ${token}`);
      expect(await linkCallback(res.body.data.authorizationUrl)).toEqual({ error: 'session_expired' });
      expect(h.many('SELECT * FROM admin_oauth_identities')).toHaveLength(0);
    });

    it('rejects linking a second Google account to the same admin', async () => {
      h.linkGoogle(ids.admin, 'google-sub-existing');
      const res = await linkStart(PASSWORD);
      expect(res.status).toBe(409);
    });
  });

  describe('16. inactive administrator', () => {
    beforeEach(() => h.linkGoogle(ids.superAdmin, 'google-sub-super-admin'));

    it('refuses a linked identity whose admin account is disabled', async () => {
      h.setUserStatus(ids.superAdmin, 'suspended');
      const { state, cookie } = await startLogin();
      expect(await callback({ state, cookie })).toEqual({ error: 'account_disabled' });
      expect(h.sessions.size).toBe(0);
    });

    it('re-checks the account at ticket exchange time', async () => {
      const { state, cookie } = await startLogin();
      const { ticket } = await callback({ state, cookie });
      h.setUserStatus(ids.superAdmin, 'suspended');
      const res = await exchange(ticket);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.ACCOUNT_DEACTIVATED);
      expect(h.sessions.size).toBe(0);
    });
  });

  it('never exposes Google tokens or the client secret to the browser', async () => {
    h.linkGoogle(ids.superAdmin, 'google-sub-super-admin');
    const { state, cookie } = await startLogin();
    const res = await request(app).get('/api/v1/admin/auth/google/callback')
      .query({ state, code: 'auth-code-123' }).set('Cookie', cookie.split(';')[0]);
    expect(res.headers.location).not.toContain('ya29.secret');
    expect(res.headers.location).not.toContain(CONFIG.clientSecret);
    expect(res.headers.location).not.toContain('eyJ');
    expect(JSON.stringify(auditEvents)).not.toMatch(/ya29\.secret|test-client-secret|auth-code-123/);
  });
});
