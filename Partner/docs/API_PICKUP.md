# GONGO Partner Backend — Vehicle Pickup & Active Rental API Specification (Phase 9)

Base URL: `/api/v1/partner/bookings`  
Authentication: `Authorization: Bearer <Supabase_JWT_Token>` (Requires `role: PARTNER`)

---

## 1. Architectural Principles & Business Rules

### 1.1 Hard Lock: Authorized Pickup Verification Only
* **Partner CANNOT manually set a booking to `ACTIVE`**.
* The booking state transition:
  ```text
  CONFIRMED → ACTIVE
  ```
  can occur **strictly and exclusively** through the authorized pickup verification flow (`POST /api/v1/partner/bookings/:bookingId/pickup/verify`).
* Partner cannot accept, reject, or manually confirm bookings. Any route attempting arbitrary lifecycle mutation (`/accept`, `/reject`, `/confirm`, `PATCH /bookings/:id`) returns `404 Not Found`.

### 1.2 OTP Authority & Storage Security
* **Authority**: The Partner Backend is the authoritative verification engine for vehicle pickup, reusing the existing `booking_pickup_verifications` table (Migration 016).
* **Plaintext OTP Isolation**: Raw OTP is **never** persisted in the database, never returned in API responses, never logged, and never written to audit trails or analytics.
* **Salted SHA-256 Hashing**: Stored in `booking_pickup_verifications.otp_hash` as a 64-character hex string.
* **Timing-Safe Comparison**: Verification employs `crypto.timingSafeEqual` to eliminate side-channel timing attacks.
* **Lifecycle & Attempts**:
  - OTP TTL: **15 minutes** (900 seconds).
  - Maximum failed attempts: **5 attempts**. Once 5 failures occur, the OTP is invalidated and a fresh code must be requested.
  - Rate limiting: Max 10 OTP requests/minute, max 15 verification attempts/minute per partner.

### 1.3 Strict Broken Object Level Authorization (BOLA)
Every pickup action validates double-ownership:
```sql
WHERE b.id = $1 AND b.partner_id = $2 AND v.partner_id = $2
```
A partner can only request OTP or verify pickup for vehicles that they own. Cross-partner access attempts return `404 Not Found` without information leakage.

### 1.4 Vehicle Concurrency Protection
* A vehicle cannot have multiple simultaneous active rentals.
* The activation transaction checks:
  ```sql
  SELECT id FROM bookings
  WHERE vehicle_id = $1 AND booking_status = 'ACTIVE' AND id != $2
  ```
  If another booking is already active, the operation rejects with `409 Conflict`.

### 1.5 Atomic Handover Transaction
Verification and activation are wrapped in an atomic PostgreSQL transaction (`pool.transaction`):
1. Locks booking and vehicle rows (`FOR UPDATE OF b, v`).
2. Validates partner ownership and vehicle non-archived status.
3. Checks for conflicting active rentals.
4. Validates OTP hash and attempts in Redis/DB.
5. Updates `booking_pickup_verifications`:
   `is_verified = true`, `verified_at = CURRENT_TIMESTAMP`, `verified_by = :userId`.
6. Updates `bookings`: `booking_status = 'ACTIVE'`, `updated_at = CURRENT_TIMESTAMP`.
7. Updates `vehicles`: `rental_status = 'ACTIVE'`, `updated_at = CURRENT_TIMESTAMP`.
8. Clears OTP state in Redis.
9. Emits audit log `BOOKING_PICKUP_VERIFIED` (actor, vehicleId, timestamp; zero raw OTP).
10. Commits transaction and returns active booking.

### 1.6 Future Return & Late History Compatibility
* Late-return calculation and late charges are **NOT** performed during pickup. They are determined during the later return workflow in Phase 10 and preserved in completed booking history.
* The original `bookings.expected_return_at` timestamp is **strictly preserved and never overwritten**.

---

## 2. Endpoints

### 2.1 Request / Resend Pickup OTP

`POST /api/v1/partner/bookings/:bookingId/pickup/otp`

Dispatches a 4-digit pickup security code to the customer's verified phone number via SMS.

#### Headers
```http
Authorization: Bearer <token>
Idempotency-Key: <optional-uuid>
```

#### Request Example
```http
POST /api/v1/partner/bookings/33333333-3333-4333-a333-333333333333/pickup/otp HTTP/1.1
Host: localhost:3001
Authorization: Bearer <token>
```

