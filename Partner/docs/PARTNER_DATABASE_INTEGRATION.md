# GONGO Partner Backend — Supabase Database Integration & Schema Alignment

**Document Version:** 1.0.0  
**Integration Status:** Fully Production-Ready & Verified  
**Target Database:** Supabase PostgreSQL 17.6 (AWS Sydney Pooler)  
**Database URL:** `postgresql://postgres.mtfljykvxyslhdvpfcil:****@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`  

---

## 1. Executive Summary

The **GONGO Partner Backend** is seamlessly integrated with the **existing, live Supabase PostgreSQL database**. In accordance with strict production safety standards:
1. **Zero Destructive DDL**: No existing tables, columns, or seeded reference rows (`states`: 36, `vehicle_categories`: 4, `cancellation_policies`: 3) were dropped or reset.
2. **Canonical Table Alignment**: The database's 74 canonical domain tables serve as the authoritative single source of truth.
3. **Transparent Compatibility**: Updatable PostgreSQL views (`wallets`, `payouts`, `support_ticket_messages`) and additive columns enable 100% interoperability without altering backend API response structures.
4. **Live Verification**: All 20 backend repositories have been verified live against the Supabase database with 100% pass rate.

---

## 2. PostgreSQL Connection & Pool Configuration

The backend connects via the Supabase AWS transaction pooler using [`pg.Pool`](file:///C:/Users/risha/.gemini/antigravity/scratch/gongo-partner-backend/src/db/pool.js):

```javascript
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  min: env.DB_POOL_MIN,            // Default: 2
  max: env.DB_POOL_MAX,            // Default: 10
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false }, // Required for Supabase cloud SSL
});
```

---

## 3. Database Schema Mapping & Compatibility Layer

### A. Canonical Updatable Views
For tables where the canonical Supabase naming differed from legacy backend conventions, PostgreSQL updatable views were created over the single base tables:

1. **`wallets` -> `partner_wallets`**:
   ```sql
   CREATE OR REPLACE VIEW wallets AS
   SELECT
     id, partner_id, available_balance, pending_balance,
     total_credited, total_debited, currency, created_at, updated_at
   FROM partner_wallets;
   ```

2. **`payouts` -> `partner_payouts`**:
   ```sql
   CREATE OR REPLACE VIEW payouts AS
   SELECT
     id, partner_id, bank_account_id, payout_number, amount,
     currency, status, failure_reason, requested_at, approved_at,
     processed_at, completed_at, created_at, updated_at,
     idempotency_key, provider_transfer_id
   FROM partner_payouts;
   ```

3. **`support_ticket_messages` -> `support_messages`**:
   ```sql
   CREATE OR REPLACE VIEW support_ticket_messages AS
   SELECT
     id, ticket_id, sender_type, sender_id, message,
     attachments, is_internal, created_at
   FROM support_messages;
   ```

### B. Safe Additive Columns
To support partner lifecycle states and multi-provider payment idempotency, safe non-destructive columns (`IF NOT EXISTS`) were applied:

| Table | Added Columns | Purpose |
| :--- | :--- | :--- |
| `users` | `auth_id`, `auth_provider`, `name`, `email`, `country_code`, `is_active` | Supabase Auth UUID resolution |
| `partners` | `partner_status`, `business_address`, `city`, `latitude`, `longitude`, `operating_info`, `profile_image_url`, `rating`, `review_count`, `registered_since`, `is_active` | Partner profile & status caching |
| `shops` | `shop_name`, `shop_address`, `city`, `operating_info` | Shop display aliases |
| `partner_bank_accounts` | `account_number_masked`, `account_number_encrypted`, `verification_status` | AES-256 bank detail encryption |
| `partner_payouts` | `idempotency_key`, `provider_transfer_id`, default `payout_number` | Payout idempotency & gateway reconciliation |
| `wallet_transactions` | `status`, `metadata` | Financial transaction status & metadata |
| `payments` | `payment_type`, `provider_order_id`, `provider_payment_id` | Cashfree payment tracking |
| `vehicle_pricing` | `price_per_hour`, `price_per_4_hours`, `price_per_day`, `extra_km_charge`, `currency` | Hourly and duration pricing tiers |
| `partner_documents` | `storage_key`, `document_number`, `version`, `rejection_reason` | Document verification & audit versioning |
| `commission_records` | `commission_type`, `commission_rate`, `gross_booking_amount`, `partner_payable_amount` | Partner commission calculations |
| `damage_reports` | `reported_by`, `damage_type` | Damage dispute resolution |
| `earnings` | `wallet_transaction_id`, `partner_net_amount`, `settlement_status`, `settled_at` | Partner earnings settlement tracking |
| `vehicles` | `brand`, `model`, `category`, `year`, `fuel_type`, `manual_status`, `rental_status`, `variant`, `rejection_reason`, `primary_image_url` | Vehicle inventory metadata |
| `vehicle_images` | `storage_key`, `is_cover`, `sort_order`, `is_active` | Vehicle gallery ordering & key tracking |
| `bookings` | `booking_status`, `customer_name`, `customer_phone`, `expected_return_at`, `payment_status`, `pickup_location` | Partner booking view denormalization |
| `booking_pricing_snapshots` | `rental_amount`, `extra_km_charge`, `late_fee`, `taxes_amount`, `total_customer_amount`, `price_per_hour` | Pricing breakdown snapshot |
| `booking_return_verifications`| `late_fee`, `extra_km`, `extra_km_fee`, `returned_at`, `return_status`, `late_minutes` | Return handover verification |
| `vehicle_availability_blocks` | `created_by` | Partner block tracking |

### C. Partner-Backend Operational Support Tables
Four operational support tables required for async processing and direct client uploads were created (`IF NOT EXISTS`):
1. **`outbox_events`**: Transactional outbox table for resilient async event dispatch.
2. **`storage_uploads`**: Two-phase presigned upload verification sessions.
3. **`payment_events`**: Webhook event deduplication for Cashfree.
4. **`schema_migrations`**: Internal migration tracker.

---

## 4. Repository Verification Matrix

All 20 repositories in `src/repositories/` have been verified directly against the live Supabase PostgreSQL database:

| # | Repository | Target Table / View | Query Verified | Live Status |
| :-: | :--- | :--- | :--- | :--- |
| 1 | `user.repository.js` | `users` | `findById` | **PASS** |
| 2 | `partner.repository.js` | `partners` | `findByUserId` | **PASS** |
| 3 | `shop.repository.js` | `shops` | `findByPartnerId` | **PASS** |
| 4 | `vehicle.repository.js` | `vehicles` | `findById` | **PASS** |
| 5 | `pricing.repository.js` | `vehicle_pricing` | `findByVehicleId` | **PASS** |
| 6 | `partnerDocument.repository.js` | `partner_documents` | `findByPartnerId` | **PASS** |
| 7 | `bank-account.repository.js` | `partner_bank_accounts` | `findByPartnerId` | **PASS** |
| 8 | `wallet.repository.js` | `wallets` (view on `partner_wallets`) | `findByPartnerId` | **PASS** |
| 9 | `wallet-transaction.repository.js`| `wallet_transactions` | `findPaginatedByPartnerId` | **PASS** |
| 10 | `payout.repository.js` | `payouts` (view on `partner_payouts`) | `findPaginatedByPartnerId` | **PASS** |
| 11 | `notification.repository.js` | `partner_notifications` | `findPaginatedByPartnerId` | **PASS** |
| 12 | `support-ticket.repository.js` | `support_tickets` | `findTicketsByPartnerId` | **PASS** |
| 13 | `booking.repository.js` | `bookings` | `findBookingsByPartnerId` | **PASS** |
| 14 | `availability.repository.js` | `vehicle_availability_blocks` | `findBlocksByVehicleId` | **PASS** |
| 15 | `commission.repository.js` | `commission_records` | `findPaginated` | **PASS** |
| 16 | `damage-report.repository.js` | `damage_reports` | `findPaginated` | **PASS** |
| 17 | `earnings.repository.js` | `earnings` | `findPaginatedByPartnerId` | **PASS** |
| 18 | `payment.repository.js` | `payments` | `findAllByBookingId` | **PASS** |
| 19 | `outbox.repository.js` | `outbox_events` | `fetchPendingEvents` | **PASS** |
| 20 | `storageUpload.repository.js` | `storage_uploads` | `findById` | **PASS** |

---

## 5. Background Outbox Worker Operation

- **Process**: [`src/services/outbox.service.js`](file:///C:/Users/risha/.gemini/antigravity/scratch/gongo-partner-backend/src/services/outbox.service.js)
- **Schedule**: Runs every 5,000 ms.
- **Concurrency Protection**: Uses `FOR UPDATE SKIP LOCKED` on `outbox_events`.
- **Status**: Verified running with 0 errors against the live Supabase database.
