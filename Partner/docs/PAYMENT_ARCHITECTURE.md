# GONGO Partner Backend — Payment & Settlement Architecture

## 1. Architectural Philosophy & Separation of Concerns
The GONGO platform operates a two-sided vehicle rental marketplace. To preserve financial security, fraud prevention, and operational integrity, payment responsibilities are decoupled:

```text
       CUSTOMER DOMAIN                              PARTNER DOMAIN
  ┌─────────────────────────┐                  ┌────────────────────────┐
  │ Customer App & Backend  │                  │  Partner App & Backend │
  │                         │                  │                        │
  │ • Debtor / Payer        │                  │ • Vehicle Host         │
  │ • Mounts Cashfree SDK   │                  │ • Return Inspector     │
  │ • Initiates Orders      │                  │ • Operational Viewer   │
  │ • Pays Advance & Dues   │                  │ • Read-Only Settlement │
  └────────────┬────────────┘                  └───────────▲────────────┘
               │                                           │
               ▼                                           │
       CASHFREE GATEWAY ───────────────────────────────────┘
         (PG v2023-08-01)        Webhook Event: POST_RENTAL_SETTLEMENT_SUCCESS
```

1. **Customer is the sole payment initiator**: The customer initiates payment orders under their authenticated session. The Partner cannot initiate payments or charge the customer directly.
2. **Partner has operational visibility**: The partner views whether post-rental fees are `NO_CHARGE`, `UNPAID`, `PAYMENT_PENDING`, or `PAID`.
3. **No automatic damage billing**: Partner damage assessments (`damage_reports.estimated_amount`) are non-authoritative. Collection is explicitly deferred until an independent dispute/adjudication workflow is established.

---

## 2. Cryptographic Webhook Security (PG v2023-08-01)

### 2.1 Raw Request Body Verification
Cashfree computes its HMAC-SHA256 signature using the exact raw bytes received over the wire. If the JSON parser re-serializes the body, key order or whitespace differences invalidate the signature.

To prevent this:
```javascript
// src/middlewares/bodyParser.js
const jsonParser = express.json({
  limit: JSON_LIMIT,
  strict: true,
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  },
});
```

### 2.2 Verification Algorithm
1. Extract `timestamp = req.headers['x-webhook-timestamp']`.
2. Extract `signature = req.headers['x-webhook-signature']`.
3. Verify timestamp clock-skew:
   $$\text{nowSec} - \text{tsSec} \le 600 \quad \text{and} \quad \text{tsSec} - \text{nowSec} \le 300$$
4. Compute expected signature:
   $$\text{expected} = \text{Base64}(\text{HMAC-SHA256}(\text{timestamp} + \text{rawBody}, \text{secretKey}))$$
5. Compare using constant-time comparison:
   ```javascript
   crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
   ```

---

## 3. Idempotency & Reconciliation Engine

### 3.1 Event Idempotency
Gateways retransmit webhooks when timeouts or network blips occur. Duplicate processing is prevented via the `payment_events` table:
* Unique constraint: `uq_payment_events_event_id (provider, event_id)`
* Checks before execution; if `is_processed = true`, returns `200 OK` with `{ duplicate: true }`.

### 3.2 Transactional Row Locking
To prevent race conditions with concurrent customer checkout queries, the payment row is locked within the transaction:
```sql
SELECT * FROM payments WHERE provider_order_id = $1 FOR UPDATE;
```

### 3.3 Amount & Currency Reconciliation
Before marking any payment as `SUCCESS`:
1. **Amount reconciliation**:
   $$|\text{lockedPayment.amount} - \text{eventAmount}| \le 0.01$$
   If an amount discrepancy exists, the payment is marked `FAILED` with `failureReason = 'AMOUNT_MISMATCH'`, and the webhook is rejected.
2. **Currency reconciliation**:
   $$\text{eventCurrency} === \text{lockedPayment.currency} \quad (\text{'INR'})$$
   Any currency deviation marks the payment `FAILED` with `failureReason = 'CURRENCY_MISMATCH'`.

---

## 4. Phase 11 Scope Boundaries
To guarantee zero architectural drift, Phase 11 maintains strict boundaries:
* ❌ **No Wallets**: No updates to `wallets` or `wallet_transactions`.
* ❌ **No Earnings**: No inserts into `earnings`.
* ❌ **No Commission Deductions**: No inserts into `commission_records`.
* ❌ **No Payouts**: No bank transfers or payout requests.
* ❌ **No Booking State Changes**: Booking status remains `COMPLETED`.
