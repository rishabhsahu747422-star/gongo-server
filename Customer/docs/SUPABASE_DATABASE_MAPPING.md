# GONGO Customer Backend — Supabase Database Mapping

This document specifies the exact mapping between the GONGO Customer Backend application concepts and the authoritative Supabase PostgreSQL schema.

---

## 1. Core Architectural Principles

1. **Source of Truth**: The Supabase PostgreSQL database is the sole authoritative data store. No secondary local database or shadow tables are maintained.
2. **Authentication Flow**:
   ```
   Customer App (Mobile/Web)
          ↓ (Supabase Access Token)
   Supabase Auth (auth.users)
          ↓ (auth.users.id)
   Customer Backend (Verify JWT & map auth_id)
          ↓
   public.users (id, role='customer', auth_id=auth.users.id)
          ↓
   public.customer_profiles (user_id = public.users.id)
   ```
3. **Storage Architecture**:
   ```
   Customer Backend
          ↓
   Supabase Storage Client (@supabase/supabase-js)
          ↓
   Bucket: `gongo-uploads` (Private, 5MB limit)
   ```
4. **Data Access**: Standard PostgreSQL connection via `node-postgres` (`pg`) using connection pooling, parameterized queries, and ACID transactions.

---

## 2. Table & Concept Mapping

