'use strict';

/**
 * Dev Resolvers for Offline / Development Mode
 * Seamlessly registers mock resolvers for all repositories when PostgreSQL is unavailable.
 */

const AdminPartnerRepository = require('../repositories/admin-partner.repository');
const AdminCustomerRepository = require('../repositories/admin-customer.repository');
const AdminVehicleRepository = require('../repositories/admin-vehicle.repository');
const AdminBookingRepository = require('../repositories/admin-booking.repository');
const AdminVerificationRepository = require('../repositories/admin-verification.repository');
const AdminShopRepository = require('../repositories/admin-shop.repository');
const { setMockPaymentResolver } = require('../repositories/admin-payment.repository');
const { setMockWalletResolver } = require('../repositories/admin-wallet.repository');
const AdminDamageDisputeRepository = require('../repositories/admin-damage-dispute.repository');
const AdminSupportRepository = require('../repositories/admin-support.repository');
const AdminActionRepository = require('../repositories/admin-action.repository');
const logger = require('../config/logger');

// In-memory data store
let partnersStore = [
  {
    id: 'prt-901',
    user_id: 'usr-p01',
    business_name: 'Speedy Wheels Mobility',
    business_type: 'Fleet Operator',
    business_address: '100 Feet Road, Indiranagar, Bengaluru, Karnataka 560038',
    city: 'Bengaluru',
    latitude: 12.9716,
    longitude: 77.5946,
    operating_info: { workingHours: '06:00 - 23:00', pickupAvailable: true },
    partner_status: 'ONLINE',
    kyc_status: 'VERIFIED',
    profile_image_url: 'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?w=400',
    rating: 4.8,
    review_count: 320,
    registered_since: '2026-01-15T11:00:00Z',
    is_active: true,
    created_at: '2026-01-15T11:00:00Z',
    updated_at: '2026-09-20T10:00:00Z',
    user_name: 'Vikram Malhotra',
    user_email: 'vikram@speedywheels.in',
    user_phone: '+91 98220 11223',
    user_country_code: '+91',
    vehicle_count: 24,
    booking_count: 1420,
  },
  {
    id: 'prt-902',
    user_id: 'usr-p02',
    business_name: 'Apex Bike Rentals',
    business_type: 'Individual Owner',
    business_address: 'Hitech City Main Rd, Madhapur, Hyderabad, Telangana 500081',
    city: 'Hyderabad',
    latitude: 17.4485,
    longitude: 78.3756,
    operating_info: { workingHours: '07:00 - 22:00', pickupAvailable: true },
    partner_status: 'ONLINE',
    kyc_status: 'UNDER_REVIEW',
    profile_image_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400',
    rating: 4.5,
    review_count: 88,
    registered_since: '2026-08-10T14:30:00Z',
    is_active: true,
    created_at: '2026-08-10T14:30:00Z',
    updated_at: '2026-09-18T09:15:00Z',
    user_name: 'Rajesh Naidu',
    user_email: 'rajesh@apexrentals.in',
    user_phone: '+91 97110 33445',
    user_country_code: '+91',
    vehicle_count: 8,
    booking_count: 210,
  },
  {
    id: 'prt-903',
    user_id: 'usr-p03',
    business_name: 'Royal Scooty Hub',
    business_type: 'Fleet Operator',
    business_address: 'Calangute - Baga Road, Goa 403516',
    city: 'Goa',
    latitude: 15.5439,
    longitude: 73.7553,
    operating_info: { workingHours: '08:00 - 21:00', pickupAvailable: true },
    partner_status: 'OFFLINE',
    kyc_status: 'SUSPENDED',
    profile_image_url: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400',
    rating: 3.9,
    review_count: 140,
    registered_since: '2026-02-22T08:15:00Z',
    is_active: false,
    created_at: '2026-02-22T08:15:00Z',
    updated_at: '2026-09-25T14:00:00Z',
    user_name: 'Anthony D\'Souza',
    user_email: 'anthony@royalscooty.com',
    user_phone: '+91 99001 55667',
    user_country_code: '+91',
    vehicle_count: 18,
    booking_count: 640,
  },
];

let customersStore = [
  {
    id: 'cust-001',
    name: 'Aarav Mehta',
    email: 'aarav.mehta@example.com',
    phone: '+91 98450 12345',
    country_code: '+91',
    avatar_storage_key: null,
    is_active: true,
    created_at: '2026-01-10T09:00:00Z',
    updated_at: '2026-09-22T14:15:00Z',
    total_bookings: 14,
    active_bookings: 1,
    total_spent: 42500,
  },
  {
    id: 'cust-002',
    name: 'Pooja Hegde',
    email: 'pooja.h@example.com',
    phone: '+91 99880 54321',
    country_code: '+91',
    avatar_storage_key: null,
    is_active: true,
    created_at: '2026-02-05T12:30:00Z',
    updated_at: '2026-09-20T11:45:00Z',
    total_bookings: 6,
    active_bookings: 0,
    total_spent: 18900,
  },
  {
    id: 'cust-003',
    name: 'Karan Johar Sharma',
    email: 'karan.sharma@example.com',
    phone: '+91 97766 88990',
    country_code: '+91',
    avatar_storage_key: null,
    is_active: false,
    created_at: '2026-03-12T16:20:00Z',
    updated_at: '2026-09-15T08:10:00Z',
    total_bookings: 2,
    active_bookings: 0,
    total_spent: 4500,
  },
];

let vehiclesStore = [
  {
    id: 'veh-101',
    partner_id: 'prt-901',
    partner_name: 'Speedy Wheels Mobility',
    partner_city: 'Bengaluru',
    brand: 'Royal Enfield',
    model: 'Classic 350',
    variant: 'Halcyon Green',
    year: 2024,
    registration_number: 'KA-01-EQ-9921',
    category: 'Bikes',
    fuel_type: 'PETROL',
    transmission: 'MANUAL',
    seats: 2,
    description: 'Iconic cruiser motorcycle with smooth thumping engine and comfortable upright posture.',
    manual_status: 'ONLINE',
    rental_status: 'AVAILABLE',
    verification_status: 'VERIFIED',
    is_archived: false,
    offline_reason: null,
    cover_image_url: 'https://images.unsplash.com/photo-1558981403-c5f9899a28bc?w=500',
    price_per_day: 1200,
    price_per_hour: 150,
    booking_count: 48,
    shop_id: 'shp-101',
    shop_name: 'Speedy Wheels Indiranagar Hub',
    color: 'Halcyon Green',
    engine_capacity: '349 cc',
    current_odometer: 4250,
    helmet_included: true,
    created_at: '2026-02-01T10:00:00Z',
    updated_at: '2026-09-28T16:00:00Z',
  },
  {
    id: 'veh-102',
    partner_id: 'prt-901',
    partner_name: 'Speedy Wheels Mobility',
    partner_city: 'Bengaluru',
    brand: 'Hyundai',
    model: 'Creta SX (O)',
    variant: 'Turbo Petrol',
    year: 2025,
    registration_number: 'KA-03-MR-4412',
    category: 'Cars',
    fuel_type: 'PETROL',
    transmission: 'AUTOMATIC',
    seats: 5,
    description: 'Feature-rich compact SUV equipped with panoramic sunroof, ventilated seats and ADAS.',
    manual_status: 'ONLINE',
    rental_status: 'BOOKED',
    verification_status: 'VERIFIED',
    is_archived: false,
    offline_reason: null,
    cover_image_url: 'https://images.unsplash.com/photo-1549399542-7e3f8b79c341?w=500',
    price_per_day: 3500,
    price_per_hour: 400,
    booking_count: 62,
    shop_id: 'shp-101',
    shop_name: 'Speedy Wheels Indiranagar Hub',
    color: 'Polar White',
    engine_capacity: '1482 cc',
    current_odometer: 11400,
    helmet_included: false,
    created_at: '2026-02-10T12:00:00Z',
    updated_at: '2026-09-28T17:30:00Z',
  },
  {
    id: 'veh-103',
    partner_id: 'prt-902',
    partner_name: 'Apex Bike Rentals',
    partner_city: 'Hyderabad',
    brand: 'Ather',
    model: '450X Gen 3',
    variant: 'Space Grey',
    year: 2024,
    registration_number: 'TS-09-EA-1002',
    category: 'EVs',
    fuel_type: 'ELECTRIC',
    transmission: 'AUTOMATIC',
    seats: 2,
    description: 'Ultra-fast electric scooter featuring Google Maps on dashboard with Warp mode acceleration.',
    manual_status: 'ONLINE',
    rental_status: 'AVAILABLE',
    verification_status: 'PENDING',
    is_archived: false,
    offline_reason: null,
    cover_image_url: 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?w=500',
    price_per_day: 800,
    price_per_hour: 100,
    booking_count: 14,
    shop_id: 'shp-102',
    shop_name: 'Speedy Wheels Koramangala Hub',
    color: 'Space Grey',
    engine_capacity: '3.7 kWh Battery',
    current_odometer: 1520,
    helmet_included: true,
    created_at: '2026-08-15T09:00:00Z',
    updated_at: '2026-09-26T12:00:00Z',
  },
  {
    id: 'veh-104',
    partner_id: 'prt-903',
    partner_name: 'Royal Scooty Hub',
    partner_city: 'Goa',
    brand: 'Honda',
    model: 'Activa 6G',
    variant: 'Deluxe',
    year: 2023,
    registration_number: 'GA-03-F-8819',
    category: 'Scooties',
    fuel_type: 'PETROL',
    transmission: 'AUTOMATIC',
    seats: 2,
    description: 'Reliable and comfortable gearless scooter ideal for coastal cruising and daily errands.',
    manual_status: 'OFFLINE',
    rental_status: 'MAINTENANCE',
    verification_status: 'VERIFIED',
    is_archived: false,
    offline_reason: 'Scheduled 10,000km engine servicing and brake pad overhaul',
    cover_image_url: 'https://images.unsplash.com/photo-1558981359-219d6364c9c8?w=500',
    price_per_day: 550,
    price_per_hour: 70,
    booking_count: 110,
    shop_id: 'shp-102',
    shop_name: 'Speedy Wheels Koramangala Hub',
    color: 'Matte Blue',
    engine_capacity: '109.5 cc',
    current_odometer: 8900,
    helmet_included: true,
    created_at: '2026-03-01T11:00:00Z',
    updated_at: '2026-09-25T15:00:00Z',
  },
];

