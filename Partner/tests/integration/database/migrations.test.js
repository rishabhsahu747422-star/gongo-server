'use strict';

/* eslint-disable no-restricted-syntax, no-await-in-loop */
const fs = require('fs');
const crypto = require('crypto');
const { newDb, DataType } = require('pg-mem');
const { getMigrationFiles } = require('../../../src/db/migrator');

describe('Database Migrations & Schema Integrity Test Suite', () => {
  let db;
  let allMigrations;
  let pgm;

  beforeAll(() => {
    allMigrations = getMigrationFiles();
  });

  beforeEach(() => {
    db = newDb();

    // Register pgcrypto gen_random_uuid in pg-mem
    db.registerExtension('pgcrypto', (schema) => {
      schema.registerFunction({
        name: 'gen_random_uuid',
        returns: DataType.uuid,
        impure: true,
        implementation: () => crypto.randomUUID(),
      });
    });

    // pg-mem SQL adapter
    pgm = {
      sql: async (statement) => {
        if (!statement || typeof statement !== 'string' || !statement.trim()) return;
        // Skip PL/pgSQL function bodies, triggers, and function drops in memory tests
        if (
          !statement.includes('LANGUAGE plpgsql')
          && !statement.includes('CREATE TRIGGER')
          && !statement.includes('DROP TRIGGER')
          && !statement.includes('DROP FUNCTION')
          && !statement.includes('ROW LEVEL SECURITY')
          && !statement.includes('CREATE POLICY')
          && !statement.includes('DROP POLICY')
          && !statement.includes('customer_profiles')
        ) {
          db.public.none(statement);
        }
      },
    };
  });

  // ── 1. Migration System & Ordering ─────────────────────────────
  describe('1. Migration Structure & Order', () => {
    it('discovers all migration files in correct alphabetical dependency order', () => {
      expect(allMigrations.length).toBe(51);

      // Verify alphabetical ordering
      const sortedNames = [...allMigrations.map((m) => m.name)].sort();
      expect(allMigrations.map((m) => m.name)).toEqual(sortedNames);
    });

    it('all migration modules export both up and down functions', () => {
      allMigrations.forEach((m) => {
        expect(typeof m.module.up).toBe('function');
        expect(typeof m.module.down).toBe('function');
      });
    });

    it('successfully executes all migrations sequentially without errors', async () => {
      for (const m of allMigrations) {
        await expect(m.module.up(pgm)).resolves.not.toThrow();
      }
    });

    it('successfully executes rollback (down) functions without errors', async () => {
      // Run up migrations
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }

      // Rollback in reverse order
      const reversed = [...allMigrations].reverse();
      for (const m of reversed) {
        await expect(m.module.down(pgm)).resolves.not.toThrow();
      }
    });
  });

  // ── 2. Core Schema & Table Existence ───────────────────────────
  describe('2. Table Structure & Constraints', () => {
    beforeEach(async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }
    });

    it('seeds vehicle categories reference data with CAR, BIKE, SCOOTER', () => {
      const rows = db.public.many('SELECT code, name FROM vehicle_categories ORDER BY code ASC;');
      const codes = rows.map((r) => r.code);

      expect(codes).toContain('BIKE');
      expect(codes).toContain('CAR');
      expect(codes).toContain('SCOOTER');
      expect(codes).not.toContain('MOTORCYCLE'); // Forbidden taxonomy
    });

    it('049 adds vehicles.is_active defaulting to active, holds archived vehicles, never reactivates', async () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone, email)
        VALUES ('uid_is_active', 'PARTNER', '+919800000049', 'p049@gongo.in') RETURNING id;
      `);
      const partner = db.public.one(`INSERT INTO partners (user_id) VALUES ('${user.id}') RETURNING id;`);
      const fresh = db.public.one(`
        INSERT INTO vehicles (partner_id, category, brand, model, registration_number, year, fuel_type)
        VALUES ('${partner.id}', 'Car', 'Maruti', 'Swift', 'MP04IA0001', 2024, 'Petrol')
        RETURNING is_active;
      `);
      expect(fresh.is_active).toBe(true);

      const archived = db.public.one(`
        INSERT INTO vehicles (partner_id, category, brand, model, registration_number, year, fuel_type, is_archived, is_active)
        VALUES ('${partner.id}', 'Car', 'Maruti', 'Dzire', 'MP04IA0002', 2024, 'Petrol', true, true)
        RETURNING id;
      `);
      const held = db.public.one(`
        INSERT INTO vehicles (partner_id, category, brand, model, registration_number, year, fuel_type, is_active)
        VALUES ('${partner.id}', 'Car', 'Maruti', 'Baleno', 'MP04IA0003', 2024, 'Petrol', false)
        RETURNING id;
      `);

      // Re-running 049 (idempotent) puts archived vehicles on hold and leaves held ones held
      const m049 = allMigrations.find((m) => m.name.startsWith('049_'));
      await m049.module.up(pgm);
      expect(db.public.one(`SELECT is_active FROM vehicles WHERE id = '${archived.id}'`).is_active).toBe(false);
      expect(db.public.one(`SELECT is_active FROM vehicles WHERE id = '${held.id}'`).is_active).toBe(false);
    });

    it('enforces UUID primary key and user role constraints', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone, email)
        VALUES ('firebase_uid_1', 'PARTNER', '+919876543210', 'partner@gongo.in')
        RETURNING id, role, is_active;
      `);

      expect(user.id).toBeDefined();
      expect(user.role).toBe('PARTNER');
      expect(user.is_active).toBe(true);

      // Invalid role rejected by CHECK constraint
      expect(() => {
        db.public.none(`
          INSERT INTO users (auth_id, role, phone)
          VALUES ('firebase_uid_bad', 'SUPERADMIN', '+919876543211');
        `);
      }).toThrow();
    });

    it('enforces partner status and KYC status CHECK constraints', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_partner_test', 'PARTNER', '+919999988888')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id, partner_status, kyc_status)
        VALUES ('${user.id}', 'ONLINE', 'VERIFIED')
        RETURNING id, partner_status, kyc_status;
      `);

      expect(partner.id).toBeDefined();
      expect(partner.partner_status).toBe('ONLINE');
      expect(partner.kyc_status).toBe('VERIFIED');

      // Invalid status rejected
      expect(() => {
        db.public.none(`
          INSERT INTO partners (user_id, partner_status)
          VALUES ('${user.id}', 'INVALID_STATUS');
        `);
      }).toThrow();
    });

    it('enforces storage_uploads entity_type and status CHECK constraints', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_storage_test', 'PARTNER', '+919999977777')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);

      const upload = db.public.one(`
        INSERT INTO storage_uploads (partner_id, entity_type, storage_key, content_type, expires_at)
        VALUES ('${partner.id}', 'PROFILE_IMAGE', 'partners/${partner.id}/profile/abc.jpg', 'image/jpeg', NOW() + INTERVAL '15 minutes')
        RETURNING id, entity_type, status;
      `);

      expect(upload.id).toBeDefined();
      expect(upload.entity_type).toBe('PROFILE_IMAGE');
      expect(upload.status).toBe('PENDING');

      // Invalid entity_type rejected
      expect(() => {
        db.public.none(`
          INSERT INTO storage_uploads (partner_id, entity_type, storage_key, content_type, expires_at)
          VALUES ('${partner.id}', 'INVALID_ENTITY', 'key', 'image/jpeg', NOW())
        `);
      }).toThrow();

      // Invalid status rejected
      expect(() => {
        db.public.none(`
          INSERT INTO storage_uploads (partner_id, entity_type, storage_key, content_type, expires_at, status)
          VALUES ('${partner.id}', 'PROFILE_IMAGE', 'key2', 'image/jpeg', NOW(), 'INVALID_STATUS')
        `);
      }).toThrow();
    });
  });

  // ── 3. Security & OTP Protection ────────────────────────────────
  describe('3. Plaintext OTP Protection', () => {
    beforeEach(async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }
    });

    it('booking_pickup_verifications NEVER stores raw OTP column', () => {
      const columns = db.public.many(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'booking_pickup_verifications';
      `).map((c) => c.column_name);

      expect(columns).not.toContain('otp');
      expect(columns).not.toContain('otp_code');
      expect(columns).not.toContain('customer_otp');
      expect(columns).toContain('otp_hash');
      expect(columns).toContain('verification_reference');
    });
  });

  // ── 4. Internal Commission Confidentiality ───────────────────────
  describe('4. Commission Confidentiality & Pricing Snapshots', () => {
    beforeEach(async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }
    });

    it('booking_pricing_snapshots does NOT contain commission columns', () => {
      const snapshotColumns = db.public.many(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'booking_pricing_snapshots';
      `).map((c) => c.column_name);

      expect(snapshotColumns).not.toContain('commission');
      expect(snapshotColumns).not.toContain('commission_rate');
      expect(snapshotColumns).not.toContain('commission_amount');
      expect(snapshotColumns).not.toContain('gongo_cut');
      expect(snapshotColumns).toContain('total_customer_amount');
      expect(snapshotColumns).toContain('price_per_hour');
    });

    it('booking_return_verifications contains return_status, total_distance and no return OTP columns', () => {
      const returnColumns = db.public.many(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'booking_return_verifications';
      `).map((c) => c.column_name);

      expect(returnColumns).toContain('return_status');
      expect(returnColumns).toContain('total_distance');
      expect(returnColumns).toContain('late_minutes');
      expect(returnColumns).toContain('late_fee');
      expect(returnColumns).toContain('extra_km');
      expect(returnColumns).toContain('extra_km_fee');
      expect(returnColumns).toContain('odometer_end');
      expect(returnColumns).not.toContain('otp');
      expect(returnColumns).not.toContain('otp_hash');
      expect(returnColumns).not.toContain('otp_code');
    });

    it('commission_records table exists strictly for internal finance with rate constraint', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_p1', 'PARTNER', '+919111122222')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);

      const vehicle = db.public.one(`
        INSERT INTO vehicles (partner_id, category, brand, model, registration_number, year, fuel_type)
        VALUES ('${partner.id}', 'Car', 'Maruti', 'Swift', 'MP04AB0001', 2024, 'Petrol')
        RETURNING id;
      `);

      const customerId = crypto.randomUUID();
      const booking = db.public.one(`
        INSERT INTO bookings (booking_number, customer_id, partner_id, vehicle_id, start_at, expected_return_at)
        VALUES ('BK-101', '${customerId}', '${partner.id}', '${vehicle.id}', '2026-10-01T10:00:00Z', '2026-10-02T10:00:00Z')
        RETURNING id;
      `);

      const comm = db.public.one(`
        INSERT INTO commission_records (
          booking_id, partner_id, commission_rate, commission_amount,
          gross_booking_amount, partner_payable_amount
        )
        VALUES ('${booking.id}', '${partner.id}', 0.1500, 150.00, 1000.00, 850.00)
        RETURNING id, commission_rate, commission_amount, partner_payable_amount;
      `);

      expect(comm.commission_rate).toBe(0.15);
      expect(comm.commission_amount).toBe(150.00);
      expect(comm.partner_payable_amount).toBe(850.00);

      // Commission rate cannot exceed 1.0000 (100%)
      expect(() => {
        db.public.none(`
          INSERT INTO commission_records (
            booking_id, partner_id, commission_rate, commission_amount,
            gross_booking_amount, partner_payable_amount
          )
          VALUES ('${booking.id}', '${partner.id}', 1.5000, 150.00, 1000.00, 850.00);
        `);
      }).toThrow();
    });
  });

  // ── 5. Ledger-Based Partner Wallet ──────────────────────────────
  describe('5. Ledger-Based Partner Wallet Architecture', () => {
    beforeEach(async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }
    });

    it('creates wallet and supports sequential immutable ledger transactions', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_wallet_partner', 'PARTNER', '+919333344444')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);

      const wallet = db.public.one(`
        INSERT INTO wallets (partner_id, available_balance)
        VALUES ('${partner.id}', 0.00)
        RETURNING id, available_balance;
      `);

      expect(wallet.available_balance).toBe(0.00);

      // 1. Credit transaction
      const tx1 = db.public.one(`
        INSERT INTO wallet_transactions (
          wallet_id, partner_id, transaction_type, direction, amount, balance_after,
          reference_type, reference_id, description
        )
        VALUES (
          '${wallet.id}', '${partner.id}', 'BOOKING_CREDIT', 'CREDIT', 1500.00, 1500.00,
          'BOOKING', 'BK-999', 'Booking rental payout'
        )
        RETURNING id, balance_after;
      `);

      expect(tx1.balance_after).toBe(1500.00);

      // 2. Debit transaction (e.g. Payout withdrawal)
      const tx2 = db.public.one(`
        INSERT INTO wallet_transactions (
          wallet_id, partner_id, transaction_type, direction, amount, balance_after,
          reference_type, reference_id, description
        )
        VALUES (
          '${wallet.id}', '${partner.id}', 'PAYOUT_DEBIT', 'DEBIT', 500.00, 1000.00,
          'PAYOUT', 'PAYOUT-001', 'Bank withdrawal'
        )
        RETURNING id, balance_after;
      `);

      expect(tx2.balance_after).toBe(1000.00);

      // Rejects negative amount
      expect(() => {
        db.public.none(`
          INSERT INTO wallet_transactions (
            wallet_id, partner_id, transaction_type, direction, amount, balance_after,
            reference_type, reference_id
          )
          VALUES (
            '${wallet.id}', '${partner.id}', 'ADJUSTMENT', 'CREDIT', -50.00, 950.00,
            'ADJUSTMENT', 'ADJ-1'
          );
        `);
      }).toThrow();
    });
  });

  // ── 6. Booking Operational Rules & Payment Separation ───────────
  describe('6. Booking Lifecycle & Cashfree Payments', () => {
    beforeEach(async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }
    });

    it('bookings table does NOT accept outdated accept/reject booking statuses', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_b1', 'PARTNER', '+919444455555')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);

      const vehicle = db.public.one(`
        INSERT INTO vehicles (partner_id, category, brand, model, registration_number, year, fuel_type)
        VALUES ('${partner.id}', 'Bike', 'KTM', 'Duke 200', 'MP04CD0002', 2024, 'Petrol')
        RETURNING id;
      `);

      // Approved statuses: UPCOMING, ACTIVE, COMPLETED, CANCELLED
      const validBooking = db.public.one(`
        INSERT INTO bookings (booking_number, customer_id, partner_id, vehicle_id, start_at, expected_return_at, booking_status)
        VALUES ('BK-VALID', '${crypto.randomUUID()}', '${partner.id}', '${vehicle.id}', '2026-10-01T10:00:00Z', '2026-10-02T10:00:00Z', 'UPCOMING')
        RETURNING id, booking_status;
      `);
      expect(validBooking.booking_status).toBe('UPCOMING');

      // Outdated 'ACCEPTED' / 'REJECTED' statuses must be rejected by check constraint
      expect(() => {
        db.public.none(`
          INSERT INTO bookings (booking_number, customer_id, partner_id, vehicle_id, start_at, expected_return_at, booking_status)
          VALUES ('BK-INVALID-1', '${crypto.randomUUID()}', '${partner.id}', '${vehicle.id}', '2026-10-01T10:00:00Z', '2026-10-02T10:00:00Z', 'ACCEPTED');
        `);
      }).toThrow();

      expect(() => {
        db.public.none(`
          INSERT INTO bookings (booking_number, customer_id, partner_id, vehicle_id, start_at, expected_return_at, booking_status)
          VALUES ('BK-INVALID-2', '${crypto.randomUUID()}', '${partner.id}', '${vehicle.id}', '2026-10-01T10:00:00Z', '2026-10-02T10:00:00Z', 'REJECTED');
        `);
      }).toThrow();
    });

    it('payments table strictly allows Cashfree and rejects Razorpay provider', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_pay_test', 'PARTNER', '+919555566666')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);

      const vehicle = db.public.one(`
        INSERT INTO vehicles (partner_id, category, brand, model, registration_number, year, fuel_type)
        VALUES ('${partner.id}', 'Car', 'Hyundai', 'Creta', 'MP04IJ0003', 2024, 'Petrol')
        RETURNING id;
      `);

      const booking = db.public.one(`
        INSERT INTO bookings (booking_number, customer_id, partner_id, vehicle_id, start_at, expected_return_at)
        VALUES ('BK-PAY-1', '${crypto.randomUUID()}', '${partner.id}', '${vehicle.id}', '2026-10-01T10:00:00Z', '2026-10-02T10:00:00Z')
        RETURNING id;
      `);

      // Valid CASHFREE payment
      const payment = db.public.one(`
        INSERT INTO payments (booking_id, customer_id, provider, provider_order_id, amount)
        VALUES ('${booking.id}', '${crypto.randomUUID()}', 'CASHFREE', 'cf_order_123', 2500.00)
        RETURNING id, provider, amount;
      `);

      expect(payment.provider).toBe('CASHFREE');
      expect(payment.amount).toBe(2500.00);

      // Rejects RAZORPAY provider via CHECK constraint
      expect(() => {
        db.public.none(`
          INSERT INTO payments (booking_id, customer_id, provider, provider_order_id, amount)
          VALUES ('${booking.id}', '${crypto.randomUUID()}', 'RAZORPAY', 'rzp_order_bad', 2500.00);
        `);
      }).toThrow();
    });

    it('payment_events enforces unique event_id to prevent webhook replay', () => {
      db.public.none(`
        INSERT INTO payment_events (provider, event_id, event_type, payload)
        VALUES ('CASHFREE', 'event_abc_123', 'PAYMENT_SUCCESS', '{"orderId": "123"}');
      `);

      // Duplicate event_id must fail unique constraint
      expect(() => {
        db.public.none(`
          INSERT INTO payment_events (provider, event_id, event_type, payload)
          VALUES ('CASHFREE', 'event_abc_123', 'PAYMENT_SUCCESS', '{"orderId": "123"}');
        `);
      }).toThrow();
    });
  });

  // ── 7. Document Versioning ───────────────────────────────────────
  describe('7. Document Versioning & Audit Integrity', () => {
    beforeEach(async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }
    });

    it('partner_documents supports versioning (v1, v2) for the same document type', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_doc_p1', 'PARTNER', '+919666677777')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);

      // v1
      const docV1 = db.public.one(`
        INSERT INTO partner_documents (partner_id, document_type, storage_key, version)
        VALUES ('${partner.id}', 'AADHAAR', 's3://bucket/docs/v1.pdf', 1)
        RETURNING id, version;
      `);
      expect(docV1.version).toBe(1);

      // v2 for same partner and document_type
      const docV2 = db.public.one(`
        INSERT INTO partner_documents (partner_id, document_type, storage_key, version)
        VALUES ('${partner.id}', 'AADHAAR', 's3://bucket/docs/v2.pdf', 2)
        RETURNING id, version;
      `);
      expect(docV2.version).toBe(2);

      // Duplicate version (partner_id, document_type, version) fails unique constraint
      expect(() => {
        db.public.none(`
          INSERT INTO partner_documents (partner_id, document_type, storage_key, version)
          VALUES ('${partner.id}', 'AADHAAR', 's3://bucket/docs/v1_dup.pdf', 1);
        `);
      }).toThrow();

      // Enforces canonical KYC document types (AADHAAR, PAN, GST, SHOP_ESTABLISHMENT)
      // Rejects non-canonical types like SHOP_LICENSE or DRIVING_LICENSE
      expect(() => {
        db.public.none(`
          INSERT INTO partner_documents (partner_id, document_type, storage_key, version)
          VALUES ('${partner.id}', 'SHOP_LICENSE', 's3://bucket/docs/license.pdf', 1);
        `);
      }).toThrow();

      expect(() => {
        db.public.none(`
          INSERT INTO partner_documents (partner_id, document_type, storage_key, version)
          VALUES ('${partner.id}', 'DRIVING_LICENSE', 's3://bucket/docs/dl.pdf', 1);
        `);
      }).toThrow();

      // Accepts SHOP_ESTABLISHMENT
      const shopEstDoc = db.public.one(`
        INSERT INTO partner_documents (partner_id, document_type, storage_key, version)
        VALUES ('${partner.id}', 'SHOP_ESTABLISHMENT', 's3://bucket/docs/gumasta.pdf', 1)
        RETURNING id, document_type;
      `);
      expect(shopEstDoc.document_type).toBe('SHOP_ESTABLISHMENT');
    });
  });

  // ── 8. Monetary Column Precision ─────────────────────────────────
  describe('8. Precision Verification for Money Columns', () => {
    beforeEach(async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }
    });

    it('verifies financial columns use NUMERIC data type', () => {
      // 1. Verify that the SQL migrations declare NUMERIC(12, 2) or NUMERIC(5, 2) and NEVER FLOAT
      const migrationFiles = allMigrations.map((m) => m.fullPath);
      const moneyKeywords = [
        'price_per_hour', 'price_per_day', 'security_deposit',
        'total_customer_amount', 'gross_booking_amount', 'partner_payable_amount',
        'available_balance', 'pending_balance', 'amount', 'balance_after',
      ];

      migrationFiles.forEach((file) => {
        const content = fs.readFileSync(file, 'utf8');
        moneyKeywords.forEach((col) => {
          if (content.includes(col)) {
            expect(content).toMatch(new RegExp(`${col}\\s+NUMERIC\\(\\d+,\\s*2\\)`));
            expect(content).not.toMatch(new RegExp(`${col}\\s+(FLOAT|REAL|DOUBLE)`, 'i'));
          }
        });
      });

      // 2. Verify in-database insertion with two decimal places
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_money_test', 'PARTNER', '+919777788888')
        RETURNING id;
      `);
      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);
      const wallet = db.public.one(`
        INSERT INTO wallets (partner_id, available_balance, pending_balance)
        VALUES ('${partner.id}', 1250.75, 500.25)
        RETURNING available_balance, pending_balance;
      `);

      expect(wallet.available_balance).toBe(1250.75);
      expect(wallet.pending_balance).toBe(500.25);
    });
  });

  // ── 9. Canonical Partner Business Entity & Booking Status Reconciliation ──
  describe('9. Canonical Partner Business Entity & Hardening (Migration 032)', () => {
    beforeEach(async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }
    });

    it('partners table possesses canonical business & location columns', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_biz_test', 'PARTNER', '+919444433333')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (
          user_id, business_name, business_address, city, latitude, longitude, operating_info
        )
        VALUES (
          '${user.id}', 'Apex Mobility Hub', 'Plot 99, Sector 5', 'Bhopal', 23.2500, 77.4100, '08:00 AM - 10:00 PM'
        )
        RETURNING id, business_name, business_address, city, latitude, longitude, operating_info;
      `);

      expect(partner.id).toBeDefined();
      expect(partner.business_name).toBe('Apex Mobility Hub');
      expect(partner.business_address).toBe('Plot 99, Sector 5');
      expect(partner.city).toBe('Bhopal');
      expect(Number(partner.latitude)).toBeCloseTo(23.25, 2);
      expect(Number(partner.longitude)).toBeCloseTo(77.41, 2);
      expect(partner.operating_info).toBe('08:00 AM - 10:00 PM');
    });

    it('bookings table permits PENDING_PAYMENT and CONFIRMED statuses', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_book_status_test', 'PARTNER', '+919444422222')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);

      const vehicle = db.public.one(`
        INSERT INTO vehicles (partner_id, category, brand, model, registration_number, year, fuel_type)
        VALUES ('${partner.id}', 'Bike', 'Royal Enfield', 'Classic 350', 'MP04BK9999', 2024, 'Petrol')
        RETURNING id;
      `);

      const b1 = db.public.one(`
        INSERT INTO bookings (booking_number, customer_id, partner_id, vehicle_id, start_at, expected_return_at, booking_status)
        VALUES ('BK-PEND-1', '${crypto.randomUUID()}', '${partner.id}', '${vehicle.id}', '2026-11-01T10:00:00Z', '2026-11-02T10:00:00Z', 'PENDING_PAYMENT')
        RETURNING id, booking_status;
      `);
      expect(b1.booking_status).toBe('PENDING_PAYMENT');

      const b2 = db.public.one(`
        INSERT INTO bookings (booking_number, customer_id, partner_id, vehicle_id, start_at, expected_return_at, booking_status)
        VALUES ('BK-CONF-1', '${crypto.randomUUID()}', '${partner.id}', '${vehicle.id}', '2026-11-03T10:00:00Z', '2026-11-04T10:00:00Z', 'CONFIRMED')
        RETURNING id, booking_status;
      `);
      expect(b2.booking_status).toBe('CONFIRMED');
    });

    it('vehicles table possesses pickup_location column and supports VEHICLE_DOCUMENT in storage_uploads', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('uid_vdoc_test', 'PARTNER', '+919444411111')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);

      const vehicle = db.public.one(`
        INSERT INTO vehicles (
          partner_id, category, brand, model, registration_number, year, fuel_type, pickup_location
        )
        VALUES (
          '${partner.id}', 'Car', 'Maruti Suzuki', 'Swift', 'MP04CD1234', 2024, 'Petrol', 'Shop Counter, Station Road'
        )
        RETURNING id, pickup_location;
      `);

      expect(vehicle.id).toBeDefined();
      expect(vehicle.pickup_location).toBe('Shop Counter, Station Road');

      // Test VEHICLE_DOCUMENT upload in storage_uploads
      const upload = db.public.one(`
        INSERT INTO storage_uploads (
          partner_id, entity_type, entity_id, document_type,
          storage_key, content_type, expected_size_bytes, status, expires_at
        )
        VALUES (
          '${partner.id}', 'VEHICLE_DOCUMENT', '${vehicle.id}', 'RC',
          'partners/${partner.id}/vehicles/${vehicle.id}/rc.pdf', 'application/pdf', 1048576, 'COMPLETED', NOW() + INTERVAL '1 hour'
        )
        RETURNING id, entity_type, document_type;
      `);

      expect(upload.id).toBeDefined();
      expect(upload.entity_type).toBe('VEHICLE_DOCUMENT');
      expect(upload.document_type).toBe('RC');

      // Invalid document type for storage_uploads should fail
      expect(() => {
        db.public.none(`
          INSERT INTO storage_uploads (
            partner_id, entity_type, entity_id, document_type,
            storage_key, content_type, expected_size_bytes, status, expires_at
          )
          VALUES (
            '${partner.id}', 'VEHICLE_DOCUMENT', '${vehicle.id}', 'INVALID_DOC_TYPE',
            'partners/bad.pdf', 'application/pdf', 1048576, 'COMPLETED', NOW() + INTERVAL '1 hour'
          );
        `);
      }).toThrow();
    });

    it('verifies payments table supports payment_type and metadata (Migration 035)', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('pay-auth-user', 'PARTNER', '+919876543000')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);

      const vehicle = db.public.one(`
        INSERT INTO vehicles (
          partner_id, category, brand, model, registration_number, year, fuel_type, pickup_location
        )
        VALUES (
          '${partner.id}', 'Bike', 'Honda', 'Activa', 'MP04EF5678', 2024, 'Petrol', 'Indiranagar'
        )
        RETURNING id;
      `);

      const booking = db.public.one(`
        INSERT INTO bookings (
          booking_number, customer_id, customer_name, customer_phone,
          partner_id, vehicle_id, start_at, expected_return_at, booking_status, pickup_location
        )
        VALUES (
          'BK-PAY-035', '${user.id}', 'Pay Tester', '+919876543000',
          '${partner.id}', '${vehicle.id}', NOW(), NOW() + INTERVAL '2 days', 'COMPLETED', 'Indiranagar'
        )
        RETURNING id;
      `);

      // Test valid BOOKING_ADVANCE
      const advPayment = db.public.one(`
        INSERT INTO payments (
          booking_id, customer_id, provider_order_id, amount, payment_type, metadata
        )
        VALUES (
          '${booking.id}', '${user.id}', 'cf_adv_test_01', 1200.00, 'BOOKING_ADVANCE', '{"note": "advance"}'::jsonb
        )
        RETURNING id, payment_type, metadata;
      `);

      expect(advPayment.payment_type).toBe('BOOKING_ADVANCE');
      expect(advPayment.metadata.note).toBe('advance');

      // Test valid POST_RENTAL_SETTLEMENT
      const settlePayment = db.public.one(`
        INSERT INTO payments (
          booking_id, customer_id, provider_order_id, amount, payment_type, metadata
        )
        VALUES (
          '${booking.id}', '${user.id}', 'cf_set_test_02', 300.00, 'POST_RENTAL_SETTLEMENT', '{"lateFee": 300}'::jsonb
        )
        RETURNING id, payment_type, metadata;
      `);

      expect(settlePayment.payment_type).toBe('POST_RENTAL_SETTLEMENT');
      expect(settlePayment.metadata.lateFee).toBe(300);

      // Test invalid payment_type fails check constraint
      expect(() => {
        db.public.none(`
          INSERT INTO payments (
            booking_id, customer_id, provider_order_id, amount, payment_type
          )
          VALUES (
            '${booking.id}', '${user.id}', 'cf_bad_type', 100.00, 'INVALID_TYPE'
          );
        `);
      }).toThrow();
    });

    it('verifies wallet_transactions enforces unique settlement credit reference (Migration 036)', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, phone, role, is_active)
        VALUES ('pay-unique-auth', '9876543299', 'PARTNER', true)
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id)
        VALUES ('${user.id}')
        RETURNING id;
      `);

      const wallet = db.public.one(`
        INSERT INTO wallets (partner_id, available_balance, pending_balance)
        VALUES ('${partner.id}', 1000.00, 0.00)
        RETURNING id;
      `);

      // First settlement credit ledger record
      db.public.none(`
        INSERT INTO wallet_transactions (
          wallet_id, partner_id, transaction_type, direction, amount, balance_after, reference_type, reference_id, status
        )
        VALUES (
          '${wallet.id}', '${partner.id}', 'SETTLEMENT_PAYMENT', 'CREDIT', 500.00, 1500.00, 'POST_RENTAL_SETTLEMENT', 'pay-unique-12a', 'COMPLETED'
        );
      `);

      // Duplicate settlement credit ledger record must fail unique constraint
      expect(() => {
        db.public.none(`
          INSERT INTO wallet_transactions (
            wallet_id, partner_id, transaction_type, direction, amount, balance_after, reference_type, reference_id, status
          )
          VALUES (
            '${wallet.id}', '${partner.id}', 'SETTLEMENT_PAYMENT', 'CREDIT', 500.00, 2000.00, 'POST_RENTAL_SETTLEMENT', 'pay-unique-12a', 'COMPLETED'
          );
        `);
      }).toThrow();
    });
  });

  // ── 10. Ratings Foundation & Schema Integrity (Migration 044) ────────
  describe('10. Ratings Foundation & Moderation Constraints (Migration 044)', () => {
    beforeEach(async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }
    });

    it('verifies ratings table columns and vehicle rating columns exist', () => {
      const ratingCols = db.public.many(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'ratings';
      `).map((c) => c.column_name);

      expect(ratingCols).toContain('id');
      expect(ratingCols).toContain('booking_id');
      expect(ratingCols).toContain('customer_id');
      expect(ratingCols).toContain('partner_id');
      expect(ratingCols).toContain('vehicle_id');
      expect(ratingCols).toContain('target_type');
      expect(ratingCols).toContain('rating_score');
      expect(ratingCols).toContain('review_comment');
      expect(ratingCols).toContain('status');
      expect(ratingCols).toContain('created_at');
      expect(ratingCols).toContain('updated_at');

      const vehicleCols = db.public.many(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'vehicles';
      `).map((c) => c.column_name);

      expect(vehicleCols).toContain('rating_avg');
      expect(vehicleCols).toContain('rating_count');
    });

    it('enforces rating score range (1-5), target_type, and status CHECK constraints', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, name, email)
        VALUES ('auth-cust-001', 'CUSTOMER', 'John D.', 'john@test.com')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id, partner_status, kyc_status)
        VALUES ('${user.id}', 'OFFLINE', 'VERIFIED')
        RETURNING id;
      `);

      const vehicle = db.public.one(`
        INSERT INTO vehicles (
          partner_id, category, brand, model, registration_number,
          year, fuel_type, transmission, seats
        )
        VALUES (
          '${partner.id}', 'CAR', 'Tata', 'Nexon', 'MH-02-AB-9999',
          2024, 'Petrol', 'Manual', 5
        )
        RETURNING id;
      `);

      const booking = db.public.one(`
        INSERT INTO bookings (
          booking_number, customer_id, partner_id, vehicle_id,
          booking_status, start_at, expected_return_at
        )
        VALUES (
          'BK-RAT-001', '${user.id}', '${partner.id}', '${vehicle.id}',
          'COMPLETED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 day'
        )
        RETURNING id;
      `);

      // Valid partner rating (score 5)
      expect(() => {
        db.public.none(`
          INSERT INTO ratings (
            booking_id, customer_id, partner_id, target_type, rating_score, review_comment, status
          )
          VALUES (
            '${booking.id}', '${user.id}', '${partner.id}', 'PARTNER', 5, 'Great host!', 'APPROVED'
          );
        `);
      }).not.toThrow();

      // Valid vehicle rating for same booking (target_type VEHICLE, score 4)
      expect(() => {
        db.public.none(`
          INSERT INTO ratings (
            booking_id, customer_id, partner_id, vehicle_id, target_type, rating_score, review_comment, status
          )
          VALUES (
            '${booking.id}', '${user.id}', '${partner.id}', '${vehicle.id}', 'VEHICLE', 4, 'Smooth drive', 'APPROVED'
          );
        `);
      }).not.toThrow();

      // Duplicate partner rating on same booking must be rejected by unique constraint
      expect(() => {
        db.public.none(`
          INSERT INTO ratings (
            booking_id, customer_id, partner_id, target_type, rating_score, status
          )
          VALUES (
            '${booking.id}', '${user.id}', '${partner.id}', 'PARTNER', 3, 'APPROVED'
          );
        `);
      }).toThrow();

      // Invalid score out of bounds (< 1 or > 5) must be rejected
      expect(() => {
        db.public.none(`
          INSERT INTO ratings (
            booking_id, customer_id, partner_id, target_type, rating_score, status
          )
          VALUES (
            '${booking.id}', '${user.id}', '${partner.id}', 'PARTNER', 6, 'APPROVED'
          );
        `);
      }).toThrow();

      // Invalid target_type must be rejected
      expect(() => {
        db.public.none(`
          INSERT INTO ratings (
            booking_id, customer_id, partner_id, target_type, rating_score, status
          )
          VALUES (
            '${booking.id}', '${user.id}', '${partner.id}', 'INVALID_TARGET', 4, 'APPROVED'
          );
        `);
      }).toThrow();
    });
  });

  // ── 11. Area, Location Coordinates & Working Hours (Migration 046) ───
  describe('11. Area, Location Coordinates & Working Hours (Migration 046)', () => {
    beforeEach(async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }
    });

    it('verifies area, locality, opening_time, closing_time, is_open_24_hours columns exist on partners and shops', () => {
      const partnerCols = db.public.many(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'partners';
      `).map((c) => c.column_name);

      expect(partnerCols).toContain('area');
      expect(partnerCols).toContain('locality');
      expect(partnerCols).toContain('opening_time');
      expect(partnerCols).toContain('closing_time');
      expect(partnerCols).toContain('is_open_24_hours');
      expect(partnerCols).toContain('location_accuracy');
      expect(partnerCols).toContain('location_source');

      const shopCols = db.public.many(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'shops';
      `).map((c) => c.column_name);

      expect(shopCols).toContain('area');
      expect(shopCols).toContain('locality');
      expect(shopCols).toContain('opening_time');
      expect(shopCols).toContain('closing_time');
      expect(shopCols).toContain('is_open_24_hours');
      expect(shopCols).toContain('location_accuracy');
      expect(shopCols).toContain('location_source');
    });

    it('enforces latitude (-90 to 90) and longitude (-180 to 180) range CHECK constraints on partners and shops', () => {
      const user = db.public.one(`
        INSERT INTO users (auth_id, role, phone)
        VALUES ('auth-loc-046', 'PARTNER', '+919876500046')
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (
          user_id, business_name, business_address, city, area, locality,
          latitude, longitude, opening_time, closing_time, is_open_24_hours
        )
        VALUES (
          '${user.id}', 'Piplani Hub', 'Shop No. 12, Main Road, Bhopal, Madhya Pradesh', 'Bhopal', 'Piplani', 'Piplani',
          23.259933, 77.412615, '09:00 AM', '09:00 PM', false
        )
        RETURNING id, area, opening_time, closing_time, is_open_24_hours, latitude, longitude;
      `);

      expect(partner.area).toBe('Piplani');
      expect(partner.opening_time).toBe('09:00 AM');
      expect(partner.closing_time).toBe('09:00 PM');
      expect(partner.is_open_24_hours).toBe(false);
      expect(Number(partner.latitude)).toBeCloseTo(23.259933, 5);
      expect(Number(partner.longitude)).toBeCloseTo(77.412615, 5);

      // Out-of-bounds latitude (> 90) rejected on partners
      expect(() => {
        db.public.none(`
          UPDATE partners SET latitude = 95.0 WHERE id = '${partner.id}';
        `);
      }).toThrow();

      // Out-of-bounds longitude (< -180) rejected on partners
      expect(() => {
        db.public.none(`
          UPDATE partners SET longitude = -185.0 WHERE id = '${partner.id}';
        `);
      }).toThrow();
    });
  });

  // ── 12. Partner Consent Records & Immutable Legal Audit (Migration 047) ──────
  describe('12. Partner Consent Records & Legal Audit (Migration 047)', () => {
    it('verifies partner_consents table structure, foreign keys, and doc_type CHECK constraint', async () => {
      for (const m of allMigrations) {
        await m.module.up(pgm);
      }

      const user = db.public.one(`
        INSERT INTO users (auth_id, role, name, phone, email, is_active)
        VALUES ('auth-consent-1', 'PARTNER', 'Legal Test Partner', '9876543210', 'legal@gongo.in', true)
        RETURNING id;
      `);

      const partner = db.public.one(`
        INSERT INTO partners (user_id, business_name, city, is_active)
        VALUES ('${user.id}', 'Consent Motors', 'Bhopal', true)
        RETURNING id;
      `);

      const consent = db.public.one(`
        INSERT INTO partner_consents (
          user_id, partner_id, document_type, document_version, content_hash, metadata
        )
        VALUES (
          '${user.id}', '${partner.id}', 'GONGO_TERMS', '1.0.0', 'hash_test_123', '{"source":"registration"}'::jsonb
        )
        RETURNING id, user_id, partner_id, document_type, document_version, content_hash, accepted_at;
      `);

      expect(consent.id).toBeDefined();
      expect(consent.document_type).toBe('GONGO_TERMS');
      expect(consent.document_version).toBe('1.0.0');
      expect(consent.content_hash).toBe('hash_test_123');
      expect(consent.accepted_at).toBeDefined();

      // Disallowed document_type is rejected by CHECK constraint
      expect(() => {
        db.public.none(`
          INSERT INTO partner_consents (user_id, partner_id, document_type, document_version, content_hash)
          VALUES ('${user.id}', '${partner.id}', 'INVALID_DOC_TYPE', '1.0.0', 'hash_123');
        `);
      }).toThrow();
    });
  });
});