#### Response Example (`200 OK`)
```json
{
  "success": true,
  "data": {
    "message": "Pickup OTP sent to customer successfully"
  }
}
```

---

### 2.2 Verify Pickup OTP & Activate Rental

`POST /api/v1/partner/bookings/:bookingId/pickup/verify`

Verifies the customer's pickup OTP, transitions booking to `ACTIVE`, sets vehicle `rental_status` to `ACTIVE`, and records handover inspection metadata (`HandoverScreen.js`).

#### Headers
```http
Authorization: Bearer <token>
Idempotency-Key: <optional-uuid>
Content-Type: application/json
```

#### Request Body Schema

| Field | Type | Required | Description |
|---|---|---|---|
| `otp` | string | **Yes** | 4 to 6 numeric digits provided by customer. |
| `odometerStart` | number | No | Starting odometer reading (>= 0). |
| `fuelLevelStart` | string | No | Starting fuel level (e.g. `'FULL'`, `'75%'`, `'50%'`). |
| `notes` | string | No | Handover inspection remarks (max 500 characters). |
| `photos` | array of strings | No | Array of vehicle condition photo storage keys. |

#### Request Example
```http
POST /api/v1/partner/bookings/33333333-3333-4333-a333-333333333333/pickup/verify HTTP/1.1
Host: localhost:3001
Authorization: Bearer <token>
Content-Type: application/json

{
  "otp": "4829",
  "odometerStart": 14250,
  "fuelLevelStart": "FULL",
  "notes": "Vehicle handed over in pristine condition with 2 helmets"
}
```

#### Response Example (`200 OK`)
```json
{
  "success": true,
  "data": {
    "id": "33333333-3333-4333-a333-333333333333",
    "bookingNumber": "BK-2026-001",
    "status": "ACTIVE",
    "bookingStatus": "ACTIVE",
    "paymentStatus": "COMPLETED",
    "vehicleId": "55555555-5555-4555-a555-555555555555",
    "vehicleName": "Royal Enfield Classic 350 Dark Stealth",
    "registrationNumber": "KA01AB1234",
    "vehicleCategory": "Motorcycle • Petrol",
    "vehicleImage": "vehicles/images/cover-123.jpg",
    "vehicleTransmission": "Manual",
    "vehicleSeats": 2,
    "customerId": "cust-111",
    "customerName": "Rahul Sharma",
    "customerPhone": "+919876543210",
    "customerRating": 4.8,
    "startAt": "2026-09-25T10:00:00.000Z",
    "expectedReturnAt": "2026-09-27T10:00:00.000Z",
    "handoverAt": "2026-09-25T10:05:22.140Z",
    "bookingAmount": 5124,
    "securityDeposit": 3000,
    "pickupLocation": "Indiranagar Hub, Bangalore",
    "pricing": {
      "baseAmount": 1600,
      "rentalAmount": 2000,
      "securityDeposit": 3000,
      "extraKmCharge": 15,
      "lateFee": 0,
      "discountAmount": 200,
      "taxesAmount": 324,
      "totalCustomerAmount": 5124,
      "currency": "INR"
    },
    "createdAt": "2026-09-21T08:00:00.000Z",
    "updatedAt": "2026-09-25T10:05:22.140Z"
  }
}
```

---

## 3. Error Codes & Edge Cases

### 3.1 Invalid OTP (`400 Bad Request`)
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid OTP. Please check with the customer and try again.",
    "details": [{ "field": "otp", "message": "Invalid OTP" }],
    "requestId": "90b1ad69-df42-45e0-a931-15b9c0378685"
  }
}
```

### 3.2 Max Verification Attempts Exceeded (`400 Bad Request`)
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Maximum verification attempts exceeded. Please request a new OTP.",
    "details": [{ "field": "otp", "message": "Maximum verification attempts exceeded" }],
    "requestId": "3a70cb60-dfa8-48b4-82a9-08bb9c071682"
  }
}
```

### 3.3 Vehicle Concurrency Conflict (`409 Conflict`)
```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Vehicle already has an active rental in progress",
    "requestId": "2291079d-3f0e-47aa-be08-54b9d0319ec8"
  }
}
```

### 3.4 BOLA Violation or Unknown Booking (`404 Not Found`)
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Booking not found or does not belong to partner",
    "requestId": "6a964344-e2b2-4d74-a6fc-6e542ef4f169"
  }
}
```
