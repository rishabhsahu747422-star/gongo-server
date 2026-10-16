# Admin Authentication (Backend)

Admin Portal sign-in is handled entirely by this backend:

| Method | Endpoint |
| --- | --- |
| Email + password + mandatory SMS OTP | `POST /api/v1/admin/auth/login` → `POST /api/v1/admin/auth/verify-2fa` |
| Mobile number + password + mandatory SMS OTP | `POST /api/v1/admin/auth/login` → `POST /api/v1/admin/auth/verify-2fa` |
| Google OAuth (Authorization Code + PKCE) | `GET /api/v1/admin/auth/google` → callback → `POST /api/v1/admin/auth/google/exchange` |

All routes are also mounted under `/api/admin/...` (same handlers).

Every completed sign-in produces the same thing: a **server-side admin session**. The client receives
an opaque 256-bit token; only its SHA-256 hash is stored in `admin_sessions`. The token is sent
as `Authorization: Bearer <token>` and can be revoked at any time (logout, logout-all,
password change, account disable). Third-party tokens (Supabase JWTs, Google ID tokens) are
never accepted by the Admin API directly. Because credentials travel in a header rather than a
cookie, CSRF does not apply to the API; the only cookie is the short-lived, HttpOnly
OAuth browser-binding cookie used during Google sign-in.

Admin Supabase mobile-OTP login and all development auth bypasses have been removed.
Customer and Partner authentication (separate servers) are unaffected.

---

## 1. Data model

| Table | Purpose |
| --- | --- |
| `users` (existing) | Account, `role` (`admin`, `super_admin`, `support_executive`), `status`/`is_active`, email, phone |
| `admin_permissions` (existing) | Granular permissions; `SUPER_ADMIN` grants everything |
| `admin_sessions` (existing) | Hashed session tokens, expiry, revocation |
| `admin_credentials` (migration 056) | scrypt password hash, `must_change_password`, failed-attempt counter, `locked_until` |
| `admin_oauth_identities` (migration 056) | Explicit admin ↔ Google `sub` links (unique per subject and per admin) |

