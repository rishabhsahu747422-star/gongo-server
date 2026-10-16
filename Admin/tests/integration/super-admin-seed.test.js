'use strict';

/**
 * Initial Super Admin seed (src/db/seeds/super-admin.seed.js), executed with its real SQL
 * against pg-mem, followed by real logins with the seeded account.
 */

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn(),
}));

const request = require('supertest');
const { createApp } = require('../../src/app');
const { resetRateLimits } = require('../../src/middlewares/rateLimiter');
const { verifyPassword } = require('../../src/utils/password');
const { seedSuperAdmin, SeedConflictError, SUPER_ADMIN_ACCOUNT } = require('../../src/db/seeds/super-admin.seed');
const renflairProvider = require('../../src/providers/renflair.provider');
const { createAuthHarness } = require('../support/admin-auth-harness');

const INITIAL_PASSWORD = 'Initial#SuperAdmin-2026';

describe('Super Admin initialization seed', () => {
  let app;
  let h;
  let client;

  const seed = (options) => seedSuperAdmin(client, options);
  const superAdminRows = () => h.many(`SELECT * FROM users WHERE LOWER(email) = '${SUPER_ADMIN_ACCOUNT.email}'`);

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(async () => {
    await resetRateLimits();
    h = createAuthHarness();
    await h.install();
    const { Client } = h.db.adapters.createPg();
    client = new Client();
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
    h.uninstall();
  });

  it('22. creates an active super_admin with normalized email, 10-digit mobile and SUPER_ADMIN permission', async () => {
    const result = await seed({ initialPassword: INITIAL_PASSWORD });

    expect(result.account).toBe('created');
    expect(result.permission).toBe('granted');
    expect(result.password).toMatch(/initial password set/);

    const [user] = superAdminRows();
    expect(user).toEqual(expect.objectContaining({
      email: 'gongorental@gmail.com', phone: '8989232398', role: 'super_admin', status: 'active', is_active: true,
    }));
    expect(h.many(`SELECT permission FROM admin_permissions WHERE user_id = '${user.id}'`))
      .toEqual([{ permission: 'SUPER_ADMIN' }]);

    const cred = h.one(`SELECT * FROM admin_credentials WHERE user_id = '${user.id}'`);
    expect(cred.password_hash).toMatch(/^scrypt\$/);
    expect(cred.password_hash).not.toContain(INITIAL_PASSWORD);
    expect(cred.must_change_password).toBe(true);
    expect(await verifyPassword(INITIAL_PASSWORD, cred.password_hash)).toBe(true);
  });

  it('22b. the seeded Super Admin can sign in by email and by mobile number', async () => {
    let lastOtp;
    renflairProvider.setMockSender(({ otp }) => {
      lastOtp = otp;
      return { success: true, simulated: true };
    });

    await seed({ initialPassword: INITIAL_PASSWORD });

    const byEmail = await request(app).post('/api/v1/admin/auth/login')
      .send({ identifier: 'gongorental@gmail.com', password: INITIAL_PASSWORD });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data.step).toBe('OTP_PENDING');
    const verifyEmail = await request(app).post('/api/v1/admin/auth/verify-2fa')
      .send({ challengeId: byEmail.body.data.challengeId, otp: lastOtp });

    const byMobile = await request(app).post('/api/admin/auth/login')
      .send({ identifier: '8989232398', password: INITIAL_PASSWORD });
    expect(byMobile.status).toBe(200);
    expect(byMobile.body.data.step).toBe('OTP_PENDING');
    const verifyMobile = await request(app).post('/api/v1/admin/auth/verify-2fa')
      .send({ challengeId: byMobile.body.data.challengeId, otp: lastOtp });

    [verifyEmail, verifyMobile].forEach((res) => {
      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe('super_admin');
      expect(res.body.data.user.permissions).toContain('SUPER_ADMIN');
      expect(res.body.data.passwordChangeRequired).toBe(true);
    });
  });

  it('23. reruns are idempotent and never overwrite an existing password', async () => {
    await seed({ initialPassword: INITIAL_PASSWORD });
    const [user] = superAdminRows();
    const before = h.one(`SELECT password_hash FROM admin_credentials WHERE user_id = '${user.id}'`).password_hash;

    const rerun = await seed({ initialPassword: 'Different#Password-2027' });
    expect(rerun.account).toBe('unchanged');
    expect(rerun.permission).toBe('already present');
    expect(rerun.password).toBe('existing password preserved');

    expect(superAdminRows()).toHaveLength(1);
    expect(h.many(`SELECT * FROM admin_permissions WHERE user_id = '${user.id}'`)).toHaveLength(1);
    const after = h.one(`SELECT password_hash FROM admin_credentials WHERE user_id = '${user.id}'`).password_hash;
    expect(after).toBe(before);
  });

  it('without SUPER_ADMIN_INITIAL_PASSWORD it provisions the account but sets no password', async () => {
    const result = await seed({});
    expect(result.password).toMatch(/not set/);
    const [user] = superAdminRows();
    expect(h.one(`SELECT * FROM admin_credentials WHERE user_id = '${user.id}'`)).toBeNull();

    const res = await request(app).post('/api/v1/admin/auth/login')
      .send({ identifier: 'gongorental@gmail.com', password: 'anything-at-all' });
    expect(res.status).toBe(401);

    // A later run may set it once
    expect((await seed({ initialPassword: INITIAL_PASSWORD })).password).toMatch(/initial password set/);
  });

  it('rejects a weak initial password', async () => {
    await expect(seed({ initialPassword: 'password' })).rejects.toThrow(SeedConflictError);
  });

  it('25. refuses to promote an existing non-admin account that merely matches the email', async () => {
    const customerId = h.addUser({ email: 'GongoRental@gmail.com', phone: '8989232398', role: 'customer' });

    await expect(seed({ initialPassword: INITIAL_PASSWORD })).rejects.toThrow(/--confirm-user-id=/);
    expect(h.one(`SELECT role FROM users WHERE id = '${customerId}'`).role).toBe('customer');
    expect(h.many('SELECT * FROM admin_permissions')).toHaveLength(0);

    // Wrong confirmation id is also refused
    await expect(seed({ confirmUserId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(SeedConflictError);

    // Explicit operator confirmation of that exact account is required
    const result = await seed({ initialPassword: INITIAL_PASSWORD, confirmUserId: customerId });
    expect(result.account).toBe('updated');
    expect(h.one(`SELECT role FROM users WHERE id = '${customerId}'`).role).toBe('super_admin');
  });

  it('25b. refuses when the Super Admin mobile number belongs to a different account', async () => {
    h.addUser({ email: 'someone@example.com', phone: '+918989232398', role: 'customer' });
    await expect(seed({ initialPassword: INITIAL_PASSWORD })).rejects.toThrow(/mobile number already belongs/);
    expect(superAdminRows()).toHaveLength(0);
  });

  it('does not silently reactivate a suspended Super Admin', async () => {
    await seed({ initialPassword: INITIAL_PASSWORD });
    const [user] = superAdminRows();
    h.setUserStatus(user.id, 'suspended');

    await expect(seed({})).rejects.toThrow(/reactivate/);
    expect(h.one(`SELECT status FROM users WHERE id = '${user.id}'`).status).toBe('suspended');
    await seed({ confirmUserId: user.id });
    expect(h.one(`SELECT status FROM users WHERE id = '${user.id}'`).status).toBe('active');
  });
});
