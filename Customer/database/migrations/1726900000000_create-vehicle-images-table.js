'use strict';

/**
 * Migration: Vehicle images table.
 *
 * DESIGN DECISIONS:
 *   - `storage_key` stores the S3 object key (relative path within the bucket).
 *     This is an internal reference used by the image signing service.
 *     It is NEVER exposed to customers through public APIs.
 *   - Image URLs presented to customers must be generated as time-limited
 *     presigned URLs by the server-side image service (deferred to Step 7+ /
 *     image upload step). Only the storage_key is persisted.
 *   - `display_order` allows partners to control image carousel ordering.
 *   - `is_primary` flags the cover/thumbnail image for list views.
 *     Enforced as a partial unique index: at most one primary image per vehicle.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS vehicle_images (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_id    UUID        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      storage_key   TEXT        NOT NULL,
      display_order SMALLINT    NOT NULL DEFAULT 0,
      is_primary    BOOLEAN     NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_vehicle_images_display_order CHECK (display_order >= 0)
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_images_vehicle_id
    ON vehicle_images (vehicle_id);
  `);

  // At most one primary image per vehicle — enforced at the database level
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_vehicle_images_one_primary
    ON vehicle_images (vehicle_id)
    WHERE is_primary = true;
  `);

  // Ordering index: efficient retrieval sorted by display_order
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_images_vehicle_order
    ON vehicle_images (vehicle_id, display_order);
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS vehicle_images CASCADE;');
};
