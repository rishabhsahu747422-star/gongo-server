# GONGO Server — Deployment-Hardening Changes

This document summarises the backend changes made during the deployment-readiness audit
(Customer, Partner and Admin APIs served by the unified server in `server/`).

- **Status:** ready for **staging**. Not production-ready: staging, real-PostgreSQL tests and the
  Docker build have not been run, and several business decisions are open (see the end).
- **Nothing was deployed, migrated, backfilled or committed.** No production data was touched.
- Operational details (environment variables, migration and backfill procedures, staging
  checklist) are in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). The database table/column
  inventory is in [`docs/SCHEMA_INVENTORY.md`](docs/SCHEMA_INVENTORY.md).

---

## 1. Unified server (`src/`)

| Change | Why |
|---|---|
| New `src/lifecycle.js`; rewritten `src/server.js` | `npm start` never connected or verified the database/Redis, never started background workers and never closed pools on shutdown. It now verifies every dependency at startup (fatal in production), starts workers once (`ENABLE_WORKERS`), closes everything on SIGTERM/SIGINT and handles unhandled rejections and uncaught exceptions. Configuration errors are reported as one clean `[FATAL]` line. |
| `GET /health/ready` (in `src/routes/index.js`) | Returns 200 only when every sub-app reaches PostgreSQL and Redis, otherwise 503. `/health/live` stays the liveness probe. |
| CORS (`src/app.js`) | Previously allowed every origin. Production now honours the allowlist (`CORS_ORIGINS`, `CORS_ORIGIN`, `CORS_ALLOWED_ORIGINS`); wildcards are dropped. |
| `trust proxy` (`src/app.js`) | Set explicitly from `TRUST_PROXY` (use `1` behind a load balancer). |
| `src/config/env.js` | Removed hardcoded Supabase/DB/Redis defaults; added `HOST`, `TRUST_PROXY`, `ENABLE_WORKERS`. |
| `src/routes/admin.routes.js` | The Admin franchise screen returned 404 because `/admin/franchise-applications` was routed to the public router. |
| `src/routes/index.js` | Legacy `/api/v1/auth` paths are dispatched by first path segment instead of substring matching. |

## 2. Customer API

**Payments (`services/payment.service.js`, `payment/providers/cashfree.provider.js`)**
- Removed the hardcoded fallback Cashfree secret (webhooks were forgeable when no secret was set).
- Webhook simulation and the dev payment bypass are refused in production.
- A late payment for a cancelled or expired booking no longer re-confirms the booking. It now
  creates one idempotent `refunds` row (status `requested`) in the Admin refund queue.
- Payment polling now runs the same locked code path as the webhook (`_applyPaymentSuccess`), so
  earnings, vehicle status and notifications apply exactly once, whichever arrives first.
- Best-effort steps inside the webhook transaction run under savepoints, so a failure there can no
  longer silently roll back the payment update.
- Removed a query reference to the non-existent `bookings.rental_amount` column.

**Authentication (`providers/supabase.js`, `middleware/auth.middleware.js`, `middleware/cors.js`)**
- Fixed a 30-day lockout after logout (Supabase tokens had no issued-at time).
- Accounts are no longer auto-created with an invented phone number.
- A non-JWT bearer token that is not a live session is rejected locally instead of calling Supabase.
- Unlisted CORS origins get 403 instead of 500.

**Vehicles and bookings (`repositories/vehicle.repository.js`, `repositories/booking.repository.js`, `services/availability.service.js`)**
- Search, detail, nearby, cities and booking eligibility exclude admin-held vehicles
  (`is_active = false`), as well as archived and OFFLINE vehicles.
- Booking creation re-checks eligibility on the locked vehicle row. Booking history is unaffected.
- Fixed two fallback queries that could never succeed (`ratings`, category `slug`).

**Configuration (`config/env.js`, `config/logger.js`)**
- Production refuses to start with placeholder Cashfree keys, dev auth or dev payment flags,
  the Redis mock, or a missing Supabase URL or service-role key.
- No log file is written in production.

## 3. Partner API

**Vehicles (`services/vehicle.service.js`, `repositories/vehicle.repository.js`, `services/booking.service.js`, `controllers/vehicle.controller.js`)**
- A vehicle can go ONLINE only if it is VERIFIED/APPROVED, not archived and not held by an admin.
  This is enforced in the service and atomically in the SQL. The `manualStatus` field could
  previously bypass the PENDING check.
- **New vehicles are created OFFLINE** (they start PENDING).
- Pickup no longer un-archives admin-deactivated vehicles.
- Fixed a crash from a missing `storageService` import.

