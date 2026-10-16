# GONGO Admin Backend — Supabase Database Integration Guide

## 1. Executive Summary & Objective

The **GONGO Admin Backend** (`server/Admin`) is the dedicated Node.js/Express server layer providing administrative control, operations management, analytics, financial processing, and audit logging for the **GONGO** mobility platform.

The backend connects directly and exclusively to the existing **Supabase PostgreSQL database** (74 tables defined in `GONGO_DB_REFERENCE.md`). 

### Core Architectural Principles
* **Single Source of Truth**: The Supabase PostgreSQL database is the single authoritative store.
* **No Database Duplication**: No duplicate tables, shadow schemas, or conflicting ORM schemas are created.
* **Supabase PostgreSQL**: The Admin Backend uses Supabase PostgreSQL and Storage. Admin sign-in is handled by this backend (password + Google OAuth); see [docs/ADMIN_AUTHENTICATION.md](docs/ADMIN_AUTHENTICATION.md).
* **Zero Frontend DB Access**: The Admin Frontend NEVER directly accesses Supabase or S3 credentials. All requests flow through the Admin Backend REST API.
* **Strict Admin RBAC**: Server-side role resolution and permission verification on every route (`admin`, `support_executive`).
* **Audit Trail**: Every administrative action writes an immutable record to `admin_actions` and `audit_logs`.

---

## 2. Architecture & Request Pipeline

```text
GONGO ADMIN FRONTEND (React / Vite)
        │
        │ HTTPS REST API (/api/v1 and /api)
        ▼
GONGO ADMIN BACKEND (Node.js + Express)
        │
        ├── Rate Limiting (express-rate-limit)
        ├── Security Headers (helmet, cors)
        ├── Authentication (email/mobile + password, Google OAuth → server-side admin sessions)
        ├── RBAC & Permissions (authenticate.js, authorize.js)
        ├── Mass-Assignment Protection & Validation (validate.js)
        ├── Business Logic & Transactional Services
        ├── Audit Logging (admin_actions, audit_logs)
        │
        ▼
SUPABASE POSTGRESQL DATABASE (74 Public Tables)
        ├── users & customer profiles
        ├── partners, kyc, documents, bank accounts
        ├── shops, operating hours, documents
        ├── vehicles, images, features, pricing, availability
        ├── bookings, items, breakdown, status history, pickup/return
        ├── payments, attempts, transactions, webhooks
        ├── refunds, refund_transactions, cancellations
        ├── commission_rules, commission_transactions
        ├── partner_wallets, wallet_transactions
        ├── partner_payouts, payout_transactions
        ├── reviews, review_replies, review_reports
        ├── coupons, rules, redemptions
        ├── offers, offer_vehicles, offer_shops
        ├── support_tickets, messages, attachments, status history
        ├── disputes, dispute_evidence
        ├── rental_agreements
        └── admin_actions, audit_logs
```

---

## 3. Environment Variables & Setup

Create a `.env` file in `server/Admin/` matching `.env.example`:

```env
# Server Configuration
PORT=5000
NODE_ENV=development
API_PREFIX=/api/v1
CORS_ORIGIN=http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173

# Supabase Production Database (Required)
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJh...your-secret-service-role-key...

# Direct PostgreSQL Connection (Optional for High-Performance Pool)
DATABASE_URL=postgresql://postgres:password@db.your-project-id.supabase.co:5432/postgres
DB_MAX_CONNECTIONS=20
DB_IDLE_TIMEOUT_MS=30000
DB_CONNECTION_TIMEOUT_MS=5000

# Authentication & Session Security
JWT_SECRET=your-256-bit-super-secure-jwt-secret-string-here-min-32-chars
ADMIN_SESSION_TTL_SECONDS=86400
ADMIN_MAX_ACTIVE_SESSIONS=5
CIPHER_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# Redis Cache & Token Blacklist (Optional, falls back to memory)
REDIS_URL=redis://localhost:6379

# AWS S3 Storage (For Secure Signed URLs)
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET_DOCUMENTS=gongo-secure-documents
AWS_S3_BUCKET_MEDIA=gongo-public-media
```

