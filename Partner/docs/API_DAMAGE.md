# GONGO Partner Backend — Damage Reporting API

## Overview

The Damage Reporting API allows Partners to report physical damage discovered on vehicles during or following a rental. Damage reports can be submitted either directly inside the return inspection payload or independently via dedicated endpoints.

---

## Allowed Damage Types Taxonomy

- `ACCIDENT`: Collision or moving vehicle damage
- `SCRATCH`: Surface paint or body scratches
- `DENT`: Panel indents or structural deformations
- `MECHANICAL`: Engine, transmission, or brake issues caused by customer
- `INTERIOR`: Stains, burns, or tears in seat covers/dashboard
- `OTHER`: Other non-standard damages

---

## Endpoints

### 1. Report Vehicle Damage

```http
POST /api/v1/partner/bookings/:bookingId/damage
```

- **Authentication**: Bearer token (`PARTNER` role required)
- **Rate Limit**: 20 requests/min
- **BOLA Protection**: Verifies booking and vehicle ownership

#### Request Body
```json
{
  "damageType": "DENT",
  "description": "Dent on driver side door from parking lot obstacle",
  "estimatedAmount": 2500,
  "photos": [
    "uploads/damages/dent_door.jpg"
  ]
}
```

#### Response (201 Created)
```json
{
  "success": true,
  "data": {
    "id": "dmg-standalone-01",
    "bookingId": "33333333-3333-4333-a333-333333333333",
    "vehicleId": "55555555-5555-4555-a555-555555555555",
    "damageType": "DENT",
    "description": "Dent on driver side door from parking lot obstacle",
    "estimatedAmount": 2500,
    "status": "REPORTED",
    "photos": [
      "uploads/damages/dent_door.jpg"
    ],
    "createdAt": "2026-09-27T11:00:00.000Z"
  }
}
```

---

### 2. List Damage Reports for Booking

```http
GET /api/v1/partner/bookings/:bookingId/damage
```

- **Authentication**: Bearer token (`PARTNER` role required)
- **Rate Limit**: 120 requests/min

#### Response (200 OK)
```json
{
  "success": true,
  "data": [
    {
      "id": "dmg-standalone-01",
      "bookingId": "33333333-3333-4333-a333-333333333333",
      "vehicleId": "55555555-5555-4555-a555-555555555555",
      "damageType": "DENT",
      "description": "Dent on driver side door from parking lot obstacle",
      "estimatedAmount": 2500,
      "approvedAmount": null,
      "status": "REPORTED",
      "photos": [
        "uploads/damages/dent_door.jpg"
      ],
      "createdAt": "2026-09-27T11:00:00.000Z"
    }
  ]
}
```