**Wallet and payouts**
- **Ledger readers** (`constants/wallet.js`, `repositories/wallet-transaction.repository.js`,
  `services/reconciliation.service.js`, `services/wallet.service.js`): the ledger stores lowercase
  values (`credit`, `booking`, `admin_adjustment`). Readers compared against uppercase names and
  never matched, so the settlement idempotency check was broken and a replayed settlement could
  credit twice. One mapping table is now used by the writer and all readers. API output still
  uses `CREDIT`/`DEBIT`.
- **Recalculation** (`services/wallet.service.js`): the wallet recalculation now includes Admin
  manual adjustments, which it previously erased.
- **Payout requests** (`services/payout.service.js`):
  - the idempotency key is re-checked after the wallet row lock, so two simultaneous duplicate
    requests can no longer hold funds twice;
  - the `partner_wallets` mirror is copied rather than debited again (in the live layout `wallets`
    is a view over `partner_wallets`);
  - the mirror update runs under a savepoint.
- **Reconciliation:** `reference_id` comparisons are cast so they work with the live UUID column.
- **Background work:**
  - the outbox worker only claims Partner events (it used to consume Admin's);
  - each event runs under its own savepoint;
  - the commission lock on return completion runs under a savepoint.

**Auth (`providers/supabase.js`, `controllers/auth.controller.js`)**
- `dev-` tokens are rejected in production.
- Registration no longer turns a Supabase JWT into a new 30-day session.

**Migration (prepared, not executed)**
- `database/migrations/049_add_is_active_to_vehicles.js` adds `vehicles.is_active` when it is
  missing. It only ever sets `false`, and only for archived vehicles. On live it is a no-op for
  the column.

## 4. Admin API

**Authentication (`services/admin-auth.service.js`, `services/otp.service.js`, `middlewares/auth.js`, `providers/supabase.js`)**
- Real admins were rejected because roles are stored lowercase. Fixed.
- The password check always failed because the user lookup did not select `email`. Fixed.
- OTP codes are verified with Supabase (the code checked before was never sent).
- Supabase identities are linked by confirmed email or phone only, never to an account already
  bound to another identity.
- OTP SMS is sent only to numbers of active admins. Other numbers get the same response shape
  but no SMS.
- The `123456` dev OTP requires `ADMIN_DEV_AUTH_ENABLED`.

**Users (`services/admin-user.service.js`)**
- New admins require an initial password (there was a known default password).

**Wallets and payouts (`services/admin-wallet.service.js`, `repositories/admin-wallet.repository.js`, `controllers/admin-wallet.controller.js`)**
- **Payout model:** the amount is held when the partner requests the payout.
  - *mark-paid* no longer deducts a second time;
  - *reject* releases the hold;
  - *retry* re-applies it.
- **Manual adjustments** (`POST /wallets/:id/adjust`):
  - require a UUID `Idempotency-Key`;
  - apply once (same key and payload → original result; same key, different payload → 409);
  - are recorded in the ledger with amount, direction, reason, key and acting admin;
  - survive recalculation.
- **Wallet list and detail** failed on every request (`users.full_name`/`phone_number` do not
  exist). Fixed.
- **Ledger writer:** rejects invalid directions and missing reference ids; `wallet_id` points to
  the `wallets` row.

**Audit attribution (new `src/security/financial-actor.js`)**
- Payout, refund and wallet actions record the acting admin's own `users.id`. The "pick any
  admin" fallback is removed.
- If the actor cannot be resolved, the action is refused with 403 `ADMIN_ACTOR_UNRESOLVED`.

**Payments (`services/admin-payment.service.js`)**
- Refunds work for payments stored as `paid`.
- Payout retry works with lowercase statuses.

**Disputes (`services/admin-damage-dispute.service.js`)**
- Wallet deductions failed against the live CHECK constraints and called the wallet lock with
  reversed arguments. They are now recorded as `admin_adjustment` ledger rows and survive
  recalculation.

**Vehicles (`services/admin-vehicle.service.js`, `repositories/admin-vehicle.repository.js`)**

| Action | Result |
|---|---|
| block | OFFLINE + admin hold (`is_active = false`); temporary |
| deactivate | OFFLINE + hold + `is_archived = true` |
| activate | REJECTED → 409; VERIFIED/APPROVED → ONLINE; otherwise the hold is lifted and the vehicle stays OFFLINE |

- `PATCH /:id/status` can no longer set ONLINE for blocked, archived, inactive, PENDING or REJECTED
  vehicles, and cannot lift holds.
- All actions lock the vehicle row inside a transaction.
- Existing bookings are never cancelled; the response reports `existingActiveBookings`.
- The reason is stored in `offline_reason` and no longer overwrites the verification rejection reason.

**Background work (`repositories/admin-outbox.repository.js`)**
- The outbox worker only claims Admin events.

## 5. Deployment files (new)

| File | Purpose |
|---|---|
| `Dockerfile`, `.dockerignore` | Production image for the unified server (`node src/server.js`, non-root, no `.env` baked in). **Build not yet verified.** |
| `.env.example` | Every variable, with placeholders only. |
| `docs/DEPLOYMENT.md` | Runbook: runtime, environment, read-only schema checks, migrations 048/049, optional AD-2 relabel, staging checklist, rollback. |
| `docs/SCHEMA_INVENTORY.md` | Which tables/columns come from migrations versus the live Supabase baseline. A fresh database cannot be built from repository migrations alone. |

## 6. Tests

| Suite | Command | Result |
|---|---|---|
| Unified | `npx jest tests --runInBand --forceExit` (in `server/`) | 80/80 |
| Customer | `cd Customer && npx jest --runInBand --forceExit` | 867/867 |
| Partner | `cd Partner && npx jest --runInBand --forceExit` | 1116/1116 |
| Admin | `cd Admin && npx jest --runInBand --forceExit` | 1610/1610 |

**New test files**
- Unified: `tests/integration/production-mode.test.js` (production CORS, headers, 401/404, dev
  bypasses off, test routes not mounted)
- Customer:
  - `tests/unit/services/payment.production-guards.test.js`
  - `tests/integration/vehicleLifecycleEligibility.test.js`
  - `tests/helpers/relativeDates.js` (fixed dates replaced with dates relative to today; the suite
    passes with the clock set to 2027-01-02 and 2028-06-15)
- Partner: `tests/unit/wallet.recalculation-adjustments.test.js`
- Admin:
  - `tests/integration/admin-wallet-ledger-integrity.test.js`
  - `tests/unit/admin-vehicle-lifecycle.test.js`

**Other test changes**
- Many existing test files gained regression cases.
- Where an existing expectation encoded a confirmed bug, it was corrected and the change
  explained in the test.

**Real-PostgreSQL tests (not yet run)**
- `Admin/tests/postgres/wallet-concurrency.pgtest.js` covers row locks, races and real rollback.
- It is excluded from `npm test`. Run it against a disposable database:
  `TEST_PG_URL=… npm run test:pg`.
- The in-memory test database (pg-mem) cannot verify locks or rollback.

## 7. Work that was already in progress (preserved, not authored here)

These files had uncommitted changes before this work started. They were kept as-is, apart from
bug fixes noted above:
- Partner vehicle pricing history (`pricing.*`, migration `048_add_changed_by_to_vehicle_pricing_history.js`)
- Customer auth changes (`auth.controller.js`, `auth.service.js`, `customer-auth.service.js`, `firebase-auth.service.js`)
- Customer payment route changes (`routes/payments.js`, `payment.controller.js`)
- Admin dev-auth, route-permission and user-management changes (`config/env.js`,
  `admin-*.routes.js`, `admin-permission.service.js`)
- The tests `Admin/tests/integration/dev-auth-disabled.test.js` and `tests/integration/webhook-raw-body.test.js`

## 8. Before production

**Blockers**
1. Build the Docker image.
2. Run the staging checklist (`docs/DEPLOYMENT.md` §3d).
3. Run `npm run test:pg` against a disposable PostgreSQL database.
4. Run the read-only schema checks (`docs/SCHEMA_INVENTORY.md` §7).
5. Apply migrations 048 and 049 on staging (single-migration procedure in `DEPLOYMENT.md` §3b).

**Business decisions needed**
- New vehicles start OFFLINE. Should admin approval switch them ONLINE automatically? (The
  Partner app text about pending vehicles is now inaccurate.)
- What to do with existing PENDING+ONLINE vehicles in customer listings.
- Whether rejection or a document re-upload should force a vehicle OFFLINE.
- An expiry window for unpaid bookings (none exists today).
- **Admin 2FA** is documented as required (`ENFORCE_2FA`) but not enforced. The admin web app
  logs in with a Supabase password token; enforcing 2FA needs a frontend change.
- Whether regular admins may create super_admins.
- Permissions for coupon and offer management.
- Finance sign-off on the payout hold/release model.
