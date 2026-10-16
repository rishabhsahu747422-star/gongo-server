'use strict';

/**
 * Adds vehicles.is_active (admin hold flag) for environments built from repository
 * migrations.
 *
 * Why: Admin block/deactivate write vehicles.is_active (false = admin hold), Partner's ONLINE
 * guard and Customer eligibility read it, but no repository migration created it — it exists
 * only in the live Supabase baseline. Without it a fresh database fails on those paths.
 *
 * Safety:
 * - ADD COLUMN IF NOT EXISTS: a no-op where the live column already exists (its type,
 *   default and existing values are left untouched).
 * - New column: nullable BOOLEAN DEFAULT true, so existing rows read as active (no admin
 *   hold) — a fresh column cannot carry a hold that was never recorded.
 * - The UPDATE only ever sets is_active = false, and only for archived vehicles (archive is
 *   a stricter state than a hold). It can never reactivate a blocked, archived or rejected
 *   vehicle and does not touch manual_status, verification_status or bookings.
 */
exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE vehicles
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
  `);

  await pgm.sql(`
    UPDATE vehicles
    SET is_active = false
    WHERE is_archived = true
      AND (is_active IS NULL OR is_active = true);
  `);
};

/**
 * Down is intentionally non-destructive: dropping the column would erase every admin
 * block/deactivation hold recorded since. Roll back the application instead; drop the
 * column manually only on a database where it was created by this migration and holds no
 * data that matters.
 */
exports.down = async () => {};
