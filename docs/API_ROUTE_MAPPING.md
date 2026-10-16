# GONGO API Route Mapping Reference

This document maps all public, customer, partner, and administrative API endpoints to their canonical Unified Backend routes, required HTTP methods, authentication levels, and access controls.

---

## 1. Top-Level Health & Probes

| HTTP Method | Original Endpoint | Unified Endpoint | Auth Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `GET` | `/health` | `/health` | No | System-wide health probe |
| `GET` | `/health/live` | `/health/live` | No | Kubernetes / Docker liveness probe |

---

## 2. Customer Application APIs
 
Base Path: `/api/v1/customer` (canonical) or `/customer/api/v1` (compatibility alias)
 
`/api/v1/customer` is a namespace prefix, not a standalone GET endpoint. Use
`/api/v1/customer/health` for a customer sub-application health probe.
 
| HTTP Method | Original Endpoint | Unified Canonical Endpoint | Auth Required | Role / Permissions | Description |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `POST` | `/api/v1/auth/send-otp` | `/api/v1/customer/auth/send-otp` | No | Public | Request SMS OTP for customer login |
| `POST` | `/api/v1/auth/verify-otp` | `/api/v1/customer/auth/verify-otp` | No | Public | Verify OTP and mint Supabase session |
| `POST` | `/api/v1/auth/dev-login` | `/api/v1/customer/auth/dev-login` | No | Dev Only | Development bypass customer login |
| `GET` | `/api/v1/customers/me` | `/api/v1/customer/customers/me` | Yes | `CUSTOMER` | Fetch authenticated customer profile |
| `PATCH` | `/api/v1/customers/me` | `/api/v1/customer/customers/me` | Yes | `CUSTOMER` | Update customer profile allowlist |
| `GET` | `/api/v1/customers/addresses` | `/api/v1/customer/customers/addresses` | Yes | `CUSTOMER` | List saved customer delivery addresses |
| `POST` | `/api/v1/customers/addresses` | `/api/v1/customer/customers/addresses` | Yes | `CUSTOMER` | Add new saved address |
| `GET` | `/api/v1/vehicles` | `/api/v1/customer/vehicles` | No | Public | Search available vehicles (bikes/cars) |
| `GET` | `/api/v1/vehicles/:id` | `/api/v1/customer/vehicles/:id` | No | Public | Get vehicle details, specs & pricing |
| `POST` | `/api/v1/pricing/quote` | `/api/v1/customer/pricing/quote` | Yes | `CUSTOMER` | Calculate dynamic rental quote |
| `POST` | `/api/v1/bookings` | `/api/v1/customer/bookings` | Yes | `CUSTOMER` | Create reservation booking |
| `GET` | `/api/v1/bookings` | `/api/v1/customer/bookings` | Yes | `CUSTOMER` | List customer active/past bookings |
| `GET` | `/api/v1/bookings/:id` | `/api/v1/customer/bookings/:id` | Yes | `CUSTOMER` (Owner) | Get private booking details |
| `POST` | `/api/v1/bookings/:id/cancel` | `/api/v1/customer/bookings/:id/cancel` | Yes | `CUSTOMER` (Owner) | Cancel booking with policy calculation |
| `POST` | `/api/v1/payments/cashfree/order`| `/api/v1/customer/payments/cashfree/order`| Yes | `CUSTOMER` | Create Cashfree PG checkout order |
| `POST` | `/api/v1/payments/cashfree/webhook`| `/api/v1/customer/payments/cashfree/webhook`| No | HMAC Signature | Cashfree asynchronous payment webhook |
 
---
 
## 3. Partner Application APIs
 
Base Path: `/api/v1/partner` (canonical) or `/partner/api/v1` (compatibility alias)
 
`GET /api/v1/partner` returns the Partner API metadata and health probe.
`GET /api/v1/partner/health` is the explicit partner API health endpoint.
 
