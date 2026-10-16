# GONGO Admin Backend — API Architecture, Reuse Analysis & Implementation Specification

## Document Status

**Status:** Ready for Admin Backend implementation  
**Scope:** GONGO Admin Backend only  
**Frontend source analyzed:** Uploaded `Admin` frontend project  
**Existing backends considered:** GONGO Customer Backend + GONGO Partner Backend  
**Database:** Shared PostgreSQL / Supabase ecosystem  
**Base API namespace:** `/api/v1/admin`

> **Important:** The Admin Backend does not currently exist. This document is the implementation contract/blueprint for creating it. It does not assume that an Admin API already exists.

---

# 1. Executive Decision

The Admin Panel should **not** directly call Partner APIs or Customer APIs for administrative operations.

The correct architecture is:

```text
Admin React Frontend
        |
        | Firebase/Admin authentication
        v
GONGO Admin Backend
        |
        +--> Admin Controllers
        |
        +--> Admin Services
        |
        +--> Existing Customer/Partner domain repositories/services
        |
        v
Shared PostgreSQL
```

### What can be reused

The existing Customer and Partner backends already contain valuable domain logic for:

- users
- partners
- shops
- vehicles
- bookings
- payments
- wallet/ledger
- payouts
- support
- notifications
- storage
- reconciliation
- validation
- audit-related infrastructure

**Reuse these domain/repository/service capabilities where safe.**

### What should NOT be reused directly

Do not make the Admin frontend call endpoints such as:

```text
/partner/...
/customer/...
```

for privileged admin operations.

Reason:

- Partner APIs are partner-scoped.
- Customer APIs are customer-scoped.
- Admin needs cross-user/cross-partner visibility.
- Admin needs role/permission checks.
- Admin needs administrative actions such as approve/reject/suspend/refund/resolve.
- Admin operations must generate admin audit records.

Therefore:

> **Reuse business logic and database repositories where possible; expose a dedicated `/api/v1/admin/...` API surface for the Admin frontend.**

---

# 2. Existing System Baseline

The supplied platform/database reference defines a shared PostgreSQL ecosystem containing entities such as:

- users
- partners
- partner KYC/documents
- partner bank accounts
- shops
- shop documents/images
- vehicles
- vehicle documents/images/pricing
- bookings
- booking pricing/status/pickup/return
- payments
- refunds
- wallets
- wallet transactions
- commission rules/transactions
- partner payouts
- reviews
- coupons/offers
- notifications
- support tickets/messages/attachments
- disputes/evidence
- admin actions
- audit logs

The existing Partner Backend has already been reported as production-hardened with:

- 79 documented Partner endpoints
- Firebase authentication
- PostgreSQL
- Redis
- S3 storage
- wallet/ledger controls
- payout controls
- reconciliation
- outbox processing
- support tickets
- BOLA protection
- admin financial endpoints
- ADMIN role protection
- 75 test suites / 759 tests passing at the reported Phase 19 baseline

The Admin Backend should build on this domain model rather than creating a disconnected database.

---

# 3. Admin Frontend Audit

The uploaded Admin frontend contains these major areas:

```text
Auth
Dashboard
Customers
Partners
Shops
Vehicles
Verification
Bookings
Finance
Marketplace
System
```

The frontend currently contains mock/demo data in several screens.

Examples found during the audit include:

- Customers
- Partners
- Shops
- Bookings
- Vehicles
- Payments
- Commission
- Refunds
- Offers
- Reviews
- Support
- Disputes
- Audit Logs
- Admin Users
- Partner Verification
- Vehicle Verification

Therefore the Admin Backend must become the authoritative source before those mocks are removed.

---

# 4. Admin Backend Architecture

Recommended structure:

```text
src/
├── config/
├── app.js
├── server.js
│
├── routes/
│   ├── admin-auth.routes.js
│   ├── admin-dashboard.routes.js
│   ├── admin-customers.routes.js
│   ├── admin-partners.routes.js
│   ├── admin-shops.routes.js
│   ├── admin-vehicles.routes.js
│   ├── admin-verification.routes.js
│   ├── admin-bookings.routes.js
│   ├── admin-payments.routes.js
│   ├── admin-commissions.routes.js
│   ├── admin-payouts.routes.js
│   ├── admin-refunds.routes.js
│   ├── admin-offers.routes.js
│   ├── admin-support.routes.js
│   ├── admin-disputes.routes.js
│   ├── admin-reviews.routes.js
│   ├── admin-notifications.routes.js
│   ├── admin-analytics.routes.js
│   ├── admin-users.routes.js
│   ├── admin-audit.routes.js
│   └── admin-settings.routes.js
│
├── controllers/
├── services/
├── repositories/
├── validators/
├── middlewares/
└── utils/
```

The exact folder structure may follow the existing Customer/Partner backend conventions.

---

# 5. Authentication & Authorization

