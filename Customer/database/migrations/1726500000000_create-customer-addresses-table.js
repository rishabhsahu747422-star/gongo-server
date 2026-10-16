'use strict';

/**
 * Migration: Create customer_addresses table.
 *
 * Design decisions:
 * - Partial unique index on (user_id) WHERE is_default = true enforces at most
 *   one default address per customer at the database level.
 * - Coordinates are NUMERIC(10,7) (7 decimal places ~ 1.1 cm precision).
 * - label CHECK enforces 'HOME', 'WORK', 'OTHER' only.
 * - lat/lon are nullable - not every address has coordinates.
 * - ON DELETE CASCADE: removing a user removes all their addresses.
 * - Delete behaviour: when the default address is deleted, no auto-promotion
 *   occurs; the customer simply has no default. The client can then set a new
 *   default via PATCH /api/v1/customers/me/addresses/:id/default.
 */

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS customer_addresses (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label         VARCHAR(10) NOT NULL DEFAULT 'OTHER',
      full_address  TEXT        NOT NULL,
      address_line1 VARCHAR(255),
      address_line2 VARCHAR(255),
      landmark      VARCHAR(100),
      city          VARCHAR(100),
      state         VARCHAR(100),
      postal_code   VARCHAR(20),
      country_code  VARCHAR(5)  NOT NULL DEFAULT 'IN',
      latitude      NUMERIC(10,7),
      longitude     NUMERIC(10,7),
      is_default    BOOLEAN     NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_customer_addresses_label CHECK (
        label IN ('HOME', 'WORK', 'OTHER')
      ),
      CONSTRAINT chk_customer_addresses_latitude CHECK (
        latitude IS NULL OR (latitude >= -90 AND latitude <= 90)
      ),
      CONSTRAINT chk_customer_addresses_longitude CHECK (
        longitude IS NULL OR (longitude >= -180 AND longitude <= 180)
      )
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_customer_addresses_user_id
    ON customer_addresses (user_id);
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_customer_addresses_one_default
    ON customer_addresses (user_id)
    WHERE is_default = true;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_customer_addresses_updated_at ON customer_addresses;
    CREATE TRIGGER trg_customer_addresses_updated_at
    BEFORE UPDATE ON customer_addresses
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_customer_addresses_updated_at ON customer_addresses;');
  pgm.sql('DROP TABLE IF EXISTS customer_addresses CASCADE;');
};
