# GONGO Partner Backend — Partner Profile & Shop API Specification

## Overview
This document specifies the authenticated Partner Profile and Shop Management APIs for the GONGO Partner marketplace backend, matching the contracts required by the `gongo-partner` mobile frontend.

> [!IMPORTANT]
> **Authentication $\neq$ KYC Verification**:
> A partner can be authenticated while `partner_status = 'OFFLINE'` and `kyc_status = 'PENDING'`. Partners cannot approve their own KYC.
> 
> **Phone Number Immutability**:
> A partner's registered phone number is the cryptographic anchor tied to Supabase Authentication and cannot be altered through profile update endpoints.
>
> **Scope Clarification**:
> - **Phase 4**: Partner Profile, Shop, GPS Location, and KYC Document Metadata.
> - **Phase 5**: AWS S3 direct upload and presigned URL binary transfers.
> - **Phase 13**: Payout Bank Accounts and settlements.

---

## 1. Authentication & Security Context

All profile and shop endpoints require an authenticated partner session.

### Request Headers
| Header | Type | Description |
| :--- | :--- | :--- |
| `Authorization` | `string` | **Required**. Format: `Bearer <Supabase_JWT_Token>` |
| `X-Request-Id` | `string` | *Optional*. UUID correlation identifier |
| `Content-Type` | `string` | `application/json` for mutation endpoints |

Identity Resolution Flow:
$$\text{Supabase JWT token} \longrightarrow \text{users.auth\_id} \longrightarrow \text{users.id} \longrightarrow \text{partners.user\_id} \longrightarrow \text{req.user.partnerId}$$

---

## 2. Endpoints

### 2.1 Get Authenticated Partner Profile
Retrieves the authoritative, live profile of the authenticated partner, including derived profile completion status.

* **Method**: `GET`
* **Path**: `/api/v1/partner/profile`
* **Roles Allowed**: `PARTNER`

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "name": "Vikram Sharma",
      "phone": "+91 9876543210",
      "email": "vikram@gongo.in",
      "role": "PARTNER",
      "isActive": true
    },
    "partner": {
      "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "partnerStatus": "OFFLINE",
      "kycStatus": "PENDING",
      "rating": 4.9,
      "reviewCount": 42,
      "registeredSince": "Nov 2024",
      "profileImage": "https://images.gongo.in/vikram.jpg",
      "shopName": "Apex Wheels & Rentals",
      "shopAddress": "Plot 42, MP Nagar Zone 1",
      "city": "Bhopal",
      "operatingInfo": "08:00 AM - 10:00 PM (All Days)",
      "isNewPartner": false
    },
    "completion": {
      "isProfileComplete": true,
      "isShopComplete": true,
      "isKycComplete": false
    }
  },
  "requestId": "a0f1c2d3-e4f5-6a7b-8c9d-0e1f2a3b4c5d"
}
```

---

### 2.2 Update Partner Profile
Updates editable personal and store information. Any attempt to supply server-controlled fields or modify the registered phone number is strictly rejected.

* **Method**: `PATCH`
* **Path**: `/api/v1/partner/profile`
* **Roles Allowed**: `PARTNER`
* **Rate Limit**: 30 requests / minute

#### Allowed Fields
* `name` (`string`, 2–150 chars)
* `email` (`string`, valid email)
* `profileImage` / `profileImageUrl` (`string`, URL up to 500 chars)
* `shopName` (`string`, 2–200 chars)
* `shopAddress` (`string`, 5–1000 chars)
* `city` (`string`, 2–100 chars)
* `operatingInfo` (`string`, up to 200 chars)

#### Protected Server-Controlled Fields (Rejected with `400 MASS_ASSIGNMENT_VIOLATION`)
* `id`, `partnerId`, `userId`, `authId`, `role`
* `phone`, `phoneNumber` (rejected with `400 VALIDATION_ERROR`)
* `partnerStatus`, `kycStatus`, `verificationStatus`
* `rating`, `reviewCount`, `registeredSince`, `isNewPartner`
* `walletBalance`, `commission`, `payoutStatus`, `isActive`

#### Request Payload
```json
{
  "name": "Vikram S. Sharma",
  "email": "vikram.sharma@apexrentals.in",
  "profileImage": "https://images.gongo.in/vikram_avatar_v2.jpg",
  "shopAddress": "Plot 42, Sector 18, Commercial Zone, MP Nagar",
  "operatingInfo": "07:00 AM - 11:00 PM (All Days)"
}
```

#### Response (`200 OK`)
Returns the refreshed profile structure described in Section 2.1.

---

### 2.3 Get Primary Shop & Location
Retrieves primary hub and default vehicle pickup location details.

* **Method**: `GET`
* **Path**: `/api/v1/partner/shop`
* **Roles Allowed**: `PARTNER`

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "id": "e4c3b2a1-5717-4562-b3fc-2c963f66afa6",
    "partnerId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "shopName": "Apex Wheels & Rentals",
    "shopAddress": "Plot 42, MP Nagar Zone 1",
    "city": "Bhopal",
    "latitude": 23.259933,
    "longitude": 77.412615,
    "operatingInfo": "08:00 AM - 10:00 PM (All Days)",
    "isActive": true,
    "createdAt": "2026-09-21T07:00:00.000Z",
    "updatedAt": "2026-09-21T07:30:00.000Z"
  },
  "requestId": "a0f1c2d3-e4f5-6a7b-8c9d-0e1f2a3b4c5d"
}
```

---

### 2.4 Update Shop & Location
Updates store hub address, operating hours, and GPS pickup coordinates.

* **Method**: `PATCH`
* **Path**: `/api/v1/partner/shop`
* **Roles Allowed**: `PARTNER`
* **Rate Limit**: 30 requests / minute

#### Validation Rules
* `shopName`: Optional string, 2–200 chars.
* `shopAddress`: Optional string, 5–1000 chars.
* `city`: Optional string, 2–100 chars.
* `latitude`: Optional numeric float $\in [-90.0, +90.0]$ (or null).
* `longitude`: Optional numeric float $\in [-180.0, +180.0]$ (or null).
* `operatingInfo`: Optional string up to 200 chars.

#### Request Payload
```json
{
  "shopName": "Apex Wheels Hub Bhopal",
  "shopAddress": "Plot 42, MP Nagar Zone 1",
  "city": "Bhopal",
  "latitude": 23.259933,
  "longitude": 77.412615,
  "operatingInfo": "07:00 AM - 11:00 PM (All Days)"
}
```

#### Response (`200 OK`)
Returns the updated shop object.
