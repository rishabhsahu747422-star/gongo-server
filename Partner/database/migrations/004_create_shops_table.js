'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS shops (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      shop_name VARCHAR(200) NOT NULL,
      shop_address TEXT NOT NULL,
      city VARCHAR(100) NOT NULL,
      latitude NUMERIC(10,7),
      longitude NUMERIC(10,7),
      operating_info VARCHAR(200),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_shops_partner_id
    ON shops (partner_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_shops_city
    ON shops (city);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_shops_updated_at ON shops;
    CREATE TRIGGER trg_shops_updated_at
    BEFORE UPDATE ON shops
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_shops_updated_at ON shops;');
  await pgm.sql('DROP TABLE IF EXISTS shops CASCADE;');
};
