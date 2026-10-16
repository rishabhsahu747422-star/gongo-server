'use strict';

const adminActionRepository = require('../../src/repositories/admin-action.repository');
const adminPermissionRepository = require('../../src/repositories/admin-permission.repository');
const adminSettingRepository = require('../../src/repositories/admin-setting.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');

describe('Unit: Admin Repositories & Parameterized Queries', () => {
  let mockClient;
  let executedQueries;

  beforeEach(() => {
    executedQueries = [];
    mockClient = {
      query: jest.fn(async (text, values) => {
        executedQueries.push({ text, values });
        return {
          rows: [{ id: 'mock-id-123' }],
          rowCount: 1,
        };
      }),
    };
  });

  describe('1. AdminActionRepository', () => {
    it('creates an admin action using parameterized SQL (values array passed to pg client)', async () => {
      const payload = {
        actorId: 'usr-123',
        actorRole: 'ADMIN',
        permission: 'SUPER_ADMIN',
        action: 'APPROVE_KYC',
        targetResource: 'PARTNER',
        targetResourceId: 'partner-999',
        requestId: 'req-uuid-1',
        ipAddress: '127.0.0.1',
        userAgent: 'Jest/Test',
        beforeState: { status: 'PENDING' },
        afterState: { status: 'VERIFIED' },
        metadata: { notes: 'Approved via test' },
      };

      await adminActionRepository.createAction(payload, mockClient);

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const call = mockClient.query.mock.calls[0];
      const [sql, values] = call;

      expect(sql).toContain('INSERT INTO admin_actions');
      expect(sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)');
      expect(values).toHaveLength(12);
      expect(values[0]).toBe('usr-123');
      expect(values[3]).toBe('APPROVE_KYC');
      expect(values[4]).toBe('PARTNER');
      expect(values[5]).toBe('partner-999');
    });

    it('retrieves actions with parameterized filtering preventing SQL injection', async () => {
      const maliciousInput = "' OR 1=1 --";
      await adminActionRepository.findWithFilters({
        actorId: maliciousInput,
        action: 'RESOLVE_DISPUTE',
        limit: 10,
        offset: 5,
      }, mockClient);

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, values] = mockClient.query.mock.calls[0];

      expect(sql).toContain('WHERE actor_id = $1 AND action = $2');
      expect(sql).toContain('LIMIT $3 OFFSET $4');
      // Values are passed as parameters, NOT interpolated into SQL string
      expect(values[0]).toBe(maliciousInput);
      expect(values[1]).toBe('RESOLVE_DISPUTE');
      expect(values[2]).toBe(10);
      expect(values[3]).toBe(5);
    });
  });

  describe('2. AdminPermissionRepository', () => {
    it('finds permissions by user id using parameterized query', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ permission: 'SUPER_ADMIN' }, { permission: 'FINANCE_ADMIN' }],
        rowCount: 2,
      });

      const perms = await adminPermissionRepository.findPermissionsByUserId('usr-456', mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE user_id = $1'),
        ['usr-456'],
      );
      expect(perms).toEqual(['SUPER_ADMIN', 'FINANCE_ADMIN']);
    });

    it('assigns permission using parameterized query with conflict guard', async () => {
      await adminPermissionRepository.assignPermission('usr-456', 'OPERATIONS_ADMIN', 'admin-001', mockClient);

      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO admin_permissions (user_id, permission, assigned_by)');
      expect(sql).toContain('VALUES ($1, $2, $3)');
      expect(sql).toContain('ON CONFLICT (user_id, permission) DO NOTHING');
      expect(values).toEqual(['usr-456', 'OPERATIONS_ADMIN', 'admin-001']);
    });

    it('revokes permission using parameterized query', async () => {
      await adminPermissionRepository.revokePermission('usr-456', 'OPERATIONS_ADMIN', mockClient);

      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('DELETE FROM admin_permissions');
      expect(sql).toContain('WHERE user_id = $1 AND permission = $2');
      expect(values).toEqual(['usr-456', 'OPERATIONS_ADMIN']);
    });
  });

  describe('3. AdminSettingRepository', () => {
    it('finds setting by key using parameterized query', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ key: 'platform_fee', value: { rate: 0.05 } }],
        rowCount: 1,
      });

      const setting = await adminSettingRepository.findByKey('platform_fee', mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE key = $1'),
        ['platform_fee'],
      );
      expect(setting.key).toBe('platform_fee');
    });

    it('upserts setting using parameterized query with EXCLUDED semantics', async () => {
      await adminSettingRepository.upsertSetting({
        category: 'commission',
        key: 'standard_commission',
        value: { rate: 10 },
        description: 'Standard 10% rate',
        updatedBy: 'usr-admin-1',
      }, mockClient);

      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO admin_settings (category, key, value, description, updated_by)');
      expect(sql).toContain('ON CONFLICT (key) DO UPDATE');
      expect(values).toEqual([
        'commission',
        'standard_commission',
        JSON.stringify({ rate: 10 }),
        'Standard 10% rate',
        'usr-admin-1',
      ]);
    });
  });

  describe('4. AdminSessionRepository', () => {
    it('creates session using parameterized query', async () => {
      const expires = new Date();
      await adminSessionRepository.createSession({
        userId: 'usr-1',
        sessionToken: 'tok-abc-123',
        expiresAt: expires,
        ipAddress: '10.0.0.1',
        userAgent: 'Mozilla',
      }, mockClient);

      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO admin_sessions');
      expect(values).toEqual(['usr-1', 'tok-abc-123', expires, '10.0.0.1', 'Mozilla']);
    });

    it('revokes session using parameterized query', async () => {
      await adminSessionRepository.revokeSession('tok-abc-123', mockClient);

      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('UPDATE admin_sessions');
      expect(sql).toContain('WHERE session_token = $1');
      expect(values).toEqual(['tok-abc-123']);
    });

    it('finds session by token hash using parameterized query', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: 'sess-1', session_token: 'hash-1' }],
        rowCount: 1,
      });

      const res = await adminSessionRepository.findByToken('hash-1', mockClient);

      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('WHERE session_token = $1');
      expect(values).toEqual(['hash-1']);
      expect(res.id).toBe('sess-1');
    });

    it('revokes all sessions for a user using parameterized query', async () => {
      mockClient.query.mockResolvedValueOnce({ rowCount: 4 });

      const count = await adminSessionRepository.revokeAllUserSessions('usr-test-123', mockClient);

      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('UPDATE admin_sessions');
      expect(sql).toContain('WHERE user_id = $1 AND is_active = true');
      expect(values).toEqual(['usr-test-123']);
      expect(count).toBe(4);
    });

    it('counts active sessions for a user using parameterized query', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [{ count: 3 }] });

      const count = await adminSessionRepository.countActiveSessionsByUserId('usr-test-123', mockClient);

      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('WHERE user_id = $1 AND is_active = true AND expires_at > CURRENT_TIMESTAMP');
      expect(values).toEqual(['usr-test-123']);
      expect(count).toBe(3);
    });

    it('revokes oldest sessions beyond keepCount using parameterized query', async () => {
      mockClient.query.mockResolvedValueOnce({ rowCount: 2 });

      const count = await adminSessionRepository.revokeOldestSessions('usr-test-123', 4, mockClient);

      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('WHERE user_id = $1 AND is_active = true AND expires_at > CURRENT_TIMESTAMP');
      expect(sql).toContain('OFFSET $2');
      expect(values).toEqual(['usr-test-123', 4]);
      expect(count).toBe(2);
    });

    it('executes cleanup of expired sessions with cutoff date using parameterized query', async () => {
      const cutoff = new Date('2026-01-01');
      mockClient.query.mockResolvedValueOnce({ rowCount: 10 });

      const count = await adminSessionRepository.cleanupExpiredSessions(cutoff, mockClient);

      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('DELETE FROM admin_sessions');
      expect(sql).toContain('updated_at < $1');
      expect(values).toEqual([cutoff]);
      expect(count).toBe(10);
    });
  });
});
