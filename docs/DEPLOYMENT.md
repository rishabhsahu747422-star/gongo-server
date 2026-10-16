# GONGO Unified Backend — Deployment Runbook

The unified server (`npm start` → `node src/server.js`) mounts the Customer, Partner and Admin
sub-apps under `/api/v1/customer`, `/api/v1/partner` and `/api/v1/admin` in one process.
No hosting provider is fixed by the repository (README lists Railway / Render / AWS); the
`Dockerfile` in this directory works on any container platform, and the same commands work on a
managed Node.js platform.

## 1. Runtime

| Item | Value |
| --- | --- |
| Node.js | 20 LTS (engines: `>=18`) |
| Install | `npm ci --omit=dev` in `server/` (root lockfile; sub-apps have no separate install) |
| Build | none |
| Start | `npm start` (= `node src/server.js`) |
| Port | `$PORT` (default 8080), bound to `$HOST` (default `0.0.0.0`) |
| Liveness | `GET /health/live` (process up) |
| Readiness | `GET /health/ready` — 200 only if all three sub-apps reach PostgreSQL and Redis, else 503 |
| Shutdown | SIGTERM/SIGINT: stop accepting, drain, stop workers, close Redis + DB pools (10 s cap) |

Container: `docker build -t gongo-api .` from `server/`. The image runs as the non-root `node` user
and sets `NODE_ENV=production`.

## 2. Environment

See `.env.example` for every variable (placeholders only). Production startup **fails** if any
`[REQUIRED]` value is missing, if a Cashfree placeholder is used, or if any dev shortcut flag is on.

Critical:
- `NODE_ENV=production` exactly. Any other value enables development auth shortcuts.
- `TRUST_PROXY=1` (or the real hop count). Unset → every user shares one rate-limit bucket (OTP
  lockouts); `true` is rejected by the sub-app validators.
- `CORS_ORIGINS`, `CORS_ORIGIN`, `CORS_ALLOWED_ORIGINS`: the same list of browser origins
  (Admin web panel). Mobile apps need no CORS entry.
- `DB_POOL_MAX`: each sub-app opens its own pool, so one instance uses up to 3 × `DB_POOL_MAX`
  connections. Size against the Supabase pooler limit × instance count.
- `ENABLE_WORKERS` (default true): runs no-show auto-cancellation and the Partner/Admin outbox
  workers. They use `FOR UPDATE SKIP LOCKED` and partition `outbox_events` by event type, so
  several instances are safe.

## 3. Database — before the first deploy of this version

Migrations never run on startup. Nothing in this repository has been run against the live database.

### 3a. Verify the live schema (read-only, Supabase SQL Editor)

```sql
-- Columns the code depends on
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name, column_name) IN (
    ('vehicles','is_active'), ('vehicles','is_archived'), ('vehicles','is_available'),
    ('vehicles','manual_status'), ('vehicle_pricing_history','changed_by'),
    ('bookings','booking_reference'), ('outbox_events','aggregate_type'),
    ('users','email'), ('users','is_active'))
ORDER BY 1, 2;

-- vehicles.is_active default MUST be true or NULL (a false default would block partners
-- from putting new vehicles ONLINE — see AD-2 below)
SELECT column_default FROM information_schema.columns
WHERE table_schema='public' AND table_name='vehicles' AND column_name='is_active';

-- Applied Partner/Admin migrations
SELECT name, executed_at FROM schema_migrations ORDER BY name DESC LIMIT 20;

-- Admin role values actually stored (expected lowercase)
SELECT role, count(*) FROM users GROUP BY role;

-- Vehicles admin-deactivated before the AD-2 fix (is_active=false but not archived)
SELECT count(*) FROM vehicles WHERE is_active = false AND is_archived IS NOT TRUE;

-- Wallet layout: is `wallets` a VIEW over partner_wallets (Supabase alignment) or a table?
-- The code works for both (balances are written to wallets, then COPIED to partner_wallets).
SELECT table_name, table_type FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('wallets', 'partner_wallets', 'wallet_transactions');

-- Ledger constraints and stored vocabulary. Both apps write direction 'credit'/'debit',
-- transaction_type 'booking_earning'/'payout'/'refund_adjustment'/'admin_adjustment',
-- reference_type 'booking'/'payout'/'refund'/'admin'. Any CHECK must accept these.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.wallet_transactions'::regclass;
SELECT direction, transaction_type, reference_type, count(*) FROM wallet_transactions GROUP BY 1, 2, 3 ORDER BY 4 DESC;

-- Payout idempotency index (Partner requests also re-check the key under the wallet lock)
SELECT indexdef FROM pg_indexes WHERE tablename = 'partner_payouts';

-- Payments captured for bookings that are no longer confirmable (manual refund queue)
SELECT p.id, p.booking_id, p.amount, b.status
FROM payments p JOIN bookings b ON b.id = p.booking_id
WHERE lower(p.status) IN ('paid','success')
  AND lower(b.status) ~ '^(cancel|expired|no_show)';
```

