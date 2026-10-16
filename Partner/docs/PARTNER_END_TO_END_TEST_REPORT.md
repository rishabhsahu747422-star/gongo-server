# GONGO Partner Backend — Development Authentication & End-to-End Business Flow Test Report

**Execution Date:** October 1, 2026  
**Environment:** Development (`NODE_ENV=development`)  
**Database Target:** Supabase PostgreSQL 17.6 (AWS Sydney Pooler with SSL)  
**Redis Target:** `127.0.0.1:6379` (Local instance)  
**Test Suite Script:** `npm run test:partner-flow` (`scripts/test_partner_business_flow.js`)  
**Overall Status:** **ALL 34 CORE VERIFICATION CHECKS PASSED (100%)**

---

## 1. Authentication Architecture Audit

This audit documents how partner identity and authorization function across the backend pipeline.

### 1.1 How the Current Supabase JWT is Extracted
In `src/middlewares/auth.js`:
- The incoming HTTP request is inspected for the `Authorization` header.
- The middleware strictly validates that the header follows the `Bearer <token>` scheme.
- If missing or malformed, a `401 Unauthorized` (`MISSING_AUTH_TOKEN` / `INVALID_TOKEN_FORMAT`) is returned immediately.
- The raw token is passed to `src/providers/supabase.js:verifyIdToken(token)`.

### 1.2 How Supabase UID Becomes `users.auth_id`
- When `verifyIdToken(token)` runs:
  - In normal/production mode, it invokes Supabase Auth's `getUser(token)`.
  - The returned user profile contains `user.id`, which corresponds to the Supabase Auth UID.
  - In development mode (when `PARTNER_DEV_AUTH_ENABLED=true`), `dev-partner-token` resolves deterministically to `PARTNER_DEV_AUTH_ID` (`dev-partner-auth-id`).
- Downstream in `src/middlewares/auth.js`:
  - `userRepository.findByAuthId(decodedToken.uid)` executes:
    ```sql
    SELECT id, auth_id, role, is_active FROM users WHERE auth_id = $1 LIMIT 1
    ```
  - This maps the Supabase UID directly to the internal PostgreSQL user record (`users.id`).

### 1.3 How `users.id` Maps to `partners.user_id`
- In `src/middlewares/auth.js`:
  - If `user.role === 'PARTNER'`, the middleware queries the partner entity using `partnerRepository.findByAuthId(decodedToken.uid)` or `partnerRepository.findByUserId(user.id)`:
    ```sql
    SELECT p.id, p.user_id, p.status, p.kyc_status, p.is_active
    FROM partners p
    JOIN users u ON u.id = p.user_id
    WHERE u.auth_id = $1 AND p.deleted_at IS NULL
    LIMIT 1;
    ```
  - This resolves the primary `partners` row linked by `partners.user_id = users.id`.

### 1.4 How `req.user.partnerId` is Populated
- In `src/middlewares/auth.js`, the request user context is constructed:
  ```javascript
  req.user = {
    id: user.id,               // Internal users.id (UUID)
    partnerId: partner.id,     // Internal partners.id (UUID)
    userId: user.id,           // Alias for backward compatibility
    authId: decodedToken.uid,  // Supabase Auth UID
    role: 'PARTNER',           // Normalized canonical uppercase role
    kycStatus: partner.kyc_status,
    partnerStatus: partner.status,
  };
  ```

### 1.5 How Role `PARTNER` is Enforced
- Protected routes use `requireRole('PARTNER')` from `src/middlewares/role.js`:
  ```javascript
  const requireRole = (...roles) => (req, res, next) => {
    if (!req.user || !roles.some(r => r.toUpperCase() === req.user.role?.toUpperCase())) {
      return next(new ForbiddenError('Access forbidden: insufficient role permissions'));
    }
    next();
  };
  ```
- Any non-partner user attempting to access partner routes receives `403 Forbidden` (`INSUFFICIENT_PERMISSIONS`).

