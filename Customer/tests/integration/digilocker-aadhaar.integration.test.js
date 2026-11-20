'use strict';

const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const crypto = require('crypto');
const { pool } = require('../../src/config/database');
const { setMockFirebaseAuth } = require('../../src/config/firebase');
const { createApp } = require('../../src/app');
const usersMigration = require('../../database/migrations/1726300000000_create-users-table');
const docMigration = require('../../database/migrations/1726400000000_create-customer-documents-table');
const verifMigration = require('../../database/migrations/1729100000000_create-customer-identity-verifications-table');
const { defaultProvider: digiLockerProvider } = require('../../src/providers/digilocker.provider');
const { setMockSupabaseClient, resetSupabaseClient } = require('../../src/providers/supabase');

describe('DigiLocker Aadhaar Verification Integration Tests', () => {
  let app;
  let db;
  let mockPool;
  let mockFirebaseAuth;
  let mockStorageBucket;
  let mockSupabaseClient;

  const customerA = {
    id: '10000000-0000-4000-8000-000000000001',
    role: 'customer',
    name: 'Aadhaar Customer A',
    countryCode: '+91',
    phone: '9876543210',
    email: 'aadhaar_a@example.com',
    authId: 'auth-aadhaar-a',
  };

  const customerB = {
    id: '20000000-0000-4000-8000-000000000002',
    role: 'customer',
    name: 'Aadhaar Customer B',
    countryCode: '+91',
    phone: '9876543211',
    email: 'aadhaar_b@example.com',
    authId: 'auth-aadhaar-b',
  };

  const partnerUser = {
    id: '30000000-0000-4000-8000-000000000003',
    role: 'partner',
    name: 'Partner User',
    countryCode: '+91',
    phone: '9876543212',
    email: 'partner@example.com',
    authId: 'auth-partner-user',
  };

  const validXml = `<?xml version="1.0" encoding="UTF-8"?>
<UidData uid="XXXXXXXX4321">
  <Poi dob="15-08-1992" gender="M" name="Aadhaar Customer A"/>
  <Poa city="Bhopal" dist="Bhopal" state="Madhya Pradesh" pc="462001"/>
</UidData>`;

  beforeAll(async () => {
    // 1. Initialize pg-mem in-memory PostgreSQL
    db = newDb();
    db.registerExtension('pgcrypto', (schema) => {
      schema.registerFunction({
        name: 'gen_random_uuid',
        returns: DataType.uuid,
        impure: true,
        implementation: () => crypto.randomUUID(),
      });
    });

    const pgm = {
      sql: (statement) => {
        if (!statement.includes('LANGUAGE plpgsql') && !statement.includes('TRIGGER') && !statement.includes('POLICY')) {
          db.public.none(statement);
        }
      },
    };

    await usersMigration.up(pgm);
    await docMigration.up(pgm);
    await verifMigration.up(pgm);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();

    pool.query = mockPool.query.bind(mockPool);
    pool.connect = mockPool.connect.bind(mockPool);

    // 2. Mock Firebase / Supabase Auth
    mockFirebaseAuth = {
      verifyIdToken: jest.fn().mockImplementation(async (token) => {
        if (token === 'token-customer-a') {
          return { uid: customerA.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
        }
        if (token === 'token-customer-b') {
          return { uid: customerB.authId, auth_time: Math.floor(Date.now() / 1000), role: 'customer' };
        }
        if (token === 'token-partner') {
          return { uid: partnerUser.authId, auth_time: Math.floor(Date.now() / 1000), role: 'partner' };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/argument-error';
        throw err;
      }),
    };
    setMockFirebaseAuth(mockFirebaseAuth);

    // 3. Seed users
    db.public.none(`
      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customerA.id}', '${customerA.role}', '${customerA.name}', '${customerA.countryCode}', '${customerA.phone}', '${customerA.email}', 'supabase', '${customerA.authId}', true),
        ('${customerB.id}', '${customerB.role}', '${customerB.name}', '${customerB.countryCode}', '${customerB.phone}', '${customerB.email}', 'supabase', '${customerB.authId}', true),
        ('${partnerUser.id}', '${partnerUser.role}', '${partnerUser.name}', '${partnerUser.countryCode}', '${partnerUser.phone}', '${partnerUser.email}', 'supabase', '${partnerUser.authId}', true);
    `);

    // 4. Configure DigiLocker mock delegate
    digiLockerProvider.setMockDelegate({
      initiateSession: async ({ customerId, state, redirectUri }) => ({
        authorizationUrl: `https://api.digitallocker.gov.in/public/oauth2/1/authorize?client_id=test&state=${state}`,
        state: state || 'mock_state_123',
        provider: 'DIGILOCKER_SANDBOX',
        providerReferenceId: 'digilocker_ref_integration_1',
      }),
      exchangeCodeForToken: async ({ code }) => ({
        accessToken: `access_token_${code}`,
        tokenType: 'Bearer',
        expiresIn: 3600,
        digilockerId: 'dl_user_int_1',
      }),
      fetchAadhaarXml: async () => ({
        xmlContent: validXml,
        documentType: 'AADHAAR',
        maskedAadhaar: 'XXXX-XXXX-4321',
        isAuthorized: true,
      }),
    });

    // 5. Configure mock Supabase storage
    mockStorageBucket = {
      upload: jest.fn().mockResolvedValue({ data: { path: 'mock-storage-path.xml' }, error: null }),
      createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.supabase.local/signed-url' }, error: null }),
    };
    mockSupabaseClient = {
      storage: {
        from: jest.fn().mockReturnValue(mockStorageBucket),
      },
    };
    setMockSupabaseClient(mockSupabaseClient);

    app = createApp();
  });

  afterAll(() => {
    digiLockerProvider.setMockDelegate(null);
    resetSupabaseClient();
  });

  describe('POST /api/v1/customers/me/aadhaar/initiate', () => {
    it('returns 401 without Bearer token', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate');

      expect(res.status).toBe(401);
    });

    it('returns 403 for partner user', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-partner');

      expect(res.status).toBe(403);
    });

    it('successfully initiates DigiLocker session for authenticated customer', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-customer-a')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('verificationId');
      expect(res.body.data).toHaveProperty('authorizationUrl');
      expect(res.body.data).toHaveProperty('state');
      expect(res.body.data.provider).toBe('DIGILOCKER_SANDBOX');

      // Verify PostgreSQL record was inserted
      const rows = db.public.many(`SELECT * FROM customer_identity_verifications WHERE id = '${res.body.data.verificationId}';`);
      expect(rows).toHaveLength(1);
      expect(rows[0].customer_id).toBe(customerA.id);
      expect(rows[0].verification_status).toBe('IN_PROGRESS');
    });
  });

  describe('GET /api/v1/customers/aadhaar/callback', () => {
    let activeState;
    let activeVerificationId;

    beforeEach(async () => {
      const initRes = await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-customer-a');

      activeState = initRes.body.data.state;
      activeVerificationId = initRes.body.data.verificationId;
    });

    it('completes verification on valid authorization code callback', async () => {
      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({
          state: activeState,
          code: 'valid_auth_code_999',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('VERIFIED');
      expect(res.body.data.maskedAadhaar).toBe('XXXX-XXXX-4321');

      // Verify database updated
      const rows = db.public.many(`SELECT * FROM customer_identity_verifications WHERE id = '${activeVerificationId}';`);
      expect(rows[0].verification_status).toBe('VERIFIED');
      expect(rows[0].verified_at).not.toBeNull();
    });

    it('is idempotent on duplicate callback requests', async () => {
      // First call
      await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ state: activeState, code: 'valid_auth_code_999' });

      // Second call
      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ state: activeState, code: 'valid_auth_code_999' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('VERIFIED');
    });

    it('handles user cancellation callback and marks record CANCELLED', async () => {
      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({
          state: activeState,
          error: 'access_denied',
          error_description: 'User denied authorization in DigiLocker',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');

      const rows = db.public.many(`SELECT * FROM customer_identity_verifications WHERE id = '${activeVerificationId}';`);
      expect(rows[0].verification_status).toBe('CANCELLED');
    });

    it('renders HTML bridge page when browser requests text/html', async () => {
      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'text/html')
        .query({
          state: activeState,
          code: 'valid_auth_code_999',
        });

      expect(res.status).toBe(200);
      expect(res.text).toContain('gongo://aadhaar-verification/result');
      expect(res.text).toContain('Return to GONGO App');
    });

    it('allows unauthenticated browser callback without Bearer token (rejects on missing state, not auth)', async () => {
      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AADHAAR_MISSING_STATE');
    });

    it('rejects unauthenticated callback with unknown state with 400 AADHAAR_INVALID_SESSION', async () => {
      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ state: 'unknown_unauthenticated_state' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AADHAAR_INVALID_SESSION');
    });

    it('renders HTML error card when browser with text/html encounters invalid session', async () => {
      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'text/html')
        .query({ state: 'unknown_state_for_browser' });

      expect(res.status).toBe(400);
      expect(res.text).toContain('Verification Failed');
      expect(res.text).toContain('Return to GONGO App');
    });
  });

  describe('GET /api/v1/customers/me/aadhaar/status', () => {
    it('returns NOT_VERIFIED for customer B who has not initiated', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/aadhaar/status')
        .set('Authorization', 'Bearer token-customer-b');

      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('NOT_VERIFIED');
      expect(res.body.data.isVerified).toBe(false);
    });

    it('returns VERIFIED for customer A after completed verification', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me/aadhaar/status')
        .set('Authorization', 'Bearer token-customer-a');

      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toBe('VERIFIED');
      expect(res.body.data.isVerified).toBe(true);
      expect(res.body.data.maskedAadhaar).toBe('XXXX-XXXX-4321');
    });
  });

  describe('GET /api/v1/customers/me/aadhaar/:verificationId/signed-url', () => {
    it('blocks Customer B from obtaining signed download URL for Customer A document', async () => {
      // Find Customer A verification
      const rows = db.public.many(`SELECT id FROM customer_identity_verifications WHERE customer_id = '${customerA.id}' AND verification_status = 'VERIFIED';`);
      const verificationId = rows[0].id;

      // Customer B tries to access Customer A's verification
      const res = await request(app)
        .get(`/api/v1/customers/me/aadhaar/${verificationId}/signed-url`)
        .set('Authorization', 'Bearer token-customer-b');

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/customers/me profile parity', () => {
    it('returns aadhaarStatus in verificationStatus DTO', async () => {
      const res = await request(app)
        .get('/api/v1/customers/me')
        .set('Authorization', 'Bearer token-customer-a');

      expect(res.status).toBe(200);
      expect(res.body.data.verificationStatus).toHaveProperty('aadhaarStatus');
      expect(res.body.data.verificationStatus.aadhaarStatus).toBe('VERIFIED');
    });
  });
});