### 3b. Apply Partner migration 048 (staging first, then production, with a backup)

Partner migration `048_add_changed_by_to_vehicle_pricing_history.js` must be applied **before**
deploying this code: the pricing endpoints insert/select `changed_by` and return 500 without it.
Its full SQL is:

```sql
ALTER TABLE vehicle_pricing_history
ADD COLUMN IF NOT EXISTS changed_by UUID REFERENCES users(id) ON DELETE SET NULL;
```

Safety: additive, idempotent, nullable (no rewrite of existing rows; all values start NULL so the
foreign key validates instantly). Takes a brief `ACCESS EXCLUSIVE` lock on
`vehicle_pricing_history` only. Prerequisites: tables `vehicle_pricing_history` (Partner 012) and
`users` exist — check with:

```sql
SELECT to_regclass('public.vehicle_pricing_history') AS pricing_history, to_regclass('public.users') AS users;
```

**Do not blindly run `npm run db:migrate`.** The Partner migrator applies *every* Partner migration
whose filename is missing from `schema_migrations`, not just 048. If the live database was built
another way (Supabase SQL editor, Customer's node-pg-migrate) that table may be incomplete and the
command would re-run older migrations (some drop/re-add constraints) against live data.

```bash
cd server/Partner && DATABASE_URL=<staging-url> npm run db:migrate:status
```

- If the **only** pending entry is `048_add_changed_by_to_vehicle_pricing_history.js`:
  `DATABASE_URL=<staging-url> npm run db:migrate`.
- Otherwise: stop, run the SQL above manually in the SQL editor, then record it so the migrator
  stays consistent:
  `INSERT INTO schema_migrations (name) VALUES ('048_add_changed_by_to_vehicle_pricing_history.js') ON CONFLICT (name) DO NOTHING;`
  and investigate the other "pending" entries separately before ever running `db:migrate` there.

Rollback: `ALTER TABLE vehicle_pricing_history DROP COLUMN IF EXISTS changed_by;` and
`DELETE FROM schema_migrations WHERE name = '048_add_changed_by_to_vehicle_pricing_history.js';`
(loses recorded pricing-change authors; the code must be rolled back first).

### 3b-2. Partner migration 049 — `vehicles.is_active` (prepared, NOT executed)

`049_add_is_active_to_vehicles.js` exists so databases built from repository migrations have the
admin-hold column that Admin writes and Partner/Customer read. Live check (read-only):

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'vehicles' AND column_name IN ('is_active', 'is_archived', 'manual_status', 'offline_reason', 'rejection_reason');
```

The pre-alignment live snapshot (`Customer/scripts/supabase_schema.json`) shows
`vehicles.is_active boolean NOT NULL DEFAULT true`, so on live 049's `ADD COLUMN IF NOT EXISTS`
is a no-op; its only effect is `UPDATE vehicles SET is_active = false WHERE is_archived = true AND
(is_active IS NULL OR is_active = true)` — it only ever adds a hold to already-archived vehicles,
never reactivates anything. Preview its row count first (read-only):
`SELECT count(*) FROM vehicles WHERE is_archived = true AND (is_active IS NULL OR is_active = true);`
Apply it with the same single-migration procedure as 048 (§3b). Its `down` is intentionally a
no-op (dropping the column would erase admin holds).

Staging validation: after applying, `SELECT count(*) FROM vehicles WHERE is_archived = true AND is_active IS NOT FALSE;` must be 0,
and Customer search must not return any `is_active = false` vehicle.

### 3c. One-time AD-2 backfill (requires sign-off; changes production data)

**Is it still required?** No longer for safety. Before this release, Admin *deactivate* (and
`PATCH /vehicles/:id/status` with `isArchived: true`) wrote only `vehicles.is_active = false`,
which Customer and Partner did not check, so those vehicles stayed bookable and could be put back
ONLINE by the partner. From this release, Partner refuses ONLINE and Customer excludes vehicles
with `is_active = false`, so legacy-deactivated vehicles are treated as an **admin hold** (not
bookable, not re-listable) without any data change. The backfill only re-labels them as
**archived** (permanent) instead of **held** (liftable by Admin → Activate). Run it only if the
business wants that distinction for legacy rows.

**Who writes `is_active = false`** (verified in code): before this release only Admin actions —
`DEACTIVATE_VEHICLE` and `PATCH /status` archive (`VEHICLE_ARCHIVE`). Partner never writes it
(partner archive sets `is_archived = true` directly), so legacy Admin deactivations cannot be
confused with Partner deactivations. From this release Admin *block* (`BLOCK_VEHICLE`) also writes
`is_active = false, is_archived = false` — so `is_active` alone no longer identifies a
deactivation. Use the admin audit trail (`admin_actions`) instead.

**Limitation:** audit rows exist only for actions whose audit write succeeded. Vehicles held with
no matching audit row are left as *held* (the safe state — not bookable, Admin can still activate
or deactivate explicitly).

Read-only preview (classifies every held, non-archived vehicle by its latest admin action):

```sql
WITH latest AS (
  SELECT DISTINCT ON (a.target_resource_id)
         a.target_resource_id AS vehicle_id, a.action, a.created_at
  FROM admin_actions a
  WHERE upper(a.target_resource) = 'VEHICLE'
    AND a.action IN ('DEACTIVATE_VEHICLE', 'VEHICLE_ARCHIVE', 'BLOCK_VEHICLE', 'ACTIVATE_VEHICLE', 'VEHICLE_RESTORE')
  ORDER BY a.target_resource_id, a.created_at DESC
)
SELECT v.id, v.partner_id, v.registration_number, v.manual_status, v.verification_status,
       l.action AS latest_admin_action, l.created_at AS action_at,
       CASE WHEN l.action IN ('DEACTIVATE_VEHICLE', 'VEHICLE_ARCHIVE') THEN 'backfill → archived'
            WHEN l.action = 'BLOCK_VEHICLE' THEN 'keep → blocked (temporary)'
            ELSE 'keep → held (no deactivation record)' END AS outcome
FROM vehicles v
LEFT JOIN latest l ON l.vehicle_id = v.id::text
WHERE v.is_active = false AND v.is_archived IS NOT TRUE
ORDER BY outcome, l.created_at DESC NULLS LAST;

-- Count that the backfill would change (record this number before running)
SELECT count(*) FROM vehicles v
WHERE v.is_active = false AND v.is_archived IS NOT TRUE
  AND v.id::text IN (
    SELECT target_resource_id FROM admin_actions a1
    WHERE upper(a1.target_resource) = 'VEHICLE' AND a1.action IN ('DEACTIVATE_VEHICLE', 'VEHICLE_ARCHIVE')
      AND NOT EXISTS (
        SELECT 1 FROM admin_actions a2
        WHERE a2.target_resource_id = a1.target_resource_id AND upper(a2.target_resource) = 'VEHICLE'
          AND a2.action IN ('BLOCK_VEHICLE', 'ACTIVATE_VEHICLE', 'VEHICLE_RESTORE')
          AND a2.created_at > a1.created_at));

-- Upcoming/active bookings on held vehicles (they stay valid and visible; operations should
-- contact these customers — neither the release nor the backfill cancels anything)
SELECT b.id, b.vehicle_id, b.status, b.start_at, b.end_at
FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
WHERE v.is_active = false AND v.is_archived IS NOT TRUE
  AND b.end_at > now() AND lower(b.status) NOT LIKE 'cancel%';
```

Backfill (WRITE — requires sign-off; staging first; never touches bookings; only ever sets
`is_archived = true`, so it cannot reactivate anything):

```sql
BEGIN;
-- Persistent backup for rollback (keep until the change is accepted)
CREATE TABLE IF NOT EXISTS ad2_backfill_backup (
  vehicle_id UUID PRIMARY KEY, prior_is_archived BOOLEAN, backed_up_at TIMESTAMPTZ DEFAULT now());
INSERT INTO ad2_backfill_backup (vehicle_id, prior_is_archived)
SELECT v.id, v.is_archived FROM vehicles v
WHERE v.is_active = false AND v.is_archived IS NOT TRUE
  AND v.id::text IN (
    SELECT target_resource_id FROM admin_actions a1
    WHERE upper(a1.target_resource) = 'VEHICLE' AND a1.action IN ('DEACTIVATE_VEHICLE', 'VEHICLE_ARCHIVE')
      AND NOT EXISTS (
        SELECT 1 FROM admin_actions a2
        WHERE a2.target_resource_id = a1.target_resource_id AND upper(a2.target_resource) = 'VEHICLE'
          AND a2.action IN ('BLOCK_VEHICLE', 'ACTIVATE_VEHICLE', 'VEHICLE_RESTORE')
          AND a2.created_at > a1.created_at))
ON CONFLICT (vehicle_id) DO NOTHING;
UPDATE vehicles SET is_archived = true, updated_at = now()
WHERE id IN (SELECT vehicle_id FROM ad2_backfill_backup) AND is_archived IS NOT TRUE;
SELECT count(*) FROM ad2_backfill_backup;  -- must equal the recorded preview count
COMMIT;  -- or ROLLBACK if it does not
```

Rollback (WRITE): `UPDATE vehicles v SET is_archived = b.prior_is_archived FROM ad2_backfill_backup b
WHERE v.id = b.vehicle_id;` (vehicles stay held via `is_active = false`; nothing becomes bookable).

**Order:** deploy the release first (it makes held vehicles safe), verify on staging that
`is_active = false` vehicles are absent from customer search and refuse partner ONLINE, then run
the optional backfill at any time. Booking rows and history are never modified.

## 3d. Staging environment (do this before production)

The repository migrations are **not** reproducible from an empty database: Admin migrations
050, 054 and 055 alter `partner_payouts`, `customer_profiles` and `platform_charge_settings`,
which no repository migration creates (they exist only in the live Supabase baseline). Build
staging from the production schema instead:

1. Create a separate Supabase project (or Postgres database) for staging.
2. Copy the **schema only** from production (Supabase dashboard → Database → Backups / or
   `pg_dump --schema-only --no-owner --no-privileges "$PROD_DATABASE_URL" > schema.sql`, then
   `psql "$STAGING_DATABASE_URL" -f schema.sql`). Do not copy production customer data.
3. Copy `schema_migrations` contents so the migrator sees the same history:
   `pg_dump --data-only -t schema_migrations "$PROD_DATABASE_URL" | psql "$STAGING_DATABASE_URL"`.
4. Seed staging with test partners/vehicles/customers (e.g. `Partner/scripts/seed_partner_dev.js`
   pointed at the staging `DATABASE_URL`).
5. Provision a separate Redis and use Cashfree **SANDBOX** credentials and a sandbox webhook.
6. Run §3a, §3b (and §3c if the staging copy contains deactivated vehicles) against staging.
7. Deploy (§4) with `NODE_ENV=production` and staging values, then run the staging checks below.

Staging checks (all must pass before production):
- `GET /health/ready` → 200, every check `UP`.
- Customer: OTP login → vehicle search → quote → booking → Cashfree sandbox payment → webhook marks
  payment `paid` and booking `payment_completed`; replaying the same webhook is a no-op.
- Cancel a booking, then deliver a late sandbox payment for it → booking stays cancelled, logs show
  `refund required`.
- Partner: request payout → available balance drops by the amount; Admin rejects it → balance
  restored; a second payout marked paid → balance unchanged by the mark-paid step.
- Admin: deactivate a vehicle → Partner toggle to ONLINE returns 409 → customer search/booking no
  longer offer it; its past bookings still list for customer, partner and admin.
- Admin OTP login with a real admin phone receives and accepts the Supabase SMS code; a
  non-admin number receives no SMS.
- Late payment: the refund queue (`GET /api/v1/admin/refunds`) shows one `requested` refund for the
  late-paid cancelled booking; replaying the webhook does not add a second one.
- Vehicle lifecycle: a new partner vehicle starts OFFLINE; partner ONLINE is refused (409) while
  PENDING/REJECTED, after admin block or deactivate; admin `PATCH /status` cannot set ONLINE for
  those states nor lift a hold; `/activate` on a VERIFIED vehicle restores ONLINE.
- Wallet: an admin adjustment with a UUID `Idempotency-Key` applies once (repeat returns the same
  result; same key + different amount → 409); the partner wallet summary still includes it after a
  refresh; a dispute `ADJUST_WALLET` resolution debits once and persists.
- Run `npm run test:pg` (§5b) against a disposable staging-side database.
- Run the schema checks in `docs/SCHEMA_INVENTORY.md` §7 (Q1–Q10).

## 4. Deploy

1. Configure every `[REQUIRED]` variable as a platform secret (never in the image or repo).
2. Run 3a; resolve anything unexpected. Apply 3b (and 3c once approved).
3. Deploy the image / `npm ci --omit=dev && npm start`.
4. Configure the platform health check: liveness `/health/live`, readiness `/health/ready`.
5. Check logs for `Listening on` and `Background worker started` lines; no `[FATAL]`.
6. Against the real HTTPS URL:
   - `GET /health/ready` → 200 with every check `UP`
   - `GET /api/v1/customer/customers/me` without a token → 401
   - `OPTIONS` preflight from an unlisted origin → no `Access-Control-Allow-Origin` header
7. In the Cashfree dashboard, point the webhook to
   `https://<host>/api/v1/customer/payments/webhook/cashfree` and send a sandbox test event.

### Platform settings

The repository does not commit to a provider. Any of these works with the same settings:

| Setting | Value |
| --- | --- |
| Root directory | `server` |
| Build | Docker (`server/Dockerfile`) — or Node runtime with install `npm ci --omit=dev` |
| Start | `npm start` (Docker image runs `node src/server.js`) |
| Port | platform-provided `$PORT` (image default 8080) |
| Health check path | `/health/ready` (readiness), `/health/live` (liveness) |
| Instances | ≥1; workers are multi-instance safe. Budget DB connections: 3 × `DB_POOL_MAX` per instance |

The assigned HTTPS hostname needs no code change: put the browser origins that call the API
in `CORS_ORIGINS` / `CORS_ORIGIN` / `CORS_ALLOWED_ORIGINS`, point the apps at
`https://<assigned-host>/api/v1/{customer|partner|admin}`, set `CASHFREE_RETURN_URL` to the
customer app's return page, and register the Cashfree webhook URL (step 7).

## 5. Behaviour changes in this release (review before deploy)

- **Payout balances**: the partner's available balance is debited when a payout is requested
  (Partner `payout.service`). Admin *mark paid* no longer deducts it a second time; Admin *reject*
  now credits the held amount back; *retry* re-applies the hold. Payouts requested before this
  release were also debited at request time, so no data migration is needed — confirm with
  finance that no wallet was manually corrected for the old double-deduction.
- **Admin OTP** is verified against the code Supabase sends (`auth.verifyOtp`). The dev code
  `123456` works only with `ADMIN_DEV_AUTH_ENABLED=true` outside production.
- **New admin users** require an initial password (min 8 chars); there is no default password.
- **Admin email/phone fallback** only links a Supabase identity whose email/phone is confirmed and
  only to a DB user not already bound to another Supabase account.
- **Customer auto-provisioning** requires a phone number on the Supabase identity.
- **Admin OTP send** (`/auth/otp/send`, `/auth/mobile/login`) only texts numbers belonging to an
  active admin; other numbers get the same response shape but no SMS.
- **Admin wallet list/detail** now select `users.name` / `users.phone` (they previously referenced
  non-existent `full_name` / `phone_number` and always failed).
- **Manual wallet adjustments** (`POST /api/v1/admin/wallets/:id/adjust`) now **require** an
  `Idempotency-Key` header (or `idempotencyKey` body field, 8–100 chars). The key is stored as the
  ledger row's `reference_id`; a retry with the same key returns the original result, a reused key
  with a different amount/direction returns 409. Partner's wallet recalculation now includes
  completed `admin_adjustment` ledger rows, so adjustments are no longer erased.
- **Financial audit attribution:** payout mark-paid/reject/retry, refund approval/rejection and
  wallet adjustments record the acting admin's own `users.id`. The former "any admin" fallback is
  removed; if the actor cannot be resolved the action is refused with 403
  `ADMIN_ACTOR_UNRESOLVED` (except under explicit dev auth outside production).
- **Ledger vocabulary:** readers (Partner settlement idempotency barrier, Partner/Admin filters,
  reconciliation, Admin summaries) now match the stored lowercase values; previously the settlement
  barrier never matched, so a replayed settlement could be credited twice. API output still uses
  `CREDIT`/`DEBIT`.
- **Wallet mirror writes:** balance changes are written once to `wallets` and copied to
  `partner_wallets` (previously applied to both, which double-applied when `wallets` is the live
  view over `partner_wallets`).
- **Admin vehicle actions:** block = `OFFLINE`, `is_active=false` (temporary hold the partner cannot
  undo); deactivate = `OFFLINE`, `is_active=false`, `is_archived=true`; activate refuses REJECTED
  vehicles (409), sets ONLINE only for VERIFIED/APPROVED and otherwise lifts the hold but leaves the
  vehicle OFFLINE. All three lock the vehicle row in a transaction. Existing bookings are never
  cancelled; the response reports `existingActiveBookings`.
- **Customer auth:** a non-JWT bearer token that is not a live session is rejected locally instead
  of making a Supabase network call per request.
- **Wallet adjustment key is a UUID** (live `wallet_transactions.reference_id` is `uuid`).
- **Dispute wallet deductions** are recorded as `admin_adjustment` ledger rows (the live CHECKs
  rejected the previous `'debit'`/`'dispute_resolution'` values) and survive recalculation; the
  wallet lock call had its arguments reversed and is fixed.
- **Vehicle status invariants (Admin and Partner):** ONLINE requires VERIFIED/APPROVED
  verification, not archived, and no admin hold (`is_active = false`). `PATCH
  /admin/vehicles/:id/status` can no longer lift a block/deactivation (use `/activate`).
  **New partner vehicles are created OFFLINE** (they are PENDING); after admin approval the partner
  must switch them ONLINE. The Partner app's availability screen text ("pending vehicles can accept
  bookings") is now inaccurate.
- **Customer discovery/booking** excludes `is_active = false` vehicles.
- **Late payments for cancelled bookings** create one `refunds` row (status `requested`,
  idempotency key `late-payment:<paymentId>`) in the Admin refund queue.

## 5b. Real-PostgreSQL integration tests (run on staging CI)

`Admin/tests/postgres/*.pgtest.js` cover what pg-mem cannot (row locks, concurrent duplicate
adjustments, mark-paid vs reject races, real ROLLBACK). They are excluded from `npm test` and must
be pointed at a disposable database (they create and drop their own schema):

```bash
cd server/Admin && TEST_PG_URL=postgresql://user:pass@host:5432/disposable_db npm run test:pg
```

They have not yet been run against a real PostgreSQL instance.
- **Late payments for cancelled bookings** keep the payment `paid` and log
  `refund required` (see the refund-queue query in 3a) instead of re-confirming the booking.

## 6. Rollback

Redeploy the previous image/commit. Migration 048 is additive and needs no rollback; if required,
`npm run db:migrate:rollback` in `Partner/` drops the column (pricing-history `changed_by` data is
lost).
