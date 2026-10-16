'use strict';

const adminAuthService = require('../../src/services/admin-auth.service');
const userRepository = require('../../src/repositories/user.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminPermissionRepository = require('../../src/repositories/admin-permission.repository');
const auditService = require('../../src/services/audit.service');
const { hashSessionToken } = require('../../src/utils/crypto');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Unit: AdminAuthService (Authentication & Session Lifecycle)', () => {
  let auditSpy;

  beforeEach(() => {
    auditSpy = jest.spyOn(auditService, 'logAdminAction').mockImplementation((event) => event);

    userRepository.constructor.setMockUserResolver((authId) => {
      if (authId === 'uid-admin-1') {
        return {
          id: 'admin-uuid-1',
          auth_id: 'uid-admin-1',
          role: 'ADMIN',
          name: 'Super Admin',
          email: 'admin1@gongo.in',
          is_active: true,
        };
      }
      if (authId === 'uid-customer-1') {
        return {
          id: 'cust-uuid-1',
          auth_id: 'uid-customer-1',
          role: 'CUSTOMER',
          name: 'Regular Customer',
          email: 'cust@gongo.in',
          is_active: true,
        };
      }
      if (authId === 'uid-deactivated') {
        return {
          id: 'admin-deactivated-uuid',
          auth_id: 'uid-deactivated',
          role: 'ADMIN',
          name: 'Deactivated Admin',
          email: 'deactivated@gongo.in',
          is_active: false,
        };
      }
      return null;
    });

    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      if (id === 'admin-uuid-1') {
        return {
          id: 'admin-uuid-1',
          auth_id: 'uid-admin-1',
          role: 'ADMIN',
          name: 'Super Admin',
          email: 'admin1@gongo.in',
          is_active: true,
        };
      }
      if (id === 'admin-deactivated-uuid') {
        return {
          id: 'admin-deactivated-uuid',
          auth_id: 'uid-deactivated',
          role: 'ADMIN',
          name: 'Deactivated Admin',
          email: 'deactivated@gongo.in',
          is_active: false,
        };
      }
      return null;
    });

    jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(async () => [
      'SUPER_ADMIN',
    ]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    userRepository.constructor.resetMockUserResolver();
    adminSessionRepository.constructor.resetMockSessionResolver();
  });

  // ── 1. createAuthenticatedSession (shared by password + Google sign-in) ───────
  describe('createAuthenticatedSession', () => {
    const ADMIN = {
      id: 'admin-uuid-1', role: 'admin', name: 'Ops', email: 'ops@gongo.in', status: 'active', is_active: true,
    };

    it('creates a session, resolves permissions and audits without leaking the raw token', async () => {
      jest.spyOn(adminSessionRepository, 'countActiveSessionsByUserId').mockResolvedValue(1);
      const createSecureSpy = jest.spyOn(adminSessionRepository, 'createSecureSession').mockResolvedValue({
        session: { id: 'session-uuid-1', user_id: 'admin-uuid-1', expires_at: new Date(Date.now() + 3600000).toISOString() },
        rawToken: 'mock-raw-session-token',
      });

      const result = await adminAuthService.createAuthenticatedSession({
        user: ADMIN, authMethod: 'password_email', ipAddress: '10.0.0.1', userAgent: 'jest', requestId: 'req-1',
      });

      expect(result.rawToken).toBe('mock-raw-session-token');
      expect(result.user.permissions).toEqual(['SUPER_ADMIN']);
      expect(createSecureSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-uuid-1' }));
      expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({
        action: 'ADMIN_LOGIN',
        actorId: 'admin-uuid-1',
        metadata: expect.objectContaining({ loginMethod: 'password_email' }),
      }));
      expect(JSON.stringify(auditSpy.mock.calls)).not.toContain('mock-raw-session-token');
    });

    it('revokes oldest sessions when active sessions exceed configured maximum', async () => {
      jest.spyOn(adminSessionRepository, 'countActiveSessionsByUserId').mockResolvedValue(100);
      const revokeOldestSpy = jest.spyOn(adminSessionRepository, 'revokeOldestSessions').mockResolvedValue(2);
      jest.spyOn(adminSessionRepository, 'createSecureSession').mockResolvedValue({
        session: { id: 'session-new', user_id: 'admin-uuid-1' },
        rawToken: 'new-raw-token',
      });

      await adminAuthService.createAuthenticatedSession({ user: ADMIN, authMethod: 'google' });
      expect(revokeOldestSpy).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['inactive', { ...ADMIN, status: 'suspended' }],
      ['customer', { ...ADMIN, role: 'customer' }],
      ['missing', null],
    ])('refuses to create a session for a %s account', async (_label, user) => {
      const createSecureSpy = jest.spyOn(adminSessionRepository, 'createSecureSession');
      await expect(adminAuthService.createAuthenticatedSession({ user, authMethod: 'google' }))
        .rejects.toMatchObject({ statusCode: 403 });
      expect(createSecureSpy).not.toHaveBeenCalled();
    });
  });

  describe('resolvePermissions', () => {
    it('grants SUPER_ADMIN to the canonical super_admin role from the database', async () => {
      jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockResolvedValue([]);
      const perms = await adminAuthService.resolvePermissions({ id: 'u1', role: 'super_admin' });
      expect(perms).toEqual(['SUPER_ADMIN']);
    });

    it('does not grant SUPER_ADMIN to an ordinary admin', async () => {
      jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockResolvedValue(['vehicles.read']);
      const perms = await adminAuthService.resolvePermissions({ id: 'u2', role: 'admin' });
      expect(perms).toEqual(['vehicles.read']);
    });

    it('fails closed to no permissions when the lookup errors', async () => {
      jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockRejectedValue(new Error('db down'));
      const perms = await adminAuthService.resolvePermissions({ id: 'u3', role: 'admin' });
      expect(perms).toEqual([]);
    });
  });

  // ── 2. validateSession ────────────────────────────────────────────────────
  describe('validateSession', () => {
    it('validates active non-expired session successfully', async () => {
      const rawToken = 'sample-raw-session-token-for-testing';
      const tokenHash = hashSessionToken(rawToken);

      jest.spyOn(adminSessionRepository, 'findByToken').mockResolvedValue({
        id: 'session-uuid-1',
        user_id: 'admin-uuid-1',
        session_token: tokenHash,
        is_active: true,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        last_active_at: new Date().toISOString(),
      });

      const touchSpy = jest.spyOn(adminSessionRepository, 'touchSession').mockResolvedValue(true);

      const result = await adminAuthService.validateSession(rawToken);

      expect(result).toBeDefined();
      expect(result.session.id).toBe('session-uuid-1');
      expect(result.user.id).toBe('admin-uuid-1');
      expect(result.user.role).toBe('ADMIN');
      expect(touchSpy).not.toHaveBeenCalled(); // Within throttle window
    });

    it.each(['admin', 'super_admin', 'support_executive'])(
      'accepts lowercase DB role "%s" (users_role_check stores lowercase)',
      async (dbRole) => {
        const rawToken = `lowercase-role-token-${dbRole}`;
        jest.spyOn(adminSessionRepository, 'findByToken').mockResolvedValue({
          id: 'session-lower',
          user_id: 'admin-uuid-lower',
          session_token: hashSessionToken(rawToken),
          is_active: true,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          last_active_at: new Date().toISOString(),
        });
        jest.spyOn(userRepository, 'findById').mockResolvedValue({
          id: 'admin-uuid-lower',
          role: dbRole,
          is_active: true,
          email: 'ops@example.com',
        });

        const result = await adminAuthService.validateSession(rawToken);
        expect(result.user.id).toBe('admin-uuid-lower');
      },
    );

    it('still rejects non-admin DB roles', async () => {
      const rawToken = 'customer-role-token';
      jest.spyOn(adminSessionRepository, 'findByToken').mockResolvedValue({
        id: 'session-cust',
        user_id: 'cust-uuid',
        session_token: hashSessionToken(rawToken),
        is_active: true,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        last_active_at: new Date().toISOString(),
      });
      jest.spyOn(userRepository, 'findById').mockResolvedValue({
        id: 'cust-uuid', role: 'customer', is_active: true,
      });

      await expect(adminAuthService.validateSession(rawToken)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects non-existent session with 401 INVALID_TOKEN', async () => {
      jest.spyOn(adminSessionRepository, 'findByToken').mockResolvedValue(null);

      await expect(
        adminAuthService.validateSession('nonexistent-raw-token'),
      ).rejects.toMatchObject({
        statusCode: 401,
        code: ERROR_CODES.INVALID_TOKEN,
      });
    });

    it('rejects revoked session with 401 TOKEN_REVOKED', async () => {
      const rawToken = 'revoked-token-test';
      const tokenHash = hashSessionToken(rawToken);

      jest.spyOn(adminSessionRepository, 'findByToken').mockResolvedValue({
        id: 'session-revoked',
        user_id: 'admin-uuid-1',
        session_token: tokenHash,
        is_active: false,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        last_active_at: new Date().toISOString(),
      });

      await expect(adminAuthService.validateSession(rawToken)).rejects.toMatchObject({
        statusCode: 401,
        code: ERROR_CODES.TOKEN_REVOKED,
      });
    });

    it('rejects expired session with 401 TOKEN_EXPIRED', async () => {
      const rawToken = 'expired-token-test';
      const tokenHash = hashSessionToken(rawToken);

      jest.spyOn(adminSessionRepository, 'findByToken').mockResolvedValue({
        id: 'session-expired',
        user_id: 'admin-uuid-1',
        session_token: tokenHash,
        is_active: true,
        expires_at: new Date(Date.now() - 1000).toISOString(), // Expired 1s ago
        last_active_at: new Date(Date.now() - 5000).toISOString(),
      });

      await expect(adminAuthService.validateSession(rawToken)).rejects.toMatchObject({
        statusCode: 401,
        code: ERROR_CODES.TOKEN_EXPIRED,
      });
    });

    it('rejects deactivated user associated with active session', async () => {
      const rawToken = 'valid-token-deactivated-user';
      const tokenHash = hashSessionToken(rawToken);

      jest.spyOn(adminSessionRepository, 'findByToken').mockResolvedValue({
        id: 'session-deact',
        user_id: 'admin-deactivated-uuid',
        session_token: tokenHash,
        is_active: true,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        last_active_at: new Date().toISOString(),
      });

      await expect(adminAuthService.validateSession(rawToken)).rejects.toMatchObject({
        statusCode: 403,
        code: ERROR_CODES.ACCOUNT_DEACTIVATED,
      });
    });

    it('updates last_active_at when activity interval exceeds throttle threshold', async () => {
      const rawToken = 'activity-throttle-token';
      const tokenHash = hashSessionToken(rawToken);

      // 2 minutes ago (> 60s throttle)
      const pastActive = new Date(Date.now() - 120000).toISOString();

      jest.spyOn(adminSessionRepository, 'findByToken').mockResolvedValue({
        id: 'session-throttle',
        user_id: 'admin-uuid-1',
        session_token: tokenHash,
        is_active: true,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        last_active_at: pastActive,
      });

      const touchSpy = jest.spyOn(adminSessionRepository, 'touchSession').mockResolvedValue(true);

      await adminAuthService.validateSession(rawToken);

      expect(touchSpy).toHaveBeenCalledWith(tokenHash);
    });
  });

  // ── 3. logout & logoutAll ─────────────────────────────────────────────────
  describe('logout & logoutAll', () => {
    it('revokes the specific session and logs audit event', async () => {
      const revokeSpy = jest.spyOn(adminSessionRepository, 'revokeSession').mockResolvedValue(true);

      const result = await adminAuthService.logout({
        rawToken: 'token-to-revoke',
        userId: 'admin-uuid-1',
        sessionId: 'session-uuid-1',
      });

      expect(result.message).toContain('Successfully logged out');
      expect(revokeSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ADMIN_LOGOUT',
          actorId: 'admin-uuid-1',
        }),
      );
    });

    it('revokes all sessions for user on logoutAll and returns count', async () => {
      const revokeAllSpy = jest
        .spyOn(adminSessionRepository, 'revokeAllUserSessions')
        .mockResolvedValue(3);

      const result = await adminAuthService.logoutAll({
        userId: 'admin-uuid-1',
      });

      expect(result.revokedCount).toBe(3);
      expect(revokeAllSpy).toHaveBeenCalledWith('admin-uuid-1');
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ADMIN_LOGOUT_ALL',
          actorId: 'admin-uuid-1',
          metadata: expect.objectContaining({ revokedCount: 3 }),
        }),
      );
    });
  });

  // ── 4. refreshSession ─────────────────────────────────────────────────────
  describe('refreshSession', () => {
    it('revokes old session and creates a fresh session', async () => {
      const oldRawToken = 'old-raw-token';
      const oldHash = hashSessionToken(oldRawToken);

      jest.spyOn(adminAuthService, 'validateSession').mockResolvedValue({
        session: { id: 'old-session-id', session_token: oldHash },
        user: { id: 'admin-uuid-1', role: 'ADMIN' },
      });

      const revokeSpy = jest.spyOn(adminSessionRepository, 'revokeSession').mockResolvedValue(true);
      const createSecureSpy = jest
        .spyOn(adminSessionRepository, 'createSecureSession')
        .mockResolvedValue({
          session: { id: 'new-session-id', expires_at: new Date(Date.now() + 86400000) },
          rawToken: 'new-raw-session-token',
        });

      const result = await adminAuthService.refreshSession({
        rawToken: oldRawToken,
      });

      expect(result.rawToken).toBe('new-raw-session-token');
      expect(revokeSpy).toHaveBeenCalledWith(oldHash);
      expect(createSecureSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ADMIN_SESSION_REFRESH',
          actorId: 'admin-uuid-1',
        }),
      );
    });
  });

  // ── 5. cleanupExpiredSessions ─────────────────────────────────────────────
  describe('cleanupExpiredSessions', () => {
    it('calls repository cleanup contract with retention cutoff date', async () => {
      const cleanupSpy = jest
        .spyOn(adminSessionRepository, 'cleanupExpiredSessions')
        .mockResolvedValue(5);

      const count = await adminAuthService.cleanupExpiredSessions(30);

      expect(count).toBe(5);
      expect(cleanupSpy).toHaveBeenCalledWith(expect.any(Date));
    });
  });
});