### Environment Startup Validation
At backend startup, `src/config/env.js` validates that:
1. `SUPABASE_URL` is set and has a valid URL structure.
2. `SUPABASE_SERVICE_ROLE_KEY` is set and is non-empty.
3. If running in `NODE_ENV=production`, missing Supabase credentials cause immediate fail-fast termination with an explicit error.
4. Secrets are NEVER logged in logs, stack traces, or responses.

---

## 4. Supabase Client & Database Access Layer

### Dedicated Singleton Client (`src/config/supabase.js`)
* Initialized exactly once and reused across the application.
* Uses `SUPABASE_SERVICE_ROLE_KEY` to bypass Row-Level Security (RLS) safely within the server boundary.
* The service role key is NEVER passed to the frontend.
* Exposes `getSupabase()`, `isSupabaseConfigured()`, and `checkSupabaseHealth()`.

### Repository Pattern (`src/repositories/`)
Controllers do NOT execute raw Supabase or PostgreSQL queries. All data access flows through dedicated repositories:
* `user.repository.js` — User identity resolution, Firebase UID mapping.
* `admin-partner.repository.js` — Partner profiles, KYC, verification history.
* `admin-vehicle.repository.js` — Vehicle catalog, physical vs future availability, pricing.
* `admin-booking.repository.js` — Booking ledger, customer snapshots, status history.
* `admin-finance.repository.js` — Payments, refunds, commissions, wallets, payouts.
* `admin-dashboard.repository.js` — Aggregated metrics across all 13 business domains.
* `admin-action.repository.js` & `audit_logs` — Immutable audit records.

---

## 5. Admin Authentication & Role-Based Access Control (RBAC)

### Identity Resolution Flow
1. Incoming HTTP Request with `Authorization: Bearer <admin session token>` (issued by `POST /admin/auth/login` or the Google ticket exchange).
2. `middlewares/auth.js` hashes the token and looks it up in `admin_sessions` (active, unexpired). No other credential type is accepted.
3. The session's `user_id` is resolved against `users.id`.
4. Role and status are retrieved authoritatively from the database:
   * Must have `status = 'active'` (or `is_active = true`) and `deleted_at IS NULL`.
   * Must have `role IN ('admin', 'super_admin', 'support_executive')`.
5. Request body or header values for `role`, `user_id`, or `admin_id` are strictly ignored.

### Role Hierarchy
* **`admin`**: Full administrative access across all domains, including financial ledger adjustments, refunds, payouts, system configurations, and role management.
* **`support_executive`**: Operational access limited to Customer, Booking, Partner/Vehicle viewing, Support Tickets, and Disputes. Restricted from sensitive financial adjustments and admin role escalation.

---

## 6. Database Table Mapping (All 74 Tables)

