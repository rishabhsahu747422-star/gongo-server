'use strict';

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.sql(`
    CREATE TABLE IF NOT EXISTS bookings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_number VARCHAR(50) NOT NULL,
      customer_id UUID NOT NULL,
      customer_name VARCHAR(150),
      customer_phone VARCHAR(20),
      partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
      shop_id UUID REFERENCES shops(id) ON DELETE RESTRICT,
      vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
      start_at TIMESTAMPTZ NOT NULL,
      expected_return_at TIMESTAMPTZ NOT NULL,
      booking_status VARCHAR(30) NOT NULL DEFAULT 'UPCOMING',
      payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      pickup_location TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uq_bookings_booking_number UNIQUE (booking_number),
      CONSTRAINT chk_bookings_time_range CHECK (start_at < expected_return_at),
      CONSTRAINT chk_bookings_status CHECK (booking_status IN ('UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
      CONSTRAINT chk_bookings_payment_status CHECK (payment_status IN ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'))
    );
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_partner_id
    ON bookings (partner_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_customer_id
    ON bookings (customer_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_vehicle_id
    ON bookings (vehicle_id);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_status
    ON bookings (booking_status);
  `);

  await pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_bookings_vehicle_time
    ON bookings (vehicle_id, start_at, expected_return_at);
  `);

  await pgm.sql(`
    DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;
    CREATE TRIGGER trg_bookings_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);
};

exports.down = async (pgm) => {
  await pgm.sql('DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;');
  await pgm.sql('DROP TABLE IF EXISTS bookings CASCADE;');
};