Admin APIs must use backend-enforced authorization.

Recommended request flow:

```text
Firebase ID Token
       ↓
authenticate
       ↓
resolve users record
       ↓
verify role
       ↓
verify admin permission
       ↓
controller
```

Required roles from the supplied platform reference include:

```text
admin
support_executive
customer
partner
```

The Admin application may additionally implement permission groups such as:

```text
SUPER_ADMIN
OPERATIONS_ADMIN
FINANCE_ADMIN
SUPPORT_ADMIN
VERIFICATION_ADMIN
```

These should be represented in a consistent backend authorization model rather than relying on frontend visibility.

---

# 6. Important Reuse Rule

## Direct endpoint reuse

### Generally: NO

Example:

```text
Admin frontend
   ↓
GET /api/v1/partner/vehicles
```

should not be the normal architecture.

That endpoint is designed around authenticated partner ownership.

## Service/repository reuse

### YES

Example:

```text
Admin Vehicle Service
      ↓
Vehicle Repository
      ↓
vehicles
```

The Admin service can reuse existing vehicle repository/query logic where compatible.

The same principle applies to:

- booking queries
- payment queries
- wallet queries
- partner queries
- customer queries
- document queries
- support queries

---

# 7. API Classification

Every Admin requirement should be classified as one of:

| Classification | Meaning |
|---|---|
| REUSE DOMAIN | Existing Customer/Partner service/repository can be reused |
| ADMIN WRAPPER | Existing business logic reused behind a new Admin endpoint |
| ADMIN NEW | New Admin-specific controller/service/query/action required |
| CROSS-DOMAIN | Requires joins/aggregation across multiple existing domains |
| ADMIN-ONLY | No existing user-facing equivalent; must be implemented for Admin |

This is preferable to blindly copying existing APIs.

---

# 8. Admin API Contract Standards

Base:

```text
/api/v1/admin
```

Success:

```json
{
  "success": true,
  "data": {},
  "meta": {}
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": {}
  },
  "requestId": "uuid"
}
```

All list endpoints should support server-side pagination where applicable.

Recommended parameters:

```text
page
limit
search
status
sortBy
sortOrder
from
to
```

Sensitive mutations should support:

```text
X-Request-ID
Idempotency-Key
```

when the operation is retry-sensitive.

---

# 9. ADMIN AUTH API

## Required

```text
POST /api/v1/admin/auth/login
POST /api/v1/admin/auth/verify-otp
POST /api/v1/admin/auth/refresh
POST /api/v1/admin/auth/logout
GET  /api/v1/admin/auth/me
```

### Implementation

**ADMIN-ONLY**

The existing Firebase authentication infrastructure may be reused.

Admin-specific role/permission checks must be added.

### Notes

Do not duplicate password/token cryptography unnecessarily if the platform's existing Firebase authentication model is retained.

The Admin backend must never trust a client-supplied:

```text
role
adminId
permission
```

---

# 10. DASHBOARD APIs

Frontend requirements from the Admin Panel include:

- customer count
- partner count
- verified/pending partners
- vehicle count
- active/pending vehicles
- booking count
- active/completed/cancelled bookings
- revenue
- commission
- partner payouts
- pending refunds
- support tickets
- disputes
- booking trends
- revenue trends
- marketplace statistics

## APIs

```text
GET /api/v1/admin/dashboard
GET /api/v1/admin/dashboard/stats
GET /api/v1/admin/dashboard/revenue
GET /api/v1/admin/dashboard/bookings
```

### Classification

**CROSS-DOMAIN**

These should aggregate existing domain data rather than duplicate business records.

Potential data sources:

```text
users
partners
shops
vehicles
bookings
payments
refunds
commission_transactions / commission_records
partner_payouts / payouts
support_tickets
disputes
```

---

# 11. CUSTOMER MANAGEMENT

## APIs

```text
GET   /api/v1/admin/customers
GET   /api/v1/admin/customers/:id
PATCH /api/v1/admin/customers/:id/status
GET   /api/v1/admin/customers/:id/bookings
GET   /api/v1/admin/customers/:id/payments
GET   /api/v1/admin/customers/:id/documents
GET   /api/v1/admin/customers/:id/activity
```

### Classification

| API | Classification |
|---|---|
| List customers | ADMIN WRAPPER |
| Customer detail | ADMIN WRAPPER |
| Customer status | ADMIN-ONLY |
| Customer bookings | REUSE DOMAIN + ADMIN WRAPPER |
| Customer payments | REUSE DOMAIN + ADMIN WRAPPER |
| Customer documents | REUSE DOMAIN + ADMIN WRAPPER |
| Customer activity | CROSS-DOMAIN |

### Important

Customer identity must be resolved from the authenticated Admin context, not from client-supplied ownership information.

---

# 12. PARTNER MANAGEMENT

## APIs

