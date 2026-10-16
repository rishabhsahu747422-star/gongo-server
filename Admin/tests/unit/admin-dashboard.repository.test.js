'use strict';

const adminDashboardRepository = require('../../src/repositories/admin-dashboard.repository');

describe('Unit: AdminDashboardRepository & SQL Safety', () => {
  let mockClient;
  let executedQueries;

  beforeEach(() => {
    adminDashboardRepository.constructor.resetMockDashboardResolver();
    executedQueries = [];
    mockClient = {
      query: jest.fn(async (text, values) => {
        executedQueries.push({ text, values });
        return {
          rows: [
            {
              total: 10,
              active: 8,
              new_in_range: 2,
              online: 5,
              offline: 3,
              verified: 7,
              pending_kyc: 2,
              idle: 4,
              booked: 4,
              upcoming: 1,
              completed: 8,
              cancelled: 1,
              in_range: 5,
              total_payments: 10,
              success_payments: 9,
              gross_volume: '15000',
              pending_volume: '1000',
              total_commission: '1500',
              settled_commission: '1200',
              completed_payouts: '8000',
              pending_payouts: '1000',
              open_tickets: 2,
              resolved_tickets: 8,
            },
          ],
          rowCount: 1,
        };
      }),
    };
  });

  afterEach(() => {
    adminDashboardRepository.constructor.resetMockDashboardResolver();
  });

  it('getOverviewStats uses parameterized queries when date range provided', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-10T00:00:00.000Z');

    const result = await adminDashboardRepository.getOverviewStats(start, end, mockClient);

    expect(mockClient.query).toHaveBeenCalled();
    // Verify parameterized queries received start and end
    const customerCall = executedQueries.find((q) => q.text.includes('role = \'CUSTOMER\''));
    expect(customerCall.values).toEqual([start, end]);
    expect(customerCall.text).toContain('$1');
    expect(customerCall.text).toContain('$2');

    expect(result.customers.total).toBe(10);
    expect(result.financial.grossVolume).toBe(15000);
    expect(result.financial.completedPayouts).toBe(8000);
  });

  it('getOverviewStats uses default database date ranges when no dates passed', async () => {
    const result = await adminDashboardRepository.getOverviewStats(null, null, mockClient);

    const customerCall = executedQueries.find((q) => q.text.includes('role = \'CUSTOMER\''));
    expect(customerCall.values).toEqual([]);
    expect(customerCall.text).toContain('INTERVAL \'30 days\'');
    expect(result.customers.total).toBe(10);
  });

  it('getRevenueMetrics runs parameterized aggregation and trends', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-10T00:00:00.000Z');

    mockClient.query = jest.fn(async (text, values) => {
      executedQueries.push({ text, values });
      if (text.includes('TO_CHAR')) {
        return {
          rows: [
            { date: '2026-09-05', total_payments: 5, successful_payments: 5, gross_amount: '7500' },
          ],
        };
      }
      return {
        rows: [{
          total_payments: 10,
          success_payments: 9,
          pending_payments: 1,
          failed_payments: 0,
          cancelled_payments: 0,
          gross_volume: '15000',
          pending_volume: '1000',
          total_commission: '1500',
          settled_commission: '1200',
          completed_payouts: '8000',
          pending_payouts: '1000',
        }],
      };
    });

    const res = await adminDashboardRepository.getRevenueMetrics(start, end, mockClient);

    const allMatch = executedQueries.every(
      (q) => q.values.length === 2 && q.values[0] === start && q.values[1] === end,
    );
    expect(allMatch).toBe(true);
    expect(res.summary.grossVolume).toBe(15000);
    expect(res.trends).toHaveLength(1);
    expect(res.trends[0].grossAmount).toBe(7500);
  });

  it('getBookingMetrics computes completion rate and groups trends', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-10T00:00:00.000Z');

    mockClient.query = jest.fn(async (text, values) => {
      executedQueries.push({ text, values });
      if (text.includes('TO_CHAR')) {
        return {
          rows: [{ date: '2026-09-05', total: 10, completed: 8, cancelled: 1 }],
        };
      }
      return {
        rows: [{
          total: 20,
          upcoming: 2,
          active: 3,
          completed: 14,
          cancelled: 1,
        }],
      };
    });

    const res = await adminDashboardRepository.getBookingMetrics(start, end, mockClient);

    expect(res.summary.total).toBe(20);
    expect(res.summary.completed).toBe(14);
    expect(res.summary.completionRate).toBe(70.0);
    expect(res.trends).toHaveLength(1);
  });

  it('getRecentActivity enforces bounded LIMIT and OFFSET parameterized values', async () => {
    mockClient.query = jest.fn(async (text, values) => {
      executedQueries.push({ text, values });
      return {
        rows: [
          {
            id: 'act-1',
            actor_id: 'usr-1',
            actor_role: 'ADMIN',
            permission: 'kyc.verify',
            action: 'APPROVE',
            target_resource: 'partners',
            target_resource_id: 'p-1',
            request_id: 'req-1',
            created_at: '2026-09-25T12:00:00.000Z',
          },
        ],
      };
    });

    const res = await adminDashboardRepository.getRecentActivity(100, 10, mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $1 OFFSET $2'),
      [50, 10], // Clamped to 50
    );
    expect(res).toHaveLength(1);
    expect(res[0].actorRole).toBe('ADMIN');
    expect(res[0].action).toBe('APPROVE');
  });

  it('getCategoryDistribution maps canonical categories including EVs and preserves colorMap', async () => {
    mockClient.query = jest.fn(async () => ({
      rows: [
        { name: 'Bikes', count: 18 },
        { name: 'Cars', count: 10 },
        { name: 'EVs', count: 6 },
      ],
      rowCount: 3,
    }));

    const res = await adminDashboardRepository.getCategoryDistribution(mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('LOWER(COALESCE(v.fuel_type, \'\')) IN (\'ev\', \'electric\')'),
      undefined,
    );
    expect(res).toEqual([
      { name: 'Bikes', value: 18, count: 18, color: '#FF6B00' },
      { name: 'Cars', value: 10, count: 10, color: '#3B82F6' },
      { name: 'EVs', value: 6, count: 6, color: '#10B981' },
      { name: 'Scooties', value: 0, count: 0, color: '#F59E0B' },
    ]);
  });

  it('getCategoryDistribution returns fallback canonical categories on query error', async () => {
    mockClient.query = jest.fn(async () => {
      throw new Error('DB connection failure');
    });

    const res = await adminDashboardRepository.getCategoryDistribution(mockClient);

    expect(res).toEqual([
      { name: 'Bikes', value: 24, count: 24, color: '#FF6B00' },
      { name: 'Cars', value: 38, count: 38, color: '#3B82F6' },
      { name: 'EVs', value: 0, count: 0, color: '#10B981' },
      { name: 'Scooties', value: 1, count: 1, color: '#F59E0B' },
    ]);
  });

  it('supports mock resolver injection for isolated testing', async () => {
    const mockResolver = {
      getOverviewStats: jest.fn().mockResolvedValue({ mocked: true }),
    };

    adminDashboardRepository.constructor.setMockDashboardResolver(mockResolver);

    const res = await adminDashboardRepository.getOverviewStats();
    expect(res).toEqual({ mocked: true });
    expect(mockResolver.getOverviewStats).toHaveBeenCalled();
  });
});
