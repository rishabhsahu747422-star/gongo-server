# GONGO Partner Backend — Vehicle Pricing API Specification

The Vehicle Pricing module allows Partners to configure rental rates, deposits, and per-kilometer charges for vehicles in their inventory. All changes are tracked in an immutable audit history table (`vehicle_pricing_history`).

Base URL Path: `/api/v1/partner/vehicles/:vehicleId/pricing`  
Authentication: **Bearer Token (Supabase JWT token with PARTNER role)**  
Protection: **Strict BOLA (Partner Ownership Verification) + Row-Level Concurrency Locking**

---

## Endpoints

### 1. Get Vehicle Pricing
Retrieves the active pricing configuration for a vehicle.

* **Method:** `GET`
* **Route:** `/api/v1/partner/vehicles/:vehicleId/pricing`
* **Success Status:** `200 OK`

#### Response Example
```json
{
  "success": true,
  "data": {
    "id": "c7a6e11b-3f4a-4b7b-9c6a-4a2a1c0d8e20",
    "vehicleId": "aaaa1111-1111-1111-1111-111111111111",
    "pricePerHour": 140.00,
    "pricePer4Hours": 500.00,
    "pricePerDay": 2200.00,
    "securityDeposit": 4000.00,
    "extraKmCharge": 14.00,
    "currency": "INR",
    "isActive": true,
    "createdAt": "2026-09-20T10:00:00.000Z",
    "updatedAt": "2026-09-21T09:30:00.000Z"
  }
}
```

*Note: If no pricing has been configured yet, the endpoint returns a default structure with `0.00` rates and `currency: "INR"`.*

---

### 2. Upsert Vehicle Pricing
Sets or updates rental pricing for a vehicle. Runs atomically inside a database transaction:
1. Acquires row lock: `SELECT id FROM vehicles WHERE id = $1 AND partner_id = $2 FOR UPDATE`.
2. Closes existing open history record in `vehicle_pricing_history` (`valid_to = CURRENT_TIMESTAMP`).
3. Upserts current rates in `vehicle_pricing`.
4. Inserts new snapshot in `vehicle_pricing_history` with `valid_from = CURRENT_TIMESTAMP, valid_to = NULL`.
5. Emits structured audit log (`VEHICLE_PRICING_UPDATED`).

* **Method:** `PUT`
* **Route:** `/api/v1/partner/vehicles/:vehicleId/pricing`
* **Headers:**
  * `Authorization: Bearer <token>`
  * `X-Idempotency-Key: <uuid>` *(Optional)*
* **Success Status:** `200 OK`

#### Request Payload
```json
{
  "pricePerDay": 2200,
  "pricePerHour": 140,
  "pricePer4Hours": 500,
  "securityDeposit": 4000,
  "extraKmCharge": 14
}
```

#### Auto-Derivation Rule
If only `pricePerDay` is supplied (e.g. from rapid editing screens), the server deterministically auto-derives the slab rates:
* `pricePerHour = Number((pricePerDay / 15).toFixed(2))`
* `pricePer4Hours = Number((pricePerDay / 4).toFixed(2))`
* `securityDeposit` defaults to `0.00` if omitted
* `extraKmCharge` defaults to `0.00` if omitted
* `currency` defaults to `'INR'`

#### Field Constraints
| Field | Type | Required | Constraints |
|---|---|---|---|
| `pricePerDay` | Numeric | Yes | `>= 0.00`, `<= 1,000,000` |
| `pricePerHour` | Numeric | No | `>= 0.00`, `<= 1,000,000` (auto-derived if omitted) |
| `pricePer4Hours` | Numeric | No | `>= 0.00`, `<= 1,000,000` (auto-derived if omitted) |
| `securityDeposit` | Numeric | No | `>= 0.00`, `<= 1,000,000` |
| `extraKmCharge` | Numeric | No | `>= 0.00`, `<= 10,000` |
| `currency` | String | No | Must be `'INR'` |

---

### 3. Get Pricing History
Retrieves immutable historical records of price changes for the vehicle.

* **Method:** `GET`
* **Route:** `/api/v1/partner/vehicles/:vehicleId/pricing/history`
* **Query Parameters:**
  * `limit`: Max records to return (default: `50`)
  * `offset`: Pagination offset (default: `0`)
* **Success Status:** `200 OK`

#### Response Example
```json
{
  "success": true,
  "data": [
    {
      "id": "e4f3a2b1-5c6d-4e8f-9a0b-1c2d3e4f5a6b",
      "vehicleId": "aaaa1111-1111-1111-1111-111111111111",
      "pricePerHour": 140.00,
      "pricePer4Hours": 500.00,
      "pricePerDay": 2200.00,
      "securityDeposit": 4000.00,
      "extraKmCharge": 14.00,
      "validFrom": "2026-09-21T09:30:00.000Z",
      "validTo": null,
      "createdAt": "2026-09-21T09:30:00.000Z"
    },
    {
      "id": "d3e2a1b0-4b5c-3d7e-8f9a-0b1c2d3e4f5a",
      "vehicleId": "aaaa1111-1111-1111-1111-111111111111",
      "pricePerHour": 100.00,
      "pricePer4Hours": 375.00,
      "pricePerDay": 1500.00,
      "securityDeposit": 3000.00,
      "extraKmCharge": 10.00,
      "validFrom": "2026-09-15T08:00:00.000Z",
      "validTo": "2026-09-21T09:30:00.000Z",
      "createdAt": "2026-09-15T08:00:00.000Z"
    }
  ]
}
```

---

## Security & Error Handling

* **400 VALIDATION_ERROR:** Negative rate, malformed numbers, non-INR currency, or rate exceeding bounds.
* **400 MASS_ASSIGNMENT_VIOLATION:** Injection of server-controlled fields (`id`, `vehicleId`, `isActive`, `createdAt`, `updatedAt`).
* **401 UNAUTHORIZED:** Missing or invalid Bearer token.
* **403 FORBIDDEN:** Account inactive or non-partner caller.
* **404 NOT_FOUND:** Vehicle does not exist or does not belong to the calling partner (BOLA protection).
* **409 CONFLICT:** Attempting to update pricing on an archived vehicle.
