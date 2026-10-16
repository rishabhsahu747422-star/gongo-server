# GONGO Customer Backend

Production-focused marketplace backend for a vehicle rental platform.

Built with **Node.js**, **Express.js**, **PostgreSQL**, **Redis**, and **Firebase Admin SDK**.

---

## Requirements

- Node.js >= 18.0.0
- npm >= 9.0.0
- PostgreSQL >= 14 (with `pgcrypto` extension support)
- Redis >= 6.0

---

## Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd gongo-customer-backend

# 2. Install dependencies
npm install

# 3. Configure environment variables (see Configuration section below)
cp .env.example .env
```

---

## Configuration

Copy `.env.example` to `.env` and fill in real values. **Never commit `.env`.**

```bash
cp .env.example .env
```

### Required Variables

| Variable | Description | Example |
|---|---|---|
| `NODE_ENV` | Runtime environment | `development` |
| `PORT` | HTTP server port | `3000` |
| `API_VERSION` | API version prefix | `v1` |
| `LOG_LEVEL` | Log verbosity | `http` |
| `CORS_ORIGIN` | Allowed origins (comma-separated) | `http://localhost:3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/gongo_dev` |
| `DB_POOL_MIN` | Min pool connections | `2` |
| `DB_POOL_MAX` | Max pool connections | `10` |
| `DB_IDLE_TIMEOUT_MS` | Idle client timeout in ms | `30000` |
| `DB_CONNECTION_TIMEOUT_MS` | Connection timeout in ms | `10000` |
| `DB_SSL` | Force SSL for DB connection | `false` |
| `REDIS_URL` | Redis URL for OTP state & rate limits | `redis://localhost:6379` |
| `FIREBASE_PROJECT_ID` | Firebase project ID | `your-project` |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email | `...@project.iam.gserviceaccount.com` |
| `FIREBASE_PRIVATE_KEY` | Firebase private key | `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n` |
| `MSG91_AUTH_KEY` | MSG91 API key | `your-auth-key` |
| `MSG91_TEMPLATE_ID` | MSG91 OTP template ID | `your-template-id` |
| `MSG91_SENDER_ID` | MSG91 Sender Header | `GONGOI` |
| `TRUST_PROXY` | Express trust proxy setting (never 'true') | `false` (dev) / `loopback` / `1` |
| `AUTH_OTP_EXPIRY_SECONDS` | OTP validity window | `300` |
| `AUTH_OTP_RESEND_SECONDS` | Cooldown before resending OTP | `30` |
| `AUTH_OTP_MAX_ATTEMPTS` | Maximum failed verification attempts | `5` |
| `AUTH_RATE_LIMIT_PHONE_MAX`| Max OTP requests per phone in window | `5` |
| `AUTH_RATE_LIMIT_IP_MAX` | Max OTP requests per IP in window | `20` |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | Rate limit window in seconds | `3600` |

---

## Customer Authentication (Step 3)

GONGO uses a **Custom OTP + Firebase Custom Token** architecture:
1. The backend handles OTP generation, rate limiting, and SMS delivery via **MSG91**.
2. Temporary OTP state is cryptographically hashed and stored in **Redis** with a strict TTL.
3. Upon successful OTP verification, the user account is created or resolved in PostgreSQL, and the Firebase Admin SDK mints a **Firebase Custom Token** with claims `{ role: 'customer' }`.
4. The client app exchanges the custom token for a Firebase ID token via the Firebase Client SDK (`signInWithCustomToken()`).
5. Protected endpoints verify the Firebase ID token and enforce active user status and role constraints.

### Authentication Endpoints

#### 1. Send OTP
```http
POST /api/v1/auth/send-otp
Content-Type: application/json

{
  "phone": "9876543210",
  "countryCode": "+91"
}
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "data": {
    "verificationId": "550e8400-e29b-41d4-a716-446655440000",
    "expiresIn": 300,
    "resendAfter": 30
  },
  "requestId": "..."
}
```
*Note: The OTP is NEVER returned in the API response or written to logs.*

#### 2. Verify OTP
```http
POST /api/v1/auth/verify-otp
Content-Type: application/json

{
  "verificationId": "550e8400-e29b-41d4-a716-446655440000",
  "otp": "123456"
}
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Authentication successful",
  "data": {
    "customToken": "eyJhbGciOiJSUzI1NiIs...",
    "accessToken": "eyJhbGciOiJSUzI1NiIs...",
    "tokenType": "Bearer",
    "user": {
      "id": "c1f7a634-...",
      "role": "customer",
      "phone": "9876543210",
      "countryCode": "+91",
      "name": null,
      "email": null,
      "isProfileComplete": false
    }
  },
  "requestId": "..."
}
```

#### 3. Refresh Session
```http
POST /api/v1/auth/refresh
Content-Type: application/json

{
  "token": "valid-firebase-id-token"
}
```
**Architecture Note:** Firebase ID tokens expire after 60 minutes and are refreshed automatically by the Firebase Client SDK directly on the client device (e.g. `auth.currentUser.getIdToken(true)`). The backend verifies valid ID tokens and provides safe advisory guidance to prevent insecure server-side workarounds. Expired tokens must be refreshed via the Firebase Client SDK or re-authenticated via OTP.


