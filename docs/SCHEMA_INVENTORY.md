# GONGO Server: Database Schema & Migration Inventory

Generated: 2026-10-14. Static, read-only analysis of the repository. No database was contacted, no migration was run, and no code was changed.

## 0. Scope, sources and method

| Source | Path | Notes |
|---|---|---|
| Customer migrations | `Customer/database/migrations/*.js` (23 files) | node-pg-migrate 9 (`Customer/package.json` scripts `migrate:up/down/status` = `node-pg-migrate -m database/migrations --envPath .env`). No `--migrations-table` flag, so tracking uses node-pg-migrate's default table **`pgmigrations`**. `Admin/database/migrations/20261007_production_supabase_security_hardening.sql` confirms that `public.pgmigrations` exists in production. |
| Partner migrations | `Partner/database/migrations/*.js` (49 files) | Custom runner `Partner/src/db/migrator.js`, tracking table **`schema_migrations(id, name, executed_at)`**. Loads `*.js` only, in alphabetical order, one transaction per file. **Working tree:** `048_add_changed_by_to_vehicle_pricing_history.js` is staged (`A`), and `049_add_is_active_to_vehicles.js` is **untracked** (not committed). |
| Admin migrations | `Admin/database/migrations/` (18 `.js` + 3 `.sql`) | Custom runner `Admin/src/db/migrator.js`. It uses the **same** `schema_migrations` table and loads only `*.js`. **The 3 `.sql` files are never run by any migrator.** They must be applied by hand (Supabase SQL editor). |
| Live-alignment script | `Partner/scripts/apply_supabase_alignment.js` | An idempotent list of about 170 DDL statements, run outside any migrator. Each statement is wrapped in try/catch, so failures are only logged. |
| Live schema snapshot (pre-alignment) | `Customer/scripts/supabase_schema.json` (+ `schema_summary.md/.txt`) | An `information_schema` dump of **78 base tables** (columns, PK/UNIQUE constraints, FKs, CHECKs). It contains no views, and **unique indexes created with `CREATE UNIQUE INDEX` are not included**. It predates the alignment script: for example, `users` has no `country_code` and `wallet_transactions` has no `status`/`metadata`. In this report it is called **"baseline snapshot"**. |
| Partial live export (post-alignment) | `N:\Codes\gongo-v1\db_schema.md` | Only **5 tables**: `bookings`, `partners`, `payments`, `users` (these appear complete), and `vehicles` (truncated after 6 columns: id, partner_id, shop_id, model_id, registration_number, chassis_number). |
| Application SQL | `Customer/src`, `Partner/src`, `Admin/src`, `src/` (473 `.js` files) | All template-literal SQL was scanned for `FROM/JOIN/INTO/UPDATE/DELETE FROM`. `${this.tableName}` was resolved to each repository's `super('<table>')`. CTE names (`all_documents`, `b_earnings`, `daily_bookings`, `daily_payments`, `eligible`, `stale`, `to_revoke`, `unified_*`, `v_stats`, `vehicle_candidates`) and keyword false positives (`FOR UPDATE OF`, `SKIP LOCKED`) were excluded and checked by hand. The only Supabase-JS `.from()` calls target `users` (`Admin/src/repositories/user.repository.js`, `Admin/src/config/supabase.js`). Columns come from `alias.column` references, `INSERT (...)` column lists and `UPDATE ... SET` targets, and the cases listed below were spot-checked. |

Legend used below: **Snap** = present in the baseline snapshot; **Align** = created or added by `apply_supabase_alignment.js`; **dbmd** = present in `db_schema.md`.

---

## 1. Tables and views created by repository migrations

55 distinct relation names are created across the three sub-apps. 14 of them are created by more than one sub-app with *different* definitions (see §5).

### 1.1 Customer (`Customer/database/migrations`, node-pg-migrate → `pgmigrations`)

| Relation | Creating migration | Later alterations (Customer) |
|---|---|---|
| users | 1726300000000_create-users-table.js (also creates `pgcrypto`, `update_updated_at_column()`) | 1728200000000 (avatar_storage_key), 1728500000000 (customer_reference) |
| customer_documents | 1726400000000_create-customer-documents-table.js | |
| customer_addresses | 1726500000000_create-customer-addresses-table.js | |
| partners, shops | 1726600000000_create-partners-shops-table.js | 1728500000000 (partners.partner_reference) |
| vehicle_categories, cities | 1726700000000_create-categories-cities-table.js | |
| vehicles | 1726800000000_create-vehicles-table.js | 1728500000000 (vehicle_reference) |
| vehicle_images | 1726900000000_create-vehicle-images-table.js | |
| bookings, booking_price_breakdown, booking_cancellations, booking_return | 1727000000000_create-bookings-table.js (also `btree_gist` + exclusion constraint `no_overlapping_blocking_bookings`) | 1727300000000 (coupon_id, coupon_code, discount_amount), 1728400000000 (booking_cancellations refund fields), 1728500000000 (booking_reference) |
| idempotency_keys | 1727100000000_create-idempotency-keys-table.js | |
| coupons, coupon_redemptions | 1727200000000_create-coupons-table.js | |
| payments, payment_attempts | 1727400000000_create-payments-table.js | 1728100000000 / 1728300000000 (chk_payments_type), 1728500000000 (order_reference) |
| customer_device_tokens | 1727500000000_create-customer-device-tokens-table.js | |
| notifications | 1727600000000_create-notifications-table.js | 1727900000000 (type CHECK) |
| support_tickets | 1727700000000_create-support-tickets-table.js | |
| support_ticket_messages | 1727800000000_create-support-ticket-messages-table.js | |
| booking_return_verifications | 1728000000000_create-booking-return-verifications-table.js | |
| *(alters only)* refunds | n/a | 1728400000000 (upi_id, original_paid_amount, refund_percentage, policy_name), 1728500000000 (refund_reference). **Not created by Customer.** |
| *(alters only)* customer_profiles | n/a | 1728500000000 (customer_reference). **Not created by any migration.** |

### 1.2 Partner (`Partner/database/migrations`, `schema_migrations`)

| Relation | Creating migration | Later alterations (Partner) |
|---|---|---|
| *(extension/function)* | 001_extensions.js (`pgcrypto`, `update_updated_at_column()`) | |
| users | 002_create_users_table.js | 038 (auth_provider default), 039, 043_global (customer_reference) |
| partners | 003_create_partners_table.js | 032, 039, 043_global, 045, 046 |
| shops | 004_create_shops_table.js | 039, 045, 046 |
| partner_documents | 005 | 032 (doc-type CHECK) |
| partner_bank_accounts | 006 | |
| vehicle_categories | 007 (seeds CAR/BIKE/SCOOTER) | |
| vehicles | 008 | 033 (pickup_location), 043_global (vehicle_reference), 044 (rating_avg, rating_count), **049 (is_active; untracked file)** |
| vehicle_images | 009 | 040 (verification/versioning columns) |
| vehicle_documents | 010 | |
| vehicle_pricing | 011 | 043_add_duration_pricing_slabs (price_3/6/12_hours) |
| vehicle_pricing_history | 012 | 043_add_duration_pricing_slabs, 048 (changed_by; staged) |
| vehicle_availability_blocks | 013 | |
| bookings | 014 | 032 (status CHECK), 043_global (booking_reference) |
| booking_pricing_snapshots | 015 | 034 |
| booking_pickup_verifications | 016 | |
| booking_return_verifications | 017 | 034 |
| damage_reports | 018 | |
| payments | 019 | 035 (payment_type, metadata), 041, 043_global (order_reference) |
| payment_events | 020 | |
| commission_records | 021 | |
| **wallets** (table) | 022 | |
| wallet_transactions | 023 | 036 (partial unique index) |
| earnings | 024 | |
| **payouts** (table) | 025 | |
| partner_notifications | 026 | |
| partner_device_tokens | 027 | |
| support_tickets | 028 | 042 |
| support_ticket_messages | 029 | |
| audit_logs | 030 | |
| storage_uploads | 031 | 032, 033 |
| outbox_events | 037 | |
| ratings | 044_create_ratings_table.js (+ trigger function, RLS, policies using `auth.uid()` and role `authenticated`) | |
| partner_consents | 047_create_partner_consent_records_table.js | |
| *(alters only)* customer_profiles, refunds | n/a | 043_add_global_public_reference_ids.js. **Partner creates neither.** |

### 1.3 Admin (`Admin/database/migrations`, shared `schema_migrations`)

