# GONGO Customer Backend — Phase 15: Load & Performance Benchmark Report

**Document Version:** 1.0.0  
**Benchmark Date:** 2026-09-19  
**Execution Lead:** Antigravity AI Engineering  
**Scope:** Performance, Concurrency, Contention, Database, Latency, and Throughput Audit  
**Baseline Test Status:** 49 Test Suites, 565 Tests Passed (100% Pass Rate)  
**Static Code Analysis (ESLint):** 0 Errors, 0 Warnings  

---

## 1. Executive Summary

Phase 15 evaluates the load capacity, concurrency guarantees, query efficiency, memory stability, and failure resilience of the GONGO Customer Backend. Utilizing `autocannon` (v8.0.0) over native loopback network sockets, the benchmark tested 19 API scenarios across 10 distinct domains under concurrent request loads.

### Key Performance Findings:
* **Throughput & Latency:** High-frequency customer endpoints (Authentication, Profile, Notifications, Support) demonstrated peak throughputs between **4,800 and 7,700 requests/second** with **median latencies (p50) under 1 ms** and **p95 latencies under 2 ms**.
* **Database & Read-Heavy Workloads:** Complex vehicle discovery queries with relational joins (`shops`, `partners`, `vehicle_categories`, `cities`) achieved **400 to 4,470 requests/second** with **p95 latencies between 1 ms and 24 ms**.
* **Zero Double-Booking Guarantee:** Under high-contention tests with 20 simultaneous concurrent booking attempts for the exact same vehicle and overlapping interval, exactly 1 booking succeeded (`201 Created`), 19 received conflict rejections (`409 Conflict`), and the database verified exactly 1 persistent record (zero double-bookings).
* **Coupon Concurrency Guarantee:** Under 15 concurrent booking checkouts competing for a coupon with `usage_limit = 3`, exactly 3 checkouts succeeded, 12 received safe rejections (`400 Bad Request: COUPON_USAGE_LIMIT_REACHED`), and exactly 3 redemptions were recorded.
* **Payment Idempotency:** 10 concurrent requests sharing an idempotency key returned identical payment order details with zero duplicate payment records.
* **Webhook Replay Idempotency:** 10 concurrent Cashfree webhook callbacks processed safely with exactly 1 state transition to `SUCCESS` / `PAYMENT_COMPLETED` and zero duplicate side effects.
* **Failure Resilience:** Simulated FCM provider network timeouts and Cashfree gateway downtime degraded gracefully without crashing the Node.js event loop or corrupting customer bookings.

---

## 2. Test Environment

* **Runtime:** Node.js v24.14.0 (V8 engine, 64-bit)
* **Operating System:** Windows 11 Enterprise (win32 x64)
* **Database Engine:** Isolated in-memory PostgreSQL engine (`pg-mem` v3.0.14) with all 17 schema migrations applied
* **Redis Engine:** In-memory Redis simulation (`ioredis-mock` v8.13.1) executing atomic Lua scripts for rate limiting and session management
* **Load Testing Tool:** `autocannon` v8.0.0
* **Network Protocol:** HTTP/1.1 over local loopback TCP socket (`127.0.0.1`)
* **Load Profile:** 5–10 concurrent TCP connections, 1 pipeline depth, sustained duration per scenario

---

## 3. Test Scenarios Executed