#### 4. Get Current Profile
```http
GET /api/v1/auth/me
Authorization: Bearer <firebase-id-token>
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Current user profile retrieved",
  "data": {
    "id": "c1f7a634-...",
    "role": "customer",
    "name": null,
    "countryCode": "+91",
    "phone": "9876543210",
    "email": null,
    "isProfileComplete": false,
    "createdAt": "2026-09-14T12:00:00.000Z"
  }
}
```

#### 5. Logout
```http
POST /api/v1/auth/logout
Authorization: Bearer <firebase-id-token>
```
Revokes all Firebase refresh tokens via `admin.auth().revokeRefreshTokens()` and registers immediate session invalidation in Redis.

---

## Authentication Security Controls

1. **Role Enforcement**:
   - Customer authentication flow strictly hardcodes `role = 'customer'`.
   - Client cannot submit `{ role: 'admin' }` or `{ role: 'partner' }` to escalate privileges.
2. **Impersonation Prevention**:
   - Authenticated identity comes strictly from the verified phone number or cryptographically validated Firebase credentials.
   - Client cannot submit a custom `userId` in request bodies.
3. **Cryptographic OTP Security**:
   - Exactly 6 digits generated via Node.js `crypto.randomInt(100000, 1000000)`.
   - Hashed using HMAC-SHA256 before storing in Redis. Plaintext OTPs are never stored.
   - Verified using constant-time comparison (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.
   - Single-use: state is immediately consumed and deleted upon successful verification to prevent replay attacks.
   - Maximum 5 attempts before the verification session is invalidated.
4. **Layered Rate Limiting**:
   - Per-phone sliding window rate limit (default: 5 OTP requests per hour).
   - Per-IP sliding window rate limit (default: 20 OTP requests per hour).
   - Resend cooldown (default: 30 seconds) between requests for the same phone number.
5. **No Secret Leakage**:
   - OTP, auth tokens, Firebase private keys, and MSG91 API keys are never written to log files.
   - Error responses sanitize internal provider and database error details.
6. **Graceful Fail-Closed**:
   - Security-critical rate limiting and attempt counters fail-closed if Redis is unavailable, preventing brute-force bypass.

---

## Customer Profile & Account (Step 4)

Provides personal profile management and document verification foundations for registered customers:
1. **Strict Identity Derivation**: All operations derive the target user strictly from the verified Firebase identity (`req.user.id`).
2. **Anti-IDOR / Anti-Mass Assignment**: Rejects client-supplied `userId`, `role`, `phone`, `authId`, or `isActive` updates.
3. **Safe Allowlisting**: Only safe profile fields (`name`, `email`) are editable via `PATCH /api/v1/customers/me`.
4. **Document Foundation**: Reversible schema (`customer_documents`) for tracking KYC and driving licenses without exposing internal storage keys or raw file blobs.

### Customer Profile Endpoints

#### 1. Get My Profile
```http
GET /api/v1/customers/me
Authorization: Bearer <firebase-id-token>
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Customer profile retrieved",
  "data": {
    "id": "c1f7a634-...",
    "role": "customer",
    "name": "Rishabh Sharma",
    "countryCode": "+91",
    "phone": "9876543210",
    "email": "user@example.com",
    "verificationStatus": {
      "isProfileComplete": true,
      "drivingLicenseStatus": "VERIFIED"
    },
    "createdAt": "2026-09-14T12:00:00.000Z",
    "updatedAt": "2026-09-15T10:00:00.000Z"
  }
}
```

#### 2. Update My Profile
```http
PATCH /api/v1/customers/me
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "name": "Rishabh Sharma",
  "email": "new.email@example.com"
}
```

#### 3. Get My Documents
```http
GET /api/v1/customers/me/documents
Authorization: Bearer <firebase-id-token>
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Customer documents retrieved",
  "data": [
    {
      "id": "90000000-...",
      "documentType": "DRIVING_LICENSE",
      "status": "VERIFIED",
      "rejectionReason": null,
      "verifiedAt": "2026-09-15T12:00:00.000Z",
      "createdAt": "2026-09-15T10:00:00.000Z",
      "updatedAt": "2026-09-15T12:00:00.000Z"
    }
  ]
}
```

#### 4. Get Platform Fee (Checkout)
```http
GET /api/v1/customer/platform-fee
Authorization: Bearer <auth-token>
```
**Response (200 OK):**
```json
{
  "success": true,
  "message": "Active platform fee retrieved successfully",
  "data": {
    "feeType": "fixed",
    "feeValue": 50.00,
    "currency": "INR"
  },
  "requestId": "req-..."
}
```

---

## Database Management & Migrations

Database migrations are managed via **`node-pg-migrate`**. All migrations run within transactional blocks (`BEGIN` / `COMMIT`) and are version-controlled in `database/migrations/`.

```bash
# Run pending migrations (UP)
npm run migrate:up

# Roll back the most recent migration (DOWN)
npm run migrate:down

# Check migration status
npm run migrate:status
```

---

## Running Tests

```bash
# All tests (unit, security, integration, database)
npm test

# Database integration tests only
npm run test:db

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Security tests only
npm run test:security

# With coverage report
npm run test:coverage
```

---

## Linting

```bash
# Check for issues
npm run lint

# Auto-fix what can be fixed
npm run lint:fix
```
