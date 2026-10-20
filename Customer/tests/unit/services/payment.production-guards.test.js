'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PaymentService } = require('../../../src/services/payment.service');
const cashfreeProvider = require('../../../src/services/payment/providers/cashfree.provider');
const { PAYMENT_TYPE } = require('../../../src/constants/payment');

const ENV_MODULE = path.resolve(__dirname, '../../../src/config/env.js');

const VALID_PRODUCTION_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  REDIS_URL: 'redis://127.0.0.1:6379',
  CORS_ORIGIN: 'https://app.example.com',
  CASHFREE_APP_ID: 'real-app-id',
  CASHFREE_SECRET_KEY: 'real-secret',
  CASHFREE_ENV: 'PRODUCTION',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

/**
 * Loads config/env.js in a child process against exactly the given environment
 * (cwd is the OS temp dir, so no .env file is picked up).
 */
function loadEnvInChild({ set = {}, unset = [] } = {}) {
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ...VALID_PRODUCTION_ENV,
    ...set,
  };
  unset.forEach((key) => delete env[key]);
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(ENV_MODULE)})`], {
    cwd: os.tmpdir(),
    env,
    encoding: 'utf8',
  });
}

describe('Customer production configuration guards', () => {
  it('loads with real Cashfree credentials and dev shortcuts off', () => {
    const res = loadEnvInChild();
    expect(res.stderr).not.toMatch(/Invalid production configuration/);
    expect(res.status).toBe(0);
  });

  it.each([
    ['missing CASHFREE_SECRET_KEY', { unset: ['CASHFREE_SECRET_KEY'] }, /CASHFREE_SECRET_KEY/],
    ['placeholder CASHFREE_SECRET_KEY', { set: { CASHFREE_SECRET_KEY: 'test_cashfree_secret_key' } }, /CASHFREE_SECRET_KEY/],
    ['missing CASHFREE_APP_ID', { unset: ['CASHFREE_APP_ID'] }, /CASHFREE_APP_ID/],
    ['CASHFREE_ENV=SANDBOX in production', { set: { CASHFREE_ENV: 'SANDBOX' } }, /CASHFREE_ENV/],
    ['CUSTOMER_DEV_AUTH_ENABLED=true', { set: { CUSTOMER_DEV_AUTH_ENABLED: 'true' } }, /CUSTOMER_DEV_AUTH_ENABLED/],
    ['DEV_DUMMY_PAYMENT_ENABLED=true', { set: { DEV_DUMMY_PAYMENT_ENABLED: 'true' } }, /DEV_DUMMY_PAYMENT_ENABLED/],
    ['USE_REDIS_MOCK=true', { set: { USE_REDIS_MOCK: 'true' } }, /USE_REDIS_MOCK/],
    ['missing SUPABASE_URL', { unset: ['SUPABASE_URL'] }, /SUPABASE_URL/],
    ['missing SUPABASE_SERVICE_ROLE_KEY', { unset: ['SUPABASE_SERVICE_ROLE_KEY'] }, /SUPABASE_SERVICE_ROLE_KEY/],
  ])('refuses to load with %s', (_label, options, message) => {
    const res = loadEnvInChild(options);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(message);
  });
});

describe('PaymentService production guards', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.DEV_DUMMY_PAYMENT_ENABLED;
  });

  it('rejects webhook simulation in production even in Cashfree SANDBOX mode', async () => {
    process.env.NODE_ENV = 'production';
    const service = new PaymentService({ ...cashfreeProvider, envMode: 'SANDBOX' });
    await expect(
      service.simulateCashfreeWebhook({ customerId: 'c1', bookingId: 'b1' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects the dev payment bypass in production even when the flag is set', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_DUMMY_PAYMENT_ENABLED = 'true';
    const service = new PaymentService();
    await expect(service.devBypassPayment('c1', 'b1')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('Cashfree webhook signature without a configured secret', () => {
  it('does not fall back to the publicly known placeholder key', () => {
    const saved = process.env.CASHFREE_SECRET_KEY;
    process.env.CASHFREE_SECRET_KEY = '';
    let provider;
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line global-require
        provider = require('../../../src/services/payment/providers/cashfree.provider');
      });
    } finally {
      if (saved === undefined) delete process.env.CASHFREE_SECRET_KEY;
      else process.env.CASHFREE_SECRET_KEY = saved;
    }

    const rawBody = '{"a":1}';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const forged = crypto.createHmac('sha256', 'test_cashfree_secret_key')
      .update(`${timestamp}${rawBody}`).digest('base64');

    expect(provider.verifyWebhookSignature(
      { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': forged },
      rawBody,
    )).toBe(false);
  });
});

describe('Bearer token verification', () => {
  it('rejects a non-JWT token absent from the session store without calling Supabase', async () => {
    // eslint-disable-next-line global-require
    const supabaseProvider = require('../../../src/providers/supabase');
    const getUser = jest.fn();
    supabaseProvider.setMockSupabaseClient({ auth: { getUser } });
    try {
      await expect(supabaseProvider.verifyIdToken('a'.repeat(64)))
        .rejects.toMatchObject({ statusCode: 401, code: 'AUTH_INVALID_CREDENTIAL' });
      expect(getUser).not.toHaveBeenCalled();
    } finally {
      supabaseProvider.resetSupabaseClient();
    }
  });

  it('still verifies JWT-shaped tokens with Supabase', async () => {
    // eslint-disable-next-line global-require
    const supabaseProvider = require('../../../src/providers/supabase');
    const getUser = jest.fn().mockResolvedValue({ data: { user: { id: 'u-1', phone: '+919000000000' } }, error: null });
    supabaseProvider.setMockSupabaseClient({ auth: { getUser } });
    try {
      const payload = Buffer.from(JSON.stringify({ iat: 1700000000 })).toString('base64url');
      const decoded = await supabaseProvider.verifyIdToken(`hdr.${payload}.sig`);
      expect(getUser).toHaveBeenCalledTimes(1);
      expect(decoded.uid).toBe('u-1');
      expect(decoded.iat).toBe(1700000000);
    } finally {
      supabaseProvider.resetSupabaseClient();
    }
  });
});

describe('Payment status poll reconciliation', () => {
  function buildPollService({ lockedStatus = 'pending', providerAmount = 500 } = {}) {
    const service = new PaymentService({
      envMode: 'SANDBOX',
      getOrderStatus: jest.fn().mockResolvedValue({ orderStatus: 'PAID', orderAmount: providerAmount }),
    });
    service.bookingRepository = {
      findByIdAndCustomerId: jest.fn().mockResolvedValue({ id: 'book-1', status: 'payment_pending' }),
    };
    service.paymentRepository = {
      findLatestByBookingId: jest.fn().mockResolvedValue({
        id: 'pay-1', status: 'pending', providerOrderId: 'order-1', amount: 500,
      }),
      transaction: (cb) => cb({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
      lockByProviderOrderId: jest.fn().mockResolvedValue({
        id: 'pay-1', booking_id: 'book-1', amount: '500.00', status: lockedStatus,
        payment_type: PAYMENT_TYPE.BOOKING_ADVANCE,
      }),
    };
    const applySpy = jest.spyOn(service, '_applyPaymentSuccess').mockResolvedValue({ processed: true });
    return { service, applySpy };
  }

  it('applies the full webhook success path (earnings, vehicle, notifications) when the provider reports PAID', async () => {
    const { service, applySpy } = buildPollService();
    await service.getPaymentStatus('cust-1', 'book-1');
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy.mock.calls[0][2]).toMatchObject({ providerOrderId: 'order-1' });
  });

  it('is a no-op when the webhook already marked the payment paid', async () => {
    const { service, applySpy } = buildPollService({ lockedStatus: 'paid' });
    await service.getPaymentStatus('cust-1', 'book-1');
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('does not mark paid when the provider amount differs', async () => {
    const { service, applySpy } = buildPollService({ providerAmount: 1 });
    await service.getPaymentStatus('cust-1', 'book-1');
    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe('Cashfree webhook — late payment for a cancelled booking', () => {
  function buildService(bookingStatus) {
    const queries = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        queries.push({ sql, params });
        if (/SELECT status FROM bookings/.test(sql)) {
          return { rows: [{ status: bookingStatus }] };
        }
        return { rows: [] };
      }),
    };
    const service = new PaymentService({ envMode: 'SANDBOX', verifyWebhookSignature: () => true });
    service.paymentRepository = {
      transaction: (cb) => cb(client),
      lockByProviderOrderId: jest.fn().mockResolvedValue({
        id: 'pay-1',
        booking_id: 'book-1',
        customer_id: 'cust-1',
        amount: '500.00',
        currency: 'INR',
        status: 'pending',
        payment_type: PAYMENT_TYPE.BOOKING_ADVANCE,
      }),
      updateStatus: jest.fn().mockResolvedValue({}),
    };
    return { service, queries };
  }

  const payload = {
    type: 'PAYMENT_SUCCESS_WEBHOOK',
    data: {
      order: { order_id: 'order-1', order_amount: 500, order_currency: 'INR' },
      payment: {
        cf_payment_id: 'cf-1', payment_status: 'SUCCESS', payment_amount: 500, payment_currency: 'INR',
      },
    },
  };

  it('does not move a cancelled booking back to confirmed', async () => {
    const { service, queries } = buildService('cancelled');
    const result = await service.processWebhook({}, JSON.stringify(payload), payload);

    expect(result.bookingConfirmed).toBe(false);
    expect(queries.some((q) => /UPDATE bookings/.test(q.sql))).toBe(false);
    expect(queries.some((q) => /UPDATE vehicles/.test(q.sql))).toBe(false);
  });

  it('puts the late payment into the Admin refund queue exactly once (replay reuses it)', async () => {
    const refunds = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        if (/SELECT status FROM bookings/.test(sql)) return { rows: [{ status: 'cancelled' }] };
        if (/SELECT id FROM refunds/.test(sql)) {
          return { rows: refunds.filter((r) => r.payment_id === params[0] && r.idempotency_key === params[1]) };
        }
        if (/INSERT INTO refunds/.test(sql)) {
          refunds.push({ id: params[0], payment_id: params[3], requested_amount: params[5], idempotency_key: params[8] });
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const service = new PaymentService({ envMode: 'SANDBOX', verifyWebhookSignature: () => true });
    service.paymentRepository = {
      transaction: (cb) => cb(client),
      lockByProviderOrderId: jest.fn().mockResolvedValue({
        id: 'pay-late-1', booking_id: 'book-1', customer_id: 'cust-1', amount: '500.00',
        currency: 'INR', status: 'pending', payment_type: PAYMENT_TYPE.BOOKING_ADVANCE,
      }),
      updateStatus: jest.fn().mockResolvedValue({}),
    };

    const first = await service.processWebhook({}, JSON.stringify(payload), payload);
    const second = await service._applyPaymentSuccess(client, {
      id: 'pay-late-1', booking_id: 'book-1', customer_id: 'cust-1', amount: '500.00',
      currency: 'INR', payment_type: PAYMENT_TYPE.BOOKING_ADVANCE,
    }, { providerOrderId: 'order-1' });

    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toEqual(expect.objectContaining({
      payment_id: 'pay-late-1', requested_amount: 500, idempotency_key: 'late-payment:pay-late-1',
    }));
    expect(first.refundRequestId).toBe(refunds[0].id);
    expect(second.refundRequestId).toBe(refunds[0].id);
  });

  it('a failure recording the refund request never fails the payment update', async () => {
    const { service, queries } = buildService('cancelled');
    const originalQuery = service.paymentRepository.transaction;
    service.paymentRepository.transaction = (cb) => originalQuery((client) => cb({
      query: async (sql, params) => {
        if (/refunds/.test(sql)) throw new Error('relation "refunds" does not exist');
        return client.query(sql, params);
      },
    }));
    const result = await service.processWebhook({}, JSON.stringify(payload), payload);
    expect(result.bookingConfirmed).toBe(false);
    expect(result.refundRequestId).toBeNull();
    expect(service.paymentRepository.updateStatus).toHaveBeenCalled();
    expect(queries.some((q) => /UPDATE bookings/.test(q.sql))).toBe(false);
  });

  it('confirms a booking that is awaiting payment', async () => {
    const { service, queries } = buildService('payment_pending');
    const result = await service.processWebhook({}, JSON.stringify(payload), payload);

    expect(result.bookingConfirmed).not.toBe(false);
    expect(queries.some((q) => /UPDATE bookings/.test(q.sql))).toBe(true);
  });
});