### 1.6 Which APIs Depend on `req.user.partnerId` vs `req.user.id`
- **`req.user.id` (`users.id`):** Used strictly for user-account level identity (e.g. `GET /api/v1/auth/me`, user device registration).
- **`req.user.partnerId` (`partners.id`):** Used for **all business entities**:
  - Vehicles (`vehicles.partner_id`)
  - Shops (`shops.partner_id`)
  - Vehicle pricing & pricing history (`vehicle_pricing`, `vehicle_pricing_history`)
  - Vehicle availability blocks (`vehicle_availability_blocks.partner_id`)
  - Partner KYC documents (`partner_documents.partner_id`)
  - Bank accounts (`partner_bank_accounts.partner_id`)
  - Wallets, ledger & payout transactions (`wallets.partner_id`, `payouts.partner_id`)
  - Bookings & Earnings summaries (`bookings.partner_id`, `booking_items`)
  - Notifications (`notifications.partner_id`)

### 1.7 How BOLA (Broken Object Level Authorization) is Enforced
- Partner endpoints **never** trust client-supplied `partnerId` in path params, queries, or JSON bodies.
- Every repository query or update that accesses a child resource includes `WHERE partner_id = $2`:
  - `vehicleRepository.findByIdAndPartnerId(id, partnerId)`
  - `partnerDocumentRepository.findByIdAndPartnerId(id, partnerId)`
  - `bankAccountRepository.findByIdAndPartnerId(id, partnerId)`
  - `availabilityRepository.findBlocksByVehicleId(id, partnerId)`
- When Partner A attempts to read or mutate a resource owned by Partner B, the query returns 0 rows, throwing a standard `404 Not Found` (`Vehicle not found or does not belong to partner`), preventing resource enumeration and IDOR attacks.

---

## 2. Development Authentication Design & Security Guarantees

Because the Supabase/Twilio SMS trial was exhausted, a deterministic development authentication mechanism was created to allow full business flow and frontend testing without modifying or weakening production authentication.

### 2.1 Security Guarantees
1. **Production Fail-Fast Guard:**
   - In `src/config/env.js`, a strict fail-fast check prevents initialization if dev auth is enabled in production:
     ```javascript
     if (env.NODE_ENV === 'production' && env.PARTNER_DEV_AUTH_ENABLED) {
       throw new Error('FATAL SECURITY VIOLATION: PARTNER_DEV_AUTH_ENABLED cannot be active in production!');
     }
     ```
2. **Zero Authorization Bypass:**
   - No mock middleware or bypass routes exist.
   - Every request with `Bearer dev-partner-token` goes through the standard `authenticate` and `requireRole('PARTNER')` middleware chain.
   - It performs real database lookups against `users` and `partners` tables in Supabase.
3. **Identity Parity:**
   - Populates `req.user` with identical fields (`id`, `partnerId`, `userId`, `authId`, `role='PARTNER'`).
4. **Deterministic Dev Test Identities:**
   - **Partner A:** Auth ID `dev-partner-auth-id`, Partner ID `dc3a5acd-8d03-45c0-8cb9-23d1b3ffd562`, Phone `+919999999999`
   - **Partner B:** Auth ID `dev-partner-b-auth-id`, Partner ID `4b696412-7f55-4f61-8a38-16f143a7c0e2`, Phone `+918888888888`
   - Seeded with valid Shop, Wallet, Bank Account, and Baseline Vehicle records via `npm run seed:partner-dev`.

---

## 3. End-to-End Business Flow Verification Matrix

All 34 steps were executed live against the Supabase PostgreSQL database via `npm run test:partner-flow`.