```text
GET   /api/v1/admin/partners
GET   /api/v1/admin/partners/:id
PATCH /api/v1/admin/partners/:id/status
GET   /api/v1/admin/partners/:id/documents
GET   /api/v1/admin/partners/:id/kyc
GET   /api/v1/admin/partners/:id/bank-accounts
GET   /api/v1/admin/partners/:id/shops
GET   /api/v1/admin/partners/:id/vehicles
GET   /api/v1/admin/partners/:id/bookings
GET   /api/v1/admin/partners/:id/earnings
```

## Verification mutations

```text
POST /api/v1/admin/partners/:id/approve
POST /api/v1/admin/partners/:id/reject
```

### Classification

Most read queries:

**ADMIN WRAPPER / REUSE DOMAIN**

Approval/rejection/status:

**ADMIN-ONLY**

The Partner Backend's existing partner/KYC/document business rules should be reused where safe.

---

# 13. SHOP MANAGEMENT

## APIs

```text
GET   /api/v1/admin/shops
GET   /api/v1/admin/shops/:id
PATCH /api/v1/admin/shops/:id/status
GET   /api/v1/admin/shops/:id/vehicles
GET   /api/v1/admin/shops/:id/documents
GET   /api/v1/admin/shops/:id/verification
POST  /api/v1/admin/shops/:id/approve
POST  /api/v1/admin/shops/:id/reject
```

### Classification

**ADMIN WRAPPER + ADMIN-ONLY verification mutations**

Underlying shop/vehicle relationships should use the shared DB/domain layer.

---

# 14. VEHICLE MANAGEMENT

## APIs

```text
GET   /api/v1/admin/vehicles
GET   /api/v1/admin/vehicles/:id
PATCH /api/v1/admin/vehicles/:id/status
GET   /api/v1/admin/vehicles/:id/documents
GET   /api/v1/admin/vehicles/:id/images
GET   /api/v1/admin/vehicles/:id/history
GET   /api/v1/admin/vehicles/:id/bookings
GET   /api/v1/admin/vehicles/:id/earnings
```

### Verification

```text
POST /api/v1/admin/vehicles/:id/approve
POST /api/v1/admin/vehicles/:id/reject
```

### Classification

Read operations:

**REUSE DOMAIN + ADMIN WRAPPER**

Approval/rejection/status:

**ADMIN-ONLY**

Do not copy partner vehicle ownership authorization into Admin APIs. Admin authorization is different.

---

# 15. PARTNER & VEHICLE VERIFICATION

The frontend has dedicated verification pages.

## Partner verification

```text
GET  /api/v1/admin/verifications/partners
GET  /api/v1/admin/verifications/partners/:id
POST /api/v1/admin/verifications/partners/:id/approve
POST /api/v1/admin/verifications/partners/:id/reject
```

## Vehicle verification

```text
GET  /api/v1/admin/verifications/vehicles
GET  /api/v1/admin/verifications/vehicles/:id
POST /api/v1/admin/verifications/vehicles/:id/approve
POST /api/v1/admin/verifications/vehicles/:id/reject
```

## Documents

```text
GET /api/v1/admin/verifications/documents/:id
```

### Classification

**ADMIN-ONLY**

Reuse existing KYC/document validation rules, storage utilities, and repositories where possible.

Every verification mutation should record:

```text
admin user
target entity
old status
new status
reason
timestamp
requestId
```

---

# 16. BOOKING MANAGEMENT

## APIs

```text
GET   /api/v1/admin/bookings
GET   /api/v1/admin/bookings/:id
PATCH /api/v1/admin/bookings/:id/status
POST  /api/v1/admin/bookings/:id/cancel
GET   /api/v1/admin/bookings/:id/timeline
GET   /api/v1/admin/bookings/:id/payment
GET   /api/v1/admin/bookings/:id/commission
GET   /api/v1/admin/bookings/:id/settlement
```

### Classification

Booking reads:

**REUSE DOMAIN + ADMIN WRAPPER**

Booking cancellation/status mutation:

**ADMIN-ONLY**

The existing booking/settlement rules must remain authoritative.

Admin should not recalculate:

- rental totals
- late fees
- extra KM
- settlement amounts
- commission

unless the existing domain service explicitly defines that calculation.

---

# 17. PAYMENT MANAGEMENT

## APIs

```text
GET /api/v1/admin/payments
GET /api/v1/admin/payments/:id
GET /api/v1/admin/payments/:id/transactions
GET /api/v1/admin/payments/:id/webhooks
GET /api/v1/admin/payments/:id/booking
```

### Classification

**REUSE DOMAIN + ADMIN WRAPPER**

The Admin API should expose read-only operational visibility over existing payment records.

Do not create a second payment ledger.

---

# 18. REFUND MANAGEMENT

## APIs