| Relation | Creating migration | Notes |
|---|---|---|
| admin_actions | 038 | |
| admin_permissions | 039 (042 drops its CHECK) | |
| admin_settings | 040 (re-creates `update_updated_at_column()`) | |
| admin_sessions | 041 | |
| refunds, commission_rules | 043_create_refunds_and_commission_rules_tables.js | 053 (utr, payment_method, notes, status CHECK), 054 (refund_reference) |
| disputes | 044 | |
| notification_templates, notifications | 046 (`CREATE TABLE IF NOT EXISTS notifications` + reconcile) | |
| **payouts** (VIEW over `partner_payouts`) | 050_partner_payout_requests_and_manual_payment.js | conflicts with Partner 025 table |
| cancellation_refund_rules | 051 (seeded) | |
| franchise_applications | 052 | |
| *(alters only)* support_tickets, support_ticket_messages | 045 | |
| *(alters only)* outbox_events | 047 (locked_at, locked_by) | |
| *(alters only)* users, admin_actions | 048 | |
| *(alters only)* vehicle_images | 049 (same as Partner 040) | |
| *(alters only)* partner_payouts | 050. **Not created by any migration.** | |
| *(alters only)* bookings, users, customer_profiles, partners, vehicles, payments, refunds | 054 (same body as Partner 043_global and Customer 1728500000000) | |
| *(alters only)* platform_charge_settings | 055. **Not created by any migration.** | |
| ratings (SQL, **never run by migrator**) | 20261010_create_ratings_table_and_rls.sql | Same as Partner 044 plus helper functions. Manual apply only. |
| *(manual SQL)* | 20261007_production_supabase_security_hardening.sql (+ rollback) | Treats `support_ticket_messages`, `wallets` and `payouts` as **views** and enables RLS on 19 tables, including `pgmigrations` and `schema_migrations`. Manual apply only. |

### 1.4 Relations created only by `Partner/scripts/apply_supabase_alignment.js` (not by a migration)

- **Views:** `wallets` (over `partner_wallets`), `payouts` (over `partner_payouts`, without the 4 manual-payout columns that Admin 050 adds), `support_ticket_messages` (over `support_messages`).
- **`CREATE TABLE IF NOT EXISTS` with definitions that differ from the migrations:** outbox_events, storage_uploads, payment_events, partner_notifications, partner_device_tokens, commission_records, damage_reports, earnings, booking_pricing_snapshots, booking_pickup_verifications, booking_return_verifications, vehicle_availability_blocks. Notable differences: alignment `commission_records` and `earnings` have **no UNIQUE(booking_id)**; `commission_records.rate/commission_rate` are `NUMERIC(5,2)` (migration 021: `NUMERIC(5,4)` with `CHECK <= 1`); `payment_events` has `UNIQUE(event_id)` only and `processed` instead of `is_processed`.
- **Indexes:** `idx_partner_payouts_idempotency` (UNIQUE partial on `partner_payouts(partner_id, idempotency_key)`), `idx_users_auth_id`, `idx_vehicle_pricing_vehicle_id` (UNIQUE), and others.
- It also adds columns that the code needs and no migration adds: `vehicles.rejection_reason`, `vehicles.primary_image_url`, `bookings.booking_status/customer_name/customer_phone/expected_return_at/payment_status/pickup_location` (on the live `bookings` table), `partner_payouts.idempotency_key/provider_transfer_id` (+ `payout_number` default), `support_messages.sender_type/attachments`, `wallet_transactions.status/metadata`, `earnings.partner_net_amount/settlement_status/...`, `commission_records.commission_type/...`, and `vehicle_pricing_history.valid_from/valid_to/extra_km_charge`.
- It references baseline-only columns, which proves it targets the Supabase baseline: `vehicles.model_id`, `vehicle_pricing.pricing_type/price`, `partner_documents.file_url`, `vehicle_images.file_url/storage_path/image_type`, `shops.name/address_line1`, `partner_bank_accounts.account_number`, `vehicle_documents.file_url/storage_path/uploaded_at`, `vehicle_pricing_history.effective_from`.

---

## 2. Relations referenced by application code but NOT created by any repository migration

**The earlier claim of about 32 such relations is confirmed: there are exactly 32.** 30 of them appear in the baseline snapshot, which makes them externally provisioned (Supabase baseline). The 2 that appear in no repository artefact are `platform_charge_settings` and `platform_fee_settings`. Three of the 32 are also the target of `ALTER` statements in repository migrations, so those migrations cannot run on a fresh database: `customer_profiles`, `partner_payouts`, `platform_charge_settings`. None of the 32 appear in `db_schema.md`.

Each listed example was checked. `partner_payouts`, `partner_wallets`, `customer_profiles`, `commission_transactions`, `reviews`, `offers` and `payment_webhooks` are all confirmed: not created by any migration, and present in the baseline snapshot.

"Guarded" means every reference sits in a `try/catch` that degrades to an empty result or a fallback. "Hard" means the failure surfaces as an error or breaks a business flow.

