'use strict';

const adminActionRepository = require('../../src/repositories/admin-action.repository');

const { SECURITY_CATEGORIES } = adminActionRepository;

const TEST_ADMIN_ID = 'a0000001-0000-4000-a000-000000000001';
const TEST_ACTION_ID = 'da000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'b0000001-0000-4000-a000-000000000001';

describe('Unit: AdminActionRepository', () => {
  let mockQuery;

  beforeEach(() => {
    mockQuery = jest.fn();
    adminActionRepository.query = mockQuery;
    adminActionRepository.constructor.resetMockActionResolver();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    adminActionRepository.constructor.resetMockActionResolver();
  });

  describe('1. createAction', () => {
    it('executes parameterized INSERT with all 12 fields and redacts metadata', async () => {
      const payload = {
        actorId: TEST_ADMIN_ID,
        actorRole: 'ADMIN',
        permission: 'audit.manage',
        action: 'UPDATE_SETTING',
        targetResource: 'SETTING',
        targetResourceId: 'setting-1',
        requestId: 'req-001',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        beforeState: { passwordHash: 'secret_hash_before', val: 1 },
        afterState: { passwordHash: 'secret_hash_after', val: 2 },
        metadata: { token: 'raw-token-123', safeInfo: 'kept' },
      };

      mockQuery.mockResolvedValueOnce({
        rows: [{ id: TEST_ACTION_ID, action: 'UPDATE_SETTING' }],
      });

      const result = await adminActionRepository.createAction(payload);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, values] = mockQuery.mock.calls[0];

      expect(sql).toContain('INSERT INTO admin_actions');
      expect(sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)');
      expect(values).toHaveLength(12);
      expect(values[0]).toBe(TEST_ADMIN_ID);
      expect(values[3]).toBe('UPDATE_SETTING');
      expect(values[4]).toBe('SETTING');
      expect(values[5]).toBe('setting-1');
      // Redaction check: passwordHash and token must be [REDACTED]
      const beforeStateSaved = JSON.parse(values[9]);
      const afterStateSaved = JSON.parse(values[10]);
      const metadataSaved = JSON.parse(values[11]);
      expect(beforeStateSaved.passwordHash).toBe('[REDACTED]');
      expect(beforeStateSaved.val).toBe(1);
      expect(afterStateSaved.passwordHash).toBe('[REDACTED]');
      expect(metadataSaved.token).toBe('[REDACTED]');
      expect(metadataSaved.safeInfo).toBe('kept');

      expect(result).toBeDefined();
      expect(result.id).toBe(TEST_ACTION_ID);
    });

    it('uses provided client if passed in for transaction consistency', async () => {
      const mockClient = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'act-txn-1' }] }) };
      const payload = {
        actorId: TEST_ADMIN_ID,
        actorRole: 'ADMIN',
        action: 'APPROVE_KYC',
      };

      await adminActionRepository.createAction(payload, mockClient);

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('2. listAuditActions', () => {
    it('executes parameterized count and select queries with pagination defaults', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '2' }] }) // Count query
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_ACTION_ID,
              actor_id: TEST_ADMIN_ID,
              actor_role: 'ADMIN',
              action: 'ADMIN_LOGIN',
              target_resource: 'ADMIN_SESSION',
              target_resource_id: 'sess-1',
              request_id: 'req-001',
              ip_address: '10.0.0.1',
              user_agent: 'Chrome',
              before_state: null,
              after_state: null,
              metadata: { note: 'login success' },
              created_at: new Date('2026-09-01T12:00:00Z'),
              actor_name: 'Admin User',
              actor_email: 'admin@gongo.in',
            },
          ],
        });

      const result = await adminActionRepository.listAuditActions({ page: 1, limit: 10 });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result.pagination.total).toBe(2);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.totalPages).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(TEST_ACTION_ID);
      expect(result.items[0].actorName).toBe('Admin User');
      expect(result.items[0].actorEmail).toBe('admin@gongo.in');
    });

    it('applies filters: actorId, action, targetResource, targetResourceId, requestId, ipAddress', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [] });

      await adminActionRepository.listAuditActions({
        actorId: TEST_ADMIN_ID,
        action: 'CANCEL_BOOKING',
        targetResource: 'BOOKING',
        targetResourceId: TEST_BOOKING_ID,
        requestId: 'req-xyz',
        ipAddress: '192.168.1.100',
      });

      const countSql = mockQuery.mock.calls[0][0];
      const countValues = mockQuery.mock.calls[0][1];

      expect(countSql).toContain('a.actor_id = $1');
      expect(countSql).toContain('a.action = $2');
      expect(countSql).toContain('a.target_resource = $3');
      expect(countSql).toContain('a.target_resource_id = $4');
      expect(countSql).toContain('a.request_id = $5');
      expect(countSql).toContain('a.ip_address = $6');

      expect(countValues[0]).toBe(TEST_ADMIN_ID);
      expect(countValues[1]).toBe('CANCEL_BOOKING');
      expect(countValues[2]).toBe('BOOKING');
      expect(countValues[3]).toBe(TEST_BOOKING_ID);
      expect(countValues[4]).toBe('req-xyz');
      expect(countValues[5]).toBe('192.168.1.100');
    });

    it('applies date range bounds (fromDate, toDate)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await adminActionRepository.listAuditActions({
        fromDate: '2026-09-01T00:00:00.000Z',
        toDate: '2026-09-10T23:59:59.999Z',
      });

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('a.created_at >= $1');
      expect(sql).toContain('a.created_at <= $2');
      expect(values[0]).toBe('2026-09-01T00:00:00.000Z');
      expect(values[1]).toBe('2026-09-10T23:59:59.999Z');
    });

    it('filters by category using SECURITY_CATEGORIES mapping', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '5' }] })
        .mockResolvedValueOnce({ rows: [] });

      await adminActionRepository.listAuditActions({
        category: 'AUTHENTICATION',
      });

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('a.action = ANY($1::text[])');
      expect(values[0]).toEqual(SECURITY_CATEGORIES.AUTHENTICATION);
    });

    it('applies search term matching actor name, email, action, resource, requestId', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [] });

      await adminActionRepository.listAuditActions({
        search: 'john%admin',
      });

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('ILIKE $1');
      // Escapes wildcard character %
      expect(values[0]).toBe('%john\\%admin%');
    });

    it('enforces allowlisted sorting columns and defaults safely when unknown', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [] });

      await adminActionRepository.listAuditActions({
        sortBy: 'malicious_column; DROP TABLE users;',
        sortOrder: 'asc',
      });

      const [, selectSql] = mockQuery.mock.calls.map((c) => c[0]);
      // Should fallback to default 'created_at' and safe 'ASC'
      expect(selectSql).toContain('ORDER BY a.created_at ASC');
      expect(selectSql).not.toContain('malicious_column');
    });
  });

  describe('3. findActionById', () => {
    it('returns sanitized action details with actor projection when found', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_ACTION_ID,
            actor_id: TEST_ADMIN_ID,
            actor_role: 'ADMIN',
            permission: 'audit.read',
            action: 'ADMIN_LOGIN',
            target_resource: 'ADMIN_SESSION',
            target_resource_id: 'sess-100',
            request_id: 'req-002',
            ip_address: '127.0.0.1',
            user_agent: 'TestAgent/1.0',
            before_state: null,
            after_state: null,
            metadata: { secretToken: 'should_be_redacted', safeKey: 123 },
            created_at: new Date('2026-09-02T10:00:00Z'),
            actor_name: 'Super Admin',
            actor_email: 'superadmin@gongo.in',
            actor_active: true,
          },
        ],
      });

      const action = await adminActionRepository.findActionById(TEST_ACTION_ID);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('WHERE a.id = $1');
      expect(values[0]).toBe(TEST_ACTION_ID);

      expect(action).toBeDefined();
      expect(action.id).toBe(TEST_ACTION_ID);
      expect(action.metadata.secretToken).toBe('[REDACTED]');
      expect(action.metadata.safeKey).toBe(123);
      expect(action.actorName).toBe('Super Admin');
      expect(action.category).toBe('AUTHENTICATION');
    });

    it('returns null when action is not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const action = await adminActionRepository.findActionById('nonexistent-id');
      expect(action).toBeNull();
    });
  });

  describe('4. findActionsByActor & findActionsByResource', () => {
    it('findActionsByActor delegates to listAuditActions with actorId filter', async () => {
      const spy = jest.spyOn(adminActionRepository, 'listAuditActions').mockResolvedValue({
        items: [],
        pagination: { total: 0, page: 1, limit: 20, totalPages: 0 },
      });

      await adminActionRepository.findActionsByActor(TEST_ADMIN_ID, { page: 2, limit: 15 });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: TEST_ADMIN_ID,
          page: 2,
          limit: 15,
        }),
        null,
      );
    });

    it('findActionsByResource delegates to listAuditActions with targetResource and targetResourceId', async () => {
      const spy = jest.spyOn(adminActionRepository, 'listAuditActions').mockResolvedValue({
        items: [],
        pagination: { total: 0, page: 1, limit: 20, totalPages: 0 },
      });

      await adminActionRepository.findActionsByResource('BOOKING', TEST_BOOKING_ID, { page: 1 });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          targetResource: 'BOOKING',
          targetResourceId: TEST_BOOKING_ID,
          page: 1,
        }),
        null,
      );
    });
  });

  describe('5. findSecurityEvents', () => {
    it('filters strictly by security categories or single category', async () => {
      const spy = jest.spyOn(adminActionRepository, 'listAuditActions').mockResolvedValue({
        items: [],
        pagination: { total: 0, page: 1, limit: 20, totalPages: 0 },
      });

      await adminActionRepository.findSecurityEvents({
        category: 'PERMISSION',
        page: 1,
        limit: 10,
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          actionList: SECURITY_CATEGORIES.PERMISSION,
          page: 1,
          limit: 10,
        }),
        null,
      );
    });

    it('defaults to all security actions if no specific category is given', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await adminActionRepository.findSecurityEvents({});

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('a.action = ANY($1::text[])');
      // Checks that values[0] contains auth, session, and permission actions
      expect(values[0]).toEqual(expect.arrayContaining(['ADMIN_LOGIN', 'REVOKE_SESSION', 'ASSIGN_ROLE']));
    });
  });

  describe('6. getSecuritySummary', () => {
    it('executes aggregation queries and returns category, action, and top actor metrics', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '42' }] }) // total
        .mockResolvedValueOnce({
          rows: [
            { action: 'ADMIN_LOGIN', count: '25' },
            { action: 'ASSIGN_PERMISSIONS', count: '10' },
          ],
        }) // action breakdown
        .mockResolvedValueOnce({
          rows: [
            { target_resource: 'ADMIN_SESSION', count: '25' },
          ],
        }) // resource breakdown
        .mockResolvedValueOnce({
          rows: [
            {
              actor_id: TEST_ADMIN_ID,
              actor_name: 'Super Admin',
              actor_email: 'admin@gongo.in',
              action_count: '35',
            },
          ],
        }); // top actors

      const summary = await adminActionRepository.getSecuritySummary({
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-02T23:59:59.999Z',
      });

      expect(mockQuery).toHaveBeenCalledTimes(4);
      expect(summary.totalEvents).toBe(42);
      expect(summary.categoryBreakdown.AUTHENTICATION).toBe(25);
      expect(summary.categoryBreakdown.PERMISSION).toBe(10);
      expect(summary.actionBreakdown).toHaveLength(2);
      expect(summary.topActors).toHaveLength(1);
      expect(summary.topActors[0].name).toBe('Super Admin');
    });
  });

  describe('7. getDistinctActionsAndResources', () => {
    it('returns sorted unique actions and target resources with category list', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ action: 'ADMIN_LOGIN' }, { action: 'APPROVE_KYC' }],
        })
        .mockResolvedValueOnce({
          rows: [{ target_resource: 'ADMIN_SESSION' }, { target_resource: 'PARTNER' }],
        });

      const catalog = await adminActionRepository.getDistinctActionsAndResources();

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(catalog.actions).toEqual(['ADMIN_LOGIN', 'APPROVE_KYC']);
      expect(catalog.resources).toEqual(['ADMIN_SESSION', 'PARTNER']);
      expect(catalog.categories).toBeDefined();
      expect(catalog.categories).toContain('AUTHENTICATION');
    });
  });

  describe('8. Immutability guarantees', () => {
    it('does not expose delete, update, or clear methods on repository', () => {
      expect(adminActionRepository.delete).toBeUndefined();
      expect(adminActionRepository.update).toBeUndefined();
      expect(adminActionRepository.deleteById).toBeUndefined();
      expect(adminActionRepository.truncate).toBeUndefined();
    });
  });
});
