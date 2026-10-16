# GONGO Partner Backend — KYC Document Metadata API Specification

## Overview
This document specifies the KYC Document Metadata workflow for the GONGO Partner marketplace backend, matching the contracts required by [`KYCVerificationScreen.js`](file:///C:/Users/risha/.gemini/antigravity/scratch/gongo-partner/src/screens/profile/KYCVerificationScreen.js).

> [!IMPORTANT]
> **Server-Authoritative Verification**:
> Partners **cannot** approve their own documents or modify their `kyc_status` or `verification_status`. Any client attempt to inject verification statuses is rejected with `400 MASS_ASSIGNMENT_VIOLATION`.
> 
> **PII Protection & Masking**:
> Document numbers (e.g. Aadhaar, PAN) are masked in all read responses and are strictly **never** emitted into system audit logs or error messages.
>
> **Scope Clarification**:
> - **Phase 4**: Document metadata, sequential versioning, masking, and status queries.
> - **Phase 5**: AWS S3 direct upload and presigned URL binary transfers.

---

## 1. Supported Document Types

| Canonical Key | Frontend Display Title | Requirement Level | Format Validation |
| :--- | :--- | :--- | :--- |
| `AADHAAR` | Aadhaar Card | **Required / Compulsory** | Exactly 12 numeric digits |
| `PAN` | PAN Card | Optional Business Doc | Regex `^[A-Z]{5}[0-9]{4}[A-Z]$` |
| `GST` | GSTIN Certificate | Optional Business Doc | 15-character GSTIN format |
| `SHOP_ESTABLISHMENT` | Shop Establishment Certificate | Optional Business Doc | String up to 100 chars |

---

## 2. Endpoints

### 2.1 Get KYC Overview
Returns the partner's overall `kycStatus`, requirement breakdown, and the list of currently submitted documents with masked document numbers.

* **Method**: `GET`
* **Path**: `/api/v1/partner/kyc`
* **Roles Allowed**: `PARTNER`

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "kycStatus": "PENDING",
    "documents": [
      {
        "id": "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
        "documentType": "AADHAAR",
        "documentNumberMasked": "•••• •••• 8910",
        "verificationStatus": "VERIFIED",
        "version": 1,
        "rejectionReason": null,
        "createdAt": "2026-09-21T08:00:00.000Z",
        "updatedAt": "2026-09-21T08:30:00.000Z"
      },
      {
        "id": "2c8e7aad-cced-5c3e-8c6e-bc9efccd5cfe",
        "documentType": "PAN",
        "documentNumberMasked": "AB••••••4F",
        "verificationStatus": "PENDING",
        "version": 1,
        "rejectionReason": null,
        "createdAt": "2026-09-21T08:15:00.000Z",
        "updatedAt": "2026-09-21T08:15:00.000Z"
      }
    ],
    "requiredDocumentTypes": [
      "AADHAAR"
    ],
    "optionalDocumentTypes": [
      "PAN",
      "GST",
      "SHOP_ESTABLISHMENT",
      "SHOP_LICENSE"
    ]
  },
  "requestId": "a0f1c2d3-e4f5-6a7b-8c9d-0e1f2a3b4c5d"
}
```

---

### 2.2 Submit Document Metadata (New Version)
Submits metadata for identity or business verification. If a document of the specified type already exists for this partner, the backend automatically assigns the next sequential `version` number (`v2`, `v3`, etc.) while keeping historical versions intact.

* **Method**: `POST`
* **Path**: `/api/v1/partner/kyc/documents`
* **Roles Allowed**: `PARTNER`
* **Rate Limit**: 20 requests / minute

#### Request Payload
```json
{
  "documentType": "AADHAAR",
  "documentNumber": "987654328910"
}
```

#### Protected Fields (Rejected with `400 MASS_ASSIGNMENT_VIOLATION`)
* `verificationStatus` (always enforced by server as `'PENDING'`)
* `kycStatus`
* `rejectionReason`
* `version` (always calculated by server as `maxVersion + 1`)
* `storageKey` (server-managed canonical path placeholder)
* `partnerId`, `userId`

#### Response (`201 Created`)
```json
{
  "success": true,
  "data": {
    "id": "3d9f8bbe-ddef-6d4f-9d7f-cd0fad0e6d0f",
    "documentType": "AADHAAR",
    "documentNumberMasked": "•••• •••• 8910",
    "verificationStatus": "PENDING",
    "version": 2,
    "createdAt": "2026-09-21T09:00:00.000Z"
  },
  "requestId": "b1g2d3e4-f5a6-7b8c-9d0e-1f2a3b4c5d6e"
}
```

---

### 2.3 Get Document Metadata by ID
Retrieves metadata for a specific document version. Strictly verified against partner ownership (IDOR protection).

* **Method**: `GET`
* **Path**: `/api/v1/partner/kyc/documents/:id`
* **Roles Allowed**: `PARTNER`

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "id": "3d9f8bbe-ddef-6d4f-9d7f-cd0fad0e6d0f",
    "documentType": "AADHAAR",
    "documentNumberMasked": "•••• •••• 8910",
    "verificationStatus": "PENDING",
    "version": 2,
    "rejectionReason": null,
    "createdAt": "2026-09-21T09:00:00.000Z",
    "updatedAt": "2026-09-21T09:00:00.000Z"
  },
  "requestId": "c2h3e4f5-a6b7-8c9d-0e1f-2a3b4c5d6e7f"
}
```

#### IDOR Protection
If a partner attempts to access a document belonging to another partner, the server responds with:
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Document not found"
  }
}
```
Cross-partner resource existence is never revealed.
