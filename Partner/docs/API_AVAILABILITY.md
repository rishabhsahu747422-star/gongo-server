# GONGO Partner Backend — Vehicle Calendar Availability API Specification

The Vehicle Calendar Availability module allows Partners to block out unavailable periods (e.g. maintenance, servicing, repairs, personal use) on vehicle calendars, preventing overlapping customer bookings.

Base URL Path: `/api/v1/partner/vehicles/:vehicleId/availability`  
Table: `vehicle_availability_blocks`  
Authentication: **Bearer Token (Supabase JWT token with PARTNER role)**  
Protection: **Strict BOLA + Row-Level Concurrency Locking + Overlap Protection**

---

## Allowed Reason Taxonomy
Availability blocks must use one of the canonical reason categories:
* `Maintenance` (default)
* `Service`
* `Damage`
* `Personal Use`
* `Temporary Unavailability`
* `Other`

---

## Endpoints

### 1. List Availability Blocks
Retrieves calendar availability blocks for a vehicle within an optional date range.

* **Method:** `GET`
* **Route:** `/api/v1/partner/vehicles/:vehicleId/availability`
* **Query Parameters:**
  * `startDate`: ISO 8601 string (e.g. `2026-10-01T00:00:00Z`). Returns blocks where `end_time >= startDate`.
  * `endDate`: ISO 8601 string (e.g. `2026-10-31T23:59:59Z`). Returns blocks where `start_time <= endDate`.
  * `isActive`: Filter by active state (`true`, `false`, or `all`). Defaults to `true`.
  * `page`: Page number (default: `1`).
  * `limit`: Page limit (default: `100`, max: `200`).
* **Success Status:** `200 OK`

#### Response Example
```json
{
  "success": true,
  "data": [
    {
      "id": "bbbb1111-1111-1111-1111-111111111111",
      "vehicleId": "aaaa1111-1111-1111-1111-111111111111",
      "startTime": "2026-10-05T09:00:00.000Z",
      "endTime": "2026-10-07T18:00:00.000Z",
      "reason": "Service",
      "isActive": true,
      "createdBy": "11111111-1111-1111-1111-111111111111",
      "createdAt": "2026-09-21T09:30:00.000Z",
      "updatedAt": "2026-09-21T09:30:00.000Z"
    }
  ]
}
```

---

### 2. Create Availability Block
Creates a new blocked window for a vehicle with atomic concurrency locking and overlap prevention.
1. Acquires vehicle row lock: `SELECT id FROM vehicles WHERE id = $1 AND partner_id = $2 FOR UPDATE`.
2. Verifies vehicle is active and not archived.
3. Checks for overlapping active blocks using standard interval overlap:
   ```sql
   WHERE vehicle_id = $1 AND is_active = true AND start_time < $newEnd AND end_time > $newStart
   ```
4. If overlap exists -> throws `409 Conflict`.
5. Inserts block into `vehicle_availability_blocks`.
6. Emits structured audit log (`VEHICLE_AVAILABILITY_BLOCKED`).

* **Method:** `POST`
* **Route:** `/api/v1/partner/vehicles/:vehicleId/availability`
* **Headers:**
  * `Authorization: Bearer <token>`
  * `X-Idempotency-Key: <uuid>` *(Optional)*
* **Success Status:** `201 Created`

#### Request Payload
```json
{
  "startTime": "2026-10-05T09:00:00.000Z",
  "endTime": "2026-10-07T18:00:00.000Z",
  "reason": "Service"
}
```

---

### 3. Update Availability Block
Updates the dates or reason of an existing block.
* If `startTime` or `endTime` is modified, an overlap check is re-executed (excluding the block itself: `AND id != $blockId`).

* **Method:** `PATCH`
* **Route:** `/api/v1/partner/vehicles/:vehicleId/availability/:blockId`
* **Success Status:** `200 OK`

#### Request Payload
```json
{
  "reason": "Damage"
}
```

---

### 4. Delete / Unblock Availability Block
Soft-deactivates an availability block (`is_active = false`) and emits audit event `VEHICLE_AVAILABILITY_UNBLOCKED`.

* **Method:** `DELETE`
* **Route:** `/api/v1/partner/vehicles/:vehicleId/availability/:blockId`
* **Success Status:** `200 OK`

#### Response Example
```json
{
  "success": true,
  "data": {
    "message": "Availability block removed successfully",
    "blockId": "bbbb1111-1111-1111-1111-111111111111"
  }
}
```

---

## Security & Error Codes

* **400 VALIDATION_ERROR:** `endTime <= startTime`, invalid date format, or invalid reason taxonomy.
* **400 MASS_ASSIGNMENT_VIOLATION:** Client attempt to inject `id`, `vehicleId`, `createdBy`, `isActive`.
* **401 UNAUTHORIZED:** Missing or invalid token.
* **404 NOT_FOUND:** Vehicle or block not found, or belongs to another partner (BOLA protection).
* **409 CONFLICT:**
  * Block overlaps with an existing active block (`Vehicle availability block overlaps with an existing active block`).
  * Attempting to block an archived vehicle.
