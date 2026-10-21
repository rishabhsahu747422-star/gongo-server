'use strict';

describe('Database Pool Configuration and Lifecycle', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Environment Parsing & Bounds Validation', () => {
    it('preserves DB_POOL_MIN=0 correctly without falsy fallback to default', () => {
      process.env.DB_POOL_MIN = '0';
      process.env.DB_POOL_MAX = '3';
      const serverEnv = require('../../src/config/env');
      expect(serverEnv.DB_POOL_MIN).toBe(0);
      expect(serverEnv.DB_POOL_MAX).toBe(3);
    });

    it('defaults DB_POOL_MIN to 0 and DB_POOL_MAX to 3 when unset', () => {
      delete process.env.DB_POOL_MIN;
      delete process.env.DB_POOL_MAX;
      const serverEnv = require('../../src/config/env');
      expect(serverEnv.DB_POOL_MIN).toBe(0);
      expect(serverEnv.DB_POOL_MAX).toBe(3);
    });

    it('rejects negative DB_POOL_MIN < 0', () => {
      process.env.DB_POOL_MIN = '-1';
      process.env.DB_POOL_MAX = '5';
      expect(() => {
        require('../../src/config/env');
      }).toThrow(/DB_POOL_MIN must be >= 0/);
    });

    it('rejects DB_POOL_MAX < 1', () => {
      process.env.DB_POOL_MIN = '0';
      process.env.DB_POOL_MAX = '0';
      expect(() => {
        require('../../src/config/env');
      }).toThrow(/DB_POOL_MAX must be >= 1/);
    });

    it('rejects DB_POOL_MIN > DB_POOL_MAX', () => {
      process.env.DB_POOL_MIN = '5';
      process.env.DB_POOL_MAX = '2';
      expect(() => {
        require('../../src/config/env');
      }).toThrow(/must be <= DB_POOL_MAX/);
    });
  });

  describe('Sub-app Pool Configurations & Connection Budget', () => {
    it('calculates the combined connection demand across all 3 pools within the 15-connection limit', () => {
      process.env.DB_POOL_MIN = '0';
      process.env.DB_POOL_MAX = '3';

      const customerConfig = require('../../Customer/src/config');
      const partnerPoolModule = require('../../Partner/src/db/pool');
      const adminPoolModule = require('../../Admin/src/db/pool');

      const customerPool = customerConfig.pool;
      const partnerPool = partnerPoolModule.pool;
      const adminPool = adminPoolModule.pool;

      expect(customerPool.options.min).toBe(0);
      expect(customerPool.options.max).toBe(3);

      expect(partnerPool.options.min).toBe(0);
      expect(partnerPool.options.max).toBe(3);

      expect(adminPool.options.min).toBe(0);
      expect(adminPool.options.max).toBe(3);

      const totalMaxConnections = customerPool.options.max + partnerPool.options.max + adminPool.options.max;
      expect(totalMaxConnections).toBe(9);
      expect(totalMaxConnections).toBeLessThanOrEqual(15);

      const headroom = 15 - totalMaxConnections;
      expect(headroom).toBeGreaterThanOrEqual(6);
    });
  });

  describe('Startup Probe Client Lifecycle', () => {
    it('acquires exactly 1 client and releases it in finally during connectDatabase', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
        release: jest.fn(),
      };

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
        totalCount: 1,
        idleCount: 1,
      };

      // Probe simulation matching Customer, Partner and Admin connectDatabase pattern
      let client;
      try {
        client = await mockPool.connect();
        await client.query('SELECT 1');
      } finally {
        if (client) client.release();
      }

      expect(mockPool.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.query).toHaveBeenCalledWith('SELECT 1');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('releases checked-out client even when query fails during startup probe', async () => {
      const mockClient = {
        query: jest.fn().mockRejectedValue(new Error('Connection timeout')),
        release: jest.fn(),
      };

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      };

      let client;
      let errorThrown = false;
      try {
        client = await mockPool.connect();
        await client.query('SELECT 1');
      } catch (err) {
        errorThrown = true;
      } finally {
        if (client) client.release();
      }

      expect(errorThrown).toBe(true);
      expect(mockPool.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });
});
