# GONGO Partner Backend — Supabase Database Compatibility Audit
**Audit Date:** 2026-09-29  
**Target Database:** Supabase PostgreSQL (`postgresql://postgres.mtfljykvxyslhdvpfcil:****@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`)  
**Project ID:** `mtfljykvxyslhdvpfcil`  
**Reference Document:** `GONGO_DATABASE_REFERENCE.md`  

---

## Executive Summary
This document provides an exhaustive, read-only compatibility audit between the **live deployed Supabase PostgreSQL database** (containing 74 canonical public tables) and the **GONGO Partner Backend** codebase (`gongo-partner-backend`).

In accordance with Section 1 of the instructions (*ABSOLUTE SAFETY RULES*):
- No database tables or columns were dropped, recreated, truncated, or modified during this audit.
- The live Supabase schema is treated as the primary source of truth.
- All 74 existing business tables are cataloged and mapped for reuse by the Partner Backend.

---

## A. Existing Tables in Live Supabase Database (74 Tables)

The live Supabase database contains the following 74 tables in the `public` schema:

1. `admin_actions`
2. `areas`
3. `audit_logs`
4. `booking_cancellations`
5. `booking_customer_details`
6. `booking_items`
7. `booking_pickup`
8. `booking_price_breakdown`
9. `booking_return`
10. `booking_status_history`
11. `bookings`
12. `cancellation_policies` (Seeded: 3 rows)
13. `cities`
14. `commission_rules`
15. `commission_transactions`
16. `coupon_redemptions`
17. `coupon_rules`
18. `coupons`
19. `customer_documents`
20. `customer_identity_verifications`
21. `customer_profiles`
22. `customer_saved_addresses`
23. `dispute_evidence`
24. `disputes`
25. `notification_templates`
26. `notifications`
27. `offer_shops`
28. `offer_vehicles`
29. `offers`
30. `partner_bank_accounts`
31. `partner_documents`
32. `partner_kyc`
33. `partner_payouts`
34. `partner_verification_history`
35. `partner_wallets`
36. `partners`
37. `payment_attempts`
38. `payment_transactions`
39. `payment_webhooks`
40. `payments`
41. `payout_transactions`
42. `refund_transactions`
43. `refunds`
44. `rental_agreements`
45. `review_replies`
46. `review_reports`
47. `reviews`
48. `shop_documents`
49. `shop_images`
50. `shop_operating_hours`
51. `shop_verification_history`
52. `shops`
53. `states` (Seeded: 36 rows)
54. `support_attachments`
55. `support_messages`
56. `support_tickets`
57. `ticket_status_history`
58. `user_devices`
59. `user_notification_preferences`
60. `users`
61. `vehicle_availability`
62. `vehicle_blocked_periods`
63. `vehicle_brands`
64. `vehicle_categories` (Seeded: 4 rows: BIKE, SCOOTY, CAR, EV)
65. `vehicle_documents`
66. `vehicle_extra_charges`
67. `vehicle_feature_values`
68. `vehicle_features`
69. `vehicle_images`
70. `vehicle_models`
71. `vehicle_pricing`
72. `vehicle_pricing_rules`
73. `vehicles`
74. `wallet_transactions`

---

## B. Tables Expected by Partner Backend vs. Supabase Mapping

The Partner Backend currently interfaces with 20 repository domains. Below is the mapping between the legacy backend assumptions and the canonical Supabase tables:

| Backend Repository | Legacy Backend Assumption | Existing Supabase Table | Direct Match? | Status / Action |
| :--- | :--- | :--- | :--- | :--- |
| `user.repository.js` | `users` | `users` | **YES** | Additive columns needed for Supabase Auth |
| `partner.repository.js` | `partners` | `partners` | **YES** | Align query aliases to canonical columns |
| `shop.repository.js` | `shops` | `shops` | **YES** | Align query aliases to canonical columns |
| `vehicle.repository.js` | `vehicles` | `vehicles` | **YES** | Map vehicle taxonomy (`model_id`) |
| `pricing.repository.js` | `vehicle_pricing` | `vehicle_pricing` | **YES** | Reuse canonical table |
| `partnerDocument.repository.js` | `partner_documents` | `partner_documents` | **YES** | Reuse canonical table |
| `bank-account.repository.js` | `partner_bank_accounts` | `partner_bank_accounts`| **YES** | Reuse canonical table |
| `wallet-transaction.repository.js`| `wallet_transactions` | `wallet_transactions` | **YES** | Reuse canonical table |
| `booking.repository.js` | `bookings` | `bookings` | **YES** | Reuse canonical table |
| `payment.repository.js` | `payments` | `payments` | **YES** | Reuse canonical table |
| `support-ticket.repository.js` | `support_tickets` | `support_tickets` | **YES** | Reuse canonical table |
| `wallet.repository.js` | `wallets` | `partner_wallets` | **NO** | Adapt repository to `partner_wallets` |
| `payout.repository.js` | `payouts` | `partner_payouts` | **NO** | Adapt repository to `partner_payouts` |
| `notification.repository.js` | `partner_notifications` | `notifications` | **NO** | Adapt repository to `notifications` |
| `notification.repository.js` | `partner_device_tokens` | `user_devices` | **NO** | Adapt repository to `user_devices` |
| `support-ticket.repository.js` | `support_ticket_messages`| `support_messages` | **NO** | Adapt repository to `support_messages` |
| `availability.repository.js` | `vehicle_availability_blocks`| `vehicle_availability` / `vehicle_blocked_periods` | **NO** | Adapt to canonical availability tables |
| `booking.repository.js` (handover)| `booking_pickup_verifications`| `booking_pickup` | **NO** | Adapt repository to `booking_pickup` |
| `booking.repository.js` (return) | `booking_return_verifications`| `booking_return` | **NO** | Adapt repository to `booking_return` |
| `damage-report.repository.js` | `damage_reports` | `disputes` / `booking_return` | **NO** | Safe view/table alignment |
| `outbox.repository.js` | `outbox_events` | *(None)* | **NO** | Safe additive migration required |
| `storageUpload.repository.js` | `storage_uploads` | *(None)* | **NO** | Safe additive migration required |

---

## C. Missing Tables in Supabase

Two operational support tables required by the Partner Backend's asynchronous background workers and direct-to-storage presigned upload verification do not exist in the 74 canonical domain tables:

1. **`outbox_events`**:
   - **Purpose**: Implements the Transactional Outbox Pattern for resilient, asynchronous event dispatch (notifications, analytics, payment webhooks).
   - **Impact**: Without this table, the outbox worker emits: `relation "outbox_events" does not exist`.
   - **Resolution**: Create via a safe, non-destructive additive migration (`IF NOT EXISTS`).

2. **`storage_uploads`**:
   - **Purpose**: Ephemeral tracking of presigned direct client upload sessions, recording `expected_size_bytes`, `content_type`, `expires_at`, and completion state for magic-byte verification.
   - **Impact**: Required by `storageUpload.repository.js` during two-phase upload confirmation.
   - **Resolution**: Create via a safe, non-destructive additive migration (`IF NOT EXISTS`).

3. **`schema_migrations`**:
   - **Purpose**: PostgreSQL migration tracking engine for safe forward migrations.
   - **Impact**: Initialized automatically with `CREATE TABLE IF NOT EXISTS schema_migrations`.

---

## D. Column Mismatches in Key Existing Tables

### 1. `users` Table
- **Supabase Current Columns**: `id`, `phone`, `role`, `status`, `created_at`, `updated_at`, `deleted_at`, `firebase_uid`.
- **Backend Expected Columns**: `auth_id`, `auth_provider`, `name`, `email`, `is_active`.
- **Analysis**:
  - `firebase_uid` was the legacy auth identifier.
  - Supabase Auth uses a UUID (`sub` claim in Supabase JWT).
  - To support Supabase Auth without breaking existing `firebase_uid` historical references, `auth_id` (`VARCHAR(128)`) and `auth_provider` (`VARCHAR(50) DEFAULT 'supabase'`) must be added as additive columns.
  - `status` in Supabase corresponds to `is_active` (`status = 'active'`). Add an `is_active BOOLEAN GENERATED ALWAYS AS (status = 'active' AND deleted_at IS NULL) STORED` or boolean column default `true`.
  - `name` and `email` can be added as nullable columns on `users` or mapped to `partners.contact_email` / `business_name`.