| # | Relation | Referencing files | Columns used by code | Snap | Align | Likely origin / notes |
|---|---|---|---|---|---|---|
| 1 | partner_wallets | Customer/src/services/booking.service.js; Partner/src/services/payout.service.js, wallet.service.js; Admin/src/repositories/admin-wallet.repository.js, admin-dashboard.repository.js | id, partner_id, available_balance, pending_balance, receivable_balance, total_credited, total_debited, total_earned, total_paid_out, currency, updated_at | Y (all) | view source only | Supabase baseline. **Hard** in Admin (`updateWalletBalances` → `UPDATE partner_wallets`). The baseline has UNIQUE(partner_id) and UNIQUE(id, partner_id). |
| 2 | partner_payouts | Partner/src/repositories/payout.repository.js (base table of the payout repo), Partner/src/services/wallet.service.js; Admin/src/services/admin-wallet.service.js, admin-wallet.repository.js, admin-dashboard.repository.js | id, partner_id, bank_account_id, payout_number, amount, currency, status, requested_at, approved_at, processed_at, completed_at, failure_reason, created_at, updated_at, **idempotency_key, provider_transfer_id** (Align only), **processed_by, payment_method, payment_reference, notes** (Admin 050 only) | Y (base columns) | Y | Supabase baseline. **Hard.** Altered by Admin 050. |
| 3 | customer_profiles | Customer/src/repositories/customer.repository.js; Admin/src/repositories/admin-customer.repository.js, user.repository.js | id, user_id, full_name, profile_photo_url, profile_photo_path, customer_reference (added by the global-reference migrations), created_at, updated_at; `ON CONFLICT (user_id)` | Y (except customer_reference) | n | Supabase baseline. Altered by Customer 1728500000000, Partner 043_global and Admin 054. |
| 4 | commission_transactions | Customer/src/services/payment.service.js; Partner/src/services/commission-lock.service.js, wallet.service.js; Admin/src/repositories/admin-dashboard.repository.js | id, booking_id, partner_id, commission_rule_id, commission_type, commission_rate, base_amount, commission_amount, currency, status, created_at | Y | n | Supabase baseline. Baseline CHECKs: status ∈ {applied, adjusted, reversed}, commission_type ∈ {percentage, fixed} (see §4.6). |
| 5 | platform_charge_settings | Customer/src/repositories/platform-fee.repository.js; Admin/src/repositories/platform-fee.repository.js | id, charge_type, calculation_type, value, currency, is_active, created_by, created_at, updated_at | **n** | n | **Definition not in repository and not in the snapshot.** It was created out-of-band after the snapshot. Altered and seeded by Admin 055. |
| 6 | platform_fee_settings | Customer/src/repositories/platform-fee.repository.js | id, fee_type, fee_value, currency, is_active, created_by, created_at, updated_at | **n** | n | **Definition not in repository.** It may not exist at all: the code catches errors mentioning the table name and falls back to `platform_charge_settings`. Guarded. |
| 7 | reviews | Customer/src/repositories/booking.repository.js; Admin/src/repositories/admin-review.repository.js (base table), admin-booking, admin-customer, admin-partner, admin-vehicle repositories | id, booking_id, customer_id, partner_id, vehicle_id, rating, review_text, status, created_at, updated_at | Y | n | Supabase baseline. Note that Partner uses the separate, migration-created `ratings` table, so there are two rating stores. |
| 8 | review_replies | Admin/src/repositories/admin-review.repository.js (`SELECT *`) | (all) | Y | n | Baseline. Guarded (`.catch`). |
| 9 | review_reports | Admin/src/repositories/admin-review.repository.js | review_id, reported_by, status, resolution_note, resolved_at, resolved_by, created_at, updated_at | Y | n | Baseline. |
| 10 | offers | Admin/src/repositories/admin-offer.repository.js (base table) | name, description, offer_type, discount_type, discount_value, max_discount_amount, valid_from, valid_until, is_active, created_by | Y | n | Baseline. |
| 11 | offer_shops | Admin/src/repositories/admin-offer.repository.js | id, offer_id, shop_id, created_at; `ON CONFLICT (offer_id, shop_id)` | Y (UNIQUE offer_shops_unique) | n | Baseline. |
| 12 | offer_vehicles | Admin/src/repositories/admin-offer.repository.js | id, offer_id, vehicle_id, created_at; `ON CONFLICT (offer_id, vehicle_id)` | Y (UNIQUE offer_vehicles_unique) | n | Baseline. The same file also selects `v.name` and `s.shop_code`, which exist in no known schema. |
| 13 | payment_webhooks | Admin/src/repositories/admin-payment.repository.js | id, gateway, event_type, gateway_event_id, gateway_order_id, gateway_payment_id, payload, signature_verified, processing_status, processing_error, received_at, processed_at, created_at | Y | n | Baseline. Guarded, falls back to `payment_events`. No writer exists in this repository. |
| 14 | payout_transactions | Admin/src/repositories/admin-wallet.repository.js | id, payout_id, attempt_number, gateway, … , failure_reason, created_at, updated_at | Y | n | Baseline. FK payout_id → partner_payouts. Guarded. |
| 15 | booking_pickup | Customer/src/services/no-show-cancellation.service.js; Partner/src/repositories/booking.repository.js; Admin/src/repositories/admin-booking.repository.js | booking_id, picked_up_at, pickup_location, handed_over_by, odometer_reading, fuel_level, notes, created_at, updated_at | Y | n | Baseline. |
| 16 | booking_status_history | same three files as #15 | id, booking_id, old_status, new_status, changed_by, change_reason, created_at | Y | n | Baseline. |
| 17 | booking_customer_details | Admin/src/repositories/admin-booking.repository.js | id, booking_id, full_name, phone, alternate_phone, id_type, id_reference, created_at | Y | n | Baseline. Guarded. |
| 18 | rental_agreements | Admin/src/repositories/admin-agreement.repository.js (base table), admin-booking.repository.js | agreement_number, agreement_version, booking_id, customer_id, partner_id, vehicle_id, rental_start_at, rental_end_at, rental_amount, security_deposit, discount_amount, extra_charges, tax_amount, total_amount, status, customer_accepted, partner_acknowledged, document_url, created_at, updated_at, plus **accepted_at, acknowledged_at, storage_path (not in snapshot)** | Y (partial) | n | Baseline. 3 columns used by the code are not in the snapshot. |
| 19 | coupon_rules | Customer/src/repositories/coupon.repository.js; Admin/src/repositories/admin-coupon.repository.js | id, coupon_id, rule_type, category_id, partner_id, shop_id, vehicle_id, rule_value, is_active, created_at | Y | n | Baseline. Guarded. |
| 20 | customer_identity_verifications | Admin/src/repositories/admin-customer.repository.js | customer_id, verification_status, …, failed_at, failure_reason, created_at, updated_at | Y | n | Baseline. Guarded. |
| 21 | customer_saved_addresses | Customer/src/repositories/address.repository.js | customer_id, address_label, address_line1, address_line2, postal_code, latitude, longitude, is_default, is_active | Y | n | Baseline. This coexists with the migration-created `customer_addresses`. |
| 22 | partner_verification_history | Admin/src/repositories/admin-partner.repository.js | id, partner_id, verification_type, old_status, new_status, reason, verified_by, created_at | Y | n | Baseline. |
| 23 | shop_documents | Admin/src/repositories/admin-shop.repository.js | id, shop_id, document_type, document_number, file_url, storage_path, verification_status, rejection_reason, uploaded_at, verified_at, created_at, updated_at | Y | n | Baseline. Guarded. |
| 24 | shop_images | Admin/src/repositories/admin-shop.repository.js | id, shop_id, file_url, storage_path, image_type, display_order, is_primary, is_active, created_at, updated_at | Y | n | Baseline. Guarded. |
| 25 | shop_operating_hours | Admin/src/repositories/admin-shop.repository.js | id, shop_id, day_of_week, opens_at, closes_at, is_closed, created_at, updated_at | Y | n | Baseline. Guarded. |
| 26 | shop_verification_history | Admin/src/repositories/admin-shop.repository.js | id, shop_id, verification_type, old_status, new_status, reason, verified_by, created_at | Y | n | Baseline. |
| 27 | support_messages | Customer/src/repositories/support-ticket-message.repository.js | id, ticket_id, sender_id, message, is_internal, created_at, **sender_type, attachments** (Align) | Y | Y (adds 2 columns; `support_ticket_messages` view source) | Baseline. |
| 28 | support_attachments | Customer/src/repositories/support-ticket-message.repository.js | id, message_id, file_url, storage_path | Y | n | Baseline. |
| 29 | ticket_status_history | Admin/src/repositories/admin-support.repository.js | ticket_id, old_status, new_status, changed_by, reason | Y | n | Baseline. |
| 30 | user_devices | Customer/src/repositories/device-token.repository.js; Admin/src/repositories/admin-notification.repository.js | user_id, device_token, platform, device_id, is_active, last_seen_at, updated_at; **`ON CONFLICT (device_token)`** | Y (no UNIQUE constraint on device_token in snapshot) | n | Baseline. The fallback to `customer_device_tokens` runs only if the error text contains "user_devices" or "does not exist". A missing unique index raises a different error (42P10), so no fallback happens. Verify on staging. |
| 31 | vehicle_brands | Customer/src/repositories/booking.repository.js; Admin/src/repositories/public-vehicle.repository.js | id, name | Y | n | Baseline. |
| 32 | vehicle_models | same as #31 | id, name, brand_id, category_id | Y | n | Baseline (FK target of live `vehicles.model_id`). |

Additional latent reference (not counted): `Admin/src/repositories/admin-reports.repository.js` calls `super('reports', 'id')`. No `reports` table exists in any source. Base-repository helpers (`findById`, etc.) would fail if they were ever called on that repository. No such call was found.

Baseline-snapshot tables that exist but are not referenced by code: `areas`, `states`, `booking_items`, `cancellation_policies`, `dispute_evidence`, `partner_kyc`, `payment_transactions`, `refund_transactions`, `user_notification_preferences`, `vehicle_availability`, `vehicle_blocked_periods`, `vehicle_extra_charges`, `vehicle_feature_values`, `vehicle_features`, `vehicle_pricing_rules`.

---

## 3. Columns used by code but missing from the creating migrations (tables that ARE migrated)

Each sub-app's creating migration (plus that sub-app's later `ADD COLUMN`s) was compared against the columns the code uses. "Source" says where the column does exist: **Snap** (baseline), **Align**, **dbmd**, or **NONE** (no known schema; a query using it fails with SQLSTATE 42703 wherever it runs).

### 3.1 vehicles. Two incompatible migration definitions

- **Partner 008** shape: partner_id, shop_id, category, brand, model, variant, registration_number, year, fuel_type, transmission, seats, description, manual_status, rental_status, verification_status, is_archived, offline_reason (+033 pickup_location, +043 vehicle_reference, +044 rating_avg/rating_count, +049 is_active).
- **Customer 1726800000000** shape: shop_id NOT NULL, category_id NOT NULL → vehicle_categories, vehicle_subtype, brand, model, vehicle_name, year, fuel_type, transmission, engine_capacity_cc, color, seats, mileage_kmpl, price_per_hour/day/week/month, security_deposit, late_fee_per_hour, extra_km_charge, city_id, pickup_address, latitude, longitude, registration_number, description, listing_status, rating_avg, rating_count. It has **no partner_id**.
- **Live baseline (Snap)**: partner_id, shop_id, model_id, registration_number, chassis_number, engine_number, color, status, verification_status, is_active, is_available, vehicle_description, manufacture_year, engine_capacity, current_odometer, helmet_included (+ Align adds brand, model, category, year, fuel_type, manual_status, rental_status, rejection_reason, primary_image_url, variant, transmission, seats, description, pickup_location, is_archived, offline_reason).

The code uses columns from all three shapes. Columns used but absent from both repository definitions:

| Column | Used in | Source |
|---|---|---|
| is_active | Partner/src/repositories/vehicle.repository.js (reads via `to_jsonb(v)->>'is_active'`), Partner/src/services/vehicle.service.js, Admin admin-vehicle / admin-verification / admin-dashboard / admin-partner / admin-reports / admin-shop / admin-support / public-vehicle repositories | Snap. Repository only via **untracked** Partner 049. |
| is_available | Partner vehicle.repository.js; Admin admin-vehicle.repository.js, public-vehicle.repository.js | Snap only. **No migration.** |
| rejection_reason | Partner vehicle.repository.js; Admin admin-vehicle.repository.js, admin-verification.repository.js, admin-verification.service.js | **Align only** (not in Snap, not in any migration) |
| primary_image_url | Partner booking.repository.js, vehicle.repository.js; Admin admin-booking.repository.js, admin-customer.repository.js | Align only |
| model_id, status, manufacture_year, vehicle_description | Customer booking.repository.js, vehicle.repository.js; Admin public-vehicle/admin-vehicle repositories | Snap (model_id also dbmd) |
| engine_capacity, current_odometer, helmet_included | Admin admin-vehicle.repository.js | Snap |
| name | Admin admin-offer.repository.js (`v.name AS vehicle_name`) | **NONE** |

Customer-shape columns used by code that are absent from the live evidence (Snap/Align/dbmd): category_id, listing_status, vehicle_name, price_per_hour/day/week/month, security_deposit, late_fee_per_hour, extra_km_charge, pickup_address. These exist only if Customer 1726800000000 created the table. Verify on staging.

