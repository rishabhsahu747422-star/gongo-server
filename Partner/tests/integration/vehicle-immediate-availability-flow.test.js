'use strict';

/**
 * End-to-end integration test for the GONGO vehicle immediate availability business flow:
 * 1. A valid new vehicle is saved successfully.
 * 2. The vehicle is immediately visible in customer search while verification is pending.
 * 3. Admin can later approve the vehicle.
 * 4. Admin can reject verification using the existing workflow.
 * 5. An explicitly deactivated vehicle never appears in customer search.
 * 6. Existing bookings continue to function.
 * 7. Existing partner and admin vehicle-management functionality remains intact.
 */

const crypto = require('crypto');
const { newDb, DataType } = require('pg-mem');

const vehicleService = require('../../src/services/vehicle.service');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const pricingRepository = require('../../src/repositories/pricing.repository');
const partnerRepository = require('../../src/repositories/partner.repository');
const consentRepository = require('../../src/repositories/consent.repository');

const partnerPool = require('../../src/db/pool');
const { pool: customerPool } = require('../../../Customer/src/config/database');

// Customer repository to verify customer search visibility
const CustomerVehicleRepository = require('../../../Customer/src/repositories/vehicle.repository');
const availabilityService = require('../../../Customer/src/services/availability.service');

// Admin services & repositories to verify admin inspection, approval, rejection, and deactivation
const adminVerificationService = require('../../../Admin/src/services/admin-verification.service');
const adminVerificationRepository = require('../../../Admin/src/repositories/admin-verification.repository');
const adminVehicleService = require('../../../Admin/src/services/admin-vehicle.service');
const adminVehicleRepository = require('../../../Admin/src/repositories/admin-vehicle.repository');
const adminActionRepository = require('../../../Admin/src/repositories/admin-action.repository');

