# GONGO Partner Backend — Return & Completion API

## Overview

The Return & Completion API enables Partners to complete vehicle returns, verify odometer readings and fuel levels, record applicable late and extra-distance charges, report physical vehicle damage, and transition the rental from `ACTIVE` to `COMPLETED`.

Authoritative Booking Lifecycle Transition:
```text
ACTIVE
  ↓
Return / Inspection (Odometer, Fuel, Photos, Notes, Damage)
  ↓
Backend Return Timing & Late Calculation (15-min grace period)
  ↓
Update Pricing Snapshot & Record Verification
  ↓
Booking COMPLETED + Vehicle ACTIVE → IDLE
```

---

## Mandatory Business Rules

1. **NO Return OTP**: The Partner inspects and confirms the return directly. There is NO return OTP.
2. **Preservation of Schedule**: `bookings.expected_return_at` is immutable historical data and is NEVER altered. The actual return time is strictly stamped by the backend server (`CURRENT_TIMESTAMP`).
3. **15-Minute Grace Period**:
   - `lateMinutes <= 15`: ₹0.00 late charge (`billableHours = 0`, `returnStatus: 'ON_TIME'`).
   - `lateMinutes > 15`: Billed in 1-hour increments rounded up (`Math.ceil(lateMinutes / 60)`), `returnStatus: 'LATE'`.
4. **Historical Snapshot Hourly Rate**: Late charges are calculated using `booking_pricing_snapshots.price_per_hour` locked at the time of booking. Current vehicle pricing is never used.
5. **Odometer Validation**: End odometer reading must be greater than or equal to start odometer (`odometer_end >= odometer_start`). Backend computes `totalDistance = odometer_end - odometer_start`.
6. **Vehicle Status Reset**: When return completes, vehicle `rental_status` resets from `ACTIVE` to `IDLE`. The partner's `manual_status` (`ONLINE`/`OFFLINE`) remains untouched.
7. **Zero Commission Exposure**: No platform commissions, platform margins, or wallet settlements are exposed to the Partner.

---

## Endpoints

### 1. Confirm Return & Finalize Booking

```http
POST /api/v1/partner/bookings/:bookingId/return
```

- **Authentication**: Bearer token (`PARTNER` role required)
- **Rate Limit**: 20 requests/min
- **Idempotency**: Supported via `Idempotency-Key` header
- **Mass Assignment**: Rejects protected fields (`status`, `lateFee`, `lateMinutes`, `actualReturnAt`, `verifiedBy`)

#### Request Body
```json
{
  "odometerEnd": 12540,
  "fuelLevelEnd": "FULL",
  "extraKm": 0,
  "notes": "Vehicle returned in good condition",
  "photos": [
    "uploads/returns/odometer.jpg"
  ],
  "damageReport": {
    "damageType": "SCRATCH",
    "description": "Minor scratch on rear bumper",
    "estimatedAmount": 1200,
    "photos": [
      "uploads/damages/bumper.jpg"
    ]
  }
}
```

#### Response (200 OK)
```json
{
  "success": true,
  "data": {
    "booking": {
      "id": "33333333-3333-4333-a333-333333333333",
      "bookingNumber": "BK-2026-RET-01",
      "status": "COMPLETED",
      "bookingStatus": "COMPLETED",
      "paymentStatus": "COMPLETED",
      "vehicleId": "55555555-5555-4555-a555-555555555555",
      "vehicleName": "Royal Enfield Classic 350",
      "registrationNumber": "KA01AB1234",
      "expectedReturnAt": "2026-09-27T10:00:00.000Z",
      "returnedAt": "2026-09-27T10:10:00.000Z",
      "returnStatus": "ON_TIME",
      "odometerStart": 12000,
      "odometerEnd": 12540,
      "totalDistance": 540,
      "lateMinutes": 10,
      "lateFee": 0,
      "extraKm": 0,
      "extraKmFee": 0
    },
    "returnVerification": {
      "id": "ret-verif-001",
      "bookingId": "33333333-3333-4333-a333-333333333333",
      "bookingNumber": "BK-2026-RET-01",
      "status": "COMPLETED",
      "expectedReturnAt": "2026-09-27T10:00:00.000Z",
      "actualReturnAt": "2026-09-27T10:10:00.000Z",
      "returnStatus": "ON_TIME",
      "odometerStart": 12000,
      "odometerEnd": 12540,
      "totalDistance": 540,
      "fuelLevelStart": "FULL",
      "fuelLevelEnd": "FULL",
      "lateMinutes": 10,
      "lateFee": 0,
      "extraKm": 0,
      "extraKmFee": 0,
      "notes": "Vehicle returned in good condition",
      "photos": ["uploads/returns/odometer.jpg"],
      "damageReports": [
        {
          "id": "dmg-rep-001",
          "damageType": "SCRATCH",
          "description": "Minor scratch on rear bumper",
          "estimatedAmount": 1200,
          "approvedAmount": null,
          "status": "REPORTED",
          "photos": ["uploads/damages/bumper.jpg"],
          "createdAt": "2026-09-27T10:10:00.000Z"
        }
      ],
      "settlementSummary": {
        "baseAmount": 2000,
        "lateFee": 0,
        "extraKmFee": 0,
        "totalCollected": 5124,
        "currency": "INR"
      }
    }
  }
}
```

---

### 2. Get Return Details & Settlement Summary

```http
GET /api/v1/partner/bookings/:bookingId/return
```

- **Authentication**: Bearer token (`PARTNER` role required)
- **Rate Limit**: 120 requests/min
- **Response**: Returns the complete return verification and billing breakdown.
