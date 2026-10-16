# GONGO Admin API - Quick Reference

**Base URL:** `http://localhost:3001/api/v1`

---

## 🔐 Authentication APIs

| Method | Endpoint | Purpose | Auth Required |
|--------|----------|---------|---------------|
| POST | `/admin/auth/login` | Send credentials, get OTP | No |
| POST | `/admin/auth/verify-2fa` | Verify OTP, get token | No |
| POST | `/admin/auth/otp/send` | Send SMS OTP | No |
| POST | `/admin/auth/otp/verify` | Verify phone OTP | No |
| GET | `/admin/auth/me` | Get current user info | Yes |
| POST | `/admin/auth/refresh` | Refresh token | Yes |
| POST | `/admin/auth/logout` | Logout current session | Yes |
| POST | `/admin/auth/logout-all` | Logout all sessions | Yes |

---

## 📊 Dashboard APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/dashboard` | Main overview | Yes |
| GET | `/admin/dashboard/stats` | Statistics | Yes |
| GET | `/admin/dashboard/revenue` | Revenue metrics | Yes |
| GET | `/admin/dashboard/bookings` | Booking metrics | Yes |
| GET | `/admin/dashboard/activity` | Recent activity | Yes |
| GET | `/admin/dashboard/category-distribution` | Fleet distribution | Yes |
| GET | `/admin/dashboard/urgent-alerts` | Pending verifications | Yes |

---

## 👥 Partner APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/partners` | List partners (paginated) | Yes |
| GET | `/admin/partners/{id}` | Get partner details | Yes |
| PATCH | `/admin/partners/{id}` | Update partner status | Yes |
| POST | `/admin/partners/{id}/suspend` | Suspend partner | Yes |
| POST | `/admin/partners/{id}/activate` | Activate partner | Yes |

---

## 👨‍💼 Customer APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/customers` | List customers (paginated) | Yes |
| GET | `/admin/customers/{id}` | Get customer details | Yes |
| PATCH | `/admin/customers/{id}` | Update customer | Yes |
| POST | `/admin/customers/{id}/suspend` | Suspend customer | Yes |
| POST | `/admin/customers/{id}/activate` | Activate customer | Yes |

---

## 🚗 Vehicle APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/vehicles` | List vehicles (paginated) | Yes |
| GET | `/admin/vehicles/{id}` | Get vehicle details | Yes |
| PATCH | `/admin/vehicles/{id}` | Update vehicle | Yes |
| POST | `/admin/vehicles/{id}/verify` | Verify vehicle documents | Yes |
| GET | `/admin/vehicles/{id}/documents` | Get vehicle documents | Yes |

---

## 📅 Booking APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/bookings` | List bookings (paginated) | Yes |
| GET | `/admin/bookings/{id}` | Get booking details | Yes |
| PATCH | `/admin/bookings/{id}/status` | Update booking status | Yes |
| POST | `/admin/bookings/{id}/cancel` | Cancel booking | Yes |
| POST | `/admin/bookings/{id}/refund` | Process refund | Yes |

---

## ✅ Verification/KYC APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/verifications` | List verifications | Yes |
| GET | `/admin/verifications/{id}` | Get verification details | Yes |
| POST | `/admin/verifications/{id}/approve` | Approve verification | Yes |
| POST | `/admin/verifications/{id}/reject` | Reject verification | Yes |
| GET | `/admin/verifications/{id}/documents` | Get KYC documents | Yes |

---

## 💰 Payment APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/payments` | List transactions | Yes |
| GET | `/admin/payments/{id}` | Get transaction details | Yes |
| GET | `/admin/payouts` | List payouts | Yes |
| POST | `/admin/payouts` | Trigger payout | Yes |
| GET | `/admin/payouts/{id}` | Get payout details | Yes |

---

## 💳 Wallet APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/wallets` | List wallets | Yes |
| GET | `/admin/wallets/{id}` | Get wallet details | Yes |
| POST | `/admin/wallets/{id}/topup` | Top up wallet | Yes |
| POST | `/admin/wallets/{id}/withdraw` | Withdraw from wallet | Yes |

---

## 🔔 Notification APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/notifications` | List notifications | Yes |
| PATCH | `/admin/notifications/{id}/read` | Mark as read | Yes |
| DELETE | `/admin/notifications/{id}` | Delete notification | Yes |

---

## 🔍 Audit APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/audit-logs` | List audit logs | Yes |
| GET | `/admin/audit-logs/{id}` | Get audit detail | Yes |
| GET | `/admin/audit-logs?action=XXX` | Filter by action | Yes |

---

## 📤 Storage APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| POST | `/admin/storage/upload-url` | Get presigned upload URL | Yes |
| POST | `/admin/storage/download-url` | Get presigned download URL | Yes |
| DELETE | `/admin/storage/{path}` | Delete file | Yes |

---

## 🏪 Shop APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/shops` | List shops | Yes |
| GET | `/admin/shops/{id}` | Get shop details | Yes |
| PATCH | `/admin/shops/{id}` | Update shop | Yes |

---

## 🎟️ Offer APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/offers` | List offers | Yes |
| POST | `/admin/offers` | Create offer | Yes |
| PATCH | `/admin/offers/{id}` | Update offer | Yes |
| DELETE | `/admin/offers/{id}` | Delete offer | Yes |

---

## ⭐ Review APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/reviews` | List reviews | Yes |
| GET | `/admin/reviews/{id}` | Get review details | Yes |
| PATCH | `/admin/reviews/{id}` | Update review status | Yes |
| DELETE | `/admin/reviews/{id}` | Delete review | Yes |

