# GONGO Partner Backend — Booking Operations API Specification (Phase 8)

Base URL: `/api/v1/partner/bookings`  
Authentication: `Authorization: Bearer <Supabase_JWT_Token>` (Requires `role: PARTNER`)

---

## 1. Architectural Principles & Business Rules

### 1.1 Hard Lock: No Partner Accept / Reject / Confirm Workflow
* **Partner DOES NOT accept or reject bookings.**
* GONGO bookings are **auto-confirmed** upon successful customer payment verification via the Cashfree payment gateway on the Customer Backend.
* There are **NO** partner-side booking approval, rejection, or state-transition endpoints. Attempts to access `/accept`, `/reject`, or `/confirm` return `404 Not Found`.
* In the Partner UI, `CONFIRMED` backend bookings are displayed with the `UPCOMING` badge / tab to clearly indicate scheduled upcoming reservations.

### 1.2 Strict BOLA (Broken Object Level Authorization) Enforcement
Every booking query strictly enforces double-ownership:
```sql
WHERE b.id = $1 AND b.partner_id = $2 AND v.partner_id = $2
```
A partner can only query bookings for vehicles that they own. Any attempt by Partner A to access Partner B's booking returns `404 Not Found` without disclosing booking existence.

### 1.3 Zero Commission Leakage
Financial details exposed to partners are strictly limited to customer pricing snapshots (`booking_pricing_snapshots`):
* Base amount
* Rental amount
* Security deposit
* Extra km charge
* Late fee
* Total customer amount
* Platform commission percentages, internal margins, and commission calculation records are **never** exposed.

### 1.4 Customer Data Minimization
Exposed customer details are restricted strictly to operational needs:
* `customerId` (UUID)
* `customerName`
* `customerPhone`
* `customerRating` (Operational metric)
Sensitive customer tokens, payment gateway credentials, and private customer backend fields are never leaked.

---

## 2. Endpoints

### 2.1 List Partner Bookings

`GET /api/v1/partner/bookings`

Retrieves a paginated list of bookings for vehicles owned by the authenticated partner, formatted for the Partner Mobile App (`BookingsScreen.js` and `BookingCard.js`).

#### Query Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `tab` | string | No | — | Filter by UI tab: `Upcoming` (or `UPCOMING`), `Active` (or `ACTIVE`), `Completed` (or `COMPLETED`). |
| `status` | string | No | — | Filter by booking status: `UPCOMING`, `CONFIRMED`, `ACTIVE`, `COMPLETED`, `CANCELLED`, `ALL`. |
| `vehicleId` | UUID | No | — | Filter by specific vehicle UUID. |
| `startDate` | ISO 8601 | No | — | Filter bookings active on or after this timestamp. |
| `endDate` | ISO 8601 | No | — | Filter bookings active on or before this timestamp. |
| `search` | string | No | — | Search term matching booking number, vehicle reg/brand/model, or customer name/phone. |
| `page` | integer | No | `1` | Page number (>= 1). |
| `limit` | integer | No | `20` | Items per page (1 to 100). |

#### Request Example
```http
GET /api/v1/partner/bookings?tab=Upcoming&page=1&limit=10 HTTP/1.1
Host: localhost:3001
Authorization: Bearer <token>
```

#### Response Example (`200 OK`)
```json
{
  "success": true,
  "data": {
    "bookings": [
      {
        "id": "33333333-3333-4333-a333-333333333333",
        "bookingNumber": "BK-2026-001",
        "status": "UPCOMING",
        "bookingStatus": "CONFIRMED",
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
        "handoverAt": null,
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
        "updatedAt": "2026-09-21T08:05:00.000Z"
      }
    ],
    "pagination": {
      "total": 1,
      "page": 1,
      "limit": 10,
      "totalPages": 1
    }
  }
}
```

---

### 2.2 Get Partner Booking Details

`GET /api/v1/partner/bookings/:bookingId`

Retrieves comprehensive booking details for a specific reservation owned by the authenticated partner (`BookingDetailsScreen.js`).

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `bookingId` | UUID | Yes | Target booking UUID. |

#### Request Example
```http
GET /api/v1/partner/bookings/33333333-3333-4333-a333-333333333333 HTTP/1.1
Host: localhost:3001
Authorization: Bearer <token>
```

#### Response Example (`200 OK`)
```json
{
  "success": true,
  "data": {
    "id": "33333333-3333-4333-a333-333333333333",
    "bookingNumber": "BK-2026-001",
    "status": "UPCOMING",
    "bookingStatus": "CONFIRMED",
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
    "handoverAt": null,
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
    "updatedAt": "2026-09-21T08:05:00.000Z"
  }
}
```

---

### 2.3 Pickup Operations (Phase 9)

Vehicle pickup and handover OTP verification are detailed extensively in [API_PICKUP.md](./API_PICKUP.md):

* `POST /api/v1/partner/bookings/:bookingId/pickup/otp`: Dispatches 4-digit security code to customer phone via SMS.
* `POST /api/v1/partner/bookings/:bookingId/pickup/verify`: Verifies customer OTP and activates rental (`CONFIRMED → ACTIVE`).

---

### 2.4 Return & Damage Operations (Phase 10)

Vehicle return, inspection, late charge calculation, damage reporting, and booking completion are detailed extensively in [API_RETURN.md](./API_RETURN.md) and [API_DAMAGE.md](./API_DAMAGE.md):

* `POST /api/v1/partner/bookings/:bookingId/return`: Completes vehicle return inspection, calculates late charges (15-min grace period), resets vehicle `rental_status` to `IDLE`, and transitions booking to `COMPLETED`.
* `GET /api/v1/partner/bookings/:bookingId/return`: Retrieves return verification receipt and settlement summary.
* `POST /api/v1/partner/bookings/:bookingId/damage`: Reports physical vehicle damage discovered during/after rental.
* `GET /api/v1/partner/bookings/:bookingId/damage`: Retrieves list of damage reports for a booking.

---

## 3. Error Responses

### 3.1 Invalid Query or UUID (`400 Bad Request`)
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid booking identifier format (must be a valid UUID)",
    "details": [
      {
        "field": "bookingId",
        "message": "Invalid UUID"
      }
    ],
    "requestId": "6a964344-e2b2-4d74-a6fc-6e542ef4f169"
  }
}
```

### 3.2 BOLA Violation or Missing Booking (`404 Not Found`)
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Booking not found or does not belong to partner",
    "requestId": "4c94f063-4414-419b-ab09-9b626e855074"
  }
}
```

### 3.3 Rate Limiting (`429 Too Many Requests`)
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests, please try again later",
    "requestId": "2291079d-3f0e-47aa-be08-54b9d0319ec8"
  }
}
```
Rate limit configured at **120 requests/minute** per authenticated partner.
