# GONGO Partner Backend — Storage & S3 Architecture

## 1. Direct-to-S3 Upload Flow

All file uploads in GONGO Partner Backend follow a secure three-step protocol that avoids routing multi-megabyte binary payloads through Node.js application servers.

```text
[Partner Frontend]                 [Backend API]                    [AWS S3 Bucket]
       │                                 │                                 │
       │ 1. POST /storage/presign        │                                 │
       │    (entityType, fileName, MIME) │                                 │
       ├────────────────────────────────>│                                 │
       │                                 │ 2. Generate secure storageKey   │
       │                                 │    Generate Presigned PUT URL   │
       │                                 │    Insert PENDING into DB       │
       │                                 ├────────────────────────────────>│ (S3 Presigned URL)
       │ 3. { uploadId, uploadUrl }      │                                 │
       │<────────────────────────────────┤                                 │
       │                                                                   │
       │ 4. PUT direct upload (binary payload + AES256 headers)            │
       ├──────────────────────────────────────────────────────────────────>│
       │                                                                   │
       │ 5. POST /storage/complete { uploadId }                            │
       ├────────────────────────────────>│                                 │
       │                                 │ 6. HeadObject (verify size)     │
       │                                 ├────────────────────────────────>│
       │                                 │ 7. Range Get (bytes=0-15)       │
       │                                 ├────────────────────────────────>│
       │                                 │ 8. Validate Magic-Byte Signature│
       │                                 │ 9. Transactional DB commit:     │
       │                                 │    - mark upload COMPLETED      │
       │                                 │    - sync domain entity record  │
       │ 10. { status: "COMPLETED" }     │                                 │
       │<────────────────────────────────┤                                 │
```

---

## 2. Secure S3 Key Generation & Namespace Isolation

All uploaded assets are partitioned under partner-specific prefixes:

| Entity Type | S3 Key Pattern | Allowed MIME Types | Max Size |
|---|---|---|---|
| **`PROFILE_IMAGE`** | `partners/{partnerId}/profile/{uuid}.{ext}` | `image/jpeg`, `image/png`, `image/webp` | 5 MB |
| **`KYC_DOCUMENT`** | `partners/{partnerId}/kyc/{documentType}/{uuid}.{ext}` | `image/jpeg`, `image/png`, `application/pdf` | 10 MB |
| **`VEHICLE_IMAGE`** | `partners/{partnerId}/vehicles/{vehicleId}/images/{uuid}.{ext}` | `image/jpeg`, `image/png`, `image/webp` | 10 MB |
| **`VEHICLE_DOCUMENT`** | `partners/{partnerId}/vehicles/{vehicleId}/docs/{docType}/{uuid}.{ext}` | `image/jpeg`, `image/png`, `application/pdf` | 10 MB |

---

## 3. Binary Magic-Byte Signature Verification

To defeat content-type spoofing (e.g. executable scripts masquerading as `.png` or `.pdf`), the backend reads the first 16 bytes directly from S3 via an HTTP Range request (`Range: bytes=0-15`) before committing any database record:

```javascript
// Verification table
JPEG:  buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF
PNG:   buf.subarray(0, 8) === [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
WebP:  buf.subarray(0, 4) === 'RIFF' && buf.subarray(8, 12) === 'WEBP'
PDF:   buf.subarray(0, 5) === '%PDF-'
```

If the signature does not match the declared MIME type:
1. The S3 object is deleted immediately.
2. The upload record is marked `FAILED`.
3. The request is rejected with `400 VALIDATION_ERROR`.

---

## 4. Private Access & Presigned Downloads

The S3 bucket is strictly non-public (`AWS_S3_PUBLIC=false`).
When authorized clients need to view a protected document or image:
1. Client requests `POST /api/v1/storage/access-url` with `{ storageKey }`.
2. Backend verifies BOLA: `storageKey.startsWith('partners/' + req.partner.id + '/')`.
3. Backend issues a short-lived presigned GET URL (default 300 seconds / 5 minutes).

---

## 5. Storage Cleanup & Garbage Collection

Expired `PENDING` upload sessions are handled by `StorageCleanupService`:
- Discovers `storage_uploads` where `status = 'PENDING' AND expires_at < CURRENT_TIMESTAMP`.
- Deletes orphaned S3 objects if partially uploaded.
- Transitions status to `EXPIRED`.
