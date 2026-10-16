# GONGO Partner Backend — Architecture & System Design

## 1. Executive Summary & Design Principles

The GONGO Partner Backend is a production-grade marketplace backend built with Node.js, Express, PostgreSQL, Redis, Supabase Admin, and AWS S3. It powers the operational and business workflows of vehicle rental partners on the GONGO platform.

### Architectural Tenets
1. **Frontend as Product Source of Truth**: Data contracts strictly reflect the real screens and interactions in the React Native partner app (`gongo-partner`).
2. **Partner as the Canonical Business Entity**: The Partner (`partners` table) is the single canonical business, profile, and location entity. The legacy `shops` table exists strictly for backward compatibility with foreign keys (`vehicles.shop_id`, `bookings.shop_id`).
3. **Defense-in-Depth Security**:
   - Zero trust: Every authenticated request resolves identity through Supabase Admin -> PostgreSQL `users` (`role = 'PARTNER'`) -> PostgreSQL `partners`.
   - Complete BOLA/IDOR protection: Access to resources is strictly checked against the authenticated partner's primary key (`req.partner.id`).
   - Server-controlled state: Status fields (`partner_status`, `kyc_status`, `verification_status`, financial ledgers) can never be mutated by client request payloads.
4. **Ledger-Based Financial System**: Partner balances are maintained in an append-only transaction ledger (`wallet_transactions`). No balance mutation can occur outside a ledger record and atomic transaction.
5. **Private Direct-to-Cloud Storage**: Files never pass through backend application memory. The client receives a presigned PUT URL with strict content type and AES256 server-side encryption, uploads directly to private S3, and the backend verifies file existence and magic bytes upon completion.
6. **Zero Partner Accept/Reject Friction**: Vehicle rental bookings flow directly into the system upon customer payment confirmation via Cashfree. Partners do not manually accept or reject customer bookings.

---

## 2. Technology Stack

| Layer | Component | Description / Specification |
|---|---|---|
| **Runtime** | Node.js | v18+ LTS |
| **Framework** | Express.js | v4.19+ with Helmet security headers |
| **Primary Database** | PostgreSQL | v15+ via `pg` (with connection pooling and transaction helpers) |
| **Cache & Rate Limit** | Redis | `ioredis` with sliding window rate limiting & idempotency store |
| **Authentication** | Supabase Auth / Admin | Identity token verification (external authentication authority) |
| **Object Storage** | AWS S3 SDK v3 | Private S3 bucket, presigned PUT/GET URLs, AES256 server encryption |
| **Validation** | Custom Functional | Strict whitelist filtering, mass-assignment guards, type assertions |
| **Logging** | Winston & Morgan | Structured JSON logging with request correlation ID tracking |
| **Testing** | Jest, Supertest, pg-mem | Unit, database migration, integration, and security regression suites |

---

## 3. Core Directory Layout

```text
gongo-partner-backend/
├── database/
│   └── migrations/           # Sequential database migrations (001–032)
├── docs/                     # Canonical engineering documentation
├── src/
│   ├── app.js                # Express app factory with middleware pipeline
│   ├── server.js             # HTTP listener with graceful shutdown
│   ├── config/               # Envalid-validated configuration & Winston logger
│   ├── constants/            # Error codes, document types, roles, limits
│   ├── db/                   # Connection pool, transaction runner, migrator
│   ├── errors/               # Standardized AppError hierarchy
│   ├── middleware/           # Auth, RBAC, BOLA, rate-limit, audit, error handler
│   ├── providers/            # Supabase Auth / Admin, AWS S3 provider
│   ├── repositories/         # BaseRepository & domain data access objects
│   ├── routes/               # Express routing modularized by domain
│   ├── services/             # Business logic, state transitions, transactions
│   ├── utils/                # Masking, string sanitization, mass assignment helpers
│   └── validators/           # Strict request body/query validators
└── tests/
    ├── integration/          # End-to-end HTTP API tests
    ├── security/             # OWASP Top 10 security regression tests
    └── unit/                 # Domain service, validator, and provider unit tests
```

---

## 4. Layered Request Lifecycle

```text
[Incoming HTTP Request]
         │
         ▼
[Security Headers Middleware (Helmet)]
         │
         ▼
[CORS Origin Validation (Strict Whitelist)]
         │
         ▼
[Request ID Attachment (X-Request-Id UUID)]
         │
         ▼
[Payload Size Limit (10kb JSON limit)]
         │
         ▼
[Redis Sliding Window Rate Limiter]
         │
         ▼
[Supabase Bearer Token Extraction & Admin Verification]
         │
         ▼
[User & Partner Database Resolution (PostgreSQL users & partners)]
         │
         ▼
[Role Verification (role === 'PARTNER')]
         │
         ▼
[BOLA/IDOR Ownership Check (Target belongs to req.partner.id)]
         │
         ▼
[Input Validation & Mass Assignment Stripping (Strict Whitelist)]
         │
         ▼
[Domain Service Execution (Transaction Runner & Concurrency Locks)]
         │
         ▼
[Repository Query Execution (Parameterized SQL Queries)]
         │
         ▼
[Audit Logging (Redacted Structured Security Log)]
         │
         ▼
[Formatted API Response { success: true, data: { ... } }]
```

---

## 5. Architectural Invariants for Future Phases

1. **Never Trust Client Status**: All status updates (booking states, payment states, KYC verification, vehicle listing approval) are exclusively server-driven.
2. **Never Create Duplicate Business Concepts**: Partner (`partners`) is the store/hub. Do not create new "Shop" entities, routes, or workflows.
3. **Always Parameterize SQL**: Raw string concatenation into SQL queries is strictly prohibited across all repositories.
4. **Always Use Atomic Transactions for Multi-Write Operations**: Any workflow touching multiple records or financial balances must use `pool.transaction`.
5. **Always Redact Sensitive Data in Logs**: Customer phone numbers, raw document IDs, OTP hashes, and access tokens must never appear in application logs.
