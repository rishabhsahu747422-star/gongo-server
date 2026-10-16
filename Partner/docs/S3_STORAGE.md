# Amazon S3 Storage Architecture & Operational Guide

## Overview

The GONGO Partner Platform uses AWS Amazon Simple Storage Service (S3) for storing partner avatars, KYC verification documents, and vehicle listing images.

All storage operations follow direct-to-S3 uploads using short-lived Presigned URLs signed by the backend using AWS Signature Version 4.

---

## 1. Bucket Security Architecture

### Private Bucket Enforcement
- **Public Access Block**: Enabled (`BlockPublicAcls = true`, `IgnorePublicAcls = true`, `BlockPublicPolicy = true`, `RestrictPublicBuckets = true`).
- **Access Policy**: Only authorized backend IAM credentials / IAM execution roles can generate signed URLs and issue S3 commands.
- **Default Encryption**: `SSE-S3` with `AES256` algorithm enabled by default on the bucket.

### CORS Configuration
In order to allow frontend web and mobile apps to perform direct HTTP `PUT` requests to S3, the bucket must have CORS configured:

```json
[
  {
    "AllowedHeaders": [
      "Content-Type",
      "x-amz-server-side-encryption"
    ],
    "AllowedMethods": [
      "PUT",
      "GET",
      "HEAD"
    ],
    "AllowedOrigins": [
      "https://partner.gongo.in",
      "https://staging-partner.gongo.in",
      "http://localhost:3000",
      "http://localhost:5173"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3000
  }
]
```

---

## 2. IAM Policy for Partner Backend Service

The partner backend requires the following least-privilege IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GongoPartnerS3Access",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:HeadObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::gongo-partner-documents/partners/*"
    }
  ]
}
```

---

## 3. S3 Lifecycle Rules

To automatically clean up abandoned partial uploads and manage storage costs:

1. **Abort Incomplete Multipart Uploads**: After 1 day.
2. **Expired Temporary Files**: Non-current versions transitioned to Glacier after 90 days if versioning is enabled.

---

## 4. Environment Configuration Reference

| Variable | Type | Default | Description |
|---|---|---|---|
| `AWS_REGION` | string | `ap-south-1` | AWS deployment region |
| `AWS_ACCESS_KEY_ID` | string | (empty) | IAM Access Key ID (for local dev; use IAM roles in ECS/EC2) |
| `AWS_SECRET_ACCESS_KEY` | string | (empty) | IAM Secret Access Key (strictly backend-only) |
| `AWS_S3_BUCKET` | string | `gongo-partner-documents` | Private target S3 bucket name |
| `AWS_S3_PUBLIC` | boolean | `false` | Must strictly remain `false` in all environments |
| `AWS_S3_PRESIGN_UPLOAD_EXPIRES_SECONDS` | number | `900` | Expiry of presigned PUT URLs (15 minutes) |
| `AWS_S3_PRESIGN_DOWNLOAD_EXPIRES_SECONDS` | number | `300` | Expiry of presigned GET URLs (5 minutes) |
| `AWS_S3_MAX_UPLOAD_SIZE_BYTES` | number | `10485760` | Maximum single upload binary size (10 MB) |

---

## 5. Storage Upload Tracking Lifecycle

Table: `storage_uploads`

```
  [Initiated]
       |
       v
   [PENDING] ----(Upload verified via S3 HeadObject)----> [COMPLETED]
       |
       +-------(Expires past expires_at)--------------> [EXPIRED]
       |
       +-------(Size violation / corruption)---------> [FAILED]
```

- Background worker or scheduled cron calls `storageCleanupService.cleanupExpiredUploads(100)` to mark expired pending uploads and delete orphan S3 objects.
