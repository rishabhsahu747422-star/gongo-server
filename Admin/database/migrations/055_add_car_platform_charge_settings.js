'use strict';

exports.shorthands = undefined;

/**
 * Migration 055: Add Car platform fee settings to platform_charge_settings
 *
 * Updates CHECK constraint on charge_type to allow car-specific platform fee charge types:
 * - service_charge_car
 * - convenience_fee_car
 * - gst_car
 *
 * Seeds initial car platform charges if not already present:
 * - service_charge_car: fixed ₹5.00
 * - convenience_fee_car: fixed ₹3.00
 * - gst_car: percentage 18.00%
 *
 * Leaves existing bike records completely untouched.
 */
exports.up = async (pgm) => {
  // 1. Update charge_type CHECK constraint
  await pgm.sql(`
    ALTER TABLE platform_charge_settings
    DROP CONSTRAINT IF EXISTS platform_charge_settings_charge_type_check;

    ALTER TABLE platform_charge_settings
    ADD CONSTRAINT platform_charge_settings_charge_type_check
    CHECK (charge_type IN (
      'convenience_fee',
      'service_charge',
      'gst',
      'convenience_fee_car',
      'service_charge_car',
      'gst_car'
    ));

    -- Update GST check constraints to also cover gst_car
    ALTER TABLE platform_charge_settings
    DROP CONSTRAINT IF EXISTS platform_charge_settings_gst_type_check;

    ALTER TABLE platform_charge_settings
    ADD CONSTRAINT platform_charge_settings_gst_type_check
    CHECK (charge_type NOT IN ('gst', 'gst_car') OR calculation_type = 'percentage');

    ALTER TABLE platform_charge_settings
    DROP CONSTRAINT IF EXISTS platform_charge_settings_gst_value_check;

    ALTER TABLE platform_charge_settings
    ADD CONSTRAINT platform_charge_settings_gst_value_check
    CHECK (charge_type NOT IN ('gst', 'gst_car') OR value <= 100);
  `);

  // 2. Insert initial car-specific charge settings if not existing
  await pgm.sql(`
    INSERT INTO platform_charge_settings (charge_type, calculation_type, value, currency, is_active, created_at, updated_at)
    SELECT 'service_charge_car', 'fixed', 5.00, 'INR', true, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM platform_charge_settings WHERE charge_type = 'service_charge_car' AND is_active = true
    );

    INSERT INTO platform_charge_settings (charge_type, calculation_type, value, currency, is_active, created_at, updated_at)
    SELECT 'convenience_fee_car', 'fixed', 3.00, 'INR', true, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM platform_charge_settings WHERE charge_type = 'convenience_fee_car' AND is_active = true
    );

    INSERT INTO platform_charge_settings (charge_type, calculation_type, value, currency, is_active, created_at, updated_at)
    SELECT 'gst_car', 'percentage', 18.00, 'INR', true, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM platform_charge_settings WHERE charge_type = 'gst_car' AND is_active = true
    );
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    DELETE FROM platform_charge_settings
    WHERE charge_type IN ('service_charge_car', 'convenience_fee_car', 'gst_car');

    ALTER TABLE platform_charge_settings
    DROP CONSTRAINT IF EXISTS platform_charge_settings_charge_type_check;

    ALTER TABLE platform_charge_settings
    ADD CONSTRAINT platform_charge_settings_charge_type_check
    CHECK (charge_type IN ('convenience_fee', 'service_charge', 'gst'));

    ALTER TABLE platform_charge_settings
    DROP CONSTRAINT IF EXISTS platform_charge_settings_gst_type_check;

    ALTER TABLE platform_charge_settings
    ADD CONSTRAINT platform_charge_settings_gst_type_check
    CHECK (charge_type <> 'gst' OR calculation_type = 'percentage');

    ALTER TABLE platform_charge_settings
    DROP CONSTRAINT IF EXISTS platform_charge_settings_gst_value_check;

    ALTER TABLE platform_charge_settings
    ADD CONSTRAINT platform_charge_settings_gst_value_check
    CHECK (charge_type <> 'gst' OR value <= 100);
  `);
};