### 3.2 bookings. Two incompatible migration definitions

- **Partner 014**: booking_number, customer_id, customer_name, customer_phone, partner_id, shop_id, vehicle_id, start_at, expected_return_at, booking_status, payment_status, pickup_location. It has **no `status`, `end_at` or amounts**.
- **Customer 1727000000000**: customer_id, vehicle_id, status, rental_type, start_at, end_at, pickup_address, price_per_*, base_amount, security_deposit, late_fee_per_hour, extra_km_charge, total_amount, cancellation_reason, cancelled_at (+ coupon_id, coupon_code, discount_amount). It has **no partner_id, booking_number or booking_status**.
- **Live (dbmd, post-alignment)**: both `status` (lowercase CHECK) and `booking_status`, plus subtotal, discount_amount, extra_charges, tax_amount, platform_fee, total_amount, currency, booking_reference.

The code reads `b.status` and `b.booking_status` **in the same statement** (for example `Partner/src/services/wallet.service.js`, `Partner/src/services/commission-lock.service.js`, and the `ratings` policies in Partner 044), so neither repository chain alone satisfies it.

| Column | Used in | Source |
|---|---|---|
| booking_reference | everywhere | Partner 043_global / Admin 054 / Customer 1728500000000 (each fails on a fresh DB, see §6), dbmd |
| status (with booking_status) | Partner wallet.service.js, commission-lock.service.js, booking.repository.js; Customer services | Customer migration only; dbmd |
| subtotal, tax_amount, extra_charges, platform_fee, currency | Customer booking.repository.js, payment.service.js, no-show-cancellation.service.js; Partner booking.repository.js | Snap/dbmd only. **No migration.** |
| **rental_amount** | Customer/src/services/payment.service.js:1015 (`SELECT … b.subtotal, b.rental_amount … v.category_id`) | **NONE.** This SELECT is the first statement of the `sp_partner_earnings` best-effort block, so on any known schema the advance-payment webhook's earnings/commission/wallet-pending sync is skipped (a warning is logged). |
| start_date, end_date | Admin/src/repositories/admin-payment.repository.js:325 (`getPaymentBooking`), admin-damage-dispute.repository.js:251 | **NONE** |
| start_datetime, end_datetime, city | Admin/src/repositories/admin-reports.repository.js:296-342 | **NONE** |
| rental_type, base_amount, security_deposit, coupon_id, coupon_code, price_per_*, late_fee_per_hour, extra_km_charge, pickup_address, cancellation_reason | Customer repositories/services; Admin | Customer migration only. **Absent from dbmd** (live `bookings` appears complete there). |

### 3.3 payments

| Column | Used in | Source |
|---|---|---|
| partner_id, payment_number | Customer/src/repositories/payment.repository.js (INSERT), booking.service.js, payment.service.js | Snap/dbmd (NOT NULL live). **Neither migration defines partner_id.** Customer defines payment_number as nullable. |
| order_reference | Customer payment.repository.js | 043_global / 054 / 1728500000000; dbmd (NOT NULL) |
| provider, metadata, failure_reason | Customer payment.repository.js:192 (INSERT), Partner, Admin | Customer 1727400000000 / Partner 019+035 only. **Absent from dbmd**, which suggests Partner 035 was not applied live. Verify. |
| provider_reference, user_id | Admin/src/repositories/admin-reports.repository.js:792-799 | **NONE** (`payments` has customer_id, not user_id) |

### 3.4 wallets (Partner 022 table; live = view over partner_wallets)

All columns used (id, partner_id, available_balance, pending_balance, total_credited, total_debited, currency, created_at, updated_at) are in 022 and in the alignment view. The code also writes `partner_wallets` directly (receivable_balance, total_earned, total_paid_out), which no migration defines.

### 3.5 wallet_transactions (Partner 023)

| Column | Used in | Source |
|---|---|---|
| **balance_before** | Partner/src/repositories/wallet-transaction.repository.js:89 (INSERT), Partner/src/services/wallet.service.js:201 (INSERT), Admin/src/repositories/admin-wallet.repository.js:1582 (INSERT) | **Snap only** (NOT NULL, CHECK ≥ 0). **Missing from 023**, so every ledger insert fails on a repository-provisioned database. |
| status, metadata | all three writers | 023 and Align. Not in Snap. |
| type | Admin/src/repositories/admin-reports.repository.js:1081,1100 (`wt.type`) | **NONE** (the column is transaction_type) |

**Type mismatch:** `reference_id` is `VARCHAR(100)` in 023 but `uuid` in the baseline. `Partner/src/services/reconciliation.service.js:103,130,132` compares `t.reference_id = p.id::text`, and `Partner/src/services/wallet.service.js:240` compares `wt.reference_id = b.id`. Whichever type is live, one of these forms has no `=` operator: uuid = text fails on the baseline, and varchar = uuid fails on the repository schema.

### 3.6 partner_wallets / partner_payouts / payouts

- `partner_wallets` and `partner_payouts`: no creating migration (see §2).
- `payouts`: the Partner 025 table lacks payout_number, currency, approved_at, completed_at, processed_by, payment_method, payment_reference and notes. All of these are selected via the Admin 050 view, and `Admin/src/repositories/admin-wallet.repository.js` reads `payouts` (lines 689, 1129, 1261, 1691) and runs `UPDATE payouts` (line 1736). `Partner/src/services/wallet.service.js:108-110` UNIONs `partner_payouts` and `payouts`, so both relations must exist.

### 3.7 earnings (Partner 024)

| Column | Used in | Source |
|---|---|---|
| commission_amount, net_earnings | Customer/src/services/booking.service.js, payment.service.js (INSERT); Partner earnings.repository.js, booking.repository.js, vehicle.repository.js, commission-lock.service.js | **Align only** |
| status | Customer/src/services/booking.service.js (INSERT) | **Align only** |

`ON CONFLICT (booking_id)` is used by Customer booking.service.js and payment.service.js, and by Partner earnings.repository.js and commission-lock.service.js. It requires UNIQUE(booking_id), which 024 has and the alignment definition does not.

### 3.8 commission_records (Partner 021)

| Column | Used in | Source |
|---|---|---|
| rate | Customer booking.service.js; Partner booking.repository.js, earnings.repository.js, wallet.service.js | Align only |
| partner_payout_amount | Customer booking.service.js; Partner booking.repository.js | Align only |

### 3.9 refunds (Admin 043)

| Column | Used in | Source |
|---|---|---|
| cancellation_id, requested_at | Customer/src/services/cancellation.service.js | Snap only |
| upi_id, original_paid_amount, refund_percentage, policy_name | Customer cancellation flow | Customer 1728400000000 only (which itself fails on a fresh DB unless Admin 043 ran first) |

### 3.10 outbox_events (Partner 037 + Admin 047)

All used columns are covered. The baseline outbox_events has `scheduled_at`, not `next_retry_at`/`locked_*`, which Align/037/047 add.

### 3.11 users. Two incompatible migration definitions

| Column | Used in | Source |
|---|---|---|
| status, deleted_at | Customer customer.repository.js, user.repository.js; Admin user.repository.js | Snap/dbmd only. **No migration.** |
| created_by | Admin | Admin 048 |
| avatar_storage_key | Customer | Customer migrations only. **Absent from dbmd.** |
| firebase_uid | not used by code | Snap/dbmd only (legacy) |

### 3.12 Other migrated tables (columns used but missing from all migrations)

