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
const linksMigration = require('../../database/migrations/1729200000000_create-customer-identity-links-table');
const { defaultProvider: digiLockerProvider } = require('../../src/providers/digilocker.provider');
const { setMockSupabaseClient, resetSupabaseClient } = require('../../src/providers/supabase');

describe('DigiLocker Aadhaar Verification Integration Tests', () => {
  let app;
  let db;
  let mockPool;
  let mockFirebaseAuth;
  let mockStorageBucket;
  let mockSupabaseClient;
  let defaultMockDelegate;

  const customerA = {
    id: '10000000-0000-4000-8000-000000000001',
    role: 'customer',
    name: 'Initial Customer A',
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
    await linksMigration.up(pgm);

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

    // 3. Seed users and customer_profiles
    db.public.none(`
      CREATE TABLE IF NOT EXISTS customer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE NOT NULL REFERENCES users(id),
        full_name VARCHAR(255),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO users (id, role, name, country_code, phone, email, auth_provider, auth_id, is_active)
      VALUES
        ('${customerA.id}', '${customerA.role}', '${customerA.name}', '${customerA.countryCode}', '${customerA.phone}', '${customerA.email}', 'supabase', '${customerA.authId}', true),
        ('${customerB.id}', '${customerB.role}', '${customerB.name}', '${customerB.countryCode}', '${customerB.phone}', '${customerB.email}', 'supabase', '${customerB.authId}', true),
        ('${partnerUser.id}', '${partnerUser.role}', '${partnerUser.name}', '${partnerUser.countryCode}', '${partnerUser.phone}', '${partnerUser.email}', 'supabase', '${partnerUser.authId}', true);

      INSERT INTO customer_profiles (user_id, full_name)
      VALUES
        ('${customerA.id}', '${customerA.name}'),
        ('${customerB.id}', '${customerB.name}');
    `);

    // 4. Configure DigiLocker mock delegate
    defaultMockDelegate = {
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
      getSessionStatus: async (sessionId) => ({
        status: 'succeeded',
        isCompleted: true,
      }),
    };
    digiLockerProvider.setMockDelegate(defaultMockDelegate);

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

  afterEach(() => {
    digiLockerProvider.setMockDelegate(defaultMockDelegate);
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

      // Verify profile name synchronized to users and customer_profiles tables
      const userRows = db.public.many(`SELECT name FROM users WHERE id = '${customerA.id}';`);
      expect(userRows[0].name).toBe('Aadhaar Customer A');
      const profileRows = db.public.many(`SELECT full_name FROM customer_profiles WHERE user_id = '${customerA.id}';`);
      expect(profileRows[0].full_name).toBe('Aadhaar Customer A');
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
      expect(res.text).toContain('intent://aadhaar-verification/result');
      expect(res.text).toContain('package=com.gongo.gongocustomer');
      expect(res.text).toContain('openGongoApp');
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
      expect(res.text).toContain('intent://aadhaar-verification/result');
      expect(res.text).toContain('openGongoApp');
    });

    it('completes verification via Sandbox redirect with session_id query param and no state', async () => {
      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ session_id: 'digilocker_ref_integration_1' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('VERIFIED');
    });

    it('completes verification via POST callback with session_id in request body', async () => {
      const res = await request(app)
        .post('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .send({ session_id: 'digilocker_ref_integration_1' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('VERIFIED');
    });

    it('rejects callback if session has expired beyond TTL', async () => {
      const initRes = await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-customer-b');
      const expiredVerifId = initRes.body.data.verificationId;
      const expiredState = initRes.body.data.state;

      // Age this record beyond 15m
      const expiredDate = new Date(Date.now() - 1000 * 60 * 30).toISOString();
      db.public.none(`UPDATE customer_identity_verifications SET created_at = '${expiredDate}' WHERE id = '${expiredVerifId}';`);

      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ state: expiredState });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AADHAAR_SESSION_EXPIRED');

      // Clean up customer B test record to preserve subsequent tests
      db.public.none(`DELETE FROM customer_identity_verifications WHERE customer_id = '${customerB.id}';`);
    });

    it('rejects Sandbox callback when provider reports pending authorization (status: created)', async () => {
      digiLockerProvider.setMockDelegate({
        initiateSession: async () => ({ authorizationUrl: 'https://sandbox.co.in/auth', state: 's', provider: 'DIGILOCKER_SANDBOX', providerReferenceId: 'sess_pend' }),
        getSessionStatus: async () => ({ status: 'created', isPending: true, isAuthorized: false, isCompleted: false }),
      });

      // Create a fresh pending session in DB
      const initRes = await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-customer-b');
      const sessId = initRes.body.data.state;

      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ session_id: 'sess_pend' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AADHAAR_SESSION_NOT_COMPLETED');

      db.public.none(`DELETE FROM customer_identity_verifications WHERE customer_id = '${customerB.id}';`);
    });

    it('rejects Sandbox callback when provider reports authorization failed (status: failed)', async () => {
      digiLockerProvider.setMockDelegate({
        initiateSession: async () => ({ authorizationUrl: 'https://sandbox.co.in/auth', state: 's', provider: 'DIGILOCKER_SANDBOX', providerReferenceId: 'sess_failed' }),
        getSessionStatus: async () => ({ status: 'failed', isFailed: true, isAuthorized: false, isCompleted: false }),
      });

      await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-customer-b');

      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ session_id: 'sess_failed' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AADHAAR_SESSION_FAILED');

      db.public.none(`DELETE FROM customer_identity_verifications WHERE customer_id = '${customerB.id}';`);
    });

    it('rejects Sandbox callback when provider reports session expired (status: expired)', async () => {
      digiLockerProvider.setMockDelegate({
        initiateSession: async () => ({ authorizationUrl: 'https://sandbox.co.in/auth', state: 's', provider: 'DIGILOCKER_SANDBOX', providerReferenceId: 'sess_exp' }),
        getSessionStatus: async () => ({ status: 'expired', isExpired: true, isAuthorized: false, isCompleted: false }),
      });

      await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-customer-b');

      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ session_id: 'sess_exp' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AADHAAR_SESSION_EXPIRED');

      db.public.none(`DELETE FROM customer_identity_verifications WHERE customer_id = '${customerB.id}';`);
    });

    it('rejects Sandbox callback when documents_consented does not include aadhaar', async () => {
      digiLockerProvider.setMockDelegate({
        initiateSession: async () => ({ authorizationUrl: 'https://sandbox.co.in/auth', state: 's', provider: 'DIGILOCKER_SANDBOX', providerReferenceId: 'sess_nodoc' }),
        getSessionStatus: async () => ({ status: 'succeeded', isAuthorized: true, isCompleted: true, documentsConsented: ['pan'] }),
      });

      await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-customer-b');

      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ session_id: 'sess_nodoc' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AADHAAR_CONSENT_MISSING');

      db.public.none(`DELETE FROM customer_identity_verifications WHERE customer_id = '${customerB.id}';`);
    });

    it('rejects callback with 503 STORAGE_UPLOAD_ERROR when Supabase storage bucket is not found or fails', async () => {
      // Mock storage upload failure
      mockStorageBucket.upload.mockResolvedValueOnce({
        data: null,
        error: { message: 'Bucket not found', statusCode: 404 },
      });

      const origFetch = defaultMockDelegate.fetchAadhaarXml;
      defaultMockDelegate.fetchAadhaarXml = async () => ({
        xmlContent: `<?xml version="1.0" encoding="UTF-8"?><UidData uid="XXXXXXXX9876"><Poi dob="20-10-1995" gender="F" name="Aadhaar Customer B"/></UidData>`,
        documentType: 'AADHAAR',
        maskedAadhaar: 'XXXX-XXXX-9876',
        isAuthorized: true,
      });

      try {
        const initRes = await request(app)
          .post('/api/v1/customers/me/aadhaar/initiate')
          .set('Authorization', 'Bearer token-customer-b');
        const failVerifId = initRes.body.data.verificationId;
        const failState = initRes.body.data.state;

        const res = await request(app)
          .get('/api/v1/customers/aadhaar/callback')
          .set('Accept', 'application/json')
          .query({ state: failState });

        expect(res.status).toBe(503);
        expect(res.body.code).toBe('STORAGE_UPLOAD_ERROR');

        // Verify DB record marked FAILED
        const rows = db.public.many(`SELECT verification_status FROM customer_identity_verifications WHERE id = '${failVerifId}';`);
        expect(rows[0].verification_status).toBe('FAILED');
      } finally {
        defaultMockDelegate.fetchAadhaarXml = origFetch;
        db.public.none(`DELETE FROM customer_identity_verifications WHERE customer_id = '${customerB.id}';`);
      }
    });

    it('rejects duplicate verification with 409 IDENTITY_ALREADY_LINKED when same Aadhaar identity is verified on another customer account', async () => {
      // Customer B initiates verification
      const initRes = await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-customer-b');
      const bState = initRes.body.data.state;
      const bVerifId = initRes.body.data.verificationId;

      // Mock delegate returns validXml which belongs to Customer A
      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ state: bState, code: 'code_for_customer_b' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDENTITY_ALREADY_LINKED');
      expect(res.body.message).toContain('already verified on another account');

      // Verify Customer B's profile name remains untouched
      const userRow = db.public.one(`SELECT name FROM users WHERE id = '${customerB.id}';`);
      expect(userRow.name).toBe('Aadhaar Customer B');

      // Verify Customer B's verification record marked FAILED
      const verifRow = db.public.one(`SELECT verification_status FROM customer_identity_verifications WHERE id = '${bVerifId}';`);
      expect(verifRow.verification_status).toBe('FAILED');

      db.public.none(`DELETE FROM customer_identity_verifications WHERE id = '${bVerifId}';`);
    });

    it('allows re-verification of the same Aadhaar identity by the same customer', async () => {
      // Customer A initiates another verification
      const initRes = await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-customer-a');
      const aState2 = initRes.body.data.state;
      const aVerifId2 = initRes.body.data.verificationId;

      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ state: aState2, code: 'code_reverify_customer_a' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('VERIFIED');

      // Verify identity link now points to latest verification ID
      const linkRow = db.public.one(`SELECT verification_id FROM customer_identity_links WHERE customer_id = '${customerA.id}';`);
      expect(linkRow.verification_id).toBe(aVerifId2);

      db.public.none(`DELETE FROM customer_identity_verifications WHERE id = '${aVerifId2}';`);
    });

    it('rejects callback with 400 AADHAAR_MISSING_NAME when XML has empty or missing name attribute in Poi element', async () => {
      digiLockerProvider.setMockDelegate({
        initiateSession: async () => ({ authorizationUrl: 'https://sandbox.co.in/auth', state: 's', provider: 'DIGILOCKER_SANDBOX', providerReferenceId: 'sess_noname' }),
        getSessionStatus: async () => ({ status: 'succeeded', isAuthorized: true, isCompleted: true }),
        fetchAadhaarXml: async () => ({
          xmlContent: `<?xml version="1.0" encoding="UTF-8"?><UidData uid="XXXXXXXX9999"><Poi dob="01-01-1990" gender="M" name="   "/></UidData>`,
          documentType: 'AADHAAR',
          maskedAadhaar: 'XXXX-XXXX-9999',
          isAuthorized: true,
        }),
      });

      const initRes = await request(app)
        .post('/api/v1/customers/me/aadhaar/initiate')
        .set('Authorization', 'Bearer token-customer-b');
      const noNameState = initRes.body.data.state;
      const noNameVerifId = initRes.body.data.verificationId;

      const res = await request(app)
        .get('/api/v1/customers/aadhaar/callback')
        .set('Accept', 'application/json')
        .query({ state: noNameState });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AADHAAR_MISSING_NAME');

      // Verify Customer B's name is unchanged
      const userRow = db.public.one(`SELECT name FROM users WHERE id = '${customerB.id}';`);
      expect(userRow.name).toBe('Aadhaar Customer B');

      db.public.none(`DELETE FROM customer_identity_verifications WHERE id = '${noNameVerifId}';`);
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

  describe('POST /api/v1/customers/me/aadhaar/check-availability', () => {
    it('returns 401 without Bearer token', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/aadhaar/check-availability')
        .send({ aadhaarNumber: '5421 8976 3412' });

      expect(res.status).toBe(401);
    });

    it('returns 400 when Aadhaar number is invalid or malformed', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/aadhaar/check-availability')
        .set('Authorization', 'Bearer token-customer-b')
        .send({ aadhaarNumber: '12345' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_AADHAAR_FORMAT');
    });

    it('returns 400 when Aadhaar number contains repeating digits', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/aadhaar/check-availability')
        .set('Authorization', 'Bearer token-customer-b')
        .send({ aadhaarNumber: '000000000000' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_AADHAAR_FORMAT');
    });

    it('returns isAvailable: true for an unlinked 12-digit Aadhaar number', async () => {
      const res = await request(app)
        .post('/api/v1/customers/me/aadhaar/check-availability')
        .set('Authorization', 'Bearer token-customer-b')
        .send({ aadhaarNumber: '7654 3210 9876' });

      expect(res.status).toBe(200);
      expect(res.body.data.isAvailable).toBe(true);
      expect(res.body.data.message).toBe('Aadhaar is available for verification.');
      // Never returns raw Aadhaar or fingerprint
      expect(res.body.data).not.toHaveProperty('identityHash');
      expect(res.body.data).not.toHaveProperty('aadhaarNumber');
    });

    it('returns isAvailable: false with IDENTITY_ALREADY_LINKED when already linked to another customer', async () => {
      // First link an Aadhaar to customer A in customer_identity_links
      const testAadhaar = '5421 8976 3412';
      const normalized = testAadhaar.replace(/\s/g, '');
      const crypto = require('crypto');
      const testHash = crypto.createHmac('sha256', process.env.AADHAAR_HMAC_SECRET || 'gongo-aadhaar-identity-hmac-secret-v1')
        .update(normalized)
        .digest('hex');

      db.public.none(`
        INSERT INTO customer_identity_links (id, customer_id, identity_hash, id_type)
        VALUES ('33333333-3333-4333-8333-333333333333', '${customerA.id}', '${testHash}', 'AADHAAR')
        ON CONFLICT (identity_hash) DO NOTHING;
      `);

      try {
        // Customer B checks availability for customer A's Aadhaar
        const res = await request(app)
          .post('/api/v1/customers/me/aadhaar/check-availability')
          .set('Authorization', 'Bearer token-customer-b')
          .send({ aadhaarNumber: testAadhaar });

        expect(res.status).toBe(200);
        expect(res.body.data.isAvailable).toBe(false);
        expect(res.body.data.reason).toBe('IDENTITY_ALREADY_LINKED');
        expect(res.body.data.message).toContain('already associated with a verified account');
        // Does not leak Customer A ID
        expect(res.body.data).not.toHaveProperty('customerId');
      } finally {
        db.public.none(`DELETE FROM customer_identity_links WHERE id = '33333333-3333-4333-8333-333333333333';`);
      }
    });

    it('returns isAvailable: true when the SAME customer checks their already linked Aadhaar', async () => {
      const testAadhaar = '5421 8976 3412';
      const normalized = testAadhaar.replace(/\s/g, '');
      const crypto = require('crypto');
      const testHash = crypto.createHmac('sha256', process.env.AADHAAR_HMAC_SECRET || 'gongo-aadhaar-identity-hmac-secret-v1')
        .update(normalized)
        .digest('hex');

      db.public.none(`
        INSERT INTO customer_identity_links (id, customer_id, identity_hash, id_type)
        VALUES ('44444444-4444-4444-8444-444444444444', '${customerA.id}', '${testHash}', 'AADHAAR')
        ON CONFLICT (identity_hash) DO NOTHING;
      `);

      try {
        // Customer A checks availability for their own already linked Aadhaar
        const res = await request(app)
          .post('/api/v1/customers/me/aadhaar/check-availability')
          .set('Authorization', 'Bearer token-customer-a')
          .send({ aadhaarNumber: testAadhaar });

        expect(res.status).toBe(200);
        expect(res.body.data.isAvailable).toBe(true);
      } finally {
        db.public.none(`DELETE FROM customer_identity_links WHERE id = '44444444-4444-4444-8444-444444444444';`);
      }
    });
  });
});