| HTTP Method | Original Endpoint | Unified Canonical Endpoint | Auth Required | Role / Permissions | Description |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `POST` | `/api/auth/otp/send` | `/api/v1/partner/auth/otp/send` | No | Public | Send partner OTP via Renflair SMS |
| `POST` | `/api/auth/otp/verify` | `/api/v1/partner/auth/otp/verify` | No | Public | Verify partner OTP |
| `POST` | `/api/v1/auth/dev-login` | `/api/v1/partner/auth/dev-login` | No | Dev Only | Development bypass partner login |
| `GET` | `/api/v1/partner/dashboard/stats` | `/api/v1/partner/dashboard/stats` | Yes | `PARTNER` | Real-time fleet & earnings KPIs |
| `GET` | `/api/v1/partner/profile` | `/api/v1/partner/profile` | Yes | `PARTNER` | Get partner shop & personal profile |
| `PUT` | `/api/v1/partner/profile` | `/api/v1/partner/profile` | Yes | `PARTNER` | Update partner shop details |
| `POST` | `/api/v1/partner/kyc` | `/api/v1/partner/kyc` | Yes | `PARTNER` | Submit partner KYC document bundle |
| `POST` | `/api/v1/partner/storage/presign-upload` | `/api/v1/partner/storage/presign-upload` | Yes | `PARTNER` | Request presigned S3/Supabase upload URL |
| `GET` | `/api/v1/partner/vehicles` | `/api/v1/partner/vehicles` | Yes | `PARTNER` | List fleet vehicles owned by partner |
| `POST` | `/api/v1/partner/vehicles` | `/api/v1/partner/vehicles` | Yes | `PARTNER` | Register new fleet vehicle |
| `PATCH` | `/api/v1/partner/vehicles/:id` | `/api/v1/partner/vehicles/:id` | Yes | `PARTNER` (Owner) | Update vehicle details or status |
| `GET` | `/api/v1/partner/bookings` | `/api/v1/partner/bookings` | Yes | `PARTNER` | View booking dispatch requests |
| `POST` | `/api/v1/partner/bookings/:id/accept` | `/api/v1/partner/bookings/:id/accept` | Yes | `PARTNER` (Owner) | Accept customer booking request |
| `POST` | `/api/v1/partner/bookings/:id/reject` | `/api/v1/partner/bookings/:id/reject` | Yes | `PARTNER` (Owner) | Reject customer booking request |
| `GET` | `/api/v1/partner/earnings` | `/api/v1/partner/earnings` | Yes | `PARTNER` | Get ledger earnings and payout balance |
| `POST` | `/api/v1/partner/payouts/request` | `/api/v1/partner/payouts/request` | Yes | `PARTNER` | Request wallet withdrawal via Cashfree |
 
---
 
## 4. Admin Portal APIs
 
Base Path: `/api/v1/admin` (canonical) or `/admin/api/v1` (compatibility alias)
 
`GET /api/v1/admin` returns the Admin API metadata and health probe.
`GET /api/v1/admin/health` is the explicit Admin API health endpoint.
 
| HTTP Method | Original Endpoint | Unified Canonical Endpoint | Auth Required | Role / Permissions | Description |
| :--- | :--- | :--- | :---: | :--- | :--- |
| `POST` | `/api/v1/admin/auth/login` | `/api/v1/admin/auth/login` | No | Public | Admin email/password login |
| `POST` | `/api/v1/admin/auth/verify-2fa` | `/api/v1/admin/auth/verify-2fa` | No | Public | Verify 2FA SMS code, issue session |
| `GET` | `/api/v1/admin/dashboard` | `/api/v1/admin/dashboard` | Yes | `ADMIN` / `dashboard.read` | Global marketplace metrics & KPIs |
| `GET` | `/api/v1/admin/customers` | `/api/v1/admin/customers` | Yes | `ADMIN` / `customers.read` | Paginated customer registry |
| `PATCH` | `/api/v1/admin/customers/:id/suspend` | `/api/v1/admin/customers/:id/suspend` | Yes | `ADMIN` / `customers.suspend` | Suspend or reactivate customer |
| `GET` | `/api/v1/admin/partners` | `/api/v1/admin/partners` | Yes | `ADMIN` / `partners.read` | List all rental partners & statuses |
| `POST` | `/api/v1/admin/verification/partner/:id` | `/api/v1/admin/verification/partner/:id` | Yes | `ADMIN` / `partners.verify` | Approve or reject partner KYC |
| `GET` | `/api/v1/admin/vehicles` | `/api/v1/admin/vehicles` | Yes | `ADMIN` / `vehicles.read` | Inspect vehicles across all partners |
| `POST` | `/api/v1/admin/verification/vehicle/:id` | `/api/v1/admin/verification/vehicle/:id` | Yes | `ADMIN` / `vehicles.verify` | Verify vehicle RC/PUC/Insurance |
| `GET` | `/api/v1/admin/bookings` | `/api/v1/admin/bookings` | Yes | `ADMIN` / `bookings.read` | Global booking overview |
| `POST` | `/api/v1/admin/refunds/approve` | `/api/v1/admin/refunds/approve` | Yes | `ADMIN` / `refunds.approve` | Approve Cashfree refund |
| `GET` | `/api/v1/admin/audit` | `/api/v1/admin/audit` | Yes | `ADMIN` / `audit.read` | Inspect immutable audit logs |