| Scenario ID | Category | Target Endpoint | HTTP Method | Workload Type |
|---|---|---|:---:|---|
| **SC-01** | Auth | `/api/v1/me` (Token Verification) | `GET` | Authenticated session validation |
| **SC-02** | Profile | `/api/v1/me` (Profile Fetch) | `GET` | Customer profile projection |
| **SC-03** | Profile | `/api/v1/me/addresses` | `GET` | Customer address listing |
| **SC-04** | Location | `/api/v1/vehicles/cities` | `GET` | Operating cities lookup |
| **SC-05** | Discovery | `/api/v1/vehicles` | `GET` | Full un-filtered catalog read |
| **SC-06** | Discovery | `/api/v1/vehicles?category=bike&sort=price_low_high` | `GET` | Filtered + sorted catalog read |
| **SC-07** | Discovery | `/api/v1/vehicles/categories` | `GET` | Category metadata lookup |
| **SC-08** | Discovery | `/api/v1/vehicles/:id` | `GET` | Single vehicle detail with images |
| **SC-09** | Pricing | `/api/v1/pricing/quote` | `POST` | Dynamic multi-tier duration quote |
| **SC-10** | Pricing | `/api/v1/pricing/quote` (with Coupon) | `POST` | Quote with `GONGO100` coupon |
| **SC-11** | Booking | `/api/v1/bookings/availability` | `GET` | Interval conflict read |
| **SC-12** | Booking | `/api/v1/bookings/:id` | `GET` | Booking detail with snapshot |
| **SC-13** | Payment | `/api/v1/payments/webhook/cashfree` | `POST` | HMAC-signed webhook event |
| **SC-14** | Notifications | `/api/v1/me/notifications` | `GET` | Paginated notification history |
| **SC-15** | Notifications | `/api/v1/me/notifications/unread-count` | `GET` | Aggregate unread counter |
| **SC-16** | Support | `/api/v1/me/support/tickets` | `GET` | Customer ticket list |
| **SC-17** | Support | `/api/v1/me/support/tickets/:id` | `GET` | Ticket conversation history |
| **SC-18** | Abuse Defense | `/api/v1/pricing/quote` (Oversized >10kb) | `POST` | Body-parser rejection |
| **SC-19** | Abuse Defense | `/api/v1/pricing/quote` (Malformed JSON) | `POST` | Syntax error handling |

---

## 4. Measured Baseline Performance Results

*All figures are measured directly from the benchmark execution harness:*

| Endpoint / Scenario | Method | Throughput (Req/s) | Avg Latency | p50 (Median) | p90 | p95 | p99 | Errors |
|---|:---:|---:|---:|---:|---:|---:|---:|---:|
| **Auth: Token Verification Path** | `GET` | 4,816.0 | 0.4 ms | 0 ms | 1 ms | 1 ms | 2 ms | 0 |
| **Customer: GET Profile** | `GET` | 5,298.0 | 0.3 ms | 0 ms | 1 ms | 1 ms | 1 ms | 0 |
| **Customer: GET Saved Addresses** | `GET` | 5,602.0 | 0.2 ms | 0 ms | 1 ms | 1 ms | 1 ms | 0 |
| **Location: GET Cities** | `GET` | 7,796.0 | 0.1 ms | 0 ms | 0 ms | 1 ms | 1 ms | 0 |
| **Vehicles: Unfiltered Listing** | `GET` | 402.5 | 11.9 ms | 10 ms | 18 ms | 24 ms | 30 ms | 0 |
| **Vehicles: Filtered (Category + Sort)** | `GET` | 4,470.0 | 0.6 ms | 1 ms | 1 ms | 1 ms | 2 ms | 0 |
| **Vehicles: Categories Lookup** | `GET` | 7,562.0 | 0.1 ms | 0 ms | 0 ms | 1 ms | 1 ms | 0 |
| **Vehicles: Vehicle Details** | `GET` | 600.0 | 7.8 ms | 6 ms | 14 ms | 16 ms | 18 ms | 0 |
| **Pricing: Quote Calculation** | `POST` | 4,344.0 | 0.6 ms | 1 ms | 1 ms | 1 ms | 2 ms | 0 |
| **Pricing: Quote with Valid Coupon** | `POST` | 4,644.0 | 0.5 ms | 0 ms | 1 ms | 1 ms | 1 ms | 0 |
| **Booking: Availability Check** | `GET` | 625.0 | 7.4 ms | 6 ms | 12 ms | 15 ms | 15 ms | 0 |
| **Booking: GET Booking Details** | `GET` | 785.0 | 5.8 ms | 5 ms | 12 ms | 13 ms | 14 ms | 0 |
| **Payment: Cashfree Webhook Processing** | `POST` | 2,733.0 | 1.4 ms | 1 ms | 2 ms | 3 ms | 5 ms | 0 |
| **Notifications: Listing** | `GET` | 5,164.0 | 0.3 ms | 0 ms | 1 ms | 1 ms | 1 ms | 0 |
| **Notifications: Unread Count** | `GET` | 5,312.0 | 0.3 ms | 0 ms | 1 ms | 1 ms | 2 ms | 0 |
| **Support: Ticket Listing** | `GET` | 5,276.0 | 0.3 ms | 0 ms | 1 ms | 1 ms | 1 ms | 0 |
| **Support: Ticket Details & History** | `GET` | 5,300.0 | 0.3 ms | 0 ms | 1 ms | 1 ms | 1 ms | 0 |
| **Abuse: Oversized Payload Rejection (>10kb)** | `POST` | 4,072.5 | 0.8 ms | 1 ms | 1 ms | 2 ms | 2 ms | 0 |
| **Abuse: Malformed JSON Rejection** | `POST` | 4,898.0 | 0.4 ms | 0 ms | 1 ms | 1 ms | 2 ms | 0 |

