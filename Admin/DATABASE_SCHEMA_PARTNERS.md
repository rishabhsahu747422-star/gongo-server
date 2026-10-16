# 🗄️ Admin Backend - Partners Database Schema

## 📋 Overview

Admin backend **DIRECTLY accesses database tables** - NO separate schema needed to be created!
The schema is already in place in the Partner backend's PostgreSQL database.

---

## 🔗 Database Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     GONGO Database (PostgreSQL)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┐    ┌──────────────────┐                          │
│  │  users table     │    │  partners table  │                          │
│  │  (users)         │────│  (partners)      │                          │
│  └────────┬─────────┘    └────────┬─────────┘                          │
│           │                       │                                     │
│           │    ┌──────────────────┼──────────────────┐                 │
│           │    │                  │                  │                 │
│           ▼    ▼                  ▼                  ▼                 │
│    ┌────────────────┐  ┌──────────────────┐  ┌──────────────────┐     │
│    │   partners     │  │ partner_documents│  │partner_bank_accts│     │
│    │   (joined)     │  │  (documents)     │  │  (bank info)     │     │
│    └────────────────┘  └──────────────────┘  └──────────────────┘     │
│                                                                          │
│    ┌────────────────────────────────────────────────────────────────┐  │
│    │                    Other Related Tables                       │  │
│    │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐           │  │
│    │  │vehicles │  │bookings │  │ earnings│  │ payouts │           │  │
│    │  └─────────┘  └─────────┘  └─────────┘  └─────────┘           │  │
│    └────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 Main Tables Used in Admin Backend

### 1. `users` Table
**Location:** `users` (in Partner database)

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `id` | UUID | Primary key | `550e8400-e29b-41d4-a716-446655440000` |
| `auth_id` | VARCHAR(128) | Firebase/Supabase auth ID | `uid_12345` |
| `auth_provider` | VARCHAR(50) | Auth provider (firebase/supabase) | `firebase` |
| `role` | VARCHAR(20) | User role (ADMIN/PARTNER/CUSTOMER) | `PARTNER` |
| `name` | VARCHAR(150) | User's full name | `Rahul Sharma` |
| `country_code` | VARCHAR(8) | Phone country code | `+91` |
| `phone` | VARCHAR(20) | Phone number | `9876543210` |
| `email` | VARCHAR(255) | Email address | `rahul@example.com` |
| `is_active` | BOOLEAN | Account status | `true` |
| `created_at` | TIMESTAMPTZ | Created timestamp | `2024-01-01T10:00:00Z` |
| `updated_at` | TIMESTAMPTZ | Updated timestamp | `2024-01-15T14:30:00Z` |

**Indexes:**
- `idx_users_auth_provider_auth_id` (unique on auth_provider, auth_id)
- `idx_users_country_code_phone` (unique on country_code, phone)
- `idx_users_email_lower` (unique on LOWER(email))
- `idx_users_role`

---

### 2. `partners` Table
**Location:** `partners` (in Partner database)

| Column | Type | Description | Example | Status |
|--------|------|-------------|---------|--------|
| `id` | UUID | Primary key (auto-generated) | `partner-uuid-here` | ✅ Created |
| `user_id` | UUID | Foreign key to users.id | `user-uuid-here` | ✅ Created |
| `partner_status` | VARCHAR(20) | Status: ONLINE/OFFLINE | `OFFLINE` | ✅ Created |
| `kyc_status` | VARCHAR(30) | KYC status | `PENDING` | ✅ Created |
| `profile_image_url` | TEXT | Partner profile image | `https://...` | ✅ Created |
| `rating` | NUMERIC(3,2) | Partner rating (0-5) | `4.85` | ✅ Created |
| `review_count` | INTEGER | Number of reviews | `45` | ✅ Created |
| `registered_since` | VARCHAR(50) | Registration date string | `2024` | ✅ Created |
| `is_active` | BOOLEAN | Account active status | `true` | ✅ Created |
| `created_at` | TIMESTAMPTZ | Created timestamp | `2024-01-01T10:00:00Z` | ✅ Created |
| `updated_at` | TIMESTAMPTZ | Updated timestamp | `2024-01-15T14:30:00Z` | ✅ Created |

**Indexes:**
- `idx_partners_user_id`
- `idx_partners_kyc_status`
- `idx_partners_partner_status`

**Triggers:**
- `trg_partners_updated_at` (auto-updates updated_at on change)

---

## 🔍 How Admin Backend Accesses Partners

### Repository Layer
**File:** `server/Admin/src/repositories/admin-partner.repository.js`

```javascript
class AdminPartnerRepository extends BaseRepository {
  constructor() {
    super('partners', 'id');  // Table name: 'partners', PK: 'id'
  }
}
```

### Service Layer
**File:** `server/Admin/src/services/admin-partner.service.js`

### Controller Layer
**File:** `server/Admin/src/controllers/admin-partner.controller.js`

### Route
**File:** `server/Admin/src/routes/admin.routes.js` → `router.use('/partners', adminPartnerRoutes)`

---

## 📝 Database Query Examples (Admin Backend)

