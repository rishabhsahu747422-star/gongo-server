# GONGO Partner Backend — Vehicle / Inventory Domain Architecture

## 1. Domain Model Overview

In the GONGO platform:
- **Partner is the canonical business entity and vehicle owner** (`vehicles.partner_id -> partners.id`).
- There is **no separate Shop business concept**. The legacy `shop_id` column exists strictly as backward-compatibility infrastructure for existing database foreign keys and is resolved transparently.
- Every vehicle query, update, image, or document operation is strictly scoped to the authenticated partner ID (`WHERE partner_id = req.partner.id`).

---

## 2. Vehicle Identification & Registration Uniqueness

- **Registration Number Normalization**:
  - Trims leading/trailing whitespace.
  - Collapses multiple internal spaces into a single space.
  - Converts all characters to uppercase (e.g. `'mp 04   ab 1234'` -> `'MP 04 AB 1234'`).
- **Race-Safe DB-Level Enforcement**:
  - Registration uniqueness is enforced by the PostgreSQL constraint:
    `CONSTRAINT uq_vehicles_registration UNIQUE (registration_number)`.
  - Application-level check provides friendly 409 Conflict error messages before database transaction execution.
- **Registration Number Immutability**:
  - Once created, a vehicle's `registration_number` cannot be mutated via update endpoints.

---

## 3. Vehicle Operational Lifecycle & Effective Status Matrix

Vehicles maintain two database state fields:
1. `manual_status`: Controlled by the partner (`ONLINE` vs `OFFLINE`).
2. `rental_status`: Controlled by the booking lifecycle (`IDLE`, `BOOKED`, `ACTIVE`).
3. `is_archived`: Indicates whether the vehicle has been retired/soft-deleted.

### Effective Status Resolution Matrix
The backend derives an authoritative `effectiveStatus` for frontend consumption:

| `is_archived` | `rental_status` | `manual_status` | `effectiveStatus` | Partner Actions Permitted |
|---|---|---|---|---|
| `true` | Any | Any | `ARCHIVED` | Read-only; cannot update status or specifications |
| `false` | `ACTIVE` | Any | `ACTIVE` | Trip in progress; **cannot toggle status or archive** |
| `false` | Any | `OFFLINE` | `UNAVAILABLE` | Vehicle offline; can edit details or switch to ONLINE |
| `false` | `BOOKED` | `ONLINE` | `BOOKED` | Upcoming booking; can toggle offline (for future dates) |
| `false` | `IDLE` | `ONLINE` | `AVAILABLE` | Vehicle ready for immediate rental |

---

## 4. Vehicle Images & Storage Architecture

Vehicle images utilize the Phase 5 AWS S3 direct upload infrastructure:
1. **Presign Request**: Client requests upload URL with `entityType: 'VEHICLE_IMAGE'`, supplying `vehicleId` and `fileName`.
2. **BOLA Check**: Backend validates that `vehicleId` exists and belongs to the authenticated partner.
3. **Backend-Controlled Key**:
   `partners/{partnerId}/vehicles/{vehicleId}/images/{fileUuid}.{ext}`
4. **Direct Upload**: Client uploads directly to S3 with AES256 server-side encryption.
5. **Completion & Verification**:
   Client calls `/api/v1/storage/complete`.
   Backend validates binary presence and magic bytes via `HeadObject` and range request, then commits record to `vehicle_images`.

---

## 5. Vehicle Compliance Documents Architecture

Vehicle documents (`RC`, `Insurance`, `PUC`, `Fitness`, `Other`) follow the same hardened S3 flow:
1. **Presign Request**: Client requests upload URL with `entityType: 'VEHICLE_DOCUMENT'`, supplying `vehicleId`, `documentType`, and `fileName`.
2. **BOLA Check**: Backend verifies partner ownership of `vehicleId`.
3. **Backend-Controlled Key**:
   `partners/{partnerId}/vehicles/{vehicleId}/documents/{documentType}/{fileUuid}.{ext}`
4. **Direct Upload & Completion**:
   Upon verification, backend increments the document version and creates an entry in `vehicle_documents`:
   - `verification_status: 'PENDING'`
   - `version: currentMaxVersion + 1`
   - `UNIQUE (vehicle_id, document_type, version)` constraint prevents version collisions.

---

## 6. Security Guarantees & IDOR Prevention

- **Never Trust Client**: Client-supplied `partnerId`, `userId`, or status fields are rejected or ignored.
- **Resource Ownership**: Every database query verifies `WHERE id = $vehicleId AND partner_id = $partnerId`. Accessing another partner's vehicle yields a safe `404 Not Found`.
- **Mass-Assignment Guard**: Server-controlled fields (`rentalStatus`, `verificationStatus`, `isArchived`, `createdAt`, `updatedAt`) are strictly prohibited in request payloads.
- **Audit Logging**: All lifecycle changes (`VEHICLE_CREATED`, `VEHICLE_UPDATED`, `VEHICLE_STATUS_UPDATED`, `VEHICLE_ARCHIVED`, `VEHICLE_COVER_IMAGE_SET`, `VEHICLE_IMAGE_DELETED`, `VEHICLE_DOCUMENT_DELETED`) generate structured, redacted audit events.
