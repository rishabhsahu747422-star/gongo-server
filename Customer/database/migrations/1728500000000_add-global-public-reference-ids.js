'use strict';

exports.shorthands = undefined;

/**
 * Migration: Global Public Reference ID System
 *
 * Adds public human-readable reference IDs:
 * - bookings.booking_reference (e.g. BK-7F3K92)
 * - users.customer_reference & customer_profiles.customer_reference (e.g. CUS-4K82P9)
 * - partners.partner_reference (e.g. PTR-9X31M7)
 * - vehicles.vehicle_reference (e.g. VEH-6D91A4)
 * - payments.order_reference (e.g. ORD-8M42Q6)
 * - refunds.refund_reference (e.g. REF-3K72M9)
 */
exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE OR REPLACE FUNCTION generate_gongo_reference(prefix text, len integer DEFAULT 6)
    RETURNS text AS $$
    DECLARE
      charset text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
      result text := prefix || '-';
      i integer;
    BEGIN
      FOR i IN 1..len LOOP
        result := result || substr(charset, floor(random() * length(charset) + 1)::integer, 1);
      END LOOP;
      RETURN result;
    END;
    $$ LANGUAGE plpgsql;

    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_reference VARCHAR(20);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_reference VARCHAR(20);
    ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS customer_reference VARCHAR(20);
    ALTER TABLE partners ADD COLUMN IF NOT EXISTS partner_reference VARCHAR(20);
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_reference VARCHAR(20);
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_reference VARCHAR(20);
    ALTER TABLE refunds ADD COLUMN IF NOT EXISTS refund_reference VARCHAR(20);

    DO $$
    DECLARE
      r RECORD;
      new_ref TEXT;
      attempts INTEGER;
    BEGIN
      FOR r IN SELECT id FROM bookings WHERE booking_reference IS NULL LOOP
        attempts := 0;
        LOOP
          new_ref := generate_gongo_reference('BK', 6);
          EXIT WHEN NOT EXISTS (SELECT 1 FROM bookings WHERE booking_reference = new_ref) OR attempts > 100;
          attempts := attempts + 1;
        END LOOP;
        UPDATE bookings SET booking_reference = new_ref WHERE id = r.id;
      END LOOP;

      FOR r IN SELECT id FROM users WHERE customer_reference IS NULL AND (role ILIKE 'customer' OR role IS NULL) LOOP
        attempts := 0;
        LOOP
          new_ref := generate_gongo_reference('CUS', 6);
          EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE customer_reference = new_ref) OR attempts > 100;
          attempts := attempts + 1;
        END LOOP;
        UPDATE users SET customer_reference = new_ref WHERE id = r.id;
      END LOOP;

      UPDATE customer_profiles cp
      SET customer_reference = u.customer_reference
      FROM users u
      WHERE cp.user_id = u.id AND cp.customer_reference IS NULL AND u.customer_reference IS NOT NULL;

      FOR r IN SELECT id FROM customer_profiles WHERE customer_reference IS NULL LOOP
        attempts := 0;
        LOOP
          new_ref := generate_gongo_reference('CUS', 6);
          EXIT WHEN NOT EXISTS (SELECT 1 FROM customer_profiles WHERE customer_reference = new_ref) OR attempts > 100;
          attempts := attempts + 1;
        END LOOP;
        UPDATE customer_profiles SET customer_reference = new_ref WHERE id = r.id;
      END LOOP;

      FOR r IN SELECT id FROM partners WHERE partner_reference IS NULL LOOP
        attempts := 0;
        LOOP
          new_ref := generate_gongo_reference('PTR', 6);
          EXIT WHEN NOT EXISTS (SELECT 1 FROM partners WHERE partner_reference = new_ref) OR attempts > 100;
          attempts := attempts + 1;
        END LOOP;
        UPDATE partners SET partner_reference = new_ref WHERE id = r.id;
      END LOOP;

      FOR r IN SELECT id FROM vehicles WHERE vehicle_reference IS NULL LOOP
        attempts := 0;
        LOOP
          new_ref := generate_gongo_reference('VEH', 6);
          EXIT WHEN NOT EXISTS (SELECT 1 FROM vehicles WHERE vehicle_reference = new_ref) OR attempts > 100;
          attempts := attempts + 1;
        END LOOP;
        UPDATE vehicles SET vehicle_reference = new_ref WHERE id = r.id;
      END LOOP;

      FOR r IN SELECT id FROM payments WHERE order_reference IS NULL LOOP
        attempts := 0;
        LOOP
          new_ref := generate_gongo_reference('ORD', 6);
          EXIT WHEN NOT EXISTS (SELECT 1 FROM payments WHERE order_reference = new_ref) OR attempts > 100;
          attempts := attempts + 1;
        END LOOP;
        UPDATE payments SET order_reference = new_ref WHERE id = r.id;
      END LOOP;

      FOR r IN SELECT id FROM refunds WHERE refund_reference IS NULL LOOP
        attempts := 0;
        LOOP
          new_ref := generate_gongo_reference('REF', 6);
          EXIT WHEN NOT EXISTS (SELECT 1 FROM refunds WHERE refund_reference = new_ref) OR attempts > 100;
          attempts := attempts + 1;
        END LOOP;
        UPDATE refunds SET refund_reference = new_ref WHERE id = r.id;
      END LOOP;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_booking_reference ON bookings(booking_reference);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_customer_reference ON users(customer_reference) WHERE customer_reference IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_profiles_customer_reference ON customer_profiles(customer_reference) WHERE customer_reference IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_partners_partner_reference ON partners(partner_reference);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_vehicle_reference ON vehicles(vehicle_reference);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_order_reference ON payments(order_reference);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_refund_reference ON refunds(refund_reference);

    ALTER TABLE bookings ALTER COLUMN booking_reference SET NOT NULL;
    ALTER TABLE partners ALTER COLUMN partner_reference SET NOT NULL;
    ALTER TABLE vehicles ALTER COLUMN vehicle_reference SET NOT NULL;
    ALTER TABLE payments ALTER COLUMN order_reference SET NOT NULL;
    ALTER TABLE refunds ALTER COLUMN refund_reference SET NOT NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DROP INDEX IF EXISTS uq_bookings_booking_reference;
    DROP INDEX IF EXISTS uq_users_customer_reference;
    DROP INDEX IF EXISTS uq_customer_profiles_customer_reference;
    DROP INDEX IF EXISTS uq_partners_partner_reference;
    DROP INDEX IF EXISTS uq_vehicles_vehicle_reference;
    DROP INDEX IF EXISTS uq_payments_order_reference;
    DROP INDEX IF EXISTS uq_refunds_refund_reference;

    ALTER TABLE bookings DROP COLUMN IF EXISTS booking_reference;
    ALTER TABLE users DROP COLUMN IF EXISTS customer_reference;
    ALTER TABLE customer_profiles DROP COLUMN IF EXISTS customer_reference;
    ALTER TABLE partners DROP COLUMN IF EXISTS partner_reference;
    ALTER TABLE vehicles DROP COLUMN IF EXISTS vehicle_reference;
    ALTER TABLE payments DROP COLUMN IF EXISTS order_reference;
    ALTER TABLE refunds DROP COLUMN IF EXISTS refund_reference;
  `);
};