let bookingsStore = [
  {
    id: 'bkg-7001',
    booking_number: 'GONGO-26-0081',
    customer_id: 'cust-001',
    partner_id: 'prt-901',
    vehicle_id: 'veh-102',
    start_at: '2026-09-28T09:00:00Z',
    expected_return_at: '2026-09-30T18:00:00Z',
    actual_return_at: null,
    booking_status: 'ONGOING',
    payment_status: 'PAID',
    pickup_location: '100 Feet Road, Indiranagar Hub, Bengaluru',
    return_location: '100 Feet Road, Indiranagar Hub, Bengaluru',
    total_amount: 8500,
    security_deposit: 3000,
    commission_amount: 1275,
    partner_payout_amount: 7225,
    cancellation_reason: null,
    created_at: '2026-09-27T14:30:00Z',
    updated_at: '2026-09-28T09:10:00Z',
    customer_name: 'Aarav Mehta',
    customer_email: 'aarav.mehta@example.com',
    customer_phone: '+91 98450 12345',
    partner_name: 'Speedy Wheels Mobility',
    partner_city: 'Bengaluru',
    vehicle_registration_number: 'KA-03-MR-4412',
    vehicle_brand: 'Hyundai',
    vehicle_model: 'Creta SX (O)',
    vehicle_category: 'Cars',
  },
  {
    id: 'bkg-7002',
    booking_number: 'GONGO-26-0082',
    customer_id: 'cust-002',
    partner_id: 'prt-901',
    vehicle_id: 'veh-101',
    start_at: '2026-09-25T10:00:00Z',
    expected_return_at: '2026-09-27T10:00:00Z',
    actual_return_at: '2026-09-27T09:45:00Z',
    booking_status: 'COMPLETED',
    payment_status: 'PAID',
    pickup_location: 'Indiranagar Hub, Bengaluru',
    return_location: 'Indiranagar Hub, Bengaluru',
    total_amount: 2700,
    security_deposit: 1500,
    commission_amount: 405,
    partner_payout_amount: 2295,
    cancellation_reason: null,
    created_at: '2026-09-24T18:00:00Z',
    updated_at: '2026-09-27T09:50:00Z',
    customer_name: 'Pooja Hegde',
    customer_email: 'pooja.h@example.com',
    customer_phone: '+91 99880 54321',
    partner_name: 'Speedy Wheels Mobility',
    partner_city: 'Bengaluru',
    vehicle_registration_number: 'KA-01-EQ-9921',
    vehicle_brand: 'Royal Enfield',
    vehicle_model: 'Classic 350',
    vehicle_category: 'Bikes',
  },
];

let shopsStore = [
  {
    id: 'shp-101',
    partner_id: 'prt-901',
    shop_name: 'Speedy Wheels Indiranagar Hub',
    business_name: 'Speedy Wheels Mobility',
    address: '100 Feet Road, Indiranagar',
    city: 'Bengaluru',
    latitude: 12.9716,
    longitude: 77.5946,
    is_active: true,
    operating_hours: '06:00 - 23:00',
    phone: '+91 98220 11223',
    vehicle_count: 14,
    created_at: '2026-01-20T10:00:00Z',
  },
  {
    id: 'shp-102',
    partner_id: 'prt-901',
    shop_name: 'Speedy Wheels Koramangala Hub',
    business_name: 'Speedy Wheels Mobility',
    address: '80 Feet Road, 4th Block, Koramangala',
    city: 'Bengaluru',
    latitude: 12.9352,
    longitude: 77.6245,
    is_active: true,
    operating_hours: '07:00 - 22:00',
    phone: '+91 98220 11224',
    vehicle_count: 10,
    created_at: '2026-02-15T11:00:00Z',
  },
];

let documentsStore = [
  {
    id: 'doc-p01',
    entity_type: 'PARTNER',
    entity_id: 'prt-901',
    document_type: 'GST_CERTIFICATE',
    document_number: '29ABCDE1234F1Z5',
    file_url: 'https://example.com/docs/gst_29abcde.pdf',
    verification_status: 'VERIFIED',
    verified_at: '2026-01-16T10:00:00Z',
    rejection_reason: null,
    created_at: '2026-01-15T11:30:00Z',
  },
  {
    id: 'doc-p02',
    entity_type: 'PARTNER',
    entity_id: 'prt-902',
    document_type: 'PAN_CARD',
    document_number: 'ABCDE9876K',
    file_url: 'https://example.com/docs/pan_rajesh.pdf',
    verification_status: 'UNDER_REVIEW',
    verified_at: null,
    rejection_reason: null,
    created_at: '2026-08-10T15:00:00Z',
  },
  {
    id: 'doc-v01',
    entity_type: 'VEHICLE',
    entity_id: 'veh-103',
    document_type: 'RC_BOOK',
    document_number: 'TS09EA1002RC',
    file_url: 'https://example.com/docs/rc_ather.pdf',
    verification_status: 'PENDING',
    verified_at: null,
    rejection_reason: null,
    created_at: '2026-08-15T09:30:00Z',
  },
];

