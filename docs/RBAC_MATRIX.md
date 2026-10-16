# GONGO RBAC & Permissions Matrix

This document provides the authoritative mapping between canonical roles, granular permissions, and domain operations across the unified GONGO platform.

## 1. Canonical Roles

- `CUSTOMER`: End-user renting bikes and cars.
- `PARTNER`: Verified fleet and vehicle owner listing vehicles for rental.
- `ADMIN`: Platform administrator managing partners, vehicles, bookings, fees, and operations.
- `SUPER_ADMIN`: Root administrator with full system-wide bypass and user management.
- `SUPPORT_EXECUTIVE`: Customer/Partner support agent with read-only operational visibility and ticket resolution privileges.

---

## 2. Granular Permissions Matrix

| Domain & Permission | Description | CUSTOMER | PARTNER | ADMIN | SUPER_ADMIN | SUPPORT_EXECUTIVE |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **customer:profile:read** | Read own customer profile | ✅ | ❌ | ✅ | ✅ | ✅ |
| **customer:profile:update** | Update own profile | ✅ | ❌ | ❌ | ✅ | ❌ |
| **customer:address:read** | View saved addresses | ✅ | ❌ | ❌ | ✅ | ❌ |
| **customer:address:manage** | Add/edit/delete saved address | ✅ | ❌ | ❌ | ✅ | ❌ |
| **customer:document:upload** | Upload customer KYC / DL documents | ✅ | ❌ | ❌ | ✅ | ❌ |
| **partner:profile:read** | Read partner shop/profile | ❌ | ✅ | ✅ | ✅ | ✅ |
| **partner:profile:update** | Update partner profile/shop | ❌ | ✅ | ❌ | ✅ | ❌ |
| **partner:kyc:submit** | Upload and submit KYC documents | ❌ | ✅ | ❌ | ✅ | ❌ |
| **partner:kyc:verify** | Approve or reject partner KYC | ❌ | ❌ | ✅ | ✅ | ❌ |
| **partner:bank:manage** | Manage encrypted bank details | ❌ | ✅ | ❌ | ✅ | ❌ |
| **partner:earnings:read** | View earnings & wallet breakdown | ❌ | ✅ | ✅ | ✅ | ❌ |
| **partner:payout:request** | Request wallet payout | ❌ | ✅ | ❌ | ✅ | ❌ |
| **partner:payout:approve** | Approve and trigger Cashfree payout | ❌ | ❌ | ✅ | ✅ | ❌ |
| **vehicle:read** | Browse vehicles & inventory | ✅ | ✅ | ✅ | ✅ | ✅ |
| **vehicle:create** | Create new vehicle listing | ❌ | ✅ | ❌ | ✅ | ❌ |
| **vehicle:update** | Update own vehicle listing | ❌ | ✅ | ❌ | ✅ | ❌ |
| **vehicle:delete** | Deactivate/delete own vehicle | ❌ | ✅ | ❌ | ✅ | ❌ |
| **vehicle:verify** | Verify and approve vehicle listing | ❌ | ❌ | ✅ | ✅ | ❌ |
| **booking:read** | View booking details | ✅ | ✅ | ✅ | ✅ | ✅ |
| **booking:create** | Create rental booking & quote | ✅ | ❌ | ❌ | ✅ | ❌ |
| **booking:update** | Accept/reject booking request | ❌ | ✅ | ✅ | ✅ | ❌ |
| **booking:cancel** | Cancel booking | ✅ | ❌ | ✅ | ✅ | ❌ |
| **payment:create** | Initiate Cashfree payment order | ✅ | ❌ | ❌ | ✅ | ❌ |
| **payment:verify** | Verify payment completion | ✅ | ❌ | ❌ | ✅ | ❌ |
| **payment:read** | Read payment & transaction history | ✅ | ❌ | ✅ | ✅ | ❌ |
| **payment:refund** | Approve and initiate refund | ❌ | ❌ | ✅ | ✅ | ❌ |
| **commission:manage** | Set platform commission rates | ❌ | ❌ | ✅ | ✅ | ❌ |
| **platform_fee:manage** | Configure checkout platform fee | ❌ | ❌ | ✅ | ✅ | ❌ |
| **admin:dashboard:read** | View platform metrics & KPIs | ❌ | ❌ | ✅ | ✅ | ✅ |
| **admin:users:manage** | Manage admin users & roles | ❌ | ❌ | ✅ | ✅ | ❌ |
| **admin:audit:read** | Read administrative audit trail | ❌ | ❌ | ✅ | ✅ | ❌ |
| **admin:settings:manage** | Manage platform global settings | ❌ | ❌ | ✅ | ✅ | ❌ |
| **admin:disputes:resolve** | Resolve customer/partner disputes | ❌ | ❌ | ✅ | ✅ | ✅ |
| **admin:support:manage** | Manage support tickets & replies | ❌ | ❌ | ✅ | ✅ | ✅ |
| **admin:notifications:send** | Send broadcast notifications | ❌ | ❌ | ✅ | ✅ | ❌ |

---

## 3. Resource Ownership Rules (BOLA / IDOR Defense)

Holding a valid role or permission is **never sufficient** for accessing private entity instances:
1. **Customer Scoping**: Customers can only view/modify records where `customer_id === req.user.id`.
2. **Partner Scoping**: Partners can only view/modify vehicles, earnings, bank accounts, and booking handoffs where `partner_id === req.user.partnerId`.
3. **Admin Exemption**: Administrators with proper permissions may access records across tenants, but every administrative mutation is written to the immutable audit trail (`admin_audit_logs`).
