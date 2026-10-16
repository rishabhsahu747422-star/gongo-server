# GONGO Partner Backend — Payments & Return Settlement API Specification

## 1. Overview
The Payments & Settlement API provides the Partner with read-only operational visibility into post-rental charges and payment audit trails, while providing Cashfree PG with a cryptographically verified webhook callback endpoint.

---

## 2. Security & Architectural Principles
1. **Customer is the Sole Payer**: The customer is the debtor who initiates payment via the Customer App/Backend. The Partner cannot initiate payments or charge the customer directly.
2. **Authoritative Server Derivation**: Post-rental charges are derived strictly from `booking_return_verifications` (`late_fee + extra_km_fee`).
3. **Deferred Damage Assessment**: Partner damage reports (`damage_reports`) remain in `REPORTED` status; `estimated_amount` is non-authoritative and is NEVER added to payable charges.
4. **Cryptographic Webhook Verification**: Uses HMAC-SHA256 over raw request body and timestamp, constant-time comparison, and clock-skew replay protection.
5. **Double-Ownership BOLA Protection**: All partner routes enforce verification that both the booking and vehicle belong to the authenticated partner.

---

## 3. Endpoints

### 3.1 Get Return Settlement Details
Retrieves authoritative breakdown of return charges and current settlement payment status.

* **URL**: `/api/v1/partner/bookings/:bookingId/settlement`
* **Method**: `GET`
* **Auth**: Required (`Bearer <SupabaseToken>`, Role: `PARTNER`)
* **Rate Limit**: 120 req / minute

#### Response `200 OK`
```json
{
  "success": true,
  "data": {
    "bookingId": "33333333-3333-4333-a333-333333333333",
    "bookingNumber": "BK-2026-RET-01",
    "vehicleId": "55555555-5555-4555-a555-555555555555",
    "registrationNumber": "KA01AB1234",
    "returnVerification": {
      "returnedAt": "2026-09-27T12:00:00.000Z",
      "odometerEnd": 12600.00,
      "lateMinutes": 105,
      "lateFee": 240.00,
      "extraKm": 30.00,
      "extraKmFee": 450.00,
      "returnStatus": "LATE"
    },
    "damageReports": [
      {
        "id": "dmg-999",
        "damageType": "DENT",
        "description": "Side panel dent",
        "estimatedAmount": 3500.00,
        "status": "REPORTED",
        "action": "DEFERRED_APPROVAL",
        "note": "Damage estimates are not payable in Phase 11. Collection is deferred until formal approval."
      }
    ],
    "charges": {
      "lateFee": 240.00,
      "extraKmFee": 450.00,
      "approvedDamageFee": 0.00,
      "totalSettlementPayable": 690.00
    },
    "settlementStatus": "UNPAID",
    "payment": null
  }
}
```

---

### 3.2 Get Booking Payments
Retrieves complete payment history for the booking (advance booking payments and post-rental settlements).

* **URL**: `/api/v1/partner/bookings/:bookingId/payments`
* **Method**: `GET`
* **Auth**: Required (`Bearer <SupabaseToken>`, Role: `PARTNER`)
* **Rate Limit**: 120 req / minute

#### Response `200 OK`
```json
{
  "success": true,
  "data": {
    "bookingId": "33333333-3333-4333-a333-333333333333",
    "bookingNumber": "BK-2026-RET-01",
    "totalPayments": 2,
    "payments": [
      {
        "id": "pay-advance-01",
        "paymentType": "BOOKING_ADVANCE",
        "provider": "CASHFREE",
        "providerOrderId": "cf_adv_001",
        "providerPaymentId": "cf_pay_adv_999",
        "amount": 5124.00,
        "currency": "INR",
        "status": "SUCCESS",
        "createdAt": "2026-09-21T08:05:00.000Z",
        "updatedAt": "2026-09-21T08:06:00.000Z"
      },
      {
        "id": "pay-settle-02",
        "paymentType": "POST_RENTAL_SETTLEMENT",
        "provider": "CASHFREE",
        "providerOrderId": "cf_set_002",
        "providerPaymentId": "cf_pay_set_888",
        "amount": 690.00,
        "currency": "INR",
        "status": "SUCCESS",
        "createdAt": "2026-09-27T12:15:00.000Z",
        "updatedAt": "2026-09-27T12:16:00.000Z"
      }
    ]
  }
}
```

---

### 3.3 Cashfree Gateway Webhook Callback
Receives payment gateway asynchronous notifications.

* **URL**: `/api/v1/payments/webhook/cashfree`
* **Method**: `POST`
* **Auth**: Gateway HMAC-SHA256 signature (`x-webhook-signature`, `x-webhook-timestamp`)
* **Rate Limit**: 100 req / minute

#### Headers
| Header | Description |
| :--- | :--- |
| `x-webhook-timestamp` | Epoch timestamp in seconds |
| `x-webhook-signature` | Base64-encoded HMAC-SHA256 digest over `timestamp + rawBody` |
| `Content-Type` | `application/json` |

#### Payload Format (Cashfree PG v2023-08-01)
```json
{
  "data": {
    "order": {
      "order_id": "cf_set_002",
      "order_amount": 690.00,
      "order_currency": "INR"
    },
    "payment": {
      "cf_payment_id": "cf_pay_set_888",
      "payment_status": "SUCCESS",
      "payment_amount": 690.00,
      "payment_currency": "INR",
      "payment_message": "Transaction Successful"
    }
  },
  "event_time": "2026-09-27T12:16:00.000Z",
  "type": "PAYMENT_SUCCESS_WEBHOOK"
}
```

#### Response `200 OK`
```json
{
  "success": true,
  "data": {
    "processed": true,
    "status": "SUCCESS"
  }
}
```
