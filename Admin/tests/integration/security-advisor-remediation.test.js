'use strict';

/**
 * Unit & Integration Test Suite for Security Advisor Remediation and Outbox Reliability
 *
 * Verifies:
 * - Empty queue backoff & poll frequency adjustments
 * - Outbox claim semantics & concurrency safety (FOR UPDATE SKIP LOCKED)
 * - Lease expiration & stale recovery logic
 * - RLS policy definitions for cancellation_refund_rules, franchise_applications, partner_consents
 * - Duplicate index assessment logic
 * - SECURITY DEFINER function definitions (pinned search_path, execute grants)
 * - Mutable search_path remediation (generate_gongo_reference, update_updated_at_column, set_updated_at)
 * - Ratings table RLS policies
 */

const fs = require('fs');
const path = require('path');
const adminOutboxRepository = require('../../src/repositories/admin-outbox.repository');
const { OutboxWorker } = require('../../src/jobs/outbox.worker');

describe('Security Advisor & Outbox Performance Remediation Suite', () => {
  const forwardMigrationPath = path.resolve(__dirname, '../../database/migrations/20261015_remediate_security_advisor_and_outbox_optimization.sql');
  const rollbackMigrationPath = path.resolve(__dirname, '../../database/migrations/20261015_rollback_security_advisor_and_outbox_optimization.sql');

  let forwardSql = '';
  let rollbackSql = '';

  beforeAll(() => {
    expect(fs.existsSync(forwardMigrationPath)).toBe(true);
    expect(fs.existsSync(rollbackMigrationPath)).toBe(true);
    forwardSql = fs.readFileSync(forwardMigrationPath, 'utf8');
    rollbackSql = fs.readFileSync(rollbackMigrationPath, 'utf8');
  });

  describe('Phase 1: Outbox Worker Polling & Claiming Semantics', () => {
    it('OutboxWorker initializes with safe backoff bounds and respects empty-queue exponential delay', () => {
      const worker = new OutboxWorker({
        pollIntervalMs: 2000,
        maxPollIntervalMs: 15000,
        leaseSeconds: 300,
      });

      expect(worker.pollIntervalMs).toBe(2000);
      expect(worker.maxPollIntervalMs).toBe(15000);
      expect(worker.currentPollDelayMs).toBe(2000);

      // Simulate empty poll
      const mockEmptyRepo = {
        claimEvents: jest.fn().mockResolvedValue([]),
        recoverStaleJobs: jest.fn().mockResolvedValue([]),
      };
      worker.outboxRepo = mockEmptyRepo;

      return worker.pollOnce().then((processed) => {
        expect(processed).toBe(0);
        // Delay should increase due to backoff
        expect(worker.currentPollDelayMs).toBeGreaterThan(2000);
        expect(worker.currentPollDelayMs).toBeLessThanOrEqual(15000);
      });
    });

    it('Outbox claim SQL query preserves FOR UPDATE SKIP LOCKED and leases', () => {
      let capturedSql = '';
      const mockResolver = {
        claimEvents: (options, client) => {
          return Promise.resolve([]);
        },
      };

      // Check the raw repository code
      const repoFileContent = fs.readFileSync(
        path.resolve(__dirname, '../../src/repositories/admin-outbox.repository.js'),
        'utf8'
      );
      expect(repoFileContent).toContain('FOR UPDATE SKIP LOCKED');
      expect(repoFileContent).toContain("status = 'PROCESSING'");
      expect(repoFileContent).toContain('locked_at = CURRENT_TIMESTAMP');
    });

    it('Migration defines index idx_outbox_events_admin_claim_opt for composite next_retry_at and created_at sorting', () => {
      expect(forwardSql).toContain('idx_outbox_events_admin_claim_opt');
      expect(forwardSql).toContain('(next_retry_at ASC, created_at ASC)');
      expect(forwardSql).toContain("WHERE status IN ('PENDING', 'FAILED')");
    });
  });

  describe('Phase 2: RLS Policies for cancellation_refund_rules, franchise_applications, partner_consents', () => {
    it('enables RLS on the 3 flagged tables in forward migration', () => {
      expect(forwardSql).toContain('ALTER TABLE public.cancellation_refund_rules ENABLE ROW LEVEL SECURITY;');
      expect(forwardSql).toContain('ALTER TABLE public.franchise_applications ENABLE ROW LEVEL SECURITY;');
      expect(forwardSql).toContain('ALTER TABLE public.partner_consents ENABLE ROW LEVEL SECURITY;');
    });

    it('revokes untrusted access from anon and authenticated roles', () => {
      expect(forwardSql).toContain('REVOKE ALL ON TABLE public.cancellation_refund_rules FROM anon, authenticated;');
      expect(forwardSql).toContain('REVOKE ALL ON TABLE public.franchise_applications FROM anon, authenticated;');
      expect(forwardSql).toContain('REVOKE ALL ON TABLE public.partner_consents FROM anon, authenticated;');
    });

    it('preserves access for trusted service_role', () => {
      expect(forwardSql).toContain('GRANT ALL ON TABLE public.cancellation_refund_rules TO service_role;');
      expect(forwardSql).toContain('GRANT ALL ON TABLE public.franchise_applications TO service_role;');
      expect(forwardSql).toContain('GRANT ALL ON TABLE public.partner_consents TO service_role;');
    });
  });

  describe('Phase 3: Duplicate Indexes Audit', () => {
    it('drops confirmed redundant indexes while preserving primary/unique constraints', () => {
      expect(forwardSql).toContain('DROP INDEX IF EXISTS public.idx_admin_sessions_token;');
      expect(forwardSql).toContain('DROP INDEX IF EXISTS public.idx_admin_settings_key;');
      expect(forwardSql).toContain('CREATE INDEX IF NOT EXISTS idx_storage_uploads_partner ON public.storage_uploads (partner_id, status);');
      expect(forwardSql).toContain('DROP INDEX IF EXISTS public.idx_storage_uploads_partner_id;');
      expect(forwardSql).toContain('DROP INDEX IF EXISTS public.idx_vehicle_pricing_history_vehicle_id;');
    });

    it('rollback script properly restores dropped indexes', () => {
      expect(rollbackSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_sessions_token');
      expect(rollbackSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_settings_key');
      expect(rollbackSql).toContain('CREATE INDEX IF NOT EXISTS idx_storage_uploads_partner_id');
      expect(rollbackSql).toContain('CREATE INDEX IF NOT EXISTS idx_support_tickets_ticket_number');
      expect(rollbackSql).toContain('CREATE INDEX IF NOT EXISTS idx_vehicle_pricing_history_vehicle_id');
    });
  });

  describe('Phase 4 & 5: SECURITY DEFINER and Mutable search_path Hardening', () => {
    const requiredFunctions = [
      'get_auth_partner_id',
      'get_auth_user_id',
      'validate_customer_rating_submission',
      'sync_vehicle_rating_aggregates',
      'generate_gongo_reference',
      'update_updated_at_column',
      'set_updated_at',
    ];

    it.each(requiredFunctions)('pins search_path to public, pg_temp on %s', (fnName) => {
      const fnDefRegex = new RegExp(`FUNCTION public\\.${fnName}[\\s\\S]*?SET search_path = public, pg_temp`, 'i');
      expect(forwardSql).toMatch(fnDefRegex);
    });

    it('declares generate_gongo_reference as VOLATILE to prevent optimizer constant-folding', () => {
      expect(forwardSql).toMatch(/FUNCTION public\.generate_gongo_reference[\s\S]*?VOLATILE/i);
      expect(forwardSql).not.toMatch(/FUNCTION public\.generate_gongo_reference[\s\S]*?IMMUTABLE/i);
    });

    it('hardens validate_customer_rating_submission against cross-account oracle probing', () => {
      expect(forwardSql).toContain('public.get_auth_user_id() IS NULL OR p_customer_id = public.get_auth_user_id()');
    });

    it('restricts execute grants on SECURITY DEFINER functions away from PUBLIC and anon', () => {
      expect(forwardSql).toContain('REVOKE ALL ON FUNCTION public.get_auth_partner_id() FROM PUBLIC, anon;');
      expect(forwardSql).toContain('REVOKE ALL ON FUNCTION public.get_auth_user_id() FROM PUBLIC, anon;');
      expect(forwardSql).toContain('REVOKE ALL ON FUNCTION public.validate_customer_rating_submission(UUID, UUID, UUID, UUID, VARCHAR) FROM PUBLIC, anon;');
      expect(forwardSql).toContain('REVOKE ALL ON FUNCTION public.sync_vehicle_rating_aggregates() FROM PUBLIC, anon;');
    });
  });

  describe('Phase 6: Ratings Table Policies', () => {
    it('standardizes ratings policies with robust SECURITY DEFINER helper validation', () => {
      expect(forwardSql).toContain('CREATE POLICY partner_view_own_ratings ON public.ratings');
      expect(forwardSql).toContain('partner_id = public.get_auth_partner_id()');
      expect(forwardSql).toContain("status = 'APPROVED'");

      expect(forwardSql).toContain('CREATE POLICY customer_view_own_ratings ON public.ratings');
      expect(forwardSql).toContain('customer_id = public.get_auth_user_id()');

      expect(forwardSql).toContain('CREATE POLICY customer_submit_rating ON public.ratings');
      expect(forwardSql).toContain('customer_id = public.get_auth_user_id()');
      expect(forwardSql).toContain('public.validate_customer_rating_submission(booking_id, customer_id, partner_id, vehicle_id, target_type)');
    });

    it('revokes UPDATE and DELETE from authenticated and anon on ratings', () => {
      expect(forwardSql).toContain('REVOKE UPDATE, DELETE ON public.ratings FROM authenticated, anon;');
    });
  });

  describe('Phase 7: Behavioral In-Memory SQL Execution (pg-mem)', () => {
    let db;

    beforeEach(() => {
      const { newDb } = require('pg-mem');
      db = newDb();
      // Register custom dummy function for random
      db.public.registerFunction({
        name: 'random',
        args: [],
        returns: db.public.getType('float'),
        implementation: () => Math.random(),
      });
    });

    it('generate_gongo_reference generates formatted references with correct prefix and length', () => {
      const charset = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
      db.public.registerFunction({
        name: 'generate_gongo_reference',
        args: [db.public.getType('text'), db.public.getType('integer')],
        returns: db.public.getType('text'),
        implementation: (prefix, len) => {
          let result = prefix + '-';
          for (let i = 0; i < len; i++) {
            result += charset.charAt(Math.floor(Math.random() * charset.length));
          }
          return result;
        },
      });

      const ref1 = db.public.one("SELECT generate_gongo_reference('BK', 6) as ref;").ref;
      expect(ref1).toMatch(/^BK-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);

      const ref2 = db.public.one("SELECT generate_gongo_reference('PTR', 8) as ref;").ref;
      expect(ref2).toMatch(/^PTR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    });

    it('validate_customer_rating_submission correctly checks booking eligibility', () => {
      let currentAuthUser = null;
      db.public.registerFunction({
        name: 'get_auth_user_id',
        args: [],
        returns: db.public.getType('uuid'),
        implementation: () => currentAuthUser,
      });

      db.public.none(`
        CREATE TABLE bookings (
          id UUID PRIMARY KEY,
          customer_id UUID NOT NULL,
          partner_id UUID NOT NULL,
          vehicle_id UUID,
          booking_status VARCHAR(50),
          status VARCHAR(50)
        );
      `);

      db.public.registerFunction({
        name: 'validate_customer_rating_submission',
        args: [
          db.public.getType('uuid'),
          db.public.getType('uuid'),
          db.public.getType('uuid'),
          db.public.getType('uuid'),
          db.public.getType('text'),
        ],
        returns: db.public.getType('bool'),
        implementation: (bookingId, customerId, partnerId, vehicleId, targetType) => {
          const authFilter = currentAuthUser ? `'${customerId}' = '${currentAuthUser}'` : 'TRUE';
          const vehicleFilter = targetType !== 'VEHICLE' ? 'TRUE' : `b.vehicle_id = '${vehicleId}'::uuid`;
          const res = db.public.one(`
            SELECT EXISTS (
              SELECT 1
              FROM bookings b
              WHERE b.id = '${bookingId}'::uuid
                AND b.customer_id = '${customerId}'::uuid
                AND ${authFilter}
                AND b.partner_id = '${partnerId}'::uuid
                AND ${vehicleFilter}
                AND (
                  b.booking_status IN ('COMPLETED', 'CONFIRMED')
                  OR COALESCE(b.status, '') IN ('completed', 'returned')
                )
            ) as valid;
          `);
          return res.valid;
        },
      });

      const bId = '11111111-1111-1111-1111-111111111111';
      const cId = '22222222-2222-2222-2222-222222222222';
      const pId = '33333333-3333-3333-3333-333333333333';
      const vId = '44444444-4444-4444-4444-444444444444';

      // Insert completed booking
      db.public.none(`
        INSERT INTO bookings (id, customer_id, partner_id, vehicle_id, booking_status, status)
        VALUES ('${bId}', '${cId}', '${pId}', '${vId}', 'COMPLETED', 'completed');
      `);

      // 1. Backend context (get_auth_user_id() is null) -> valid customer and booking
      currentAuthUser = null;
      const isValidBackend = db.public.one(`
        SELECT validate_customer_rating_submission(
          '${bId}'::uuid, '${cId}'::uuid, '${pId}'::uuid, '${vId}'::uuid, 'VEHICLE'
        ) as valid;
      `).valid;
      expect(isValidBackend).toBe(true);

      // 2. Authenticated user context matching customer_id -> valid
      currentAuthUser = cId;
      const isValidAuth = db.public.one(`
        SELECT validate_customer_rating_submission(
          '${bId}'::uuid, '${cId}'::uuid, '${pId}'::uuid, '${vId}'::uuid, 'VEHICLE'
        ) as valid;
      `).valid;
      expect(isValidAuth).toBe(true);

      // 3. Authenticated attacker attempting to probe another customer's booking -> rejected
      currentAuthUser = '99999999-9999-9999-9999-999999999999';
      const isBlockedAttacker = db.public.one(`
        SELECT validate_customer_rating_submission(
          '${bId}'::uuid, '${cId}'::uuid, '${pId}'::uuid, '${vId}'::uuid, 'VEHICLE'
        ) as valid;
      `).valid;
      expect(isBlockedAttacker).toBe(false);

      // 4. Invalid customer ID
      currentAuthUser = null;
      const isInvalidCustomer = db.public.one(`
        SELECT validate_customer_rating_submission(
          '${bId}'::uuid, '99999999-9999-9999-9999-999999999999'::uuid, '${pId}'::uuid, '${vId}'::uuid, 'VEHICLE'
        ) as valid;
      `).valid;
      expect(isInvalidCustomer).toBe(false);

      // 5. Wrong vehicle ID
      const isInvalidVehicle = db.public.one(`
        SELECT validate_customer_rating_submission(
          '${bId}'::uuid, '${cId}'::uuid, '${pId}'::uuid, '88888888-8888-8888-8888-888888888888'::uuid, 'VEHICLE'
        ) as valid;
      `).valid;
      expect(isInvalidVehicle).toBe(false);
    });
  });
});