```text
GET  /api/v1/admin/refunds
GET  /api/v1/admin/refunds/:id
POST /api/v1/admin/refunds/:id/approve
POST /api/v1/admin/refunds/:id/reject
```

### Classification

List/detail:

**REUSE DOMAIN + ADMIN WRAPPER**

Approve/reject:

**ADMIN-ONLY**

Refund mutation must use the existing payment/refund transaction logic.

It must be idempotent.

---

# 19. COMMISSION MANAGEMENT

## APIs

```text
GET   /api/v1/admin/commissions
GET   /api/v1/admin/commissions/:id
GET   /api/v1/admin/commissions/rules
POST  /api/v1/admin/commissions/rules
PATCH /api/v1/admin/commissions/rules/:id
GET   /api/v1/admin/commissions/transactions
```

### Classification

Historical commission reads:

**REUSE DOMAIN + ADMIN WRAPPER**

Commission rule management:

**ADMIN-ONLY**

Do not modify historical commission transactions when changing a future rule.

---

# 20. PARTNER PAYOUT MANAGEMENT

The frontend/database reference includes partner payouts and finance operations.

## APIs

```text
GET  /api/v1/admin/payouts
GET  /api/v1/admin/payouts/:id
POST /api/v1/admin/payouts/:id/approve
POST /api/v1/admin/payouts/:id/reject
POST /api/v1/admin/payouts/:id/retry
GET  /api/v1/admin/payouts/reconciliation
```

### Classification

Reads:

**REUSE DOMAIN + ADMIN WRAPPER**

Payout mutations:

**ADMIN-ONLY**

Reconciliation:

**REUSE DOMAIN**

The existing Partner Backend reconciliation/wallet safeguards should be reused rather than duplicated.

---

# 21. WALLET / FINANCIAL OPERATIONS

Where Admin needs financial visibility:

```text
GET /api/v1/admin/wallets
GET /api/v1/admin/wallets/:partnerId
GET /api/v1/admin/wallets/:partnerId/transactions
GET /api/v1/admin/financials/reconciliation
```

### Classification

**REUSE DOMAIN + ADMIN WRAPPER**

The immutable ledger remains the source of truth.

Admin must not directly mutate wallet balances.

---

# 22. OFFER / COUPON MANAGEMENT

The Admin frontend contains an Offers page.

## APIs

```text
GET    /api/v1/admin/offers
POST   /api/v1/admin/offers
GET    /api/v1/admin/offers/:id
PATCH  /api/v1/admin/offers/:id
DELETE /api/v1/admin/offers/:id
GET    /api/v1/admin/offers/:id/vehicles
GET    /api/v1/admin/offers/:id/shops
```

If coupon functionality is enabled by the final product contract:

```text
GET    /api/v1/admin/coupons
POST   /api/v1/admin/coupons
GET    /api/v1/admin/coupons/:id
PATCH  /api/v1/admin/coupons/:id
DELETE /api/v1/admin/coupons/:id
```

### Classification

**ADMIN-ONLY**

Existing booking pricing/discount rules should be reused when applying an offer.

---

# 23. SUPPORT TICKETS

The Partner Backend already has a support ticket/message module.

## Admin APIs

```text
GET   /api/v1/admin/support/tickets
GET   /api/v1/admin/support/tickets/:id
PATCH /api/v1/admin/support/tickets/:id/status
POST  /api/v1/admin/support/tickets/:id/messages
```

Optional:

```text
PATCH /api/v1/admin/support/tickets/:id/priority
```

### Classification

**STRONG REUSE OPPORTUNITY**

Reuse:

- support ticket repository
- support message repository
- ticket service
- attachment/storage handling
- status transition rules

Create an Admin controller/service layer because Admin has cross-partner visibility.

Do not make Admin call the Partner support endpoint directly.

---

# 24. DISPUTE MANAGEMENT

## APIs

```text
GET  /api/v1/admin/disputes
GET  /api/v1/admin/disputes/:id
GET  /api/v1/admin/disputes/:id/evidence
POST /api/v1/admin/disputes/:id/resolve
POST /api/v1/admin/disputes/:id/reject
```

### Classification

Reads:

**REUSE DOMAIN + ADMIN WRAPPER**

Resolution:

**ADMIN-ONLY**

Every resolution must create an audit record.

---

# 25. REVIEWS & MODERATION

The Admin frontend contains a Reviews page.

## APIs

```text
GET    /api/v1/admin/reviews
GET    /api/v1/admin/reviews/:id
PATCH  /api/v1/admin/reviews/:id/status
POST   /api/v1/admin/reviews/:id/hide
POST   /api/v1/admin/reviews/:id/restore
GET    /api/v1/admin/reviews/:id/reports
```

### Classification

**ADMIN-ONLY**

Underlying review/report entities can be reused from the shared DB/domain layer.

---

# 26. NOTIFICATION MANAGEMENT

The Admin README specifies a Notification Management module.

