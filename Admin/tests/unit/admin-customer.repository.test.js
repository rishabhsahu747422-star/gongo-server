'use strict';

const adminCustomerRepository = require('../../src/repositories/admin-customer.repository');

describe('Unit: AdminCustomerRepository', () => {
  let mockClient;
  let executedQueries;

  beforeEach(() => {
    adminCustomerRepository.constructor.resetMockCustomerResolver();
    executedQueries = [];
    mockClient = {
      query: jest.fn(async (text, values) => {
        executedQueries.push({ text, values });
        return {
          rows: [
            {
              id: 'c1111111-1111-4111-a111-111111111111',
              name: 'Aarav Patel',
              email: 'aarav@customer.in',
              phone: '9876543210',
              country_code: '+91',
              avatar_storage_key: 'avatars/c111.png',
              is_active: true,
              created_at: new Date('2026-09-01T10:00:00.000Z'),
              updated_at: new Date('2026-09-01T10:00:00.000Z'),
              booking_count: 5,
              total_spend: '15000.50',
              full_count: 1,
            },
          ],
          rowCount: 1,
        };
      }),
    };
  });

  afterEach(() => {
    adminCustomerRepository.constructor.resetMockCustomerResolver();
  });

  it('listCustomers executes parameterized search and filtering with non-UUID string', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-20T00:00:00.000Z');

    const res = await adminCustomerRepository.listCustomers({
      search: 'Aarav',
      isActive: true,
      startDate: start,
      endDate: end,
      limit: 10,
      offset: 0,
      sortBy: 'name',
      sortOrder: 'ASC',
    }, mockClient);

    expect(mockClient.query).toHaveBeenCalled();
    const query = executedQueries[0];
    expect(query.text).toContain("u.role = 'CUSTOMER'");
    expect(query.text).toContain('u.name ILIKE $1');
    expect(query.text).toContain('u.is_active = $2');
    expect(query.text).toContain('u.created_at >= $3');
    expect(query.text).toContain('u.created_at < $4');
    expect(query.text).toContain('ORDER BY u.name ASC');

    expect(res.customers).toHaveLength(1);
    expect(res.customers[0].name).toBe('Aarav Patel');
    expect(res.customers[0].bookingCount).toBe(5);
    expect(res.customers[0].totalSpend).toBe(15000.50);
    expect(res.total).toBe(1);
  });

  it('listCustomers matches UUID search query', async () => {
    const searchUuid = 'c1111111-1111-4111-a111-111111111111';
    await adminCustomerRepository.listCustomers({
      search: searchUuid,
      limit: 10,
      offset: 0,
    }, mockClient);

    const query = executedQueries[0];
    expect(query.text).toContain('u.id = $2');
    expect(query.values).toContain(searchUuid);
  });

  it('findCustomerById executes parameterized query by UUID and projects safe fields', async () => {
    const cId = 'c1111111-1111-4111-a111-111111111111';
    const res = await adminCustomerRepository.findCustomerById(cId, mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      // UUID lookup is parameterized and scoped to the customer role (case-insensitive,
      // since users.role values exist in both 'CUSTOMER' and 'customer' casing).
      expect.stringContaining("WHERE (u.id = $1) AND (u.role ILIKE 'CUSTOMER')"),
      [cId],
    );
    expect(executedQueries[0].text).not.toContain('password_hash');
    expect(res).toBeDefined();
    expect(res.id).toBe(cId);
    expect(res.name).toBe('Aarav Patel');
    expect(res.email).toBe('aarav@customer.in');
    expect(res).not.toHaveProperty('password_hash');
  });

  it('getCustomerSummaries executes booking, payment, document, and address aggregations', async () => {
    const cId = 'c1111111-1111-4111-a111-111111111111';

    mockClient.query = jest.fn(async (text) => {
      if (text.includes('FROM bookings')) {
        return { rows: [{ total: 10, upcoming: 2, active: 1, completed: 6, cancelled: 1 }] };
      }
      if (text.includes('FROM payments')) {
        return {
          rows: [{
            total_payments: 8,
            successful_payments: 6,
            pending_payments: 1,
            failed_payments: 1,
            total_spent: '24000.00',
          }],
        };
      }
      if (text.includes('FROM customer_documents')) {
        return {
          rows: [{
            total_documents: 2,
            verified_documents: 2,
            pending_documents: 0,
            rejected_documents: 0,
          }],
        };
      }
      if (text.includes('FROM customer_addresses')) {
        return { rows: [{ address_count: 3 }] };
      }
      return { rows: [] };
    });

    const res = await adminCustomerRepository.getCustomerSummaries(cId, mockClient);

    expect(res.bookingSummary.total).toBe(10);
    expect(res.bookingSummary.upcoming).toBe(2);
    expect(res.bookingSummary.active).toBe(1);
    expect(res.bookingSummary.completed).toBe(6);
    expect(res.paymentSummary.totalPayments).toBe(8);
    expect(res.paymentSummary.successfulPayments).toBe(6);
    expect(res.paymentSummary.totalSpent).toBe(24000.00);
    expect(res.documentSummary.totalDocuments).toBe(2);
    expect(res.documentSummary.verifiedDocuments).toBe(2);
    expect(res.addressCount).toBe(3);
  });

  it('getActiveBookingCount queries bookings with active/upcoming statuses', async () => {
    const cId = 'c1111111-1111-4111-a111-111111111111';
    mockClient.query = jest.fn().mockResolvedValueOnce({ rows: [{ count: 2 }] });

    const count = await adminCustomerRepository.getActiveBookingCount(cId, mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("booking_status IN ('UPCOMING', 'ACTIVE', 'CONFIRMED')"),
      [cId],
    );
    expect(count).toBe(2);
  });

  it('updateCustomerStatus updates users table and returns updated record', async () => {
    const cId = 'c1111111-1111-4111-a111-111111111111';
    mockClient.query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: cId, is_active: false }] })
      .mockResolvedValueOnce({
        rows: [{
          id: cId,
          name: 'Aarav Patel',
          email: 'aarav@customer.in',
          phone: '9876543210',
          country_code: '+91',
          is_active: false,
        }],
      });

    const res = await adminCustomerRepository.updateCustomerStatus(cId, false, mockClient);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE users\n      SET is_active = $2, updated_at = CURRENT_TIMESTAMP\n      WHERE id = $1 AND role = 'CUSTOMER'"),
      [cId, false],
    );
    expect(res.isActive).toBe(false);
  });

  it('getCustomerBookings executes parameterized query with status filter and pagination', async () => {
    const cId = 'c1111111-1111-4111-a111-111111111111';
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'b1111111-1111-4111-b111-111111111111',
          booking_number: 'BK-1001',
          customer_id: cId,
          partner_id: 'p1',
          vehicle_id: 'v1',
          start_at: new Date(),
          expected_return_at: new Date(),
          booking_status: 'COMPLETED',
          payment_status: 'SUCCESS',
          pickup_location: 'Indiranagar',
          created_at: new Date(),
          updated_at: new Date(),
          full_count: 1,
        },
      ],
    });

    const res = await adminCustomerRepository.getCustomerBookings(
      cId,
      { status: 'COMPLETED', limit: 10, offset: 0 },
      mockClient,
    );

    expect(res.bookings).toHaveLength(1);
    expect(res.bookings[0].bookingNumber).toBe('BK-1001');
    expect(res.total).toBe(1);
  });

  it('getCustomerPayments executes parameterized query with status filter and pagination', async () => {
    const cId = 'c1111111-1111-4111-a111-111111111111';
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'pay-1',
          booking_id: 'bk-1',
          customer_id: cId,
          provider: 'RAZORPAY',
          amount: '1200.00',
          currency: 'INR',
          status: 'SUCCESS',
          payment_method: 'UPI',
          payment_type: 'BOOKING_PAYMENT',
          failure_reason: null,
          created_at: new Date(),
          updated_at: new Date(),
          full_count: 1,
        },
      ],
    });

    const res = await adminCustomerRepository.getCustomerPayments(
      cId,
      { status: 'SUCCESS', limit: 10, offset: 0 },
      mockClient,
    );

    expect(res.payments).toHaveLength(1);
    expect(res.payments[0].amount).toBe(1200.00);
    expect(res.total).toBe(1);
  });

  it('getCustomerDocuments retrieves documents safely', async () => {
    const cId = 'c1111111-1111-4111-a111-111111111111';
    // Row shape follows the authoritative Supabase customer_documents columns selected by
    // getCustomerDocuments (customer_id, verification_status, file_url, storage_path) —
    // see Customer/src/repositories/customer-document.repository.js.
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'doc-1',
          customer_id: cId,
          document_type: 'DRIVING_LICENSE',
          verification_status: 'VERIFIED',
          file_url: 'https://cdn.example.com/docs/c1/dl.jpg',
          storage_path: 'docs/c1/dl.jpg',
          rejection_reason: null,
          verified_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const docs = await adminCustomerRepository.getCustomerDocuments(cId, mockClient);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE customer_id = $1'),
      [cId],
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].customerId).toBe(cId);
    // documentType is the human-readable label rendered by the admin UI
    // (frontend/Admin DocumentList shows doc.documentType); the raw enum is kept separately.
    expect(docs[0].documentType).toBe('Driving License');
    expect(docs[0].rawDocumentType).toBe('DRIVING_LICENSE');
    // Status is normalized to lowercase (matches stored verification_status values;
    // the admin Badge lowercases status before styling).
    expect(docs[0].status).toBe('verified');
    expect(docs[0].verificationStatus).toBe('verified');
    expect(docs[0].storageKey).toBe('docs/c1/dl.jpg');
    expect(docs[0].fileUrl).toBe('https://cdn.example.com/docs/c1/dl.jpg');
  });

  it('getCustomerAddresses retrieves saved addresses', async () => {
    const cId = 'c1111111-1111-4111-a111-111111111111';
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'addr-1',
          user_id: cId,
          label: 'Home',
          full_address: '12, 4th Cross, Koramangala',
          city: 'Bengaluru',
          state: 'Karnataka',
          postal_code: '560034',
          country_code: 'IN',
          latitude: '12.9352',
          longitude: '77.6245',
          is_default: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const addrs = await adminCustomerRepository.getCustomerAddresses(cId, mockClient);
    expect(addrs).toHaveLength(1);
    expect(addrs[0].label).toBe('Home');
    expect(addrs[0].latitude).toBe(12.9352);
  });

  it('getCustomerActivity retrieves audit trail', async () => {
    const cId = 'c1111111-1111-4111-a111-111111111111';
    mockClient.query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'act-1',
          actor_id: 'admin-1',
          actor_role: 'ADMIN',
          permission: 'customers.update',
          action: 'CUSTOMER_SUSPEND',
          target_resource: 'CUSTOMER',
          target_resource_id: cId,
          request_id: 'req-1',
          before_state: { isActive: true },
          after_state: { isActive: false },
          metadata: { reason: 'Policy violation' },
          created_at: new Date(),
          full_count: 1,
        },
      ],
    });

    const res = await adminCustomerRepository.getCustomerActivity(
      cId,
      { limit: 10, offset: 0 },
      mockClient,
    );
    expect(res.activity).toHaveLength(1);
    expect(res.activity[0].action).toBe('CUSTOMER_SUSPEND');
    expect(res.total).toBe(1);
  });

  it('supports mock customer resolver hook for unit tests', async () => {
    const mockResolver = {
      listCustomers: jest.fn().mockResolvedValue({ customers: [], total: 0 }),
    };
    adminCustomerRepository.constructor.setMockCustomerResolver(mockResolver);

    const res = await adminCustomerRepository.listCustomers();
    expect(res).toEqual({ customers: [], total: 0 });
    expect(mockResolver.listCustomers).toHaveBeenCalled();
  });
});
