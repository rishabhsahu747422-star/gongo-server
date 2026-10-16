'use strict';

/**
 * Admin authentication: email/mobile + password login, sessions, logout, profile,
 * password change and privilege-escalation guards. Repositories run real SQL on pg-mem
 * (see tests/support/admin-auth-harness.js); the auth logic is not mocked.
 */

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn(),
}));

const request = require('supertest');
const { createApp } = require('../../src/app');
const auditService = require('../../src/services/audit.service');
const { resetRateLimits } = require('../../src/middlewares/rateLimiter');
const { hashSessionToken } = require('../../src/utils/crypto');
const { ERROR_CODES } = require('../../src/constants/errors');
const { PERMISSIONS } = require('../../src/constants/permissions');
const renflairProvider = require('../../src/providers/renflair.provider');
const { setMockSupabaseClient, resetSupabaseClient } = require('../../src/providers/supabase');
const { createAuthHarness } = require('../support/admin-auth-harness');

const PASSWORD = 'Gongo#Admin-2026!';
const LOGIN = '/api/v1/admin/auth/login';

describe('Integration: Admin password authentication & session lifecycle', () => {
  let app;
  let h;
  let auditEvents;
  let ids;
  let lastDispatchedOtp;

  const login = (identifier, password = PASSWORD) => request(app)
    .post(LOGIN)
    .send({ identifier, password });
  const verify2FA = (challengeId, otp = lastDispatchedOtp) => request(app)
    .post('/api/v1/admin/auth/verify-2fa')
    .send({ challengeId, otp });
  const resend2FA = (challengeId) => request(app)
    .post('/api/v1/admin/auth/resend-2fa')
    .send({ challengeId });
  const fullLogin = async (identifier, password = PASSWORD) => {
    const loginRes = await login(identifier, password);
    if (loginRes.status !== 200 || !loginRes.body?.data?.challengeId) {
      return loginRes;
    }
    const verifyRes = await verify2FA(loginRes.body.data.challengeId, lastDispatchedOtp);
    return verifyRes;
  };
  const bearer = (token) => ({ Authorization: `Bearer ${token}` });

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(async () => {
    await resetRateLimits();
    lastDispatchedOtp = null;
    renflairProvider.setMockSender(({ otp }) => {
      lastDispatchedOtp = otp;
      return { success: true, simulated: true };
    });
    auditEvents = [];
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((event) => {
      auditEvents.push(event);
      return event;
    });

    h = createAuthHarness();
    await h.install();
    ids = {
      superAdmin: h.addUser({
        email: 'gongorental@gmail.com', phone: '8989232398', role: 'super_admin', name: 'GONGO Super Admin',
      }),
      admin: h.addUser({
        email: 'ops@gongo.in', phone: '+919876500001', role: 'admin', name: 'Ops Admin',
      }),
      suspended: h.addUser({
        email: 'suspended@gongo.in', phone: '9876500002', role: 'admin', status: 'suspended',
      }),
      customer: h.addUser({ email: 'customer@example.com', phone: '9000000001', role: 'customer' }),
    };
    await h.setPassword(ids.superAdmin, PASSWORD);
    await h.setPassword(ids.admin, PASSWORD);
    await h.setPassword(ids.suspended, PASSWORD);
    // Even a stray credential row for a customer must never open the Admin Portal
    await h.setPassword(ids.customer, PASSWORD);
    h.grant(ids.superAdmin, PERMISSIONS.SUPER_ADMIN);
    h.grant(ids.admin, PERMISSIONS.VEHICLES_READ);
  });

  afterEach(() => {
    h.uninstall();
    jest.restoreAllMocks();
  });

  // ── Password login ──────────────────────────────────────────────────────────
  describe('POST /admin/auth/login', () => {
    it('1. password verification creates OTP challenge (case/whitespace-insensitive email)', async () => {
      const res = await login('  GongoRental@Gmail.COM ');

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { data } = res.body;
      expect(data.step).toBe('OTP_PENDING');
      expect(data.challengeId).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
      expect(data.phoneMasked).toBe('+91 ******2398');
      expect(data.expiresIn).toBe(300);
      expect(data.token).toBeUndefined();
      expect(data.user).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/password_hash|scrypt\$/);
    });

    it('1b. completes login after valid SMS OTP verification', async () => {
      const loginRes = await login('gongorental@gmail.com');
      const { challengeId } = loginRes.body.data;
      const res = await verify2FA(challengeId, lastDispatchedOtp);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { data } = res.body;
      expect(data.step).toBe('AUTHENTICATED');
      expect(data.tokenType).toBe('Bearer');
      expect(data.token).toMatch(/^[0-9a-f]{64}$/);
      expect(data.user).toEqual({
        id: ids.superAdmin,
        name: 'GONGO Super Admin',
        email: 'gongorental@gmail.com',
        phone: '8989232398',
        role: 'super_admin',
        status: 'active',
        permissions: [PERMISSIONS.SUPER_ADMIN],
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password_hash|scrypt\$/);
    });

    it.each(['8989232398', '+91 89892 32398', '08989232398', '91-8989232398'])(
      '2. initiates OTP challenge with registered mobile number + password (%s)',
      async (mobile) => {
        const res = await login(mobile);
        expect(res.status).toBe(200);
        expect(res.body.data.step).toBe('OTP_PENDING');
        expect(res.body.data.phoneMasked).toBe('+91 ******2398');
      },
    );

    it('2b. matches a mobile number stored in E.164 form and dispatches OTP', async () => {
      const res = await login('9876500001');
      expect(res.status).toBe(200);
      expect(res.body.data.step).toBe('OTP_PENDING');
      expect(res.body.data.phoneMasked).toBe('+91 ******0001');
    });

    it('3/4. wrong password and unknown identifier get the same generic 401', async () => {
      const wrongPassword = await login('gongorental@gmail.com', 'Wrong#Password-1');
      const unknownEmail = await login('nobody@gongo.in');
      const unknownMobile = await login('9123456789');

      [wrongPassword, unknownEmail, unknownMobile].forEach((res) => {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
        expect(res.body.error.message).toBe('Invalid credentials');
        expect(res.body.data).toBeUndefined();
      });
      expect(h.sessions.size).toBe(0);
    });

    it('5. rejects a missing password or identifier with 400', async () => {
      const noPassword = await request(app).post(LOGIN).send({ identifier: 'ops@gongo.in' });
      const noIdentifier = await request(app).post(LOGIN).send({ password: PASSWORD });
      const malformed = await request(app).post(LOGIN).send({ identifier: 'not-an-email-or-phone', password: PASSWORD });
      [noPassword, noIdentifier, malformed].forEach((res) => {
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      });
    });

    it('6. rejects a disabled administrator (403 only once the password is proven)', async () => {
      const correct = await login('suspended@gongo.in');
      expect(correct.status).toBe(403);
      expect(correct.body.error.code).toBe(ERROR_CODES.ACCOUNT_DEACTIVATED);

      const wrong = await login('suspended@gongo.in', 'Wrong#Password-1');
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
      expect(h.sessions.size).toBe(0);
    });

    it('7. never authenticates a non-admin account, even with a valid credential row', async () => {
      const byEmail = await login('customer@example.com');
      const byMobile = await login('9000000001');
      [byEmail, byMobile].forEach((res) => {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
      });
    });

    it('8a. rate-limits login attempts per client (429 with Retry-After)', async () => {
      let last;
      for (let i = 0; i < 11; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        last = await login('nobody@gongo.in', 'x');
      }
      expect(last.status).toBe(429);
      expect(last.headers['retry-after']).toBeDefined();
    });

    it('8b. locks the account after repeated wrong passwords; correct password is then refused', async () => {
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await login('ops@gongo.in', `Wrong#Password-${i}`);
        expect(res.status).toBe(401);
      }
      const locked = await login('ops@gongo.in');
      expect(locked.status).toBe(401);
      expect(locked.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
      expect(h.one(`SELECT locked_until FROM admin_credentials WHERE user_id = '${ids.admin}'`).locked_until)
        .not.toBeNull();
      expect(auditEvents.some((e) => e.action === 'ADMIN_LOGIN_FAILED' && e.metadata.reason === 'account_locked'))
        .toBe(true);
    });

    it('rejects client-supplied identity/role fields', async () => {
      const res = await request(app).post(LOGIN).send({
        identifier: 'ops@gongo.in', password: PASSWORD, role: 'super_admin',
      });
      expect(res.status).toBe(400);
      expect(h.sessions.size).toBe(0);
    });

    it('records security events without passwords, hashes or raw identifiers', async () => {
      await login('ops@gongo.in', 'Wrong#Password-1');
      await fullLogin('ops@gongo.in');
      const serialized = JSON.stringify(auditEvents);
      expect(serialized).toContain('ADMIN_LOGIN_FAILED');
      expect(serialized).toContain('ADMIN_OTP_CHALLENGE_CREATED');
      expect(serialized).toContain('ADMIN_OTP_VERIFIED');
      expect(serialized).toContain('ADMIN_LOGIN');
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain('Wrong#Password-1');
      expect(serialized).not.toContain('scrypt$');
      expect(serialized).not.toContain('ops@gongo.in');
    });

    it('reports passwordChangeRequired for a provisioned initial password', async () => {
      const id = h.addUser({ email: 'new@gongo.in', phone: '9876500003', role: 'admin' });
      await h.setPassword(id, PASSWORD, { mustChange: true });
      const res = await fullLogin('new@gongo.in');
      expect(res.status).toBe(200);
      expect(res.body.data.passwordChangeRequired).toBe(true);
    });
  });

  // ── One-time migration of Supabase-provisioned admins ───────────────────────
  describe('legacy Supabase Auth password migration', () => {
    let legacyId;
    let signInWithPassword;

    beforeEach(() => {
      legacyId = h.addUser({ email: 'legacy@gongo.in', phone: '9876500004', role: 'admin', authId: 'sup-legacy-uid' });
      signInWithPassword = jest.fn(async ({ password }) => (password === 'Legacy#Pass-2025'
        ? { data: { user: { id: 'sup-legacy-uid' } }, error: null }
        : { data: { user: null }, error: { message: 'Invalid login credentials' } }));
      setMockSupabaseClient({ auth: { signInWithPassword } });
    });

    afterEach(() => resetSupabaseClient());

    it('verifies once against the bound Supabase account, then uses only the local hash', async () => {
      const first = await login('legacy@gongo.in', 'Legacy#Pass-2025');
      expect(first.status).toBe(200);
      expect(first.body.data.step).toBe('OTP_PENDING');
      const cred = h.one(`SELECT password_hash FROM admin_credentials WHERE user_id = '${legacyId}'`);
      expect(cred.password_hash).toMatch(/^scrypt\$/);

      signInWithPassword.mockClear();
      const second = await login('legacy@gongo.in', 'Legacy#Pass-2025');
      expect(second.status).toBe(200);
      expect(second.body.data.step).toBe('OTP_PENDING');
      expect(signInWithPassword).not.toHaveBeenCalled();
    });

    it('rejects when Supabase accepts the password for a different auth account', async () => {
      signInWithPassword.mockResolvedValue({ data: { user: { id: 'someone-else' } }, error: null });
      const res = await login('legacy@gongo.in', 'Legacy#Pass-2025');
      expect(res.status).toBe(401);
      expect(h.one(`SELECT * FROM admin_credentials WHERE user_id = '${legacyId}'`)).toBeNull();
    });

    it('rejects a wrong password without creating a credential', async () => {
      const res = await login('legacy@gongo.in', 'Wrong#Password-1');
      expect(res.status).toBe(401);
      expect(h.one(`SELECT * FROM admin_credentials WHERE user_id = '${legacyId}'`)).toBeNull();
    });
  });

  // ── Mandatory SMS OTP verification & challenge security ─────────────────────
  describe('Mandatory SMS OTP verification & challenge security', () => {
    let challengeId;

    beforeEach(async () => {
      const loginRes = await login('ops@gongo.in');
      challengeId = loginRes.body.data.challengeId;
    });

    it('rejects verify-2fa with missing challengeId or missing OTP with 400', async () => {
      const noChallenge = await request(app).post('/api/v1/admin/auth/verify-2fa').send({ otp: '123456' });
      expect(noChallenge.status).toBe(400);

      const noOtp = await request(app).post('/api/v1/admin/auth/verify-2fa').send({ challengeId });
      expect(noOtp.status).toBe(400);

      const malformedOtp = await request(app).post('/api/v1/admin/auth/verify-2fa').send({ challengeId, otp: '12abc' });
      expect(malformedOtp.status).toBe(400);
    });

    it('rejects invalid OTP with 401 and decrements remaining attempts', async () => {
      const wrong = await verify2FA(challengeId, '000000');
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
      expect(wrong.body.error.message).toMatch(/attempt\(s\) remaining/);
    });

    it('locks out and destroys challenge after max failed OTP attempts', async () => {
      let lastRes;
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        lastRes = await verify2FA(challengeId, `00000${i}`);
      }
      expect(lastRes.status).toBe(401);
      expect(lastRes.body.error.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
      expect(lastRes.body.error.message).toMatch(/Too many failed attempts/);

      // Subsequent attempt with original valid OTP is rejected because challenge was destroyed
      const retry = await verify2FA(challengeId, lastDispatchedOtp);
      expect(retry.status).toBe(401);
      expect(retry.body.error.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
    });

    it('prevents replay: cannot verify the same challenge/OTP twice (atomic consumption)', async () => {
      const first = await verify2FA(challengeId, lastDispatchedOtp);
      expect(first.status).toBe(200);
      expect(first.body.data.step).toBe('AUTHENTICATED');

      const replay = await verify2FA(challengeId, lastDispatchedOtp);
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
    });

    it('rejects an expired or non-existent challenge ID', async () => {
      const res = await verify2FA('nonexistent-challenge-id-000000000000000000', '123456');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
    });

    it('enforces cooldown on resend-2fa', async () => {
      // First resend immediately after login hits cooldown
      const immediate = await resend2FA(challengeId);
      expect(immediate.status).toBe(429);
      expect(immediate.body.error.message).toMatch(/Please wait/);
    });

    it('resends new OTP after cooldown, invalidates old OTP, and preserves challenge', async () => {
      const { redisClient } = require('../../src/providers/redis');
      const { sha256 } = require('../../src/utils/crypto');
      // Clear cooldown key in redis to simulate elapsed cooldown
      await redisClient.del(`admin:auth:cooldown:${sha256(challengeId)}`);

      const oldOtp = lastDispatchedOtp;
      let newDispatchedOtp;
      renflairProvider.setMockSender(({ otp }) => {
        newDispatchedOtp = otp;
        return { success: true, simulated: true };
      });

      const resendRes = await resend2FA(challengeId);
      expect(resendRes.status).toBe(200);
      expect(resendRes.body.data.cooldownRemaining).toBeGreaterThan(0);

      // Old OTP is no longer accepted
      const oldVerify = await verify2FA(challengeId, oldOtp);
      expect(oldVerify.status).toBe(401);

      // New OTP succeeds
      const newVerify = await verify2FA(challengeId, newDispatchedOtp);
      expect(newVerify.status).toBe(200);
      expect(newVerify.body.data.step).toBe('AUTHENTICATED');
    });

    it('rejects verification if administrator is disabled after challenge was issued', async () => {
      h.setUserStatus(ids.admin, 'suspended');
      const res = await verify2FA(challengeId, lastDispatchedOtp);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.ACCOUNT_DEACTIVATED);
    });

    it('challenge token cannot authorize protected admin APIs', async () => {
      const me = await request(app).get('/api/v1/admin/auth/me').set(bearer(challengeId));
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);

      const admin = await request(app).get('/api/v1/admin').set(bearer(challengeId));
      expect(admin.status).toBe(401);
      expect(admin.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);
    });
  });

  // ── Sessions ────────────────────────────────────────────────────────────────
  describe('Sessions, /me, logout', () => {
    it('17. successful login creates a server-side session storing only the token hash', async () => {
      const { body } = await fullLogin('ops@gongo.in');
      const stored = h.sessions.get(hashSessionToken(body.data.token));
      expect(stored).toBeDefined();
      expect(stored.user_id).toBe(ids.admin);
      expect([...h.sessions.keys()]).not.toContain(body.data.token);
      expect(new Date(stored.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('18. GET /me returns the authenticated profile with safe fields only', async () => {
      const { body } = await fullLogin('8989232398');
      const res = await request(app).get('/api/v1/admin/auth/me').set(bearer(body.data.token));

      expect(res.status).toBe(200);
      expect(res.body.data.user).toEqual(expect.objectContaining({
        id: ids.superAdmin,
        email: 'gongorental@gmail.com',
        phone: '8989232398',
        role: 'super_admin',
        status: 'active',
        permissions: [PERMISSIONS.SUPER_ADMIN],
      }));
      expect(res.body.data.session.id).toBeDefined();
      expect(JSON.stringify(res.body)).not.toMatch(/password|session_token|scrypt/i);
    });

    it('19. rejects unauthenticated and forged requests', async () => {
      const none = await request(app).get('/api/v1/admin/auth/me');
      expect(none.status).toBe(401);

      const forged = await request(app).get('/api/v1/admin/auth/me').set(bearer('f'.repeat(64)));
      expect(forged.status).toBe(401);
      expect(forged.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);

      const protectedRoute = await request(app).get('/api/v1/admin').set(bearer('f'.repeat(64)));
      expect(protectedRoute.status).toBe(401);
    });

    it('20/21. logout revokes the session; the token no longer authorizes protected APIs', async () => {
      const { body } = await fullLogin('ops@gongo.in');
      const { token } = body.data;
      expect((await request(app).get('/api/v1/admin').set(bearer(token))).status).toBe(200);

      const out = await request(app).post('/api/v1/admin/auth/logout').set(bearer(token));
      expect(out.status).toBe(200);
      expect(h.sessions.get(hashSessionToken(token)).is_active).toBe(false);

      const me = await request(app).get('/api/v1/admin/auth/me').set(bearer(token));
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe(ERROR_CODES.TOKEN_REVOKED);
      const admin = await request(app).get('/api/v1/admin').set(bearer(token));
      expect(admin.status).toBe(401);
    });

    it('logout-all revokes every session of the admin only', async () => {
      const a1 = (await fullLogin('ops@gongo.in')).body.data.token;
      const a2 = (await fullLogin('9876500001')).body.data.token;
      const other = (await fullLogin('gongorental@gmail.com')).body.data.token;

      const res = await request(app).post('/api/v1/admin/auth/logout-all').set(bearer(a1));
      expect(res.status).toBe(200);
      expect(res.body.data.revokedCount).toBe(2);
      expect((await request(app).get('/api/v1/admin/auth/me').set(bearer(a2))).status).toBe(401);
      expect((await request(app).get('/api/v1/admin/auth/me').set(bearer(other))).status).toBe(200);
    });

    it('rejects a session once the admin is disabled', async () => {
      const { token } = (await fullLogin('ops@gongo.in')).body.data;
      h.setUserStatus(ids.admin, 'suspended');
      const res = await request(app).get('/api/v1/admin/auth/me').set(bearer(token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.ACCOUNT_DEACTIVATED);
    });

    it('refresh rotates the token and revokes the old one', async () => {
      const oldToken = (await fullLogin('ops@gongo.in')).body.data.token;
      const res = await request(app).post('/api/v1/admin/auth/refresh').set(bearer(oldToken));
      expect(res.status).toBe(200);
      const newToken = res.body.data.token;
      expect(newToken).not.toBe(oldToken);
      expect((await request(app).get('/api/v1/admin/auth/me').set(bearer(oldToken))).status).toBe(401);
      expect((await request(app).get('/api/v1/admin/auth/me').set(bearer(newToken))).status).toBe(200);
    });
  });

  // ── Password change ─────────────────────────────────────────────────────────
  describe('POST /admin/auth/password/change', () => {
    const NEW_PASSWORD = 'Brand-New#Pass-2027';

    it('requires the current password, enforces policy, and revokes other sessions', async () => {
      const current = (await fullLogin('ops@gongo.in')).body.data.token;
      const other = (await fullLogin('9876500001')).body.data.token;
      const change = (body) => request(app).post('/api/v1/admin/auth/password/change').set(bearer(current)).send(body);

      expect((await change({ currentPassword: 'Wrong#Password-1', newPassword: NEW_PASSWORD })).status).toBe(403);
      expect((await change({ currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);

      const ok = await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(ok.status).toBe(200);
      expect(ok.body.data.revokedSessions).toBe(1);

      expect((await request(app).get('/api/v1/admin/auth/me').set(bearer(current))).status).toBe(200);
      expect((await request(app).get('/api/v1/admin/auth/me').set(bearer(other))).status).toBe(401);
      expect((await fullLogin('ops@gongo.in')).status).toBe(401);
      expect((await fullLogin('ops@gongo.in', NEW_PASSWORD)).status).toBe(200);
    });
  });

  // ── Privilege escalation ────────────────────────────────────────────────────
  describe('Super Admin protection', () => {
    let adminToken;

    beforeEach(async () => {
      h.grant(ids.admin, PERMISSIONS.ADMIN_PERMISSIONS_MANAGE);
      h.grant(ids.admin, PERMISSIONS.ADMIN_USERS_CREATE);
      adminToken = (await fullLogin('ops@gongo.in')).body.data.token;
    });

    it('24. an ordinary admin cannot promote themselves to super_admin', async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${ids.admin}/role`)
        .set(bearer(adminToken))
        .send({ role: 'super_admin' });
      expect(res.status).toBe(403);
      expect(h.one(`SELECT role FROM users WHERE id = '${ids.admin}'`).role).toBe('admin');
    });

    it('24b. an ordinary admin cannot create a super_admin account', async () => {
      const res = await request(app)
        .post('/api/v1/admin/users')
        .set(bearer(adminToken))
        .send({
          name: 'Shadow', email: 'shadow@gongo.in', role: 'super_admin', password: 'Shadow#Pass-2026',
        });
      expect(res.status).toBe(403);
      expect(h.one("SELECT id FROM users WHERE email = 'shadow@gongo.in'")).toBeNull();
    });

    it('24c. role/permission claims sent by the client are ignored by authorization', async () => {
      // The admin lacks customers.read; spoofed headers/query must not change that.
      const res = await request(app)
        .get('/api/v1/admin/customers')
        .set({ ...bearer(adminToken), 'x-role': 'SUPER_ADMIN', 'x-permissions': 'SUPER_ADMIN' })
        .query({ role: 'super_admin', permissions: 'SUPER_ADMIN' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(ERROR_CODES.INSUFFICIENT_PERMISSIONS);

      const me = await request(app).get('/api/v1/admin/auth/me').set(bearer(adminToken));
      expect(me.body.data.user.role).toBe('admin');
      expect(me.body.data.user.permissions).not.toContain(PERMISSIONS.SUPER_ADMIN);
    });

    it('25. an account matching the Super Admin email but not an admin gets nothing', async () => {
      // Recreate the scenario: Super Admin email held by a customer row, no admin row
      h.db.public.none(`UPDATE users SET role = 'customer' WHERE id = '${ids.superAdmin}'`);
      const byEmail = await login('gongorental@gmail.com');
      const byMobile = await login('8989232398');
      [byEmail, byMobile].forEach((res) => {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
      });
    });
  });
});