A precise final endpoint set depends on the final Admin UI behavior.

Recommended:

```text
GET  /api/v1/admin/notifications
POST /api/v1/admin/notifications
GET  /api/v1/admin/notifications/:id
POST /api/v1/admin/notifications/:id/send
```

If Admin only needs operational visibility, read endpoints can reuse existing notification repositories.

If Admin can broadcast notifications, the sending workflow is **ADMIN-ONLY** and must include:

- permission checks
- recipient validation
- rate limits
- audit logging
- outbox/event dispatch
- delivery status

---

# 27. ANALYTICS

## APIs

```text
GET /api/v1/admin/analytics/customers
GET /api/v1/admin/analytics/partners
GET /api/v1/admin/analytics/vehicles
GET /api/v1/admin/analytics/bookings
GET /api/v1/admin/analytics/revenue
```

Optional operational endpoints:

```text
GET /api/v1/admin/analytics/utilization
GET /api/v1/admin/analytics/categories
GET /api/v1/admin/analytics/cities
GET /api/v1/admin/analytics/rentals
```

### Classification

**CROSS-DOMAIN**

Analytics should query/aggregate existing transactional tables.

For expensive reports, use:

- indexed SQL
- aggregation queries
- Redis caching where appropriate
- precomputed reporting tables only if profiling proves necessary

Do not duplicate financial truth into an uncontrolled analytics store.

---

# 28. ADMIN USERS & ROLES

The frontend has an Admin Users page.

## APIs

```text
GET    /api/v1/admin/users
GET    /api/v1/admin/users/:id
POST   /api/v1/admin/users
PATCH  /api/v1/admin/users/:id
PATCH  /api/v1/admin/users/:id/status
PATCH  /api/v1/admin/users/:id/role
DELETE /api/v1/admin/users/:id
```

Permission endpoints if required:

```text
GET /api/v1/admin/roles
GET /api/v1/admin/permissions
```

### Classification

**ADMIN-ONLY**

This is not a Customer/Partner API reuse case.

Super-admin-only operations must be explicitly protected.

---

# 29. AUDIT LOGS

The platform database includes `audit_logs` and `admin_actions`.

## APIs

```text
GET /api/v1/admin/audit-logs
GET /api/v1/admin/audit-logs/:id
```

Recommended filters:

```text
adminId
action
entityType
entityId
from
to
search
page
limit
```

### Classification

**ADMIN-ONLY**

Audit logs must be append-only from the application perspective.

Admin users should not be able to delete or silently modify audit records.

---

# 30. PLATFORM SETTINGS

The Admin frontend contains Settings.

## APIs

```text
GET   /api/v1/admin/settings
PATCH /api/v1/admin/settings
```

If settings are split by domain:

```text
GET/PATCH /api/v1/admin/settings/general
GET/PATCH /api/v1/admin/settings/booking
GET/PATCH /api/v1/admin/settings/commission
GET/PATCH /api/v1/admin/settings/notifications
```

### Classification

**ADMIN-ONLY**

Sensitive configuration should not be stored as arbitrary frontend-controlled values.

Secrets such as:

- Firebase credentials
- Cashfree credentials
- database credentials
- encryption keys
- AWS secrets

must remain environment/secret-manager configuration and must never be exposed through Admin Settings.

---

# 31. STORAGE / DOCUMENT PREVIEW

Admin needs to inspect:

- partner KYC documents
- vehicle RC
- insurance
- PUC
- shop documents
- support attachments
- other verification evidence

Use the existing S3/storage infrastructure.

Recommended:

```text
POST /api/v1/admin/storage/presign-view
```

or a controlled document-access endpoint:

```text
GET /api/v1/admin/documents/:id/access
```

### Classification

**REUSE STORAGE DOMAIN + ADMIN AUTHORIZATION**

Do not expose permanent public S3 URLs for private documents.

---

# 32. API REUSE MATRIX