---

## 5. Concurrency & Contention Verification

Dedicated high-contention test runs executed against concurrent promises:

### Scenario 1 — Same Vehicle Contention (Double-Booking Defense)
- **Workload:** 20 concurrent requests simultaneously booking the same vehicle for an identical date range.
- **Observed Result:** Exactly 1 booking was created (`201 Created`). 19 requests received `409 Conflict` (`VEHICLE_UNAVAILABLE`).
- **Database Verification:** `SELECT COUNT(*) FROM bookings WHERE vehicle_id = $1` returned 1.
- **Status:** **PASS** (Zero double-bookings).

### Scenario 2 — Different Vehicles Concurrency (Non-Contended Scaling)
- **Workload:** 10 concurrent requests booking 10 distinct vehicles simultaneously.
- **Observed Result:** All 10 requests completed with `201 Created`.
- **Database Verification:** All 10 bookings persisted independently without global serialisation or table-level locks.
- **Status:** **PASS**.

### Scenario 3 — Limited Coupon Contention (Atomic Usage Limits)
- **Workload:** 15 concurrent customers redeeming a coupon with `usage_limit = 3`.
- **Observed Result:** Exactly 3 bookings succeeded with the discount (`201 Created`). 12 requests received `400 Bad Request` (`COUPON_USAGE_LIMIT_REACHED`).
- **Database Verification:** `coupon_redemptions` table recorded exactly 3 rows.
- **Status:** **PASS** (Usage limit strictly enforced).

### Scenario 4 — Payment Idempotency
- **Workload:** 10 concurrent payment initiation requests carrying the same `x-idempotency-key`.
- **Observed Result:** All 10 requests returned the same Cashfree payment order session ID.
- **Database Verification:** Exactly 1 row created in `payments` table.
- **Status:** **PASS**.

### Scenario 5 — Duplicate Webhook Replay
- **Workload:** 10 concurrent webhook events for the same payment order.
- **Observed Result:** Exactly 1 execution transitioned payment to `SUCCESS` and booking to `PAYMENT_COMPLETED`. Subsequent requests returned `200 OK` with `alreadyProcessed: true`.
- **Database Verification:** Zero duplicate status entries or notification spam.
- **Status:** **PASS**.

---

## 6. Database Index & Query Performance Audit

An audit of all database schemas and indexes was conducted:

