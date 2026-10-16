# GONGO Partner Backend — Database Schema Documentation

## 1. Overview & Architectural Principles

The GONGO Partner Backend database is built on PostgreSQL (32 sequential migrations) designed for strict financial correctness, operational reliability, and boundary isolation.

### Key Tenets
1. **Partner as Canonical Business Entity**:
   - `partners` is the authoritative entity for profile, business name, address, city, location coordinates (`latitude`, `longitude`), and operating hours.
   - `shops` is a legacy compatibility table maintained exclusively for foreign key backward compatibility (`vehicles.shop_id`, `bookings.shop_id`). New Phase 6+ features must treat the Partner as the canonical owner.
2. **Canonical KYC Documents**:
   - Strictly 4 valid document types enforced via database CHECK constraints: `AADHAAR`, `PAN`, `GST`, `SHOP_ESTABLISHMENT`.
   - Document submissions support sequential versioning (`version = 1, 2...`) with unique constraint `(partner_id, document_type, version)`.
3. **Storage Uploads Tracking (`storage_uploads`)**:
   - Tracks all direct S3 presigned upload sessions with state machine (`PENDING`, `COMPLETED`, `FAILED`, `EXPIRED`).
   - S3 keys are strictly isolated per partner: `partners/{partnerId}/...`.
4. **Payment Gateway**: Exclusively **CASHFREE** (`provider = 'CASHFREE'`). Outdated providers (e.g. Razorpay) are prohibited by schema check constraints.
5. **No Partner Accept/Reject**: Partner does **NOT** accept or reject customer bookings manually. Bookings are automatically confirmed upon customer payment. Allowed statuses: `PENDING_PAYMENT`, `CONFIRMED`, `ACTIVE`, `COMPLETED`, `CANCELLED`.
6. **Ledger-Based Partner Wallet**: Mandatory append-only ledger (`wallet_transactions`). No balance modification can occur without a corresponding immutable ledger entry.
7. **Confidential Internal Commission**: GONGO commission details (`commission_records`) are internal financial records. They are strictly excluded from customer/partner-facing pricing snapshots, DTOs, and APIs.
8. **No Floating-Point Money**: All financial quantities strictly use `NUMERIC(12,2)`.
9. **No Plaintext OTP Storage**: Customer handover OTPs are **never** stored in plaintext. Only cryptographically hashed verification signatures (`otp_hash`) are recorded.

---

## 2. Table Summary & Relationships

```text
users (Auth & User identity, role: PARTNER | CUSTOMER | ADMIN)
  └── partners (Canonical business entity, profile, location, KYC status)
        ├── shops (Legacy rental location compatibility table)
        │     └── vehicles (Inventory - Phase 6)
        │           ├── vehicle_images (Storage references)
        │           ├── vehicle_documents (Versioned)
        │           ├── vehicle_pricing (Current rates)
        │           ├── vehicle_pricing_history (Historical rates)
        │           └── vehicle_availability_blocks (Maintenance blocks)
        ├── partner_documents (KYC Documents: AADHAAR, PAN, GST, SHOP_ESTABLISHMENT)
        ├── storage_uploads (Direct S3 upload lifecycle tracking)
        ├── partner_bank_accounts (Payout destinations - Phase 13)
        ├── wallets (Current balances)
        │     └── wallet_transactions (Immutable ledger)
        ├── earnings (Settlement tracking)
        ├── payouts (Withdrawal transactions)
        ├── partner_notifications
        ├── partner_device_tokens (FCM tokens)
        └── support_tickets
              └── support_ticket_messages

bookings (Marketplace bookings)
  ├── booking_pricing_snapshots (Immutable customer financial snapshot)
  ├── booking_pickup_verifications (Handover verification - Hashed OTP)
  ├── booking_return_verifications (Return verification & charges)
  ├── damage_reports (Incident tracking)
  ├── payments (Cashfree PG transactions)
  ├── payment_events (Webhook idempotency log)
  ├── commission_records (Internal GONGO commission)
  └── earnings (Linkage to partner payout ledger)

audit_logs (Immutable security audit trail)
```

