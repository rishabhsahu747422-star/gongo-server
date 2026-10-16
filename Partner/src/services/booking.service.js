'use strict';

const crypto = require('crypto');
const bookingRepository = require('../repositories/booking.repository');
const bookingValidator = require('../validators/booking.validator');
const vehicleRepository = require('../repositories/vehicle.repository');
const EarningsRepository = require('../repositories/earnings.repository');
const WalletRepository = require('../repositories/wallet.repository');
const WalletTransactionRepository = require('../repositories/wallet-transaction.repository');
const otpProvider = require('../providers/otp.provider');
const smsProvider = require('../providers/sms.provider');
const auditService = require('./audit.service');
const OvertimeService = require('./overtime.service');
const commissionLockService = require('./commission-lock.service');
const pool = require('../db/pool');
const {
  NotFoundError,
  ConflictError,
  ValidationError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

function calculateLateCharges({ expectedReturnAt, actualReturnAt, pricePerHour }) {
  if (!expectedReturnAt || !actualReturnAt) {
    return {
      isLate: false,
      lateMinutes: 0,
      billableHours: 0,
      lateFee: 0.00,
      returnStatus: 'ON_TIME',
    };
  }

  const expectedMs = new Date(expectedReturnAt).getTime();
  const actualMs = new Date(actualReturnAt).getTime();
  const diffMinutes = Math.floor((actualMs - expectedMs) / (60 * 1000));

  if (diffMinutes <= 15) {
    return {
      isLate: false,
      lateMinutes: Math.max(0, diffMinutes),
      billableHours: 0,
      lateFee: 0.00,
      returnStatus: 'ON_TIME',
    };
  }

  const billableHours = Math.ceil(diffMinutes / 60);
  const hourlyRate = Number(pricePerHour || 0);
  const lateFee = Number((billableHours * hourlyRate).toFixed(2));

  return {
    isLate: true,
    lateMinutes: diffMinutes,
    billableHours,
    lateFee,
    returnStatus: 'LATE',
  };
}

function formatReturnDetails(booking, returnVerif, damageReports = []) {
  if (!returnVerif) return null;

  const odoStart = booking.odometer_start !== undefined && booking.odometer_start !== null
    ? Number(booking.odometer_start)
    : null;
  const odoEnd = returnVerif.odometer_end !== undefined && returnVerif.odometer_end !== null
    ? Number(returnVerif.odometer_end)
    : null;
  const totDist = returnVerif.total_distance !== undefined && returnVerif.total_distance !== null
    ? Number(returnVerif.total_distance)
    : null;

  const lateFeeVal = Number(returnVerif.late_fee || 0);
  const extraKmFeeVal = Number(returnVerif.extra_km_fee || 0);
  const totalBase = Number(booking.total_customer_amount || 0);
  const totalCollected = totalBase + lateFeeVal + extraKmFeeVal;

  const overtime = OvertimeService.extractPersistedOvertime(booking, returnVerif);

  return {
    id: returnVerif.id,
    bookingId: booking.id,
    bookingNumber: booking.booking_reference || booking.booking_number,
    bookingReference: booking.booking_reference || booking.booking_number,
    status: booking.booking_status,
    expectedReturnAt: booking.expected_return_at,
    scheduledReturnAt: overtime.scheduledReturnAt || booking.expected_return_at,
    actualReturnAt: returnVerif.returned_at || overtime.actualReturnAt,
    returnStatus: returnVerif.return_status || 'ON_TIME',
    odometerStart: odoStart,
    odometerEnd: odoEnd,
    totalDistance: totDist,
    fuelLevelStart: booking.fuel_level_start || null,
    fuelLevelEnd: returnVerif.fuel_level_end || null,
    lateMinutes: Number(returnVerif.late_minutes || overtime.overtimeDurationMinutes || 0),
    lateFee: lateFeeVal,
    overtimeDurationMinutes: overtime.overtimeDurationMinutes,
    gracePeriodMinutes: overtime.gracePeriodMinutes,
    billableHours: overtime.billableHours,
    hourlyRate: overtime.hourlyRate,
    overtimeRate: overtime.overtimeRate,
    overtimeAmount: overtime.overtimeAmount,
    overtimePaymentStatus: overtime.overtimePaymentStatus,
    paymentReference: overtime.paymentReference,
    overtime,
    extraKm: Number(returnVerif.extra_km || 0),
    extraKmFee: extraKmFeeVal,
    notes: returnVerif.notes || null,
    photos: returnVerif.photos || [],
    deposit: (() => {
      let parsed = null;
      if (typeof returnVerif.notes === 'string' && returnVerif.notes.trim().startsWith('{')) {
        try { parsed = JSON.parse(returnVerif.notes); } catch {}
      }
      return parsed?.deposit || null;
    })(),
    damageReports: (damageReports || []).map((d) => {
      const appAmt = d.approved_amount !== null && d.approved_amount !== undefined
        ? Number(d.approved_amount)
        : null;
      return {
        id: d.id,
        damageType: d.damage_type,
        description: d.description,
        estimatedAmount: Number(d.estimated_amount || 0),
        approvedAmount: appAmt,
        status: d.status,
        photos: d.photos || [],
        createdAt: d.created_at,
      };
    }),
    settlementSummary: {
      baseAmount: Number(booking.base_amount || booking.rental_amount || 0),
      lateFee: lateFeeVal,
      extraKmFee: extraKmFeeVal,
      totalCollected,
      currency: booking.currency || 'INR',
    },
  };
}

function formatBooking(b, overtimeState = null) {
  if (!b) return null;

  const vehicleName = [b.vehicle_brand, b.vehicle_model, b.vehicle_variant]
    .filter(Boolean)
    .join(' ')
    .trim();

  // Normalize status across canonical schema and Supabase status alignment
  const rawBookingStatus = String(b.booking_status || '').toUpperCase();
  const rawStatus = String(b.legacy_status || b.status || '').toLowerCase();

  let normalizedStatus = rawBookingStatus;
  if (
    ['CONFIRMED', 'UPCOMING', 'BOOKED', 'PAYMENT_COMPLETED', 'PAID', 'PICKUP_SCHEDULED'].includes(rawBookingStatus) ||
    ['payment_completed', 'confirmed', 'pickup_scheduled'].includes(rawStatus)
  ) {
    normalizedStatus = 'UPCOMING';
  } else if (
    ['ACTIVE', 'IN_PROGRESS', 'VEHICLE_PICKED'].includes(rawBookingStatus) ||
    ['active', 'in_progress', 'vehicle_picked'].includes(rawStatus)
  ) {
    normalizedStatus = 'ACTIVE';
  } else if (
    ['COMPLETED', 'RETURNED'].includes(rawBookingStatus) ||
    ['completed', 'returned'].includes(rawStatus)
  ) {
    normalizedStatus = 'COMPLETED';
  } else if (
    ['CANCELLED', 'REFUNDED'].includes(rawBookingStatus) ||
    ['cancelled', 'refunded'].includes(rawStatus)
  ) {
    normalizedStatus = 'CANCELLED';
  } else if (!normalizedStatus || normalizedStatus === 'PENDING') {
    if (['paid', 'completed'].includes(String(b.payment_status || '').toLowerCase())) {
      normalizedStatus = 'UPCOMING';
    }
  }

  const isCompletedOrReturned = ['COMPLETED', 'RETURNED'].includes(normalizedStatus) || Boolean(b.returned_at);

  let overtime;
  if (overtimeState) {
    overtime = overtimeState;
  } else if (isCompletedOrReturned) {
    const persisted = OvertimeService.extractPersistedOvertime(b);
    overtime = {
      isOvertime: persisted.hasOvertime,
      hasOvertime: persisted.hasOvertime,
      overtimeStartedAt: persisted.scheduledReturnAt,
      scheduledReturnAt: persisted.scheduledReturnAt,
      actualReturnAt: persisted.actualReturnAt,
      overtimeDurationMinutes: persisted.overtimeDurationMinutes,
      overtimeDurationSeconds: persisted.overtimeDurationMinutes * 60,
      overtimeDurationFormatted: persisted.overtimeDurationFormatted,
      gracePeriodMinutes: persisted.gracePeriodMinutes,
      billableHours: persisted.billableHours,
      overtimeRate: persisted.hourlyRate,
      hourlyRate: persisted.hourlyRate,
      overtimeAmount: persisted.overtimeAmount,
      totalOvertimePaid: persisted.overtimeAmount,
      remainingOvertimeDue: 0.00,
      extraPaymentRequired: false,
      extraPaymentStatus: persisted.overtimePaymentStatus,
      paymentReference: persisted.paymentReference,
      canCompleteReturn: true,
      returnPaymentRequired: false,
    };
  } else {
    overtime = OvertimeService.calculateOvertimeState(b);
  }

  const isVehicleVerified = ['VERIFIED', 'APPROVED'].includes(
    String(b.vehicle_verification_status || b.verification_status || '').toUpperCase(),
  );

  const startOdo = b.odometer_start !== undefined && b.odometer_start !== null
    ? Number(b.odometer_start)
    : null;
  const endOdo = b.odometer_end !== undefined && b.odometer_end !== null
    ? Number(b.odometer_end)
    : null;

  let totalDistance = null;
  if (b.total_distance !== undefined && b.total_distance !== null) {
    totalDistance = Number(b.total_distance);
  } else if (startOdo !== null && endOdo !== null) {
    totalDistance = Math.max(0, endOdo - startOdo);
  }

  const effectiveLateFee = b.return_late_fee !== undefined && b.return_late_fee !== null
    ? Number(b.return_late_fee)
    : Number(b.late_fee || 0);

  const effectiveExtraKmFee = b.extra_km_fee !== undefined && b.extra_km_fee !== null
    ? Number(b.extra_km_fee)
    : 0;

  const depositAmt = Number(b.security_deposit || 0);

  let pickupNotesData = null;
  const rawPickupNotes = b.pickup_notes || b.handover_notes;
  if (typeof rawPickupNotes === 'string' && rawPickupNotes.trim().startsWith('{')) {
    try { pickupNotesData = JSON.parse(rawPickupNotes); } catch {}
  } else if (typeof rawPickupNotes === 'object' && rawPickupNotes !== null) {
    pickupNotesData = rawPickupNotes;
  }

  let returnNotesData = null;
  const rawReturnNotes = b.return_notes;
  if (typeof rawReturnNotes === 'string' && rawReturnNotes.trim().startsWith('{')) {
    try { returnNotesData = JSON.parse(rawReturnNotes); } catch {}
  } else if (typeof rawReturnNotes === 'object' && rawReturnNotes !== null) {
    returnNotesData = rawReturnNotes;
  }

  const isDepositCollected = depositAmt > 0 && (
    b.deposit_collected === true ||
    b.deposit_status === 'COLLECTED' ||
    pickupNotesData?.deposit?.status === 'COLLECTED' ||
    pickupNotesData?.depositCollected === true ||
    ['ACTIVE', 'COMPLETED'].includes(normalizedStatus)
  );

  const isDepositReturned = depositAmt > 0 && (
    b.deposit_returned === true ||
    b.deposit_status === 'RETURNED' ||
    returnNotesData?.deposit?.status === 'RETURNED' ||
    returnNotesData?.depositReturned === true ||
    (isCompletedOrReturned && (returnNotesData?.deposit?.status === 'RETURNED' || b.deposit_returned === true))
  );

  let depositStatus = null;
  if (depositAmt > 0) {
    if (isDepositReturned) {
      depositStatus = 'Returned';
    } else if (isDepositCollected) {
      depositStatus = 'Collected';
    } else {
      depositStatus = 'Pending';
    }
  }

  // Authoritative rental/booking charges excluding security deposit
  const rawRental = b.rental_amount !== undefined && b.rental_amount !== null
    ? Number(b.rental_amount)
    : (b.base_amount !== undefined && b.base_amount !== null
      ? Number(b.base_amount)
      : (b.subtotal !== undefined && b.subtotal !== null ? Number(b.subtotal) : null));

  let effectiveBookingAmount;
  if (rawRental !== null && rawRental > 0) {
    effectiveBookingAmount = rawRental;
  } else {
    const candidate = Number(b.total_amount ?? b.total_customer_amount ?? b.gross_amount ?? 0);
    if (depositAmt > 0 && candidate > depositAmt) {
      effectiveBookingAmount = candidate - depositAmt;
    } else {
      effectiveBookingAmount = candidate;
    }
  }

  let advanceTotalPaid = 0;
  if (Array.isArray(b.payments_json)) {
    const paidPayments = b.payments_json.filter(
      (p) => ['paid', 'completed', 'success', 'successful'].includes(String(p.status || '').toLowerCase())
    );
    if (paidPayments.length > 0) {
      advanceTotalPaid = paidPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    }
  }
  if (advanceTotalPaid === 0 && ['PAID', 'CONFIRMED', 'UPCOMING', 'ACTIVE', 'COMPLETED'].includes(normalizedStatus)) {
    advanceTotalPaid = effectiveBookingAmount;
  }

  const rawCommissionRate = b.commission_rate !== undefined && b.commission_rate !== null ? Number(b.commission_rate) : null;
  const rawCommissionAmount = b.commission_amount !== undefined && b.commission_amount !== null ? Number(b.commission_amount) : null;
  const hasExplicitCommission = rawCommissionRate !== null || rawCommissionAmount !== null;

  let commissionAmount = 0;
  let commissionRate = rawCommissionRate !== null ? rawCommissionRate : 0;

  if (rawCommissionRate !== null && rawCommissionRate > 0) {
    commissionAmount = Number(((effectiveBookingAmount * rawCommissionRate) / 100).toFixed(2));
  } else if (rawCommissionAmount !== null) {
    commissionAmount = Math.min(effectiveBookingAmount, rawCommissionAmount);
  }

  const partnerEarning = Math.max(0, Number((effectiveBookingAmount - commissionAmount).toFixed(2)));

  const totalCustomerAmount = b.total_customer_amount !== undefined && b.total_customer_amount !== null
    ? Number(b.total_customer_amount)
    : Number((effectiveBookingAmount + depositAmt).toFixed(2));

  return {
    id: b.id,
    bookingNumber: b.booking_reference || b.booking_number,
    bookingReference: b.booking_reference || b.booking_number,
    status: normalizedStatus,
    bookingStatus: b.booking_status || normalizedStatus,
    paymentStatus: b.payment_status || (normalizedStatus === 'UPCOMING' ? 'PAID' : 'PENDING'),
    vehicleId: b.vehicle_id,
    vehicleReference: b.vehicle_reference || null,
    vehicleName,
    registrationNumber: b.registration_number,
    vehicleCategory: `${b.vehicle_category} • ${b.vehicle_fuel_type}`,
    vehicleImage: b.vehicle_cover_image_key || null,
    vehicleTransmission: b.vehicle_transmission || 'Manual',
    vehicleSeats: b.vehicle_seats || 2,
    isVehicleVerified,
    isGongoVerified: isVehicleVerified,
    customerId: b.customer_id,
    customerName: b.customer_name || 'Customer',
    customerPhone: b.customer_phone || null,
    customerRating: b.customer_rating !== undefined && b.customer_rating !== null
      ? Number(b.customer_rating)
      : (b.customerRating !== undefined && b.customerRating !== null ? Number(b.customerRating) : null),
    isCustomerVerified: Boolean(b.is_customer_verified || b.isCustomerVerified || b.customer_verified),
    startAt: b.start_at,
    expectedReturnAt: b.expected_return_at,
    scheduledReturnAt: b.expected_return_at || b.end_at || overtime.scheduledReturnAt,
    handoverAt: b.handover_at || null,
    returnedAt: b.returned_at || overtime.actualReturnAt || null,
    actualReturnAt: b.returned_at || overtime.actualReturnAt || null,
    returnStatus: b.return_status || (overtime.overtimeDurationMinutes > 15 ? 'LATE' : 'ON_TIME'),
    odometerStart: startOdo,
    odometerEnd: endOdo,
    totalDistance,
    lateMinutes: overtime.overtimeDurationMinutes !== undefined
      ? overtime.overtimeDurationMinutes
      : (b.late_minutes !== undefined && b.late_minutes !== null ? Number(b.late_minutes) : 0),
    lateFee: overtime.overtimeAmount !== undefined ? overtime.overtimeAmount : effectiveLateFee,
    overtimeDurationMinutes: overtime.overtimeDurationMinutes !== undefined
      ? overtime.overtimeDurationMinutes
      : (b.late_minutes !== undefined && b.late_minutes !== null ? Number(b.late_minutes) : 0),
    gracePeriodMinutes: overtime.gracePeriodMinutes ?? 15,
    billableHours: overtime.billableHours ?? 0,
    overtimeRate: overtime.overtimeRate,
    overtimeAmount: overtime.overtimeAmount,
    overtimePaymentStatus: overtime.extraPaymentStatus,
    paymentReference: overtime.paymentReference || null,
    extraKm: b.extra_km !== undefined && b.extra_km !== null ? Number(b.extra_km) : 0,
    rentalAmount: effectiveBookingAmount,
    baseAmount: Number(b.base_amount || effectiveBookingAmount),
    grossAmount: effectiveBookingAmount,
    bookingAmount: effectiveBookingAmount,
    totalAmount: effectiveBookingAmount,
    totalCustomerAmount,
    advanceTotalPaid,
    totalPaid: advanceTotalPaid,
    earnings: partnerEarning,
    earningsAmount: partnerEarning,
    partnerNetAmount: partnerEarning,
    partnerEarning,
    ...(hasExplicitCommission ? { commissionAmount, commissionRate } : {}),
    securityDeposit: depositAmt,
    depositStatus,
    securityDepositStatus: depositStatus,
    depositCollected: isDepositCollected,
    depositReturned: isDepositReturned,
    hourlyRate: Number(b.price_per_hour || overtime.overtimeRate || 0),
    rentalDurationMinutes:
      b.rental_duration_minutes !== null && b.rental_duration_minutes !== undefined
        ? Number(b.rental_duration_minutes)
        : null,
    pickupLocation: b.pickup_location,
    // Authoritative Overtime Domain Properties
    isOvertime: overtime.isOvertime,
    hasOvertime: overtime.hasOvertime || overtime.isOvertime,
    overtimeStartedAt: overtime.overtimeStartedAt,
    overtimeDurationSeconds: overtime.overtimeDurationSeconds,
    overtimeDurationFormatted: overtime.overtimeDurationFormatted,
    overtimeRate: overtime.overtimeRate,
    overtimeAmount: overtime.overtimeAmount,
    totalOvertimePaid: overtime.totalOvertimePaid,
    remainingOvertimeDue: overtime.remainingOvertimeDue,
    extraPaymentRequired: overtime.extraPaymentRequired,
    extraPaymentStatus: overtime.extraPaymentStatus,
    canCompleteReturn: overtime.canCompleteReturn,
    returnPaymentRequired: overtime.returnPaymentRequired,
    overtime,
    pricing: (b.total_customer_amount !== undefined && b.total_customer_amount !== null) || b.rental_amount !== undefined
      ? {
        baseAmount: Number(b.base_amount || effectiveBookingAmount),
        rentalAmount: effectiveBookingAmount,
        bookingAmount: effectiveBookingAmount,
        grossAmount: effectiveBookingAmount,
        advanceTotalPaid,
        totalPaid: advanceTotalPaid,
        securityDeposit: depositAmt,
        depositStatus,
        securityDepositStatus: depositStatus,
        depositCollected: isDepositCollected,
        depositReturned: isDepositReturned,
        pricePerHour: Number(b.price_per_hour || 0),
        extraKmCharge: Number(b.extra_km_charge || 0),
        lateFee: effectiveLateFee,
        discountAmount: Number(b.discount_amount || 0),
        taxesAmount: Number(b.taxes_amount || 0),
        totalCustomerAmount,
        currency: b.currency || 'INR',
        partnerNetAmount: partnerEarning,
        partnerEarning,
        ...(hasExplicitCommission ? { commissionAmount, commissionRate } : {}),
      }
      : null,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

class BookingService {
  constructor(deps = {}) {
    this.bookingRepository = deps.bookingRepository || bookingRepository;
    this.bookingValidator = deps.bookingValidator || bookingValidator;
    this.otpProvider = deps.otpProvider || otpProvider;
    this.smsProvider = deps.smsProvider || smsProvider;
    this.earningsRepository = deps.earningsRepository || new EarningsRepository();
    this.walletRepository = deps.walletRepository || new WalletRepository();
    this.walletTransactionRepository = deps.walletTransactionRepository || new WalletTransactionRepository();
  }

  /**
   * List bookings belonging to vehicles owned by the partner.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {object} [params.query]
   * @returns {Promise<object>} Bookings and pagination metadata
   */
  async getBookings({ partnerId, query = {} }) {
    const options = this.bookingValidator.validateBookingListQuery(query);

    const rows = await this.bookingRepository.findBookingsByPartnerId(partnerId, options);
    let total;
    if (rows.length > 0 && rows[0].total_count !== undefined) {
      total = Number(rows[0].total_count);
    } else {
      total = await this.bookingRepository.countBookingsByPartnerId(partnerId, options);
    }

    const totalPages = Math.ceil(total / options.limit) || 1;

    return {
      bookings: rows.map(formatBooking),
      pagination: {
        total,
        page: options.page,
        limit: options.limit,
        totalPages,
      },
    };
  }

  /**
   * Retrieve single booking details verifying partner ownership.
   *
   * @param {object} params
   * @param {string} params.bookingId
   * @param {string} params.partnerId
   * @returns {Promise<object>}
   */
  async getBookingById({ bookingId, partnerId }) {
    const validBookingId = this.bookingValidator.validateBookingId(bookingId);
    const booking = await this.bookingRepository.findBookingByIdAndPartnerId(
      validBookingId,
      partnerId,
    );

    if (!booking) {
      throw new NotFoundError('Booking not found or does not belong to partner');
    }

    if (process.env.NODE_ENV !== 'test' && (booking.commission_amount === undefined || booking.commission_amount === null || Number(booking.commission_amount) === 0)) {
      try {
        const snap = await commissionLockService.lockBookingCommission(booking);
        if (snap && typeof snap.commissionAmount === 'number') {
          booking.commission_amount = snap.commissionAmount;
          booking.commission_rate = snap.commissionRate;
          booking.gross_amount = snap.grossAmount;
          booking.partner_net_amount = snap.partnerNetAmount;
        }
      } catch {}
    }

    let existingPayments = Array.isArray(booking.payments_json) ? booking.payments_json : [];
    if (!booking.payments_json) {
      try {
        const payRes = await pool.query(
          'SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC',
          [validBookingId],
        );
        existingPayments = payRes.rows || [];
      } catch {
        // safe fallback if mock db
      }
    }

    const overtimeState = OvertimeService.calculateOvertimeState(booking, new Date(), {
      existingPayments,
    });

    return formatBooking(booking, overtimeState);
  }

  /**
   * Request/resend pickup OTP to the customer.
   *
   * @param {object} params
   * @param {string} params.bookingId
   * @param {string} params.partnerId
   * @param {string} params.userId
   * @returns {Promise<object>}
   */
  async requestPickupOtp({ bookingId, partnerId, userId }) {
    const validBookingId = this.bookingValidator.validateBookingId(bookingId);
    const booking = await this.bookingRepository.findBookingByIdAndPartnerId(
      validBookingId,
      partnerId,
    );

    if (!booking) {
      throw new NotFoundError('Booking not found or does not belong to partner');
    }

    if (booking.booking_status === 'ACTIVE') {
      throw new ConflictError('Booking is already in ACTIVE rental state');
    }

    const currBookingStatus = String(booking.booking_status || '').toUpperCase();
    const currStatus = String(booking.status || booking.legacy_status || '').toLowerCase();
    const isReadyForPickup =
      ['CONFIRMED', 'UPCOMING', 'PICKUP_SCHEDULED', 'BOOKED', 'PAYMENT_COMPLETED', 'PAID'].includes(currBookingStatus) ||
      ['confirmed', 'pickup_scheduled', 'payment_completed', 'initiated'].includes(currStatus);

    if (!isReadyForPickup) {
      throw new ConflictError(
        `Cannot request pickup OTP for booking with status: ${booking.booking_status || booking.status}`,
      );
    }

    const otp = this.otpProvider.generateOtp(4);
    const salt = this.otpProvider.generateSalt();
    const otpHash = this.otpProvider.hashOtp(otp, salt);

    await this.otpProvider.storeOtpState(validBookingId, { otpHash, salt, otp }, 900);

    await pool.transaction(async (client) => {
      await this.bookingRepository.upsertPickupVerification(
        {
          bookingId: validBookingId,
          otpHash,
          verificationReference: otp,
          isVerified: false,
          verifiedAt: null,
          verifiedBy: null,
        },
        client,
      );
    });

    await this.smsProvider.sendPickupOtp({
      phone: booking.customer_phone,
      otp,
      bookingNumber: booking.booking_reference || booking.booking_number,
    });

    auditService.logEvent({
      actorId: userId || partnerId,
      actorRole: 'PARTNER',
      action: 'BOOKING_PICKUP_OTP_DISPATCHED',
      entityType: 'BOOKING',
      entityId: validBookingId,
      metadata: {
        phoneMasked: this.smsProvider.maskPhone(booking.customer_phone),
      },
    });

    return {
      success: true,
      message: 'Pickup OTP sent to customer successfully',
    };
  }

  /**
   * Verifies customer pickup OTP and activates rental atomically.
   *
   * @param {object} params
   * @param {string} params.bookingId
   * @param {string} params.partnerId
   * @param {string} params.userId
   * @param {object} [params.payload]
   * @returns {Promise<object>}
   */
  async verifyPickupAndActivate({ bookingId, partnerId, userId, payload = {}, input }) {
    const validBookingId = this.bookingValidator.validateBookingId(bookingId);
    const validated = this.bookingValidator.validatePickupVerify(input || payload);

    return pool.transaction(async (client) => {
      const booking = await this.bookingRepository.findBookingByIdAndPartnerIdForUpdate(
        validBookingId,
        partnerId,
        client,
      );

      if (!booking) {
        throw new NotFoundError('Booking not found or does not belong to partner');
      }

      // Idempotency: If booking is already ACTIVE, return safe cached state
      if (booking.booking_status === 'ACTIVE' || booking.status === 'in_progress') {
        const existingVerif = await this.bookingRepository.findPickupVerificationByBookingId(
          validBookingId,
          client,
        );
        if (existingVerif && existingVerif.is_verified) {
          const fullBooking = await this.bookingRepository.findBookingByIdAndPartnerId(
            validBookingId,
            partnerId,
            client,
          );
          return formatBooking(fullBooking);
        }
        throw new ConflictError('Booking is already in ACTIVE status');
      }

      // Valid pickup activation starting status
      const currBookingStatus = String(booking.booking_status || '').toUpperCase();
      const currStatus = String(booking.status || booking.legacy_status || '').toLowerCase();
      const isValidStart = ['CONFIRMED', 'UPCOMING', 'PICKUP_SCHEDULED', 'BOOKED', 'PAYMENT_COMPLETED', 'PAID'].includes(currBookingStatus) ||
        ['confirmed', 'pickup_scheduled', 'payment_completed', 'initiated'].includes(currStatus);

      if (!isValidStart) {
        throw new ConflictError(
          `Cannot activate booking with current status: ${booking.booking_status || booking.status}`,
        );
      }

      // Check if scheduled return time has already passed without vehicle handover
      const scheduledReturn = booking.expected_return_at || booking.end_at;
      if (scheduledReturn && new Date(scheduledReturn).getTime() <= Date.now()) {
        throw new ConflictError(
          'Booking has expired because the scheduled return time has passed without vehicle handover',
          ERROR_CODES.CONFLICT,
        );
      }

      // Vehicle Concurrency: Check if vehicle has another simultaneous ACTIVE booking
      const conflict = await this.bookingRepository.findConflictingActiveBooking(
        booking.vehicle_id,
        validBookingId,
        client,
      );
      if (conflict) {
        throw new ConflictError(
          'Vehicle already has an active rental in progress',
          ERROR_CODES.CONFLICT,
        );
      }

      if (booking.vehicle_is_archived) {
        // Vehicle was archived but partner is fulfilling an active confirmed booking: auto-restore
        // so rental can proceed safely. Never auto-restore an ADMIN-held vehicle (is_active = false:
        // admin deactivate / archive): existing bookings are honoured, but lifting the admin hold
        // is reserved for the admin activate action. The trip itself does not depend on
        // is_archived. is_active is read schema-tolerantly (NULL/absent = not admin-held).
        await client.query(
          `UPDATE vehicles SET is_archived = false, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND COALESCE((to_jsonb(vehicles) ->> 'is_active')::boolean, true)`,
          [booking.vehicle_id],
        );
      }

      // Brute-force protection: check attempts
      const currentAttempts = await this.otpProvider.getAttempts(validBookingId);
      if (currentAttempts >= 5) {
        throw new ValidationError(
          'Maximum verification attempts exceeded. Please request a new OTP.',
          [{ field: 'otp', message: 'Maximum verification attempts exceeded' }],
          ERROR_CODES.VALIDATION_ERROR,
        );
      }

      // Retrieve OTP state: check Redis first, fallback to DB
      const redisState = await this.otpProvider.getOtpState(validBookingId);
      let isValid = false;

      if (redisState && (redisState.otpHash || redisState.otp)) {
        if (redisState.otpHash && redisState.salt) {
          isValid = this.otpProvider.verifyOtp(validated.otp, redisState.otpHash, redisState.salt);
        }
        if (!isValid && redisState.otp) {
          const candidateStr = String(validated.otp);
          const redisOtpStr = String(redisState.otp);
          if (candidateStr.length === redisOtpStr.length) {
            const bufA = Buffer.from(candidateStr);
            const bufB = Buffer.from(redisOtpStr);
            if (crypto.timingSafeEqual(bufA, bufB)) {
              isValid = true;
            }
          }
        }
      } else {
        const dbVerif = await this.bookingRepository.findPickupVerificationByBookingId(
          validBookingId,
          client,
        );
        if (dbVerif && (dbVerif.otp_hash || dbVerif.verification_reference)) {
          if (dbVerif.verification_reference && typeof dbVerif.verification_reference === 'string') {
            const candidateStr = String(validated.otp);
            const refStr = String(dbVerif.verification_reference);
            if (candidateStr.length === refStr.length) {
              const bufA = Buffer.from(candidateStr);
              const bufB = Buffer.from(refStr);
              if (crypto.timingSafeEqual(bufA, bufB)) {
                isValid = true;
              }
            }
          }
          if (!isValid && dbVerif.otp_hash) {
            const candidateHash = crypto
              .createHash('sha256')
              .update(String(validated.otp))
              .digest('hex');
            if (candidateHash === dbVerif.otp_hash) {
              isValid = true;
            } else {
              isValid = this.otpProvider.verifyOtp(validated.otp, dbVerif.otp_hash, 'salt');
            }
          }
        } else {
          throw new ValidationError(
            'Pickup OTP has not been generated or has expired. Please request a new OTP.',
            [{ field: 'otp', message: 'No active OTP found' }],
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
      }

      if (!isValid) {
        await this.otpProvider.incrementAttempts(validBookingId);
        throw new ValidationError(
          'Invalid OTP. Please check with the customer and try again.',
          [{ field: 'otp', message: 'Invalid OTP' }],
          ERROR_CODES.VALIDATION_ERROR,
        );
      }

      // OTP verified: clear Redis state
      await this.otpProvider.clearOtpState(validBookingId);

      const verifiedAt = new Date().toISOString();

      // Security Deposit collection check
      const requiredDeposit = Number(booking.security_deposit || 0);
      if (requiredDeposit > 0) {
        const isAlreadyCollected = booking.deposit_collected === true || booking.deposit_status === 'COLLECTED';
        const isVerifiedAtPickup = validated.depositCollected === true || payload.depositCollected === true;
        if (!isAlreadyCollected && !isVerifiedAtPickup) {
          throw new ValidationError(
            'Cannot complete vehicle handover: Security deposit must be collected from the customer before handover.',
            [{
              field: 'securityDeposit',
              message: 'Collect the security deposit from the customer before handing over the vehicle.',
              securityDeposit: requiredDeposit,
            }],
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
      }

      // Update pickup verification record
      let pickupNotes = validated.notes || null;
      if (requiredDeposit > 0) {
        const depositInfo = {
          amount: requiredDeposit,
          status: 'COLLECTED',
          collectedAt: verifiedAt,
          collectedBy: userId || partnerId,
        };
        if (typeof validated.notes === 'string' && validated.notes.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(validated.notes);
            pickupNotes = JSON.stringify({ ...parsed, deposit: depositInfo });
          } catch {
            pickupNotes = JSON.stringify({ partnerNotes: validated.notes, deposit: depositInfo });
          }
        } else {
          pickupNotes = JSON.stringify({ partnerNotes: validated.notes || null, deposit: depositInfo });
        }
      }

      await this.bookingRepository.upsertPickupVerification(
        {
          bookingId: validBookingId,
          isVerified: true,
          verifiedAt,
          verifiedBy: userId,
          odometerStart: validated.odometerStart,
          fuelLevelStart: validated.fuelLevelStart,
          photos: validated.photos,
          notes: pickupNotes,
        },
        client,
      );

      // Create/update canonical booking_pickup record
      if (typeof this.bookingRepository.upsertBookingPickup === 'function') {
        await this.bookingRepository.upsertBookingPickup(
          {
            bookingId: validBookingId,
            pickedUpAt: verifiedAt,
            handedOverBy: userId,
            odometerReading: validated.odometerStart,
            fuelLevel: validated.fuelLevelStart ? Number(validated.fuelLevelStart) : null,
            pickupLocation: booking.pickup_location || null,
            notes: validated.notes || null,
          },
          client,
        );
      }

      // Record booking_status_history entry
      if (typeof this.bookingRepository.recordStatusHistory === 'function') {
        await this.bookingRepository.recordStatusHistory(
          {
            bookingId: validBookingId,
            oldStatus: booking.status || 'confirmed',
            newStatus: 'in_progress',
            changedBy: userId || null,
            changeReason: 'Handover OTP verified by partner',
          },
          client,
        );
      }

      // Transition booking to ACTIVE and in_progress
      await this.bookingRepository.updateBookingStatus(validBookingId, 'ACTIVE', client);

      // Transition vehicle rental_status to ACTIVE and is_available to false
      await vehicleRepository.updateRentalStatus(booking.vehicle_id, 'ACTIVE', client);

      // Emit audit log (zero raw OTP)
      auditService.logEvent({
        actorId: userId || partnerId,
        actorRole: 'PARTNER',
        action: 'BOOKING_PICKUP_VERIFIED',
        entityType: 'BOOKING',
        entityId: validBookingId,
        metadata: {
          vehicleId: booking.vehicle_id,
          verifiedAt,
        },
      });

      const fullBooking = await this.bookingRepository.findBookingByIdAndPartnerId(
        validBookingId,
        partnerId,
        client,
      );
      return formatBooking(fullBooking);
    });
  }

  /**
   * Completes vehicle return, calculates charges, records damages, and finalizes booking.
   *
   * @param {object} params
   * @param {string} params.bookingId
   * @param {string} params.partnerId
   * @param {string} params.userId
   * @param {object} [params.payload]
   * @returns {Promise<object>}
   */
  async completeReturnAndFinalize({ bookingId, partnerId, userId, payload = {}, input }) {
    const validBookingId = this.bookingValidator.validateBookingId(bookingId);
    const validated = this.bookingValidator.validateReturnPayload(input || payload);

    return pool.transaction(async (client) => {
      const booking = await this.bookingRepository.findBookingByIdAndPartnerIdForUpdate(
        validBookingId,
        partnerId,
        client,
      );

      if (!booking) {
        throw new NotFoundError('Booking not found or does not belong to partner');
      }

      // Idempotency: If booking is already COMPLETED, return cached completion state safely
      if (booking.booking_status === 'COMPLETED') {
        const existingVerif = await this.bookingRepository.findReturnVerificationByBookingId(
          validBookingId,
          client,
        );
        if (existingVerif) {
          const fullBooking = await this.bookingRepository.findBookingByIdAndPartnerId(
            validBookingId,
            partnerId,
            client,
          );
          const damages = await this.bookingRepository.findDamageReportsByBookingId(
            validBookingId,
            client,
          );
          return {
            booking: formatBooking(fullBooking),
            returnVerification: formatReturnDetails(fullBooking, existingVerif, damages),
          };
        }
        throw new ConflictError('Booking is already in COMPLETED status');
      }

      // Valid return starting status
      if (booking.booking_status !== 'ACTIVE') {
        throw new ConflictError(
          `Cannot return booking with current status: ${booking.booking_status}`,
        );
      }

      // Odometer validation: end >= start
      const startOdo = booking.odometer_start !== null && booking.odometer_start !== undefined
        ? Number(booking.odometer_start)
        : null;
      const endOdo = validated.odometerEnd !== undefined && validated.odometerEnd !== null
        ? Number(validated.odometerEnd)
        : null;

      if (startOdo !== null && endOdo !== null) {
        if (endOdo < startOdo) {
          throw new ValidationError(
            'End odometer reading cannot be less than start odometer reading',
            [{ field: 'odometerEnd', message: 'odometerEnd must be greater than or equal to odometerStart' }],
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
      }

      const totalDistance = (startOdo !== null && endOdo !== null)
        ? Math.max(0, endOdo - startOdo)
        : null;

      // Authoritative actual return timestamp generated by backend
      const actualReturnAt = new Date();

      // Hourly rate strictly from booking pricing snapshot
      const snapshotHourlyRate = Number(booking.price_per_hour || 0);
      const lateAnalysis = calculateLateCharges({
        expectedReturnAt: booking.expected_return_at,
        actualReturnAt,
        pricePerHour: snapshotHourlyRate,
      });

      // RETURN GATE: If overtime amount is due, customer must pay before return is finalized!
      let existingPayments = [];
      try {
        existingPayments = await this.bookingRepository.findPaymentsByBookingId(validBookingId, client);
      } catch {
        existingPayments = [];
      }

      const overtimeState = OvertimeService.calculateOvertimeState(booking, actualReturnAt, {
        existingPayments,
        rateOverride: snapshotHourlyRate,
      });

      // Extra KM calculation if extra KM recorded
      const extraKm = Number(validated.extraKm || 0);
      const extraKmRate = Number(booking.extra_km_charge || 0);
      const extraKmFee = Number((extraKm * extraKmRate).toFixed(2));

      // Overtime payment reference resolution from existing online payments
      let overtimePaymentRef = null;
      if (Array.isArray(existingPayments)) {
        for (const p of existingPayments) {
          const type = String(p.payment_type || p.paymentType || '').toUpperCase();
          if (type === 'OVERTIME_CHARGE' || type === 'POST_RENTAL_SETTLEMENT') {
            const status = String(p.status || '').toLowerCase();
            if (status === 'paid' || status === 'success') {
              overtimePaymentRef = p.transaction_reference || p.gateway_payment_id || p.id || null;
            }
          }
        }
      }

      const finalOvertimeMinutes = overtimeState.overtimeDurationMinutes !== undefined
        ? overtimeState.overtimeDurationMinutes
        : lateAnalysis.lateMinutes;

      const finalOvertimeFee = overtimeState.overtimeAmount !== undefined
        ? overtimeState.overtimeAmount
        : lateAnalysis.lateFee;

      const finalBillableHours = overtimeState.billableHours !== undefined
        ? overtimeState.billableHours
        : (finalOvertimeMinutes > 15 ? Math.max(1, Math.ceil(finalOvertimeMinutes / 60)) : 0);

      // Partner Overtime Collection / Waiver Lifecycle:
      // If customer already completed online payment via gateway, it is authoritative PAID.
      // If overtime fee is due and unpaid online, Partner can choose to confirm collection (COLLECTED_BY_PARTNER)
      // or waive collection (WAIVED_BY_PARTNER). Unpaid online customer payment is NEVER falsely marked paid.
      const isOnlinePaid = overtimeState.extraPaymentStatus === 'PAID';
      let overtimePaymentStatus = 'NOT_REQUIRED';
      let overtimeCollectionDetails = null;

      if (isOnlinePaid) {
        overtimePaymentStatus = 'PAID';
        overtimeCollectionDetails = {
          status: 'PAID_ONLINE',
          method: 'ONLINE_PAYMENT',
          paidAmount: overtimeState.totalOvertimePaid || finalOvertimeFee,
          paymentReference: overtimePaymentRef,
        };
      } else if (finalOvertimeFee > 0) {
        if (validated.overtimeCollected === true) {
          overtimePaymentStatus = 'COLLECTED_BY_PARTNER';
          const collectionRef = `PARTNER_COLLECTION_${validBookingId}_${Date.now()}`;
          overtimeCollectionDetails = {
            status: 'COLLECTED_BY_PARTNER',
            method: 'DIRECT_PARTNER_COLLECTION',
            confirmedAmount: finalOvertimeFee,
            confirmedAt: actualReturnAt.toISOString(),
            confirmedBy: userId || partnerId,
            reference: collectionRef,
          };
        } else {
          overtimePaymentStatus = 'WAIVED_BY_PARTNER';
          overtimeCollectionDetails = {
            status: 'WAIVED_BY_PARTNER',
            waivedAmount: finalOvertimeFee,
            waivedAt: actualReturnAt.toISOString(),
            waivedBy: userId || partnerId,
            reference: null,
          };
        }
      }

      const finalOvertimeData = {
        scheduledReturnAt: booking.expected_return_at || booking.end_at || null,
        actualReturnAt: actualReturnAt.toISOString(),
        overtimeDurationMinutes: finalOvertimeMinutes,
        gracePeriodMinutes: 15,
        billableHours: finalBillableHours,
        hourlyRate: snapshotHourlyRate,
        overtimeAmount: finalOvertimeFee,
        overtimePaymentStatus,
        paymentReference: isOnlinePaid ? overtimePaymentRef : (overtimeCollectionDetails?.reference || null),
        confirmedAmount: overtimePaymentStatus === 'COLLECTED_BY_PARTNER' ? finalOvertimeFee : (isOnlinePaid ? finalOvertimeFee : 0),
        confirmedAt: overtimePaymentStatus === 'COLLECTED_BY_PARTNER' ? actualReturnAt.toISOString() : null,
        waivedAmount: overtimePaymentStatus === 'WAIVED_BY_PARTNER' ? finalOvertimeFee : 0,
        waivedAt: overtimePaymentStatus === 'WAIVED_BY_PARTNER' ? actualReturnAt.toISOString() : null,
        collectionDetails: overtimeCollectionDetails,
      };

      const returnDeposit = Number(booking.security_deposit || 0);
      const isDepositReturned = validated.depositReturned === true;
      const notesPayload = {
        partnerNotes: validated.notes || null,
        overtime: finalOvertimeData,
        deposit: returnDeposit > 0 ? {
          amount: returnDeposit,
          status: isDepositReturned ? 'RETURNED' : 'PENDING_RETURN',
          returnedAt: isDepositReturned ? actualReturnAt.toISOString() : null,
          returnedBy: userId || partnerId,
        } : null,
      };
      const serializedNotes = JSON.stringify(notesPayload);

      // Record return verification
      const returnVerification = await this.bookingRepository.upsertReturnVerification(
        {
          bookingId: validBookingId,
          returnedAt: actualReturnAt.toISOString(),
          odometerEnd: endOdo,
          fuelLevelEnd: validated.fuelLevelEnd || null,
          lateMinutes: finalOvertimeMinutes,
          lateFee: finalOvertimeFee,
          extraKm,
          extraKmFee,
          totalDistance,
          returnStatus: finalOvertimeMinutes > 15 ? 'LATE' : 'ON_TIME',
          notes: serializedNotes,
          photos: validated.photos || null,
          verifiedBy: userId || null,
        },
        client,
      );

      // Record damage report if provided
      let createdDamage = null;
      if (validated.damageReport) {
        createdDamage = await this.bookingRepository.createDamageReport(
          {
            bookingId: validBookingId,
            vehicleId: booking.vehicle_id,
            reportedBy: userId || partnerId,
            damageType: validated.damageReport.damageType,
            description: validated.damageReport.description,
            estimatedAmount: validated.damageReport.estimatedAmount,
            photos: validated.damageReport.photos,
            status: 'REPORTED',
          },
          client,
        );

        auditService.logEvent({
          actorId: userId || partnerId,
          actorRole: 'PARTNER',
          action: 'DAMAGE_REPORT_CREATED',
          entityType: 'DAMAGE_REPORT',
          entityId: createdDamage.id,
          metadata: {
            bookingId: validBookingId,
            vehicleId: booking.vehicle_id,
            damageType: validated.damageReport.damageType,
            estimatedAmount: validated.damageReport.estimatedAmount,
          },
        });
      }

      // Update pricing snapshot charges
      await this.bookingRepository.updatePricingSnapshotCharges(
        validBookingId,
        {
          lateFee: lateAnalysis.lateFee,
          extraKmFee,
        },
        client,
      );

      // Record booking_status_history for completion
      if (typeof this.bookingRepository.recordStatusHistory === 'function') {
        let overtimeReasonSuffix = '';
        if (finalOvertimeFee > 0) {
          if (overtimePaymentStatus === 'COLLECTED_BY_PARTNER') {
            overtimeReasonSuffix = ` Overtime: ₹${finalOvertimeFee} confirmed collected by partner.`;
          } else if (overtimePaymentStatus === 'WAIVED_BY_PARTNER') {
            overtimeReasonSuffix = ` Overtime: ₹${finalOvertimeFee} waived by partner.`;
          } else if (overtimePaymentStatus === 'PAID') {
            overtimeReasonSuffix = ` Overtime: ₹${finalOvertimeFee} paid online.`;
          }
        }
        await this.bookingRepository.recordStatusHistory(
          {
            bookingId: validBookingId,
            oldStatus: booking.status || 'in_progress',
            newStatus: 'completed',
            changedBy: userId || null,
            changeReason: `Vehicle return inspection finalized by partner.${overtimeReasonSuffix}`,
          },
          client,
        );
      }

      // Transition booking status to COMPLETED
      await this.bookingRepository.updateBookingStatus(validBookingId, 'COMPLETED', client);

      // Transition vehicle rental_status to IDLE (preserving manual_status)
      await vehicleRepository.updateRentalStatus(booking.vehicle_id, 'IDLE', client);

      // Upsert synchronized partner earnings record with locked commission snapshot
      const targetPartnerId = booking.partner_id || partnerId;
      const baseGross = Number(booking.total_customer_amount || booking.total_amount || 0);
      const effectiveLateFee = overtimePaymentStatus === 'WAIVED_BY_PARTNER' ? 0 : Number(lateAnalysis.lateFee || 0);
      const extraFees = effectiveLateFee + Number(extraKmFee || 0);
      const grossAmount = baseGross + extraFees;

      let partnerNetAmount = grossAmount;
      let commissionAmount = 0;
      // Best-effort commission snapshot under a savepoint, so a failure here cannot abort
      // the surrounding return-completion transaction.
      let commissionSavepoint = false;
      try {
        await client.query('SAVEPOINT return_commission_lock');
        commissionSavepoint = true;
      } catch (_) {
        commissionSavepoint = false;
      }
      try {
        const snap = await commissionLockService.lockBookingCommission(validBookingId, client);
        if (snap && typeof snap.commissionAmount === 'number') {
          commissionAmount = snap.commissionAmount;
          partnerNetAmount = Math.max(0, grossAmount - commissionAmount);
        }
        if (commissionSavepoint) await client.query('RELEASE SAVEPOINT return_commission_lock');
      } catch (_) {
        if (commissionSavepoint) await client.query('ROLLBACK TO SAVEPOINT return_commission_lock');
      }

      if (this.earningsRepository && typeof this.earningsRepository.upsertBookingEarning === 'function') {
        await this.earningsRepository.upsertBookingEarning({
          bookingId: validBookingId,
          partnerId: targetPartnerId,
          grossAmount,
          commissionAmount,
          partnerNetAmount,
          settlementStatus: 'SETTLED',
          settledAt: actualReturnAt.toISOString(),
        }, client);
      }

      // Atomically credit partner wallet and append ledger entry
      if (grossAmount > 0 && this.walletRepository && typeof this.walletRepository.creditWallet === 'function') {
        try {
          let wallet = await this.walletRepository.findByPartnerId(targetPartnerId, client);
          if (!wallet && typeof this.walletRepository.createWallet === 'function') {
            wallet = await this.walletRepository.createWallet(targetPartnerId, client);
          }
          if (wallet) {
            const creditRes = await this.walletRepository.creditWallet(targetPartnerId, grossAmount, client);
            if (this.walletTransactionRepository && typeof this.walletTransactionRepository.createLedgerEntry === 'function') {
              await this.walletTransactionRepository.createLedgerEntry({
                walletId: wallet.id,
                partnerId: targetPartnerId,
                transactionType: 'SETTLEMENT_PAYMENT',
                direction: 'CREDIT',
                amount: grossAmount,
                balanceAfter: creditRes ? creditRes.newAvailable : Number((Number(wallet.available_balance || 0) + grossAmount).toFixed(2)),
                referenceType: 'BOOKING',
                referenceId: validBookingId,
                status: 'COMPLETED',
                description: `Rental earnings for booking #${booking.booking_reference || booking.booking_number}`,
                metadata: {
                  bookingId: validBookingId,
                  grossAmount,
                  lateFee: Number(lateAnalysis.lateFee || 0),
                  extraKmFee: Number(extraKmFee || 0),
                },
              }, client);
            }
          }
        } catch {}
      }

      // Audit event
      auditService.logEvent({
        actorId: userId || partnerId,
        actorRole: 'PARTNER',
        action: 'BOOKING_RETURN_COMPLETED',
        entityType: 'BOOKING',
        entityId: validBookingId,
        metadata: {
          vehicleId: booking.vehicle_id,
          returnedAt: actualReturnAt.toISOString(),
          expectedReturnAt: booking.expected_return_at,
          lateMinutes: lateAnalysis.lateMinutes,
          lateFee: lateAnalysis.lateFee,
          billableHours: lateAnalysis.billableHours,
          returnStatus: lateAnalysis.returnStatus,
          odometerStart: startOdo,
          odometerEnd: endOdo,
          totalDistance,
          extraKm,
          extraKmFee,
          damageReported: Boolean(validated.damageReport),
        },
      });

      const fullBooking = await this.bookingRepository.findBookingByIdAndPartnerId(
        validBookingId,
        partnerId,
        client,
      );
      const damages = await this.bookingRepository.findDamageReportsByBookingId(
        validBookingId,
        client,
      );

      return {
        booking: formatBooking(fullBooking),
        returnVerification: formatReturnDetails(fullBooking, returnVerification, damages),
      };
    });
  }

  /**
   * Retrieves return verification details and billing summary for a booking.
   *
   * @param {object} params
   * @param {string} params.bookingId
   * @param {string} params.partnerId
   * @returns {Promise<object>}
   */
  async getReturnDetails({ bookingId, partnerId }) {
    const validBookingId = this.bookingValidator.validateBookingId(bookingId);
    const booking = await this.bookingRepository.findBookingByIdAndPartnerId(
      validBookingId,
      partnerId,
    );

    if (!booking) {
      throw new NotFoundError('Booking not found or does not belong to partner');
    }

    const [returnVerif, damages] = await Promise.all([
      this.bookingRepository.findReturnVerificationByBookingId(validBookingId),
      this.bookingRepository.findDamageReportsByBookingId(validBookingId),
    ]);

    if (!returnVerif) {
      throw new NotFoundError('Return verification not found for this booking');
    }

    return formatReturnDetails(booking, returnVerif, damages);
  }

  /**
   * Reports damage for an active or completed booking.
   *
   * @param {object} params
   * @param {string} params.bookingId
   * @param {string} params.partnerId
   * @param {string} params.userId
   * @param {object} [params.payload]
   * @returns {Promise<object>}
   */
  async reportDamage({ bookingId, partnerId, userId, payload = {} }) {
    const validBookingId = this.bookingValidator.validateBookingId(bookingId);
    const validated = this.bookingValidator.validateDamageReportPayload(payload);

    return pool.transaction(async (client) => {
      const booking = await this.bookingRepository.findBookingByIdAndPartnerIdForUpdate(
        validBookingId,
        partnerId,
        client,
      );

      if (!booking) {
        throw new NotFoundError('Booking not found or does not belong to partner');
      }

      const damageReport = await this.bookingRepository.createDamageReport(
        {
          bookingId: validBookingId,
          vehicleId: booking.vehicle_id,
          reportedBy: userId || partnerId,
          damageType: validated.damageType,
          description: validated.description,
          estimatedAmount: validated.estimatedAmount,
          photos: validated.photos,
          status: 'REPORTED',
        },
        client,
      );

      auditService.logEvent({
        actorId: userId || partnerId,
        actorRole: 'PARTNER',
        action: 'DAMAGE_REPORT_CREATED',
        entityType: 'DAMAGE_REPORT',
        entityId: damageReport.id,
        metadata: {
          bookingId: validBookingId,
          vehicleId: booking.vehicle_id,
          damageType: validated.damageType,
          estimatedAmount: validated.estimatedAmount,
        },
      });

      return {
        id: damageReport.id,
        bookingId: damageReport.booking_id,
        vehicleId: damageReport.vehicle_id,
        damageType: damageReport.damage_type,
        description: damageReport.description,
        estimatedAmount: Number(damageReport.estimated_amount || 0),
        status: damageReport.status,
        photos: damageReport.photos || [],
        createdAt: damageReport.created_at,
      };
    });
  }

  /**
   * Retrieves damage reports for a booking.
   *
   * @param {object} params
   * @param {string} params.bookingId
   * @param {string} params.partnerId
   * @returns {Promise<Array<object>>}
   */
  async getDamageReports({ bookingId, partnerId }) {
    const validBookingId = this.bookingValidator.validateBookingId(bookingId);
    const booking = await this.bookingRepository.findBookingByIdAndPartnerId(
      validBookingId,
      partnerId,
    );

    if (!booking) {
      throw new NotFoundError('Booking not found or does not belong to partner');
    }

    const reports = await this.bookingRepository.findDamageReportsByBookingId(validBookingId);
    return (reports || []).map((d) => {
      const appAmt = d.approved_amount !== null && d.approved_amount !== undefined
        ? Number(d.approved_amount)
        : null;
      return {
        id: d.id,
        bookingId: d.booking_id,
        vehicleId: d.vehicle_id,
        damageType: d.damage_type,
        description: d.description,
        estimatedAmount: Number(d.estimated_amount || 0),
        approvedAmount: appAmt,
        status: d.status,
        photos: d.photos || [],
        createdAt: d.created_at,
      };
    });
  }
}

const bookingServiceInstance = new BookingService();
bookingServiceInstance.calculateLateCharges = calculateLateCharges;
bookingServiceInstance.formatReturnDetails = formatReturnDetails;
bookingServiceInstance.formatBooking = formatBooking;

module.exports = bookingServiceInstance;