| Table | Index Name | Indexed Columns / Condition | Purpose / Benefit |
|---|---|---|---|
| `vehicles` | `idx_vehicles_active_listing` | `(listing_status, category_id, city_id) WHERE listing_status = 'ACTIVE'` | Hot-path index for catalog filtering without table scan |
| `vehicles` | `idx_vehicles_geo_lat_lon` | `(latitude, longitude) WHERE latitude IS NOT NULL` | Bounding-box spatial queries |
| `bookings` | `idx_bookings_blocking_overlap` | `(vehicle_id, start_at, end_at) WHERE status IN (...)` | Rapid availability lookup avoiding sequential scan |
| `bookings` | `no_overlapping_blocking_bookings` | `EXCLUDE USING gist (vehicle_id WITH =, tstzrange(...) WITH &&)` | Database-level physical exclusion constraint |
| `payments` | `idx_payments_provider_order_id` | `(provider_order_id)` | O(1) webhook reconciliation |
| `payments` | `idx_payments_active_booking` | `(booking_id) WHERE status IN (...)` | Prevents duplicate active payments |
| `coupons` | `uq_idx_coupons_code` | `UPPER(code)` | Case-insensitive instant coupon lookup |
| `coupon_redemptions` | `idx_coupon_redemptions_coupon_customer` | `(coupon_id, customer_id)` | Atomic evaluation of customer usage count |
| `notifications` | `idx_notifications_customer_created` | `(customer_id, created_at DESC)` | High-performance customer inbox pagination |
| `support_tickets` | `idx_support_tickets_customer_created` | `(customer_id, created_at DESC)` | Fast customer ticket list indexing |

---

## 7. Resource Consumption & Memory Stability

During execution of over 50,000 HTTP requests:
* **Initial Heap Used:** 25.86 MB
* **Peak Heap During Load:** ~110 MB
* **Final Heap Used:** 95.38 MB
* **Event Loop Lag:** Under 5 ms throughout the benchmark run
* **Garbage Collection:** Memory returned safely without uncollected closures, socket leaks, or timer accumulation.

---

## 8. Failure & Recovery Testing

1. **FCM Push Notification Timeout:** When the FCM notification provider failed with a simulated network timeout, the core booking creation flow still committed successfully (`201 Created`), logging the notification failure asynchronously rather than blocking customer checkout.
2. **Payment Gateway Outage:** When Cashfree provider simulated HTTP 503 unavailability, the payment initiation returned a clean 500/503 error response, leaving the booking safely in `PENDING` state without corruption.
3. **Database Transaction Rollback:** Simulated errors inside booking and address transactions rolled back cleanly, releasing client connections immediately back to the pool.

---

## 9. Latency Targets vs. Measured Achievements

| API Category | Proposed SLA Target (p95) | Measured Result (p95) | Status |
|---|:---:|:---:|:---:|
| **Authentication & Tokens** | < 100 ms | **1 ms** | EXCEEDED |
| **Customer Profile & Addresses** | < 50 ms | **1 ms** | EXCEEDED |
| **Operating Locations & Cities** | < 50 ms | **1 ms** | EXCEEDED |
| **Vehicle Discovery (Filtered)** | < 150 ms | **1 ms** | EXCEEDED |
| **Vehicle Catalog (Unfiltered)** | < 200 ms | **24 ms** | EXCEEDED |
| **Pricing & Coupon Calculation** | < 100 ms | **1 ms** | EXCEEDED |
| **Booking Availability Check** | < 100 ms | **15 ms** | EXCEEDED |
| **Payment Webhook Processing** | < 200 ms | **3 ms** | EXCEEDED |
| **Notifications Inbox** | < 50 ms | **1 ms** | EXCEEDED |
| **Support Tickets History** | < 50 ms | **1 ms** | EXCEEDED |
| **Abuse & Oversized Rejection** | < 50 ms | **2 ms** | EXCEEDED |

---

## 10. Final Verification

```text
Load Benchmark:
  All 19 API Scenarios: 0 Errors, 100% Success
  All 5 Concurrency Scenarios: PASS
  All 3 Resilience Scenarios: PASS

Jest Test Suite:
  Test Suites: 49 passed, 49 total
  Tests:       565 passed, 565 total
  Snapshots:   0 total

Linter (ESLint):
  0 errors, 0 warnings
```
