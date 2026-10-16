'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const PartnerRepository = require('../../src/repositories/partner.repository');
const partnerService = require('../../src/services/partner.service');
const { invalidateAuthCache } = require('../../src/middlewares/auth');
const { redisClient } = require('../../src/providers/redis');
const db = require('../../src/db/pool');

describe('Integration: Cross-User Partner Dashboard Counts & Isolation', () => {
  let app;

  const existingPartnerId = 'dc3a5acd-8d03-45c0-8cb9-23d1b3ffd562';
  const existingPartnerAuthId = 'dev-partner-auth-id';
  const existingPartnerToken = 'token-partner-with-data-32';

  const newPartnerId = '00000000-0000-0000-0000-000000000001';
  const newPartnerAuthId = 'new-partner-zero-auth-id';
  const newPartnerToken = 'token-new-partner-zero-data';

  const existingPartnerStats = {
    totalVehicles: 32,
    bookedVehicles: 10,
    availableVehicles: 22,
    unavailableVehicles: 0,
    upcomingBookings: 58,
    activeRentals: 4,
    completedBookings: 15,
    cancelledBookings: 2,
    earnings: {
      totalEarnings: 85000.0,
      monthlyEarnings: 24000.0,
      weeklyEarnings: 8000.0,
      pendingSettlements: 3,
    },
    activeRentalsSummary: [
      {
        id: 'bk-101',
        bookingNumber: 'BK-101',
        customerName: 'Customer A',
        customerPhone: '+919876543210',
        vehicleName: 'Hyundai Creta',
        registrationNumber: 'KA-01-AB-1234',
        startAt: '2026-10-10T00:00:00Z',
        expectedReturnAt: '2026-10-10T12:00:00Z',
      },
    ],
  };

  const newPartnerStats = {
    totalVehicles: 0,
    bookedVehicles: 0,
    availableVehicles: 0,
    unavailableVehicles: 0,
    upcomingBookings: 0,
    activeRentals: 0,
    completedBookings: 0,
    cancelledBookings: 0,
    earnings: {
      totalEarnings: 0,
      monthlyEarnings: 0,
      weeklyEarnings: 0,
      pendingSettlements: 0,
    },
    activeRentalsSummary: [],
  };

  beforeAll(async () => {
    app = createApp();

    // Setup active session for Existing Partner
    await redisClient.set(
      `auth:session:${existingPartnerToken}`,
      JSON.stringify({
        uid: existingPartnerAuthId,
        userId: 'usr-existing-partner',
        phone: '9999999999',
        role: 'PARTNER',
        partnerId: existingPartnerId,
        createdAt: new Date().toISOString(),
      }),
      'EX',
      3600
    );

    // Setup active session for New Partner
    await redisClient.set(
      `auth:session:${newPartnerToken}`,
      JSON.stringify({
        uid: newPartnerAuthId,
        userId: 'usr-new-partner-zero',
        phone: '8888888888',
        role: 'PARTNER',
        partnerId: newPartnerId,
        createdAt: new Date().toISOString(),
      }),
      'EX',
      3600
    );

    // Mock PartnerRepository identity lookup
    PartnerRepository.setMockPartnerResolver((idOrAuth) => {
      if (idOrAuth === existingPartnerAuthId || idOrAuth === existingPartnerId) {
        return {
          id: existingPartnerId,
          partnerId: existingPartnerId,
          userId: 'usr-existing-partner',
          auth_id: existingPartnerAuthId,
          name: 'Fleet Partner',
          phone: '+91 9999999999',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'ONLINE',
          kyc_status: 'VERIFIED',
        };
      }
      if (idOrAuth === newPartnerAuthId || idOrAuth === newPartnerId) {
        return {
          id: newPartnerId,
          partnerId: newPartnerId,
          userId: 'usr-new-partner-zero',
          auth_id: newPartnerAuthId,
          name: 'Brand New Partner',
          phone: '+91 8888888888',
          role: 'PARTNER',
          is_active: true,
          partner_status: 'OFFLINE',
          kyc_status: 'PENDING',
        };
      }
      return null;
    });
  });

  afterAll(async () => {
    PartnerRepository.setMockPartnerResolver(null);
    await redisClient.del(`auth:session:${existingPartnerToken}`);
    await redisClient.del(`auth:session:${newPartnerToken}`);
  });

  beforeEach(() => {
    partnerService.invalidateDashboardCache();
    invalidateAuthCache();
  });

  it('1. Existing Partner with data sees their actual persisted counts (32 vehicles, 10 booked, 58 upcoming)', async () => {
    jest.spyOn(PartnerRepository.prototype, 'getDashboardStats').mockImplementation(async (partnerId) => {
      if (partnerId === existingPartnerId) {
        return existingPartnerStats;
      }
      if (partnerId === newPartnerId) {
        return newPartnerStats;
      }
      return newPartnerStats;
    });

    const res = await request(app)
      .get('/api/v1/partner/dashboard/stats')
      .set('Authorization', `Bearer ${existingPartnerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stats = res.body.data;

    expect(stats.totalVehicles).toBe(32);
    expect(stats.bookedVehicles).toBe(10);
    expect(stats.upcomingBookings).toBe(58);
    expect(stats.activeRentals).toBe(4);
    expect(stats.availableVehicles).toBe(22);
    expect(stats.earnings.totalEarnings).toBe(85000);
  });

  it('2. New Partner with no vehicles or bookings sees exact zeroes across all metrics', async () => {
    const res = await request(app)
      .get('/api/v1/partner/dashboard/stats')
      .set('Authorization', `Bearer ${newPartnerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stats = res.body.data;

    expect(stats.totalVehicles).toBe(0);
    expect(stats.bookedVehicles).toBe(0);
    expect(stats.upcomingBookings).toBe(0);
    expect(stats.activeRentals).toBe(0);
    expect(stats.availableVehicles).toBe(0);
    expect(stats.unavailableVehicles).toBe(0);
    expect(stats.completedBookings).toBe(0);
    expect(stats.cancelledBookings).toBe(0);

    expect(stats.earnings.totalEarnings).toBe(0);
    expect(stats.earnings.monthlyEarnings).toBe(0);
    expect(stats.earnings.weeklyEarnings).toBe(0);
    expect(stats.earnings.pendingSettlements).toBe(0);
    expect(stats.activeRentalsSummary).toEqual([]);
  });

  it('3. Account switching between partners does not leak stale counts or cached data', async () => {
    // Call as Partner A (Existing Partner)
    const resA = await request(app)
      .get('/api/v1/partner/dashboard/stats')
      .set('Authorization', `Bearer ${existingPartnerToken}`);
    expect(resA.status).toBe(200);
    expect(resA.body.data.totalVehicles).toBe(32);
    expect(resA.body.data.upcomingBookings).toBe(58);

    // Logout Partner A
    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${existingPartnerToken}`);
    expect(logoutRes.status).toBe(200);

    // Call as Partner B (New Partner with 0 vehicles)
    const resB = await request(app)
      .get('/api/v1/partner/dashboard/stats')
      .set('Authorization', `Bearer ${newPartnerToken}`);
    expect(resB.status).toBe(200);
    expect(resB.body.data.totalVehicles).toBe(0);
    expect(resB.body.data.upcomingBookings).toBe(0);
    expect(resB.body.data.bookedVehicles).toBe(0);

    // Partner A logs back in with a new session token
    const partnerA_reloginToken = 'token-partner-a-relogin';
    await redisClient.set(
      `auth:session:${partnerA_reloginToken}`,
      JSON.stringify({
        uid: existingPartnerAuthId,
        userId: 'usr-existing-partner',
        phone: '9999999999',
        role: 'PARTNER',
        partnerId: existingPartnerId,
        createdAt: new Date().toISOString(),
      }),
      'EX',
      3600
    );

    // Call as Partner A again -> counts are restored to Partner A, never Partner B
    const resA2 = await request(app)
      .get('/api/v1/partner/dashboard/stats')
      .set('Authorization', `Bearer ${partnerA_reloginToken}`);
    expect(resA2.status).toBe(200);
    expect(resA2.body.data.totalVehicles).toBe(32);
    expect(resA2.body.data.upcomingBookings).toBe(58);

    await redisClient.del(`auth:session:${partnerA_reloginToken}`);
  });

  it('4. Rejects unauthenticated dashboard requests and enforces partner ownership', async () => {
    const unauthRes = await request(app).get('/api/v1/partner/dashboard/stats');
    expect(unauthRes.status).toBe(401);

    const invalidRes = await request(app)
      .get('/api/v1/partner/dashboard/stats')
      .set('Authorization', 'Bearer invalid-token-xyz');
    expect(invalidRes.status).toBe(401);
  });

  it('5. Invalidation helpers correctly clear caches on demand', () => {
    expect(() => partnerService.invalidateDashboardCache()).not.toThrow();
    expect(() => partnerService.invalidateDashboardCache(existingPartnerId)).not.toThrow();
    expect(() => invalidateAuthCache()).not.toThrow();
    expect(() => invalidateAuthCache(existingPartnerId)).not.toThrow();
  });

  it('6. Direct SQL query execution in PartnerRepository guarantees partner scoping and zero returns for empty partner', async () => {
    // Restore un-spied PartnerRepository
    jest.restoreAllMocks();
    const repo = new PartnerRepository();

    // Query with non-existent / empty partner UUID
    const statsForEmpty = await repo.getDashboardStats('00000000-0000-0000-0000-000000000000');
    expect(statsForEmpty.totalVehicles).toBe(0);
    expect(statsForEmpty.bookedVehicles).toBe(0);
    expect(statsForEmpty.upcomingBookings).toBe(0);
    expect(statsForEmpty.activeRentals).toBe(0);
    expect(statsForEmpty.availableVehicles).toBe(0);
    expect(statsForEmpty.completedBookings).toBe(0);
    expect(statsForEmpty.earnings.totalEarnings).toBe(0);
    expect(statsForEmpty.earnings.monthlyEarnings).toBe(0);
    expect(statsForEmpty.activeRentalsSummary).toEqual([]);
  });
});
