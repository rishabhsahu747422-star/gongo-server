# GONGO Partner Backend — Supabase Auth Integration Guide

**Document Version:** 1.0.0  
**Target Environment:** Production / Staging  
**Authentication Provider:** Supabase Auth (Phone OTP via Twilio SMS)  
**Database Identity:** Supabase PostgreSQL  

---

## 1. Authentication Architecture Overview

The GONGO Partner platform leverages **Supabase Auth** for identity management and session security. The authentication flow is completely decoupled from any legacy Firebase dependencies:

```text
┌─────────────────┐       1. Phone OTP Request        ┌─────────────────┐
│                 ├──────────────────────────────────►│                 │
│  Partner Client │                                   │  Supabase Auth  │
│ (React Native / │◄──────────────────────────────────┤  (Twilio SMS)   │
│   Web Portal)   │       2. SMS Delivery via Twilio  └────────┬────────┘
│                 │                                            │
│                 │       3. Verify OTP                        │
│                 ├────────────────────────────────────────────┘
│                 │◄─── Returns: Supabase JWT { sub, phone, role }
│                 │
│                 │       4. API Call: Authorization: Bearer <JWT>
│                 ├───────────────────────────────────────────┐
└─────────────────┘                                           ▼
                                                    ┌──────────────────┐
                                                    │  GONGO Partner   │
                                                    │     Backend      │
                                                    │ (Express Server) │
                                                    └────────┬─────────┘
                                                             │ 5. Verify Token & Claims
                                                             │    (Supabase GoTrue / JWKS)
                                                             │ 6. Resolve Partner Actor
                                                             │    users.auth_id = sub
                                                             ▼
                                                    ┌──────────────────┐
                                                    │  Supabase DB     │
                                                    │ (PostgreSQL 17)  │
                                                    └──────────────────┘
```

---

## 2. Authentication Flow Details

### Step 1: Partner OTP Request (Client-Side)
The partner frontend requests a One-Time Password using the Supabase client SDK:
```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const { data, error } = await supabase.auth.signInWithOtp({
  phone: '+919876543210',
});
```

### Step 2: OTP Verification & Token Acquisition (Client-Side)
Upon receiving the SMS OTP via Twilio, the frontend verifies the code with Supabase:
```typescript
const { data, error } = await supabase.auth.verifyOtp({
  phone: '+919876543210',
  token: '123456',
  type: 'sms',
});

// data.session.access_token contains the Supabase JWT
const accessToken = data.session.access_token;
```

### Step 3: Backend API Request
The client includes the JWT in the standard HTTP `Authorization` header on every request:
```http
GET /api/v1/partners/profile HTTP/1.1
Host: api.partner.gongo.in
Authorization: Bearer <SUPABASE_JWT_ACCESS_TOKEN>
Content-Type: application/json
```

---

## 3. Backend Verification & Identity Resolution

### 1. Token Verification Middleware ([`src/middlewares/auth.js`](file:///C:/Users/risha/.gemini/antigravity/scratch/gongo-partner-backend/src/middlewares/auth.js))
- Extracts Bearer token from `Authorization` header.
- Invokes `supabaseProvider.verifyIdToken(token)` using the Supabase Service Role client.
- Decodes the cryptographically signed JWT and extracts:
  - `sub`: Supabase Auth UUID (unique identifier).
  - `phone`: Verified mobile number.
  - `role`: Supabase role (e.g. `authenticated`).

### 2. Trusted Actor Resolution ([`src/repositories/partner.repository.js`](file:///C:/Users/risha/.gemini/antigravity/scratch/gongo-partner-backend/src/repositories/partner.repository.js))
The backend queries the PostgreSQL database using the verified `sub` UUID:
```sql
SELECT 
  p.id AS partner_id,
  p.user_id,
  p.partner_status,
  p.kyc_status,
  u.id AS user_primary_id,
  u.auth_id,
  u.role,
  u.phone
FROM users u
LEFT JOIN partners p ON p.user_id = u.id
WHERE u.auth_id = $1
LIMIT 1;
```

### 3. Attachment of Trusted `req.actor`
The verified identity is attached to the Express request context:
```javascript
req.actor = {
  id: partner.id,            // Partner UUID (used for all BOLA ownership checks)
  userId: user.id,          // Primary User UUID
  authId: decoded.sub,      // Supabase Auth UUID
  phone: decoded.phone,     // Immutable verified mobile
  role: user.role,          // Canonical role (e.g., 'PARTNER', 'ADMIN')
  kycStatus: partner.kyc_status,
  partnerStatus: partner.partner_status,
};
```

---

## 4. Role-Based Access Control (RBAC) & BOLA Prevention

1. **Role Enforcement ([`src/middlewares/roles.js`](file:///C:/Users/risha/.gemini/antigravity/scratch/gongo-partner-backend/src/middlewares/roles.js))**:
   - Routes check `requireRole('PARTNER')` or `requireRole('ADMIN')`.
   - Client-supplied roles in headers, query parameters, or request bodies are strictly stripped and ignored.

2. **Broken Object-Level Authorization (BOLA) Prevention ([`src/middlewares/ownership.js`](file:///C:/Users/risha/.gemini/antigravity/scratch/gongo-partner-backend/src/middlewares/ownership.js))**:
   - Every partner data query (`vehicles`, `shops`, `bookings`, `wallets`, `payouts`) enforces:
     ```sql
     WHERE partner_id = $1
     ```
   - Client cannot access another partner's records by tampering with route UUIDs.

---

## 5. Environment Configuration

The following variables must be configured in `.env`:

```ini
# Supabase Project Credentials
SUPABASE_URL=https://mtfljykvxyslhdvpfcil.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Supabase Storage Configuration
SUPABASE_STORAGE_BUCKET=gongo-partner-documents
SUPABASE_STORAGE_PRESIGN_UPLOAD_EXPIRES_SECONDS=900
SUPABASE_STORAGE_PRESIGN_DOWNLOAD_EXPIRES_SECONDS=300
SUPABASE_STORAGE_MAX_UPLOAD_SIZE_BYTES=10485760
```

---

## 6. Security Guarantees

- **No Shared Secrets on Client**: The `SUPABASE_SERVICE_ROLE_KEY` is strictly confined to the backend server and never sent to clients.
- **Fail-Fast Validation**: Expired, malformed, or tampered tokens return `401 Unauthorized` with structured error codes (`AUTH_INVALID_TOKEN`, `AUTH_TOKEN_EXPIRED`).
- **Account State Verification**: Suspended or deactivated partners (`is_active = false`) are rejected at the authentication layer before executing business logic.