---

## 🎓 User (Admin) Management APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/users` | List admin users | Yes |
| POST | `/admin/users` | Create admin user | Yes |
| PATCH | `/admin/users/{id}` | Update admin user | Yes |
| DELETE | `/admin/users/{id}` | Delete admin user | Yes |

---

## ⚙️ Settings APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/settings` | Get system settings | Yes |
| PATCH | `/admin/settings` | Update settings | Yes |
| GET | `/admin/settings/{key}` | Get specific setting | Yes |

---

## ❓ Support APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/support` | List support tickets | Yes |
| GET | `/admin/support/{id}` | Get ticket details | Yes |
| PATCH | `/admin/support/{id}` | Update ticket status | Yes |

---

## 📋 Reports APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/reports` | List reports | Yes |
| POST | `/admin/reports/export` | Export data | Yes |
| GET | `/admin/reports/{id}` | Get report | Yes |

---

## 🔧 Jobs/Background Tasks APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/jobs` | List background jobs | Yes |
| POST | `/admin/jobs` | Create job | Yes |
| PATCH | `/admin/jobs/{id}` | Update job status | Yes |

---

## 📄 Damage & Dispute APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/damages` | List damage claims | Yes |
| GET | `/admin/damages/{id}` | Get damage details | Yes |
| POST | `/admin/damages/{id}/approve` | Approve damage claim | Yes |
| POST | `/admin/damages/{id}/reject` | Reject damage claim | Yes |
| GET | `/admin/disputes` | List disputes | Yes |
| POST | `/admin/disputes/{id}/resolve` | Resolve dispute | Yes |

---

## 🧪 Test/Health APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/health` | Health check | No |
| GET | `/api/v1/health` | API health check | No |
| GET | `/api/v1/test/auth` | Test authentication | Yes |
| GET | `/api/v1/test/admin-only` | Test admin role | Yes |
| GET | `/api/v1/test/permission` | Test permissions | Yes |

---

## 📝 Common Query Parameters

All list endpoints accept:
- `page=1` - Page number
- `limit=20` - Items per page (max 100)
- `search=text` - Search query
- `sortBy=fieldName` - Sort field
- `sortOrder=ASC|DESC` - Sort order
- `status=ACTIVE` - Filter by status
- `dateFrom=2024-01-01` - Date range start
- `dateTo=2024-01-31` - Date range end

---

## 🔑 Header Requirements

**All authenticated endpoints require:**
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

**Optional headers:**
```
X-Request-ID: unique-id-for-tracing
X-Client-Version: 1.0.0
```

---

## 📊 Response Format

**Success (200-299):**
```json
{
  "data": {...} or [...],
  "pagination": {...},
  "message": "Optional success message"
}
```

**Error (400+):**
```json
{
  "error": {
    "message": "Error description",
    "code": "ERROR_CODE",
    "details": {...}
  }
}
```

---

## ⏱️ Rate Limits

- **General:** 100 requests/15 minutes per IP
- **Auth:** 10 attempts/15 minutes per IP
- **OTP:** 5 attempts per session
- **Upload:** 100 MB max file size

---

## 🔄 Pagination Example

```bash
# First page (20 items)
GET /admin/partners?page=1&limit=20

# Next page
GET /admin/partners?page=2&limit=20

# With sorting and filtering
GET /admin/partners?page=1&limit=20&status=ACTIVE&sortBy=name&sortOrder=ASC
```

**Response includes:**
```json
{
  "data": [...],
  "pagination": {
    "total": 45,
    "page": 1,
    "limit": 20,
    "pages": 3,
    "hasNext": true,
    "hasPrev": false
  }
}
```

---

## 🚀 Common Workflows

### Complete Login Flow
```
1. POST /admin/auth/login {identifier, password}
   ↓ Get sessionId
2. POST /admin/auth/verify-2fa {sessionId, otp}
   ↓ Get rawToken
3. Store token in localStorage/sessionStorage
4. Add to Authorization header for all requests
```

### Get Dashboard Data
```
1. GET /admin/auth/me (verify authenticated)
2. GET /admin/dashboard (main overview)
3. GET /admin/dashboard/stats (statistics)
4. GET /admin/dashboard/urgent-alerts (alerts)
```

### List & Filter Partners
```
1. GET /admin/partners?page=1&limit=20&status=ACTIVE
2. GET /admin/partners/{id} (for detailed view)
3. PATCH /admin/partners/{id} (to update status)
```

### Process Payment
```
1. GET /admin/payments?status=PENDING
2. GET /admin/payments/{id} (verify details)
3. POST /admin/payouts (trigger payout)
4. GET /admin/payouts/{id} (confirm payout)
```

---

## 💰 Platform Fee APIs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/admin/platform-fee` | Get active platform fee configuration | Yes |
| PUT | `/admin/platform-fee` | Update platform fee (fixed/percentage) | Yes |

---

## 📞 Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| INVALID_CREDENTIALS | 401 | Wrong email/password |
| OTP_INVALID | 401 | Wrong OTP |
| OTP_ATTEMPTS_EXCEEDED | 429 | Too many OTP attempts |
| OTP_EXPIRED | 401 | OTP session expired |
| NOT_FOUND | 404 | Resource doesn't exist |
| FORBIDDEN | 403 | Permission denied |
| VALIDATION_ERROR | 400 | Invalid input |
| RATE_LIMIT_EXCEEDED | 429 | Too many requests |
| CONFLICT | 409 | Duplicate/conflicting data |
| INTERNAL_SERVER_ERROR | 500 | Server error |

---

**Last Updated:** January 2024 | **Version:** 1.0.0