let platformFeeStore = [
  {
    id: '8e130156-9b3b-4f4d-b50b-f8a3c04ea675',
    charge_type: 'service_charge',
    calculation_type: 'fixed',
    value: 2.50,
    currency: 'INR',
    is_active: true,
    created_by: null,
    created_at: '2026-10-09T05:38:47.480Z',
    updated_at: '2026-10-09T05:38:47.480Z',
  },
  {
    id: 'b1699dea-b202-4402-a318-a969f9199561',
    charge_type: 'convenience_fee',
    calculation_type: 'fixed',
    value: 2.00,
    currency: 'INR',
    is_active: true,
    created_by: null,
    created_at: '2026-10-09T05:38:47.480Z',
    updated_at: '2026-10-09T05:38:47.480Z',
  },
  {
    id: 'f68a0d50-a3fd-463b-8d5f-54e6b1db126f',
    charge_type: 'gst',
    calculation_type: 'percentage',
    value: 18.00,
    currency: 'INR',
    is_active: true,
    created_by: null,
    created_at: '2026-10-09T05:38:47.480Z',
    updated_at: '2026-10-09T05:38:47.480Z',
  },
  {
    id: 'c1000001-0000-4000-a000-000000000001',
    charge_type: 'service_charge_car',
    calculation_type: 'fixed',
    value: 5.00,
    currency: 'INR',
    is_active: true,
    created_by: null,
    created_at: '2026-10-09T05:38:47.480Z',
    updated_at: '2026-10-09T05:38:47.480Z',
  },
  {
    id: 'c1000002-0000-4000-a000-000000000002',
    charge_type: 'convenience_fee_car',
    calculation_type: 'fixed',
    value: 3.00,
    currency: 'INR',
    is_active: true,
    created_by: null,
    created_at: '2026-10-09T05:38:47.480Z',
    updated_at: '2026-10-09T05:38:47.480Z',
  },
  {
    id: 'c1000003-0000-4000-a000-000000000003',
    charge_type: 'gst_car',
    calculation_type: 'percentage',
    value: 18.00,
    currency: 'INR',
    is_active: true,
    created_by: null,
    created_at: '2026-10-09T05:38:47.480Z',
    updated_at: '2026-10-09T05:38:47.480Z',
  },
];

let cancellationRulesStore = {
  bike: [
    { id: 'dev-crule-b1', tier: 1, notice_hours: 6, refund_percentage: 0, is_active: true },
    { id: 'dev-crule-b2', tier: 2, notice_hours: 12, refund_percentage: 50, is_active: true },
    { id: 'dev-crule-b3', tier: 3, notice_hours: 24, refund_percentage: 100, is_active: true },
  ],
  car: [
    { id: 'dev-crule-c1', tier: 1, notice_hours: 12, refund_percentage: 0, is_active: true },
    { id: 'dev-crule-c2', tier: 2, notice_hours: 24, refund_percentage: 50, is_active: true },
    { id: 'dev-crule-c3', tier: 3, notice_hours: 24, refund_percentage: 100, is_active: true },
  ],
};

const setMock = (repo, methodName, resolver) => {
  if (repo && typeof repo[methodName] === 'function') {
    repo[methodName](resolver);
  } else if (repo && repo.constructor && typeof repo.constructor[methodName] === 'function') {
    repo.constructor[methodName](resolver);
  }
};