### 2. `partners` Table
- **Supabase Current Columns**: `id`, `user_id`, `partner_code`, `business_name`, `business_type`, `description`, `contact_phone`, `contact_email`, `status`, `kyc_status`, `verification_status`, `commission_rate`, `onboarding_completed`, `verified_at`, `created_at`, `updated_at`, `deleted_at`.
- **Backend Legacy Expectations**: `partner_status`, `profile_image_url`, `rating`, `review_count`, `registered_since`, `is_active`.
- **Analysis**:
  - In Supabase, partner lifecycle status is in column `status` (values: `'pending'`, `'active'`, `'suspended'`, etc.). The backend can alias `status AS partner_status` or add a compatibility alias column.
  - `profile_image_url` and `rating` can be safely added via non-destructive `ADD COLUMN IF NOT EXISTS`.

### 3. `shops` Table
- **Supabase Current Columns**: `id`, `partner_id`, `name`, `description`, `contact_phone`, `contact_email`, `address_line1`, `address_line2`, `state_id`, `city_id`, `area_id`, `postal_code`, `latitude`, `longitude`, `status`, `verification_status`, `is_active`, `created_at`, `updated_at`.
- **Backend Legacy Expectations**: `shop_name`, `shop_address`, `city`, `operating_info`.
- **Analysis**:
  - Adapt repository queries: `SELECT name AS shop_name, address_line1 AS shop_address ...`.
  - Add optional columns `operating_info TEXT` and `city VARCHAR(100)` if not normalized through `cities` table.

### 4. `partner_wallets` Table
- **Supabase Current Columns**: `id`, `partner_id`, `pending_balance`, `available_balance`, `receivable_balance`, `total_earned`, `total_paid_out`, `currency`, `created_at`, `updated_at`.
- **Backend Legacy Expectations (`wallets`)**: `balance` (or `available_balance`), `total_credited`, `total_debited`.
- **Analysis**:
  - Supabase `partner_wallets` already has `available_balance`, `total_earned`, `total_paid_out`.
  - Map `available_balance` directly. Add `total_credited NUMERIC(12,2) DEFAULT 0` and `total_debited NUMERIC(12,2) DEFAULT 0` or alias to `total_earned` / `total_paid_out`.

### 5. `vehicles` Table
- **Supabase Current Columns**: `id`, `partner_id`, `shop_id`, `model_id`, `registration_number`, `chassis_number`, `engine_number`, `color`, `status`, `verification_status`, `is_active`, `is_available`, `vehicle_description`, `manufacture_year`, `engine_capacity`, `current_odometer`, `helmet_included`, `created_at`, `updated_at`.
- **Backend Legacy Expectations**: `brand`, `model`, `category`, `year`, `fuel_type`, `daily_rate`.
- **Analysis**:
  - In Supabase, vehicle taxonomy is normalized (`model_id -> vehicle_models -> vehicle_brands & vehicle_categories`).
  - Pricing is in `vehicle_pricing` (`vehicle_id`, `price`).
  - Adapt `vehicle.repository.js` to JOIN `vehicle_models`, `vehicle_brands`, and `vehicle_categories` to return brand/model/category strings seamlessly.

---

## E. Data Type Mismatches
All core financial and temporal data types in the Supabase schema conform to production standards:
- Identifiers: `UUID` (`gen_random_uuid()`) — 100% compatible.
- Monetary amounts: `NUMERIC(12,2)` / `NUMERIC` — 100% compatible with backend calculation logic.
- Timestamps: `TIMESTAMPTZ` (`timestamp with time zone`) — 100% compatible with ISO-8601 parsing.
- Enums/Status: `VARCHAR` with lowercase default (`'pending'`, `'active'`, `'confirmed'`) vs. uppercase in some backend constants. Repositories must handle case-insensitivity seamlessly using `LOWER(status)` or case-normalizing DTOs.

---

## F. Indexes Audit
The live Supabase database already contains 256 indexes covering:
- Primary keys (`_pkey`) on all 74 tables.
- Foreign key lookup indexes (e.g., `idx_partners_user_id`, `idx_vehicles_partner_id`, `idx_bookings_partner_id`).
- Unique constraints (e.g., `users_phone_key`, `vehicles_registration_number_key`).

**Recommended Additional Indexes for Partner Backend Query Paths:**
- `idx_users_auth_id` on `users(auth_id)` for sub-millisecond session resolution.
- `idx_partner_wallets_partner_id` on `partner_wallets(partner_id)`.
- `idx_outbox_events_status_scheduled` on `outbox_events(status, scheduled_at)` (for worker polling).

---