| Backend Concept | Supabase Table | Primary Key | Key Foreign Keys & Unique Constraints | Key Columns | Used By Backend Components | Used By Endpoints |
|---|---|---|---|---|---|---|
| **User Identity** | `public.users` | `id` (UUID) | `phone` (UNIQUE), `auth_id` (varchar) | `id`, `phone`, `role`, `status`, `auth_id`, `auth_provider`, `name`, `email`, `is_active`, `created_at`, `updated_at` | `UserRepository`, `CustomerRepository`, `auth.middleware.js`, `auth.service.js` | `POST /api/v1/auth/send-otp`<br>`POST /api/v1/auth/verify-otp`<br>`GET /api/v1/customers/me`<br>`PATCH /api/v1/customers/me` |
| **Customer Profile** | `public.customer_profiles` | `id` (UUID) | `user_id` -> `users(id)` (UNIQUE), `city_id` -> `cities(id)`, `state_id` -> `states(id)` | `user_id`, `full_name`, `date_of_birth`, `gender`, `profile_photo_url`, `profile_photo_path`, `address_line1`, `address_line2`, `postal_code`, `emergency_contact_name`, `emergency_contact_phone`, `occupation_type` | `CustomerRepository`, `CustomerService` | `GET /api/v1/customers/me`<br>`PATCH /api/v1/customers/me`<br>`POST /api/v1/customers/me/avatar` |
| **Customer Documents (KYC / License)** | `public.customer_documents` | `id` (UUID) | `customer_id` -> `users(id)` | `customer_id`, `document_type`, `document_number`, `file_url`, `storage_path`, `file_name`, `file_type`, `file_size_bytes`, `verification_status`, `rejection_reason`, `uploaded_at`, `verified_at` | `CustomerDocumentRepository`, `StorageService`, `CustomerService` | `GET /api/v1/customers/me/documents`<br>`POST /api/v1/customers/me/documents/upload-url`<br>`POST /api/v1/customers/me/documents` |
| **Saved Addresses** | `public.customer_saved_addresses` | `id` (UUID) | `customer_id` -> `users(id)`, `city_id` -> `cities(id)`, `state_id` -> `states(id)` | `customer_id`, `address_label`, `address_line1`, `address_line2`, `city_id`, `state_id`, `postal_code`, `latitude`, `longitude`, `is_default`, `is_active` | `AddressRepository`, `AddressService` | `POST /api/v1/customers/me/addresses`<br>`GET /api/v1/customers/me/addresses`<br>`GET /api/v1/customers/me/addresses/:id`<br>`PATCH /api/v1/customers/me/addresses/:id`<br>`DELETE /api/v1/customers/me/addresses/:id`<br>`POST /api/v1/customers/me/addresses/:id/default` |
| **Vehicles** | `public.vehicles` | `id` (UUID) | `partner_id` -> `partners(id)`, `shop_id` -> `shops(id)`, `model_id` -> `vehicle_models(id)` | `partner_id`, `shop_id`, `model_id`, `registration_number`, `color`, `status`, `verification_status`, `is_active`, `is_available`, `vehicle_description`, `manufacture_year`, `engine_capacity`, `current_odometer`, `helmet_included` | `VehicleRepository`, `VehicleService`, `BookingService`, `PricingService` | `GET /api/v1/vehicles`<br>`GET /api/v1/vehicles/nearby`<br>`GET /api/v1/vehicles/:id` |
| **Vehicle Models** | `public.vehicle_models` | `id` (UUID) | `brand_id` -> `vehicle_brands(id)`, `category_id` -> `vehicle_categories(id)` | `brand_id`, `category_id`, `name`, `code`, `description`, `is_active` | `VehicleRepository` | `GET /api/v1/vehicles`<br>`GET /api/v1/vehicles/:id` |
| **Vehicle Brands** | `public.vehicle_brands` | `id` (UUID) | `code` (UNIQUE), `name` (UNIQUE) | `name`, `code`, `logo_url`, `is_active` | `VehicleRepository` | `GET /api/v1/vehicles`<br>`GET /api/v1/vehicles/:id` |
| **Vehicle Categories** | `public.vehicle_categories` | `id` (UUID) | `code` (UNIQUE), `name` (UNIQUE) | `name`, `code`, `description`, `is_active` | `VehicleRepository` | `GET /api/v1/vehicles`<br>`GET /api/v1/vehicles/categories` |
| **Vehicle Pricing** | `public.vehicle_pricing` | `id` (UUID) | `vehicle_id` -> `vehicles(id)` | `vehicle_id`, `pricing_type`, `price`, `min_duration`, `max_duration`, `security_deposit`, `is_active`, `effective_from`, `effective_until` | `VehicleRepository`, `PricingService`, `BookingService` | `GET /api/v1/vehicles`<br>`GET /api/v1/vehicles/:id`<br>`POST /api/v1/pricing/quote`<br>`POST /api/v1/bookings` |
| **Vehicle Images** | `public.vehicle_images` | `id` (UUID) | `vehicle_id` -> `vehicles(id)` | `vehicle_id`, `file_url`, `storage_path`, `image_type`, `display_order`, `is_primary`, `is_active` | `VehicleRepository`, `VehicleService` | `GET /api/v1/vehicles`<br>`GET /api/v1/vehicles/:id` |
| **Shops** | `public.shops` | `id` (UUID) | `partner_id` -> `partners(id)`, `city_id` -> `cities(id)`, `state_id` -> `states(id)` | `partner_id`, `name`, `address_line1`, `address_line2`, `city_id`, `state_id`, `postal_code`, `latitude`, `longitude`, `status`, `verification_status`, `is_active`, `operating_info` | `VehicleRepository`, `BookingRepository` | `GET /api/v1/vehicles`<br>`GET /api/v1/vehicles/nearby`<br>`GET /api/v1/vehicles/:id`<br>`POST /api/v1/bookings` |
| **Partners** | `public.partners` | `id` (UUID) | `user_id` -> `users(id)` (UNIQUE), `partner_code` (UNIQUE) | `user_id`, `partner_code`, `business_name`, `status`, `verification_status`, `is_active`, `rating`, `review_count` | `VehicleRepository`, `BookingRepository` | `GET /api/v1/vehicles`<br>`POST /api/v1/bookings` |
| **Cities** | `public.cities` | `id` (UUID) | `state_id` -> `states(id)` | `name`, `state_id`, `is_active` | `VehicleRepository` | `GET /api/v1/vehicles/cities` |
| **Bookings** | `public.bookings` | `id` (UUID) | `booking_number` (UNIQUE), `customer_id` -> `users(id)`, `partner_id` -> `partners(id)`, `vehicle_id` -> `vehicles(id)`, `shop_id` -> `shops(id)` | `booking_number`, `customer_id`, `partner_id`, `vehicle_id`, `shop_id`, `start_at`, `end_at`, `status`, `subtotal`, `discount_amount`, `extra_charges`, `tax_amount`, `platform_fee`, `total_amount`, `currency` | `BookingRepository`, `BookingService` | `POST /api/v1/bookings`<br>`GET /api/v1/bookings`<br>`GET /api/v1/bookings/:id`<br>`POST /api/v1/bookings/:id/cancel` |
| **Booking Price Breakdown** | `public.booking_price_breakdown` | `id` (UUID) | `booking_id` -> `bookings(id)` (UNIQUE) | `booking_id`, `base_amount`, `extra_charges`, `discount_amount`, `taxable_amount`, `tax_amount`, `platform_fee`, `security_deposit`, `total_amount`, `currency` | `BookingRepository`, `BookingService` | `POST /api/v1/bookings`<br>`GET /api/v1/bookings/:id` |
| **Booking Items** | `public.booking_items` | `id` (UUID) | `booking_id` -> `bookings(id)` | `booking_id`, `item_type`, `description`, `quantity`, `unit_price`, `amount` | `BookingRepository`, `BookingService` | `POST /api/v1/bookings`<br>`GET /api/v1/bookings/:id` |
| **Booking Customer Details** | `public.booking_customer_details` | `id` (UUID) | `booking_id` -> `bookings(id)` (UNIQUE) | `booking_id`, `full_name`, `phone`, `alternate_phone`, `id_type`, `id_reference` | `BookingRepository`, `BookingService` | `POST /api/v1/bookings`<br>`GET /api/v1/bookings/:id` |
| **Booking Cancellations** | `public.booking_cancellations` | `id` (UUID) | `booking_id` -> `bookings(id)` (UNIQUE), `cancelled_by` -> `users(id)`, `policy_id` -> `cancellation_policies(id)` | `booking_id`, `cancelled_by`, `cancellation_reason`, `cancelled_at`, `policy_id`, `hours_before_start`, `refund_percentage`, `eligible_refund_amount`, `refund_status` | `BookingRepository`, `BookingService` | `POST /api/v1/bookings/:id/cancel` |
| **Booking Status History** | `public.booking_status_history` | `id` (UUID) | `booking_id` -> `bookings(id)`, `changed_by` -> `users(id)` | `booking_id`, `old_status`, `new_status`, `changed_by`, `change_reason` | `BookingRepository` | `POST /api/v1/bookings`<br>`POST /api/v1/bookings/:id/cancel` |
| **Payments** | `public.payments` | `id` (UUID) | `booking_id` -> `bookings(id)` (UNIQUE), `customer_id` -> `users(id)`, `partner_id` -> `partners(id)`, `payment_number` (UNIQUE) | `booking_id`, `customer_id`, `partner_id`, `payment_number`, `amount`, `currency`, `payment_method`, `status`, `paid_at` | `PaymentRepository`, `PaymentService` | `POST /api/v1/payments/create-order`<br>`POST /api/v1/payments/verify`<br>`POST /api/v1/payments/webhook` |
| **Payment Attempts** | `public.payment_attempts` | `id` (UUID) | `payment_id` -> `payments(id)` | `payment_id`, `attempt_number`, `gateway`, `gateway_order_id`, `gateway_payment_id`, `amount`, `currency`, `status`, `failure_code`, `failure_reason` | `PaymentRepository`, `PaymentService` | `POST /api/v1/payments/create-order`<br>`POST /api/v1/payments/verify`<br>`POST /api/v1/payments/webhook` |
| **Payment Transactions** | `public.payment_transactions` | `id` (UUID) | `payment_id` -> `payments(id)`, `payment_attempt_id` -> `payment_attempts(id)` | `payment_id`, `payment_attempt_id`, `transaction_type`, `gateway`, `gateway_transaction_id`, `amount`, `currency`, `status` | `PaymentRepository`, `PaymentService` | `POST /api/v1/payments/verify`<br>`POST /api/v1/payments/webhook` |
| **Refunds** | `public.refunds` | `id` (UUID) | `payment_id` -> `payments(id)`, `booking_id` -> `bookings(id)`, `cancellation_id` -> `booking_cancellations(id)`, `refund_number` (UNIQUE) | `payment_id`, `booking_id`, `cancellation_id`, `refund_number`, `requested_amount`, `approved_amount`, `refunded_amount`, `currency`, `reason`, `status` | `PaymentRepository`, `PaymentService` | `POST /api/v1/bookings/:id/cancel` |
| **Reviews** | `public.reviews` | `id` (UUID) | `booking_id` -> `bookings(id)` (UNIQUE), `customer_id` -> `users(id)`, `partner_id` -> `partners(id)`, `vehicle_id` -> `vehicles(id)` | `booking_id`, `customer_id`, `partner_id`, `vehicle_id`, `rating`, `review_text`, `status` | `ReviewRepository`, `ReviewService` | Customer reviews endpoints |
| **Coupons** | `public.coupons` | `id` (UUID) | `code` (UNIQUE) | `code`, `name`, `description`, `discount_type`, `discount_value`, `max_discount_amount`, `min_booking_amount`, `usage_limit`, `usage_limit_per_customer`, `used_count`, `valid_from`, `valid_until`, `is_active` | `CouponRepository`, `CouponService`, `PricingService`, `BookingService` | `POST /api/v1/coupons/validate`<br>`POST /api/v1/pricing/quote`<br>`POST /api/v1/bookings` |
| **Coupon Redemptions** | `public.coupon_redemptions` | `id` (UUID) | `booking_id` -> `bookings(id)` (UNIQUE), `coupon_id` -> `coupons(id)`, `customer_id` -> `users(id)` | `coupon_id`, `customer_id`, `booking_id`, `discount_amount`, `redeemed_at` | `CouponRepository`, `CouponService`, `BookingService` | `POST /api/v1/bookings` |
| **Notifications** | `public.notifications` | `id` (UUID) | `user_id` -> `users(id)` | `user_id`, `notification_type`, `title`, `message`, `reference_type`, `reference_id`, `is_read`, `read_at`, `data` | `NotificationRepository`, `NotificationService` | `GET /api/v1/customers/me/notifications`<br>`PATCH /api/v1/customers/me/notifications/:id/read`<br>`POST /api/v1/customers/me/notifications/read-all` |
| **User Devices** | `public.user_devices` | `id` (UUID) | `user_id` -> `users(id)` | `user_id`, `device_token`, `platform`, `device_id`, `device_name`, `app_version`, `os_version`, `is_active`, `last_seen_at` | `DeviceTokenRepository`, `NotificationService` | `POST /api/v1/customers/me/devices`<br>`GET /api/v1/customers/me/devices`<br>`DELETE /api/v1/customers/me/devices/:id` |
| **Support Tickets** | `public.support_tickets` | `id` (UUID) | `ticket_number` (UNIQUE), `user_id` -> `users(id)`, `booking_id` -> `bookings(id)` | `ticket_number`, `user_id`, `booking_id`, `partner_id`, `subject`, `description`, `category`, `priority`, `status`, `assigned_to`, `resolved_at`, `closed_at` | `SupportTicketRepository`, `SupportService` | `POST /api/v1/customers/me/support/tickets`<br>`GET /api/v1/customers/me/support/tickets`<br>`GET /api/v1/customers/me/support/tickets/:id` |
| **Support Messages** | `public.support_messages` | `id` (UUID) | `ticket_id` -> `support_tickets(id)`, `sender_id` -> `users(id)` | `ticket_id`, `sender_id`, `message`, `is_internal` | `SupportTicketMessageRepository`, `SupportService` | `POST /api/v1/customers/me/support/tickets/:id/messages` |
| **Storage (Buckets & Objects)** | `storage.buckets`, `storage.objects` | `id` | Bucket `gongo-uploads` | `id`, `name`, `public=false`, `file_size_limit=5242880` | `StorageProvider`, `StorageService` | `POST /api/v1/customers/me/documents/upload-url`<br>`POST /api/v1/customers/me/avatar/upload-url` |