The new tables have RLS enabled with no policies (deny-all through Supabase's API) and API-role
grants revoked. The backend connects as the database owner and is unaffected.

Passwords are hashed with Node's built-in scrypt (N=2^15, r=8, p=1, 16-byte salt, 64-byte key).
Users with role `super_admin` always carry the `SUPER_ADMIN` permission.

---

## 2. API contract (for the Admin frontend)

All responses use the standard envelope: `{ "status": "success", "data": {...} }` or
`{ "status": "error", "error": { "code", "message", "requestId" } }`.

### 2.1 `POST /api/v1/admin/auth/login` (Password Verification & OTP Challenge Initiation)

```http
POST /api/v1/admin/auth/login
Content-Type: application/json

{ "identifier": "gongorental@gmail.com", "password": "<password>" }
```

`identifier` may be an email (case-insensitive) or an Indian mobile number in any common
format: `8989232398`, `08989232398`, `+91 89892 32398`, `91-8989232398`.

When credentials are valid, the backend creates a short-lived OTP challenge, dispatches a 6-digit numeric OTP via the Renflair SMS Gateway to the verified administrator mobile number on file, and returns:

`200 OK`
```json
{
  "status": "success",
  "data": {
    "step": "OTP_PENDING",
    "challengeId": "1b3a…base64url challenge identifier…",
    "phoneMasked": "+91 ******2398",
    "expiresIn": 300
  }
}
```

> **Security Note:** Password login NEVER returns an authenticated session or bearer token directly. Access to protected administrator endpoints is strictly blocked until step 2.2 (`/verify-2fa`) succeeds.

Errors

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Missing identifier/password, malformed identifier, or identity fields (`role`, `userId`, `permissions`, …) in the body |
| 401 | `INVALID_CREDENTIALS` | Wrong password, unknown identifier, non-admin account, or temporarily locked account — always the same message: `Invalid credentials` |
| 403 | `ACCOUNT_DEACTIVATED` | Correct password but the admin account is disabled |
| 403 | `FORBIDDEN` | Admin account lacks a verified 10-digit mobile number for OTP dispatch |
| 429 | `RATE_LIMIT_EXCEEDED` | More than 10 auth requests / 15 min from one IP (`Retry-After` header set) |

After `ADMIN_LOGIN_MAX_FAILED_ATTEMPTS` (default 5) wrong passwords the account is locked for
`ADMIN_LOGIN_LOCKOUT_SECONDS` (default 900). During the lock even the correct password returns
the generic 401.

### 2.2 `POST /api/v1/admin/auth/verify-2fa` (Mandatory SMS OTP Verification & Session Issuance)

```http
POST /api/v1/admin/auth/verify-2fa
Content-Type: application/json

{ "challengeId": "1b3a…", "otp": "482910" }
```
*(Accepts `challengeId`, `tempToken`, or `sessionId` for backward frontend compatibility).*

`200 OK`
```json
{
  "status": "success",
  "data": {
    "step": "AUTHENTICATED",
    "tokenType": "Bearer",
    "token": "9f2c…64 hex chars…",
    "expiresAt": "2026-10-15T10:00:00.000Z",
    "passwordChangeRequired": false,
    "user": {
      "id": "6f1c…",
      "name": "GONGO Super Admin",
      "email": "gongorental@gmail.com",
      "phone": "8989232398",
      "role": "super_admin",
      "status": "active",
      "permissions": ["SUPER_ADMIN"]
    }
  }
}
```

Errors:
| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Missing or invalid challenge identifier or non-6-digit OTP |
| 401 | `INVALID_CREDENTIALS` | Incorrect passcode (includes remaining attempts count) |
| 401 | `TOKEN_EXPIRED` | Challenge expired, replayed (already consumed), or locked out after max failed attempts |
| 403 | `ACCOUNT_DEACTIVATED` | Admin account was deactivated |

### 2.3 `POST /api/v1/admin/auth/resend-2fa` (OTP Resend with Rate-Limiting Cooldown)

```http
POST /api/v1/admin/auth/resend-2fa
Content-Type: application/json

{ "challengeId": "1b3a…" }
```

Enforces a 60-second cooldown per challenge. Resending dispatches a new random OTP and immediately invalidates any prior OTP for this challenge.

`200 OK`
```json
{
  "status": "success",
  "data": {
    "message": "A new verification passcode has been dispatched.",
    "cooldownRemaining": 60
  }
}
```

### 2.4 `GET /api/v1/admin/auth/me`

```http
GET /api/v1/admin/auth/me
Authorization: Bearer <token>
```
`200 OK`
```json
{
  "status": "success",
  "data": {
    "user": { "id": "…", "name": "…", "email": "…", "phone": "…", "role": "admin", "status": "active", "permissions": ["vehicles.read"] },
    "session": { "id": "…", "expiresAt": "…", "lastActiveAt": "…", "createdAt": "…", "ipAddress": "…", "userAgent": "…" }
  }
}
```
`401` `AUTH_REQUIRED` / `INVALID_TOKEN` / `TOKEN_EXPIRED` / `TOKEN_REVOKED`; `403` `ACCOUNT_DEACTIVATED`.

### 2.5 `POST /api/v1/admin/auth/logout` · `POST /api/v1/admin/auth/logout-all`

`Authorization: Bearer <token>`, no body. Revokes the current session (or all of the admin's
sessions). The token is rejected immediately afterwards (`401 TOKEN_REVOKED`).
`logout-all` returns `{ "message": "…", "revokedCount": 3 }`.

### 2.6 `POST /api/v1/admin/auth/refresh`

`Authorization: Bearer <token>`. Revokes the presented session and returns a new one (same
shape as login). Sessions have a fixed lifetime (`ADMIN_SESSION_TTL_SECONDS`, default 24 h).

### 2.7 `POST /api/v1/admin/auth/password/change`

```json
{ "currentPassword": "…", "newPassword": "…" }
```
Policy: at least 12 characters and three of lowercase / uppercase / digit / symbol.
On success: `{ "message": "Password changed successfully", "revokedSessions": 2 }` — all other
sessions of this admin are revoked; the current one stays valid.
`403 INVALID_CREDENTIALS` for a wrong current password (counts toward lockout), `400` for policy violations.

### 2.8 Google sign-in

```
Portal                         Backend                                    Google
  │ GET /admin/auth/google/status ─► { enabled: true|false }
  │ window.location = API/admin/auth/google
  │──────────────────────────────► 302 → accounts.google.com (state, nonce, PKCE S256)
  │                                 + HttpOnly cookie binding the browser to the state
  │◄──────────────────────────────────────────────────────────────── user signs in
  │                               GET /admin/auth/google/callback?code&state
  │                                 • state: single-use, unexpired, matches cookie
  │                                 • code exchanged server-side with PKCE verifier + client secret
  │                                 • ID token: RS256 signature (Google JWKS), iss, aud/azp, exp, iat, nonce, email_verified
  │                                 • Matches existing active administrator account (by linked sub or verified email)
  │                                 • Admin account must be active with authorized role
  │◄──── 302 ADMIN_OAUTH_REDIRECT_URL#ticket=<one-time, 60 s>   (or #error=<code>)
  │ POST /admin/auth/google/exchange { "ticket": "…" }
  │──────────────────────────────► OTP challenge (if OTP configured) or session response
```

The ticket is in the URL **fragment**, so it never reaches a server log or Referer header. The
portal page at `ADMIN_OAUTH_REDIRECT_URL` reads `location.hash`, clears it with
`history.replaceState`, and POSTs the ticket to `/google/exchange`.

Upon verified identity matching an active Admin account, `/google/exchange` directly establishes the authentic administrator session (`step: 'AUTHENTICATED'`) without requiring secondary SMS OTP verification, and the frontend navigates directly to the Admin Dashboard. Password login continues to enforce mandatory SMS OTP challenges.

Possible `#error=` values: `invalid_state`, `access_denied`, `invalid_request`,
`google_verification_failed`, `email_not_verified`, `account_not_authorized`,
`account_disabled`, `identity_already_linked`, `session_expired`, `temporarily_unavailable`.

If Google OAuth is not configured, `/google`, `/google/callback`, `/google/exchange` and
`/google/link` return `503 OAUTH_NOT_CONFIGURED`, and `/google/status` returns `{ "enabled": false }`.

**Account Verification and Linking:**
1. A verified Google identity matching a pre-existing, active administrator account (`users.email` with role `super_admin`, `admin`, or `support_executive`) is recognized and mapped to that account.
2. The Google subject is automatically linked in `admin_oauth_identities` upon verified match.
3. An active administrator can also manually link or step-up link their Google account while signed in:

```http
POST /api/v1/admin/auth/google/link
Authorization: Bearer <token>
Content-Type: application/json

{ "password": "<current password>" }
```
`200 OK` → `{ "authorizationUrl": "https://accounts.google.com/…", "expiresIn": 600 }`.
The portal navigates to `authorizationUrl`; Google returns to the callback, which redirects to
`ADMIN_OAUTH_REDIRECT_URL#linked=google` (or `#error=…`). Linking requires the current password
(step-up), fails if the session was revoked in the meantime, refuses a Google account already
linked to another admin, and allows one Google account per admin (`409` if one is already linked).

---

## 3. Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `ADMIN_SESSION_TTL_SECONDS` | no | `86400` | Fixed session lifetime |
| `ADMIN_MAX_ACTIVE_SESSIONS` | no | `5` | Oldest sessions are revoked beyond this |
| `ADMIN_LOGIN_MAX_FAILED_ATTEMPTS` | no | `5` | Wrong passwords before lockout |
| `ADMIN_LOGIN_LOCKOUT_SECONDS` | no | `900` | Lock duration |
| `ADMIN_LEGACY_SUPABASE_PASSWORD_MIGRATION` | no | `true` | See §5 |
| `GOOGLE_CLIENT_ID` | for Google | – | OAuth 2.0 *Web application* client ID |
| `GOOGLE_CLIENT_SECRET` | for Google | – | Never sent to the browser or logged |
| `GOOGLE_CALLBACK_URL` | for Google | – | Exactly as registered in Google Cloud |
| `ADMIN_OAUTH_REDIRECT_URL` | for Google | – | Portal page receiving `#ticket=` / `#error=` |
| `GOOGLE_OAUTH_STATE_TTL_SECONDS` | no | `600` | Pending sign-in lifetime |
| `SUPER_ADMIN_INITIAL_PASSWORD` | seed only | – | Read only by the seed command; never put it in `.env` |

Startup validation (production): the four Google variables must be all set or all empty, callback
and portal URLs must be `https`, and a leftover `ADMIN_DEV_AUTH_ENABLED=true` aborts startup.
Redis is required in production (OAuth state/tickets and rate limits live there).

### Google Cloud Console setup

1. APIs & Services → OAuth consent screen: configure (Internal if all admins use a Google
   Workspace domain; otherwise External with the needed test users / verification).
2. Credentials → Create credentials → OAuth client ID → **Web application**.
3. Authorized redirect URI: the exact `GOOGLE_CALLBACK_URL`, e.g.
   `https://api.gongo.in/api/v1/admin/auth/google/callback` (and
   `http://localhost:3002/api/v1/admin/auth/google/callback` for local development).
4. Put the client ID/secret into the backend's secret store, set `GOOGLE_CALLBACK_URL` and
   `ADMIN_OAUTH_REDIRECT_URL`, restart, and check `GET /api/v1/admin/auth/google/status`.

The browser must reach `/google` and `/google/callback` on the **same API host**, because the
browser-binding cookie is host-only (`__Host-` prefixed in production).

---

## 4. Database migration and Super Admin initialization

```bash
cd server/Admin
npm run db:migrate:status
npm run db:migrate                      # applies 056_create_admin_credentials_and_oauth_identities
```

The migration is additive (two new tables, one index on `LOWER(users.email)`). Apply it to
staging first; take a backup before applying to production.

Initial Super Admin (`gongorental@gmail.com`, mobile `8989232398`, role `super_admin`):

```bash
# 1. Preview (rolls back)
npm run db:seed:super-admin -- --dry-run

# 2. Provision the account and set a one-time initial password (bash)
read -rs SUPER_ADMIN_INITIAL_PASSWORD && export SUPER_ADMIN_INITIAL_PASSWORD
npm run db:seed:super-admin
unset SUPER_ADMIN_INITIAL_PASSWORD
```

The seed is safe to re-run:

- creates the `users` row if missing (email lowercased, mobile stored as 10 digits, `status=active`);
- grants the `SUPER_ADMIN` permission once;
- sets a password **only if the account has none**, stored as a scrypt hash with
  `must_change_password=true`; an existing password is never overwritten;
- refuses to promote or re-activate an existing account (e.g. a customer who registered with
  that email) unless the operator passes that account's exact id: `--confirm-user-id=<uuid>`;
- refuses if the mobile number belongs to a different account;
- never prints or logs the password.

Then sign in (email or mobile + initial password), change the password via
`POST /auth/password/change`, and optionally link Google via `POST /auth/google/link`.

To add more admins, a Super Admin uses `POST /api/v1/admin/users` (initial password required,
stored hashed, flagged for change). Only Super Admins can create or promote `super_admin` accounts.

---

## 5. Existing admins provisioned in Supabase Auth

Admins created before this change have their password in Supabase Auth, not in
`admin_credentials`. With `ADMIN_LEGACY_SUPABASE_PASSWORD_MIGRATION=true`, their first password
login verifies the password with Supabase **for the exact auth account bound to the admin row
(`users.auth_id`)** and stores a local scrypt hash; afterwards Supabase is no longer consulted.
Once every admin has signed in, set the flag to `false`.

---

## 6. Removed

- `POST /admin/auth/otp/send`, `/otp/verify`, `/mobile/login`, `/verify-2fa` (Admin SMS OTP / 2FA)
- Supabase JWTs accepted directly as admin credentials (middleware and `/login`)
- `ADMIN_DEV_AUTH_ENABLED` and everything it unlocked: `dev-*` session tokens, fallback
  "Chief Operations Admin" profiles, in-memory sessions, OTP `123456`, metadata-based roles,
  unattributed financial actions
- `src/services/otp.service.js`, `scripts/test-dev-endpoints.js`
- Env vars `AUTH_OTP_EXPIRY_SECONDS`, `AUTH_OTP_MAX_ATTEMPTS`, `AUTH_OTP_RESEND_COOLDOWN_SECONDS`, `ENFORCE_2FA`

---

## 7. Authorization follow-ups

Every Admin route requires a valid session and the server-side `admin`/`super_admin` role
(`support_executive` is currently rejected at the gateway). These route groups have **no
granular permission check**, so any admin can use them; they should get `requirePermission(...)`
in a later pass:

- `admin-coupon.routes.js` — list/create/update/delete coupons
- `admin-offer.routes.js` — offers and their vehicle/shop assignments
- `admin-review.routes.js` — review moderation and report resolution
- `admin-agreement.routes.js` — rental agreement reads

`admin-profile.routes.js` is self-service (own profile and sessions) and does not need one.