| # | Category | HTTP Method & Path | Operation / Purpose | Result | Verification Notes |
|---|---|---|---|:---:|---|
| 1 | Health | `GET /health/live` | Liveness probe check | **PASS** | Status 200, process alive |
| 2 | Health | `GET /health/ready` | Readiness probe (DB & Redis) | **PASS** | Status 200, PostgreSQL & Redis UP |
| 3 | Health | `GET /api/v1/health` | API v1 status probe | **PASS** | Status 200, API healthy |
| 4 | Dev Auth | `POST /api/v1/auth/dev-login` | Passwordless development login | **PASS** | Status 200, returns token & session |
| 5 | Session | `POST /api/v1/auth/session` | Session resolution via Bearer token | **PASS** | Status 200, Partner ID resolved |
| 6 | Identity | `GET /api/v1/auth/me` | Role & Identity enforcement | **PASS** | Role: `PARTNER`, Name: `GONGO Test Partner` |
| 7 | Profile | `GET /api/v1/partner/profile` | Partner profile retrieval | **PASS** | Status: `ONLINE`, KYC: `VERIFIED` |
| 8 | Shop | `GET /api/v1/partner/shop` | Shop configuration retrieval | **PASS** | Shop: `GONGO Koramangala Hub`, Bangalore |
| 9 | Shop | `PATCH /api/v1/partner/shop` | Shop operating info update | **PASS** | Updated: `08:00 AM - 10:00 PM (Daily)` |
| 10 | Vehicle | `POST /api/v1/partner/vehicles` | Create vehicle with inline pricing | **PASS** | Status 201, Reg: `KA04DEV...`, Pricing persisted |
| 11 | Vehicle | `GET /api/v1/partner/vehicles/:id` | Read single vehicle details | **PASS** | Status 200, Model & category returned |
| 12 | Vehicle | `PATCH /api/v1/partner/vehicles/:id` | Update vehicle description & location | **PASS** | Status 200, updated location applied |
| 13 | Pricing | `PUT /api/v1/partner/vehicles/:id/pricing` | Upsert vehicle rental pricing | **PASS** | Status 200, Daily rate ₹950, deposit ₹2000 |
| 14 | Pricing | `GET /api/v1/partner/vehicles/:id/pricing` | Retrieve active vehicle pricing | **PASS** | Status 200, Hourly ₹63.33, Daily ₹950 |
| 15 | Availability | `POST /api/v1/partner/vehicles/:id/availability` | Block vehicle for maintenance window | **PASS** | Status 201, Block ID generated |
| 16 | Availability | `GET /api/v1/partner/vehicles/:id/availability` | List availability blocks | **PASS** | Status 200, 1 active block listed |
| 17 | Availability | `DELETE /api/v1/partner/vehicles/:id/availability/:blockId` | Release / soft-delete block | **PASS** | Status 200, block released |
| 18 | KYC | `GET /api/v1/partner/kyc` | Partner KYC overview | **PASS** | Status: `VERIFIED`, docs listed |
| 19 | KYC | `POST /api/v1/partner/kyc/documents` | Submit KYC document metadata | **PASS** | Status 201, Type: `GST`, Status: `PENDING` |
| 20 | KYC | `GET /api/v1/partner/kyc/documents/:id` | Get single KYC document metadata | **PASS** | Status 200, Type: `GST`, Status: `PENDING` |
| 21 | Bank Accounts | `GET /api/v1/partner/bank-account` | List partner bank accounts | **PASS** | Status 200, Primary bank returned |
| 22 | Bank Accounts | `POST /api/v1/partner/bank-account` | Add secondary bank account | **PASS** | Status 201, Masked `•••• •••• 1098` |
| 23 | Bank Accounts | `DELETE /api/v1/partner/bank-account/:bankAccountId` | Delete secondary bank account | **PASS** | Status 200, secondary account deleted |
| 24 | Notifications | `GET /api/v1/partner/notifications` | List partner notifications | **PASS** | Status 200 |
| 25 | Notifications | `POST /api/v1/partner/notifications/mark-all-read` | Mark all notifications read | **PASS** | Status 200 |
| 26 | Wallet | `GET /api/v1/partner/wallet` | Wallet balance & summary | **PASS** | Status 200, Available: ₹5000 |
| 27 | Wallet | `GET /api/v1/partner/wallet/transactions` | Ledger transaction list | **PASS** | Status 200, transactions list |
| 28 | Earnings | `GET /api/v1/partner/earnings/summary` | Financial earnings breakdown | **PASS** | Status 200, Gross & Net earnings |
| 29 | Earnings | `GET /api/v1/partner/earnings` | Paginated earnings list | **PASS** | Status 200 |
| 30 | Bookings | `GET /api/v1/partner/bookings` | Partner bookings list | **PASS** | Status 200 |
| 31 | BOLA Check | `GET /api/v1/partner/vehicles/:otherVehicleId` | Partner A reading Partner B vehicle | **PASS** | Status 404 (Correctly denied) |
| 32 | BOLA Check | `PUT /api/v1/partner/vehicles/:otherVehicleId/pricing` | Partner A mutating Partner B pricing | **PASS** | Status 404 (Correctly denied) |
| 33 | BOLA Check | `GET /api/v1/partner/vehicles/:otherVehicleId/availability` | Partner A querying Partner B availability | **PASS** | Status 404 (Correctly denied) |
| 34 | Storage | `POST /api/v1/storage/presign` | Storage presigned upload URL | **PASS** | Status 201, Supabase upload URL generated |

