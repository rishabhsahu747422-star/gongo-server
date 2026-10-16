# GONGO Partner Backend — Security Architecture & Threat Model

## 1. Security Overview

The GONGO Partner Backend implements a defense-in-depth security posture designed to prevent unauthorized data access, privilege escalation, Broken Object Level Authorization (BOLA/IDOR), mass assignment attacks, and financial tampering.

---

## 2. Authentication & Identity Resolution

Identity is strictly established through a two-stage verification pipeline:

```text
[HTTP Request Header: Authorization: Bearer <token>]
                         │
                         ▼
[Supabase Auth / Admin: verifyIdToken(token, checkRevoked=true)]
   ├── Rejects expired tokens (TOKEN_EXPIRED)
   ├── Rejects revoked tokens (TOKEN_REVOKED)
   └── Rejects forged/malformed tokens (INVALID_TOKEN)
                         │
                         ▼ Returns decodedToken.uid (auth_id)
[PostgreSQL users Table Lookup (by auth_id)]
   ├── Rejects non-existent users (NOT_REGISTERED)
   └── Rejects deactivated users (ACCOUNT_DEACTIVATED)
                         │
                         ▼
[PostgreSQL partners Table Lookup (by user_id)]
   └── Attaches trusted object to req.user and req.partner
```

### Critical Identity Invariants
- **Client Identity Claims Are Never Trusted**: `req.partner.id` is derived strictly from the verified Supabase UID mapped to PostgreSQL `users.id` and `partners.id`. Any `partnerId` supplied in route params, query strings, or request bodies is verified against `req.partner.id` or discarded.
- **Supabase Token Revocation**: `auth/logout` explicitly invokes `auth.revokeRefreshTokens(uid)` to invalidate any active refresh sessions immediately.

---

## 3. Authorization & RBAC

1. **Role Enforcement (`requireRole('PARTNER')`)**:
   - Only users with `users.role = 'PARTNER'` can access `/api/v1/partner/*` and `/api/v1/storage/*`.
   - Non-partner roles (such as `CUSTOMER`) are rejected with `403 FORBIDDEN`.
2. **Deactivation Protection**:
   - If `users.is_active = false` or `partners.is_active = false`, all protected operations are immediately blocked with `403 ACCOUNT_DEACTIVATED`.

---

## 4. Broken Object Level Authorization (BOLA / IDOR)

Every endpoint that accesses or mutates a domain entity verifies that the target resource belongs to `req.partner.id`:

- **Partner Profile**: Access is strictly scoped to `req.partner.id`.
- **KYC Documents**: Queries filter by `WHERE id = $1 AND partner_id = $2`. Accessing a document belonging to another partner returns `404 NOT_FOUND` (preventing resource existence enumeration).
- **Vehicles**: Fleet operations query `WHERE id = $1 AND partner_id = $2`.
- **Storage Uploads**: Completing an upload checks `WHERE id = $1 AND partner_id = $2`.
- **Private S3 Objects**: Generating a download URL verifies that `storageKey.startsWith('partners/' + req.partner.id + '/')`.

---

## 5. Mass-Assignment Protection

Client payloads are processed through strict whitelist validators:
- **Server-Controlled Fields Are Stripped/Rejected**:
  - Financial fields: `walletBalance`, `commissionRate`, `commissionAmount`, `earnings`, `payoutStatus`.
  - Administrative fields: `kycStatus`, `verificationStatus`, `partnerStatus`, `role`, `rating`, `reviewCount`, `isActive`.
  - System fields: `id`, `createdAt`, `updatedAt`, `storageKey`, `version`.
- Any presence of protected fields in client payloads triggers `400 MASS_ASSIGNMENT_VIOLATION`.

---

## 6. Concurrency Control & Row-Level Locking

To prevent race conditions during version generation or state transitions:
1. **KYC Document Versioning**:
   - Submissions acquire an exclusive row lock on the partner record:
     ```sql
     SELECT id FROM partners WHERE id = $1 FOR UPDATE;
     ```
   - Sequential version `currentMax + 1` is calculated within the transaction.
   - Enforced by database unique constraint `UNIQUE (partner_id, document_type, version)`.
2. **Storage Upload Completion**:
   - Completion requests lock the upload session:
     ```sql
     SELECT * FROM storage_uploads WHERE id = $1 AND partner_id = $2 FOR UPDATE;
     ```
   - Transition from `PENDING` to `COMPLETED` is atomic. If another concurrent request already committed the upload, it returns idempotently without re-inserting domain records.

---

## 7. Storage Security & Binary Magic-Byte Validation

1. **Private S3 Bucket**: Direct public bucket access is strictly forbidden (`AWS_S3_PUBLIC=false`).
2. **Strict Key Prefixing**: Keys are generated exclusively by the backend in the format:
   - Profile: `partners/{partnerId}/profile/{uuid}.{ext}`
   - KYC: `partners/{partnerId}/kyc/{docType}/{uuid}.{ext}`
   - Vehicle: `partners/{partnerId}/vehicles/{vehicleId}/images/{uuid}.{ext}`
3. **Server-Side Encryption**: Presigned PUT URLs enforce `x-amz-server-side-encryption: AES256`.
4. **Magic-Byte Signature Verification**: Before committing an upload, the backend performs an HTTP Range request (`bytes=0-15`) to inspect binary signatures:
   - JPEG: `FF D8 FF`
   - PNG: `89 50 4E 47 0D 0A 1A 0A`
   - WebP: `RIFF....WEBP`
   - PDF: `%PDF-`
   - Mismatched or spoofed extensions result in immediate S3 object deletion and session failure (`status = 'FAILED'`).

---

## 8. Rate Limiting, Idempotency & Audit Logging

1. **Rate Limiting**: Sliding window counter backed by Redis (100 requests / 60 seconds per IP/actor).
2. **Idempotency**: Requests with `X-Idempotency-Key` cache responses in Redis scoped by authenticated partner ID.
3. **Structured Audit Logging**: Critical actions (`AUTH_LOGIN`, `KYC_DOCUMENT_SUBMITTED`, `STORAGE_UPLOAD_COMPLETED`, `PROFILE_UPDATED`) emit structured JSON audit entries. Sensitive fields (Aadhaar numbers, PAN cards, OTPs, tokens) are cryptographically hashed or redacted.