| Table | Column(s) | Source |
|---|---|---|
| vehicle_pricing_history | **effective_from, effective_to**. Written by `Partner/src/repositories/pricing.repository.js:121-127` (INSERT). | Not in 012/043/048. Align references `effective_from` only. `effective_to`: **definition not in repository.** On a repository-provisioned DB every pricing change fails at the history insert. |
| vehicle_pricing | pricing_type, price | Snap (Align drops their NOT NULL) |
| vehicle_images | file_url | Snap |
| vehicle_documents | storage_path, expires_at | Snap |
| partner_documents | file_url | Snap |
| partner_bank_accounts | upi_id | Snap |
| partners | partner_code, status, contact_phone, contact_email, business_type (Snap/dbmd); email, phone, owner_name (**NONE**, Admin reports/dev-resolvers) | |
| shops | name, address_line1, city_id, contact_phone, verification_status (Snap); shop_code (**NONE**, admin-offer) | |
| booking_cancellations | refund_status, eligible_refund_amount, hours_before_start, refund_percentage, created_at | Snap |
| coupons | name, used_count, usage_limit_per_customer, created_by | Snap |
| commission_rules | partner_id, vehicle_id, category_id, effective_from, effective_until | Snap (Admin 043 lacks them; the code's scope matching in commission-lock.service.js needs partner_id/category_id/vehicle_id) |
| audit_logs | old_data, new_data | Snap |
| customer_documents | customer_id, document_number, file_url, storage_path, verification_status | Snap (Customer migration uses user_id/status) |
| notifications | user_id, notification_type, message, is_read (Snap); recipient_id, recipient_role, failed_at (**NONE**, admin-reports.repository.js:1708-1712) | |
| support_tickets | assigned_admin_id (**NONE**, admin-reports.repository.js:1471) | |
| disputes | claim_amount, dispute_reason (**NONE**, admin-reports.repository.js:1586) | |
| damage_reports | estimated_cost, settlement_amount (**NONE**, admin-reports.repository.js:1568) | |
| storage_uploads | metadata (**NONE**) | |
| payment_events | provider, is_processed. Used by `Partner/src/repositories/payment.repository.js` with `ON CONFLICT (provider, event_id)`. | 020 only. **The baseline payment_events has neither column, and its UNIQUE is (event_id).** Alignment's `CREATE TABLE IF NOT EXISTS` is a no-op on the baseline, so the Partner webhook event insert likely fails live. Verify. |

---

## 4. Constraints and indexes relevant to correctness

### 4.1 wallet_transactions CHECKs vs stored vocabulary

| Constraint | Repository (Partner 023) | Baseline snapshot | What writers store |
|---|---|---|---|
| direction | `chk_wallet_tx_direction CHECK (direction IN ('CREDIT','DEBIT'))` | `wallet_transactions_direction_check`: `'credit','debit'` | **lowercase** `'credit'/'debit'`: `Partner/src/constants/wallet.js` (`toStorageDirection`), `Partner/src/repositories/wallet-transaction.repository.js:78`, `Partner/src/services/wallet.service.js:214`, `Admin/src/repositories/admin-wallet.repository.js:1549-1552` |
| transaction_type | none | `wallet_transactions_type_check` ∈ {booking_earning, refund_adjustment, payout, admin_adjustment, receivable_recovery, other} | mapped lowercase (`LEDGER_STORAGE_TYPE`). **Exception:** `Admin/src/services/admin-damage-dispute.service.js:782-789` passes `transactionType: 'DEBIT'`, which becomes `'debit'` and violates the baseline CHECK. |
| reference_type | NOT NULL, no CHECK | nullable; `wallet_transactions_reference_type_check` ∈ {booking, refund, payout, admin, other} | mapped lowercase. **Exception:** the dispute path passes `referenceType: 'DISPUTE_RESOLUTION'`, which becomes `'dispute_resolution'` and violates the baseline CHECK. |
| status | `chk_wallet_tx_status` ∈ uppercase {PENDING, COMPLETED, FAILED, REVERSED} | column absent (Align adds it with no CHECK) | `'COMPLETED'` (uppercase) |
| balance_before | column absent | NOT NULL, CHECK ≥ 0 | always supplied |

**Conflict:** on a database built from repository migrations, every ledger insert fails. The direction CHECK is uppercase, the writers store lowercase, and `balance_before` does not exist. On the live baseline the dispute-resolution deduction violates two baseline CHECKs (if they are still present). `Admin/src/repositories/admin-wallet.repository.js` defines `createWalletTransaction` twice (lines 481 and 1524). The second, mapped definition is the one in effect.

### 4.2 Settlement idempotency index (Partner 036)

`uq_wallet_transactions_settlement_credit ON wallet_transactions(reference_type, reference_id) WHERE reference_type = 'POST_RENTAL_SETTLEMENT' AND direction = 'CREDIT'`.

Stored rows use `reference_type = 'booking'` and `direction = 'credit'` (`LEDGER_STORAGE_REFERENCE.POST_RENTAL_SETTLEMENT = 'booking'` in `Partner/src/constants/wallet.js`). The partial predicate therefore **never matches a stored row**, and the index provides no protection. On the baseline the predicate values are not even admissible under the CHECKs.

Settlement de-duplication relies only on the application check (`findByReference` in `Partner/src/services/payment.service.js:385`, under the payment row lock). Separately, `Partner/src/services/wallet.service.js:195-241` back-fills `booking_earning` credits using `NOT EXISTS (… reference_id = b.id)` without any unique index, so concurrent syncs can double-insert. A replacement index must use the stored vocabulary and must distinguish booking-earning credits (reference_id = booking id) from settlement-payment credits (reference_id = payment id); both use `reference_type = 'booking'`.

### 4.3 Payout idempotency

- Repository: `idx_payouts_partner_idempotency` (UNIQUE partial) on **`payouts`** (Partner 025). On the live layout `payouts` is a view, so this index cannot exist there.
- Code writes **`partner_payouts`** (`Partner/src/repositories/payout.repository.js`).
- Only `apply_supabase_alignment.js` creates `idx_partner_payouts_idempotency ON partner_payouts(partner_id, idempotency_key) WHERE idempotency_key IS NOT NULL`. That statement fails silently if duplicates already exist, because the script swallows errors.
- The code itself says the index "is not guaranteed" (`Partner/src/services/payout.service.js:141-144`) and re-checks under the wallet row lock. Correctness therefore depends on the lock and on the alignment index existing.

### 4.4 Status CHECKs with case or vocabulary conflicts

- `partner_payouts.status`: baseline `partner_payouts_status_check` (lowercase {requested, approved, processing, completed, failed, cancelled}). Admin 050 replaces it with the lowercase set + {pending, paid, rejected}. Partner inserts `'pending'` (`Partner/src/services/payout.service.js:182`), which **violates the baseline CHECK unless Admin 050 has been applied**. Partner 025 (`payouts` table) uses an uppercase CHECK.
- `refunds.status`: Admin 043 `chk_refunds_status` (uppercase; only effective if 043 created the table). Baseline `refunds_status_check` is lowercase. Admin 053 drops both and adds a case-insensitive `lower(status) IN (...)`. Baseline also has `refunds_amount_consistency_check (approved_amount <= requested_amount AND refunded_amount <= approved_amount)`.
- `commission_records.status`: Partner 021 CHECK ∈ {PENDING, CALCULATED, SETTLED, WAIVED}. The code inserts **`'LOCKED'`** (`Customer/src/services/payment.service.js:1093`, `Partner/src/services/commission-lock.service.js:~198`), which violates 021. The alignment definition has no CHECK.
- `commission_records.commission_rate`: Partner 021 is `NUMERIC(5,4) CHECK (0..1)`. The code stores the rule value as a percent (for example `10`; `Customer/src/services/payment.service.js:1076`), which violates 021. Alignment is `NUMERIC(5,2)` with no CHECK.
- `commission_transactions` (baseline): status ∈ {applied, adjusted, reversed}, commission_type ∈ {percentage, fixed}. The Customer writer inserts status **`'COMMISSION_LOCKED'`** and passes the upper-case `'PERCENTAGE'` (`Customer/src/services/payment.service.js:1099-1106`), which violates both. The Partner writer uses `'applied'`/lower-case and is compatible.
  - **Transaction-abort hazard:** in `Customer/src/services/payment.service.js:1012-1125` these inserts use bare `try {} catch {}` inside a single `SAVEPOINT sp_partner_earnings`. A CHECK failure leaves the transaction aborted, so the following `INSERT INTO earnings` / `wallets` statements fail and the whole block rolls back to the savepoint. Separately, the block's first SELECT references `b.rental_amount` (§3.2), which exists in no schema.
- `users.role`: Customer `chk_users_role` is lowercase {customer, partner, admin}. Partner `chk_users_role` (same name) is uppercase {PARTNER, CUSTOMER, ADMIN}. Admin 048 adds `users_role_check` with lowercase {customer, partner, admin, super_admin, support_executive}. **On a Partner-then-Admin database both CHECKs coexist and no role value can satisfy both.**
- `bookings` status: Customer CHECK and exclusion constraint `no_overlapping_blocking_bookings` use **uppercase** blocking statuses ({PENDING, ACCEPTED, PAYMENT_PENDING, …}). The live `bookings_status_check` allows lowercase only. Even if the exclusion constraint exists, its predicate never matches live rows, so **there is no DB-level double-booking guard.** The live `bookings` table (dbmd) has no Customer-migration columns, so the constraint most likely does not exist live at all.
- `support_tickets`: Customer, Partner 028/042 and Admin 045 each replace `chk_support_tickets_status/category/priority` with different sets. Admin 045 is case-sensitive and omits WAITING_FOR_USER, PAYOUT, REFUND and DAMAGE, which Partner 042 allows. The final state depends on application order.
- `payments.payment_type`: Partner 035/041 and Customer 1728100000000/1728300000000 CHECK ∈ {BOOKING_ADVANCE, POST_RENTAL_SETTLEMENT, OVERTIME_CHARGE}. The live column (Align) defaults to `'RENTAL'`, which is not in that set. Live `payments_status_check` is lowercase; Partner 019 `chk_payments_status` is uppercase.

### 4.5 Unique constraints and ON CONFLICT targets

PostgreSQL only infers a **non-partial** unique index or constraint for `ON CONFLICT (cols)` without a `WHERE` predicate.

| Target used by code | Repository provides | Baseline / Align provides | Risk |
|---|---|---|---|
| partner_notifications (partner_id, event_key) (Customer booking/payment/no-show services; Partner notification.repository.js:173) | Partner 026: **partial** unique index (`WHERE event_key IS NOT NULL`), which is not inferable | Align: `CONSTRAINT uq_partner_notifications_event UNIQUE(partner_id, event_key)` (only if Align created the table) | On a repository-built DB these inserts fail with 42P10. |
| earnings (booking_id) | 024 UNIQUE | Align table: none | fails if the live table came from Align |
| commission_records (booking_id) | 021 UNIQUE | Align table: none | same |
| payment_events (provider, event_id) | 020 UNIQUE | baseline UNIQUE(event_id); no `provider` column | likely fails live |
| user_devices (device_token) | n/a | snapshot shows no UNIQUE constraint (unique indexes not captured) | verify |
| partner_wallets / wallets (partner_id) | 022 UNIQUE on wallets | baseline UNIQUE(partner_id) on partner_wallets (works through the auto-updatable view) | OK if the view is simple |
| booking_cancellations (booking_id) | Customer: **no** unique | baseline UNIQUE(booking_id) | fails on a repository-built DB |
| vehicle_pricing (vehicle_id) | 011 UNIQUE | Align UNIQUE index | OK |
| payments: baseline `payments_booking_id_key UNIQUE(booking_id)` | none | baseline | Conflicts with multiple payments per booking (BOOKING_ADVANCE + POST_RENTAL_SETTLEMENT + OVERTIME_CHARGE). Verify whether it still exists. |

### 4.6 Foreign keys needed by financial operations

- `wallet_transactions.wallet_id`: repository FK → `wallets(id)`. Baseline FK → `partner_wallets(id)` and a composite (wallet_id, partner_id) → `partner_wallets(id, partner_id)`. Writers pass ids read from `wallets` (`Admin/src/repositories/admin-wallet.repository.js:1597`). These are valid only when `wallets` is the view over `partner_wallets`, or in the two-table repository layout. A mixed layout (a real `wallets` table plus the baseline FK to `partner_wallets`) breaks inserts.
- `partner_payouts.bank_account_id → partner_bank_accounts(id)` and `partner_id → partners(id)` (baseline). `payout_transactions.payout_id → partner_payouts(id)` (baseline).
- `earnings.wallet_transaction_id → wallet_transactions(id)` (024 only; Align adds the column without an FK).
- `refunds`: Admin 043 FKs booking_id, payment_id, customer_id → users. Baseline FKs booking_id, payment_id, cancellation_id → booking_cancellations.
- `commission_transactions.commission_rule_id → commission_rules(id)` (baseline). Customer inserts `ruleId`, which may be null or a commission_rules id from Admin 043. This is OK only if the ids are from the same table.
- Baseline `bookings`/`payments`/`vehicles` carry composite FKs (for example payments (booking_id, customer_id) → bookings(id, customer_id), and payments (booking_id, partner_id) → bookings(id, partner_id)). Inserts must therefore supply a `partner_id` consistent with the booking. Customer `payment.repository.js` does supply partner_id.

---

## 5. Conflicts between sub-app migrations

1. **Same table, different definitions (`CREATE TABLE IF NOT EXISTS`, first one wins):** users, partners, shops, vehicle_categories, vehicles, vehicle_images, bookings, payments, notifications, support_tickets, support_ticket_messages, booking_return_verifications (Customer vs Partner, plus Admin 046 for notifications), ratings (Partner 044 vs Admin `.sql`, identical). The second chain does not fail at `CREATE TABLE`. It fails at the first `CREATE INDEX` or `ALTER` that names a column its own definition expects:
   - Customer first: Partner `003` fails at `CREATE INDEX idx_partners_kyc_status ON partners(kyc_status)` (column missing).
   - Partner first: Customer `1726600000000` fails at `idx_partners_verification_status ON partners(verification_status)`.
   - The same pattern applies to vehicles (`listing_status`/`category_id` vs `category`/`manual_status`) and bookings (`status`/`end_at` vs `booking_status`/`expected_return_at`).
   - Identically named objects with different definitions silently mask each other: `chk_users_role`, `idx_bookings_status` (on `status` vs `booking_status`), `chk_vehicles_fuel_type` ('PETROL' vs 'Petrol'), `chk_device_tokens_platform` (uppercase vs lowercase), `chk_bookings_status`, `chk_payments_status`.
2. **`payouts`:** a table in Partner 025 and a view in Admin 050 (and in Align). `CREATE OR REPLACE VIEW payouts` on a database where Partner 025 ran fails with "payouts is not a view". Conversely, on the live layout (view) Partner 025's `CREATE TABLE IF NOT EXISTS` is skipped and then `CREATE INDEX … ON payouts` fails ("cannot create index on a view").
3. **`wallets`:** a table in Partner 022 and a view in Align and the hardening SQL. On the live layout Partner 022 fails at `CREATE INDEX idx_wallets_partner_id` (view). Partner 023 then FKs to `wallets(id)`, which is impossible against a view.
4. **`support_ticket_messages`:** a table in Customer and Partner 029, and a view over `support_messages` in Align and the hardening SQL. On the live layout Partner 029's index fails, and Admin 045's `ALTER TABLE support_ticket_messages DROP/ADD CONSTRAINT` fails against a view.
5. **Global reference IDs are triplicated:** Customer `1728500000000_add-global-public-reference-ids.js`, Partner `043_add_global_public_reference_ids.js` and Admin `054_add_global_public_reference_ids.js` have identical bodies but different names, so each tracker considers its own copy pending and runs it. All three `ALTER` the uncreated `customer_profiles` and the Admin-created `refunds`.
6. **Duplicated alterations:** Partner `040` and Admin `049` (vehicle_images verification, identical). Partner `035/041` and Customer `1728100000000/1728300000000` (chk_payments_type). Partner `001`, Customer `1726300000000` and Admin `040` all define `update_updated_at_column()`. Partner `044` and Admin `20261010…sql` both define ratings.
7. **Shared `schema_migrations` between Partner and Admin:** there are no exact filename collisions, but the numeric prefixes 038–049 overlap (for example Partner `038_migrate_auth_provider_to_supabase.js` and Admin `038_create_admin_actions_table.js`). `Admin/src/db/migrator.js` `down()` only rolls back rows whose names exist in its own directory. **`Partner/src/db/migrator.js` `down()` takes the newest row in the table regardless of owner**, so after any Admin migration it throws "Migration file not found for applied migration: <admin file>". Each migrator's `up()` independently runs all of its own unapplied files (see `docs/DEPLOYMENT.md` §3b warning).
8. **Customer uses a different tracker (`pgmigrations`).** Partner and Admin cannot see Customer's history and vice versa, so overlapping DDL (items 1 and 5) runs once per tracker.
9. **Admin migrator ignores `.sql` files.** `20261007_production_supabase_security_hardening.sql` and `20261010_create_ratings_table_and_rls.sql` are not recorded in any tracking table.

---

## 6. Verdict: can a fresh database be provisioned from repository migrations alone?

**No. No ordering of the three chains succeeds.** At least three relations that migrations `ALTER` are created by none of them: `customer_profiles`, `partner_payouts` and `platform_charge_settings`. 30 further baseline tables that the code needs are also never created. Even with those absent, the Customer and Partner chains collide on shared table names (§5.1). Concrete failure points on an empty PostgreSQL/Supabase database:

| Chain / order | Result |
|---|---|
| **Partner alone** (`node src/db/migrator.js up`) | 001 → `043_add_duration_pricing_slabs.js` succeed. **`043_add_global_public_reference_ids.js` fails**: `relation "customer_profiles" does not exist` (`refunds` is also missing). The migrator stops. If that file were skipped, **`044_create_ratings_table.js` fails**: policy `customer_submit_rating` references `b.status`, which Partner `bookings` lacks. On vanilla PostgreSQL it also fails on role `authenticated` and schema `auth` (`auth.uid()`). |
| **Admin after Partner** | 038–047 succeed. **048 fails**: `ALTER TABLE admin_actions ALTER COLUMN admin_id DROP NOT NULL` (column does not exist; admin_id/action_type/target_type exist only in the baseline `admin_actions`). If it had not failed, `users_role_check` (lowercase) plus Partner `chk_users_role` (uppercase) would make `users` un-insertable. **050 fails** (`partner_payouts` does not exist; also `payouts` is a table, not a view). **054 fails** (`customer_profiles`). **055 fails** (`platform_charge_settings`). 049, 051, 052 and 053 would succeed individually. |
| **Customer alone** (`npm run migrate:up`) | 1726300000000 → 1728300000000 succeed (requires `pgcrypto` and `btree_gist`). **1728400000000 fails**: `ALTER TABLE refunds` (`refunds` not yet created). **1728500000000 fails**: `customer_profiles`. |
| **Customer, then Admin 043, then Customer 1728400000000** | 1728400000000 passes. 1728500000000 still fails (`customer_profiles`). |
| **Customer + Partner on one DB** | Whichever runs second fails at the first index on a column its own definition expects (Partner 003 `idx_partners_kyc_status`, or Customer 1726600000000 `idx_partners_verification_status`). |
| **Any chain after `apply_supabase_alignment.js`** | Partner 022/025/029 fail on `CREATE INDEX` against the views `wallets`/`payouts`/`support_ticket_messages`. |

Even with the failures above bypassed, the code still needs objects that no repository artefact defines (§2: `platform_charge_settings`, `platform_fee_settings`; §3: `vehicle_pricing_history.effective_to`, plus the "NONE" columns). And the repository versions of `wallet_transactions` (direction CHECK, missing `balance_before`) and `commission_records` (status/rate CHECKs) reject what the code writes.

**What actually produced the live database** (inferred from the artefacts):
1. Supabase baseline schema (78 tables, origin outside this repository; snapshot in `Customer/scripts/supabase_schema.json`).
2. `Partner/scripts/apply_supabase_alignment.js`, which creates the views and adds compatibility columns.
3. A selective subset of migrations. Evidence from dbmd: `users.created_by` (Admin 048), `customer_reference`/`booking_reference`/`order_reference` (one of the global-reference migrations), and partners `landmark`/`area`/`opening_time` (Partner 045/046) are present. `payments.metadata` (Partner 035), `users.avatar_storage_key` (Customer 1728200000000) and all Customer `bookings` columns are absent.
4. Manual SQL (`20261007_…hardening.sql`, probably `20261010_…ratings.sql`).

The exact applied set must be read from `schema_migrations` and `pgmigrations` (§7, Q2). A reproducible environment requires a committed baseline, for example a `pg_dump --schema-only` of staging taken as migration zero, before any of the three chains.

---

## 7. Staging schema verification procedure (read-only SQL for the Supabase SQL editor)

All queries are catalog/`information_schema` reads, plus a few `SELECT DISTINCT`/`count(*)` data probes. Optionally wrap each group in `BEGIN READ ONLY; … ROLLBACK;`. Run them against **staging**, then compare with §§2–4.

### Q1. Relation inventory and kinds (expect `wallets`, `payouts`, `support_ticket_messages` = view in the live layout)

```sql
SELECT c.relname,
       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview'
                      WHEN 'p' THEN 'partitioned' ELSE c.relkind::text END AS kind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')
ORDER BY 1;

SELECT table_name, is_updatable, is_insertable_into, view_definition
FROM information_schema.views
WHERE table_schema = 'public' AND table_name IN ('wallets','payouts','support_ticket_messages');
```

### Q2. Which migrations were applied, and by which tracker

```sql
SELECT name, executed_at FROM schema_migrations ORDER BY id;          -- Partner + Admin (shared)
SELECT id, name, run_on FROM pgmigrations ORDER BY id;                -- Customer (node-pg-migrate default)
```

### Q3. Required relations that are missing

```sql
WITH req(name) AS (VALUES
 -- created by repository migrations
 ('users'),('partners'),('shops'),('vehicle_categories'),('cities'),('vehicles'),('vehicle_images'),
 ('vehicle_documents'),('vehicle_pricing'),('vehicle_pricing_history'),('vehicle_availability_blocks'),
 ('bookings'),('booking_price_breakdown'),('booking_cancellations'),('booking_return'),
 ('booking_pricing_snapshots'),('booking_pickup_verifications'),('booking_return_verifications'),
 ('damage_reports'),('payments'),('payment_attempts'),('payment_events'),('commission_records'),
 ('wallets'),('wallet_transactions'),('earnings'),('payouts'),('partner_documents'),('partner_bank_accounts'),
 ('partner_notifications'),('partner_device_tokens'),('partner_consents'),('support_tickets'),
 ('support_ticket_messages'),('audit_logs'),('storage_uploads'),('outbox_events'),('ratings'),
 ('customer_documents'),('customer_addresses'),('customer_device_tokens'),('idempotency_keys'),
 ('coupons'),('coupon_redemptions'),('notifications'),('notification_templates'),
 ('admin_actions'),('admin_permissions'),('admin_settings'),('admin_sessions'),('refunds'),
 ('commission_rules'),('disputes'),('cancellation_refund_rules'),('franchise_applications'),
 -- NOT created by any repository migration (section 2)
 ('partner_wallets'),('partner_payouts'),('customer_profiles'),('commission_transactions'),
 ('platform_charge_settings'),('platform_fee_settings'),('reviews'),('review_replies'),('review_reports'),
 ('offers'),('offer_shops'),('offer_vehicles'),('payment_webhooks'),('payout_transactions'),
 ('booking_pickup'),('booking_status_history'),('booking_customer_details'),('rental_agreements'),
 ('coupon_rules'),('customer_identity_verifications'),('customer_saved_addresses'),
 ('partner_verification_history'),('shop_documents'),('shop_images'),('shop_operating_hours'),
 ('shop_verification_history'),('support_messages'),('support_attachments'),('ticket_status_history'),
 ('user_devices'),('vehicle_brands'),('vehicle_models')
)
SELECT r.name, c.relkind
FROM req r
LEFT JOIN pg_class c ON c.relname = r.name AND c.relnamespace = 'public'::regnamespace
WHERE c.oid IS NULL OR c.relkind NOT IN ('r','v','p')
ORDER BY 1;
```

### Q4. Required columns that are missing (financial and vehicle tables first)

```sql
WITH req(t, c) AS (VALUES
 ('wallet_transactions','wallet_id'),('wallet_transactions','partner_id'),('wallet_transactions','transaction_type'),
 ('wallet_transactions','direction'),('wallet_transactions','amount'),('wallet_transactions','balance_before'),
 ('wallet_transactions','balance_after'),('wallet_transactions','reference_type'),('wallet_transactions','reference_id'),
 ('wallet_transactions','status'),('wallet_transactions','description'),('wallet_transactions','metadata'),
 ('partner_wallets','available_balance'),('partner_wallets','pending_balance'),('partner_wallets','receivable_balance'),
 ('partner_wallets','total_credited'),('partner_wallets','total_debited'),('partner_wallets','total_earned'),
 ('partner_wallets','total_paid_out'),('partner_wallets','currency'),
 ('wallets','available_balance'),('wallets','pending_balance'),('wallets','total_credited'),('wallets','total_debited'),
 ('partner_payouts','payout_number'),('partner_payouts','bank_account_id'),('partner_payouts','status'),
 ('partner_payouts','idempotency_key'),('partner_payouts','provider_transfer_id'),('partner_payouts','processed_by'),
 ('partner_payouts','payment_method'),('partner_payouts','payment_reference'),('partner_payouts','notes'),
 ('partner_payouts','requested_at'),('partner_payouts','approved_at'),('partner_payouts','processed_at'),('partner_payouts','completed_at'),
 ('payouts','processed_by'),('payouts','payment_method'),('payouts','payment_reference'),('payouts','notes'),('payouts','payout_number'),
 ('earnings','wallet_transaction_id'),('earnings','gross_amount'),('earnings','commission_amount'),('earnings','net_earnings'),
 ('earnings','partner_net_amount'),('earnings','status'),('earnings','settlement_status'),('earnings','settled_at'),
 ('commission_records','commission_type'),('commission_records','commission_rate'),('commission_records','rate'),
 ('commission_records','gross_booking_amount'),('commission_records','partner_payable_amount'),('commission_records','partner_payout_amount'),
 ('commission_transactions','commission_rule_id'),('commission_transactions','base_amount'),('commission_transactions','status'),
 ('refunds','idempotency_key'),('refunds','provider_refund_id'),('refunds','processed_by'),('refunds','utr'),('refunds','payment_method'),
 ('refunds','notes'),('refunds','upi_id'),('refunds','original_paid_amount'),('refunds','refund_percentage'),('refunds','policy_name'),
 ('refunds','refund_reference'),('refunds','cancellation_id'),('refunds','requested_at'),('refunds','customer_id'),
 ('payments','partner_id'),('payments','payment_number'),('payments','order_reference'),('payments','payment_type'),
 ('payments','provider'),('payments','provider_order_id'),('payments','provider_payment_id'),('payments','metadata'),('payments','failure_reason'),
 ('bookings','status'),('bookings','booking_status'),('bookings','payment_status'),('bookings','booking_reference'),
 ('bookings','end_at'),('bookings','expected_return_at'),('bookings','subtotal'),('bookings','tax_amount'),('bookings','platform_fee'),
 ('bookings','extra_charges'),('bookings','currency'),('bookings','rental_type'),('bookings','base_amount'),('bookings','security_deposit'),
 ('bookings','coupon_id'),('bookings','coupon_code'),('bookings','price_per_hour'),('bookings','rental_amount'),
 ('vehicles','is_active'),('vehicles','is_available'),('vehicles','rejection_reason'),('vehicles','primary_image_url'),
 ('vehicles','category'),('vehicles','category_id'),('vehicles','brand'),('vehicles','model'),('vehicles','model_id'),
 ('vehicles','manual_status'),('vehicles','rental_status'),('vehicles','listing_status'),('vehicles','is_archived'),
 ('vehicles','vehicle_reference'),('vehicles','rating_avg'),('vehicles','rating_count'),('vehicles','status'),('vehicles','vehicle_name'),
 ('vehicle_pricing_history','effective_from'),('vehicle_pricing_history','effective_to'),('vehicle_pricing_history','valid_from'),
 ('vehicle_pricing_history','valid_to'),('vehicle_pricing_history','changed_by'),('vehicle_pricing_history','price_3_hours'),
 ('users','status'),('users','deleted_at'),('users','created_by'),('users','customer_reference'),('users','avatar_storage_key'),
 ('users','country_code'),('users','auth_id'),
 ('customer_profiles','customer_reference'),
 ('outbox_events','next_retry_at'),('outbox_events','locked_at'),('outbox_events','locked_by'),
 ('payment_events','provider'),('payment_events','is_processed'),
 ('support_messages','sender_type'),('support_messages','attachments'),
 ('rental_agreements','accepted_at'),('rental_agreements','acknowledged_at'),('rental_agreements','storage_path')
)
SELECT r.t AS table_name, r.c AS column_name
FROM req r
LEFT JOIN information_schema.columns ic
  ON ic.table_schema = 'public' AND ic.table_name = r.t AND ic.column_name = r.c
WHERE ic.column_name IS NULL
ORDER BY 1, 2;
```

Some columns in this list are known to be one-shape-only (for example `vehicles.category_id` vs `vehicles.category`). Interpret a missing column against the code paths cited in §3, not as an automatic defect.

### Q5. Column types that affect comparisons

```sql
SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name, column_name) IN (
    ('wallet_transactions','reference_id'),('wallet_transactions','direction'),('wallet_transactions','balance_before'),
    ('wallet_transactions','reference_type'),('commission_records','commission_rate'),('commission_records','rate'),
    ('payments','payment_type'),('bookings','status'),('bookings','booking_status'),('users','role'),('users','phone'))
ORDER BY 1, 2;
```

### Q6. CHECK constraints on financial and status tables

```sql
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'c'
  AND conrelid::regclass::text IN (
    'wallet_transactions','partner_wallets','partner_payouts','payout_transactions','commission_records',
    'commission_transactions','earnings','refunds','payments','bookings','users','support_tickets',
    'support_ticket_messages','support_messages','notifications','vehicles','payment_events','outbox_events')
ORDER BY 1, 2;
```

Check the result for:
- `wallet_transactions` direction case, plus the reference_type and transaction_type value sets.
- `partner_payouts_status_check` including `pending`/`paid`/`rejected`.
- `commission_records` and `commission_transactions` status sets vs `'LOCKED'` / `'COMMISSION_LOCKED'` / `'applied'`.
- `refunds_status_check` case-insensitivity.
- Two `users` role CHECKs (`chk_users_role` + `users_role_check`) present together.
- `chk_payments_type` vs a `'RENTAL'` default.

### Q7. Unique indexes and constraints, and ON CONFLICT targets

```sql
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('wallet_transactions','partner_payouts','partner_wallets','earnings','commission_records',
                    'commission_transactions','payments','payment_events','refunds','partner_notifications',
                    'partner_device_tokens','user_devices','customer_device_tokens','booking_cancellations',
                    'vehicle_pricing','customer_profiles','bookings','outbox_events')
ORDER BY 1, 2;

-- Does a NON-partial unique index exist whose column set matches each ON CONFLICT target used by the code?
WITH targets(tbl, cols) AS (VALUES
  ('earnings','booking_id'), ('commission_records','booking_id'), ('partner_wallets','partner_id'),
  ('partner_notifications','event_key,partner_id'), ('partner_device_tokens','partner_id,token'),
  ('payment_events','event_id,provider'), ('vehicle_pricing','vehicle_id'), ('booking_cancellations','booking_id'),
  ('booking_pickup_verifications','booking_id'), ('customer_profiles','user_id'),
  ('customer_device_tokens','device_token'), ('user_devices','device_token'),
  ('offer_shops','offer_id,shop_id'), ('offer_vehicles','offer_id,vehicle_id'),
  ('admin_permissions','permission,user_id'), ('admin_settings','key'))
SELECT t.tbl, t.cols,
       (SELECT string_agg(ic.relname, ', ')
          FROM pg_index x
          JOIN pg_class ic ON ic.oid = x.indexrelid
         WHERE x.indrelid = to_regclass('public.' || t.tbl)
           AND x.indisunique AND x.indpred IS NULL
           AND (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
                  FROM unnest(x.indkey::int2[]) AS k(attnum)
                  JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) = t.cols
       ) AS matching_unique_index           -- NULL => that ON CONFLICT raises 42P10
FROM targets t
ORDER BY 1;

-- Payout / settlement idempotency indexes
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('idx_partner_payouts_idempotency','idx_payouts_partner_idempotency',
                    'uq_wallet_transactions_settlement_credit','uq_refunds_idempotency_key',
                    'payments_booking_id_key','uq_payments_order_reference','uq_bookings_booking_reference');

-- Double-booking guard
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = to_regclass('public.bookings') AND contype = 'x';
```

### Q8. Foreign keys used by financial operations

```sql
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'f'
  AND conrelid::regclass::text IN ('wallet_transactions','partner_payouts','payout_transactions','earnings',
                                   'commission_records','commission_transactions','refunds','payments','partner_wallets')
ORDER BY 1, 2;
```

Expect `wallet_transactions.wallet_id` to reference `partner_wallets`, and `wallets` to be a view over `partner_wallets`. A real `wallets` table combined with an FK to `partner_wallets` breaks inserts.

### Q9. Stored-vocabulary probes (read-only data, counts only)

```sql
SELECT direction, transaction_type, reference_type, status, count(*)
FROM wallet_transactions GROUP BY 1,2,3,4 ORDER BY 5 DESC;

SELECT status, count(*) FROM partner_payouts GROUP BY 1 ORDER BY 2 DESC;
SELECT status, commission_type, count(*) FROM commission_transactions GROUP BY 1,2 ORDER BY 3 DESC;
SELECT status, count(*) FROM commission_records GROUP BY 1 ORDER BY 2 DESC;
SELECT payment_type, status, count(*) FROM payments GROUP BY 1,2 ORDER BY 3 DESC;

-- Duplicate checks that a future unique index would trip on
SELECT partner_id, idempotency_key, count(*) FROM partner_payouts
WHERE idempotency_key IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;
SELECT reference_type, reference_id, transaction_type, direction, count(*) FROM wallet_transactions
GROUP BY 1,2,3,4 HAVING count(*) > 1;
SELECT booking_id, payment_type, count(*) FROM payments GROUP BY 1,2 HAVING count(*) > 1;
```

### Q10. Compile-only check of the "NONE" column queries (no rows touched)

`EXPLAIN` parses and plans without executing. Each statement below should error if the column is absent (expected per §3).

```sql
EXPLAIN SELECT b.rental_amount, v.category_id FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id LIMIT 1;  -- Customer payment.service.js:1015
EXPLAIN SELECT b.start_date, b.end_date FROM bookings b LIMIT 1;                                             -- Admin admin-payment / damage-dispute
EXPLAIN SELECT p.provider_reference, p.user_id FROM payments p LIMIT 1;                                      -- Admin admin-reports
EXPLAIN SELECT wt.type FROM wallet_transactions wt LIMIT 1;                                                  -- Admin admin-reports
EXPLAIN SELECT effective_to FROM vehicle_pricing_history LIMIT 1;                                            -- Partner pricing.repository.js
EXPLAIN SELECT 1 FROM wallet_transactions t JOIN payments p ON t.reference_id = p.id::text LIMIT 1;         -- Partner reconciliation.service.js
```

---

### Appendix: counts

- Repository-migration relations: 55 distinct (Customer 23, Partner 33, Admin 11 tables + 1 view; 14 names defined by more than one sub-app). The Admin `.sql` ratings table duplicates Partner 044.
- Relations referenced by code but not created by any migration: **32** (30 in the baseline snapshot; `platform_charge_settings` and `platform_fee_settings` in no repository artefact). Plus 1 latent (`reports`).
- Migrations that `ALTER` uncreated relations: Customer 1728400000000 (refunds, before Admin 043), Customer 1728500000000, Partner 043_add_global_public_reference_ids, Admin 050, Admin 054, Admin 055. Admin 048 alters non-existent `admin_actions` columns.
- Working-tree caveats: Partner `049_add_is_active_to_vehicles.js` is untracked and `048_add_changed_by_to_vehicle_pricing_history.js` is staged but uncommitted at the time of analysis.