## G. Constraints & Referential Integrity
- Supabase enforces 154 foreign key constraints with strict referential integrity (`ON DELETE RESTRICT` or `ON DELETE CASCADE`).
- All partner resources (`vehicles`, `shops`, `partner_documents`, `partner_kyc`, `partner_wallets`, `bookings`) strictly reference `partners(id)`.
- Partner identity references `users(id)`.
- Invariant preservation: Never bypass foreign keys; resolve entity relationships in strict dependency order.

---

## H. Authentication Schema Differences
- **Current State in Supabase**: `users` table has `firebase_uid VARCHAR(128) NULL UNIQUE`.
- **Target Architecture**:
  - Partner Frontend logs in via **Supabase Auth Phone OTP (Twilio)**.
  - Client sends `Authorization: Bearer <Supabase_Access_Token>`.
  - Backend verifies JWT using Supabase Auth public JWKS/verifyToken.
  - Token claims contain Supabase UUID in `sub`.
  - Backend resolves: `Supabase UID` → `users.auth_id` → `partners.user_id`.
- **Required Safe Migration**:
  - `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_id VARCHAR(128);`
  - `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'supabase';`
  - `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_id ON users(auth_id) WHERE auth_id IS NOT NULL;`
  - Existing `firebase_uid` column is preserved unmodified for audit and historical continuity.

---

## I. Outbox Schema Differences
- The transactional outbox worker in [`src/services/outbox.service.js`](file:///C:/Users/risha/.gemini/antigravity/scratch/gongo-partner-backend/src/services/outbox.service.js) queries `outbox_events`.
- Supabase does not currently contain this table.
- **Required Safe Additive Migration**:
  ```sql
  CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 5,
    last_error TEXT,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_events_status_scheduled ON outbox_events (status, scheduled_at);
  ```

---

## J. Storage-Related Database References
- Supabase Storage private bucket `gongo-partner-documents` (or `gongo-uploads`) stores all private binaries.
- Binary URLs in the database:
  - `partner_documents.file_url`: Stores Supabase Storage key (e.g., `partners/{partnerId}/kyc/aadhaar/{uuid}.png`).
  - `vehicle_images.image_url`: Stores Supabase Storage key.
  - `vehicle_documents.file_url`: Stores Supabase Storage key.
- Two-phase presigned upload confirmation uses `storage_uploads` to track upload expiry and size limit enforcement.
- **Required Safe Additive Migration**:
  ```sql
  CREATE TABLE IF NOT EXISTS storage_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    document_type VARCHAR(50),
    storage_key TEXT NOT NULL UNIQUE,
    content_type VARCHAR(100) NOT NULL,
    expected_size_bytes BIGINT,
    actual_size_bytes BIGINT,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_storage_uploads_partner_status ON storage_uploads (partner_id, status);
  ```

---

## K. Recommended Safe Implementation Plan

1. **Step 1 — Execute Non-Destructive Additive Database Migrations**:
   - Add `auth_id`, `auth_provider`, `name`, `email` to `users` (`IF NOT EXISTS`).
   - Add compatibility columns (`profile_image_url`, `rating`, `review_count`, `registered_since`) to `partners` (`IF NOT EXISTS`).
   - Create `outbox_events` table (`IF NOT EXISTS`).
   - Create `storage_uploads` table (`IF NOT EXISTS`).
   - Create `schema_migrations` table (`IF NOT EXISTS`).
2. **Step 2 — Adapt Backend Repositories to Canonical Supabase Tables**:
   - Update `wallet.repository.js` to target `partner_wallets`.
   - Update `payout.repository.js` to target `partner_payouts`.
   - Update `notification.repository.js` to target `notifications` and `user_devices`.
   - Update `support-ticket.repository.js` to target `support_tickets` and `support_messages`.
   - Update `booking.repository.js` to join `booking_pickup` and `booking_return`.
   - Update `vehicle.repository.js` to join `vehicle_models`, `vehicle_brands`, and `vehicle_categories`.
3. **Step 3 — Environment Configuration**:
   - Configure `.env` with authoritative Supabase connection string:
     `DATABASE_URL=postgresql://postgres.mtfljykvxyslhdvpfcil:Harshu@898923@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`
   - Set `SUPABASE_URL=https://mtfljykvxyslhdvpfcil.supabase.co`.
   - Set `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
4. **Step 4 — Verification**:
   - Run `npm test` and test all endpoints live against the Supabase database.
   - Verify server startup with 0 outbox errors.