| Domain | Existing Customer/Partner capability | Admin endpoint | Reuse strategy |
|---|---|---|---|
| Users | Existing user identity | `/admin/customers`, `/admin/users` | Repository/domain reuse |
| Customer profile | Customer domain | `/admin/customers/:id` | Admin wrapper |
| Partner profile | Partner domain | `/admin/partners/:id` | Admin wrapper |
| KYC | Partner KYC/document logic | `/admin/verifications/partners/*` | Strong reuse |
| Shops | Partner/shop domain | `/admin/shops/*` | Repository/service reuse |
| Vehicles | Partner vehicle domain | `/admin/vehicles/*` | Strong reuse |
| Vehicle documents | Storage + vehicle documents | `/admin/vehicles/:id/documents` | Strong reuse |
| Bookings | Booking domain | `/admin/bookings/*` | Strong reuse |
| Payments | Payment domain | `/admin/payments/*` | Strong reuse |
| Refunds | Payment/refund domain | `/admin/refunds/*` | Reuse transaction logic |
| Wallet | Partner wallet/ledger | `/admin/wallets/*` | Read/reconciliation reuse |
| Payouts | Partner payout domain | `/admin/payouts/*` | Strong reuse |
| Commission | Financial domain | `/admin/commissions/*` | Reuse calculations/rules |
| Support | Partner support module | `/admin/support/*` | Very strong reuse |
| Storage | S3 storage | `/admin/documents/*` | Reuse storage service |
| Notifications | Notification domain | `/admin/notifications/*` | Reuse infrastructure |
| Reviews | Shared review domain | `/admin/reviews/*` | Domain reuse |
| Disputes | Shared dispute domain | `/admin/disputes/*` | Domain reuse |
| Offers | Marketplace pricing/offer domain | `/admin/offers/*` | New Admin surface |
| Analytics | Existing transactional data | `/admin/analytics/*` | New aggregation layer |
| Audit | Admin/audit DB tables | `/admin/audit-logs/*` | Admin-only |
| Admin users | Admin identity/permissions | `/admin/users/*` | Admin-only |
| Settings | Platform config | `/admin/settings/*` | Admin-only |

---

# 33. WHAT MUST BE NEW IN THE ADMIN BACKEND

The following areas cannot simply be obtained by calling the existing Partner/Customer frontend APIs:

### Definitely Admin-specific

1. Admin authentication/session handling
2. Admin role/permission enforcement
3. Dashboard aggregation
4. Cross-partner customer queries
5. Cross-partner vehicle queries
6. Partner approval/rejection
7. Vehicle approval/rejection
8. Shop verification
9. Refund approval/rejection
10. Payout administration
11. Commission rule administration
12. Offer administration
13. Dispute resolution
14. Review moderation
15. Admin user management
16. Audit log querying
17. Platform settings
18. Cross-domain analytics

---

# 34. WHAT SHOULD BE REUSED FROM PARTNER BACKEND

Strong candidates:

```text
Authentication primitives
Firebase verification
PostgreSQL pool
Redis
Logger
Error handling
Request ID / correlation context
Storage/S3 service
Support ticket repository/service
Vehicle repository/domain rules
Booking repository/domain rules
Wallet repository
Payout service/repository
Reconciliation service
Outbox service
Notification infrastructure
Validation utilities
Financial invariants
Audit infrastructure
```

Especially important:

### Financial logic

Do not implement a second wallet/payout calculation system in Admin.

Reuse the existing financial authority.

### Support

Do not create a second support-ticket schema.

Reuse the existing ticket/message data model.

### Storage

Do not create a second S3 upload/access system.

Reuse the established storage abstraction.

---

# 35. CUSTOMER BACKEND REUSE STRATEGY

Customer Backend functionality should be treated similarly.

Do not expose Admin operations through customer-scoped endpoints.

Reuse:

- customer repositories
- booking queries
- payment queries
- profile queries
- identity verification logic
- document logic
- review logic
- dispute logic

Create an Admin-facing service/query layer where Admin requires:

- global visibility
- different joins
- filtering
- sorting
- operational actions
- audit logging

---

# 36. DATABASE RULE

The Admin Backend must use the same canonical database.

Do NOT create:

```text
admin_database
```

as a separate source of marketplace truth.

Use:

```text
PostgreSQL
   |
   +-- users
   +-- partners
   +-- shops
   +-- vehicles
   +-- bookings
   +-- payments
   +-- refunds
   +-- wallets
   +-- payouts
   +-- commission
   +-- support
   +-- disputes
   +-- reviews
   +-- admin_actions
   +-- audit_logs
```

Admin-specific tables may be added only when genuinely required, such as:

```text
admin_permissions
admin_sessions
admin_settings
```

subject to the final authentication design.

---

# 37. ADMIN DATABASE ACCESS RULES

Never trust these from the frontend:

```text
partnerId
customerId
adminId
role
permission
financial amount
commission amount
refund amount
wallet balance
```

IDs may be supplied as resource selectors, but the backend must:

1. authenticate the Admin
2. authorize the action
3. query the resource
4. validate its current state
5. execute the transaction
6. write audit information

---

# 38. FINANCIAL SAFETY

Admin financial operations must preserve the existing financial invariants.

Never allow an Admin endpoint to directly do:

```sql
UPDATE wallets SET available_balance = ...
```

unless that operation is part of the established wallet transaction service.

Use the existing financial service/repository.

For:

- refunds
- payouts
- wallet changes
- commission
- settlements

use transaction boundaries and idempotency where applicable.

---

# 39. AUDIT REQUIREMENT

The following operations must generate audit records:

```text
Partner approve
Partner reject
Partner suspend
Shop approve
Shop reject
Vehicle approve
Vehicle reject
Vehicle status change
Customer status change
Booking cancellation
Refund approval
Refund rejection
Payout approval/rejection
Commission rule change
Offer creation/update/delete
Dispute resolution
Review moderation
Admin user creation/update/role change
Settings change
```