### 1. List Partners with Search & Filters

```javascript
// Repository: listPartners()
const sql = `
  SELECT
    p.id, p.user_id, p.business_name, p.business_address, p.city,
    p.latitude, p.longitude, p.operating_info, p.partner_status,
    p.kyc_status, p.profile_image_url, p.rating, p.review_count,
    p.registered_since, p.is_active, p.created_at, p.updated_at,
    u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
    COALESCE(v.vehicle_count, 0)::int AS vehicle_count,
    COUNT(*) OVER()::int AS full_count
  FROM partners p
  JOIN users u ON p.user_id = u.id
  LEFT JOIN (
    SELECT partner_id, COUNT(*)::int AS vehicle_count
    FROM vehicles WHERE is_archived = false GROUP BY partner_id
  ) v ON v.partner_id = p.id
  WHERE p.partner_status = $1 AND p.kyc_status = $2
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT $3 OFFSET $4;
`;
```

**Response:**
```json
{
  "partners": [
    {
      "id": "partner-uuid",
      "userId": "user-uuid",
      "name": "Rahul Sharma",
      "email": "rahul@example.com",
      "phone": "+919876543210",
      "businessName": "ABC Transport",
      "businessAddress": "123 Main St",
      "city": "Mumbai",
      "partnerStatus": "ONLINE",
      "kycStatus": "VERIFIED",
      "rating": 4.85,
      "vehicleCount": 10,
      "createdAt": "2024-01-01T10:00:00Z"
    }
  ],
  "total": 45
}
```

### 2. Get Partner by ID

```javascript
// Repository: findPartnerById(partnerId)
const sql = `
  SELECT
    p.id, p.user_id, p.business_name, p.business_address, p.city,
    u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
    p.partner_status, p.kyc_status, p.rating, p.review_count,
    p.is_active
  FROM partners p
  JOIN users u ON p.user_id = u.id
  WHERE p.id = $1
  LIMIT 1;
`;
```

### 3. Update Partner Status

```javascript
// Repository: updatePartnerStatus(partnerId, { isActive, partnerStatus })
const updateSql = `
  UPDATE partners
  SET partner_status = $2, updated_at = CURRENT_TIMESTAMP
  WHERE id = $1
  RETURNING *;
`;

// Also sync users.is_active
const syncUserSql = `
  UPDATE users SET is_active = $2, updated_at = CURRENT_TIMESTAMP
  WHERE id = $1;
`;
```

---

## 📋 Other Related Tables (Partner Data)

### `partner_documents` Table
Stores partner KYC documents

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `partner_id` | UUID | Foreign key to partners.id |
| `document_type` | VARCHAR | Aadhaar/PAN/Voter ID |
| `document_number` | VARCHAR | Document number |
| `storage_key` | TEXT | S3 storage path |
| `verification_status` | VARCHAR | PENDING/VERIFIED/REJECTED |
| `rejection_reason` | TEXT | Reason for rejection |
| `created_at` | TIMESTAMPTZ | Created timestamp |
| `updated_at` | TIMESTAMPTZ | Updated timestamp |

### `partner_bank_accounts` Table
Stores partner bank account info

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `partner_id` | UUID | Foreign key to partners.id |
| `account_holder_name` | VARCHAR | Account holder name |
| `account_number_masked` | VARCHAR | Masked account number |
| `ifsc_code` | VARCHAR | IFSC code |
| `bank_name` | VARCHAR | Bank name |
| `is_primary` | BOOLEAN | Is primary account |
| `verification_status` | VARCHAR | PENDING/VERIFIED |
| `created_at` | TIMESTAMPTZ | Created timestamp |
| `updated_at` | TIMESTAMPTZ | Updated timestamp |

### `vehicles` Table
Partner's vehicle fleet

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `partner_id` | UUID | Foreign key to partners.id |
| `category` | VARCHAR | SEDAN/SUV/LUXURY |
| `brand` | VARCHAR | Maruti/Honda/Tata |
| `model` | VARCHAR | Swift/Brezza |
| `registration_number` | VARCHAR | MH-01-AB-1234 |
| `manual_status` | VARCHAR | ONLINE/OFFLINE |
| `rental_status` | VARCHAR | IDLE/BOOKED/ACTIVE |
| `verification_status` | VARCHAR | PENDING/VERIFIED/REJECTED |
| `is_archived` | BOOLEAN | Is archived |
| `created_at` | TIMESTAMPTZ | Created timestamp |

### `bookings` Table
Partner's bookings

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `booking_number` | VARCHAR | Booking number |
| `partner_id` | UUID | Foreign key to partners.id |
| `customer_id` | UUID | Foreign key to users.id |
| `booking_status` | VARCHAR | UPCOMING/ACTIVE/COMPLETED/CANCELLED |
| `start_at` | TIMESTAMPTZ | Booking start time |
| `created_at` | TIMESTAMPTZ | Created timestamp |

---

## 🔐 Database Access Pattern

