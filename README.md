# GONGO Unified Backend

Production-ready, consolidated Node.js/Express backend integrating Customer, Partner, and Admin marketplace services under a unified, secure architecture.

---

## 1. Directory Structure

```
server_unified/
├── Admin/                 # Original Admin backend service
├── Customer/              # Original Customer backend service
├── Partner/               # Original Partner backend service
├── src/
│   ├── app.js             # Master Express application builder
│   ├── server.js          # Master HTTP server bootstrap & graceful shutdown
│   ├── config/            # Centralized environment configuration
│   ├── shared/
│   │   ├── auth/          # Centralized roles, permissions, RBAC, ownership middleware
│   │   ├── constants/     # API constants & standard error codes
│   │   ├── errors/        # AppError & HTTP error subclasses
│   │   ├── middleware/    # Request ID, logging, validation
│   │   └── utils/         # Async handler and shared utilities
│   └── routes/            # Canonical sub-app route modules (/customer, /partner, /admin)
├── tests/                 # Unified test suite (unit & integration)
├── docs/
│   ├── INITIAL_AUDIT.md       # Architectural audit across services
│   ├── RBAC_MATRIX.md         # Canonical roles & permissions matrix
│   ├── API_ROUTE_MAPPING.md   # Endpoint mapping & authentication reference
│   └── INTEGRATION_REPORT.md  # Final implementation report
├── package.json           # Unified package configuration & scripts
├── jest.config.js         # Jest test runner configuration
├── .env.example           # Environment template
└── README.md
```

---

## 2. Protected Systems Notice

The following systems are **PROTECTED** and remain strictly unmodified:
1. **Supabase PostgreSQL Database**: Preserves all existing tables, foreign keys, constraints, and data records. No destructive migrations.
2. **Storage Implementation**: Preserves existing Supabase Storage and AWS S3 presigned URL generation and access rules.
3. **OTP SMS Delivery**: Preserves Renflair SMS Gateway and Supabase Auth flows, cooldowns, and retry limits.
4. **Cashfree Payments**: Preserves Cashfree Payment Gateway order creation, webhook verification, and Payout APIs.

---

## 3. Shared RBAC & Authorization Usage

```javascript
const {
  ROLES,
  PERMISSIONS,
  requireRoles,
  requirePermission,
  verifyOwnership,
} = require('./shared/auth');

// 1. Enforce Role-Based Access Control
router.get('/admin/overview', requireRoles(ROLES.ADMIN), handler);

// 2. Enforce Fine-Grained Permissions
router.post('/partner/vehicles', requirePermission(PERMISSIONS.VEHICLE_CREATE), handler);

// 3. Enforce Resource Ownership (BOLA / IDOR Defense)
router.get(
  '/partner/vehicles/:id',
  requireRoles(ROLES.PARTNER),
  verifyOwnership(async (req) => vehicleService.findById(req.params.id), { type: 'partner' }),
  handler
);
```

---

## 4. Local Startup & Commands

### Unified Server
```bash
# Start unified server on default port 8080
npm start

# Development mode with nodemon
npm run dev
```

### Standalone Service Start (Preserved)
```bash
npm run start:customer   # Runs Customer service independently on port 3000
npm run start:partner    # Runs Partner service independently on port 3001
npm run start:admin      # Runs Admin service independently on port 3002
```

### Running Tests
```bash
npm test                 # Runs unified test suite
npm run test:customer    # Runs original Customer test suite
npm run test:partner     # Runs original Partner test suite
npm run test:admin       # Runs original Admin test suite
```
