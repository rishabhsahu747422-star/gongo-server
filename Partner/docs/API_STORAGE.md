# GONGO Partner Backend — Storage & S3 Direct Upload API

## Overview

The Storage module provides a secure, two-step direct-to-S3 upload architecture for the GONGO Partner Platform. Partners never upload binary assets through the application backend, nor do they directly interact with AWS credentials.

### Key Security Principles

1. **Private Bucket Only**: Direct client access to the S3 bucket is blocked via AWS S3 bucket policies. All reads go through short-lived presigned GET URLs.
2. **Server-Side Encryption**: Every PUT upload enforces SSE-S3 (`AES256`).
3. **Backend-Controlled Storage Keys**: S3 keys are constructed strictly on the backend under partner-isolated prefixes (`partners/{partnerId}/...`). Clients cannot specify the key, bucket, or directory path.
4. **Pre-Commit Verification (`HeadObject`)**: Upload completion is only accepted after the backend verifies that the binary exists in S3 with a valid file size.
5. **Strict BOLA Isolation**: Partners can only presign, complete, or request access URLs for their own files.

---

## Storage Key Structure

| Entity Type | Storage Key Pattern | Allowed MIME Types | Max File Size |
|---|---|---|---|
| `PROFILE_IMAGE` | `partners/{partnerId}/profile/{uuid}.{ext}` | `image/jpeg`, `image/png`, `image/webp` | 5 MB |
| `KYC_DOCUMENT` | `partners/{partnerId}/kyc/{documentType}/{uuid}.{ext}` | `application/pdf`, `image/jpeg`, `image/png` | 10 MB |
| `VEHICLE_IMAGE` | `partners/{partnerId}/vehicles/{vehicleId}/images/{uuid}.{ext}` | `image/jpeg`, `image/png`, `image/webp` | 10 MB |

---

## API Endpoints

### 1. Request Presigned Upload URL

Generates a presigned S3 PUT URL for uploading directly to Amazon S3.

- **Method**: `POST`
- **Path**: `/api/v1/storage/presign`
- **Auth**: Required (`Bearer <SupabaseToken>`, Role: `PARTNER`)
- **Rate Limit**: 30 requests / minute

#### Request Body (Profile Image)
```json
{
  "entityType": "PROFILE_IMAGE",
  "fileName": "avatar.jpg",
  "contentType": "image/jpeg"
}
```

#### Request Body (KYC Document)
```json
{
  "entityType": "KYC_DOCUMENT",
  "fileName": "aadhaar.pdf",
  "contentType": "application/pdf",
  "documentType": "AADHAAR",
  "documentNumber": "123456789012"
}
```

#### Request Body (Vehicle Image)
```json
{
  "entityType": "VEHICLE_IMAGE",
  "fileName": "front_view.png",
  "contentType": "image/png",
  "vehicleId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "isCover": true
}
```

#### Success Response (`201 Created`)
```json
{
  "success": true,
  "data": {
    "uploadId": "d3b07384-d113-40e9-b586-3472be344d57",
    "uploadUrl": "https://gongo-partner-documents.s3.ap-south-1.amazonaws.com/partners/...?[SignatureParams]",
    "storageKey": "partners/11111111-1111-1111-1111-111111111111/profile/e8a8e329-873b-4835-950c-e2f7b8dc634d.jpg",
    "headers": {
      "Content-Type": "image/jpeg",
      "x-amz-server-side-encryption": "AES256"
    },
    "expiresInSeconds": 900,
    "maxSizeBytes": 5242880
  },
  "timestamp": "2026-09-21T08:15:00.000Z"
}
```

---

### 2. Client Direct Upload to S3 (Frontend to AWS)

The frontend uses the returned `uploadUrl` to perform an HTTP PUT directly to S3 with the required headers:

```http
PUT https://gongo-partner-documents.s3.ap-south-1.amazonaws.com/partners/...?[SignatureParams]
Content-Type: image/jpeg
x-amz-server-side-encryption: AES256

<binary payload>
```

---

### 3. Complete Upload & Commit

Informs the backend that direct S3 upload is finished. The backend verifies the object existence in S3 using `HeadObject` and commits the changes to target database tables (partner profile avatar, KYC documents versioning, or vehicle images).

- **Method**: `POST`
- **Path**: `/api/v1/storage/complete`
- **Auth**: Required (`Bearer <SupabaseToken>`, Role: `PARTNER`)
- **Rate Limit**: 30 requests / minute

#### Request Body
```json
{
  "uploadId": "d3b07384-d113-40e9-b586-3472be344d57"
}
```

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "uploadId": "d3b07384-d113-40e9-b586-3472be344d57",
    "status": "COMPLETED",
    "entityType": "PROFILE_IMAGE",
    "storageKey": "partners/11111111-1111-1111-1111-111111111111/profile/e8a8e329-873b-4835-950c-e2f7b8dc634d.jpg",
    "sizeBytes": 154320
  },
  "timestamp": "2026-09-21T08:16:00.000Z"
}
```

#### Error Responses
- `400 Bad Request`: File not uploaded to S3 yet (`File was not uploaded to storage...`).
- `400 Bad Request`: Upload session has expired.
- `400 Bad Request`: File size exceeds permitted limit.
- `404 Not Found`: Upload session does not exist or belongs to another partner (BOLA).

---

### 4. Get Short-Lived Access URL

Generates a temporary presigned download URL for viewing private files.

- **Method**: `POST`
- **Path**: `/api/v1/storage/access-url`
- **Auth**: Required (`Bearer <SupabaseToken>`, Role: `PARTNER`)
- **Rate Limit**: 60 requests / minute

#### Request Body
```json
{
  "storageKey": "partners/11111111-1111-1111-1111-111111111111/profile/e8a8e329-873b-4835-950c-e2f7b8dc634d.jpg"
}
```

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "downloadUrl": "https://gongo-partner-documents.s3.ap-south-1.amazonaws.com/partners/...?[SignatureParams]",
    "expiresInSeconds": 300,
    "storageKey": "partners/11111111-1111-1111-1111-111111111111/profile/e8a8e329-873b-4835-950c-e2f7b8dc634d.jpg"
  },
  "timestamp": "2026-09-21T08:17:00.000Z"
}
```

#### Error Responses
- `403 Forbidden`: Cross-partner attempt to access another partner's files (`Access denied...`).
- `400 Bad Request`: Invalid storage key or path traversal attempt.
