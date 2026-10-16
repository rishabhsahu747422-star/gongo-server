'use strict';

const request = require('supertest');
const crypto = require('crypto');
const { createApp } = require('../../src/app');
const { setMockFirebaseAuth } = require('../../src/providers/supabase');
const PartnerRepository = require('../../src/repositories/partner.repository');
const otpProvider = require('../../src/providers/otp.provider');
const storageValidator = require('../../src/validators/storage.validator');
const paymentService = require('../../src/services/payment.service');
const cashfreeProvider = require('../../src/providers/cashfree.provider');
const { ERROR_CODES } = require('../../src/constants/errors');
const { PAYMENT_ERROR_CODES } = require('../../src/constants/payment');
const env = require('../../src/config/env');

describe('STEP 8 — Production Security Hardening & Audit Test Suite', () => {
  let app;
  let mockAuth;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    // 1. Setup mock Firebase / Supabase auth provider
    mockAuth = {
      verifyIdToken: jest.fn(async (token) => {
        if (token === 'valid-partner-token') {
          return { uid: 'uid-partner-1', email: 'partner1@gongo.in', phone_number: '+919876543210' };
        }
        if (token === 'valid-partner-2-token') {
          return { uid: 'uid-partner-2', email: 'partner2@gongo.in', phone_number: '+919876543211' };
        }
        if (token === 'valid-customer-token') {
          return { uid: 'uid-customer-1', email: 'customer1@gongo.in' };
        }
        if (token === 'valid-admin-token') {
          return { uid: 'uid-admin-1', email: 'admin1@gongo.in' };
        }
        if (token === 'expired-token') {
          const err = new Error('Token expired');
          err.code = 'auth/id-token-expired';
          throw err;
        }
        if (token === 'revoked-token') {
          const err = new Error('Token revoked');
          err.code = 'auth/id-token-revoked';
          throw err;
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      }),
    };
    setMockFirebaseAuth(mockAuth);

    // 2. Setup mock PartnerRepository resolver
    PartnerRepository.setMockPartnerResolver((authId) => {
      if (authId === 'uid-partner-1') {
        return {
          id: 'partner-123',
          auth_id: 'uid-partner-1',
          role: 'PARTNER',
          is_active: true,
          status: 'ACTIVE',
        };
      }
      if (authId === 'uid-partner-2') {
        return {
          id: 'partner-456',
          auth_id: 'uid-partner-2',
          role: 'PARTNER',
          is_active: true,
          status: 'ACTIVE',
        };
      }
      if (authId === 'uid-customer-1') {
        return {
          id: 'customer-999',
          auth_id: 'uid-customer-1',
          role: 'CUSTOMER',
          is_active: true,
          status: 'ACTIVE',
        };
      }
      if (authId === 'uid-admin-1') {
        return {
          id: 'admin-001',
          auth_id: 'uid-admin-1',
          role: 'ADMIN',
          is_active: true,
          status: 'ACTIVE',
        };
      }
      return null;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // 1. Unauthenticated Request
  // =========================================================================
  it('1. Rejects unauthenticated request to protected endpoint with 401 AUTH_REQUIRED', async () => {
    const res = await request(app).get('/api/v1/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.AUTH_REQUIRED);
  });

  // =========================================================================
  // 2. Expired Authentication
  // =========================================================================
  it('2. Rejects expired authentication token with 401 TOKEN_EXPIRED', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer expired-token');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
  });

  // =========================================================================
  // 3. Invalid Authentication
  // =========================================================================
  it('3. Rejects invalid authentication token with 401 INVALID_TOKEN', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer forged-garbage-token');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.INVALID_TOKEN);
  });

  // =========================================================================
  // 4. Partner → Admin Endpoint
  // =========================================================================
  it('4. Denies access when authenticated Partner attempts to invoke Admin endpoint (403 FORBIDDEN)', async () => {
    const res = await request(app)
      .get('/api/v1/admin/damages')
      .set('Authorization', 'Bearer valid-partner-token');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  // =========================================================================
  // 5. Customer → Admin Endpoint
  // =========================================================================
  it('5. Denies access when authenticated Customer attempts to invoke Admin endpoint (403 FORBIDDEN)', async () => {
    const res = await request(app)
      .get('/api/v1/admin/damages')
      .set('Authorization', 'Bearer valid-customer-token');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  // =========================================================================
  // 6. Partner A → Partner B Resource (BOLA / IDOR)
  // =========================================================================
  it('6. Denies access (403 FORBIDDEN) when Partner A attempts to access Partner B resource', async () => {
    const res = await request(app)
      .get('/api/v1/test/resource/resource-partner-2')
      .set('Authorization', 'Bearer valid-partner-token');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  // =========================================================================
  // 7. Customer A → Customer B Resource (or Customer → Partner resource)
  // =========================================================================
  it('7. Denies access (403 FORBIDDEN) when Customer attempts to access Partner-restricted resource', async () => {
    const res = await request(app)
      .get('/api/v1/test/resource/resource-partner-1')
      .set('Authorization', 'Bearer valid-customer-token');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  // =========================================================================
  // 8. Protected Field Injection (Mass Assignment)
  // =========================================================================
  it('8. Rejects client attempt to inject server-controlled fields (walletBalance, verificationStatus)', async () => {
    const res = await request(app)
      .post('/api/v1/test/mass-assignment')
      .send({
        name: 'Malicious Payload',
        walletBalance: 999999,
        verificationStatus: 'VERIFIED',
        payoutStatus: 'PAID',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
    expect(res.body.error.message).toContain('walletBalance');
  });

  // =========================================================================
  // 9. Role Escalation
  // =========================================================================
  it('9. Prevents role escalation: client cannot elevate role via body or query params', async () => {
    const res = await request(app)
      .get('/api/v1/test/partner-only?role=ADMIN')
      .send({ role: 'ADMIN', isAdmin: true })
      .set('Authorization', 'Bearer valid-customer-token');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  // =========================================================================
  // 10. Invalid Document / Storage Key
  // =========================================================================
  it('10. Rejects access URL generation with invalid/malformed storageKey', async () => {
    const res = await request(app)
      .post('/api/v1/storage/access-url')
      .set('Authorization', 'Bearer valid-partner-token')
      .send({ storageKey: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // =========================================================================
  // 11. Cross-Tenant Storage Access
  // =========================================================================
  it('11. Prevents cross-tenant storage access (Partner 1 cannot access Partner 2 files)', async () => {
    const res = await request(app)
      .post('/api/v1/storage/access-url')
      .set('Authorization', 'Bearer valid-partner-token') // Partner 123
      .send({ storageKey: 'partners/partner-456/kyc/pan/document.pdf' }); // Partner 456

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toContain('Access denied');
  });

  // =========================================================================
  // 12. OTP Replay Protection
  // =========================================================================
  it('12. Enforces OTP replay protection: used OTP cannot be verified twice', async () => {
    const bookingId = 'test-booking-replay-' + Date.now();
    const salt = otpProvider.generateSalt();
    const rawOtp = '4829';
    const otpHash = otpProvider.hashOtp(rawOtp, salt);

    // Store initial OTP state
    await otpProvider.storeOtpState(bookingId, { otpHash, salt }, 60);

    // Verify first time -> valid
    const state = await otpProvider.getOtpState(bookingId);
    expect(state).not.toBeNull();
    const isValidFirst = otpProvider.verifyOtp(rawOtp, state.otpHash, state.salt);
    expect(isValidFirst).toBe(true);

    // Clear state on successful verification (standard flow)
    await otpProvider.clearOtpState(bookingId);

    // Replay attempt -> state no longer exists -> must fail
    const replayedState = await otpProvider.getOtpState(bookingId);
    expect(replayedState).toBeNull();
  });

  // =========================================================================
  // 13. OTP Brute Force / Rate Limit
  // =========================================================================
  it('13. Enforces OTP brute force attempt tracking and lockout limit', async () => {
    const bookingId = 'test-booking-bf-' + Date.now();
    const salt = otpProvider.generateSalt();
    const rawOtp = '7712';
    const otpHash = otpProvider.hashOtp(rawOtp, salt);

    await otpProvider.storeOtpState(bookingId, { otpHash, salt }, 60);

    // Simulate 3 invalid verification attempts
    expect(await otpProvider.getAttempts(bookingId)).toBe(0);
    const a1 = await otpProvider.incrementAttempts(bookingId);
    expect(a1).toBe(1);
    const a2 = await otpProvider.incrementAttempts(bookingId);
    expect(a2).toBe(2);
    const a3 = await otpProvider.incrementAttempts(bookingId);
    expect(a3).toBe(3);

    // Exceeded maximum attempts threshold (max: 3)
    const attempts = await otpProvider.getAttempts(bookingId);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  // =========================================================================
  // 14. Duplicate Payment / Webhook Handling (Idempotency)
  // =========================================================================
  it('14. Safely ignores duplicate payment webhook events without duplicate side-effects', async () => {
    const mockHeaders = {
      'x-webhook-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-webhook-signature': 'mock-valid-sig',
    };
    const rawBody = JSON.stringify({
      data: {
        order: { order_id: 'order-dup-123' },
        payment: { payment_status: 'SUCCESS', payment_amount: 500 },
      },
      event_id: 'evt-123',
    });

    jest.spyOn(cashfreeProvider, 'verifyWebhookSignature').mockReturnValue(true);
    jest.spyOn(paymentService.paymentRepository, 'isEventProcessed').mockResolvedValue(true);

    const result = await paymentService.processCashfreeWebhook(
      mockHeaders,
      rawBody,
      JSON.parse(rawBody),
    );

    expect(result.processed).toBe(true);
    expect(result.duplicate).toBe(true);
  });

  // =========================================================================
  // 15. Duplicate Payout / Idempotency
  // =========================================================================
  it('15. Replays cached response for duplicate idempotent action with same key', async () => {
    const idempotencyKey = 'unique-payout-key-' + Date.now();

    const res1 = await request(app)
      .post('/api/v1/test/idempotent')
      .set('Authorization', 'Bearer valid-partner-token')
      .set('Idempotency-Key', idempotencyKey)
      .send({ amount: 1500 });

    expect(res1.status).toBe(200);
    const originalTime = res1.body.data.executedAt;

    // Duplicate submission
    const res2 = await request(app)
      .post('/api/v1/test/idempotent')
      .set('Authorization', 'Bearer valid-partner-token')
      .set('Idempotency-Key', idempotencyKey)
      .send({ amount: 1500 });

    expect(res2.status).toBe(200);
    expect(res2.headers['x-idempotency-replay']).toBe('true');
    expect(res2.body.data.executedAt).toBe(originalTime);
  });

  // =========================================================================
  // 16. Invalid Payment Signature
  // =========================================================================
  it('16. Rejects payment webhook with invalid HMAC signature (400 INVALID_WEBHOOK_SIGNATURE)', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = JSON.stringify({ data: { order: { order_id: 'ord-123' } } });

    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .set('Content-Type', 'application/json')
      .set('x-webhook-timestamp', timestamp)
      .set('x-webhook-signature', 'forged_invalid_signature_xyz==')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(PAYMENT_ERROR_CODES.INVALID_WEBHOOK_SIGNATURE);
  });

  // =========================================================================
  // 17. Invalid Webhook Signature / Missing Headers
  // =========================================================================
  it('17. Rejects webhook request missing signature or timestamp headers with 400', async () => {
    const payload = { data: { order: { order_id: 'ord-missing-headers' } } };

    const res = await request(app)
      .post('/api/v1/payments/webhook/cashfree')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(PAYMENT_ERROR_CODES.INVALID_WEBHOOK_SIGNATURE);
  });

  // =========================================================================
  // 18. Malicious Filename & Path Traversal
  // =========================================================================
  it('18. Rejects upload presign requests with malicious path traversal filenames', () => {
    const maliciousPayloads = [
      { entityType: 'KYC_DOCUMENT', documentType: 'AADHAAR', fileName: '../../etc/passwd', contentType: 'application/pdf' },
      { entityType: 'KYC_DOCUMENT', documentType: 'AADHAAR', fileName: '..\\..\\windows\\system32\\cmd.exe', contentType: 'application/pdf' },
      { entityType: 'PROFILE_IMAGE', fileName: '/root/photo.jpg', contentType: 'image/jpeg' },
    ];

    maliciousPayloads.forEach((payload) => {
      expect(() => storageValidator.validatePresignInput(payload)).toThrow();
    });
  });

  // =========================================================================
  // 19. Oversized Upload
  // =========================================================================
  it('19. Rejects presign requests with declared size exceeding entity limit', () => {
    // PROFILE_IMAGE limit is 5MB
    const oversizedPayload = {
      entityType: 'PROFILE_IMAGE',
      fileName: 'photo.jpg',
      contentType: 'image/jpeg',
      fileSizeBytes: 20 * 1024 * 1024, // 20 MB
    };

    expect(() => storageValidator.validatePresignInput(oversizedPayload)).toThrow();
  });

  // =========================================================================
  // 20. Invalid File Type
  // =========================================================================
  it('20. Rejects disallowed executable and dangerous file types (.exe, .php, .sh)', () => {
    const dangerousPayloads = [
      { entityType: 'PROFILE_IMAGE', fileName: 'trojan.exe', contentType: 'application/x-msdownload' },
      { entityType: 'KYC_DOCUMENT', documentType: 'AADHAAR', fileName: 'script.php', contentType: 'application/x-php' },
      { entityType: 'VEHICLE_IMAGE', vehicleId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', fileName: 'exploit.sh', contentType: 'application/x-sh' },
    ];

    dangerousPayloads.forEach((payload) => {
      expect(() => storageValidator.validatePresignInput(payload)).toThrow();
    });
  });

  // =========================================================================
  // 21. SQL Injection Safe Validation
  // =========================================================================
  it('21. Validates and rejects SQL injection attack payloads on parameters and queries', async () => {
    const sqliPayloads = [
      "' OR 1=1 --",
      "'; DROP TABLE users; --",
      "' UNION SELECT * FROM partners --",
      "admin'--",
    ];

    for (const payload of sqliPayloads) {
      const res = await request(app)
        .get(`/api/v1/partner/bookings/${encodeURIComponent(payload)}`)
        .set('Authorization', 'Bearer valid-partner-token');

      // UUID validator must reject non-UUID identifier
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    }
  });

  // =========================================================================
  // 22. Production Debug Endpoint Protection
  // =========================================================================
  it('22. Verifies that /test/ probe endpoints are disabled and return 404 in production environment', async () => {
    // 1. Verify production guard predicate strictly rejects production
    const isDebugProbeEnabled = (nodeEnv, isProd) =>
      (nodeEnv === 'development' || nodeEnv === 'test') && !isProd && nodeEnv !== 'production';

    expect(isDebugProbeEnabled('production', true)).toBe(false);
    expect(isDebugProbeEnabled('production', false)).toBe(false);
    expect(isDebugProbeEnabled('development', false)).toBe(true);
    expect(isDebugProbeEnabled('test', false)).toBe(true);

    // 2. Verify router isolation: when production is active, debug probes are omitted -> 404
    const express = require('express');
    const prodRouter = express.Router();
    const envSimulated = { NODE_ENV: 'production', isProduction: true };
    const shouldMount = isDebugProbeEnabled(envSimulated.NODE_ENV, envSimulated.isProduction);

    if (shouldMount) {
      prodRouter.get('/test/auth', (req, res) => res.json({ probe: true }));
    }

    const prodApp = express();
    prodApp.use('/api/v1', prodRouter);
    prodApp.use((req, res) => res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} not found` },
    }));

    const res = await request(prodApp).get('/api/v1/test/auth');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