---

## 3. Core Tables Reference

### `users`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | User unique ID |
| `auth_id` | VARCHAR(128) | UNIQUE, NOT NULL | Supabase Auth UID |
| `role` | VARCHAR(32) | NOT NULL, CHECK in ('PARTNER', 'CUSTOMER', 'ADMIN') | User role |
| `name` | VARCHAR(128) | NOT NULL | Partner contact name |
| `phone` | VARCHAR(20) | UNIQUE, NOT NULL | Registered 10-digit mobile |
| `email` | VARCHAR(255) | NULL | Optional contact email |
| `is_active` | BOOLEAN | DEFAULT true | Account status flag |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | Creation timestamp |
| `updated_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP | Modification timestamp |

### `partners`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | Partner unique ID |
| `user_id` | UUID | UNIQUE, NOT NULL, REFERENCES users(id) | Linked user account |
| `partner_status` | VARCHAR(32) | DEFAULT 'OFFLINE', CHECK in ('OFFLINE', 'ONLINE', 'SUSPENDED') | Operational status |
| `kyc_status` | VARCHAR(32) | DEFAULT 'PENDING', CHECK in ('PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED') | Verification status |
| `profile_image_url` | VARCHAR(500) | NULL | S3 storage key or URL |
| `business_name` | VARCHAR(200) | NULL | Canonical business/hub name |
| `business_address` | TEXT | NULL | Canonical hub physical address |
| `city` | VARCHAR(100) | NULL | Operating city |
| `latitude` | NUMERIC(10,8) | NULL | Hub GPS latitude |
| `longitude` | NUMERIC(11,8) | NULL | Hub GPS longitude |
| `operating_info` | VARCHAR(200) | NULL | Operating schedule/hours |
| `rating` | NUMERIC(3,2) | DEFAULT 5.00 | Aggregate rating (server-controlled) |
| `review_count` | INTEGER | DEFAULT 0 | Total reviews count |
| `registered_since` | VARCHAR(32) | NULL | Registration display month/year |
| `is_active` | BOOLEAN | DEFAULT true | Active status |

### `partner_documents`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | Document record ID |
| `partner_id` | UUID | NOT NULL, REFERENCES partners(id) | Owning partner |
| `document_type` | VARCHAR(50) | NOT NULL, CHECK in ('AADHAAR', 'PAN', 'GST', 'SHOP_ESTABLISHMENT') | Canonical KYC type |
| `document_number` | VARCHAR(100) | NULL | Raw document number (masked on read) |
| `storage_key` | VARCHAR(500) | NOT NULL | Private S3 object key |
| `verification_status` | VARCHAR(32) | DEFAULT 'PENDING', CHECK in ('PENDING', 'VERIFIED', 'REJECTED') | Document state |
| `version` | INTEGER | DEFAULT 1, NOT NULL | Version sequence |
| `rejection_reason` | TEXT | NULL | Admin rejection explanation |
| *Constraint* | UNIQUE | (partner_id, document_type, version) | Concurrency collision protection |

### `storage_uploads`
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY, DEFAULT gen_random_uuid() | Upload session ID |
| `partner_id` | UUID | NOT NULL, REFERENCES partners(id) | Owning partner |
| `entity_type` | VARCHAR(50) | NOT NULL, CHECK in ('PROFILE_IMAGE', 'KYC_DOCUMENT', 'VEHICLE_IMAGE', 'VEHICLE_DOCUMENT') | Target domain entity |
| `entity_id` | UUID | NULL | Associated target entity ID |
| `document_type` | VARCHAR(50) | NULL, CHECK in ('AADHAAR', 'PAN', 'GST', 'SHOP_ESTABLISHMENT') | KYC document type if applicable |
| `storage_key` | VARCHAR(500) | NOT NULL | Backend-generated S3 key |
| `content_type` | VARCHAR(100) | NOT NULL | Declared MIME type |
| `expected_size_bytes` | BIGINT | NULL | Maximum size limit |
| `actual_size_bytes` | BIGINT | NULL | Verified size from S3 HeadObject |
| `status` | VARCHAR(32) | DEFAULT 'PENDING', CHECK in ('PENDING', 'COMPLETED', 'FAILED', 'EXPIRED') | Upload session state |
| `expires_at` | TIMESTAMPTZ | NOT NULL | Presigned URL expiration time |

---

## 4. Migration History (001–032)

1. `001_create_uuid_extension.js`: Enables `uuid-ossp` or `pgcrypto`.
2. `002_create_users_table.js`: Core user accounts with role constraints.
3. `003_create_partners_table.js`: Partner business accounts and verification states.
4. `004_create_shops_table.js`: Hub rental locations (maintained as legacy compatibility).
5. `005_create_vehicle_categories_table.js`: Seeded categories (`CAR`, `BIKE`, `SCOOTER`).
6. `006_create_vehicles_table.js`: Fleet inventory table with status states.
7. `007_create_vehicle_pricing_table.js`: Base rates and hourly/daily slabs.
8. `008_create_vehicle_pricing_history_table.js`: Immutable audit of price adjustments.
9. `009_create_vehicle_images_table.js`: Vehicle photos with cover and sort order.
10. `010_create_vehicle_documents_table.js`: RC, Insurance, Fitness certificates.
11. `011_create_vehicle_availability_blocks_table.js`: Maintenance and unavailability blocks.
12. `012_create_partner_documents_table.js`: KYC documents with versioning.
13. `013_create_partner_bank_accounts_table.js`: Bank accounts for payouts.
14. `014_create_wallets_table.js`: Partner wallet current balances.
15. `015_create_wallet_transactions_table.js`: Append-only immutable wallet ledger.
16. `016_create_bookings_table.js`: Customer vehicle reservations.
17. `017_create_booking_pricing_snapshots_table.js`: Immutable customer pricing breakdown.
18. `018_create_booking_pickup_verifications_table.js`: Handover verification with hashed OTP.
19. `019_create_booking_return_verifications_table.js`: Return inspection and excess charges.
20. `020_create_damage_reports_table.js`: Incident damage claims.
21. `021_create_payments_table.js`: Cashfree payment transactions.
22. `022_create_payment_events_table.js`: Cashfree webhook idempotency log.
23. `023_create_commission_records_table.js`: Internal GONGO commission ledger.
24. `024_create_earnings_table.js`: Partner settlement records.
25. `025_create_payouts_table.js`: Partner bank withdrawal transfers.
26. `026_create_partner_notifications_table.js`: In-app notification queue.
27. `027_create_partner_device_tokens_table.js`: FCM push notification tokens.
28. `028_create_support_tickets_table.js`: Partner support requests.
29. `029_create_support_ticket_messages_table.js`: Support conversation thread.
30. `030_create_audit_logs_table.js`: Tamper-evident operational audit trail.
31. `031_create_storage_uploads_table.js`: S3 presigned direct upload sessions.
32. `032_reconcile_schema_and_hardening.js`: Added canonical business/location fields to `partners`, backfilled from `shops`, enforced canonical KYC types (`AADHAAR`, `PAN`, `GST`, `SHOP_ESTABLISHMENT`), and reconciled booking statuses.
33. `033_add_vehicle_document_storage_and_hardening.js`: Added `pickup_location` to vehicles, added `VEHICLE_DOCUMENT` to `storage_uploads.entity_type`, and created composite inventory indexes.
34. `034_add_return_and_pricing_snapshot_hardening.js`: Added `price_per_hour` to `booking_pricing_snapshots` to preserve immutable historical rate for return calculations; added `return_status` ('ON_TIME' | 'LATE') and `total_distance` to `booking_return_verifications`.
