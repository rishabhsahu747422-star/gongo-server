'use strict';

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const adminProfileService = require('../../src/services/admin-profile.service');
const userRepository = require('../../src/repositories/user.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminPermissionRepository = require('../../src/repositories/admin-permission.repository');
const auditService = require('../../src/services/audit.service');
const {
  ValidationError,
  ForbiddenError,
  NotFoundError,
} = require('../../src/errors');

const MOCK_ADMIN_USER = {
  id: 'a0000001-0000-4000-a000-000000000001',
  auth_id: 'supabase-admin-1',
  role: 'ADMIN',
  name: 'Original Admin',
  email: 'admin1@gongo.in',
  country_code: '+91',
  phone: '9876543210',
  is_active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const MOCK_OTHER_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'supabase-admin-2',
  role: 'ADMIN',
  name: 'Other Admin',
  email: 'admin2@gongo.in',
  is_active: true,
};

const MOCK_DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'supabase-admin-3',
  role: 'ADMIN',
  name: 'Deactivated Admin',
  email: 'deactivated@gongo.in',
  is_active: false,
};

const MOCK_CUSTOMER_USER = {
  id: 'c0000001-0000-4000-a000-000000000001',
  auth_id: 'firebase-customer-1',
  role: 'CUSTOMER',
  name: 'Customer',
  email: 'cust@gongo.in',
  is_active: true,
};

