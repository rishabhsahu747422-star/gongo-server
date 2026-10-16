'use strict';

const adminPartnerRepository = require('../../src/repositories/admin-partner.repository');

describe('Unit: AdminPartnerRepository', () => {
  let mockClient;
  let executedQueries;

  beforeEach(() => {
    adminPartnerRepository.constructor.resetMockPartnerResolver();
    executedQueries = [];
    mockClient = {
      query: jest.fn(async (text, values) => {
        executedQueries.push({ text, values });
        return {
          rows: [
            {
              id: 'a1111111-1111-4111-a111-111111111111',
              user_id: 'u1111111-1111-4111-u111-111111111111',
              business_name: 'Fast Wheels Hub',
              city: 'Bengaluru',
              partner_status: 'ONLINE',
              kyc_status: 'VERIFIED',
              rating: '4.85',
              review_count: 24,
              is_active: true,
              user_name: 'Rajesh Sharma',
              user_email: 'rajesh@partner.in',
              user_phone: '9876543210',
              user_country_code: '+91',
              vehicle_count: 5,
              booking_count: 42,
              full_count: 1,
            },
          ],
          rowCount: 1,
        };
      }),
    };
  });

  afterEach(() => {
    adminPartnerRepository.constructor.resetMockPartnerResolver();
  });

  it('listPartners executes parameterized search and filtering', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-20T00:00:00.000Z');

    const res = await adminPartnerRepository.listPartners({
      search: 'Rajesh',
      partnerStatus: 'ONLINE',
      kycStatus: 'VERIFIED',
      isActive: true,
      city: 'Bengaluru',
      startDate: start,
      endDate: end,
      limit: 10,
      offset: 0,
      sortBy: 'rating',
      sortOrder: 'DESC',
    }, mockClient);

    expect(mockClient.query).toHaveBeenCalled();
    const query = executedQueries[0];
    expect(query.text).toContain('u.name ILIKE $1');
    expect(query.text).toContain('p.partner_status = $2');
    expect(query.text).toContain('p.kyc_status = $3');
    expect(query.text).toContain('p.is_active = $4');
    expect(query.text).toContain('p.city ILIKE $5');
    expect(query.text).toContain('p.created_at >= $6');
    expect(query.text).toContain('p.created_at < $7');
    expect(query.text).toContain('ORDER BY p.rating DESC');

    expect(res.partners).toHaveLength(1);
    expect(res.partners[0].businessName).toBe('Fast Wheels Hub');
    expect(res.partners[0].rating).toBe(4.85);
    expect(res.total).toBe(1);
  });

  it('findPartnerById executes parameterized query by UUID', async () => {
    const pId = 'a1111111-1111-4111-a111-111111111111';
    const res = await adminPartnerRepository.findPartnerById(pId, mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE p.id = $1'),
      [pId],
    );
    expect(res).toBeDefined();
    expect(res.name).toBe('Rajesh Sharma');
  });

  it('getPartnerSummaries executes fleet, booking, kyc, and earnings aggregations', async () => {
    const pId = 'a1111111-1111-4111-a111-111111111111';

    mockClient.query = jest.fn(async (text) => {
      if (text.includes('FROM vehicles')) {
        return { rows: [{ total: 10, active: 8, idle: 5, booked: 3 }] };
      }
      if (text.includes('FROM bookings')) {
        return { rows: [{ total: 50, upcoming: 5, active: 5, completed: 38, cancelled: 2 }] };
      }
      if (text.includes('FROM partner_documents')) {
        return { rows: [{
          total_documents: 4, pending_documents: 0, verified_documents: 4, rejected_documents: 0,
        }] };
      }
      if (text.includes('FROM earnings')) {
        return { rows: [{
          gross_amount: '50000', net_amount: '40000', settled_amount: '35000', pending_amount: '5000',
        }] };
      }
      if (text.includes('FROM payouts')) {
        return { rows: [{ completed_payouts: '30000', pending_payouts: '5000' }] };
      }
      return { rows: [] };
    });

    const res = await adminPartnerRepository.getPartnerSummaries(pId, mockClient);

    expect(res.fleetSummary.total).toBe(10);
    expect(res.bookingSummary.completed).toBe(38);
    expect(res.kycSummary.verifiedDocuments).toBe(4);
    expect(res.financialSummary.grossAmount).toBe(50000);
    expect(res.financialSummary.completedPayouts).toBe(30000);
  });

  it('getActiveBookingCount queries bookings with active statuses', async () => {
    const pId = 'a1111111-1111-4111-a111-111111111111';
    mockClient.query = jest.fn().mockResolvedValueOnce({ rows: [{ count: 3 }] });

    const count = await adminPartnerRepository.getActiveBookingCount(pId, mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("booking_status IN ('UPCOMING', 'ACTIVE', 'CONFIRMED')"),
      [pId],
    );
    expect(count).toBe(3);
  });

  it('updatePartnerStatus updates partner status and is_active flag atomically', async () => {
    const pId = 'a1111111-1111-4111-a111-111111111111';
    mockClient.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: pId, user_id: 'u-1', is_active: false, status: 'suspended' }] })
      .mockResolvedValueOnce({ rows: [{ id: pId, is_active: false, status: 'suspended' }] }); // findPartnerById

    await adminPartnerRepository.updatePartnerStatus(pId, { isActive: false }, mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE partners'),
      expect.arrayContaining([pId, false, 'suspended']),
    );
  });

  it('supports mock resolver hook for testing', async () => {
    const mockResolver = {
      listPartners: jest.fn().mockResolvedValue({ partners: [], total: 0 }),
    };
    adminPartnerRepository.constructor.setMockPartnerResolver(mockResolver);

    const res = await adminPartnerRepository.listPartners();
    expect(res).toEqual({ partners: [], total: 0 });
    expect(mockResolver.listPartners).toHaveBeenCalled();
  });
});
