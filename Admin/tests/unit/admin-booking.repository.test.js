'use strict';

const adminBookingRepository = require('../../src/repositories/admin-booking.repository');

describe('Unit: AdminBookingRepository', () => {
  let mockClient;
  let executedQueries;

  const TEST_BOOKING_ID = 'e1111111-1111-4111-a111-111111111111';
  const TEST_CUSTOMER_ID = 'c1111111-1111-4111-a111-111111111111';
  const TEST_PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';
  const TEST_VEHICLE_ID = 'd1111111-1111-4111-a111-111111111111';

  beforeEach(() => {
    adminBookingRepository.constructor.resetMockBookingResolver();
    executedQueries = [];
    mockClient = {
      query: jest.fn(async (text, values) => {
        executedQueries.push({ text, values });
        return {
          rows: [
            {
              id: TEST_BOOKING_ID,
              booking_number: 'BK-2026-0001',
              customer_id: TEST_CUSTOMER_ID,
              partner_id: TEST_PARTNER_ID,
              vehicle_id: TEST_VEHICLE_ID,
              start_at: new Date('2026-09-01T10:00:00.000Z'),
              expected_return_at: new Date('2026-09-03T10:00:00.000Z'),
              booking_status: 'CONFIRMED',
              payment_status: 'COMPLETED',
              pickup_location: 'Indiranagar Hub, Bengaluru',
              created_at: new Date('2026-09-01T08:00:00.000Z'),
              updated_at: new Date('2026-09-01T08:00:00.000Z'),
              customer_name: 'Rajesh Kumar',
              customer_phone: '9876543210',
              customer_email: 'rajesh@example.com',
              partner_name: 'Apex Mobility',
              vehicle_registration: 'KA-01-MJ-9999',
              vehicle_brand: 'Tata',
              vehicle_model: 'Nexon EV',
              vehicle_category: 'SUV',
              total_amount: '3500.00',
              security_deposit: '1500.00',
              full_count: 1,
            },
          ],
          rowCount: 1,
        };
      }),
    };
  });

  afterEach(() => {
    adminBookingRepository.constructor.resetMockBookingResolver();
  });

  it('escapes LIKE wildcards correctly', () => {
    expect(adminBookingRepository._escapeLikeWildcards('test%_\\val')).toBe('test\\%\\_\\\\val');
  });

  it('listBookings executes parameterized search and filtering with search string', async () => {
    const result = await adminBookingRepository.listBookings(
      {
        search: 'Rajesh',
        bookingStatus: 'CONFIRMED',
        paymentStatus: 'COMPLETED',
        customerId: TEST_CUSTOMER_ID,
        partnerId: TEST_PARTNER_ID,
        vehicleId: TEST_VEHICLE_ID,
        startDate: new Date('2026-09-01T00:00:00.000Z'),
        endDate: new Date('2026-09-05T00:00:00.000Z'),
        limit: 10,
        offset: 0,
        sortBy: 'created_at',
        sortOrder: 'DESC',
      },
      mockClient,
    );

    expect(result.bookings).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(executedQueries).toHaveLength(1);

    const query = executedQueries[0];
    expect(query.text).toContain('b.booking_number');
    expect(query.text).toContain('b.booking_status = $');
    expect(query.text).toContain('b.payment_status = $');
    expect(query.text).toContain('b.customer_id = $');
    expect(query.text).toContain('b.partner_id = $');
    expect(query.text).toContain('b.vehicle_id = $');
    expect(query.text).toContain('b.created_at >= $');
    expect(query.text).toContain('b.created_at < $');
    expect(query.values).toContain('CONFIRMED');
    expect(query.values).toContain('COMPLETED');
    expect(query.values).toContain(TEST_CUSTOMER_ID);
    expect(query.values).toContain(TEST_PARTNER_ID);
    expect(query.values).toContain(TEST_VEHICLE_ID);
  });

  it('listBookings works with UUID search term', async () => {
    const result = await adminBookingRepository.listBookings(
      {
        search: TEST_BOOKING_ID,
        limit: 5,
        offset: 0,
      },
      mockClient,
    );

    expect(result.bookings).toHaveLength(1);
    expect(executedQueries[0].text).toContain('b.id = $');
    expect(executedQueries[0].values).toContain(TEST_BOOKING_ID);
  });

  it('listBookings handles empty results gracefully', async () => {
    mockClient.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await adminBookingRepository.listBookings({}, mockClient);
    expect(result.bookings).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('findBookingById returns structured booking with nested entities', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: TEST_BOOKING_ID,
          booking_number: 'BK-2026-0001',
          customer_id: TEST_CUSTOMER_ID,
          partner_id: TEST_PARTNER_ID,
          vehicle_id: TEST_VEHICLE_ID,
          start_at: new Date('2026-09-01T10:00:00.000Z'),
          expected_return_at: new Date('2026-09-03T10:00:00.000Z'),
          booking_status: 'CONFIRMED',
          payment_status: 'COMPLETED',
          pickup_location: 'Indiranagar Hub, Bengaluru',
          created_at: new Date('2026-09-01T08:00:00.000Z'),
          updated_at: new Date('2026-09-01T08:00:00.000Z'),
          customer_name: 'Rajesh Kumar',
          customer_phone: '9876543210',
          customer_email: 'rajesh@example.com',
          partner_name: 'Apex Mobility',
          partner_owner_name: 'Suresh Patel',
          partner_owner_email: 'suresh@apex.in',
          partner_owner_phone: '9876543211',
          vehicle_registration_number: 'KA-01-MJ-9999',
          vehicle_brand: 'Tata',
          vehicle_model: 'Nexon EV',
          vehicle_category: 'SUV',
          vehicle_fuel_type: 'EV',
          vehicle_transmission: 'Automatic',
          vehicle_rental_status: 'IDLE',
          vehicle_manual_status: 'ONLINE',
        },
      ],
      rowCount: 1,
    });

    const booking = await adminBookingRepository.findBookingById(TEST_BOOKING_ID, mockClient);

    expect(booking).not.toBeNull();
    expect(booking.id).toBe(TEST_BOOKING_ID);
    expect(booking.bookingNumber).toBe('BK-2026-0001');
    expect(booking.customer.name).toBe('Rajesh Kumar');
    expect(booking.partner.businessName).toBe('Apex Mobility');
    expect(booking.vehicle.registrationNumber).toBe('KA-01-MJ-9999');
  });

  it('findBookingById returns null when booking not found', async () => {
    mockClient.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    const booking = await adminBookingRepository.findBookingById(TEST_BOOKING_ID, mockClient);
    expect(booking).toBeNull();
  });

  it('findBookingByIdForUpdate acquires FOR UPDATE row lock', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: TEST_BOOKING_ID,
          booking_number: 'BK-2026-0001',
          booking_status: 'ACTIVE',
          payment_status: 'COMPLETED',
          vehicle_id: TEST_VEHICLE_ID,
          customer_id: TEST_CUSTOMER_ID,
          partner_id: TEST_PARTNER_ID,
          start_at: new Date(),
          expected_return_at: new Date(),
          pickup_location: 'Location',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const current = await adminBookingRepository.findBookingByIdForUpdate(
      TEST_BOOKING_ID,
      mockClient,
    );

    expect(current).not.toBeNull();
    expect(current.bookingStatus).toBe('ACTIVE');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      [TEST_BOOKING_ID],
    );
  });

  it('getBookingSummaries aggregates pricing, pickup, and return verifications', async () => {
    mockClient.query = jest.fn().mockImplementation(async (text) => {
      if (text.includes('booking_pricing_snapshots')) {
        return {
          rows: [
            {
              id: 'pr-1',
              base_amount: '2000.00',
              rental_amount: '3000.00',
              security_deposit: '1000.00',
              extra_km_charge: '0.00',
              late_fee: '0.00',
              total_customer_amount: '4000.00',
              price_per_hour: '150.00',
              currency: 'INR',
              created_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('booking_pickup_verifications')) {
        return {
          rows: [
            {
              id: 'pv-1',
              is_verified: true,
              verified_at: new Date('2026-09-01T10:05:00.000Z'),
              odometer_start: 12500,
              fuel_level_start: 95,
              photos: ['https://cdn.gongo.in/p1.jpg'],
              notes: 'Clean vehicle',
              created_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('booking_return_verifications')) {
        return {
          rows: [
            {
              id: 'rv-1',
              returned_at: new Date('2026-09-03T10:00:00.000Z'),
              odometer_end: 12750,
              late_minutes: 0,
              late_fee: '0.00',
              extra_km: 0,
              extra_km_fee: '0.00',
              return_status: 'RETURNED_SUCCESS',
              total_distance: 250,
              photos: ['https://cdn.gongo.in/r1.jpg'],
              notes: 'No new damages',
              created_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const summaries = await adminBookingRepository.getBookingSummaries(
      TEST_BOOKING_ID,
      mockClient,
    );

    expect(summaries.pricing).not.toBeNull();
    expect(summaries.pricing.totalCustomerAmount).toBe(4000);
    expect(summaries.pickupVerification.isVerified).toBe(true);
    expect(summaries.pickupVerification.odometerStart).toBe(12500);
    expect(summaries.returnVerification.returnStatus).toBe('RETURNED_SUCCESS');
  });

  it('getBookingPayments queries payments table with ordering', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 'pay-1',
          booking_id: TEST_BOOKING_ID,
          amount: '4000.00',
          currency: 'INR',
          provider: 'RAZORPAY',
          status: 'SUCCESS',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const payments = await adminBookingRepository.getBookingPayments(
      TEST_BOOKING_ID,
      mockClient,
    );

    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(4000);
    expect(payments[0].provider).toBe('RAZORPAY');
  });

  it('getBookingCommission queries commission_records', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 'com-1',
          booking_id: TEST_BOOKING_ID,
          commission_rate: '15.00',
          commission_amount: '450.00',
          gross_booking_amount: '3000.00',
          partner_payable_amount: '2550.00',
          status: 'CALCULATED',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const commission = await adminBookingRepository.getBookingCommission(
      TEST_BOOKING_ID,
      mockClient,
    );

    expect(commission).not.toBeNull();
    expect(commission.commissionAmount).toBe(450);
    expect(commission.partnerPayableAmount).toBe(2550);
  });

  it('getBookingSettlement queries earnings table', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 'earn-1',
          booking_id: TEST_BOOKING_ID,
          gross_amount: '3000.00',
          partner_net_amount: '2550.00',
          settlement_status: 'SETTLED',
          settled_at: new Date('2026-09-04T12:00:00.000Z'),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const settlement = await adminBookingRepository.getBookingSettlement(
      TEST_BOOKING_ID,
      mockClient,
    );

    expect(settlement).not.toBeNull();
    expect(settlement.settlementStatus).toBe('SETTLED');
    expect(settlement.partnerNetAmount).toBe(2550);
  });

  it('getBookingDamages queries damage_reports table', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 'dmg-1',
          booking_id: TEST_BOOKING_ID,
          damage_type: 'SCRATCH',
          description: 'Front bumper scratch',
          estimated_amount: '1200.00',
          status: 'PENDING_REVIEW',
          photos: ['https://cdn.gongo.in/dmg1.jpg'],
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const damages = await adminBookingRepository.getBookingDamages(
      TEST_BOOKING_ID,
      mockClient,
    );

    expect(damages).toHaveLength(1);
    expect(damages[0].damageType).toBe('SCRATCH');
    expect(damages[0].estimatedAmount).toBe(1200);
  });

  it('getBookingAdminActions queries admin_actions table', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 'act-1',
          actor_id: 'a0000001-0000-4000-a000-000000000001',
          actor_role: 'ADMIN',
          action: 'BOOKING_CANCELLED',
          before_state: { bookingStatus: 'CONFIRMED' },
          after_state: { bookingStatus: 'CANCELLED' },
          metadata: { reason: 'Customer requested via support' },
          created_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const actions = await adminBookingRepository.getBookingAdminActions(
      TEST_BOOKING_ID,
      mockClient,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('BOOKING_CANCELLED');
    expect(actions[0].metadata.reason).toBe('Customer requested via support');
  });

  it('updateBookingStatus updates status and returns updated record', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: TEST_BOOKING_ID,
          booking_number: 'BK-2026-0001',
          booking_status: 'CANCELLED',
          payment_status: 'COMPLETED',
          vehicle_id: TEST_VEHICLE_ID,
          customer_id: TEST_CUSTOMER_ID,
          partner_id: TEST_PARTNER_ID,
          start_at: new Date(),
          expected_return_at: new Date(),
          pickup_location: 'Location',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const updated = await adminBookingRepository.updateBookingStatus(
      TEST_BOOKING_ID,
      'CANCELLED',
      mockClient,
    );

    expect(updated.bookingStatus).toBe('CANCELLED');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE bookings'),
      [TEST_BOOKING_ID, 'CANCELLED'],
    );
  });

  it('updateVehicleRentalStatus updates vehicles rental_status correctly', async () => {
    mockClient.query = jest.fn().mockResolvedValue({ rowCount: 1 });

    await adminBookingRepository.updateVehicleRentalStatus(
      TEST_VEHICLE_ID,
      'IDLE',
      mockClient,
    );

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE vehicles'),
      [TEST_VEHICLE_ID, 'IDLE'],
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('rental_status = $2'),
      [TEST_VEHICLE_ID, 'IDLE'],
    );
  });

  it('mock resolver hook allows custom injection for tests', async () => {
    adminBookingRepository.constructor.setMockBookingResolver({
      findBookingById: async (id) => ({ id, mock: true }),
    });

    const res = await adminBookingRepository.findBookingById('custom-id');
    expect(res).toEqual({ id: 'custom-id', mock: true });
  });
});
