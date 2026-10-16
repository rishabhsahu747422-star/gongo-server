# GONGO Partner Backend — Vehicle Inventory API Specification

Base URL: `/api/v1/partner/vehicles`

All routes require:
- Header: `Authorization: Bearer <firebase-id-token>`
- Role: `PARTNER`
- Standard Response Envelope: `{ "success": true, "data": { ... } }` or `{ "success": false, "error": { ... } }`

---

## 1. Create Vehicle

Creates a new vehicle in the authenticated partner's inventory.

- **Method**: `POST`
- **Path**: `/api/v1/partner/vehicles`
- **Rate Limit**: 60 requests/minute
- **Idempotency**: Supported via `Idempotency-Key` header

### Request Headers
```http
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: <optional-uuid>
```

### Request Body
```json
{
  "category": "Car",
  "brand": "Maruti Suzuki",
  "model": "Brezza",
  "variant": "ZXI Plus",
  "registrationNumber": "MP 04 ZB 8888",
  "year": 2023,
  "fuelType": "Petrol",
  "transmission": "Automatic",
  "seats": 5,
  "description": "Compact SUV in excellent condition",
  "pickupLocation": "Platform 1 Counter, Station Road"
}
```

### Field Requirements
| Field | Type | Required | Notes |
|---|---|---|---|
| `category` | String | Yes | Must be one of `['Car', 'Bike', 'Scooter']` |
| `brand` | String | Yes | 1–100 characters |
| `model` | String | Yes | 1–100 characters |
| `variant` | String | No | Up to 100 characters |
| `registrationNumber` | String | Yes | Normalized (trimmed, single space, uppercase). Enforced unique at DB level |
| `year` | Integer | Yes | 1990 to (Current Year + 1) |
| `fuelType` | String | Yes | Must be one of `['Petrol', 'Diesel', 'EV', 'CNG']` |
| `transmission` | String | No | Must be one of `['Manual', 'Automatic']`. Defaults to `'Manual'` |
| `seats` | Integer | No | 1–50. Defaults to 2 (Bike/Scooter) or 5 (Car) |
| `description` | String | No | Up to 1000 characters |
| `pickupLocation` | String | No | Up to 500 characters |

### Response (`201 Created`)
```json
{
  "success": true,
  "data": {
    "id": "11111111-1111-1111-1111-111111111111",
    "partnerId": "22222222-2222-2222-2222-222222222222",
    "shopId": "33333333-3333-3333-3333-333333333333",
    "category": "Car",
    "brand": "Maruti Suzuki",
    "model": "Brezza",
    "variant": "ZXI Plus",
    "registrationNumber": "MP 04 ZB 8888",
    "year": 2023,
    "fuelType": "Petrol",
    "transmission": "Automatic",
    "seats": 5,
    "description": "Compact SUV in excellent condition",
    "pickupLocation": "Platform 1 Counter, Station Road",
    "manualStatus": "ONLINE",
    "rentalStatus": "IDLE",
    "verificationStatus": "VERIFIED",
    "isArchived": false,
    "offlineReason": null,
    "effectiveStatus": "AVAILABLE",
    "coverImageKey": null,
    "createdAt": "2026-09-21T10:00:00.000Z",
    "updatedAt": "2026-09-21T10:00:00.000Z"
  }
}
```

---

## 2. List Vehicles

Lists vehicles belonging to the authenticated partner with pagination and filters.

- **Method**: `GET`
- **Path**: `/api/v1/partner/vehicles`

### Query Parameters
| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | Integer | 1 | Positive page number |
| `limit` | Integer | 20 | Results per page (1–100) |
| `category` | String | - | Filter by category (`Car`, `Bike`, `Scooter`) |
| `status` | String | - | Filter by effective status (`AVAILABLE`, `BOOKED`, `ACTIVE`, `UNAVAILABLE`, `ARCHIVED`, `ONLINE`, `OFFLINE`) |
| `search` | String | - | Search by brand, model, or registration number |

### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "vehicles": [
      {
        "id": "11111111-1111-1111-1111-111111111111",
        "partnerId": "22222222-2222-2222-2222-222222222222",
        "category": "Car",
        "brand": "Maruti Suzuki",
        "model": "Brezza",
        "registrationNumber": "MP 04 ZB 8888",
        "year": 2023,
        "effectiveStatus": "AVAILABLE",
        "coverImageKey": "partners/22222222/vehicles/11111111/images/cover.jpg"
      }
    ],
    "pagination": {
      "total": 1,
      "page": 1,
      "limit": 20,
      "totalPages": 1
    }
  }
}
```

---

## 3. Get Vehicle Details

Retrieves complete vehicle details including all active images and compliance documents.

- **Method**: `GET`
- **Path**: `/api/v1/partner/vehicles/:vehicleId`
- **Security**: Strict BOLA enforcement (`404 Not Found` if vehicle does not belong to partner).

### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "id": "11111111-1111-1111-1111-111111111111",
    "partnerId": "22222222-2222-2222-2222-222222222222",
    "category": "Car",
    "brand": "Maruti Suzuki",
    "model": "Brezza",
    "variant": "ZXI Plus",
    "registrationNumber": "MP 04 ZB 8888",
    "year": 2023,
    "fuelType": "Petrol",
    "transmission": "Automatic",
    "seats": 5,
    "description": "Compact SUV in excellent condition",
    "pickupLocation": "Platform 1 Counter, Station Road",
    "manualStatus": "ONLINE",
    "rentalStatus": "IDLE",
    "verificationStatus": "VERIFIED",
    "isArchived": false,
    "effectiveStatus": "AVAILABLE",
    "images": [
      {
        "id": "img-uuid",
        "vehicleId": "11111111-1111-1111-1111-111111111111",
        "storageKey": "partners/22222222/vehicles/11111111/images/front.jpg",
        "imageUrl": "partners/22222222/vehicles/11111111/images/front.jpg",
        "sortOrder": 0,
        "isCover": true,
        "createdAt": "2026-09-21T10:05:00.000Z"
      }
    ],
    "documents": [
      {
        "id": "doc-uuid",
        "vehicleId": "11111111-1111-1111-1111-111111111111",
        "documentType": "RC",
        "documentName": "RC",
        "documentNumber": "MP 04 ZB 8888",
        "storageKey": "partners/22222222/vehicles/11111111/documents/rc/rc.pdf",
        "verificationStatus": "VERIFIED",
        "isRequired": true,
        "version": 1,
        "createdAt": "2026-09-21T10:06:00.000Z"
      }
    ]
  }
}
```

---

## 4. Update Vehicle

Updates editable vehicle specifications.

- **Method**: `PATCH`
- **Path**: `/api/v1/partner/vehicles/:vehicleId`
- **Rate Limit**: 60 requests/minute
- **Restrictions**:
  - `registrationNumber` is immutable after creation (`400 Bad Request`).
  - Server-controlled fields (`rentalStatus`, `isArchived`, etc.) are rejected with `MASS_ASSIGNMENT_VIOLATION`.

### Request Body
```json
{
  "model": "Brezza Facelift",
  "pickupLocation": "Shop 101, Main Road Counter"
}
```

### Response (`200 OK`)
Returns the updated vehicle object.

---

## 5. Update Operational Status

Toggles vehicle operational status between `ONLINE` and `OFFLINE`.

- **Method**: `PATCH`
- **Path**: `/api/v1/partner/vehicles/:vehicleId/status`
- **Business Guard**: Cannot be modified while an active trip is in progress (`rental_status = 'ACTIVE'`) -> returns `409 Conflict`.

### Request Body
```json
{
  "status": "OFFLINE",
  "reason": "Scheduled tyre replacement"
}
```

### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "id": "11111111-1111-1111-1111-111111111111",
    "manualStatus": "OFFLINE",
    "offlineReason": "Scheduled tyre replacement",
    "effectiveStatus": "UNAVAILABLE"
  }
}
```

---

## 6. Archive Vehicle (Soft-Delete)

Archives a vehicle. Archived vehicles are excluded from public listings and partner active inventory.

- **Method**: `DELETE`
- **Path**: `/api/v1/partner/vehicles/:vehicleId`
- **Business Guard**: Cannot be archived if `rental_status` is `ACTIVE` (trip underway) or `BOOKED` (confirmed upcoming booking) -> returns `409 Conflict`.

### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "message": "Vehicle successfully archived",
    "vehicleId": "11111111-1111-1111-1111-111111111111"
  }
}
```

---

## 7. Vehicle Images & Documents Sub-Resources

### List Images
- `GET /api/v1/partner/vehicles/:vehicleId/images`

### Set Cover Image
- `PATCH /api/v1/partner/vehicles/:vehicleId/images/:imageId/cover`

### Delete Image
- `DELETE /api/v1/partner/vehicles/:vehicleId/images/:imageId`
- Removes record and initiates asynchronous deletion from private S3 bucket.

### List Compliance Documents
- `GET /api/v1/partner/vehicles/:vehicleId/documents`
- Returns latest version for each document type (`RC`, `Insurance`, `PUC`, `Fitness`, `Other`).

### Delete Compliance Document
- `DELETE /api/v1/partner/vehicles/:vehicleId/documents/:documentId`
