# GONGO Unified Backend — Initial Architecture Audit

## 1. Executive Summary & Objective

The objective of this project is to integrate three independent Node.js/Express backends:
1. **Customer Backend** (`server/Customer`)
2. **Partner Backend** (`server/Partner`)
3. **Admin Backend** (`server/Admin`)

into a single maintainable, secure, and production-ready **Unified Backend** (`server_unified/`), while strictly preserving:
- Original source files in `server/` (never modified, 100% untouched).
- Protected infrastructure: Database (Supabase PostgreSQL), Storage (Supabase Storage/S3), OTP Authentication (Renflair/Supabase), and Cashfree Payment Gateway.
- All domain calculations, business logic, and security rules.

---

## 2. Directory & Application Audit

### 2.1 Customer Backend (`server_unified/Customer`)
- **Runtime & Framework**: Node.js >=18.0.0, Express ^4.19.2 (CommonJS).
- **Default Port**: 3000.
- **Route Prefix**: `/api/v1` (with `/customer/platform-fee` convenience route).
- **Core Domains**:
  - Authentication & OTP: Renflair SMS Gateway provider + Supabase Auth token verification, Redis session revocation.
  - Profile & Address: Customer profile management, KYC document uploads, multiple addresses.
  - Vehicle Discovery: Public vehicle search, category filtering (bike/car), pricing calculation.
  - Bookings: Booking creation, quote calculation, no-show auto-cancellation worker.
  - Payments: Cashfree Payment Gateway order creation, webhook handling, payment status check.
  - Notifications & Support: FCM (Firebase Cloud Messaging) device registration, support tickets.
- **Dependencies of Note**: `@supabase/supabase-js`, `pg`, `ioredis`, `firebase-admin`, `razorpay` (legacy/fallback), `winston`, `helmet`, `cors`, `envalid`.

### 2.2 Partner Backend (`server_unified/Partner`)
- **Runtime & Framework**: Node.js >=18.0.0, Express ^4.19.2 (CommonJS).
- **Default Port**: 3001.
- **Route Prefix**: `/api/v1` (with direct `/api/auth/otp` routes).
- **Core Domains**:
  - Authentication: Supabase Auth ID token verification, in-memory partner identity cache (`authCache`), development auth bypass (`PARTNER_DEV_AUTH_ENABLED`).
  - Partner Profile & KYC: Shop details, partner verification status, KYC documents (RC, Insurance, PUC, Fitness, DL).
  - Vehicle Management: Vehicle inventory CRUD, pricing, availability toggling.
  - Booking Management: Booking request approval/rejection, booking lifecycle transitions.
  - Earnings, Wallet & Payouts: Bank account encryption (AES-256-GCM), Cashfree Payouts integration, wallet transactions.
  - Outbox Worker: Background event publisher (`outbox.service.js`).
- **Dependencies of Note**: `@supabase/supabase-js`, `pg`, `ioredis`, `winston`, `helmet`, `cors`, `envalid`, `uuid`.

### 2.3 Admin Backend (`server_unified/Admin`)
- **Runtime & Framework**: Node.js >=18.0.0, Express ^4.19.2 (CommonJS).
- **Default Port**: 3002.
- **Route Prefix**: `/api/v1` (mounted under `/admin`, `/public`, `/vehicles`).
- **Core Domains**:
  - Authentication & 2FA: Supabase token verification or explicit 64-char hex Admin Session token (`admin_sessions`), SMS OTP 2FA.
  - Granular RBAC: 5 distinct admin roles/groups (`SUPER_ADMIN`, `OPERATIONS_ADMIN`, `FINANCE_ADMIN`, `SUPPORT_ADMIN`, `VERIFICATION_ADMIN`) and granular domain permissions catalog.
  - Partner & Customer Governance: Partner KYC verification, vehicle document approval/rejection, customer suspensions.
  - Booking & Financial Operations: Booking management, refund approval, platform fee configuration, commission management, disputes.
  - Audit Trail: Immutable administrative audit logging on mutating endpoints (`auditMiddleware`).
  - Outbox Worker: Background event processor (`jobs/outbox.worker.js`).
- **Dependencies of Note**: `@supabase/supabase-js`, `pg`, `ioredis`, `@aws-sdk/client-s3`, `twilio`, `winston`, `helmet`, `cors`, `envalid`.

---

## 3. Authentication & Authorization Analysis