describe('Unit: AdminProfileService (Phase 5 — Profile & Account Security)', () => {
  let auditLogs;

  beforeEach(() => {
    jest.restoreAllMocks();
    auditLogs = [];
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((event) => {
      auditLogs.push(event);
      return event;
    });
  });

  describe('1. getProfile', () => {
    it('retrieves safe profile with permissions and session count', async () => {
      jest.spyOn(userRepository, 'findById').mockResolvedValue(MOCK_ADMIN_USER);
      jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockResolvedValue(['dashboard.read']);
      jest.spyOn(adminSessionRepository, 'countActiveSessionsByUserId').mockResolvedValue(2);

      const profile = await adminProfileService.getProfile(MOCK_ADMIN_USER.id);

      expect(profile).toHaveProperty('id', MOCK_ADMIN_USER.id);
      expect(profile).toHaveProperty('name', 'Original Admin');
      expect(profile).toHaveProperty('email', 'admin1@gongo.in');
      expect(profile).toHaveProperty('role', 'ADMIN');
      expect(profile).toHaveProperty('is_active', true);
      expect(profile.permissions).toEqual(['dashboard.read']);
      expect(profile.security.activeSessionsCount).toBe(2);

      // Verify sensitive fields are not present
      expect(profile).not.toHaveProperty('password');
      expect(profile).not.toHaveProperty('session_token');
      expect(profile).not.toHaveProperty('auth_id');
    });

    it('resolves current session metadata when token hash is provided', async () => {
      jest.spyOn(userRepository, 'findById').mockResolvedValue(MOCK_ADMIN_USER);
      jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockResolvedValue([]);
      jest.spyOn(adminSessionRepository, 'countActiveSessionsByUserId').mockResolvedValue(1);
      jest.spyOn(adminSessionRepository, 'findByToken').mockResolvedValue({
        id: 'sess-100',
        user_id: MOCK_ADMIN_USER.id,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-02T00:00:00.000Z',
        last_active_at: '2026-01-01T01:00:00.000Z',
        ip_address: '127.0.0.1',
        user_agent: 'TestAgent/1.0',
      });

      const profile = await adminProfileService.getProfile(MOCK_ADMIN_USER.id, 'hash-token-123');

      expect(profile.security.currentSession).toBeDefined();
      expect(profile.security.currentSession.id).toBe('sess-100');
      expect(profile.security.currentSession).not.toHaveProperty('session_token');
    });

    it('throws NotFoundError if admin user is not found', async () => {
      jest.spyOn(userRepository, 'findById').mockResolvedValue(null);

      await expect(adminProfileService.getProfile('non-existent-id')).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError if admin user is deactivated', async () => {
      jest.spyOn(userRepository, 'findById').mockResolvedValue(MOCK_DEACTIVATED_ADMIN);

      await expect(
        adminProfileService.getProfile(MOCK_DEACTIVATED_ADMIN.id),
      ).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError if user role is not ADMIN', async () => {
      jest.spyOn(userRepository, 'findById').mockResolvedValue(MOCK_CUSTOMER_USER);

      await expect(
        adminProfileService.getProfile(MOCK_CUSTOMER_USER.id),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('2. updateProfile — Allowed Updates & Audit', () => {
    it('updates name successfully and logs audit event', async () => {
      jest.spyOn(userRepository, 'findById').mockResolvedValue(MOCK_ADMIN_USER);
      jest.spyOn(userRepository, 'updateProfile').mockResolvedValue({
        ...MOCK_ADMIN_USER,
        name: 'Updated Name',
        updated_at: '2026-01-02T00:00:00.000Z',
      });
      jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockResolvedValue([]);
      jest.spyOn(adminSessionRepository, 'countActiveSessionsByUserId').mockResolvedValue(1);

      const res = await adminProfileService.updateProfile(
        MOCK_ADMIN_USER.id,
        { name: 'Updated Name' },
        { actor: MOCK_ADMIN_USER, requestId: 'req-1', ipAddress: '127.0.0.1' },
      );

      expect(res.name).toBe('Updated Name');
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        action: 'PROFILE_UPDATED',
        actorId: MOCK_ADMIN_USER.id,
        targetResource: 'USER',
        targetResourceId: MOCK_ADMIN_USER.id,
        beforeState: { name: 'Original Admin' },
        afterState: { name: 'Updated Name' },
      });
    });

    it('updates phone and country_code successfully', async () => {
      jest.spyOn(userRepository, 'findById').mockResolvedValue(MOCK_ADMIN_USER);
      jest.spyOn(userRepository, 'updateProfile').mockResolvedValue({
        ...MOCK_ADMIN_USER,
        phone: '+919988776655',
        country_code: '+91',
      });
      jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockResolvedValue([]);
      jest.spyOn(adminSessionRepository, 'countActiveSessionsByUserId').mockResolvedValue(1);

      const res = await adminProfileService.updateProfile(
        MOCK_ADMIN_USER.id,
        { phone: '+919988776655', country_code: '+91' },
        { actor: MOCK_ADMIN_USER },
      );

      expect(res.phone).toBe('+919988776655');
    });

    it('allows clearing phone and country_code with null', async () => {
      jest.spyOn(userRepository, 'findById').mockResolvedValue(MOCK_ADMIN_USER);
      jest.spyOn(userRepository, 'updateProfile').mockResolvedValue({
        ...MOCK_ADMIN_USER,
        phone: null,
        country_code: null,
      });
      jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockResolvedValue([]);
      jest.spyOn(adminSessionRepository, 'countActiveSessionsByUserId').mockResolvedValue(1);

      const res = await adminProfileService.updateProfile(
        MOCK_ADMIN_USER.id,
        { phone: null, country_code: null },
        { actor: MOCK_ADMIN_USER },
      );

      expect(res.phone).toBeNull();
      expect(res.country_code).toBeNull();
    });
  });

  describe('3. updateProfile — Security, Mass Assignment & BOLA Protection', () => {
    it('prevents BOLA: cannot update another administrator profile', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_OTHER_ADMIN.id,
          { name: 'Hacked Name' },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects email modification attempts explicitly', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          { email: 'newemail@gongo.in' },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects role escalation attempts', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          { role: 'SUPER_ADMIN', name: 'Name' },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects is_active tampering', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          { is_active: false, name: 'Name' },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects permissions injection', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          { permissions: ['SUPER_ADMIN'], name: 'Name' },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects userId/id tampering in payload', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          { userId: MOCK_OTHER_ADMIN.id, name: 'Name' },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects unexpected / unknown fields', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          { unknownField: 'value' },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects empty update payload', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          {},
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects oversized name', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          { name: 'A'.repeat(101) },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects script tags and injection in name', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          { name: '<script>alert(1)</script>' },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects malformed phone number', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          { phone: '123' },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects malformed country code', async () => {
      await expect(
        adminProfileService.updateProfile(
          MOCK_ADMIN_USER.id,
          { country_code: 'INVALID' },
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('4. getActiveSessions & revokeSession', () => {
    it('returns active sessions without leaking session tokens', async () => {
      const mockSessions = [
        {
          id: 'sess-1',
          session_token: 'hash-token-1',
          ip_address: '1.2.3.4',
          user_agent: 'Chrome',
          created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-02T00:00:00.000Z',
          last_active_at: '2026-01-01T01:00:00.000Z',
        },
        {
          id: 'sess-2',
          session_token: 'hash-token-2',
          ip_address: '5.6.7.8',
          user_agent: 'Safari',
          created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-02T00:00:00.000Z',
          last_active_at: '2026-01-01T01:00:00.000Z',
        },
      ];
      jest.spyOn(adminSessionRepository, 'findActiveSessionsByUserId').mockResolvedValue(mockSessions);

      const sessions = await adminProfileService.getActiveSessions(MOCK_ADMIN_USER.id, 'hash-token-1');

      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('sess-1');
      expect(sessions[0].is_current).toBe(true);
      expect(sessions[1].is_current).toBe(false);

      // Verify session tokens are strictly excluded
      expect(sessions[0]).not.toHaveProperty('session_token');
      expect(sessions[1]).not.toHaveProperty('session_token');
    });

    it('revokes an owned session successfully and audits the event', async () => {
      jest.spyOn(adminSessionRepository, 'findSessionByIdForUser').mockResolvedValue({
        id: 'sess-target',
        user_id: MOCK_ADMIN_USER.id,
        is_active: true,
        session_token: 'hash-target',
      });
      jest.spyOn(adminSessionRepository, 'revokeSessionByIdForUser').mockResolvedValue(true);

      const res = await adminProfileService.revokeSession(
        MOCK_ADMIN_USER.id,
        'sess-target',
        { actor: MOCK_ADMIN_USER, currentSessionTokenHash: 'hash-current' },
      );

      expect(res.revoked).toBe(true);
      expect(res.sessionId).toBe('sess-target');
      expect(res.isCurrentSession).toBe(false);

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        action: 'ADMIN_SESSION_REVOKED',
        actorId: MOCK_ADMIN_USER.id,
        targetResource: 'ADMIN_SESSION',
        targetResourceId: 'sess-target',
      });
    });

    it('prevents BOLA: returns 404 when attempting to revoke another user session', async () => {
      jest.spyOn(adminSessionRepository, 'findSessionByIdForUser').mockResolvedValue(null);

      await expect(
        adminProfileService.revokeSession(
          MOCK_ADMIN_USER.id,
          'sess-belonging-to-other-admin',
          { actor: MOCK_ADMIN_USER },
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