---

## 4. Automated Regression & Quality Status

All test suites across the repository run and pass cleanly:

- **Business Flow Verification Suite (`npm run test:partner-flow`):** 34/34 passed (100%)
- **Full Test Suite (`npm test`):** 75/75 suites passed, 759/759 tests passed (100%)
- **Unit Test Suite (`npm run test:unit`):** 45/45 suites passed, 411/411 tests passed (100%)
- **Integration Test Suite (`npm run test:integration`):** 29/29 suites passed, 313/313 tests passed (100%)
- **Security Regression Suite (`npm run test:security`):** 1/1 suite passed, 35/35 tests passed (100%)
- **Code Linter (`npm run lint`):** Clean (0 errors, 0 warnings)

---

## 5. Frontend Developer Guide: Testing Without SMS OTP

Frontend engineers developing the GONGO Partner App can test the complete application without SMS OTP.

### Option A: `POST /api/v1/auth/dev-login` (Recommended for Login Screens)
Use this endpoint on development environments:

```http
POST /api/v1/auth/dev-login HTTP/1.1
Host: localhost:3001
Content-Type: application/json

{
  "authId": "dev-partner-auth-id",
  "phone": "+919999999999"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "token": "dev-partner-token",
    "isRegistered": true,
    "user": {
      "id": "18f3b259-db31-4172-ba00-be87e6d081f2",
      "authId": "dev-partner-auth-id",
      "role": "PARTNER"
    },
    "partner": {
      "id": "dc3a5acd-8d03-45c0-8cb9-23d1b3ffd562",
      "businessName": "GONGO Partner Fleet 1",
      "status": "ONLINE",
      "kycStatus": "VERIFIED"
    },
    "session": {
      "sessionId": "dc3a5acd-8d03-45c0-8cb9-23d1b3ffd562",
      "partnerId": "dc3a5acd-8d03-45c0-8cb9-23d1b3ffd562",
      "role": "PARTNER"
    }
  }
}
```

### Option B: Direct Bearer Token in Requests
To make authenticated API calls directly from Postman, curl, or automated UI tests:

```http
GET /api/v1/partner/profile HTTP/1.1
Host: localhost:3001
Authorization: Bearer dev-partner-token
```

Or for testing cross-partner isolation with Partner B:
```http
GET /api/v1/partner/vehicles HTTP/1.1
Host: localhost:3001
Authorization: Bearer dev-token-dev-partner-b-auth-id
```

### Option C: Re-Seeding the Test Database
To reset the development test partners, shops, and baseline vehicles:
```bash
npm run seed:partner-dev
```
