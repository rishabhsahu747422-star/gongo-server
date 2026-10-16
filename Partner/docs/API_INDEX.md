# GONGO Partner Backend — API Endpoint Index (Phases 1–5)

Base URL: `http://localhost:3001/api/v1` (or configured host)

All API responses follow the standard envelope:
```json
{
  "success": true,
  "data": { ... }
}
```
Or in case of failure:
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": [ ... ],
    "requestId": "uuid-correlation-id"
  }
}
```

---

## 1. System & Health Endpoints

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/health/live` | Public | Process liveness probe |
| `GET` | `/health/ready` | Public | Readiness probe (checks DB pool & Redis ping) |
| `GET` | `/health` | Public | General service health summary |
| `GET` | `/api/v1/health` | Public | API-level health probe |

---

## 2. Authentication & Session Flow (`/api/v1/auth`)

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/check-phone` | Public | Verifies if phone number belongs to an existing registered partner |
| `POST` | `/api/v1/auth/session` | Bearer Token | Authenticates Supabase JWT token, resolves PostgreSQL partner, returns session |
| `POST` | `/api/v1/auth/register` | Bearer Token | Onboards first-time partner (creates `users`, `partners`, `shops`, `wallets`) |
| `GET` | `/api/v1/auth/me` | Bearer Token | Returns live authoritative database profile for authenticated partner |
| `POST` | `/api/v1/auth/logout` | Bearer Token | Revokes Supabase tokens/sessions and terminates server session |

---

## 3. Partner Profile & Hub Details (`/api/v1/partner`)

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/partner/profile` | Bearer Token | Returns full profile, canonical business/hub info, and completion status |
| `PATCH` | `/api/v1/partner/profile` | Bearer Token | Updates name, email, profile image, business name, address, and GPS coordinates |
| `GET` | `/api/v1/partner/shop` | Bearer Token | Legacy compatibility route: returns hub details and parsed GPS coordinates |
| `PATCH` | `/api/v1/partner/shop` | Bearer Token | Legacy compatibility route: updates hub details and GPS coordinates |

---

## 4. KYC Overview & Document Submission (`/api/v1/partner/kyc`)

Canonical KYC Document Types: `AADHAAR`, `PAN`, `GST`, `SHOP_ESTABLISHMENT`

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/partner/kyc` | Bearer Token | Returns partner KYC status, masked document records, and required types |
| `POST` | `/api/v1/partner/kyc/documents` | Bearer Token | Submits metadata for a new document version under concurrency row lock |
| `GET` | `/api/v1/partner/kyc/documents/:id` | Bearer Token | Returns single document metadata with masked number (enforces BOLA) |

---

## 5. Storage & S3 Direct Upload (`/api/v1/storage`)

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/storage/presign` | Bearer Token | Generates presigned PUT URL for direct-to-S3 upload with AES256 encryption |
| `POST` | `/api/v1/storage/complete` | Bearer Token | Verifies binary existence & magic bytes, commits to target domain entity |
| `POST` | `/api/v1/storage/access-url` | Bearer Token | Generates short-lived presigned GET URL for viewing private files (BOLA enforced) |

---

## 6. Vehicle Inventory Management (`/api/v1/partner/vehicles`)

Full specification: see [API_VEHICLES.md](./API_VEHICLES.md) and [VEHICLE_INVENTORY.md](./VEHICLE_INVENTORY.md).

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/partner/vehicles` | Bearer Token | Creates a new vehicle in partner inventory (idempotency supported) |
| `GET` | `/api/v1/partner/vehicles` | Bearer Token | Lists vehicles with pagination (`page`, `limit`), filters, and effective status |
| `GET` | `/api/v1/partner/vehicles/:vehicleId` | Bearer Token | Returns complete vehicle record with active images and documents |
| `PATCH` | `/api/v1/partner/vehicles/:vehicleId` | Bearer Token | Updates editable specifications (registration number is immutable) |
| `PATCH` | `/api/v1/partner/vehicles/:vehicleId/status` | Bearer Token | Toggles operational status (`ONLINE`/`OFFLINE` with reason; guards active trips) |
| `DELETE` | `/api/v1/partner/vehicles/:vehicleId` | Bearer Token | Archives vehicle (soft-delete; guards active or booked vehicles) |
| `GET` | `/api/v1/partner/vehicles/:vehicleId/images` | Bearer Token | Lists all active images for vehicle |
| `PATCH` | `/api/v1/partner/vehicles/:vehicleId/images/:imageId/cover` | Bearer Token | Sets primary cover image |
| `DELETE` | `/api/v1/partner/vehicles/:vehicleId/images/:imageId` | Bearer Token | Deletes image record and triggers private S3 bucket deletion |
| `GET` | `/api/v1/partner/vehicles/:vehicleId/documents` | Bearer Token | Lists latest compliance documents (`RC`, `Insurance`, `PUC`, etc.) |
| `DELETE` | `/api/v1/partner/vehicles/:vehicleId/documents/:documentId` | Bearer Token | Deletes compliance document record and triggers S3 deletion |

---

## 7. Vehicle Pricing (`/api/v1/partner/vehicles/:vehicleId/pricing`)

Full specification: see [API_PRICING.md](./API_PRICING.md).

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/partner/vehicles/:vehicleId/pricing` | Bearer Token | Retrieves active rental pricing configuration (defaults to zero rates if unconfigured) |
| `PUT` | `/api/v1/partner/vehicles/:vehicleId/pricing` | Bearer Token | Upserts vehicle pricing under row lock; records historical rate in immutable audit |
| `GET` | `/api/v1/partner/vehicles/:vehicleId/pricing/history` | Bearer Token | Retrieves chronological rate adjustment audit trail with validity intervals |