| Domain | Supabase Tables Utilized |
| :--- | :--- |
| **Authentication & Users** | `users`, `user_devices`, `admin_sessions` |
| **Customers** | `customer_profiles`, `customer_documents`, `customer_identity_verifications`, `customer_saved_addresses` |
| **Partners** | `partners`, `partner_kyc`, `partner_documents`, `partner_verification_history`, `partner_bank_accounts`, `partner_ratings` |
| **Shops** | `shops`, `shop_images`, `shop_documents`, `shop_operating_hours`, `shop_verification_history`, `shop_ratings` |
| **Vehicles** | `vehicles`, `vehicle_categories`, `vehicle_brands`, `vehicle_models`, `vehicle_images`, `vehicle_documents`, `vehicle_features`, `vehicle_feature_values`, `vehicle_availability`, `vehicle_blocked_periods`, `vehicle_pricing`, `vehicle_pricing_rules`, `vehicle_extra_charges`, `vehicle_ratings` |
| **Bookings** | `bookings`, `booking_items`, `booking_price_breakdown`, `booking_status_history`, `booking_customer_details`, `booking_pickup`, `booking_return`, `booking_cancellations` |
| **Payments** | `payments`, `payment_attempts`, `payment_transactions`, `payment_webhooks` |
| **Refunds** | `refunds`, `refund_transactions` |
| **Commissions** | `commission_rules`, `commission_transactions` |
| **Wallets** | `partner_wallets`, `wallet_transactions` |
| **Payouts** | `partner_payouts`, `payout_transactions` |
| **Reviews & Moderation** | `reviews`, `review_replies`, `review_reports` |
| **Coupons & Promotions** | `coupons`, `coupon_rules`, `coupon_redemptions`, `offers`, `offer_vehicles`, `offer_shops` |
| **Support & Disputes** | `support_tickets`, `support_messages`, `support_attachments`, `ticket_status_history`, `disputes`, `dispute_evidence` |
| **Agreements & Notifications** | `rental_agreements`, `notifications`, `notification_templates`, `user_notification_preferences` |
| **Audit & Compliance** | `admin_actions`, `audit_logs` |

---

## 7. Business Logic & Integrity Rules

1. **Vehicle Availability**: `vehicles.is_available` represents *current physical readiness* only. Future reservation availability is determined dynamically from `vehicle_availability`, `vehicle_blocked_periods`, and active `bookings`.
2. **Booking Flow**: Standard bookings do NOT require mandatory partner acceptance. Bookings advance through state transitions governed by server validation.
3. **Financial Immutability**: Historical financial records (`payments`, `refunds`, `commission_transactions`, `wallet_transactions`, `payout_transactions`) are ledger entries and are NEVER deleted or overwritten.
4. **Refund Invariant**: The backend strictly validates: `refunded_amount <= approved_amount <= requested_amount`.
5. **Wallet Ledger**: Partner wallet balances are verified against `wallet_transactions`. Manual adjustments require an explicit reason, direction (`CREDIT`/`DEBIT`), admin identity, and transaction logging.
6. **Data Masking**: Partner bank account numbers are masked (`XXXXXX1234`) on all standard API responses.
7. **Safe Pagination**: All listing endpoints enforce `limit <= 100` and use indexed offsets.

---

## 8. Local Development Instructions

### Prerequisites
* Node.js v18.x or v20.x
* Access to Supabase Project (URL and Service Role Key)

### Installation & Execution
```bash
# Navigate to Admin Backend
cd server/Admin

# Install dependencies
npm install

# Run unit test suite (768 tests)
npm run test:unit

# Provision the initial Super Admin (idempotent; see docs/ADMIN_AUTHENTICATION.md)
npm run db:seed:super-admin

# Start in development mode with nodemon
npm run dev

# Start in production mode
npm start
```

The backend listens on `http://localhost:5000` with dual route prefixes:
* `/api/v1/*` (Recommended standard)
* `/api/*` (Canonical legacy and fallback alias)

---

## 9. Production Deployment Instructions

### Production Checklist
1. **Environment Variables**:
   * Set `NODE_ENV=production`.
   * Set valid `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
   * Configure strong `JWT_SECRET` (at least 32 characters).
   * Restrict `CORS_ORIGIN` to official admin domain(s).
2. **Reverse Proxy (Nginx / Cloudflare)**:
   * Terminate SSL/TLS at reverse proxy.
   * Forward `X-Forwarded-For` and `X-Request-Id` headers.
   * Restrict maximum request payload size to 10MB (`client_max_body_size 10M`).
3. **Process Management**:
   * Run with PM2 in cluster mode or Docker container.
   ```bash
   pm2 start src/index.js --name gongo-admin-api -i max
   ```
4. **Health Check**:
   * Monitor `GET /health` or `GET /api/v1/health` for uptime and database connectivity.