---

## 3. Real Supabase Enums and Check Constraints

| Column / Domain | Permitted Values |
|---|---|
| `users.role` | `'customer'`, `'partner'`, `'admin'`, `'support_executive'` |
| `users.status` | `'active'`, `'inactive'`, `'suspended'`, `'deleted'` |
| `customer_documents.document_type` | `'aadhaar'`, `'driving_license'`, `'pan'`, `'student_id'`, `'working_id'` |
| `customer_documents.verification_status` | `'pending'`, `'under_review'`, `'verified'`, `'rejected'`, `'expired'` |
| `customer_profiles.gender` | `'male'`, `'female'`, `'other'`, `'prefer_not_to_say'` |
| `customer_profiles.occupation_type` | `'student'`, `'working_professional'` |
| `vehicles.status` | `'pending'`, `'active'`, `'booked'`, `'maintenance'`, `'blocked'`, `'deactivated'` |
| `vehicles.verification_status` | `'pending'`, `'under_review'`, `'verified'`, `'rejected'` |
| `vehicle_pricing.pricing_type` | `'hourly'`, `'daily'` |
| `vehicle_images.image_type` | `'front'`, `'rear'`, `'side'`, `'interior'`, `'document'`, `'gallery'` |
| `bookings.status` | `'initiated'`, `'payment_pending'`, `'payment_completed'`, `'confirmed'`, `'pickup_scheduled'`, `'vehicle_picked'`, `'in_progress'`, `'return_pending'`, `'returned'`, `'completed'`, `'cancelled'`, `'refunded'` |
| `booking_cancellations.refund_status` | `'not_applicable'`, `'eligible'`, `'pending'`, `'processing'`, `'completed'`, `'failed'`, `'partial'` |
| `payments.payment_method` | `'upi'`, `'card'`, `'netbanking'`, `'wallet'`, `'emi'`, `'other'` |
| `payments.status` | `'initiated'`, `'pending'`, `'authorized'`, `'paid'`, `'failed'`, `'cancelled'`, `'refunded'`, `'partially_refunded'` |
| `payment_attempts.gateway` | `'cashfree'`, `'razorpay'` |
| `payment_attempts.status` | `'initiated'`, `'pending'`, `'authorized'`, `'captured'`, `'failed'`, `'cancelled'` |
| `payment_transactions.status` | `'pending'`, `'success'`, `'failed'`, `'reversed'` |
| `refunds.status` | `'requested'`, `'approved'`, `'processing'`, `'completed'`, `'failed'`, `'cancelled'`, `'partial'` |
| `reviews.rating` | `1` to `5` |
| `reviews.status` | `'published'`, `'hidden'`, `'reported'`, `'removed'` |
| `coupons.discount_type` | `'percentage'`, `'fixed'` |
| `support_tickets.category` | `'booking'`, `'payment'`, `'refund'`, `'vehicle'`, `'partner'`, `'account'`, `'technical'`, `'other'` |
| `support_tickets.priority` | `'low'`, `'medium'`, `'high'`, `'urgent'` |
| `support_tickets.status` | `'open'`, `'in_progress'`, `'waiting_for_user'`, `'resolved'`, `'closed'` |