### 1. Base Repository (`BaseRepository`)
```javascript
// server/Admin/src/db/base.repository.js
class BaseRepository {
  constructor(tableName, primaryKey) {
    this.tableName = tableName;
    this.primaryKey = primaryKey;
  }

  async query(text, params) {
    const client = await pool.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }
}
```

### 2. Partner Repository Extension
```javascript
// server/Admin/src/repositories/admin-partner.repository.js
class AdminPartnerRepository extends BaseRepository {
  constructor() {
    super('partners', 'id');  // Connects to 'partners' table
  }
}
```

### 3. Query Execution
```javascript
// All queries use parameterized statements (防 SQL injection)
const sql = 'SELECT * FROM partners WHERE id = $1';
const res = await executor(sql, [partnerId]);
```

---

## 📌 Key Points for Frontend Developers

### ✅ What You Need to Know

1. **No schema creation needed!** 
   - Database tables already exist in Partner backend
   - Admin backend just reads from these tables

2. **Main tables:**
   - `users` - User identity (name, email, phone, role)
   - `partners` - Partner details (business info, status, KYC)
   - `partner_documents` - KYC documents
   - `partner_bank_accounts` - Bank account info
   - `vehicles` - Partner's vehicles
   - `bookings` - Partner's bookings

3. **Relationships:**
   - `partners.user_id` → `users.id` (1-to-1)
   - `vehicles.partner_id` → `partners.id` (1-to-many)
   - `bookings.partner_id` → `partners.id` (1-to-many)

4. **API Endpoints:**
   - `GET /api/v1/admin/partners` → List all partners (with pagination)
   - `GET /api/v1/admin/partners/{id}` → Get single partner details
   - `PATCH /api/v1/admin/partners/{id}` → Update partner status
   - `GET /api/v1/admin/partners/{id}/documents` → Get KYC documents
   - `GET /api/v1/admin/partners/{id}/vehicles` → Get partner's vehicles
   - `GET /api/v1/admin/partners/{id}/bookings` → Get partner's bookings

### ❓ Schema Verification

Run this query in PostgreSQL to see if tables exist:

```sql
-- Check if partners table exists
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name = 'partners';

-- Check partners columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'partners';

-- Check users columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'users';
```

---

## 🎯 Admin Backend Partner API Usage

### Example: List Partners with Pagination

```javascript
// API Endpoint
GET /api/v1/admin/partners?page=1&limit=20&status=ONLINE&kycStatus=VERIFIED

// Response
{
  "partners": [
    {
      "id": "partner-uuid",
      "name": "Rahul Sharma",
      "email": "rahul@example.com",
      "businessName": "ABC Transport",
      "partnerStatus": "ONLINE",
      "kycStatus": "VERIFIED",
      "rating": 4.85,
      "vehicleCount": 10,
      "createdAt": "2024-01-01T10:00:00Z"
    }
  ],
  "pagination": {
    "total": 45,
    "page": 1,
    "limit": 20,
    "pages": 3
  }
}
```

### Example: Get Partner Details

```javascript
// API Endpoint
GET /api/v1/admin/partners/partner-uuid

// Response
{
  "id": "partner-uuid",
  "name": "Rahul Sharma",
  "email": "rahul@example.com",
  "phone": "+919876543210",
  "businessName": "ABC Transport",
  "businessAddress": "123 Main St, Mumbai",
  "city": "Mumbai",
  "partnerStatus": "ONLINE",
  "kycStatus": "VERIFIED",
  "rating": 4.85,
  "reviewCount": 45,
  "isActive": true,
  "createdAt": "2024-01-01T10:00:00Z"
}
```

---

## 📂 File Structure

```
server/
├── Admin/
│   ├── src/
│   │   ├── db/
│   │   │   └── base.repository.js          ← Base class for DB access
│   │   ├── repositories/
│   │   │   ├── admin-partner.repository.js ← Partner queries
│   │   │   └── user.repository.js          ← User queries
│   │   ├── services/
│   │   │   └── admin-partner.service.js    ← Partner business logic
│   │   ├── controllers/
│   │   │   └── admin-partner.controller.js ← Partner API handlers
│   │   └── routes/
│   │       └── admin.routes.js             ← Partner routes
│   └── tests/
│       └── integration/admin-partner.test.js
└── Partner/
    └── database/
        └── migrations/
            ├── 002_create_users_table.js       ← users table schema
            └── 003_create_partners_table.js    ← partners table schema
```

---

## ✅ Summary

| Question | Answer |
|----------|--------|
| **Database tables need to be created?** | ❌ NO! Already exists in Partner backend |
| **Admin backend creates schema?** | ❌ NO! Only reads from existing tables |
| **What tables are used?** | `users`, `partners`, `partner_documents`, `partner_bank_accounts`, `vehicles`, `bookings` |
| **How to access?** | API endpoints (no direct DB access from frontend) |
| **Frontend needs to know schema?** | ✅ YES! To understand API responses |
| **Migration files exist?** | ✅ YES! `002_create_users_table.js`, `003_create_partners_table.js` |

---

**Last Updated:** January 2024  
**Database:** PostgreSQL (Supabase)  
**Schema:** Already exists, no creation needed! ✅