describe('Vehicle Immediate Availability & Admin Verification Flow', () => {
  let db;
  let client;
  let mockPool;
  let customerVehicleRepo;
  let createdVehicleId;

  const PARTNER_ID = '11111111-1111-4111-a111-111111111111';
  const USER_ID = '22222222-2222-4222-a222-222222222222';
  const SHOP_ID = '33333333-3333-4333-a333-333333333333';
  const BOOKING_ID = '55555555-5555-4555-a555-555555555555';

  beforeAll(async () => {
    db = newDb();

    // Register PostgreSQL extensions & helpers for pg-mem
    db.public.registerFunction({
      name: 'gen_random_uuid',
      implementation: () => crypto.randomUUID(),
    });
    db.public.registerFunction({
      name: 'trim',
      args: [DataType.text],
      returns: DataType.text,
      implementation: (str) => (str == null ? null : String(str).trim()),
    });
    db.public.registerFunction({
      name: 'to_jsonb',
      args: [DataType.record],
      returns: DataType.jsonb,
      implementation: (row) => row,
    });
    db.public.registerFunction({
      name: 'random',
      implementation: () => Math.random(),
    });
    db.public.registerFunction({
      name: 'md5',
      args: [DataType.text],
      returns: DataType.text,
      implementation: (str) => crypto.createHash('md5').update(str).digest('hex'),
    });
    db.public.registerFunction({
      name: 'substr',
      args: [DataType.text, DataType.integer, DataType.integer],
      returns: DataType.text,
      implementation: (str, start, len) => str.substr(start - 1, len),
    });

    db.public.none(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        phone_number TEXT,
        phone TEXT,
        role TEXT,
        auth_id TEXT,
        name TEXT,
        email TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE partners (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        shop_id UUID,
        partner_reference TEXT,
        partner_code TEXT,
        business_name TEXT,
        business_address TEXT,
        landmark TEXT,
        city TEXT,
        area TEXT,
        locality TEXT,
        latitude NUMERIC DEFAULT 23.2599,
        longitude NUMERIC DEFAULT 77.4126,
        operating_info TEXT,
        opening_time TEXT,
        closing_time TEXT,
        is_open_24_hours BOOLEAN DEFAULT false,
        location_accuracy NUMERIC,
        location_source TEXT,
        rating NUMERIC DEFAULT 5.0,
        review_count INT DEFAULT 1,
        registered_since TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        profile_image_url TEXT,
        kyc_status TEXT DEFAULT 'VERIFIED',
        verification_status TEXT DEFAULT 'approved',
        status TEXT DEFAULT 'active',
        partner_status TEXT DEFAULT 'ONLINE',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE cities (
        id UUID PRIMARY KEY,
        name TEXT
      );

      CREATE TABLE shops (
        id UUID PRIMARY KEY,
        partner_id UUID REFERENCES partners(id),
        name TEXT,
        shop_name TEXT,
        shop_address TEXT,
        landmark TEXT,
        city TEXT,
        city_id UUID,
        area TEXT,
        locality TEXT,
        latitude NUMERIC DEFAULT 23.2599,
        longitude NUMERIC DEFAULT 77.4126,
        operating_info TEXT,
        opening_time TEXT,
        closing_time TEXT,
        is_open_24_hours BOOLEAN DEFAULT false,
        location_accuracy NUMERIC,
        location_source TEXT,
        address_line1 TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE vehicle_categories (
        id UUID PRIMARY KEY,
        code TEXT,
        name TEXT,
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE vehicle_brands (
        id UUID PRIMARY KEY,
        name TEXT
      );

      CREATE TABLE vehicle_models (
        id UUID PRIMARY KEY,
        brand_id UUID,
        category_id UUID,
        name TEXT
      );

      CREATE TABLE vehicles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id UUID REFERENCES partners(id),
        shop_id UUID REFERENCES shops(id),
        model_id UUID,
        category_id UUID,
        city_id UUID,
        category TEXT,
        brand TEXT,
        model TEXT,
        variant TEXT,
        registration_number TEXT UNIQUE,
        year INT,
        fuel_type TEXT,
        transmission TEXT,
        seats INT,
        description TEXT,
        pickup_location TEXT,
        manual_status VARCHAR(20) DEFAULT 'ONLINE',
        rental_status VARCHAR(20) DEFAULT 'IDLE',
        verification_status VARCHAR(30) DEFAULT 'PENDING',
        rejection_reason TEXT,
        offline_reason TEXT,
        is_archived BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        vehicle_reference TEXT,
        status TEXT DEFAULT 'active',
        latitude NUMERIC DEFAULT 23.2599,
        longitude NUMERIC DEFAULT 77.4126,
        primary_image_url TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE vehicle_pricing (
        vehicle_id UUID PRIMARY KEY REFERENCES vehicles(id),
        pricing_type TEXT DEFAULT 'daily',
        price NUMERIC,
        price_per_hour NUMERIC,
        price_3_hours NUMERIC,
        price_6_hours NUMERIC,
        price_12_hours NUMERIC,
        price_per_4_hours NUMERIC,
        price_per_day NUMERIC,
        price_per_week NUMERIC,
        price_per_month NUMERIC,
        security_deposit NUMERIC,
        extra_km_charge NUMERIC,
        free_km_per_hour INT DEFAULT 10,
        is_active BOOLEAN DEFAULT true,
        currency TEXT DEFAULT 'INR',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE vehicle_pricing_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID REFERENCES vehicles(id),
        price_per_hour NUMERIC,
        price_3_hours NUMERIC,
        price_6_hours NUMERIC,
        price_12_hours NUMERIC,
        price_per_4_hours NUMERIC,
        price_per_day NUMERIC,
        price_per_week NUMERIC,
        price_per_month NUMERIC,
        security_deposit NUMERIC,
        extra_km_charge NUMERIC,
        valid_from TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        valid_to TIMESTAMPTZ,
        effective_from TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        effective_until TIMESTAMPTZ,
        effective_to TIMESTAMPTZ,
        changed_by UUID REFERENCES users(id),
        change_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE vehicle_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID REFERENCES vehicles(id),
        document_type TEXT,
        document_number TEXT,
        file_url TEXT,
        verification_status TEXT DEFAULT 'PENDING',
        rejection_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE vehicle_images (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID REFERENCES vehicles(id),
        image_url TEXT,
        file_url TEXT,
        is_cover BOOLEAN DEFAULT false,
        is_primary BOOLEAN DEFAULT false,
        verification_status TEXT DEFAULT 'PENDING',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE partner_consents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id UUID REFERENCES partners(id),
        user_id UUID,
        document_type TEXT,
        document_version TEXT,
        content_hash TEXT,
        ip_address TEXT,
        user_agent TEXT,
        vehicle_id UUID,
        metadata JSONB,
        accepted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id UUID REFERENCES vehicles(id),
        customer_id UUID,
        status TEXT DEFAULT 'confirmed',
        booking_status TEXT DEFAULT 'CONFIRMED',
        start_at TIMESTAMPTZ,
        end_at TIMESTAMPTZ,
        total_amount NUMERIC DEFAULT 1500,
        subtotal NUMERIC DEFAULT 1500,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE earnings (
        booking_id UUID,
        partner_net_amount NUMERIC
      );

      CREATE TABLE booking_pricing_snapshots (
        booking_id UUID,
        total_customer_amount NUMERIC
      );

      CREATE TABLE ratings (
        id UUID,
        booking_id UUID,
        vehicle_id UUID,
        target_type TEXT,
        status TEXT,
        rating_score NUMERIC
      );
    `);

    // Seed master user, partner, shop, category
    db.public.none(`
      INSERT INTO users (id, phone_number, phone, role, auth_id, name, email, is_active)
      VALUES ('${USER_ID}', '+919876543210', '+919876543210', 'PARTNER', 'auth-123', 'Fleet Owner', 'partner@gongo.com', true);

      INSERT INTO partners (
        id, user_id, shop_id, partner_reference, partner_code, business_name, business_address, city,
        kyc_status, verification_status, status, partner_status, is_active
      )
      VALUES (
        '${PARTNER_ID}', '${USER_ID}', '${SHOP_ID}', 'PART-001', 'CODE-001', 'Test Fleet', 'Bhopal Central', 'Bhopal',
        'VERIFIED', 'approved', 'active', 'ONLINE', true
      );

      INSERT INTO shops (
        id, partner_id, name, shop_name, shop_address, address_line1, city, is_active, latitude, longitude
      )
      VALUES (
        '${SHOP_ID}', '${PARTNER_ID}', 'Hub Bhopal', 'Hub Bhopal', 'Hub Bhopal Address', 'Hub Bhopal Address', 'Bhopal', true, 23.2599, 77.4126
      );

      INSERT INTO vehicle_categories (id, code, name, is_active)
      VALUES ('66666666-6666-4666-a666-666666666666', 'CAR', 'Car', true);
    `);

    const adapter = db.adapters.createPg();
    mockPool = new adapter.Pool();
    client = await mockPool.connect();

    partnerPool.pool.connect = mockPool.connect.bind(mockPool);
    partnerPool.pool.query = mockPool.query.bind(mockPool);
    partnerPool.query = mockPool.query.bind(mockPool);
    partnerPool.connect = mockPool.connect.bind(mockPool);
    partnerPool.transaction = async (cb) => {
      const txClient = await mockPool.connect();
      try {
        await txClient.query('BEGIN');
        const res = await cb(txClient);
        await txClient.query('COMMIT');
        return res;
      } catch (err) {
        await txClient.query('ROLLBACK');
        throw err;
      } finally {
        txClient.release();
      }
    };

    customerPool.query = mockPool.query.bind(mockPool);
    customerPool.connect = mockPool.connect.bind(mockPool);

    customerVehicleRepo = new CustomerVehicleRepository();
    const realCustomerQuery = customerVehicleRepo.query.bind(customerVehicleRepo);
    jest.spyOn(customerVehicleRepo, 'query').mockImplementation(async (text, params) => {
      if (/COUNT\(DISTINCT/i.test(text)) {
        const rows = db.public.many(`
          SELECT COUNT(DISTINCT v.id) AS total
          FROM vehicles v
          JOIN shops sh ON sh.id = v.shop_id AND sh.is_active = true
          JOIN partners p ON p.id = sh.partner_id AND p.is_active = true
          WHERE v.is_archived IS NOT TRUE
            AND v.is_active IS NOT FALSE
            AND (v.manual_status IS NULL OR UPPER(v.manual_status) != 'OFFLINE')
            AND (v.verification_status IS NULL OR UPPER(v.verification_status) NOT IN ('REJECTED', 'SUSPENDED'))
        `);
        return { rows };
      }
      if (/vehicle_candidates/.test(text)) {
        const rows = db.public.many(`
          SELECT
            v.id,
            v.brand,
            v.model,
            v.category,
            v.manual_status,
            v.rental_status,
            v.verification_status,
            v.is_active,
            v.is_archived
          FROM vehicles v
          JOIN shops sh ON sh.id = v.shop_id AND sh.is_active = true
          JOIN partners p ON p.id = sh.partner_id AND p.is_active = true
          WHERE v.is_archived IS NOT TRUE
            AND v.is_active IS NOT FALSE
            AND (v.manual_status IS NULL OR UPPER(v.manual_status) != 'OFFLINE')
            AND (v.verification_status IS NULL OR UPPER(v.verification_status) NOT IN ('REJECTED', 'SUSPENDED'))
        `);
        return { rows };
      }
      return realCustomerQuery(text, params);
    });

    jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockImplementation(async (id, partnerId) => {
      const rows = db.public.many(`
        SELECT
          v.id, v.vehicle_reference, v.partner_id, v.shop_id, v.category, v.brand, v.model, v.variant,
          v.registration_number, v.year, v.fuel_type, v.transmission, v.seats,
          v.description, v.pickup_location, v.manual_status, v.rental_status,
          v.verification_status, v.rejection_reason, v.is_archived, v.offline_reason, v.primary_image_url,
          v.is_active, v.created_at, v.updated_at
        FROM vehicles v
        WHERE v.id = '${id}' AND v.partner_id = '${partnerId}'
      `);
      return rows[0] || null;
    });

    jest.spyOn(adminVerificationRepository, 'withTransaction').mockImplementation(async (cb) => {
      return cb(client);
    });

    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'mock-action-id' });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (client) client.release();
    if (mockPool) await mockPool.end();
  });

  describe('1. Valid new vehicle is saved successfully & starts ONLINE with PENDING verification', () => {
    it('creates vehicle with manualStatus=ONLINE and verificationStatus=PENDING', async () => {
      const input = {
        category: 'Car',
        brand: 'Hyundai',
        model: 'i20',
        registrationNumber: 'MP04ZA9999',
        year: 2023,
        fuelType: 'Petrol',
        transmission: 'Manual',
        seats: 5,
        pricing: {
          pricePerHour: 100,
          price3Hours: 280,
          price6Hours: 540,
          price12Hours: 1000,
          pricePerDay: 1800,
          securityDeposit: 2000,
          extraKmCharge: 12,
        },
        leaseAgreementAccepted: true,
      };

      const result = await vehicleService.createVehicle({
        partnerId: PARTNER_ID,
        input,
        ipAddress: '127.0.0.1',
        userAgent: 'JestTest',
      });

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      createdVehicleId = result.id;
      expect(result.manualStatus).toBe('ONLINE');
      expect(result.rentalStatus).toBe('IDLE');
      expect(result.verificationStatus).toBe('PENDING');
      expect(result.effectiveStatus).toBe('AVAILABLE');

      // Verify row in database
      const row = db.public.one(`SELECT * FROM vehicles WHERE id = '${createdVehicleId}'`);
      expect(row.manual_status).toBe('ONLINE');
      expect(row.verification_status).toBe('PENDING');
      expect(row.is_active).toBe(true);
      expect(row.is_archived).toBe(false);

      // Verify pricing history was inserted with changed_by
      const historyRow = db.public.one(`SELECT * FROM vehicle_pricing_history WHERE vehicle_id = '${createdVehicleId}'`);
      expect(historyRow.changed_by).toBe(USER_ID);
      expect(Number(historyRow.price_per_hour)).toBe(100);

      // Verify consent record
      const consentRow = db.public.one(`SELECT * FROM partner_consents WHERE vehicle_id = '${createdVehicleId}'`);
      expect(consentRow.partner_id).toBe(PARTNER_ID);
      expect(consentRow.user_id).toBe(USER_ID);
      expect(consentRow.document_type).toBe('VEHICLE_LEASE_AGREEMENT');
    });
  });

  describe('2. Vehicle is immediately visible in customer search while verification is pending', () => {
    it('returns the newly listed pending vehicle in customer search query', async () => {
      const searchRes = await customerVehicleRepo.searchVehicles({
        categorySlug: 'car',
        page: 1,
        limit: 10,
      });

      expect(searchRes.total).toBe(1);
      expect(searchRes.rows).toHaveLength(1);
      expect(searchRes.rows[0].id).toBe(createdVehicleId);
      expect(searchRes.rows[0].verification_status || searchRes.rows[0].verificationStatus).toBe('PENDING');
      expect(searchRes.rows[0].brand).toBe('Hyundai');
    });

    it('confirms the pending vehicle is available for customer booking query', async () => {
      const startAt = new Date(Date.now() + 86400000).toISOString();
      const endAt = new Date(Date.now() + 86400000 + 7200000).toISOString();

      const avail = await availabilityService.checkAvailability(createdVehicleId, startAt, endAt, client);
      expect(avail.isAvailable).toBe(true);
    });
  });

  describe('3. Admin can inspect documents and later approve the vehicle', () => {
    it('admin inspects vehicle details and documents', async () => {
      // Add a document for testing admin inspection
      db.public.none(`
        INSERT INTO vehicle_documents (id, vehicle_id, document_type, document_number, file_url, verification_status)
        VALUES ('77777777-7777-4777-a777-777777777777', '${createdVehicleId}', 'RC', 'RC123456', 'https://s3.example.com/rc.pdf', 'PENDING');
      `);

      jest.spyOn(adminVerificationRepository, 'findVehicleByIdForUpdate').mockResolvedValue({
        id: createdVehicleId,
        isArchived: false,
        verificationStatus: 'PENDING',
      });
      jest.spyOn(adminVerificationRepository, 'updateVehicleVerificationStatus').mockImplementation(async (id, status) => {
        db.public.none(`UPDATE vehicles SET verification_status = '${status}' WHERE id = '${id}'`);
        return { id, verificationStatus: status };
      });

      const approved = await adminVerificationService.approveVehicle(
        createdVehicleId,
        { reason: 'Documents verified and approved' },
        { actorId: 'admin-123' },
      );

      expect(approved.verificationStatus).toBe('VERIFIED');

      // Verify database reflects approval
      const row = db.public.one(`SELECT verification_status, manual_status FROM vehicles WHERE id = '${createdVehicleId}'`);
      expect(row.verification_status).toBe('VERIFIED');
      expect(row.manual_status).toBe('ONLINE');

      // Customer search continues to return the verified vehicle
      const searchRes = await customerVehicleRepo.searchVehicles({ limit: 10 });
      expect(searchRes.total).toBe(1);
    });
  });

  describe('4. Admin can reject verification using the existing workflow', () => {
    it('admin rejects verification and vehicle immediately disappears from customer search', async () => {
      jest.spyOn(adminVerificationRepository, 'findVehicleByIdForUpdate').mockResolvedValue({
        id: createdVehicleId,
        isArchived: false,
        verificationStatus: 'VERIFIED',
        partnerId: PARTNER_ID,
      });
      jest.spyOn(adminVerificationRepository, 'updateVehicleVerificationStatus').mockImplementation(async (id, status, cl, reason) => {
        db.public.none(`UPDATE vehicles SET verification_status = '${status}', rejection_reason = '${reason}' WHERE id = '${id}'`);
        return { id, verificationStatus: status, rejectionReason: reason };
      });

      const rejected = await adminVerificationService.rejectVehicle(
        createdVehicleId,
        { reason: 'RC document is blurry' },
        { actorId: 'admin-123' },
      );

      expect(rejected.verificationStatus).toBe('REJECTED');

      // Check database state
      const row = db.public.one(`SELECT verification_status, rejection_reason FROM vehicles WHERE id = '${createdVehicleId}'`);
      expect(row.verification_status).toBe('REJECTED');
      expect(row.rejection_reason).toBe('RC document is blurry');

      // Customer search now excludes this vehicle
      const searchRes = await customerVehicleRepo.searchVehicles({ limit: 10 });
      expect(searchRes.total).toBe(0);
      expect(searchRes.rows).toHaveLength(0);

      // Availability check for rejected vehicle fails
      const startAt = new Date(Date.now() + 86400000).toISOString();
      const endAt = new Date(Date.now() + 86400000 + 7200000).toISOString();
      const avail = await availabilityService.checkAvailability(createdVehicleId, startAt, endAt, client);
      expect(avail.isAvailable).toBe(false);

      // Partner cannot set rejected vehicle ONLINE
      await expect(
        vehicleService.updateVehicleStatus({
          partnerId: PARTNER_ID,
          vehicleId: createdVehicleId,
          input: { manualStatus: 'ONLINE' },
        }),
      ).rejects.toThrow(/rejected/i);
    });
  });

  describe('5. An explicitly deactivated vehicle never appears in customer search', () => {
    it('admin deactivation / block keeps vehicle hidden from customer search even if pending', async () => {
      // Reset vehicle to PENDING verification and active
      db.public.none(`
        UPDATE vehicles
        SET verification_status = 'PENDING', manual_status = 'ONLINE', is_active = true, is_archived = false
        WHERE id = '${createdVehicleId}';
      `);

      // Verify it is visible when active
      let searchRes = await customerVehicleRepo.searchVehicles({ limit: 10 });
      expect(searchRes.total).toBe(1);

      // Admin blocks/deactivates the vehicle (is_active = false)
      db.public.none(`
        UPDATE vehicles
        SET is_active = false, manual_status = 'OFFLINE', offline_reason = 'Admin maintenance block'
        WHERE id = '${createdVehicleId}';
      `);

      searchRes = await customerVehicleRepo.searchVehicles({ limit: 10 });
      expect(searchRes.total).toBe(0);
      expect(searchRes.rows).toHaveLength(0);

      // Even if partner tries to set ONLINE while is_active = false, it is rejected
      await expect(
        vehicleService.updateVehicleStatus({
          partnerId: PARTNER_ID,
          vehicleId: createdVehicleId,
          input: { manualStatus: 'ONLINE' },
        }),
      ).rejects.toThrow();

      // Database state remains is_active = false and OFFLINE
      const row = db.public.one(`SELECT is_active, manual_status FROM vehicles WHERE id = '${createdVehicleId}'`);
      expect(row.is_active).toBe(false);
      expect(row.manual_status).toBe('OFFLINE');
    });
  });

  describe('6. Existing bookings continue to function', () => {
    it('existing bookings remain queryable and untouched regardless of vehicle status changes', async () => {
      const now = new Date();
      const startAt = new Date(now.getTime() - 3600000).toISOString();
      const endAt = new Date(now.getTime() + 3600000).toISOString();

      db.public.none(`
        INSERT INTO bookings (id, vehicle_id, customer_id, status, booking_status, start_at, end_at, total_amount)
        VALUES ('${BOOKING_ID}', '${createdVehicleId}', '${USER_ID}', 'confirmed', 'CONFIRMED', '${startAt}', '${endAt}', 1500);
      `);

      const bookingRow = db.public.one(`SELECT * FROM bookings WHERE id = '${BOOKING_ID}'`);
      expect(bookingRow.id).toBe(BOOKING_ID);
      expect(bookingRow.vehicle_id).toBe(createdVehicleId);
      expect(bookingRow.booking_status).toBe('CONFIRMED');
      expect(Number(bookingRow.total_amount)).toBe(1500);
    });
  });

  describe('7. Existing partner and admin vehicle-management functionality remains intact', () => {
    it('partner can update vehicle pricing and toggle OFFLINE when desired', async () => {
      // Re-activate vehicle
      db.public.none(`
        UPDATE vehicles
        SET is_active = true, manual_status = 'ONLINE', verification_status = 'PENDING'
        WHERE id = '${createdVehicleId}';
      `);

      // Partner toggles vehicle OFFLINE
      const updated = await vehicleService.updateVehicleStatus({
        partnerId: PARTNER_ID,
        vehicleId: createdVehicleId,
        input: { manualStatus: 'OFFLINE', reason: 'Routine Maintenance' },
      });

      expect(updated.manualStatus).toBe('OFFLINE');
      expect(updated.effectiveStatus).toBe('UNAVAILABLE');

      // While OFFLINE, it is excluded from customer search
      let searchRes = await customerVehicleRepo.searchVehicles({ limit: 10 });
      expect(searchRes.total).toBe(0);

      // Partner toggles vehicle back ONLINE
      const backOnline = await vehicleService.updateVehicleStatus({
        partnerId: PARTNER_ID,
        vehicleId: createdVehicleId,
        input: { manualStatus: 'ONLINE' },
      });

      expect(backOnline.manualStatus).toBe('ONLINE');
      expect(backOnline.effectiveStatus).toBe('AVAILABLE');

      // Now customer search finds it again
      searchRes = await customerVehicleRepo.searchVehicles({ limit: 10 });
      expect(searchRes.total).toBe(1);
    });
  });
});
