=== ENUMS ===
{}

=== STORAGE BUCKETS ===
[
  {
    "id": "gongo-uploads",
    "name": "gongo-uploads",
    "public": false,
    "file_size_limit": "5242880",
    "allowed_mime_types": [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf"
    ]
  }
]


================ TABLE: users ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - phone: varchar (NOT NULL)
  - role: varchar (NOT NULL) DEFAULT 'partner'::character varying
  - status: varchar (NOT NULL) DEFAULT 'active'::character varying
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
  - deleted_at: timestamptz (NULL)
  - firebase_uid: varchar (NULL)
  - auth_id: varchar (NULL)
  - auth_provider: varchar (NULL) DEFAULT 'supabase'::character varying
  - name: varchar (NULL)
  - email: varchar (NULL)
  - is_active: bool (NULL) DEFAULT true
KEYS:
  - UNIQUE: users_phone_key (phone)
  - PRIMARY KEY: users_pkey (id)

================ TABLE: customer_profiles ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - user_id: uuid (NOT NULL)
  - full_name: varchar (NULL)
  - date_of_birth: date (NULL)
  - gender: varchar (NULL)
  - profile_photo_url: text (NULL)
  - profile_photo_path: text (NULL)
  - address_line1: varchar (NULL)
  - address_line2: varchar (NULL)
  - state_id: uuid (NULL)
  - city_id: uuid (NULL)
  - area_id: uuid (NULL)
  - postal_code: varchar (NULL)
  - emergency_contact_name: varchar (NULL)
  - emergency_contact_phone: varchar (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
  - occupation_type: varchar (NULL)
KEYS:
  - PRIMARY KEY: customer_profiles_pkey (id)
  - UNIQUE: customer_profiles_user_id_key (user_id)
FOREIGN KEYS:
  - area_id -> areas(id) onDel=RESTRICT
  - city_id -> cities(id) onDel=RESTRICT
  - state_id -> states(id) onDel=RESTRICT
  - user_id -> users(id) onDel=RESTRICT

================ TABLE: customer_documents ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - customer_id: uuid (NOT NULL)
  - document_type: varchar (NOT NULL)
  - document_number: varchar (NULL)
  - file_url: text (NOT NULL)
  - storage_path: text (NOT NULL)
  - file_name: varchar (NULL)
  - file_type: varchar (NULL)
  - file_size_bytes: int8 (NULL)
  - verification_status: varchar (NOT NULL) DEFAULT 'pending'::character varying
  - rejection_reason: text (NULL)
  - uploaded_at: timestamptz (NOT NULL) DEFAULT now()
  - verified_at: timestamptz (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: customer_documents_pkey (id)
FOREIGN KEYS:
  - customer_id -> users(id) onDel=RESTRICT

================ TABLE: customer_identity_verifications ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - customer_id: uuid (NOT NULL)
  - document_type: varchar (NOT NULL)
  - verification_provider: varchar (NOT NULL)
  - verification_method: varchar (NOT NULL) DEFAULT 'online'::character varying
  - verification_status: varchar (NOT NULL) DEFAULT 'pending'::character varying
  - provider_reference: varchar (NULL)
  - verified_name: varchar (NULL)
  - verified_date_of_birth: date (NULL)
  - verified_gender: varchar (NULL)
  - verified_address: text (NULL)
  - verified_state: varchar (NULL)
  - verified_city: varchar (NULL)
  - verified_postal_code: varchar (NULL)
  - document_reference: varchar (NULL)
  - verification_response: jsonb (NULL)
  - verification_metadata: jsonb (NULL)
  - submitted_at: timestamptz (NULL)
  - verified_at: timestamptz (NULL)
  - failed_at: timestamptz (NULL)
  - failure_reason: text (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
  - aadhaar_registered_mobile: varchar (NULL)
KEYS:
  - PRIMARY KEY: customer_identity_verifications_pkey (id)
FOREIGN KEYS:
  - customer_id -> users(id) onDel=RESTRICT

================ TABLE: customer_saved_addresses ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - customer_id: uuid (NOT NULL)
  - address_label: varchar (NULL)
  - address_line1: varchar (NOT NULL)
  - address_line2: varchar (NULL)
  - state_id: uuid (NULL)
  - city_id: uuid (NULL)
  - area_id: uuid (NULL)
  - postal_code: varchar (NULL)
  - latitude: numeric (NULL)
  - longitude: numeric (NULL)
  - is_default: bool (NOT NULL) DEFAULT false
  - is_active: bool (NOT NULL) DEFAULT true
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: customer_saved_addresses_pkey (id)
FOREIGN KEYS:
  - area_id -> areas(id) onDel=RESTRICT
  - city_id -> cities(id) onDel=RESTRICT
  - customer_id -> users(id) onDel=RESTRICT
  - state_id -> states(id) onDel=RESTRICT

================ TABLE: vehicles ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - partner_id: uuid (NOT NULL)
  - shop_id: uuid (NOT NULL)
  - model_id: uuid (NOT NULL)
  - registration_number: varchar (NOT NULL)
  - chassis_number: varchar (NULL)
  - engine_number: varchar (NULL)
  - color: varchar (NULL)
  - status: varchar (NOT NULL) DEFAULT 'pending'::character varying
  - verification_status: varchar (NOT NULL) DEFAULT 'pending'::character varying
  - is_active: bool (NOT NULL) DEFAULT true
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
  - is_available: bool (NOT NULL) DEFAULT true
  - vehicle_description: text (NULL)
  - manufacture_year: int2 (NULL)
  - engine_capacity: int4 (NULL)
  - current_odometer: int4 (NULL)
  - helmet_included: bool (NOT NULL) DEFAULT false
KEYS:
  - UNIQUE: vehicles_id_shop_id_key (id)
  - UNIQUE: vehicles_id_shop_id_key (shop_id)
  - PRIMARY KEY: vehicles_pkey (id)
  - UNIQUE: vehicles_registration_number_key (registration_number)
FOREIGN KEYS:
  - model_id -> vehicle_models(id) onDel=RESTRICT
  - partner_id -> shops(id) onDel=RESTRICT
  - partner_id -> shops(partner_id) onDel=RESTRICT
  - partner_id -> partners(id) onDel=RESTRICT
  - shop_id -> shops(partner_id) onDel=RESTRICT
  - shop_id -> shops(id) onDel=RESTRICT
  - shop_id -> shops(id) onDel=RESTRICT

================ TABLE: vehicle_categories ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - name: varchar (NOT NULL)
  - code: varchar (NOT NULL)
  - description: text (NULL)
  - is_active: bool (NOT NULL) DEFAULT true
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: vehicle_categories_code_key (code)
  - UNIQUE: vehicle_categories_name_key (name)
  - PRIMARY KEY: vehicle_categories_pkey (id)

================ TABLE: vehicle_brands ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - name: varchar (NOT NULL)
  - code: varchar (NOT NULL)
  - logo_url: text (NULL)
  - is_active: bool (NOT NULL) DEFAULT true
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: vehicle_brands_code_key (code)
  - UNIQUE: vehicle_brands_name_key (name)
  - PRIMARY KEY: vehicle_brands_pkey (id)

================ TABLE: vehicle_models ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - brand_id: uuid (NOT NULL)
  - category_id: uuid (NOT NULL)
  - name: varchar (NOT NULL)
  - code: varchar (NOT NULL)
  - description: text (NULL)
  - is_active: bool (NOT NULL) DEFAULT true
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: vehicle_models_brand_category_code_key (brand_id)
  - UNIQUE: vehicle_models_brand_category_code_key (category_id)
  - UNIQUE: vehicle_models_brand_category_code_key (code)
  - UNIQUE: vehicle_models_brand_category_name_key (brand_id)
  - UNIQUE: vehicle_models_brand_category_name_key (category_id)
  - UNIQUE: vehicle_models_brand_category_name_key (name)
  - PRIMARY KEY: vehicle_models_pkey (id)
FOREIGN KEYS:
  - brand_id -> vehicle_brands(id) onDel=RESTRICT
  - category_id -> vehicle_categories(id) onDel=RESTRICT

================ TABLE: vehicle_pricing ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - vehicle_id: uuid (NOT NULL)
  - pricing_type: varchar (NOT NULL)
  - price: numeric (NOT NULL)
  - min_duration: int4 (NOT NULL) DEFAULT 1
  - max_duration: int4 (NULL)
  - security_deposit: numeric (NOT NULL) DEFAULT 0
  - is_active: bool (NOT NULL) DEFAULT true
  - effective_from: timestamptz (NOT NULL) DEFAULT now()
  - effective_until: timestamptz (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: vehicle_pricing_pkey (id)
FOREIGN KEYS:
  - vehicle_id -> vehicles(id) onDel=RESTRICT

================ TABLE: vehicle_pricing_rules ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - vehicle_pricing_id: uuid (NOT NULL)
  - rule_type: varchar (NOT NULL)
  - adjustment_type: varchar (NOT NULL)
  - adjustment_value: numeric (NOT NULL)
  - min_duration: int4 (NULL)
  - max_duration: int4 (NULL)
  - start_at: timestamptz (NULL)
  - end_at: timestamptz (NULL)
  - is_active: bool (NOT NULL) DEFAULT true
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: vehicle_pricing_rules_pkey (id)
FOREIGN KEYS:
  - vehicle_pricing_id -> vehicle_pricing(id) onDel=RESTRICT

================ TABLE: vehicle_availability ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - vehicle_id: uuid (NOT NULL)
  - start_at: timestamptz (NOT NULL)
  - end_at: timestamptz (NOT NULL)
  - availability_type: varchar (NOT NULL) DEFAULT 'available'::character varying
  - reason: text (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: vehicle_availability_pkey (id)
FOREIGN KEYS:
  - vehicle_id -> vehicles(id) onDel=RESTRICT

================ TABLE: vehicle_images ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - vehicle_id: uuid (NOT NULL)
  - file_url: text (NOT NULL)
  - storage_path: text (NOT NULL)
  - image_type: varchar (NOT NULL) DEFAULT 'gallery'::character varying
  - display_order: int4 (NOT NULL) DEFAULT 0
  - is_primary: bool (NOT NULL) DEFAULT false
  - is_active: bool (NOT NULL) DEFAULT true
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: vehicle_images_pkey (id)
FOREIGN KEYS:
  - vehicle_id -> vehicles(id) onDel=RESTRICT

================ TABLE: shops ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - partner_id: uuid (NOT NULL)
  - name: varchar (NOT NULL)
  - description: text (NULL)
  - contact_phone: varchar (NULL)
  - contact_email: varchar (NULL)
  - address_line1: text (NOT NULL)
  - address_line2: text (NULL)
  - state_id: uuid (NOT NULL)
  - city_id: uuid (NOT NULL)
  - area_id: uuid (NULL)
  - postal_code: varchar (NULL)
  - latitude: numeric (NULL)
  - longitude: numeric (NULL)
  - status: varchar (NOT NULL) DEFAULT 'pending'::character varying
  - verification_status: varchar (NOT NULL) DEFAULT 'pending'::character varying
  - is_active: bool (NOT NULL) DEFAULT true
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
  - operating_info: text (NULL) DEFAULT '08:00 AM - 10:00 PM (All Days)'::text
KEYS:
  - UNIQUE: shops_id_partner_id_key (id)
  - UNIQUE: shops_id_partner_id_key (partner_id)
  - PRIMARY KEY: shops_pkey (id)
FOREIGN KEYS:
  - area_id -> areas(id) onDel=RESTRICT
  - city_id -> cities(id) onDel=RESTRICT
  - partner_id -> partners(id) onDel=RESTRICT
  - state_id -> states(id) onDel=RESTRICT

================ TABLE: partners ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - user_id: uuid (NOT NULL)
  - partner_code: varchar (NOT NULL)
  - business_name: varchar (NULL)
  - business_type: varchar (NULL)
  - description: text (NULL)
  - contact_phone: varchar (NULL)
  - contact_email: varchar (NULL)
  - status: varchar (NOT NULL) DEFAULT 'pending'::character varying
  - kyc_status: varchar (NOT NULL) DEFAULT 'pending'::character varying
  - verification_status: varchar (NOT NULL) DEFAULT 'pending'::character varying
  - commission_rate: numeric (NULL)
  - onboarding_completed: bool (NOT NULL) DEFAULT false
  - verified_at: timestamptz (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
  - deleted_at: timestamptz (NULL)
  - profile_image_url: text (NULL)
  - rating: numeric (NULL) DEFAULT 5.0
  - review_count: int4 (NULL) DEFAULT 0
  - registered_since: varchar (NULL)
  - is_active: bool (NULL) DEFAULT true
KEYS:
  - UNIQUE: partners_partner_code_key (partner_code)
  - PRIMARY KEY: partners_pkey (id)
  - UNIQUE: partners_user_id_key (user_id)
FOREIGN KEYS:
  - user_id -> users(id) onDel=RESTRICT

================ TABLE: bookings ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - booking_number: varchar (NOT NULL)
  - customer_id: uuid (NOT NULL)
  - partner_id: uuid (NOT NULL)
  - vehicle_id: uuid (NOT NULL)
  - shop_id: uuid (NOT NULL)
  - start_at: timestamptz (NOT NULL)
  - end_at: timestamptz (NOT NULL)
  - status: varchar (NOT NULL) DEFAULT 'initiated'::character varying
  - subtotal: numeric (NOT NULL) DEFAULT 0
  - discount_amount: numeric (NOT NULL) DEFAULT 0
  - extra_charges: numeric (NOT NULL) DEFAULT 0
  - tax_amount: numeric (NOT NULL) DEFAULT 0
  - platform_fee: numeric (NOT NULL) DEFAULT 0
  - total_amount: numeric (NOT NULL) DEFAULT 0
  - currency: varchar (NOT NULL) DEFAULT 'INR'::character varying
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: bookings_booking_number_key (booking_number)
  - UNIQUE: bookings_id_customer_id_key (id)
  - UNIQUE: bookings_id_customer_id_key (customer_id)
  - UNIQUE: bookings_id_partner_id_key (id)
  - UNIQUE: bookings_id_partner_id_key (partner_id)
  - PRIMARY KEY: bookings_pkey (id)
FOREIGN KEYS:
  - customer_id -> users(id) onDel=RESTRICT
  - partner_id -> partners(id) onDel=RESTRICT
  - partner_id -> shops(id) onDel=RESTRICT
  - partner_id -> shops(partner_id) onDel=RESTRICT
  - shop_id -> shops(id) onDel=RESTRICT
  - shop_id -> vehicles(shop_id) onDel=RESTRICT
  - shop_id -> shops(partner_id) onDel=RESTRICT
  - shop_id -> shops(id) onDel=RESTRICT
  - shop_id -> vehicles(id) onDel=RESTRICT
  - vehicle_id -> vehicles(id) onDel=RESTRICT
  - vehicle_id -> vehicles(shop_id) onDel=RESTRICT
  - vehicle_id -> vehicles(id) onDel=RESTRICT

================ TABLE: booking_items ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - booking_id: uuid (NOT NULL)
  - item_type: varchar (NOT NULL)
  - description: varchar (NOT NULL)
  - quantity: numeric (NOT NULL) DEFAULT 1
  - unit_price: numeric (NOT NULL) DEFAULT 0
  - amount: numeric (NOT NULL) DEFAULT 0
  - created_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: booking_items_pkey (id)
FOREIGN KEYS:
  - booking_id -> bookings(id) onDel=RESTRICT

================ TABLE: booking_price_breakdown ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - booking_id: uuid (NOT NULL)
  - base_amount: numeric (NOT NULL) DEFAULT 0
  - extra_charges: numeric (NOT NULL) DEFAULT 0
  - discount_amount: numeric (NOT NULL) DEFAULT 0
  - taxable_amount: numeric (NOT NULL) DEFAULT 0
  - tax_amount: numeric (NOT NULL) DEFAULT 0
  - platform_fee: numeric (NOT NULL) DEFAULT 0
  - security_deposit: numeric (NOT NULL) DEFAULT 0
  - total_amount: numeric (NOT NULL) DEFAULT 0
  - currency: varchar (NOT NULL) DEFAULT 'INR'::character varying
  - created_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: booking_price_breakdown_booking_key (booking_id)
  - PRIMARY KEY: booking_price_breakdown_pkey (id)
FOREIGN KEYS:
  - booking_id -> bookings(id) onDel=RESTRICT

================ TABLE: booking_customer_details ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - booking_id: uuid (NOT NULL)
  - full_name: varchar (NOT NULL)
  - phone: varchar (NOT NULL)
  - alternate_phone: varchar (NULL)
  - id_type: varchar (NULL)
  - id_reference: varchar (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: booking_customer_details_booking_key (booking_id)
  - PRIMARY KEY: booking_customer_details_pkey (id)
FOREIGN KEYS:
  - booking_id -> bookings(id) onDel=RESTRICT

================ TABLE: booking_status_history ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - booking_id: uuid (NOT NULL)
  - old_status: varchar (NULL)
  - new_status: varchar (NOT NULL)
  - changed_by: uuid (NULL)
  - change_reason: text (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: booking_status_history_pkey (id)
FOREIGN KEYS:
  - booking_id -> bookings(id) onDel=RESTRICT
  - changed_by -> users(id) onDel=SET NULL

================ TABLE: booking_cancellations ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - booking_id: uuid (NOT NULL)
  - cancelled_by: uuid (NOT NULL)
  - cancellation_reason: varchar (NULL)
  - cancelled_at: timestamptz (NOT NULL) DEFAULT now()
  - policy_id: uuid (NULL)
  - hours_before_start: numeric (NULL)
  - refund_percentage: numeric (NOT NULL) DEFAULT 0
  - eligible_refund_amount: numeric (NOT NULL) DEFAULT 0
  - refund_status: varchar (NOT NULL) DEFAULT 'not_applicable'::character varying
  - created_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: booking_cancellations_booking_key (booking_id)
  - PRIMARY KEY: booking_cancellations_pkey (id)
FOREIGN KEYS:
  - booking_id -> bookings(id) onDel=RESTRICT
  - cancelled_by -> users(id) onDel=RESTRICT
  - policy_id -> cancellation_policies(id) onDel=RESTRICT

================ TABLE: cancellation_policies ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - name: varchar (NOT NULL)
  - min_hours_before: numeric (NOT NULL)
  - max_hours_before: numeric (NULL)
  - refund_percentage: numeric (NOT NULL)
  - applies_to: varchar (NOT NULL) DEFAULT 'customer'::character varying
  - is_active: bool (NOT NULL) DEFAULT true
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: cancellation_policies_pkey (id)

================ TABLE: payments ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - booking_id: uuid (NOT NULL)
  - customer_id: uuid (NOT NULL)
  - partner_id: uuid (NOT NULL)
  - payment_number: varchar (NOT NULL)
  - amount: numeric (NOT NULL)
  - currency: varchar (NOT NULL) DEFAULT 'INR'::character varying
  - payment_method: varchar (NULL)
  - status: varchar (NOT NULL) DEFAULT 'initiated'::character varying
  - paid_at: timestamptz (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: payments_booking_id_key (booking_id)
  - UNIQUE: payments_payment_number_key (payment_number)
  - PRIMARY KEY: payments_pkey (id)
FOREIGN KEYS:
  - booking_id -> bookings(id) onDel=RESTRICT
  - booking_id -> bookings(id) onDel=RESTRICT
  - booking_id -> bookings(partner_id) onDel=RESTRICT
  - booking_id -> bookings(customer_id) onDel=RESTRICT
  - booking_id -> bookings(id) onDel=RESTRICT
  - customer_id -> bookings(id) onDel=RESTRICT
  - customer_id -> users(id) onDel=RESTRICT
  - customer_id -> bookings(customer_id) onDel=RESTRICT
  - partner_id -> partners(id) onDel=RESTRICT
  - partner_id -> bookings(id) onDel=RESTRICT
  - partner_id -> bookings(partner_id) onDel=RESTRICT

================ TABLE: payment_attempts ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - payment_id: uuid (NOT NULL)
  - attempt_number: int4 (NOT NULL)
  - gateway: varchar (NOT NULL) DEFAULT 'razorpay'::character varying
  - gateway_order_id: varchar (NULL)
  - gateway_payment_id: varchar (NULL)
  - amount: numeric (NOT NULL)
  - currency: varchar (NOT NULL) DEFAULT 'INR'::character varying
  - status: varchar (NOT NULL) DEFAULT 'initiated'::character varying
  - failure_code: varchar (NULL)
  - failure_reason: text (NULL)
  - initiated_at: timestamptz (NOT NULL) DEFAULT now()
  - completed_at: timestamptz (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: payment_attempts_payment_attempt_key (payment_id)
  - UNIQUE: payment_attempts_payment_attempt_key (attempt_number)
  - PRIMARY KEY: payment_attempts_pkey (id)
FOREIGN KEYS:
  - payment_id -> payments(id) onDel=RESTRICT

================ TABLE: payment_transactions ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - payment_id: uuid (NOT NULL)
  - payment_attempt_id: uuid (NULL)
  - transaction_type: varchar (NOT NULL)
  - gateway: varchar (NOT NULL)
  - gateway_transaction_id: varchar (NULL)
  - amount: numeric (NOT NULL)
  - currency: varchar (NOT NULL) DEFAULT 'INR'::character varying
  - status: varchar (NOT NULL) DEFAULT 'pending'::character varying
  - transaction_at: timestamptz (NOT NULL) DEFAULT now()
  - created_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: payment_transactions_pkey (id)
FOREIGN KEYS:
  - payment_attempt_id -> payment_attempts(id) onDel=RESTRICT
  - payment_id -> payments(id) onDel=RESTRICT

================ TABLE: refunds ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - payment_id: uuid (NOT NULL)
  - booking_id: uuid (NOT NULL)
  - cancellation_id: uuid (NULL)
  - refund_number: varchar (NOT NULL)
  - requested_amount: numeric (NOT NULL)
  - approved_amount: numeric (NOT NULL) DEFAULT 0
  - refunded_amount: numeric (NOT NULL) DEFAULT 0
  - currency: varchar (NOT NULL) DEFAULT 'INR'::character varying
  - reason: varchar (NULL)
  - status: varchar (NOT NULL) DEFAULT 'requested'::character varying
  - requested_at: timestamptz (NOT NULL) DEFAULT now()
  - approved_at: timestamptz (NULL)
  - completed_at: timestamptz (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: refunds_pkey (id)
  - UNIQUE: refunds_refund_number_key (refund_number)
FOREIGN KEYS:
  - booking_id -> bookings(id) onDel=RESTRICT
  - cancellation_id -> booking_cancellations(id) onDel=RESTRICT
  - payment_id -> payments(id) onDel=RESTRICT

================ TABLE: reviews ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - booking_id: uuid (NOT NULL)
  - customer_id: uuid (NOT NULL)
  - partner_id: uuid (NOT NULL)
  - vehicle_id: uuid (NOT NULL)
  - rating: int4 (NOT NULL)
  - review_text: text (NULL)
  - status: varchar (NOT NULL) DEFAULT 'published'::character varying
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: reviews_booking_unique (booking_id)
  - PRIMARY KEY: reviews_pkey (id)
FOREIGN KEYS:
  - booking_id -> bookings(id) onDel=RESTRICT
  - customer_id -> users(id) onDel=RESTRICT
  - partner_id -> partners(id) onDel=RESTRICT
  - vehicle_id -> vehicles(id) onDel=RESTRICT

================ TABLE: coupons ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - code: varchar (NOT NULL)
  - name: varchar (NOT NULL)
  - description: text (NULL)
  - discount_type: varchar (NOT NULL)
  - discount_value: numeric (NOT NULL)
  - max_discount_amount: numeric (NULL)
  - min_booking_amount: numeric (NOT NULL) DEFAULT 0
  - usage_limit: int4 (NULL)
  - usage_limit_per_customer: int4 (NULL)
  - used_count: int4 (NOT NULL) DEFAULT 0
  - valid_from: timestamptz (NOT NULL)
  - valid_until: timestamptz (NOT NULL)
  - is_active: bool (NOT NULL) DEFAULT true
  - created_by: uuid (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: coupons_code_key (code)
  - PRIMARY KEY: coupons_pkey (id)
FOREIGN KEYS:
  - created_by -> users(id) onDel=SET NULL

================ TABLE: coupon_redemptions ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - coupon_id: uuid (NOT NULL)
  - customer_id: uuid (NOT NULL)
  - booking_id: uuid (NOT NULL)
  - discount_amount: numeric (NOT NULL)
  - redeemed_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - UNIQUE: coupon_redemptions_booking_unique (booking_id)
  - PRIMARY KEY: coupon_redemptions_pkey (id)
FOREIGN KEYS:
  - booking_id -> bookings(id) onDel=RESTRICT
  - coupon_id -> coupons(id) onDel=RESTRICT
  - customer_id -> users(id) onDel=RESTRICT

================ TABLE: notifications ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - user_id: uuid (NOT NULL)
  - notification_type: varchar (NOT NULL)
  - title: varchar (NOT NULL)
  - message: text (NOT NULL)
  - reference_type: varchar (NULL)
  - reference_id: uuid (NULL)
  - is_read: bool (NOT NULL) DEFAULT false
  - read_at: timestamptz (NULL)
  - data: jsonb (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: notifications_pkey (id)
FOREIGN KEYS:
  - user_id -> users(id) onDel=RESTRICT

================ TABLE: support_tickets ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - ticket_number: varchar (NOT NULL)
  - user_id: uuid (NOT NULL)
  - booking_id: uuid (NULL)
  - partner_id: uuid (NULL)
  - subject: varchar (NOT NULL)
  - description: text (NOT NULL)
  - category: varchar (NOT NULL)
  - priority: varchar (NOT NULL) DEFAULT 'medium'::character varying
  - status: varchar (NOT NULL) DEFAULT 'open'::character varying
  - assigned_to: uuid (NULL)
  - resolved_at: timestamptz (NULL)
  - closed_at: timestamptz (NULL)
  - created_at: timestamptz (NOT NULL) DEFAULT now()
  - updated_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: support_tickets_pkey (id)
  - UNIQUE: support_tickets_ticket_number_key (ticket_number)
FOREIGN KEYS:
  - assigned_to -> users(id) onDel=SET NULL
  - booking_id -> bookings(id) onDel=RESTRICT
  - partner_id -> partners(id) onDel=RESTRICT
  - user_id -> users(id) onDel=RESTRICT

================ TABLE: support_messages ================
COLUMNS:
  - id: uuid (NOT NULL) DEFAULT gen_random_uuid()
  - ticket_id: uuid (NOT NULL)
  - sender_id: uuid (NOT NULL)
  - message: text (NOT NULL)
  - is_internal: bool (NOT NULL) DEFAULT false
  - created_at: timestamptz (NOT NULL) DEFAULT now()
KEYS:
  - PRIMARY KEY: support_messages_pkey (id)
FOREIGN KEYS:
  - sender_id -> users(id) onDel=RESTRICT
  - ticket_id -> support_tickets(id) onDel=RESTRICT