---

## 8. Vehicle Calendar Availability (`/api/v1/partner/vehicles/:vehicleId/availability`)

Full specification: see [API_AVAILABILITY.md](./API_AVAILABILITY.md).

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/partner/vehicles/:vehicleId/availability` | Bearer Token | Lists calendar availability blocks (supports `startDate`, `endDate`, `isActive` filters) |
| `POST` | `/api/v1/partner/vehicles/:vehicleId/availability` | Bearer Token | Creates blocked period under row lock with race-safe overlap prevention |
| `PATCH` | `/api/v1/partner/vehicles/:vehicleId/availability/:blockId` | Bearer Token | Updates block timing or reason; re-evaluates overlap if dates modified |
| `DELETE` | `/api/v1/partner/vehicles/:vehicleId/availability/:blockId` | Bearer Token | Soft-deactivates availability block (`is_active = false`) and emits audit event |

## 9. Booking Operations & Pickup Handover (`/api/v1/partner/bookings`)

Full specifications: see [API_BOOKINGS.md](./API_BOOKINGS.md) and [API_PICKUP.md](./API_PICKUP.md).

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/partner/bookings` | Bearer Token | Lists partner bookings (supports `tab`, `status`, `vehicleId`, date range, `search`, pagination) |
| `GET` | `/api/v1/partner/bookings/:bookingId` | Bearer Token | Retrieves single booking details for owned vehicle (Strict BOLA enforced) |
| `POST` | `/api/v1/partner/bookings/:bookingId/pickup/otp` | Bearer Token | Dispatches 4-digit pickup verification code to customer mobile via SMS |
| `POST` | `/api/v1/partner/bookings/:bookingId/pickup/verify` | Bearer Token | Verifies customer OTP and activates rental (`CONFIRMED → ACTIVE`; BOLA enforced) |

---

## 10. Return, Late Charges & Damage Completion (`/api/v1/partner/bookings`)

Full specifications: see [API_RETURN.md](./API_RETURN.md) and [API_DAMAGE.md](./API_DAMAGE.md).

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/partner/bookings/:bookingId/return` | Bearer Token | Completes return, validates odometer, calculates late fee (15-min grace), resets vehicle to `IDLE`, completes booking |
| `GET` | `/api/v1/partner/bookings/:bookingId/return` | Bearer Token | Retrieves return verification receipt and settlement summary |
| `POST` | `/api/v1/partner/bookings/:bookingId/damage` | Bearer Token | Submits physical damage report with optional photo evidence |
| `GET` | `/api/v1/partner/bookings/:bookingId/damage` | Bearer Token | Retrieves all damage reports recorded for a booking |

---

## 11. Payments, Settlement & Gateway Webhook

Full specifications: see [API_PAYMENTS.md](./API_PAYMENTS.md) and [PAYMENT_ARCHITECTURE.md](./PAYMENT_ARCHITECTURE.md).

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/partner/bookings/:bookingId/settlement` | Bearer Token | Retrieves return charges breakdown and post-rental settlement status |
| `GET` | `/api/v1/partner/bookings/:bookingId/payments` | Bearer Token | Retrieves complete payment audit trail for booking (advance + post-rental) |
| `POST` | `/api/v1/payments/webhook/cashfree` | Gateway HMAC-SHA256 | Processes Cashfree PG v2023-08-01 webhook events (amount/currency reconciliation) |

---

## 12. HTTP Status & Error Codes

| Status | Code | Meaning |
|---|---|---|
| `200` | `OK` | Request succeeded |
| `201` | `CREATED` | Resource successfully created |
| `400` | `VALIDATION_ERROR` | Request payload failed schema or business validation |
| `401` | `AUTH_REQUIRED` / `TOKEN_EXPIRED` | Missing, invalid, or expired authentication token |
| `403` | `FORBIDDEN` / `ACCOUNT_DEACTIVATED` | Insufficient role or access to unauthorized resource |
| `404` | `NOT_FOUND` | Target resource does not exist or does not belong to partner |
| `409` | `CONFLICT` | Resource already exists or availability block overlaps with active block |
| `413` | `PAYLOAD_TOO_LARGE` | Request payload exceeded maximum allowed size |
| `429` | `RATE_LIMIT_EXCEEDED` | Exceeded permitted number of requests in current time window |
| `500` | `INTERNAL_ERROR` | Unhandled server error (stack trace sanitized and hidden) |