function registerDevResolvers() {
  logger.info('[DevResolvers] Registering in-memory fallback resolvers for offline development.');

  // 1. Partner Resolver
  setMock(AdminPartnerRepository, 'setMockPartnerResolver', {
    listPartners: async ({ search, partnerStatus, kycStatus, isActive, city, limit = 10, offset = 0 }) => {
      let filtered = [...partnersStore];
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(p =>
          p.business_name.toLowerCase().includes(q) ||
          p.user_name.toLowerCase().includes(q) ||
          p.user_email.toLowerCase().includes(q)
        );
      }
      if (partnerStatus) filtered = filtered.filter(p => p.partner_status === partnerStatus);
      if (kycStatus) filtered = filtered.filter(p => p.kyc_status === kycStatus);
      if (typeof isActive === 'boolean') filtered = filtered.filter(p => p.is_active === isActive);
      if (city) filtered = filtered.filter(p => p.city.toLowerCase().includes(city.toLowerCase()));

      const total = filtered.length;
      const sliced = filtered.slice(offset, offset + limit);
      return { partners: sliced, total };
    },
    findPartnerById: async (partnerId) => {
      return partnersStore.find(p => p.id === partnerId) || null;
    },
    getPartnerSummaries: async (partnerId) => {
      return {
        totalBookings: 1420,
        completedBookings: 1380,
        totalGrossRevenue: 1540000,
        partnerEarnings: 1309000,
        gongoCommission: 231000,
        activeVehicles: 24,
        totalVehicles: 24,
      };
    },
    getActiveBookingCount: async (partnerId) => 0,
    findPartnerByIdForUpdate: async (partnerId) => {
      return partnersStore.find(p => p.id === partnerId) || null;
    },
    updatePartnerStatus: async (partnerId, { isActive, partnerStatus }) => {
      const p = partnersStore.find(item => item.id === partnerId);
      if (p) {
        if (typeof isActive === 'boolean') {
          p.is_active = isActive;
          p.isActive = isActive;
          p.status = isActive ? 'active' : 'suspended';
        }
        if (partnerStatus) {
          p.partner_status = partnerStatus;
          p.partnerStatus = partnerStatus;
        }
      }
      return p || null;
    },
    updateKycStatus: async (partnerId, kycStatus) => {
      const p = partnersStore.find(item => item.id === partnerId);
      if (p) p.kyc_status = kycStatus;
      return p || null;
    },
    getPartnerDocuments: async (partnerId) => {
      return documentsStore.filter(d => d.entity_id === partnerId);
    },
    getPartnerBankAccounts: async (partnerId) => [
      {
        id: 'bnk-01',
        partner_id: partnerId,
        account_number: 'XXXXXX4419',
        ifsc_code: 'HDFC0001234',
        beneficiary_name: 'Speedy Wheels Mobility LLP',
        is_verified: true,
        is_primary: true,
      }
    ],
    getPartnerShops: async (partnerId) => {
      return shopsStore.filter(s => s.partner_id === partnerId);
    },
    getPartnerVehicles: async (partnerId, { limit = 10, offset = 0 } = {}) => {
      const vehicles = vehiclesStore.filter(v => v.partner_id === partnerId);
      return { vehicles: vehicles.slice(offset, offset + limit), total: vehicles.length };
    },
    getPartnerBookings: async (partnerId, { limit = 10, offset = 0 } = {}) => {
      const bookings = bookingsStore.filter(b => b.partner_id === partnerId);
      return { bookings: bookings.slice(offset, offset + limit), total: bookings.length };
    },
  });

  // 2. Customer Resolver
  setMock(AdminCustomerRepository, 'setMockCustomerResolver', {
    listCustomers: async ({ search, isActive, limit = 10, offset = 0 }) => {
      let filtered = [...customersStore];
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(c =>
          c.name.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.phone.includes(q)
        );
      }
      if (typeof isActive === 'boolean') filtered = filtered.filter(c => c.is_active === isActive);

      const total = filtered.length;
      return { customers: filtered.slice(offset, offset + limit), total };
    },
    findCustomerById: async (customerId) => {
      return customersStore.find(c => c.id === customerId) || null;
    },
    getCustomerSummaries: async (customerId) => {
      return {
        totalBookings: 14,
        activeBookings: 1,
        completedBookings: 12,
        cancelledBookings: 1,
        totalSpent: 42500,
        averageBookingValue: 3035.71,
        lastBookingAt: '2026-09-28T09:00:00Z',
      };
    },
    getActiveBookingCount: async (customerId) => 1,
    findCustomerByIdForUpdate: async (customerId) => {
      return customersStore.find(c => c.id === customerId) || null;
    },
    updateCustomerStatus: async (customerId, isActive) => {
      const c = customersStore.find(item => item.id === customerId);
      if (c) c.is_active = isActive;
      return c || null;
    },
    getCustomerBookings: async (customerId, { limit = 10, offset = 0 } = {}) => {
      const bookings = bookingsStore.filter(b => b.customer_id === customerId);
      return { bookings: bookings.slice(offset, offset + limit), total: bookings.length };
    },
    getCustomerPayments: async (customerId) => ({
      payments: [
        {
          id: 'pay-001',
          booking_id: 'bkg-7001',
          amount: 8500,
          payment_method: 'UPI',
          status: 'SUCCESS',
          created_at: '2026-09-27T14:35:00Z',
        }
      ],
      total: 1,
    }),
    getCustomerDocuments: async (customerId) => [],
    getCustomerAddresses: async (customerId) => [],
    getCustomerActivity: async (customerId) => ({ activities: [], total: 0 }),
  });

  // 3. Vehicle Resolver
  setMock(AdminVehicleRepository, 'setMockVehicleResolver', {
    listVehicles: async ({ search, category, manualStatus, rentalStatus, verificationStatus, limit = 10, offset = 0 }) => {
      let filtered = [...vehiclesStore];
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(v =>
          v.registration_number.toLowerCase().includes(q) ||
          v.brand.toLowerCase().includes(q) ||
          v.model.toLowerCase().includes(q) ||
          v.partner_name.toLowerCase().includes(q)
        );
      }
      if (category) filtered = filtered.filter(v => v.category.toLowerCase() === category.toLowerCase());
      if (manualStatus) filtered = filtered.filter(v => v.manual_status === manualStatus);
      if (rentalStatus) filtered = filtered.filter(v => v.rental_status === rentalStatus);
      if (verificationStatus) filtered = filtered.filter(v => v.verification_status === verificationStatus);

      const total = filtered.length;
      const vehicles = filtered.slice(offset, offset + limit).map(v => ({
        id: v.id,
        partnerId: v.partner_id,
        partnerName: v.partner_name,
        partnerCity: v.partner_city,
        shopId: v.shop_id,
        shopName: v.shop_name,
        brand: v.brand,
        model: v.model,
        year: v.year,
        registrationNumber: v.registration_number,
        category: v.category,
        fuelType: v.fuel_type,
        transmission: v.transmission,
        seats: v.seats,
        description: v.description,
        color: v.color,
        engineCapacity: v.engine_capacity,
        currentOdometer: v.current_odometer,
        helmetIncluded: v.helmet_included,
        isAvailable: v.rental_status === 'AVAILABLE',
        manualStatus: v.manual_status,
        rentalStatus: v.rental_status,
        verificationStatus: v.verification_status,
        isArchived: v.is_archived,
        offlineReason: v.offline_reason,
        coverImageUrl: v.cover_image_url,
        pricePerDay: v.price_per_day,
        pricePerHour: v.price_per_hour,
        bookingCount: v.booking_count,
        rating: v.rating_avg !== undefined ? (v.rating_avg !== null ? Number(v.rating_avg) : null) : null,
        reviewCount: v.rating_count || 0,
        createdAt: v.created_at,
        updatedAt: v.updated_at,
      }));
      return { vehicles, total };
    },
    findVehicleById: async (vehicleId) => {
      const v = vehiclesStore.find(item => item.id === vehicleId);
      if (!v) return null;
      return {
        id: v.id,
        partnerId: v.partner_id,
        partnerName: v.partner_name,
        partnerCity: v.partner_city,
        shopId: v.shop_id,
        shopName: v.shop_name,
        brand: v.brand,
        model: v.model,
        variant: v.variant,
        year: v.year,
        registrationNumber: v.registration_number,
        category: v.category,
        fuelType: v.fuel_type,
        transmission: v.transmission,
        seats: v.seats,
        description: v.description,
        color: v.color,
        engineCapacity: v.engine_capacity,
        currentOdometer: v.current_odometer,
        helmetIncluded: v.helmet_included,
        isAvailable: v.rental_status === 'AVAILABLE',
        manualStatus: v.manual_status,
        rentalStatus: v.rental_status,
        verificationStatus: v.verification_status,
        isArchived: v.is_archived,
        offlineReason: v.offline_reason,
        coverImageUrl: v.cover_image_url,
        pricePerDay: v.price_per_day,
        pricePerHour: v.price_per_hour,
        pricePer4Hours: v.price_per_4_hours || 0,
        securityDeposit: v.security_deposit || 0,
        extraKmCharge: v.extra_km_charge || 0,
        bookingCount: v.booking_count,
        createdAt: v.created_at,
        updatedAt: v.updated_at,
      };
    },
    getVehicleSummaries: async (vehicleId) => ({
      totalBookings: 48,
      completedBookings: 46,
      cancelledBookings: 2,
      totalGrossRevenue: 184000,
      utilizationRate: 78.5,
    }),
    getActiveBookingCount: async (vehicleId) => 0,
    findVehicleByIdForUpdate: async (vehicleId) => {
      return vehiclesStore.find(v => v.id === vehicleId) || null;
    },
    updateVehicleStatus: async (vehicleId, updates) => {
      const v = vehiclesStore.find(item => item.id === vehicleId);
      if (v) {
        if (updates.manualStatus) v.manual_status = updates.manualStatus;
        if (updates.offlineReason !== undefined) v.offline_reason = updates.offlineReason;
        if (updates.isArchived !== undefined) v.is_archived = updates.isArchived;
      }
      return v || null;
    },
    updateVehicleVerification: async (vehicleId, verificationStatus) => {
      const v = vehiclesStore.find(item => item.id === vehicleId);
      if (v) v.verification_status = verificationStatus;
      return v || null;
    },
    getVehicleDocuments: async (vehicleId) => {
      return documentsStore.filter(d => d.entity_id === vehicleId);
    },
    getVehicleImages: async (vehicleId) => [],
    getVehicleBookings: async (vehicleId, { limit = 10, offset = 0 } = {}) => {
      const bookings = bookingsStore.filter(b => b.vehicle_id === vehicleId);
      return { bookings: bookings.slice(offset, offset + limit), total: bookings.length };
    },
    getVehicleAvailability: async (vehicleId) => ({ isAvailable: true, nextBookingStart: null }),
    getVehiclePricing: async (vehicleId) => ({ pricePerDay: 1200, pricePerHour: 150, securityDeposit: 1500 }),
    getVehicleEarnings: async (vehicleId) => ({ totalGrossRevenue: 184000, netPartnerEarnings: 156400, gongoFee: 27600 }),
    getVehicleHistory: async (vehicleId) => ({ history: [], total: 0 }),
  });

  // 4. Booking Resolver
  setMock(AdminBookingRepository, 'setMockBookingResolver', {
    listBookings: async ({ search, bookingStatus, paymentStatus, limit = 10, offset = 0 }) => {
      let filtered = [...bookingsStore];
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(b =>
          b.booking_number.toLowerCase().includes(q) ||
          b.customer_name.toLowerCase().includes(q) ||
          b.vehicle_registration_number.toLowerCase().includes(q)
        );
      }
      if (bookingStatus) filtered = filtered.filter(b => b.booking_status === bookingStatus);
      if (paymentStatus) filtered = filtered.filter(b => b.payment_status === paymentStatus);

      const total = filtered.length;
      const bookings = filtered.slice(offset, offset + limit).map((r) => {
        const veh = vehiclesStore.find((v) => v.id === r.vehicle_id) || {};
        const coverImg = r.cover_image_url || veh.cover_image_url || null;
        return {
          id: r.id,
          bookingNumber: r.booking_number,
          customerId: r.customer_id,
          partnerId: r.partner_id,
          vehicleId: r.vehicle_id,
          startAt: r.start_at,
          expectedReturnAt: r.expected_return_at,
          bookingStatus: r.booking_status,
          paymentStatus: r.payment_status,
          pickupLocation: r.pickup_location,
          customer: {
            id: r.customer_id,
            name: r.customer_name,
            email: r.customer_email,
            phone: r.customer_phone,
          },
          partner: {
            id: r.partner_id,
            businessName: r.partner_name,
            city: r.partner_city,
          },
          vehicle: {
            id: r.vehicle_id,
            registrationNumber: r.vehicle_registration_number,
            brand: r.vehicle_brand,
            model: r.vehicle_model,
            category: r.vehicle_category,
            coverImageUrl: coverImg,
            primaryImage: coverImg,
            primaryImageUrl: coverImg,
          },
          coverImageUrl: coverImg,
          vehicleImage: coverImg,
          totalAmount: r.total_amount,
          securityDeposit: r.security_deposit,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      });
      return { bookings, total };
    },
    findBookingById: async (bookingId) => {
      const r = bookingsStore.find((item) => item.id === bookingId);
      if (!r) return null;
      const veh = vehiclesStore.find((v) => v.id === r.vehicle_id) || {};
      const coverImg = r.cover_image_url || veh.cover_image_url || null;
      return {
        id: r.id,
        bookingNumber: r.booking_number,
        customerId: r.customer_id,
        partnerId: r.partner_id,
        vehicleId: r.vehicle_id,
        startAt: r.start_at,
        expectedReturnAt: r.expected_return_at,
        actualReturnAt: r.actual_return_at,
        bookingStatus: r.booking_status,
        paymentStatus: r.payment_status,
        pickupLocation: r.pickup_location,
        returnLocation: r.return_location,
        totalAmount: r.total_amount,
        securityDeposit: r.security_deposit,
        commissionAmount: r.commission_amount,
        partnerPayoutAmount: r.partner_payout_amount,
        cancellationReason: r.cancellation_reason,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        customer: {
          id: r.customer_id,
          name: r.customer_name,
          email: r.customer_email,
          phone: r.customer_phone,
        },
        partner: {
          id: r.partner_id,
          businessName: r.partner_name,
          city: r.partner_city,
        },
        vehicle: {
          id: r.vehicle_id,
          registrationNumber: r.vehicle_registration_number,
          brand: r.vehicle_brand,
          model: r.vehicle_model,
          category: r.vehicle_category,
          coverImageUrl: coverImg,
          primaryImage: coverImg,
          primaryImageUrl: coverImg,
          images: coverImg ? [{ id: 'img-1', vehicleId: r.vehicle_id, imageUrl: coverImg, isCover: true }] : [],
        },
        coverImageUrl: coverImg,
        vehicleImage: coverImg,
      };
    },
    findBookingByIdForUpdate: async (bookingId) => {
      return bookingsStore.find(b => b.id === bookingId) || null;
    },
    getBookingSummaries: async (bookingId) => ({
      durationHours: 48,
      isOverdue: false,
    }),
    updateBookingStatus: async (bookingId, bookingStatus) => {
      const b = bookingsStore.find(item => item.id === bookingId);
      if (b) b.booking_status = bookingStatus;
      return b || null;
    },
    updateVehicleRentalStatus: async () => {},
    getBookingPayments: async (bookingId) => [
      {
        id: 'pay-001',
        booking_id: bookingId,
        amount: 8500,
        payment_type: 'RENTAL',
        status: 'SUCCESS',
        created_at: '2026-09-27T14:35:00Z',
      }
    ],
    getBookingCommission: async (bookingId) => ({ commissionRate: 15.0, gongoCut: 1275 }),
    getBookingSettlement: async (bookingId) => ({ settlementStatus: 'PENDING', amount: 7225 }),
    getBookingDamages: async () => [],
    getBookingAdminActions: async () => [],
  });

  // 5. Verification Resolver
  setMock(AdminVerificationRepository, 'setMockVerificationResolver', {
    listPartnerVerifications: async ({ search, kycStatus, unverifiedOnly = false, limit = 10, offset = 0 }) => {
      let filtered = [...partnersStore];
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(p => p.business_name.toLowerCase().includes(q) || p.user_name.toLowerCase().includes(q));
      }
      if (unverifiedOnly || kycStatus === 'UNVERIFIED') {
        filtered = filtered.filter(p => p.kyc_status !== 'VERIFIED');
      } else if (kycStatus && kycStatus !== 'ALL') {
        filtered = filtered.filter(p => p.kyc_status === kycStatus);
      }

      const total = filtered.length;
      const partners = filtered.slice(offset, offset + limit).map(r => ({
        id: r.id,
        userId: r.user_id,
        businessName: r.business_name,
        businessType: r.business_type,
        city: r.city,
        kycStatus: r.kyc_status,
        isActive: r.is_active,
        owner: {
          name: r.user_name,
          email: r.user_email,
          phone: r.user_phone,
        },
        documentCounts: {
          total: 2,
          verified: r.kyc_status === 'VERIFIED' ? 2 : 1,
          pending: r.kyc_status === 'UNDER_REVIEW' ? 1 : 0,
          rejected: r.kyc_status === 'REJECTED' ? 1 : 0,
        },
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      return { partners, total };
    },
    findPartnerVerificationById: async (partnerId) => {
      const p = partnersStore.find(item => item.id === partnerId);
      if (!p) return null;
      return {
        id: p.id,
        userId: p.user_id,
        businessName: p.business_name,
        businessType: p.business_type,
        city: p.city,
        kycStatus: p.kyc_status,
        owner: {
          name: p.user_name,
          email: p.user_email,
          phone: p.user_phone,
        },
        documents: documentsStore.filter(d => d.entity_id === partnerId).map(d => ({
          id: d.id,
          documentType: d.document_type,
          documentNumber: d.document_number,
          fileUrl: d.file_url,
          verificationStatus: d.verification_status,
          rejectionReason: d.rejection_reason,
          createdAt: d.created_at,
        })),
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      };
    },
    findPartnerByIdForUpdate: async (partnerId) => {
      return partnersStore.find(p => p.id === partnerId) || null;
    },
    updatePartnerKycStatus: async (partnerId, kycStatus) => {
      const p = partnersStore.find(item => item.id === partnerId);
      if (p) p.kyc_status = kycStatus;
      return p || null;
    },
    listVehicleVerifications: async ({ search, verificationStatus, unverifiedOnly = false, limit = 10, offset = 0 }) => {
      let filtered = [...vehiclesStore];
      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        filtered = filtered.filter(v => {
          const partner = partnersStore.find(p => p.id === v.partner_id) || {};
          const partnerOwner = partner.owner_name || partner.name || '';
          const shopName = v.shop_name || partner.business_name || '';
          return (
            (v.registration_number && v.registration_number.toLowerCase().includes(q)) ||
            (v.brand && v.brand.toLowerCase().includes(q)) ||
            (v.model && v.model.toLowerCase().includes(q)) ||
            (v.id && v.id.toLowerCase().includes(q)) ||
            partnerOwner.toLowerCase().includes(q) ||
            shopName.toLowerCase().includes(q) ||
            (partner.business_name && partner.business_name.toLowerCase().includes(q))
          );
        });
      }
      if (unverifiedOnly || verificationStatus === 'UNVERIFIED') {
        filtered = filtered.filter(v => v.verification_status !== 'VERIFIED');
      } else if (verificationStatus && verificationStatus !== 'ALL') {
        filtered = filtered.filter(v => v.verification_status === verificationStatus);
      }

      const total = filtered.length;
      const vehicles = filtered.slice(offset, offset + limit).map(r => {
        const partner = partnersStore.find(p => p.id === r.partner_id) || {};
        return {
          id: r.id,
          partnerId: r.partner_id,
          category: r.category,
          brand: r.brand,
          model: r.model,
          variant: r.variant,
          registrationNumber: r.registration_number,
          year: r.year,
          fuelType: r.fuel_type,
          transmission: r.transmission,
          manualStatus: r.manual_status,
          rentalStatus: r.rental_status,
          verificationStatus: r.verification_status,
          isArchived: r.is_archived,
          shopName: r.shop_name || partner.business_name || 'Central Hub',
          partner: {
            id: r.partner_id,
            name: partner.owner_name || partner.name || partner.business_name || r.partner_name || 'Fleet Operator',
            ownerName: partner.owner_name || partner.name || partner.business_name || r.partner_name || 'Fleet Operator',
            businessName: partner.business_name || r.partner_name || 'Partner Shop',
            city: r.partner_city || partner.city || 'Bengaluru',
          },
          shop: {
            id: r.shop_id || 'shop-01',
            name: r.shop_name || partner.business_name || 'Central Hub',
          },
          documentCounts: {
            total: 2,
            verified: r.verification_status === 'VERIFIED' ? 2 : 1,
            pending: r.verification_status === 'PENDING' ? 1 : 0,
            rejected: r.verification_status === 'REJECTED' ? 1 : 0,
          },
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      });
      return { vehicles, total };
    },
    findVehicleVerificationById: async (vehicleId) => {
      const v = vehiclesStore.find(item => item.id === vehicleId);
      if (!v) return null;
      return {
        id: v.id,
        partnerId: v.partner_id,
        registrationNumber: v.registration_number,
        brand: v.brand,
        model: v.model,
        category: v.category,
        verificationStatus: v.verification_status,
        partner: {
          id: v.partner_id,
          businessName: v.partner_name,
          city: v.partner_city,
        },
        documents: documentsStore.filter(d => d.entity_id === vehicleId).map(d => ({
          id: d.id,
          documentType: d.document_type,
          documentNumber: d.document_number,
          fileUrl: d.file_url,
          verificationStatus: d.verification_status,
          rejectionReason: d.rejection_reason,
          createdAt: d.created_at,
        })),
        createdAt: v.created_at,
        updatedAt: v.updated_at,
      };
    },
    findVehicleByIdForUpdate: async (vehicleId) => {
      return vehiclesStore.find(v => v.id === vehicleId) || null;
    },
    updateVehicleVerificationStatus: async (vehicleId, verificationStatus) => {
      const v = vehiclesStore.find(item => item.id === vehicleId);
      if (v) v.verification_status = verificationStatus;
      if (verificationStatus === 'VERIFIED') {
        documentsStore.forEach(d => {
          if (d.vehicle_id === vehicleId && d.verification_status === 'PENDING') {
            d.verification_status = 'VERIFIED';
          }
        });
        imagesStore.forEach(img => {
          if (img.vehicle_id === vehicleId && img.verification_status === 'PENDING') {
            img.verification_status = 'VERIFIED';
          }
        });
      }
      return v || null;
    },
    findDocumentById: async (documentId) => {
      return documentsStore.find(d => d.id === documentId) || null;
    },
    findPartnerDocumentByIdForUpdate: async (documentId) => {
      return documentsStore.find(d => d.id === documentId) || null;
    },
    updatePartnerDocumentStatus: async (documentId, { verificationStatus, rejectionReason }) => {
      const doc = documentsStore.find(d => d.id === documentId);
      if (doc) {
        doc.verification_status = verificationStatus;
        doc.rejection_reason = rejectionReason;
      }
      return doc || null;
    },
    findVehicleDocumentByIdForUpdate: async (documentId) => {
      return documentsStore.find(d => d.id === documentId) || null;
    },
    updateVehicleDocumentStatus: async (documentId, { verificationStatus, rejectionReason }) => {
      const doc = documentsStore.find(d => d.id === documentId);
      if (doc) {
        doc.verification_status = verificationStatus;
        doc.rejection_reason = rejectionReason;
      }
      return doc || null;
    },
    listKycVerifications: async () => ({ verifications: [], total: 0 }),
  });

  // 6. Shop Resolver
  setMock(AdminShopRepository, 'setMockShopResolver', {
    findAllPaginated: async ({ search, status, city, limit = 20, offset = 0 }) => {
      let filtered = [...shopsStore];
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(s => s.shop_name.toLowerCase().includes(q) || s.business_name.toLowerCase().includes(q));
      }
      if (status === 'active') filtered = filtered.filter(s => s.is_active === true);
      if (status === 'inactive') filtered = filtered.filter(s => s.is_active === false);
      if (city) filtered = filtered.filter(s => s.city.toLowerCase().includes(city.toLowerCase()));

      const total = filtered.length;
      return { shops: filtered.slice(offset, offset + limit), total };
    },
    findById: async (shopId) => {
      const s = shopsStore.find(item => item.id === shopId);
      if (!s) return null;
      return {
        id: s.id,
        name: s.shop_name,
        shopName: s.shop_name,
        partnerId: s.partner_id,
        partnerName: s.business_name,
        partnerPhone: s.phone,
        address: s.address,
        shopAddress: s.address,
        city: s.city,
        area: s.city,
        status: s.is_active ? 'active' : 'suspended',
        isActive: s.is_active,
        verificationStatus: 'verified',
        vehicleCount: s.vehicle_count,
        operatingHours: s.operating_hours,
        phone: s.phone,
        createdAt: s.created_at,
        updatedAt: s.created_at,
      };
    },
    findByIdWithDetails: async (shopId) => {
      const s = shopsStore.find(item => item.id === shopId);
      if (!s) return null;
      return {
        ...s,
        name: s.shop_name,
        partnerName: s.business_name,
        createdAt: s.created_at,
        vehicles: vehiclesStore.filter(v => v.shop_id === shopId || v.partner_id === s.partner_id),
      };
    },
    getShopVehicles: async (shopId) => {
      const s = shopsStore.find(item => item.id === shopId);
      if (!s) return [];
      return vehiclesStore
        .filter(v => v.shop_id === shopId || v.partner_id === s.partner_id)
        .map(v => ({
          id: v.id,
          shopId: s.id,
          partnerId: v.partner_id,
          brand: v.brand,
          modelName: v.model,
          registrationNumber: v.registration_number,
          category: v.category,
          manufactureYear: v.year,
          color: v.color || 'Black',
          engineCapacity: v.engine_capacity || '350cc',
          currentOdometer: v.current_odometer || 4200,
          coverImageUrl: v.cover_image_url,
          createdAt: v.created_at,
          verificationStatus: v.verification_status,
          status: v.rental_status.toLowerCase(),
          isAvailable: v.rental_status === 'AVAILABLE',
          dailyRate: v.price_per_day,
        }));
    },
    updateShopStatus: async (shopId, isActive) => {
      const s = shopsStore.find(item => item.id === shopId);
      if (s) s.is_active = isActive;
      return s || null;
    },
    findVehiclesByShopId: async (shopId) => {
      const s = shopsStore.find(item => item.id === shopId);
      return s ? vehiclesStore.filter(v => v.shop_id === shopId || v.partner_id === s.partner_id) : [];
    },
  });

  // 7. Payment & Wallet & Dispute Resolvers
  let devCommissionRulesStore = [
    {
      id: '6828d401-c511-4436-8174-a25b1a869ec7',
      name: 'Global Platform Default',
      rule_scope: 'default',
      category_id: null,
      partner_id: null,
      vehicle_id: null,
      commission_type: 'percentage',
      commission_value: 15.0,
      priority: 0,
      effective_from: new Date().toISOString(),
      effective_until: null,
      is_active: true,
      created_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  let devSupportTicketsStore = [
    {
      id: 'a1111111-1111-4111-a111-111111111111',
      ticket_number: 'TKT-20261001-001',
      customer_id: null,
      partner_id: 'prt-901',
      booking_id: null,
      category: 'PARTNER',
      subject: 'Payout settlement query for weekend fleet',
      description: 'Partner is requesting clarification on platform commission applied to weekend payouts.',
      status: 'OPEN',
      priority: 'HIGH',
      assigned_to: null,
      assigned_at: null,
      resolved_by: null,
      resolved_at: null,
      closed_at: null,
      resolution_notes: null,
      metadata: {},
      created_at: '2026-10-01T08:30:00Z',
      updated_at: '2026-10-01T09:15:00Z',
      customer_name: null,
      customer_phone: null,
      customer_email: null,
      customer_is_active: null,
      partner_business_name: 'Speedy Wheels Mobility',
      partner_owner_name: 'Vikram Malhotra',
      partner_phone: '+91 98220 11223',
      partner_email: 'vikram@speedywheels.in',
      partner_city: 'Bengaluru',
      partner_kyc_status: 'VERIFIED',
      booking_number: null,
      booking_status: null,
      assigned_admin_name: null,
      assigned_admin_email: null,
      resolved_by_admin_name: null,
      message_count: 2,
      last_message_at: '2026-10-01T09:15:00Z',
      original_sender_type: 'PARTNER',
      original_sender_id: 'usr-p01',
      original_message_at: '2026-10-01T08:30:00Z',
    },
    {
      id: 'b2222222-2222-4222-a222-222222222222',
      ticket_number: 'TKT-20261002-002',
      customer_id: 'cust-001',
      partner_id: null,
      booking_id: 'b0000001-0000-4000-a000-000000000001',
      category: 'BOOKING',
      subject: 'Extension of booking BK-1001 by 2 days',
      description: 'Customer requested 2-day booking extension due to travel schedule adjustment.',
      status: 'IN_PROGRESS',
      priority: 'MEDIUM',
      assigned_to: 'adm-001',
      assigned_at: '2026-10-02T10:00:00Z',
      resolved_by: null,
      resolved_at: null,
      closed_at: null,
      resolution_notes: null,
      metadata: {},
      created_at: '2026-10-02T09:00:00Z',
      updated_at: '2026-10-02T10:15:00Z',
      customer_name: 'Aarav Mehta',
      customer_phone: '+91 98450 12345',
      customer_email: 'aarav.mehta@example.com',
      customer_is_active: true,
      partner_business_name: null,
      partner_owner_name: null,
      partner_phone: null,
      partner_email: null,
      partner_city: null,
      partner_kyc_status: null,
      booking_number: 'BK-1001',
      booking_status: 'ACTIVE',
      assigned_admin_name: 'Super Admin',
      assigned_admin_email: 'admin@gongo.in',
      resolved_by_admin_name: null,
      message_count: 2,
      last_message_at: '2026-10-02T10:15:00Z',
      original_sender_type: 'CUSTOMER',
      original_sender_id: 'cust-001',
      original_message_at: '2026-10-02T09:00:00Z',
    },
  ];

  let devSupportMessagesStore = [
    {
      id: 'm-dev-01',
      ticket_id: 'a1111111-1111-4111-a111-111111111111',
      sender_type: 'PARTNER',
      sender_id: 'usr-p01',
      message: 'Hello Support, could you please review the commission deduction for our weekend payout?',
      attachments: [],
      created_at: '2026-10-01T08:30:00Z',
      sender_name: 'Speedy Wheels Mobility',
      sender_role: 'PARTNER',
      sender_email: 'vikram@speedywheels.in',
    },
    {
      id: 'm-dev-02',
      ticket_id: 'a1111111-1111-4111-a111-111111111111',
      sender_type: 'SUPPORT',
      sender_id: 'adm-001',
      message: 'Hi Vikram, our finance desk is reconciling the payout batch and will update you shortly.',
      attachments: [],
      created_at: '2026-10-01T09:15:00Z',
      sender_name: 'Support Desk Admin',
      sender_role: 'ADMIN',
      sender_email: 'support@gongo.in',
    },
    {
      id: 'm-dev-03',
      ticket_id: 'b2222222-2222-4222-a222-222222222222',
      sender_type: 'CUSTOMER',
      sender_id: 'cust-001',
      message: 'Hi, I would like to extend my active Royal Enfield booking by two additional days.',
      attachments: [],
      created_at: '2026-10-02T09:00:00Z',
      sender_name: 'Aarav Mehta',
      sender_role: 'CUSTOMER',
      sender_email: 'aarav.mehta@example.com',
    },
    {
      id: 'm-dev-04',
      ticket_id: 'b2222222-2222-4222-a222-222222222222',
      sender_type: 'SUPPORT',
      sender_id: 'adm-001',
      message: 'Hello Aarav, we have contacted the fleet partner to verify vehicle availability for the requested dates.',
      attachments: [],
      created_at: '2026-10-02T10:15:00Z',
      sender_name: 'Support Desk Admin',
      sender_role: 'ADMIN',
      sender_email: 'support@gongo.in',
    },
  ];

  const mockSqlExec = async (sql, params = []) => {
    const s = String(sql).toUpperCase();

    if (s.includes('SUPPORT_TICKETS') || s.includes('SUPPORT_TICKET_MESSAGES')) {
      if (s.includes('COUNT(*)::INT AS TOTAL')) {
        return { rows: [{ total: devSupportTicketsStore.length }], rowCount: 1 };
      }
      if (s.includes('FROM SUPPORT_TICKETS T') && (s.includes('WHERE T.ID = $1') || s.includes('WHERE ID = $1'))) {
        const ticket = devSupportTicketsStore.find((t) => t.id === params[0]) || devSupportTicketsStore[0];
        return { rows: ticket ? [ticket] : [], rowCount: ticket ? 1 : 0 };
      }
      if (s.includes('FROM SUPPORT_TICKET_MESSAGES M') && (s.includes('WHERE M.TICKET_ID = $1') || s.includes('WHERE TICKET_ID = $1'))) {
        const msgs = devSupportMessagesStore.filter((m) => m.ticket_id === params[0]);
        return { rows: msgs, rowCount: msgs.length };
      }
      if (s.includes('INSERT INTO SUPPORT_TICKET_MESSAGES')) {
        const newMsg = {
          id: `msg-${Date.now()}`,
          ticket_id: params[0],
          sender_type: params[1],
          sender_id: params[2],
          message: params[3],
          attachments: params[4] || [],
          created_at: new Date().toISOString(),
          sender_name: 'Support Desk Admin',
          sender_role: 'ADMIN',
        };
        devSupportMessagesStore.push(newMsg);
        return { rows: [newMsg], rowCount: 1 };
      }
      if (s.includes('FROM SUPPORT_TICKETS')) {
        return { rows: devSupportTicketsStore, rowCount: devSupportTicketsStore.length };
      }
    }
    if (s.includes('COMMISSION_RULES')) {
      if (s.includes('INSERT INTO COMMISSION_RULES')) {
        const newRule = {
          id: `cr-${Date.now()}`,
          name: params[0] || 'Commission Rule',
          rule_scope: params[1] || 'default',
          category_id: params[2] || null,
          partner_id: params[3] || null,
          vehicle_id: params[4] || null,
          commission_type: params[5] || 'percentage',
          commission_value: Number(params[6] || 0),
          priority: Number(params[7] || 0),
          effective_from: params[8] || new Date().toISOString(),
          effective_until: params[9] || null,
          is_active: params[10] !== undefined ? params[10] : true,
          created_by: params[11] || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        devCommissionRulesStore.push(newRule);
        return { rows: [newRule], rowCount: 1 };
      }
      if (s.includes('UPDATE COMMISSION_RULES')) {
        const id = params[params.length - 1];
        const rule = devCommissionRulesStore.find(r => r.id === id);
        if (rule) {
          rule.updated_at = new Date().toISOString();
        }
        return { rows: rule ? [rule] : [], rowCount: rule ? 1 : 0 };
      }
      if (s.includes('DELETE FROM COMMISSION_RULES')) {
        const id = params[0];
        const idx = devCommissionRulesStore.findIndex(r => r.id === id);
        if (idx >= 0) devCommissionRulesStore.splice(idx, 1);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (s.includes('WHERE CR.ID = $1') || s.includes('WHERE ID = $1')) {
        const rule = devCommissionRulesStore.find(r => r.id === params[0]);
        return { rows: rule ? [rule] : [], rowCount: rule ? 1 : 0 };
      }
      return {
        rows: devCommissionRulesStore.map(r => ({ ...r, full_count: devCommissionRulesStore.length })),
        rowCount: devCommissionRulesStore.length,
      };
    }

    if (s.includes('FROM VEHICLE_CATEGORIES')) {
      return {
        rows: [
          { id: '032f4a5c-ac79-4f3b-8d30-61eb49462212', name: 'Bike' },
          { id: 'db1dedc6-cca9-4c59-b200-4965f9207a34', name: 'Car' },
          { id: 'd786df39-dd63-40df-bd8b-b4a78bdffaea', name: 'EV' },
          { id: '97769e91-f292-4d11-ae1c-3eb2541bb8a9', name: 'Scooty' },
        ],
        rowCount: 4,
      };
    }

    // Return empty array / zero count for generic queries
    return { rows: [], rowCount: 0 };
  };

  if (typeof setMockPaymentResolver === 'function') setMockPaymentResolver(mockSqlExec);
  if (typeof setMockWalletResolver === 'function') setMockWalletResolver(mockSqlExec);
  setMock(AdminDamageDisputeRepository, 'setMockDamageDisputeResolver', mockSqlExec);
  setMock(AdminSupportRepository, 'setMockSupportResolver', mockSqlExec);
  setMock(AdminActionRepository, 'setMockActionResolver', async () => ({ id: 'act-dev-01' }));
  
  const AdminStorageRepository = require('../repositories/admin-storage.repository');
  setMock(AdminStorageRepository, 'setMockStorageResolver', mockSqlExec);

  const platformFeeRepo = require('../repositories/platform-fee.repository');
  if (typeof platformFeeRepo.setMockPlatformFeeResolver === 'function') {
    platformFeeRepo.setMockPlatformFeeResolver({
      findActive: async (vehicleType = null) => {
        const { mapRowsToPlatformCharges, mapRowsToAllPlatformCharges } = require('../repositories/platform-fee.repository');
        if (vehicleType === 'car') return mapRowsToPlatformCharges(platformFeeStore, 'car');
        if (vehicleType === 'bike') return mapRowsToPlatformCharges(platformFeeStore, 'bike');
        if (vehicleType === 'all') {
          return {
            bike: mapRowsToPlatformCharges(platformFeeStore, 'bike'),
            car: mapRowsToPlatformCharges(platformFeeStore, 'car'),
          };
        }
        return mapRowsToAllPlatformCharges(platformFeeStore);
      },
      updateActiveCharges: async ({
        serviceCharge,
        convenienceFee,
        gst,
        adminId = null,
        vehicleType = 'bike',
      }) => {
        const { mapRowsToPlatformCharges } = require('../repositories/platform-fee.repository');
        const isCar = String(vehicleType).toLowerCase().trim() === 'car';
        const previous = mapRowsToPlatformCharges(platformFeeStore, isCar ? 'car' : 'bike');

        const scType = isCar ? 'service_charge_car' : 'service_charge';
        const cfType = isCar ? 'convenience_fee_car' : 'convenience_fee';
        const gstType = isCar ? 'gst_car' : 'gst';

        let sc = platformFeeStore.find((r) => r.charge_type === scType);
        if (!sc) {
          sc = { id: `sc-${Date.now()}`, charge_type: scType, calculation_type: 'fixed', currency: 'INR', is_active: true };
          platformFeeStore.push(sc);
        }
        sc.value = serviceCharge;
        sc.updated_at = new Date().toISOString();
        sc.created_by = adminId;

        let cf = platformFeeStore.find((r) => r.charge_type === cfType);
        if (!cf) {
          cf = { id: `cf-${Date.now()}`, charge_type: cfType, calculation_type: 'fixed', currency: 'INR', is_active: true };
          platformFeeStore.push(cf);
        }
        cf.value = convenienceFee;
        cf.updated_at = new Date().toISOString();
        cf.created_by = adminId;

        let g = platformFeeStore.find((r) => r.charge_type === gstType);
        if (!g) {
          g = { id: `gst-${Date.now()}`, charge_type: gstType, calculation_type: 'percentage', currency: 'INR', is_active: true };
          platformFeeStore.push(g);
        }
        g.value = gst;
        g.updated_at = new Date().toISOString();
        g.created_by = adminId;

        const current = mapRowsToPlatformCharges(platformFeeStore, isCar ? 'car' : 'bike');
        return { previous, current, vehicleType: isCar ? 'car' : 'bike' };
      },
      updateActiveFee: async ({ feeType, feeValue, adminId = null, vehicleType = 'bike' }) => {
        const isCar = String(vehicleType).toLowerCase().trim() === 'car';
        const serviceCharge = isCar ? 5.00 : 2.50;
        const convenienceFee = feeType === 'fixed' ? feeValue : (isCar ? 3.00 : 2.00);
        const gst = feeType === 'percentage' ? feeValue : 18.00;
        const scType = isCar ? 'service_charge_car' : 'service_charge';
        const cfType = isCar ? 'convenience_fee_car' : 'convenience_fee';
        const gstType = isCar ? 'gst_car' : 'gst';

        const sc = platformFeeStore.find((r) => r.charge_type === scType);
        if (sc) sc.value = serviceCharge;
        const cf = platformFeeStore.find((r) => r.charge_type === cfType);
        if (cf) cf.value = convenienceFee;
        const g = platformFeeStore.find((r) => r.charge_type === gstType);
        if (g) g.value = gst;
        const { mapRowsToPlatformCharges } = require('../repositories/platform-fee.repository');
        return {
          previous: mapRowsToPlatformCharges(platformFeeStore, isCar ? 'car' : 'bike'),
          current: mapRowsToPlatformCharges(platformFeeStore, isCar ? 'car' : 'bike'),
        };
      },
    });
  }

  const cancellationRulesRepo = require('../repositories/cancellation-rules.repository');
  if (typeof cancellationRulesRepo.setMockCancellationRulesResolver === 'function') {
    cancellationRulesRepo.setMockCancellationRulesResolver({
      findByVehicleType: async (type) => {
        const norm = String(type).toLowerCase();
        const list = cancellationRulesStore[norm] || [];
        return list.map((r) => ({
          id: r.id,
          tier: Number(r.tier),
          noticeHours: Number(r.notice_hours),
          refundPercentage: Number(r.refund_percentage),
        }));
      },
      findAll: async () => ({
        bike: (cancellationRulesStore.bike || []).map((r) => ({
          id: r.id,
          tier: Number(r.tier),
          noticeHours: Number(r.notice_hours),
          refundPercentage: Number(r.refund_percentage),
        })),
        car: (cancellationRulesStore.car || []).map((r) => ({
          id: r.id,
          tier: Number(r.tier),
          noticeHours: Number(r.notice_hours),
          refundPercentage: Number(r.refund_percentage),
        })),
      }),
      updateRulesForVehicleType: async ({ vehicleType, rules }) => {
        const norm = String(vehicleType).toLowerCase();
        cancellationRulesStore[norm] = rules.map((r, idx) => ({
          id: `dev-crule-${norm}-${idx + 1}-${Date.now()}`,
          tier: idx + 1,
          notice_hours: Number(r.noticeHours ?? r.notice_hours),
          refund_percentage: Number(r.refundPercentage ?? r.refund_percentage),
          is_active: true,
        }));
        return cancellationRulesStore[norm].map((r) => ({
          id: r.id,
          tier: Number(r.tier),
          noticeHours: Number(r.notice_hours),
          refundPercentage: Number(r.refund_percentage),
        }));
      },
      updateAllRules: async ({ bike, car }) => {
        cancellationRulesStore.bike = bike.map((r, idx) => ({
          id: `dev-crule-bike-${idx + 1}-${Date.now()}`,
          tier: idx + 1,
          notice_hours: Number(r.noticeHours ?? r.notice_hours),
          refund_percentage: Number(r.refundPercentage ?? r.refund_percentage),
          is_active: true,
        }));
        cancellationRulesStore.car = car.map((r, idx) => ({
          id: `dev-crule-car-${idx + 1}-${Date.now()}`,
          tier: idx + 1,
          notice_hours: Number(r.noticeHours ?? r.notice_hours),
          refund_percentage: Number(r.refundPercentage ?? r.refund_percentage),
          is_active: true,
        }));
        return {
          bike: cancellationRulesStore.bike.map((r) => ({
            id: r.id,
            tier: Number(r.tier),
            noticeHours: Number(r.notice_hours),
            refundPercentage: Number(r.refund_percentage),
          })),
          car: cancellationRulesStore.car.map((r) => ({
            id: r.id,
            tier: Number(r.tier),
            noticeHours: Number(r.notice_hours),
            refundPercentage: Number(r.refund_percentage),
          })),
        };
      },
    });
  }
}

module.exports = {
  registerDevResolvers,
};
