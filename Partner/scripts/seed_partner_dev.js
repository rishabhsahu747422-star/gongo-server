'use strict';

require('dotenv').config();

const { pool } = require('../src/db/pool');
const env = require('../src/config/env');

async function seedPartnerDev() {
  if (env.isProduction) {
    console.error('CRITICAL: seed:partner-dev is strictly forbidden in production!');
    process.exit(1);
  }

  console.log('====================================================');
  console.log('GONGO PARTNER — SEEDING DEVELOPMENT TEST IDENTITIES');
  console.log('====================================================');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─────────────────────────────────────────────────────────────
    // 1. Partner A (Primary Development Test Partner)
    // ─────────────────────────────────────────────────────────────
    const devAuthIdA = env.PARTNER_DEV_AUTH_ID || 'dev-partner-auth-id';
    const devPhoneA = '9999999999';
    const devEmailA = 'dev.partner@gongo.in';

    let userARes = await client.query('SELECT id FROM users WHERE auth_id = $1 LIMIT 1', [devAuthIdA]);
    let userAId;
    if (userARes.rows.length === 0) {
      // Check if phone exists on another user
      await client.query('DELETE FROM users WHERE phone = $1', [devPhoneA]);
      const insUser = await client.query(`
        INSERT INTO users (auth_id, auth_provider, role, name, country_code, phone, email, is_active)
        VALUES ($1, 'supabase', 'partner', 'GONGO Test Partner', '+91', $2, $3, true)
        RETURNING id
      `, [devAuthIdA, devPhoneA, devEmailA]);
      userAId = insUser.rows[0].id;
      console.log('✓ Created User A:', userAId);
    } else {
      userAId = userARes.rows[0].id;
      await client.query(`
        UPDATE users 
        SET role = 'partner', name = 'GONGO Test Partner', phone = $2, email = $3, is_active = true
        WHERE id = $1
      `, [userAId, devPhoneA, devEmailA]);
      console.log('✓ Reused User A:', userAId);
    }

    let partnerARes = await client.query('SELECT id FROM partners WHERE user_id = $1 LIMIT 1', [userAId]);
    let partnerAId;
    if (partnerARes.rows.length === 0) {
      const insPartner = await client.query(`
        INSERT INTO partners (
          user_id, partner_code, business_name, business_address, city,
          latitude, longitude, partner_status, kyc_status, verification_status,
          rating, review_count, registered_since, is_active
        )
        VALUES (
          $1, 'PTR-DEV-001', 'GONGO Dev Garage', '100 Feet Road, 4th Block, Koramangala', 'Bangalore',
          12.9352, 77.6245, 'ONLINE', 'VERIFIED', 'verified',
          5.0, 10, 'Jan 2025', true
        )
        RETURNING id
      `, [userAId]);
      partnerAId = insPartner.rows[0].id;
      console.log('✓ Created Partner A:', partnerAId);
    } else {
      partnerAId = partnerARes.rows[0].id;
      await client.query(`
        UPDATE partners
        SET partner_status = 'ONLINE', kyc_status = 'VERIFIED', is_active = true,
            business_name = 'GONGO Dev Garage', city = 'Bangalore'
        WHERE id = $1
      `, [partnerAId]);
      console.log('✓ Reused Partner A:', partnerAId);
    }

    let shopARes = await client.query('SELECT id FROM shops WHERE partner_id = $1 LIMIT 1', [partnerAId]);
    let shopAId;
    if (shopARes.rows.length === 0) {
      const insShop = await client.query(`
        INSERT INTO shops (
          partner_id, shop_name, shop_address, city,
          latitude, longitude, operating_info, is_active
        )
        VALUES (
          $1, 'GONGO Koramangala Hub', '100 Feet Road, 4th Block, Koramangala, Bangalore', 'Bangalore',
          12.9352, 77.6245, '08:00 AM - 10:00 PM (All Days)', true
        )
        RETURNING id
      `, [partnerAId]);
      shopAId = insShop.rows[0].id;
      console.log('✓ Created Shop A:', shopAId);
    } else {
      shopAId = shopARes.rows[0].id;
      console.log('✓ Reused Shop A:', shopAId);
    }

    let walletARes = await client.query('SELECT id FROM partner_wallets WHERE partner_id = $1 LIMIT 1', [partnerAId]);
    if (walletARes.rows.length === 0) {
      await client.query(`
        INSERT INTO partner_wallets (
          partner_id, pending_balance, available_balance, receivable_balance,
          total_earned, total_paid_out, currency, total_credited, total_debited
        )
        VALUES ($1, 0.00, 5000.00, 0.00, 15000.00, 10000.00, 'INR', 15000.00, 10000.00)
      `, [partnerAId]);
      console.log('✓ Created Wallet A with 5000.00 balance');
    } else {
      console.log('✓ Reused Wallet A');
    }

    let bankARes = await client.query('SELECT id FROM partner_bank_accounts WHERE partner_id = $1 LIMIT 1', [partnerAId]);
    if (bankARes.rows.length === 0) {
      await client.query(`
        INSERT INTO partner_bank_accounts (
          partner_id, account_holder_name, bank_name, account_number,
          account_number_masked, ifsc_code, is_primary, verification_status
        )
        VALUES ($1, 'GONGO Test Partner', 'HDFC Bank', '123456789012', 'XXXXXXXX9012', 'HDFC0001234', true, 'VERIFIED')
      `, [partnerAId]);
      console.log('✓ Created Primary Bank Account A');
    } else {
      console.log('✓ Reused Bank Account A');
    }

    // ─────────────────────────────────────────────────────────────
    // 2. Partner B (Secondary BOLA Control Partner)
    // ─────────────────────────────────────────────────────────────
    const devAuthIdB = 'dev-partner-b-auth-id';
    const devPhoneB = '9999999998';
    const devEmailB = 'dev.partner.b@gongo.in';

    let userBRes = await client.query('SELECT id FROM users WHERE auth_id = $1 LIMIT 1', [devAuthIdB]);
    let userBId;
    if (userBRes.rows.length === 0) {
      await client.query('DELETE FROM users WHERE phone = $1', [devPhoneB]);
      const insUserB = await client.query(`
        INSERT INTO users (auth_id, auth_provider, role, name, country_code, phone, email, is_active)
        VALUES ($1, 'supabase', 'partner', 'BOLA Control Partner B', '+91', $2, $3, true)
        RETURNING id
      `, [devAuthIdB, devPhoneB, devEmailB]);
      userBId = insUserB.rows[0].id;
      console.log('✓ Created User B (BOLA Control):', userBId);
    } else {
      userBId = userBRes.rows[0].id;
      console.log('✓ Reused User B:', userBId);
    }

    let partnerBRes = await client.query('SELECT id FROM partners WHERE user_id = $1 LIMIT 1', [userBId]);
    let partnerBId;
    if (partnerBRes.rows.length === 0) {
      const insPartnerB = await client.query(`
        INSERT INTO partners (
          user_id, partner_code, business_name, business_address, city,
          latitude, longitude, partner_status, kyc_status, verification_status,
          rating, review_count, registered_since, is_active
        )
        VALUES (
          $1, 'PTR-DEV-002', 'Partner B Indiranagar Hub', '12th Main Road, Indiranagar', 'Bangalore',
          12.9719, 77.6412, 'ONLINE', 'VERIFIED', 'verified',
          4.8, 5, 'Feb 2025', true
        )
        RETURNING id
      `, [userBId]);
      partnerBId = insPartnerB.rows[0].id;
      console.log('✓ Created Partner B:', partnerBId);
    } else {
      partnerBId = partnerBRes.rows[0].id;
      console.log('✓ Reused Partner B:', partnerBId);
    }

    let shopBRes = await client.query('SELECT id FROM shops WHERE partner_id = $1 LIMIT 1', [partnerBId]);
    let shopBId;
    if (shopBRes.rows.length === 0) {
      const insShopB = await client.query(`
        INSERT INTO shops (
          partner_id, shop_name, shop_address, city,
          latitude, longitude, operating_info, is_active
        )
        VALUES (
          $1, 'Partner B Hub', '12th Main Road, Indiranagar, Bangalore', 'Bangalore',
          12.9719, 77.6412, '09:00 AM - 09:00 PM (All Days)', true
        )
        RETURNING id
      `, [partnerBId]);
      shopBId = insShopB.rows[0].id;
      console.log('✓ Created Shop B:', shopBId);
    } else {
      shopBId = shopBRes.rows[0].id;
      console.log('✓ Reused Shop B:', shopBId);
    }

    let walletBRes = await client.query('SELECT id FROM partner_wallets WHERE partner_id = $1 LIMIT 1', [partnerBId]);
    if (walletBRes.rows.length === 0) {
      await client.query(`
        INSERT INTO partner_wallets (
          partner_id, pending_balance, available_balance, receivable_balance,
          total_earned, total_paid_out, currency, total_credited, total_debited
        )
        VALUES ($1, 0.00, 2000.00, 0.00, 5000.00, 3000.00, 'INR', 5000.00, 3000.00)
      `, [partnerBId]);
      console.log('✓ Created Wallet B');
    } else {
      console.log('✓ Reused Wallet B');
    }

    // Baseline vehicle for Partner B (Used for cross-partner BOLA testing)
    const vehBReg = 'KA01DEV9998';
    let vehBRes = await client.query('SELECT id FROM vehicles WHERE registration_number = $1 LIMIT 1', [vehBReg]);
    if (vehBRes.rows.length === 0) {
      const insVehB = await client.query(`
        INSERT INTO vehicles (
          partner_id, shop_id, category, brand, model,
          registration_number, year, fuel_type, manual_status, rental_status,
          verification_status, is_active, is_available
        )
        VALUES (
          $1, $2, 'Motorcycle', 'Royal Enfield', 'Classic 350',
          $3, 2024, 'Petrol', 'ONLINE', 'IDLE',
          'VERIFIED', true, true
        )
        RETURNING id
      `, [partnerBId, shopBId, vehBReg]);
      const vehBId = insVehB.rows[0].id;
      await client.query(`
        INSERT INTO vehicle_pricing (
          vehicle_id, pricing_type, price, min_duration, security_deposit,
          is_active, effective_from, price_per_hour, price_per_4_hours, price_per_day, extra_km_charge, currency
        )
        VALUES ($1, 'daily', 900.00, 1, 2000.00, true, CURRENT_TIMESTAMP, 99.00, 299.00, 900.00, 10.00, 'INR')
      `, [vehBId]);
      console.log('✓ Created Partner B Vehicle (BOLA target):', vehBId);
    } else {
      console.log('✓ Reused Partner B Vehicle:', vehBRes.rows[0].id);
    }

    await client.query('COMMIT');
    console.log('====================================================');
    console.log('✓ SEEDING COMPLETED SUCCESSFULLY!');
    console.log(`Primary Partner Auth ID:   ${devAuthIdA}`);
    console.log(`Primary Dev Token:         dev-partner-token`);
    console.log(`BOLA Partner B Auth ID:    ${devAuthIdB}`);
    console.log(`BOLA Partner B Dev Token:  dev-token-${devAuthIdB}`);
    console.log('====================================================');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seeding failed:', err);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

seedPartnerDev();
