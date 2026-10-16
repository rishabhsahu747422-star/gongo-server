# GONGO Admin Backend — API Reference Manual

This document provides the complete API specification for the **GONGO Admin Backend** (`server/Admin`), detailing every endpoint, authentication requirement, RBAC roles, request/response formats, database tables used, validations, error cases, and audit logging requirements.

---

## 1. Global Standards

### Base URLs & Routing
* **API Version 1**: `/api/v1` (e.g. `/api/v1/admin/bookings`)
* **Canonical Fallback**: `/api` (e.g. `/api/admin/bookings`)
* Both prefixes are fully supported and routed identically.

### Headers
| Header | Required | Description |
| :--- | :--- | :--- |
| `Authorization` | Yes (except public login) | `Bearer <token>` (Supabase Auth access token or Admin Session token) |
| `Content-Type` | For POST/PATCH | `application/json` |
| `X-Request-Id` | Optional | Client correlation ID for distributed trace logs |

### Response Envelopes

**Success (HTTP 200 / 201):**
```json
{
  "success": true,
  "data": {},
  "message": "Operation successful"
}
```

**Paginated Success (HTTP 200):**
```json
{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

**Error (HTTP 4xx / 5xx):**
```json
{
  "success": false,
  "message": "Validation failed",
  "error": {
    "code": "VALIDATION_ERROR",
    "details": [
      { "field": "amount", "message": "Amount must be a positive number" }
    ]
  }
}
```

---

## 2. Authentication & Session Management

### 2.1 Authenticate Supabase Token
* **Endpoint**: `POST /api/v1/admin/auth/login`
* **Auth**: Public / Bearer
* **Required Role**: N/A
* **Tables Used**: `users`, `customer_profiles`, `admin_sessions`, `admin_actions`, `audit_logs`
* **Request Body**:
  ```json
  {
    "idToken": "supabase_jwt_access_token_string"
  }
  ```
* **Validation**: `idToken` must be non-empty string. Token is verified using Supabase Auth. Resolved UID must map to `users.auth_id` or `users.id`. User must have `status = 'active'` and `role IN ('admin', 'support_executive')`.
* **Error Cases**: `401 Unauthorized` (invalid token/user not found), `403 Forbidden` (non-admin role or deactivated account).
* **Audit**: Logs `ADMIN_LOGIN` to `admin_actions` and `audit_logs`.

### 2.2 Send Mobile 2FA OTP
* **Endpoint**: `POST /api/v1/admin/auth/mobile-login/send-otp`
* **Auth**: Public
* **Required Role**: N/A
* **Request Body**:
  ```json
  {
    "phone": "+919876543210"
  }
  ```
* **Validation**: Valid E.164 phone format.
* **Response (200)**: `{ "success": true, "data": { "sessionId": "otp-sess-uuid", "expiresIn": 300 } }`

### 2.3 Verify Mobile 2FA OTP
* **Endpoint**: `POST /api/v1/admin/auth/mobile-login/verify-otp`
* **Auth**: Public
* **Request Body**:
  ```json
  {
    "sessionId": "otp-sess-uuid",
    "otp": "123456",
    "phone": "+919876543210"
  }
  ```
* **Validation**: 6-digit OTP matching Redis/Supabase Auth state.
* **Audit**: Logs `ADMIN_LOGIN_OTP_VERIFIED`.

### 2.4 Get Current Admin Profile
* **Endpoint**: `GET /api/v1/admin/auth/me`
* **Auth**: Bearer Token
* **Required Role**: `admin`, `support_executive`
* **Tables Used**: `users`, `customer_profiles`
* **Response (200)**:
  ```json
  {
    "success": true,
    "data": {
      "id": "uuid",
      "name": "Admin User",
      "email": "admin@gongo.com",
      "phone": "+919876543210",
      "role": "admin",
      "permissions": ["SUPER_ADMIN"]
    }
  }
  ```

---

## 3. Admin User Management

### 3.1 List Admin Users
* **Endpoint**: `GET /api/v1/admin/users`
* **Auth**: Bearer Token
* **Required Role**: `admin`
* **Tables Used**: `users`
* **Query Parameters**: `page`, `limit` (max 100), `role`, `status`, `search`
* **Response (200)**: Paginated list of administrative users.

### 3.2 Update Admin User Status
* **Endpoint**: `PATCH /api/v1/admin/users/:id/status`
* **Auth**: Bearer Token
* **Required Role**: `admin`
* **Tables Used**: `users`, `admin_actions`, `audit_logs`
* **Request Body**:
  ```json
  {
    "status": "active",
    "reason": "Account reinstated by super admin"
  }
  ```
* **Validation**: Status must be `active`, `inactive`, or `suspended`.
* **Audit**: Creates `admin_actions` with `targetResource = 'USER'` and logs before/after state to `audit_logs`.

### 3.3 Update Admin User Role
* **Endpoint**: `PATCH /api/v1/admin/users/:id/role`
* **Auth**: Bearer Token
* **Required Role**: `admin`
* **Tables Used**: `users`, `admin_actions`, `audit_logs`
* **Request Body**:
  ```json
  {
    "role": "support_executive",
    "reason": "Department transfer"
  }
  ```
* **Validation**: Role must be `admin` or `support_executive`. Prevents self-demotion if the admin is the last super admin.
* **Audit**: Recorded in `admin_actions` and `audit_logs`.

---

## 4. Admin Dashboard Metrics

### 4.1 Get Unified Dashboard Overview
* **Endpoint**: `GET /api/v1/admin/dashboard`
* **Auth**: Bearer Token
* **Required Role**: `admin`, `support_executive`
* **Tables Used**: Aggregates across `users`, `partners`, `shops`, `vehicles`, `bookings`, `payments`, `refunds`, `partner_wallets`, `partner_payouts`, `support_tickets`, `disputes`, `commission_transactions`.
* **Query Parameters**: `startDate`, `endDate`, `preset` (`today`, `7d`, `30d`, `this_month`)
* **Response (200)**:
  ```json
  {
    "success": true,
    "data": {
      "customers": { "total": 1200, "active": 1150, "newInRange": 45 },
      "partners": { "total": 150, "active": 140, "verified": 135, "pendingKyc": 10 },
      "shops": { "total": 200, "active": 190, "verified": 185 },
      "vehicles": { "total": 850, "active": 800, "idle": 400, "booked": 350 },
      "bookings": { "total": 4500, "upcoming": 120, "active": 350, "completed": 3800, "cancelled": 230 },
      "payments": { "totalPayments": 4800, "successPayments": 4500, "grossVolume": 12500000 },
      "refunds": { "totalRefunds": 120, "processedVolume": 150000 },
      "revenue": { "grossVolume": 12500000, "netRevenue": 1875000 },
      "commission": { "totalCommission": 1875000, "settledCommission": 1600000 },
      "wallets": { "totalBalance": 5400000, "activeWallets": 145 },
      "payouts": { "completedVolume": 4200000, "pendingVolume": 350000 },
      "support": { "openTickets": 18, "resolvedTickets": 450 },
      "disputes": { "openDisputes": 4, "resolvedDisputes": 82 }
    }
  }
  ```

---

## 5. Customer Management

### 5.1 List Customers
* **Endpoint**: `GET /api/v1/admin/customers`
* **Auth**: Bearer Token
* **Required Role**: `admin`, `support_executive`
* **Tables Used**: `users`, `customer_profiles`
* **Query Parameters**: `page`, `limit` (max 50), `search`, `isActive`, `startDate`, `endDate`, `sortBy`, `sortOrder`
* **Response (200)**: Paginated list of customer accounts.

### 5.2 Get Customer Detail View
* **Endpoint**: `GET /api/v1/admin/customers/:id`
* **Auth**: Bearer Token
* **Required Role**: `admin`, `support_executive`
* **Tables Used**: `users`, `customer_profiles`, `customer_documents`, `customer_identity_verifications`, `customer_saved_addresses`, `bookings`, `payments`, `support_tickets`, `user_devices`
* **Response (200)**: Returns structured sections: `basicProfile`, `documents`, `identityVerification`, `bookings`, `payments`, `support`, and `activity`.

### 5.3 Update Customer Status
* **Endpoint**: `PATCH /api/v1/admin/customers/:id/status`
* **Auth**: Bearer Token
* **Required Role**: `admin`
* **Tables Used**: `users`, `bookings`, `admin_actions`, `audit_logs`
* **Request Body**:
  ```json
  {
    "isActive": false,
    "reason": "Policy violation",
    "force": false
  }
  ```
* **Validation**: If deactivating, checks for active bookings; requires `force: true` to bypass.
* **Audit**: Recorded in `admin_actions` and `audit_logs`.

---

## 6. Partner Management

### 6.1 List Partners
* **Endpoint**: `GET /api/v1/admin/partners`
* **Auth**: Bearer Token
* **Required Role**: `admin`, `support_executive`
* **Tables Used**: `partners`, `partner_kyc`
* **Query Parameters**: `page`, `limit` (max 50), `search`, `status`, `verification_status`, `kyc_status`, `city`

### 6.2 Get Partner Details & Sub-Resources
* `GET /api/v1/admin/partners/:id` (Full profile, shop summary, vehicle summary)
* `GET /api/v1/admin/partners/:id/kyc` (`partner_kyc`)
* `GET /api/v1/admin/partners/:id/documents` (`partner_documents`)
* `GET /api/v1/admin/partners/:id/bank-accounts` (`partner_bank_accounts` - masked numbers)
* `GET /api/v1/admin/partners/:id/verification-history` (`partner_verification_history`)

### 6.3 Partner Verification & Status Lifecycle
* **Verify**: `PATCH /api/v1/admin/partners/:id/verify`
* **Reject**: `PATCH /api/v1/admin/partners/:id/reject` (Body: `{ "reason": "Invalid GST certificate" }`)
* **Suspend**: `PATCH /api/v1/admin/partners/:id/suspend` (Body: `{ "reason": "..." }`)
* **Reactivate**: `PATCH /api/v1/admin/partners/:id/reactivate`
* **Tables Used**: `partners`, `partner_verification_history`, `admin_actions`, `audit_logs`
* **Transaction & Audit**: All transitions execute atomically in a transaction and log `partner_verification_history`, `admin_actions`, and `audit_logs`.

---

## 7. Shop Management

### 7.1 Shop Listings & Details
* `GET /api/v1/admin/shops` (Filters: `search`, `partnerId`, `verificationStatus`, `isActive`)
* `GET /api/v1/admin/shops/:id` (`shops`, `partners`)
* `GET /api/v1/admin/shops/:id/documents` (`shop_documents`)
* `GET /api/v1/admin/shops/:id/images` (`shop_images`)
* `GET /api/v1/admin/shops/:id/operating-hours` (`shop_operating_hours`)

### 7.2 Shop Verification Actions
* `PATCH /api/v1/admin/shops/:id/verify`
* `PATCH /api/v1/admin/shops/:id/reject`
* `PATCH /api/v1/admin/shops/:id/suspend`
* `PATCH /api/v1/admin/shops/:id/reactivate`
* **Tables Used**: `shops`, `shop_verification_history`, `admin_actions`, `audit_logs`.

---

## 8. Vehicle Catalog & Verification

### 8.1 Vehicle Listings & Details
* `GET /api/v1/admin/vehicles` (Filters: `search`, `partnerId`, `shopId`, `categoryId`, `brandId`, `verificationStatus`, `isAvailable`)
* `GET /api/v1/admin/vehicles/:id`
* `GET /api/v1/admin/vehicles/:id/documents` (`vehicle_documents`)
* `GET /api/v1/admin/vehicles/:id/images` (`vehicle_images`)
* `GET /api/v1/admin/vehicles/:id/pricing` (`vehicle_pricing`, `vehicle_pricing_rules`, `vehicle_extra_charges`)
* `GET /api/v1/admin/vehicles/:id/availability` (`vehicle_availability`, `vehicle_blocked_periods`)

### 8.2 Vehicle Lifecycle Controls
* `PATCH /api/v1/admin/vehicles/:id/verify`
* `PATCH /api/v1/admin/vehicles/:id/reject` (Body: `{ "reason": "Insurance expired" }`)
* `PATCH /api/v1/admin/vehicles/:id/block` (Body: `{ "startDate": "...", "endDate": "...", "reason": "Maintenance" }`)
* `PATCH /api/v1/admin/vehicles/:id/activate`
* `PATCH /api/v1/admin/vehicles/:id/deactivate`
* **Rules**: `vehicles.is_available` reflects current physical state. Future availability is verified against `bookings` and `vehicle_blocked_periods`.
* **Audit**: All actions recorded in `admin_actions` and `audit_logs`.

---

## 9. Booking Management

### 9.1 List & Inspect Bookings
* `GET /api/v1/admin/bookings` (Filters: `status`, `partner_id`, `customer_id`, `vehicle_id`, `date_from`, `date_to`)
* `GET /api/v1/admin/bookings/:id` (Composite view with Customer, Partner, Shop, Vehicle, Pricing, Payment, Agreement)
* `GET /api/v1/admin/bookings/:id/status-history` (`booking_status_history`)
* `GET /api/v1/admin/bookings/:id/customer` (`booking_customer_details`)
* `GET /api/v1/admin/bookings/:id/pickup` (`booking_pickup`)
* `GET /api/v1/admin/bookings/:id/return` (`booking_return`)
* `GET /api/v1/admin/bookings/:id/payment` (`payments`, `booking_price_breakdown`)
* `GET /api/v1/admin/bookings/:id/agreement` (`rental_agreements`)

### 9.2 Transition Booking Status
* **Endpoint**: `PATCH /api/v1/admin/bookings/:id/status`
* **Auth**: Bearer Token
* **Required Role**: `admin`, `support_executive`
* **Tables Used**: `bookings`, `booking_status_history`, `admin_actions`, `audit_logs`
* **Request Body**:
  ```json
  {
    "status": "COMPLETED",
    "reason": "Vehicle returned safely and inspected"
  }
  ```
* **Audit**: State change recorded in `booking_status_history`, `admin_actions`, and `audit_logs`.

---

## 10. Payment & Refund Management

### 10.1 Payments
* `GET /api/v1/admin/payments` (Filters: `status`, `gateway`, `date_from`, `date_to`)
* `GET /api/v1/admin/payments/:id`
* `GET /api/v1/admin/payments/:id/attempts` (`payment_attempts`)
* `GET /api/v1/admin/payments/:id/transactions` (`payment_transactions`)
* `GET /api/v1/admin/payments/:id/webhooks` (`payment_webhooks` - restricted to `admin`)

### 10.2 Refunds
* `GET /api/v1/admin/refunds`
* `GET /api/v1/admin/refunds/:id`
* `POST /api/v1/admin/refunds/:id/approve`
* `POST /api/v1/admin/refunds/:id/reject`
* `POST /api/v1/admin/refunds/:id/process`
* **Invariant Rule**: `refunded_amount <= approved_amount <= requested_amount`. Frontend cannot supply arbitrary refund sums; validated against payment ledger.
* **Audit**: Financial transactions require `admin` authorization and create `refund_transactions`, `admin_actions`, and `audit_logs`.

---

## 11. Commission Management

### 11.1 Commission Rules
* `GET /api/v1/admin/commission-rules`
* `POST /api/v1/admin/commission-rules`
* `GET /api/v1/admin/commission-rules/:id`
* `PATCH /api/v1/admin/commission-rules/:id`
* `DELETE /api/v1/admin/commission-rules/:id`
* **Hierarchy**: Vehicle specific -> Partner specific -> Category specific -> Default.
* **Immutability**: Changing a rule does NOT alter past `commission_transactions`.

### 11.2 Commission Transactions
* `GET /api/v1/admin/commission-transactions`
* `GET /api/v1/admin/commission-transactions/:id`

---

## 12. Partner Wallets & Payouts

### 12.1 Wallets
* `GET /api/v1/admin/wallets`
* `GET /api/v1/admin/wallets/:id`
* `GET /api/v1/admin/wallets/:id/transactions` (`wallet_transactions` ledger)
* `POST /api/v1/admin/wallets/:id/adjust`:
  * **Required Body**: `{ "amount": 500, "direction": "CREDIT", "reason": "Compensation for toll dispute" }`
  * **Tables Used**: `partner_wallets`, `wallet_transactions`, `admin_actions`, `audit_logs`

### 12.2 Payouts
* `GET /api/v1/admin/payouts`
* `GET /api/v1/admin/payouts/:id`
* `GET /api/v1/admin/payouts/:id/transactions`
* **Data Masking**: Bank account numbers return masked (`XXXXXX1234`).

---

## 13. Reviews, Coupons, Offers

### 13.1 Reviews & Moderation
* `GET /api/v1/admin/reviews`
* `PATCH /api/v1/admin/reviews/:id/status` (`status: "hidden"|"published"`)
* `GET /api/v1/admin/review-reports`
* `PATCH /api/v1/admin/review-reports/:id/resolve`

### 13.2 Coupons
* `GET /api/v1/admin/coupons`, `POST /api/v1/admin/coupons`
* `GET /api/v1/admin/coupons/:id`, `PATCH /api/v1/admin/coupons/:id`, `DELETE /api/v1/admin/coupons/:id`
* `GET /api/v1/admin/coupons/:id/redemptions` (`coupon_redemptions`)
* **Validation**: `valid_from < valid_until`, discount values, and usage limits.

### 13.3 Offers
* `GET /api/v1/admin/offers`, `POST /api/v1/admin/offers`
* `GET /api/v1/admin/offers/:id`, `PATCH /api/v1/admin/offers/:id`, `DELETE /api/v1/admin/offers/:id`
* `POST /api/v1/admin/offers/:id/vehicles`, `DELETE /api/v1/admin/offers/:id/vehicles/:vehicleId`
* `POST /api/v1/admin/offers/:id/shops`, `DELETE /api/v1/admin/offers/:id/shops/:shopId`

---

## 14. Support Tickets & Disputes

### 14.1 Support Tickets
* `GET /api/v1/admin/support/tickets`
* `GET /api/v1/admin/support/tickets/:id` (Includes `support_messages`, `support_attachments`)
* `POST /api/v1/admin/support/tickets/:id/messages` (Body: `{ "message": "...", "is_internal": true }`)
* `PATCH /api/v1/admin/support/tickets/:id/status` (Transitions write `ticket_status_history`)
* `PATCH /api/v1/admin/support/tickets/:id/assign` (Body: `{ "assigned_to": "admin_uuid" }`)

### 14.2 Disputes
* `GET /api/v1/admin/disputes`
* `GET /api/v1/admin/disputes/:id`
* `GET /api/v1/admin/disputes/:id/evidence` (`dispute_evidence`)
* `PATCH /api/v1/admin/disputes/:id/assign`
* `PATCH /api/v1/admin/disputes/:id/status`
* `POST /api/v1/admin/disputes/:id/resolve` (Body: `{ "resolution": "..." }`)
* `POST /api/v1/admin/disputes/:id/reject` (Body: `{ "reason": "..." }`)

---

## 15. Rental Agreements & Notifications

### 15.1 Rental Agreements
* `GET /api/v1/admin/agreements`
* `GET /api/v1/admin/agreements/:id`
* `GET /api/v1/admin/bookings/:bookingId/agreement`
* **Rule**: Agreements represent immutable historical snapshots. Terms or prices are never regenerated dynamically.

### 15.2 Notifications
* `GET /api/v1/admin/notifications`
* `GET /api/v1/admin/notification-templates`
* `POST /api/v1/admin/notification-templates`
* `PATCH /api/v1/admin/notification-templates/:id`

---

## 16. Audit Logging & Compliance

### Audit Information Schema (`admin_actions` & `audit_logs`)
Every state change or sensitive administrative read records:
* `actor_id` / `actor_role`: Resolved server-side from session (never client-supplied).
* `action`: Action verb (e.g. `PARTNER_VERIFY`, `WALLET_ADJUST`, `REFUND_PROCESS`).
* `target_resource` / `target_resource_id`: Entity type and UUID.
* `before_state`: Snapshot before mutation.
* `after_state`: Snapshot after mutation.
* `reason`: Justification provided by administrator.
* `ip_address` & `user_agent`: Extracted from HTTP request.
* `created_at`: Server timestamp.

---

## 17. Platform Fee APIs (`platform_fee_settings`)

### 17.1 Get Active Platform Fee
* **Endpoint**: `GET /api/v1/admin/platform-fee` (alias: `GET /admin/platform-fee`)
* **Auth**: Required (`Authorization: Bearer <admin-token>`)
* **RBAC Permissions**: `SUPER_ADMIN`, `settings.read`, `commissions.read`, or `platform_fee.read`
* **Response (HTTP 200)**:
```json
{
  "success": true,
  "data": {
    "id": "f3b25efa-1d9f-43e3-9484-b87ce762b6e5",
    "feeType": "fixed",
    "feeValue": 50.00,
    "currency": "INR",
    "isActive": true,
    "createdAt": "2026-10-08T18:27:11.197Z",
    "updatedAt": "2026-10-08T18:27:11.197Z"
  }
}
```
* **Error Cases**:
  * `401 Unauthorized`: Missing or invalid credentials.
  * `403 Forbidden`: Insufficient admin permissions.
  * `404 Not Found`: No active platform fee configuration found.

### 17.2 Update Platform Fee
* **Endpoint**: `PUT /api/v1/admin/platform-fee` (alias: `PUT /admin/platform-fee`)
* **Auth**: Required (`Authorization: Bearer <admin-token>`)
* **RBAC Permissions**: `SUPER_ADMIN`, `settings.update`, `commissions.update`, or `platform_fee.update`
* **Rate Limit**: Sensitive operation limiter (10 req/min)
* **Request Body (Fixed Fee)**:
```json
{
  "feeType": "fixed",
  "feeValue": 50,
  "currency": "INR"
}
```
* **Request Body (Percentage Fee)**:
```json
{
  "feeType": "percentage",
  "feeValue": 5,
  "currency": "INR"
}
```
* **Validation Rules**:
  * `feeType`: Required string. Allowed values: `'fixed'` or `'percentage'`.
  * `feeValue`: Required finite number. Must be `>= 0`. If `feeType` is `'percentage'`, must be `<= 100`.
  * `currency`: Optional string. Defaults to `'INR'`. Only `'INR'` is supported.
* **Audit Logging**: Emits `PLATFORM_FEE_UPDATE` on target `PLATFORM_FEE` recording previous/current states and updating `created_by`.
* **Response (HTTP 200)**:
```json
{
  "success": true,
  "data": {
    "id": "f3b25efa-1d9f-43e3-9484-b87ce762b6e5",
    "feeType": "percentage",
    "feeValue": 5.00,
    "currency": "INR",
    "isActive": true,
    "createdAt": "2026-10-08T18:27:11.197Z",
    "updatedAt": "2026-10-09T00:00:00.000Z"
  }
}
```
* **Validation Error Cases**:
  * `400 Bad Request`: Invalid/missing `feeType`, negative `feeValue`, percentage `> 100`, or unsupported currency.

