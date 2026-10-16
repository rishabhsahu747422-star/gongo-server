'use strict';

const poolModule = require('../../src/db/pool');

describe('Unit: Admin PostgreSQL Connection Pool & Lifecycle', () => {
  let mockClient;
  let mockPool;

  beforeEach(() => {
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 }),
      release: jest.fn(),
      on: jest.fn(),
    };

    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }),
      end: jest.fn().mockResolvedValue(),
      totalCount: 5,
      idleCount: 2,
      waitingCount: 0,
      on: jest.fn(),
    };

    poolModule.setMockPool(mockPool);
  });

  afterEach(() => {
    poolModule.resetMockPool();
    jest.clearAllMocks();
  });

  describe('query() lifecycle', () => {
    it('acquires a client, executes query, and guarantees release() on success', async () => {
      const res = await poolModule.query('SELECT 1');

      expect(mockPool.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.query).toHaveBeenCalledWith('SELECT 1', []);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
      expect(res.rows[0].id).toBe(1);
    });

    it('guarantees client.release() in finally block when query throws', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('Syntax error'));

      await expect(poolModule.query('INVALID SQL')).rejects.toThrow('Syntax error');
      expect(mockPool.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('retries on transient connection termination error and releases both clients', async () => {
      const client1 = {
        query: jest.fn().mockRejectedValueOnce(new Error('Connection terminated unexpectedly')),
        release: jest.fn(),
        on: jest.fn(),
      };
      const client2 = {
        query: jest.fn().mockResolvedValueOnce({ rows: [{ ok: true }], rowCount: 1 }),
        release: jest.fn(),
        on: jest.fn(),
      };

      mockPool.connect
        .mockResolvedValueOnce(client1)
        .mockResolvedValueOnce(client2);

      const res = await poolModule.query('SELECT * FROM admin_sessions WHERE id = $1', ['abc']);

      expect(mockPool.connect).toHaveBeenCalledTimes(2);
      expect(client1.release).toHaveBeenCalledTimes(1);
      expect(client2.release).toHaveBeenCalledTimes(1);
      expect(res.rows[0].ok).toBe(true);
    });
  });

  describe('transaction() lifecycle', () => {
    it('executes BEGIN, runs callback, commits, and releases client on success', async () => {
      const origSpy = mockClient.query;
      const result = await poolModule.transaction(async (client) => {
        const r = await client.query('INSERT INTO audit_logs VALUES (1)');
        return r.rowCount;
      });

      expect(mockPool.connect).toHaveBeenCalledTimes(1);
      expect(origSpy).toHaveBeenCalledWith('BEGIN', undefined);
      expect(origSpy).toHaveBeenCalledWith('INSERT INTO audit_logs VALUES (1)', undefined);
      expect(origSpy).toHaveBeenCalledWith('COMMIT', undefined);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
      expect(result).toBe(1);
    });

    it('executes ROLLBACK and releases client when transaction callback throws', async () => {
      const origSpy = mockClient.query;
      await expect(
        poolModule.transaction(async (client) => {
          await client.query('UPDATE accounts SET balance = balance - 100');
          throw new Error('Business constraint violation');
        })
      ).rejects.toThrow('Business constraint violation');

      expect(mockPool.connect).toHaveBeenCalledTimes(1);
      expect(origSpy).toHaveBeenCalledWith('BEGIN', undefined);
      expect(origSpy).toHaveBeenCalledWith('ROLLBACK', undefined);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkDbHealth() probe', () => {
    it('returns UP status with measured latency on healthy ping', async () => {
      const health = await poolModule.checkDbHealth();

      expect(health.status).toBe('UP');
      expect(typeof health.latencyMs).toBe('number');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('returns DOWN status and releases client when connection fails', async () => {
      mockPool.connect.mockRejectedValueOnce(new Error('Connection timeout'));

      const health = await poolModule.checkDbHealth();

      expect(health.status).toBe('DOWN');
      expect(health.error).toBe('Database unreachable');
    });
  });

  describe('concurrent requests isolation', () => {
    it('handles multiple concurrent queries without cross-client leaks', async () => {
      const clients = Array.from({ length: 5 }, (_, i) => ({
        query: jest.fn().mockResolvedValue({ rows: [{ n: i }], rowCount: 1 }),
        release: jest.fn(),
        on: jest.fn(),
      }));

      let idx = 0;
      mockPool.connect.mockImplementation(async () => clients[idx++]);

      const results = await Promise.all([
        poolModule.query('SELECT 0'),
        poolModule.query('SELECT 1'),
        poolModule.query('SELECT 2'),
        poolModule.query('SELECT 3'),
        poolModule.query('SELECT 4'),
      ]);

      expect(results).toHaveLength(5);
      expect(mockPool.connect).toHaveBeenCalledTimes(5);
      clients.forEach((c) => {
        expect(c.release).toHaveBeenCalledTimes(1);
      });
    });
  });
});
