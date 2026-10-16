'use strict';

const adminPaymentRepository = require('../../src/repositories/admin-payment.repository');

const { setMockPaymentResolver, resetMockPaymentResolver } = adminPaymentRepository;

describe('Unit: AdminPaymentRepository', () => {
  const TEST_PAYMENT_ID = 'e1111111-1111-4111-a111-111111111111';
  const TEST_BOOKING_ID = 'b1111111-1111-4111-a111-111111111111';
  const TEST_CUSTOMER_ID = 'c1111111-1111-4111-a111-111111111111';
  const TEST_PARTNER_ID = 'd1111111-1111-4111-a111-111111111111';
  const TEST_REFUND_ID = 'f1111111-1111-4111-a111-111111111111';
  const TEST_COMMISSION_ID = 'a1111111-1111-4111-a111-111111111111';

  afterEach(() => {
    resetMockPaymentResolver();
  });

  it('listPayments returns paginated payments with filters', async () => {
    setMockPaymentResolver(async (sql, params) => {
      expect(sql).toContain('FROM payments p');
      expect(params).toContain(TEST_BOOKING_ID);
      return {
        rows: [
          {
            id: TEST_PAYMENT_ID,
            booking_id: TEST_BOOKING_ID,
            customer_id: TEST_CUSTOMER_ID,
            provider: 'CASHFREE',
            provider_order_id: 'cf_order_001',
            provider_payment_id: 'cf_pay_001',
            amount: '1500.00',
            currency: 'INR',
            status: 'SUCCESS',
            payment_method: 'UPI',
            payment_type: 'BOOKING_ADVANCE',
            booking_number: 'GG-2026-0001',
            customer_name: 'Test Customer',
            full_count: 1,
          },
        ],
      };
    });

    const result = await adminPaymentRepository.listPayments({
      bookingId: TEST_BOOKING_ID,
      status: 'SUCCESS',
      page: 1,
      limit: 10,
    });

    expect(result.total).toBe(1);
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0].id).toBe(TEST_PAYMENT_ID);
  });

  it('getPaymentById returns payment with joined summaries', async () => {
    setMockPaymentResolver(async (sql, params) => {
      expect(sql).toContain('WHERE p.id = $1');
      expect(params[0]).toBe(TEST_PAYMENT_ID);
      return {
        rows: [
          {
            id: TEST_PAYMENT_ID,
            booking_id: TEST_BOOKING_ID,
            customer_id: TEST_CUSTOMER_ID,
            provider: 'CASHFREE',
            provider_order_id: 'cf_order_001',
            provider_payment_id: 'cf_pay_001',
            amount: '2500.00',
            currency: 'INR',
            status: 'SUCCESS',
            payment_method: 'CARD',
            payment_type: 'BOOKING_ADVANCE',
            booking_number: 'GG-2026-0002',
            booking_status: 'CONFIRMED',
            customer_name: 'Priya Sharma',
            customer_email: 'priya@example.com',
            partner_id: TEST_PARTNER_ID,
            partner_business_name: 'Speedy Wheels',
          },
        ],
      };
    });

    const payment = await adminPaymentRepository.getPaymentById(TEST_PAYMENT_ID);
    expect(payment).not.toBeNull();
    expect(payment.id).toBe(TEST_PAYMENT_ID);
    expect(payment.amount).toBe(2500);
    expect(payment.booking.booking_number).toBe('GG-2026-0002');
    expect(payment.customer.name).toBe('Priya Sharma');
    expect(payment.partner.business_name).toBe('Speedy Wheels');
  });

  it('getPaymentBooking returns associated booking', async () => {
    setMockPaymentResolver(async (sql, params) => {
      expect(params[0]).toBe(TEST_PAYMENT_ID);
      return {
        rows: [
          {
            id: TEST_BOOKING_ID,
            booking_number: 'GG-2026-0003',
            status: 'ACTIVE',
            total_amount: 3200,
          },
        ],
      };
    });

    const booking = await adminPaymentRepository.getPaymentBooking(TEST_PAYMENT_ID);
    expect(booking.booking_number).toBe('GG-2026-0003');
  });

  it('getPaymentCustomer returns associated customer', async () => {
    setMockPaymentResolver(async (sql, params) => {
      expect(params[0]).toBe(TEST_PAYMENT_ID);
      return {
        rows: [
          {
            id: TEST_CUSTOMER_ID,
            name: 'Customer A',
            email: 'customera@example.com',
          },
        ],
      };
    });

    const customer = await adminPaymentRepository.getPaymentCustomer(TEST_PAYMENT_ID);
    expect(customer.name).toBe('Customer A');
  });

  it('getPaymentPartner returns associated partner', async () => {
    setMockPaymentResolver(async (sql, params) => {
      expect(params[0]).toBe(TEST_PAYMENT_ID);
      return {
        rows: [
          {
            id: TEST_PARTNER_ID,
            business_name: 'Partner X',
          },
        ],
      };
    });

    const partner = await adminPaymentRepository.getPaymentPartner(TEST_PAYMENT_ID);
    expect(partner.business_name).toBe('Partner X');
  });

  it('getPaymentTimeline returns event milestones', async () => {
    setMockPaymentResolver(async (sql) => {
      if (sql.includes('WHERE p.id = $1')) {
        return {
          rows: [
            {
              id: TEST_PAYMENT_ID,
              amount: '1500.00',
              currency: 'INR',
              provider: 'CASHFREE',
              status: 'SUCCESS',
              created_at: new Date('2026-09-01T10:00:00Z'),
              updated_at: new Date('2026-09-01T10:05:00Z'),
            },
          ],
        };
      }
      if (sql.includes('FROM refunds')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const timeline = await adminPaymentRepository.getPaymentTimeline(TEST_PAYMENT_ID);
    expect(timeline).toHaveLength(2);
    expect(timeline[0].event).toBe('PAYMENT_CREATED');
    expect(timeline[1].event).toBe('PAYMENT_CONFIRMED');
  });

  it('listRefunds returns paginated refunds', async () => {
    setMockPaymentResolver(async (sql) => {
      expect(sql).toContain('FROM refunds r');
      return {
        rows: [
          {
            id: TEST_REFUND_ID,
            refund_number: 'REF-GG-0001',
            booking_id: TEST_BOOKING_ID,
            payment_id: TEST_PAYMENT_ID,
            customer_id: TEST_CUSTOMER_ID,
            requested_amount: '500.00',
            refunded_amount: '500.00',
            currency: 'INR',
            reason: 'Cancellation prior to trip start',
            status: 'COMPLETED',
            booking_number: 'GG-2026-0001',
            customer_name: 'Customer A',
            full_count: 1,
          },
        ],
      };
    });

    const result = await adminPaymentRepository.listRefunds({ status: 'COMPLETED' });
    expect(result.total).toBe(1);
    expect(result.refunds[0].refund_number).toBe('REF-GG-0001');
  });

  it('createRefund inserts record and returns created row', async () => {
    setMockPaymentResolver(async (sql, params) => {
      expect(sql).toContain('INSERT INTO refunds');
      return {
        rows: [
          {
            id: TEST_REFUND_ID,
            refund_number: params[0],
            booking_id: params[1],
            payment_id: params[2],
            customer_id: params[3],
            requested_amount: params[4],
            status: params[9],
          },
        ],
      };
    });

    const created = await adminPaymentRepository.createRefund(null, {
      refundNumber: 'REF-GG-1000',
      bookingId: TEST_BOOKING_ID,
      paymentId: TEST_PAYMENT_ID,
      customerId: TEST_CUSTOMER_ID,
      requestedAmount: 500,
      approvedAmount: 500,
      reason: 'Valid refund',
      status: 'COMPLETED',
    });

    expect(created.refund_number).toBe('REF-GG-1000');
  });

  it('listCommissions returns commission records', async () => {
    setMockPaymentResolver(async (sql) => {
      expect(sql).toContain('FROM commission_records cr');
      return {
        rows: [
          {
            id: TEST_COMMISSION_ID,
            booking_id: TEST_BOOKING_ID,
            partner_id: TEST_PARTNER_ID,
            commission_type: 'PERCENTAGE',
            commission_rate: '0.1500',
            commission_amount: '300.00',
            gross_booking_amount: '2000.00',
            partner_payable_amount: '1700.00',
            status: 'CALCULATED',
            full_count: 1,
          },
        ],
      };
    });

    const result = await adminPaymentRepository.listCommissions({ page: 1, limit: 10 });
    expect(result.total).toBe(1);
    expect(result.commissions[0].commission_amount).toBe('300.00');
  });

  it('getFinancialSummary calculates accurate aggregate financial statistics', async () => {
    setMockPaymentResolver(async (sql) => {
      if (sql.includes('FROM payments')) {
        return {
          rows: [
            {
              total_payments: 100,
              successful_payments: 80,
              failed_payments: 15,
              pending_payments: 5,
              total_collected_amount: '150000.00',
            },
          ],
        };
      }
      if (sql.includes('FROM refunds')) {
        return {
          rows: [
            {
              total_refunds: 10,
              completed_refunds: 8,
              total_refunded_amount: '12000.00',
            },
          ],
        };
      }
      if (sql.includes('FROM commission_records')) {
        return {
          rows: [
            {
              total_commission_amount: '22500.00',
              total_partner_payable_amount: '127500.00',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const summary = await adminPaymentRepository.getFinancialSummary({});
    expect(summary.payments.total).toBe(100);
    expect(summary.payments.successful).toBe(80);
    expect(summary.payments.totalCollectedAmount).toBe(150000);
    expect(summary.refunds.totalRefundedAmount).toBe(12000);
    expect(summary.commissions.totalCommissionAmount).toBe(22500);
  });
});