Minimum audit metadata:

```json
{
  "adminId": "uuid",
  "action": "PARTNER_APPROVED",
  "entityType": "PARTNER",
  "entityId": "uuid",
  "oldValue": {},
  "newValue": {},
  "reason": "optional",
  "requestId": "uuid",
  "timestamp": "..."
}
```

Never store raw secrets, tokens, passwords, or sensitive credentials in audit logs.

---

# 40. API COUNT — PLANNING BASELINE

The original Admin frontend README defines an initial API structure, but the actual frontend contains more operational/detail views than that initial list.

Therefore the implementation should NOT artificially target a fixed API count.

The correct approach is:

```text
Frontend screen
      ↓
Required operation
      ↓
Existing domain capability
      ↓
Reuse / wrapper / new
      ↓
Final Admin API
```

The final count should be produced after implementing the contract and verifying every frontend network requirement.

---

# 41. INITIAL ADMIN API CATALOG

Recommended initial catalog:

### Auth

```text
5 APIs
```

### Dashboard

```text
4 APIs
```

### Customers

```text
7 APIs
```

### Partners

```text
9+ APIs
```

### Shops

```text
8 APIs
```

### Vehicles

```text
9 APIs
```

### Verification

```text
7 APIs
```

### Bookings

```text
8 APIs
```

### Payments

```text
5 APIs
```

### Refunds

```text
4 APIs
```

### Commission

```text
6 APIs
```

### Payouts

```text
5 APIs
```

### Offers/Coupons

```text
5+ APIs
```

### Support

```text
4 APIs
```

### Disputes

```text
5 APIs
```

### Reviews

```text
5 APIs
```

### Notifications

```text
4 APIs
```

### Analytics

```text
5+ APIs
```

### Admin Users/Roles

```text
6+ APIs
```

### Audit Logs

```text
2 APIs
```

### Settings

```text
2+ APIs
```

This is a **planning baseline**, not a final count. Duplicate endpoints should be avoided when a single well-designed query can serve multiple screens.

---

# 42. IMPLEMENTATION PHASES

## Phase A — Foundation

Build:

```text
Admin authentication
Admin authorization
RBAC
Error handling
Request IDs
Logging
Validation
Rate limiting
Audit infrastructure
Database access
```

---

## Phase B — Read-only Operations

Implement:

```text
Dashboard
Customers
Partners
Shops
Vehicles
Bookings
Payments
Analytics
```

Goal:

> Admin frontend can operate against real database data without mutation workflows.

---

## Phase C — Verification

Implement:

```text
Partner verification
Shop verification
Vehicle verification
Document access
```

---

## Phase D — Finance

Implement:

```text
Payments
Refunds
Commission
Payouts
Wallet/reconciliation
```

This phase requires the strongest transaction/idempotency testing.

---

## Phase E — Marketplace Operations

Implement:

```text
Offers
Reviews
Support
Disputes
Notifications
```

---

## Phase F — Administration

Implement:

```text
Admin users
Roles
Permissions
Audit logs
Settings
```

---

## Phase G — Frontend Integration

Replace Admin frontend mock data with real API calls.

Remove:

```text
mockMarketplace.js
mockCustomers
mockPartners
mockShops
mockBookings
mockVehicles
mockPayments
mockRefunds
mockReviews
mockTickets
mockDisputes
mockCoupons
mockAuditLogs
mockAdminUsers
```

only after their corresponding API flows are verified.

---

# 43. ADMIN FRONTEND INTEGRATION CONTRACT

The Admin frontend should have a centralized API client:

```text
src/services/api/
    apiClient.js
    authApi.js
    dashboardApi.js
    customersApi.js
    partnersApi.js
    shopsApi.js
    vehiclesApi.js
    verificationApi.js
    bookingsApi.js
    paymentsApi.js
    refundsApi.js
    commissionsApi.js
    payoutsApi.js
    offersApi.js
    supportApi.js
    disputesApi.js
    reviewsApi.js
    notificationsApi.js
    analyticsApi.js
    adminUsersApi.js
    auditApi.js
    settingsApi.js
```

The exact frontend structure can differ, but the API layer should remain centralized.

---

# 44. TESTING REQUIREMENTS

Each Admin module must have:

### Unit tests

- validator
- service
- permission checks
- state transitions

### Integration tests

- authenticated Admin
- unauthorized user
- wrong Admin role
- valid resource
- missing resource
- invalid state transition
- audit record creation

### Financial tests

For:

```text
refund
payout
commission
wallet
settlement
```

test:

- duplicate request
- concurrent request
- retry
- partial failure
- invalid state
- insufficient balance
- rollback

---

# 45. SECURITY REQUIREMENTS

Minimum:

```text
Helmet
CORS policy
Body-size limit
Rate limiting
Request ID
Structured logging
Secret redaction
Firebase token verification
RBAC
Permission checks
BOLA protection
Input validation
SQL parameterization
Idempotency
Audit logging
Private S3 access
```

Sensitive endpoints such as:

```text
refund approval
payout approval
commission changes
admin role changes
settings changes
```

should have dedicated rate limits and audit logging.

---

# 46. IMPORTANT ARCHITECTURAL RULES

### Rule 1

**Admin is a separate API surface.**

### Rule 2

**Customer/Partner business logic should be reused, not blindly copied.**

### Rule 3

**Admin must use the shared canonical PostgreSQL database.**

### Rule 4

**Admin must never calculate financial truth independently.**

### Rule 5

**Admin mutations must be audited.**

### Rule 6

**Frontend permissions are only UI controls. Backend authorization is mandatory.**

### Rule 7

**Private documents must never become permanently public URLs.**

### Rule 8

**Do not create duplicate tables when the existing domain table already represents the same business entity.**

### Rule 9

**Do not create duplicate payment, wallet, payout, commission, or settlement logic.**

### Rule 10

**Every Admin endpoint must have a clear source of truth.**

---

# 47. FINAL ADMIN BACKEND ARCHITECTURE

```text
                         GONGO PLATFORM
                               |
                +--------------+--------------+
                |              |              |
          Customer App    Partner App    Admin Panel
                |              |              |
                v              v              v
          Customer API    Partner API     Admin API
                |              |              |
                +--------------+--------------+
                               |
                    Shared Domain / Services
                               |
                    Repositories / DB Layer
                               |
                         PostgreSQL
                               |
        +----------+-----------+-----------+----------+
        |          |           |           |          |
      Redis       S3        Firebase    Payments   Outbox
```

Admin-specific operations remain behind:

```text
/api/v1/admin/*
```

while domain truth remains shared.

---

# 48. FINAL BUILD CHECKLIST

Before declaring Admin Backend complete:

- [ ] Admin authentication works
- [ ] Admin role cannot be spoofed
- [ ] RBAC works
- [ ] Dashboard uses real data
- [ ] Customer list/detail uses real data
- [ ] Partner list/detail uses real data
- [ ] Shop list/detail uses real data
- [ ] Vehicle list/detail uses real data
- [ ] Partner verification works
- [ ] Vehicle verification works
- [ ] Booking management works
- [ ] Payment management works
- [ ] Refund workflow works
- [ ] Commission management works
- [ ] Payout management works
- [ ] Support workflow works
- [ ] Dispute workflow works
- [ ] Review moderation works
- [ ] Offers work
- [ ] Notifications work where required
- [ ] Analytics work
- [ ] Admin user management works
- [ ] Audit logs work
- [ ] Settings work
- [ ] Private document access works
- [ ] All mutations are audited
- [ ] Financial mutations are transactional
- [ ] Idempotency is implemented where needed
- [ ] No mock data remains in production Admin frontend
- [ ] No direct Partner/Customer endpoint misuse remains
- [ ] Full regression passes
- [ ] Admin integration tests pass
- [ ] Lint passes
- [ ] Production environment validation passes

---

# 49. FINAL DECISION

The Admin Backend should be built as a **dedicated administrative API layer over the existing GONGO domain/database**, not as a third independent marketplace backend.

The implementation strategy is:

```text
Existing Customer/Partner Backends
            ↓
Reuse proven domain rules
            ↓
Reuse repositories/services where compatible
            ↓
Add Admin-specific services/controllers
            ↓
Expose /api/v1/admin/*
            ↓
Connect Admin React frontend
            ↓
Remove frontend mock data
```

### Most important reuse opportunities

1. Partner KYC/document logic
2. Vehicle/document logic
3. Booking/settlement logic
4. Payment logic
5. Wallet/ledger logic
6. Payout logic
7. Commission logic
8. Support ticket/message logic
9. Storage/S3 logic
10. Notification/outbox infrastructure
11. Reconciliation
12. Validation/error/logging infrastructure

### Most important new Admin work

1. Admin authentication
2. Admin RBAC/permissions
3. Cross-domain queries
4. Dashboard aggregation
5. Verification actions
6. Refund administration
7. Payout administration
8. Offer management
9. Dispute resolution
10. Review moderation
11. Admin user management
12. Audit log API
13. Settings API
14. Analytics/reporting

---

## Source Basis

This document was derived from:

- the uploaded GONGO Admin frontend source tree
- `GONGO_ADMIN_PANEL_README.md`
- `GONGO_DB_REFERENCE.md`
- the existing GONGO Partner Backend implementation/verification reports supplied in this project
- the existing Customer/Partner backend architecture described in the project context

Where the supplied material did not define an exact final behavior, this document marks the item as a recommended implementation rather than claiming that the API already exists.