| Component | Customer | Partner | Admin |
| :--- | :--- | :--- | :--- |
| **Auth Mechanism** | Bearer Token verified via Supabase Auth (`verifyIdToken`) | Bearer Token verified via Supabase Auth (`verifyIdToken`) | Bearer Supabase Token OR 64-char hex Admin Session (`x-admin-session` / Bearer) |
| **Identity Lookup** | `public.users` table by `auth_id`, `id`, or verified phone | `public.partners` table by `auth_id` (cached in memory) | `public.users` by `auth_id`, verified role in `ALLOWED_ADMIN_ROLES` |
| **Session Control** | Redis blacklist check (`isUserSessionRevoked`) | Fast cache TTL check (60s) | DB `admin_sessions` check, token hashing (SHA-256) |
| **User Role Field** | `req.user.role = 'customer'` | `req.user.role = 'PARTNER'` | `req.user.role = 'ADMIN'` (or `SUPER_ADMIN`, `SUPPORT_EXECUTIVE`) |
| **Authorization Guard** | `requireRole('customer')` | `requireRole(ROLES.PARTNER)` | `requireRole(ROLES.ADMIN)` + `requirePermission(PERM)` |
| **Resource Ownership** | Scoped via `req.user.id` in DB queries | `verifyOwnership(lookupFn)` middleware checking `req.user.partnerId` | Administrative policy / audit trail logging |

---

## 4. Protected Infrastructure Status

1. **Database (Supabase PostgreSQL)**:
   - Shared canonical database instance across Customer, Partner, and Admin (`users`, `partners`, `vehicles`, `bookings`, `admin_sessions`, etc.).
   - Connection pool configurations (`pg.Pool`) exist in all three services.
   - **Protection Status**: Unchanged. No schema migrations or destructive SQL will be executed.
2. **Storage (Supabase Storage / AWS S3 fallback)**:
   - Buckets: `gongo-uploads`, `gongo-partner-documents`, `gongo-admin-documents`.
   - Presigned upload and download URLs are generated server-side.
   - **Protection Status**: Unchanged. Upload workflows and presigning policies preserved.
3. **OTP Authentication**:
   - Customer: Renflair SMS Gateway provider + Supabase Auth.
   - Partner: Renflair SMS Gateway / Supabase Auth SMS.
   - Admin: SMS OTP 2FA for privileged logins.
   - **Protection Status**: Unchanged. All providers, cooldowns, expiry, and retry limits preserved.
4. **Cashfree Payments**:
   - Customer: Cashfree Payment Gateway order creation and webhook verification.
   - Partner: Cashfree Payouts API and bank transfer integration.
   - Admin: Cashfree payment search, webhook logs, refund processing.
   - **Protection Status**: Unchanged. Order creation, signature verification, and callback handling preserved.

---

## 5. Potential Conflicts & Integration Risks

1. **Port & Startup Conflicts**:
   - Standalone services use ports 3000, 3001, 3002.
   - Running three separate Node.js processes in production leads to container overhead and CORS hurdles.
   - **Solution**: Single unified entry point running on configurable `PORT` (default 8080 or 3000), mounting modules under isolated sub-app namespaces `/customer`, `/partner`, `/admin`.
2. **Environment Variable Naming**:
   - Minor discrepancies in env naming (e.g. `CORS_ORIGIN` vs `CORS_ALLOWED_ORIGINS`, `API_PREFIX` vs `API_VERSION`).
   - **Solution**: A unified `src/config/env.js` that standardizes configuration while maintaining backwards compatibility for existing service configs.
3. **Background Schedulers & Workers**:
   - Customer has `no-show-cancellation.service` scheduler.
   - Partner has `outboxService` worker.
   - Admin has `outbox.worker` worker.
   - **Solution**: Ensure schedulers only start in production/development, can be individually toggled, and shut down cleanly during graceful shutdown.
4. **Route Namespacing**:
   - Frontends expect specific paths:
     - Customer frontend: `<API_URL>/customers/*`, `<API_URL>/vehicles/*`, `<API_URL>/bookings/*`
     - Partner frontend: `<API_URL>/partner/*`, `<API_URL>/auth/*`, `<API_URL>/storage/*`
     - Admin frontend: `<API_URL>/admin/*`, `<API_URL>/public/*`
   - **Solution**:
     - Mount canonical sub-applications at `/customer`, `/partner`, `/admin`.
     - Mount top-level `/api/v1` routes with transparent routing / aliases to prevent breaking mobile apps or web admin during transition.

---

## 6. Target Architecture & Implementation Roadmap

```
server_unified/
├── Admin/               # Original Admin service code
├── Customer/            # Original Customer service code
├── Partner/             # Original Partner service code
├── src/
│   ├── app.js           # Unified Express application assembly
│   ├── server.js        # Unified HTTP server bootstrap & graceful shutdown
│   ├── config/          # Centralized configuration (env, logger, db, redis)
│   ├── shared/
│   │   ├── auth/        # Centralized roles, permissions, RBAC, ownership middleware
│   │   ├── constants/   # Domain constants & error codes
│   │   ├── errors/      # AppError & HTTP error classes
│   │   ├── middleware/  # Request logging, ID, validation
│   │   └── utils/       # Async handler, helpers
│   └── routes/          # Unified route mounting (/customer, /partner, /admin)
├── tests/               # Non-destructive integration & RBAC test suite
├── docs/                # Architecture, RBAC matrix, and API mappings
├── package.json         # Unified dependencies & scripts
├── .env.example         # Consolidated environment template
└── README.md            # Comprehensive documentation
```
