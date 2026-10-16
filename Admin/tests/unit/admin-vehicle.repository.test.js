'use strict';

const adminVehicleRepository = require('../../src/repositories/admin-vehicle.repository');

describe('Unit: AdminVehicleRepository', () => {
  let mockClient;
  let executedQueries;

  const TEST_VEHICLE_ID = 'e1111111-1111-4111-a111-111111111111';
  const TEST_PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';

  beforeEach(() => {
    adminVehicleRepository.constructor.resetMockVehicleResolver();
    executedQueries = [];
    mockClient = {
      query: jest.fn(async (text, values) => {
        executedQueries.push({ text, values });
        return {
          rows: [
            {
              id: TEST_VEHICLE_ID,
              partner_id: TEST_PARTNER_ID,
              shop_id: null,
              category: 'CAR',
              brand: 'Hyundai',
              model: 'i20',
              variant: 'Asta',
              registration_number: 'KA-01-AB-1234',
              year: 2023,
              fuel_type: 'Petrol',
              transmission: 'Manual',
              seats: 5,
              description: 'Well-maintained hatchback',
              manual_status: 'ONLINE',
              rental_status: 'IDLE',
              verification_status: 'VERIFIED',
              is_archived: false,
              offline_reason: null,
              created_at: new Date('2026-09-01T10:00:00.000Z'),
              updated_at: new Date('2026-09-01T10:00:00.000Z'),
              partner_name: 'Fast Wheels Mobility',
              partner_city: 'Bengaluru',
              cover_image_url: 'https://cdn.gongo.in/v1.jpg',
              price_per_day: '2500.00',
              price_per_hour: '150.00',
              booking_count: 12,
              full_count: 1,
            },
          ],
          rowCount: 1,
        };
      }),
    };
  });

  afterEach(() => {
    adminVehicleRepository.constructor.resetMockVehicleResolver();
  });

  it('listVehicles executes parameterized search and filtering with non-UUID string', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-20T00:00:00.000Z');

    const res = await adminVehicleRepository.listVehicles({
      search: 'Hyundai',
      partnerId: TEST_PARTNER_ID,
      category: 'CAR',
      manualStatus: 'ONLINE',
      rentalStatus: 'IDLE',
      verificationStatus: 'VERIFIED',
      isArchived: false,
      city: 'Bengaluru',
      startDate: start,
      endDate: end,
      limit: 10,
      offset: 0,
      sortBy: 'model',
      sortOrder: 'ASC',
    }, mockClient);

    expect(mockClient.query).toHaveBeenCalled();
    const query = executedQueries[0];
    expect(query.text).toContain('v.registration_number ILIKE $1');
    expect(query.text).toContain('v.partner_id = $2');
    expect(query.text).toContain('v.category ILIKE $3');
    expect(query.text).toContain('v.manual_status = $4');
    expect(query.text).toContain('v.rental_status = $5');
    expect(query.text).toContain('v.verification_status = $6');
    expect(query.text).toContain('v.is_archived = $7');
    expect(query.text).toContain('p.city ILIKE $8');
    expect(query.text).toContain('v.created_at >= $9');
    expect(query.text).toContain('v.created_at < $10');
    expect(query.text).toContain('ORDER BY v.model ASC');

    expect(res.vehicles).toHaveLength(1);
    expect(res.vehicles[0].brand).toBe('Hyundai');
    expect(res.vehicles[0].pricePerDay).toBe(2500.00);
    expect(res.vehicles[0].bookingCount).toBe(12);
    expect(res.total).toBe(1);
  });

  it('listVehicles matches UUID search query', async () => {
    await adminVehicleRepository.listVehicles({
      search: TEST_VEHICLE_ID,
      limit: 10,
      offset: 0,
    }, mockClient);

    const query = executedQueries[0];
    expect(query.text).toContain('v.id = $2');
    expect(query.values).toContain(TEST_VEHICLE_ID);
  });

  it('findVehicleById executes parameterized query by UUID and projects safe fields', async () => {
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: TEST_VEHICLE_ID,
          partner_id: TEST_PARTNER_ID,
          shop_id: null,
          category: 'CAR',
          brand: 'Hyundai',
          model: 'i20',
          variant: 'Asta',
          registration_number: 'KA-01-AB-1234',
          year: 2023,
          fuel_type: 'Petrol',
          transmission: 'Manual',
          seats: 5,
          description: 'Hatchback',
          manual_status: 'ONLINE',
          rental_status: 'IDLE',
          verification_status: 'VERIFIED',
          is_archived: false,
          offline_reason: null,
          created_at: new Date(),
          updated_at: new Date(),
          partner_name: 'Fast Wheels Mobility',
          partner_city: 'Bengaluru',
          partner_owner_name: 'Suresh Patel',
          partner_owner_email: 'suresh@fastwheels.in',
          partner_owner_phone: '9123456780',
        },
      ],
    });

    const res = await adminVehicleRepository.findVehicleById(TEST_VEHICLE_ID, mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE v.id = $1'),
      [TEST_VEHICLE_ID],
    );
    expect(res).toBeDefined();
    expect(res.id).toBe(TEST_VEHICLE_ID);
    expect(res.brand).toBe('Hyundai');
    expect(res.partner.businessName).toBe('Fast Wheels Mobility');
    expect(res.partner.ownerName).toBe('Suresh Patel');
  });

  it('getVehicleSummaries executes booking, document, image, and pricing aggregations', async () => {
    mockClient.query = jest.fn(async (text) => {
      if (text.includes('FROM bookings')) {
        return { rows: [{ total: 20, upcoming: 2, active: 1, completed: 15, cancelled: 2 }] };
      }
      if (text.includes('FROM vehicle_documents')) {
        return { rows: [{ total: 4, verified: 4, pending: 0, rejected: 0 }] };
      }
      if (text.includes('FROM vehicle_images')) {
        return { rows: [{ count: 6 }] };
      }
      if (text.includes('FROM vehicle_pricing')) {
        return {
          rows: [{
            price_per_hour: '150.00',
            price_per_4_hours: '550.00',
            price_per_day: '2500.00',
            security_deposit: '5000.00',
            extra_km_charge: '15.00',
            currency: 'INR',
            is_active: true,
          }],
        };
      }
      if (text.includes('FROM vehicle_availability_blocks')) {
        return { rows: [{ active_blocks: 1 }] };
      }
      return { rows: [] };
    });

    const res = await adminVehicleRepository.getVehicleSummaries(TEST_VEHICLE_ID, mockClient);

    expect(res.bookingSummary.total).toBe(20);
    expect(res.bookingSummary.completed).toBe(15);
    expect(res.documentsSummary.verified).toBe(4);
    expect(res.imagesCount).toBe(6);
    expect(res.pricing.pricePerDay).toBe(2500.00);
    expect(res.availability.activeBlocksCount).toBe(1);
  });

  it('getActiveBookingCount queries bookings with active/upcoming statuses', async () => {
    mockClient.query = jest.fn().mockResolvedValueOnce({ rows: [{ count: 2 }] });

    const count = await adminVehicleRepository.getActiveBookingCount(TEST_VEHICLE_ID, mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("booking_status IN ('UPCOMING', 'ACTIVE', 'CONFIRMED')"),
      [TEST_VEHICLE_ID],
    );
    expect(count).toBe(2);
  });

  it('updateVehicleStatus updates vehicle fields and returns updated record', async () => {
    mockClient.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: TEST_VEHICLE_ID }] })
      .mockResolvedValueOnce({
        rows: [{
          id: TEST_VEHICLE_ID,
          manual_status: 'OFFLINE',
          offline_reason: 'Routine Service',
          is_archived: false,
          created_at: new Date(),
          updated_at: new Date(),
          partner_name: 'Fast Wheels Mobility',
        }],
      });

    const res = await adminVehicleRepository.updateVehicleStatus(
      TEST_VEHICLE_ID,
      { manualStatus: 'OFFLINE', offlineReason: 'Routine Service' },
      mockClient,
    );

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE vehicles'),
      expect.arrayContaining([TEST_VEHICLE_ID, 'OFFLINE', 'Routine Service']),
    );
    expect(res.manualStatus).toBe('OFFLINE');
  });

  it('updateVehicleVerification updates verification status', async () => {
    mockClient.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: TEST_VEHICLE_ID }] })
      .mockResolvedValueOnce({
        rows: [{
          id: TEST_VEHICLE_ID,
          verification_status: 'VERIFIED',
          created_at: new Date(),
          updated_at: new Date(),
        }],
      });

    const res = await adminVehicleRepository.updateVehicleVerification(
      TEST_VEHICLE_ID,
      'VERIFIED',
      mockClient,
    );

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE vehicles\n      SET verification_status = $2'),
      [TEST_VEHICLE_ID, 'VERIFIED'],
    );
    expect(res.verificationStatus).toBe('VERIFIED');
  });

  it('getVehicleDocuments retrieves document metadata', async () => {
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'doc-1',
          vehicle_id: TEST_VEHICLE_ID,
          document_type: 'RC',
          document_name: 'Registration Certificate',
          document_number: 'RC-12345',
          valid_till: '2028-12-31',
          storage_key: 'vehicles/rc.pdf',
          verification_status: 'VERIFIED',
          is_required: true,
          version: 1,
          rejection_reason: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const docs = await adminVehicleRepository.getVehicleDocuments(TEST_VEHICLE_ID, mockClient);
    expect(docs).toHaveLength(1);
    expect(docs[0].documentType).toBe('RC');
    expect(docs[0].documentNumber).toBe('RC-12345');
  });

  it('findVehicleDocumentById queries document by id and vehicle_id for ownership enforcement', async () => {
    const docId = '11111111-2222-3333-4444-555555555555';
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: docId,
          vehicle_id: TEST_VEHICLE_ID,
          document_type: 'RC',
          document_name: 'Registration Certificate',
          document_number: 'RC-12345',
          valid_till: '2028-12-31',
          storage_key: 'vehicles/rc.pdf',
          verification_status: 'VERIFIED',
          is_required: true,
          version: 1,
          rejection_reason: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const doc = await adminVehicleRepository.findVehicleDocumentById(docId, TEST_VEHICLE_ID, mockClient);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1 AND vehicle_id = $2'),
      [docId, TEST_VEHICLE_ID],
    );
    expect(doc.id).toBe(docId);
    expect(doc.vehicleId).toBe(TEST_VEHICLE_ID);
    expect(doc.documentType).toBe('RC');
  });

  it('getVehicleImages retrieves gallery images sorted by cover and order', async () => {
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'img-1',
          vehicle_id: TEST_VEHICLE_ID,
          storage_key: 'img/cover.jpg',
          image_url: 'https://cdn.gongo.in/cover.jpg',
          sort_order: 0,
          is_cover: true,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const imgs = await adminVehicleRepository.getVehicleImages(TEST_VEHICLE_ID, mockClient);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].isCover).toBe(true);
    expect(imgs[0].imageUrl).toBe('https://cdn.gongo.in/cover.jpg');
  });

  it('getVehicleBookings retrieves paginated vehicle bookings', async () => {
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'bk-1',
          booking_number: 'BK-2001',
          customer_id: 'c1',
          partner_id: TEST_PARTNER_ID,
          vehicle_id: TEST_VEHICLE_ID,
          start_at: new Date(),
          expected_return_at: new Date(),
          booking_status: 'COMPLETED',
          payment_status: 'SUCCESS',
          pickup_location: 'Koramangala',
          created_at: new Date(),
          updated_at: new Date(),
          full_count: 1,
        },
      ],
    });

    const res = await adminVehicleRepository.getVehicleBookings(
      TEST_VEHICLE_ID,
      { status: 'COMPLETED', limit: 10, offset: 0 },
      mockClient,
    );

    expect(res.bookings).toHaveLength(1);
    expect(res.bookings[0].bookingNumber).toBe('BK-2001');
    expect(res.total).toBe(1);
  });

  it('getVehicleAvailability retrieves active availability blocks', async () => {
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'avail-1',
          vehicle_id: TEST_VEHICLE_ID,
          start_time: new Date(),
          end_time: new Date(Date.now() + 86400000),
          reason: 'Periodic maintenance',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const blocks = await adminVehicleRepository.getVehicleAvailability(
      TEST_VEHICLE_ID,
      mockClient,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].reason).toBe('Periodic maintenance');
  });

  it('getVehiclePricing retrieves pricing rates', async () => {
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'pr-1',
          vehicle_id: TEST_VEHICLE_ID,
          price_per_hour: '150.00',
          price_per_4_hours: '550.00',
          price_per_day: '2500.00',
          security_deposit: '5000.00',
          extra_km_charge: '15.00',
          currency: 'INR',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const pricing = await adminVehicleRepository.getVehiclePricing(TEST_VEHICLE_ID, mockClient);
    expect(pricing).toBeDefined();
    expect(pricing.pricePerDay).toBe(2500.00);
    expect(pricing.currency).toBe('INR');
  });

  it('getVehicleEarnings aggregates revenue and booking count', async () => {
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          total_payments: 15,
          gross_revenue: '45000.00',
          successful_bookings: 14,
          refunded_bookings: 1,
        },
      ],
    });

    const earnings = await adminVehicleRepository.getVehicleEarnings(TEST_VEHICLE_ID, mockClient);
    expect(earnings.totalPayments).toBe(15);
    expect(earnings.grossRevenue).toBe(45000.00);
    expect(earnings.successfulBookings).toBe(14);
  });

  it('getVehicleHistory retrieves audit activity trail', async () => {
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'act-1',
          actor_id: 'admin-1',
          actor_role: 'ADMIN',
          permission: 'vehicles.update',
          action: 'VEHICLE_STATUS_CHANGE',
          target_resource: 'VEHICLE',
          target_resource_id: TEST_VEHICLE_ID,
          request_id: 'req-1',
          before_state: { manualStatus: 'ONLINE' },
          after_state: { manualStatus: 'OFFLINE' },
          metadata: { reason: 'Maintenance' },
          created_at: new Date(),
          full_count: 1,
        },
      ],
    });

    const res = await adminVehicleRepository.getVehicleHistory(
      TEST_VEHICLE_ID,
      { limit: 10, offset: 0 },
      mockClient,
    );

    expect(res.history).toHaveLength(1);
    expect(res.history[0].action).toBe('VEHICLE_STATUS_CHANGE');
    expect(res.total).toBe(1);
  });

  it('supports mock vehicle resolver hook for unit testing', async () => {
    const mockResolver = {
      listVehicles: jest.fn().mockResolvedValue({ vehicles: [], total: 0 }),
    };
    adminVehicleRepository.constructor.setMockVehicleResolver(mockResolver);

    const res = await adminVehicleRepository.listVehicles();
    expect(res).toEqual({ vehicles: [], total: 0 });
    expect(mockResolver.listVehicles).toHaveBeenCalled();
  });
});
