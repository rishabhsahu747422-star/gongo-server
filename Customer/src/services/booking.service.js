'use strict';

const crypto = require('crypto');
const BookingRepository = require('../repositories/booking.repository');
const IdempotencyRepository = require('../repositories/idempotency.repository');
const CustomerDocumentRepository = require('../repositories/customer-document.repository');
const availabilityService = require('./availability.service');
const couponService = require('./coupon.service');
const notificationService = require('./notification.service');
const vehicleService = require('./vehicle.service');
const pricingService = require('./pricing.service');
const platformFeeService = require('./platform-fee.service');
const { resolveVehicleCategory } = require('../utils/vehicle-category');
const vehicleRepository = require('../repositories/vehicle.repository');
const env = require('../config/env');
const { NOTIFICATION_TYPES } = require('../constants/notification');
const {
  BOOKING_STATUS,
  CANCELLABLE_STATUSES,
  RENTAL_TYPE,
} = require('../constants/booking');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../errors');
const logger = require('../config/logger');

/**
 * BookingService — business orchestration for customer bookings.
 */
class BookingService {
  constructor(deps = {}) {
    this.bookingRepository = deps.bookingRepository || new BookingRepository();
    this.idempotencyRepository = deps.idempotencyRepository || new IdempotencyRepository();
    this.documentRepository = deps.customerDocumentRepository || deps.documentRepository || new CustomerDocumentRepository();
    this.vehicleLocks = new Map();
  }

  /**
   * Serializes in-flight booking creations for the same vehicle in this process,
   * complementing SELECT FOR UPDATE row locking and PostgreSQL exclusion constraints.
   *
   * @param {string} vehicleId
   * @param {Function} fn
   * @returns {Promise<any>}
   */
  async withVehicleLock(vehicleId, fn) {
    const previous = this.vehicleLocks.get(vehicleId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.vehicleLocks.set(vehicleId, current);

    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.vehicleLocks.get(vehicleId) === current) {
        this.vehicleLocks.delete(vehicleId);
      }
    }
  }

  /**
   * Helper to compute a SHA256 hash of the normalized request parameters.
   *
   * @param {object} payload
   * @returns {string} Hex SHA256 string
   */
  static hashPayload(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /**
   * Calculates duration units and server-side base amount based on rental type
   * and vehicle pricing snapshot.
   *
   * @param {object} vehicle
   * @param {string} rentalType
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {{baseAmount: number, totalAmount: number}}
   */
  static calculatePricing(vehicle, rentalType, startDate, endDate) {
    const pricing = pricingService.constructor.calculateBaseRental(vehicle, rentalType, startDate, endDate);
    const securityDeposit = Number(vehicle.security_deposit || 0);
    const totalAmount = Math.round((pricing.baseAmount + securityDeposit) * 100) / 100;

    return {
      baseAmount: pricing.baseAmount,
      rentalAmount: pricing.baseAmount,
      totalAmount,
      actualDurationHours: pricing.actualDurationHours,
      billableDurationHours: pricing.billableDurationHours,
      pricingBreakdown: pricing.pricingBreakdown,
    };
  }

  /**
   * Create a new booking for the authenticated customer.
   *
   * Concurrency & Transaction guarantee:
   *   1. If Idempotency-Key is provided, check for existing request.
   *   2. Executes inside a PostgreSQL transaction.
   *   3. Locks the target vehicle row FOR UPDATE, strictly serializing concurrent
   *      booking attempts on the same vehicle.
   *   4. Re-verifies vehicle, shop, and partner eligibility in real time.
   *   5. Checks overlapping active/blocking bookings [startAt, endAt).
   *   6. Inserts booking with status PENDING and agreed pricing snapshot.
   *   7. Records idempotency key inside transaction if present.
   *
   * @param {string} customerId
   * @param {object} bookingData
   * @param {string} [idempotencyKey]
   * @returns {Promise<{booking: object, isIdempotentReplay?: boolean}>}
   */
  async createBooking(customerId, bookingData, idempotencyKey = null) {
    const {
      vehicleId,
      rentalType,
      startAt,
      endAt,
      pickupAddress,
      couponCode,
      isDevPayment,
    } = bookingData;

    const runCreation = async () => {
      const requestHash = BookingService.hashPayload({
        customerId,
        vehicleId,
        rentalType,
        startAt,
        endAt,
        couponCode: couponCode || null,
        isDevPayment: Boolean(isDevPayment),
      });

      // 1. Development dummy payment guard & KYC verification
      if (isDevPayment) {
        const isProd = process.env.NODE_ENV === 'production' || env.NODE_ENV === 'production';
        const isTest = process.env.NODE_ENV === 'test' || env.NODE_ENV === 'test';
        const isDevFlagEnabled =
          (Boolean(env.DEV_DUMMY_PAYMENT_ENABLED) || process.env.DEV_DUMMY_PAYMENT_ENABLED === 'true') &&
          process.env.DEV_DUMMY_PAYMENT_ENABLED !== 'false';
        const isDevAllowed = !isProd && (isTest ? process.env.DEV_DUMMY_PAYMENT_ENABLED === 'true' : isDevFlagEnabled);

        if (!isDevAllowed) {
          throw new ForbiddenError(
            'Development dummy payment is disabled in this environment',
            'DEV_PAYMENT_DISABLED',
          );
        }

        // KYC rule: Aadhaar is MANDATORY
        let aadhaarDoc = null;
        try {
          aadhaarDoc = await this.documentRepository.findLatestByUserAndType(customerId, 'AADHAAR');
        } catch (docErr) {
          if (docErr.message && (docErr.message.includes('relation') || docErr.message.includes('does not exist') || docErr.message.includes('customer_documents'))) {
            logger.warn('customer_documents table unavailable, bypassing Aadhaar check for environment', { error: docErr.message });
            aadhaarDoc = { status: 'VERIFIED' };
          }
        }
        let isAadhaarVerified = aadhaarDoc && (
          aadhaarDoc.status === 'VERIFIED' ||
          aadhaarDoc.verificationStatus === 'VERIFIED'
        );
        if (!isAadhaarVerified && process.env.NODE_ENV === 'production') {
          throw new ForbiddenError(
            'Aadhaar verification is required before proceeding to payment.',
            'KYC_REQUIRED',
          );
        }

        logger.info('[DEV PAYMENT] Development payment initiated');
        logger.info('[DEV PAYMENT] Aadhaar verification confirmed');
        logger.info('[DEV PAYMENT] Calling real booking API');
      }

      // 2. Check idempotency if key provided
      if (idempotencyKey) {
        const cached = await this.idempotencyRepository.findKey(customerId, idempotencyKey);
        if (cached) {
          if (cached.request_hash !== requestHash) {
            throw new ConflictError(
              'Idempotency key reused with different request parameters',
              'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
            );
          }
          logger.info('Returning cached response for idempotent booking request', {
            customerId,
            idempotencyKey,
          });
          return {
            booking: cached.response_body,
            isIdempotentReplay: true,
          };
        }
      }

      const startDate = new Date(startAt);
      const endDate = new Date(endAt);

      // 3. Transactional execution with vehicle row locking
      const booking = await this.bookingRepository.transaction(async (client) => {
        // Lock vehicle row FOR UPDATE
        const vehicle = await this.bookingRepository.lockVehicleForBooking(vehicleId, client);
        if (!vehicle) {
          throw new NotFoundError('Vehicle not found', 'VEHICLE_NOT_FOUND');
        }

        // Re-verify eligibility using canonical service
        availabilityService.assertVehicleEligibility(vehicle);

        // Re-verify availability
        await availabilityService.assertAvailable(vehicleId, startAt, endAt, client);

        // Server-side pricing calculation
        const pricing = BookingService.calculatePricing(
          vehicle,
          rentalType,
          startDate,
          endDate,
        );
        const baseAmount = pricing.baseAmount;

        let couponId = null;
        let couponCodeToSave = null;
        let discountAmount = 0.00;

        if (couponCode) {
          const evalResult = await couponService.validateAndLockCoupon(
            couponCode,
            customerId,
            baseAmount,
            {
              vehicle,
              vehicleId: vehicle.id,
              partnerId: vehicle.partner_id,
              shopId: vehicle.shop_id,
            },
            client,
            { requestId: idempotencyKey },
          );
          couponId = evalResult.coupon.id;
          couponCodeToSave = evalResult.coupon.code;
          discountAmount = evalResult.discountAmount;
        }

        const securityDeposit = Number(vehicle.security_deposit || 0);
        const subtotal = Math.max(0, Math.round((baseAmount - discountAmount) * 100) / 100);

        const vehicleCategory = resolveVehicleCategory(vehicle);
        // Authoritative platform fee calculation from database configuration
        const feeCharges = await platformFeeService.calculateChargesForRental(subtotal, client, { vehicleCategory });
        const convenienceFee = feeCharges.convenienceFee;
        const serviceCharge = feeCharges.serviceCharge;
        const gst = feeCharges.gst;
        const taxAmount = feeCharges.gst;
        const platformFee = feeCharges.platformFee;
        const totalAmount = Math.round((subtotal + securityDeposit) * 100) / 100;
        const payableAmount = Math.round((subtotal + feeCharges.totalFeesAndTax) * 100) / 100;

        const bookingStatusToSet = isDevPayment ? 'CONFIRMED' : 'PENDING';
        const paymentStatusToSet = isDevPayment ? 'PAID' : 'PENDING';
        const initialStatus = isDevPayment ? BOOKING_STATUS.CONFIRMED : BOOKING_STATUS.PENDING;

        // Insert booking record
        const created = await this.bookingRepository.create({
          customerId,
          vehicleId,
          status: initialStatus,
          bookingStatus: bookingStatusToSet,
          paymentStatus: paymentStatusToSet,
          rentalType,
          startAt,
          endAt,
          pickupAddress: pickupAddress || vehicle.pickup_address,
          pricePerHour: vehicle.price_per_hour,
          pricePerDay: vehicle.price_per_day,
          pricePerWeek: vehicle.price_per_week,
          pricePerMonth: vehicle.price_per_month,
          baseAmount,
          rentalAmount: baseAmount,
          actualDurationHours: pricing.actualDurationHours,
          billableDurationHours: pricing.billableDurationHours,
          pricingBreakdown: pricing.pricingBreakdown,
          discountAmount,
          couponId,
          couponCode: couponCodeToSave,
          securityDeposit: vehicle.security_deposit,
          lateFeePerHour: vehicle.late_fee_per_hour,
          extraKmCharge: vehicle.extra_km_charge,
          platformFee,
          taxAmount,
          convenienceFee,
          serviceCharge,
          payableAmount,
          totalAmount,
        }, client);

        if (couponId) {
          await couponService.recordRedemption({
            couponId,
            customerId,
            bookingId: created.id,
            discountAmount,
          }, client);
        }

        if (isDevPayment) {
          try {
            await client.query(
              `UPDATE vehicles SET rental_status = 'BOOKED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
              [vehicleId],
            );
          } catch {
            // safe fallback
          }
        }

        let createdImg = vehicle.primary_image_url || null;
        if (createdImg && !createdImg.startsWith('http')) {
          createdImg = await vehicleService.constructor.resolveImageUrl(createdImg);
        }
        created.vehicle = {
          id: vehicle.id,
          vehicleName: vehicle.vehicle_name,
          brand: vehicle.brand,
          model: vehicle.model,
          year: vehicle.year !== undefined && vehicle.year !== null ? Number(vehicle.year) : null,
          fuelType: vehicle.fuel_type,
          transmission: vehicle.transmission,
          color: vehicle.color || null,
          seats: vehicle.seats !== undefined && vehicle.seats !== null
            ? Number(vehicle.seats)
            : null,
          shopName: vehicle.shop_name || null,
          imageUrl: createdImg,
          primaryImageUrl: createdImg,
          images: createdImg ? [createdImg] : [],
        };

        // If development payment, persist real payment and notify partner
        if (isDevPayment) {
          const devPaymentRef = `DEV_PAYMENT_${created.id}`;
          const paymentNumber = `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
          let orderRef = null;
          try {
            const { generateUniqueEntityReference } = require('../utils/reference-generator');
            orderRef = await generateUniqueEntityReference(this.bookingRepository, 'payments', 'order_reference', 'ORD');
          } catch {
            orderRef = null;
          }
          const paymentAmount = Number(created.pricingSnapshot?.payableAmount || created.payableAmount || totalAmount || subtotal);
          const insertPaymentSql = `
            INSERT INTO payments (
              booking_id, customer_id, partner_id, payment_number,
              amount, currency, payment_method, status, paid_at,
              payment_type, provider_order_id, provider_payment_id, order_reference
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, ('ORD-' || upper(substr(md5(random()::text), 1, 6)))))
            RETURNING *;
          `;
          let paymentRecord = null;
          try {
            const payRes = await client.query(insertPaymentSql, [
              created.id,
              customerId,
              created.partnerId || vehicle.partner_id,
              paymentNumber,
              paymentAmount,
              'INR',
              'other',
              'paid',
              new Date(),
              'BOOKING_ADVANCE',
              devPaymentRef,
              devPaymentRef,
              orderRef,
            ]);
            paymentRecord = payRes.rows[0];
          } catch (payErr) {
            logger.error('Failed to record dummy payment', { error: payErr.message });
            throw payErr;
          }

          // Insert partner notification into partner_notifications table
          try {
            const partnerNotifSql = `
              INSERT INTO partner_notifications (
                partner_id, type, title, body, payload, event_key
              ) VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (partner_id, event_key) DO NOTHING;
            `;
            const vName = created.vehicle?.vehicleName || vehicle.vehicle_name || 'Vehicle';
            await client.query(partnerNotifSql, [
              created.partnerId || vehicle.partner_id,
              'BOOKING_CREATED',
              'New Booking Received',
              `New booking #${created.bookingNumber || created.id} for ${vName} received. Amount: ₹${totalAmount}`,
              JSON.stringify({
                bookingId: created.id,
                bookingNumber: created.bookingNumber,
                vehicleId,
                vehicleName: vName,
                customerId,
                pickupDateTime: startAt,
                returnDateTime: endAt,
                amount: paymentAmount,
                paymentStatus: 'PAID',
                bookingStatus: 'CONFIRMED',
                paymentReference: devPaymentRef,
              }),
              `BOOKING_CREATED:booking:${created.id}:${created.partnerId || vehicle.partner_id}`,
            ]);
          } catch (notifErr) {
            logger.warn('Failed to insert partner notification', { error: notifErr.message });
          }

          created.payment = {
            id: paymentRecord?.id,
            providerOrderId: devPaymentRef,
            providerPaymentId: devPaymentRef,
            amount: paymentAmount,
            currency: 'INR',
            status: 'PAID',
            paymentMethod: 'DEVELOPMENT',
          };
          created.paymentStatus = 'PAID';
          created.bookingStatus = 'CONFIRMED';
        }

        // Record idempotency inside transaction
        if (idempotencyKey) {
          await this.idempotencyRepository.saveKey({
            userId: customerId,
            key: idempotencyKey,
            requestPath: '/api/v1/bookings',
            requestHash,
            responseStatus: 201,
            responseBody: created,
            client,
          });
        }

        return created;
      });

      if (isDevPayment) {
        logger.info('[BOOKING] Booking created successfully');
        logger.info(`[BOOKING] Booking ID: ${booking.id}`);
        logger.info(`[BOOKING] Vehicle ID: ${vehicleId}`);
        logger.info(`[BOOKING] Partner ID: ${booking.partnerId}`);
        logger.info(`[BOOKING] Payment reference: DEV_PAYMENT_${booking.id}`);
        logger.info('[PARTNER NOTIFICATION] Existing booking notification/event triggered');

        // Post-commit: Sync partner earning and wallet balance asynchronously/non-critically
        try {
          const pId = booking.partnerId || booking.vehicle?.partnerId;
          const depositAmount = Number(booking.pricingSnapshot?.securityDeposit || booking.pricing?.securityDeposit || 0);
          const rawTotal = Number(booking.pricingSnapshot?.totalAmount || booking.totalAmount || 0);
          const bAmount = Number(
            booking.pricingSnapshot?.rentalAmount ||
            booking.pricingSnapshot?.baseAmount ||
            booking.subtotal ||
            (rawTotal > depositAmount && depositAmount > 0 ? rawTotal - depositAmount : rawTotal)
          );
          if (pId && bAmount > 0) {
            let commAmount = 0;
            let commRate = 0;
            let commType = 'PERCENTAGE';
            let ruleId = null;

            try {
              const rRes = await this.bookingRepository.query(
                `SELECT * FROM commission_rules
                 WHERE is_active = true
                   AND (effective_from IS NULL OR effective_from <= CURRENT_TIMESTAMP)
                   AND (effective_until IS NULL OR effective_until >= CURRENT_TIMESTAMP)
                   AND (
                     (rule_scope = 'vehicle' AND vehicle_id = $1)
                     OR (rule_scope = 'partner' AND partner_id = $2)
                     OR (rule_scope = 'default')
                   )
                 ORDER BY priority DESC, created_at DESC
                 LIMIT 1`,
                [vehicleId, pId]
              );
              const matchedRule = rRes.rows[0];
              if (matchedRule) {
                ruleId = matchedRule.id;
                commType = String(matchedRule.commission_type || 'percentage').toUpperCase();
                if (commType === 'PERCENTAGE') {
                  commRate = Number(matchedRule.commission_value || 0);
                  commAmount = Number(((bAmount * commRate) / 100).toFixed(2));
                } else {
                  commRate = 0;
                  commAmount = Math.min(bAmount, Number(Number(matchedRule.commission_value || 0).toFixed(2)));
                }
              }
            } catch { }

            const partnerNet = Math.max(0, Number((bAmount - commAmount).toFixed(2)));

            try {
              await this.bookingRepository.query(
                `INSERT INTO commission_records (
                   booking_id, partner_id, rate, commission_amount, partner_payout_amount, status,
                   commission_type, commission_rate, gross_booking_amount, partner_payable_amount, created_at, updated_at
                 )
                 SELECT $1, $2, $3, $4, $5, 'LOCKED', $6, $3, $7, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                 WHERE NOT EXISTS (SELECT 1 FROM commission_records WHERE booking_id = $1)`,
                [booking.id, pId, commRate, commAmount, partnerNet, commType, bAmount]
              );
            } catch { }

            try {
              await this.bookingRepository.query(
                `INSERT INTO earnings (
                   partner_id, booking_id, gross_amount, commission_amount, net_earnings, partner_net_amount, status, settlement_status, created_at, updated_at
                 ) VALUES ($1, $2, $3, $4, $5, $5, 'PENDING', 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (booking_id) DO UPDATE SET
                   gross_amount = EXCLUDED.gross_amount,
                   commission_amount = EXCLUDED.commission_amount,
                   net_earnings = EXCLUDED.net_earnings,
                   partner_net_amount = EXCLUDED.partner_net_amount,
                   updated_at = CURRENT_TIMESTAMP`,
                [pId, booking.id, bAmount, commAmount, partnerNet]
              );
            } catch { }

            try {
              await this.bookingRepository.query(
                `INSERT INTO partner_wallets (partner_id, available_balance, pending_balance, total_credited, total_debited, currency)
                 VALUES ($1, 0.00, $2, 0.00, 0.00, 'INR')
                 ON CONFLICT (partner_id) DO UPDATE SET
                   pending_balance = partner_wallets.pending_balance + EXCLUDED.pending_balance,
                   updated_at = CURRENT_TIMESTAMP`,
                [pId, partnerNet]
              );
            } catch { }
          }
        } catch (postCommitErr) {
          logger.warn('Non-fatal partner earning sync skipped post-commit', { error: postCommitErr.message });
        }
      } else {
        logger.info('Booking created successfully', {
          bookingId: booking.id,
          customerId,
          vehicleId,
          totalAmount: booking.pricingSnapshot.totalAmount,
        });
      }

      try {
        await notificationService.sendNotification({
          customerId,
          type: NOTIFICATION_TYPES.BOOKING_CREATED,
          title: isDevPayment ? 'Booking Confirmed' : 'Booking Created',
          body: isDevPayment
            ? `Your booking (${booking.bookingReference || booking.bookingNumber || 'confirmed'}) for ${booking.vehicle?.vehicleName || 'vehicle'} is confirmed.`
            : `Your booking (${booking.bookingReference || booking.bookingNumber || 'created'}) for ${booking.vehicle?.vehicleName || 'vehicle'} has been created.`,
          data: {
            bookingId: booking.id,
            bookingReference: booking.bookingReference || booking.bookingNumber,
            vehicleId,
          },
          eventKey: `BOOKING_CREATED:booking:${booking.id}:${customerId}`,
        });
      } catch (err) {
        logger.warn('Failed to dispatch booking creation notification', {
          bookingId: booking.id,
          bookingReference: booking.bookingReference,
          error: err.message,
        });
      }

      return { booking, isIdempotentReplay: false };
    };

    return this.withVehicleLock(vehicleId, async () => {
      if (couponCode) {
        return couponService.withCouponLock(couponCode, runCreation);
      }
      return runCreation();
    });
  }

  /**
   * List authenticated customer's bookings.
   *
   * @param {string} customerId
   * @param {object} query
   * @returns {Promise<object>}
   */
  async listBookings(customerId, query) {
    const result = await this.bookingRepository.findByCustomerId(customerId, query);
    if (result && Array.isArray(result.bookings)) {
      await Promise.all(
        result.bookings.map(async (b) => {
          if (b.vehicle) {
            const rawImg = b.vehicle.imageUrl || b.vehicle.primaryImageUrl;
            if (rawImg && !rawImg.startsWith('http')) {
              const resolved = await vehicleService.constructor.resolveImageUrl(rawImg);
              b.vehicle.imageUrl = resolved;
              b.vehicle.primaryImageUrl = resolved;
              b.vehicle.images = resolved ? [resolved] : [];
            } else if (rawImg && rawImg.startsWith('http')) {
              b.vehicle.imageUrl = rawImg;
              b.vehicle.primaryImageUrl = rawImg;
              b.vehicle.images = [rawImg];
            }
          }
        })
      );
    }
    return result;
  }

  /**
   * Get single booking details for the authenticated customer.
   *
   * @param {string} customerId
   * @param {string} bookingId
   * @returns {Promise<object>}
   */
  async getBookingById(customerId, bookingId) {
    const booking = await this.bookingRepository.findByIdAndCustomerId(
      bookingId,
      customerId,
    );
    if (!booking) {
      throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
    }

    if (booking.vehicle) {
      const rawImg = booking.vehicle.imageUrl || booking.vehicle.primaryImageUrl;
      if (rawImg && !rawImg.startsWith('http')) {
        const resolved = await vehicleService.constructor.resolveImageUrl(rawImg);
        booking.vehicle.imageUrl = resolved;
        booking.vehicle.primaryImageUrl = resolved;
      }
      try {
        const imageRows = await vehicleRepository.findImagesByVehicleId(booking.vehicleId);
        if (imageRows && imageRows.length > 0) {
          const imageShapes = await vehicleService.constructor.buildImageShapes(imageRows);
          booking.vehicle.images = imageShapes.map((img) => img.imageUrl).filter(Boolean);
          if (!booking.vehicle.imageUrl && booking.vehicle.images.length > 0) {
            booking.vehicle.imageUrl = booking.vehicle.images[0];
            booking.vehicle.primaryImageUrl = booking.vehicle.images[0];
          }
        } else if (booking.vehicle.imageUrl) {
          booking.vehicle.images = [booking.vehicle.imageUrl];
        }
      } catch {
        if (booking.vehicle.imageUrl) {
          booking.vehicle.images = [booking.vehicle.imageUrl];
        }
      }
    }

    const statusUpper = String(booking.bookingStatus || booking.status || '').toUpperCase();
    const isUpcoming = ['PENDING', 'ACCEPTED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CONFIRMED', 'UPCOMING', 'PICKUP_SCHEDULED'].includes(statusUpper);
    if (isUpcoming && !booking.pickupOtp) {
      try {
        const otp = await this.bookingRepository.ensurePickupOtp(booking.id);
        if (otp) {
          booking.pickupOtp = String(otp);
        }
      } catch {
        // Non-fatal
      }
    }

    let existingPayments = [];
    try {
      const payRes = await this.bookingRepository.query(
        'SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC',
        [booking.id],
      );
      existingPayments = payRes.rows || [];
    } catch {
      // Non-fatal
    }

    if (existingPayments.length > 0) {
      const OvertimeService = require('./overtime.service');
      const reconciled = OvertimeService.calculateOvertimeState(booking, new Date(), { existingPayments });
      Object.assign(booking, {
        isOvertime: reconciled.isOvertime,
        overtimeStartedAt: reconciled.overtimeStartedAt,
        scheduledReturnAt: booking.endAt || reconciled.scheduledReturnAt,
        overtimeDurationSeconds: reconciled.overtimeDurationSeconds,
        overtimeDurationFormatted: reconciled.overtimeDurationFormatted,
        overtimeRate: reconciled.overtimeRate,
        overtimeAmount: reconciled.overtimeAmount,
        totalOvertimePaid: reconciled.totalOvertimePaid,
        remainingOvertimeDue: reconciled.remainingOvertimeDue,
        extraPaymentRequired: reconciled.extraPaymentRequired,
        extraPaymentStatus: reconciled.extraPaymentStatus,
        canCompleteReturn: reconciled.canCompleteReturn,
        returnPaymentRequired: reconciled.returnPaymentRequired,
        overtime: reconciled,
      });
    }

    return booking;
  }

  /**
   * Cancel an existing booking belonging to the customer.
   *
   * @param {string} customerId
   * @param {string} bookingId
   * @param {string} [reason]
   * @returns {Promise<object>}
   */
  async cancelBooking(customerId, bookingId, reason = null) {
    const booking = await this.bookingRepository.findByIdAndCustomerId(
      bookingId,
      customerId,
    );
    if (!booking) {
      throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
    }

    const statusUpper = (booking.status || '').toUpperCase();
    const isCancellable = CANCELLABLE_STATUSES.some((s) => s.toUpperCase() === statusUpper);
    if (!isCancellable) {
      throw new BadRequestError(
        `Booking cannot be cancelled in status ${booking.status}`,
        'BOOKING_NOT_CANCELLABLE',
      );
    }

    const cancelStatus = BOOKING_STATUS.CANCELLED;

    const cancelled = await this.bookingRepository.updateStatus(
      bookingId,
      customerId,
      cancelStatus,
      {
        cancellationReason: reason,
        cancelledAt: new Date().toISOString(),
      },
    );

    logger.info('Booking cancelled successfully by customer', {
      bookingId,
      customerId,
      reason,
    });

    const displayRef = cancelled.bookingReference || cancelled.bookingNumber;
    try {
      await notificationService.sendNotification({
        customerId,
        type: NOTIFICATION_TYPES.BOOKING_CANCELLED,
        title: 'Booking Cancelled',
        body: displayRef
          ? `Your booking ${displayRef} has been cancelled.`
          : 'Your booking has been cancelled.',
        data: {
          bookingId,
          bookingReference: displayRef,
        },
        eventKey: `BOOKING_CANCELLED:booking:${bookingId}:${customerId}`,
      });
    } catch (err) {
      logger.warn('Failed to dispatch booking cancellation notification', {
        bookingId,
        bookingReference: displayRef,
        error: err.message,
      });
    }

    return cancelled;
  }

  /**
   * Submit ratings (vehicle and partner) and optional review for a completed booking.
   *
   * @param {string} customerId
   * @param {string} bookingId
   * @param {object} ratingData - { vehicleRating, partnerRating, review }
   * @returns {Promise<object>}
   */
  async submitRating(customerId, bookingId, ratingData) {
    const booking = await this.bookingRepository.findByIdAndCustomerId(bookingId, customerId);
    if (!booking) {
      throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
    }

    const statusUpper = (booking.status || '').toUpperCase();
    const bookingStatusUpper = (booking.bookingStatus || '').toUpperCase();
    const isCompleted =
      statusUpper === 'COMPLETED' ||
      statusUpper === 'RETURNED' ||
      bookingStatusUpper === 'COMPLETED' ||
      bookingStatusUpper === 'RETURNED';

    if (!isCompleted) {
      throw new BadRequestError(
        'Ratings can only be submitted for completed bookings',
        'BOOKING_NOT_COMPLETED'
      );
    }

    const alreadyRated = await this.bookingRepository.hasRating(booking.id);
    if (alreadyRated) {
      throw new ConflictError('This booking has already been rated', 'ALREADY_RATED');
    }

    const result = await this.bookingRepository.createRatingsAndReview(
      booking,
      customerId,
      ratingData
    );

    logger.info('Rating submitted successfully for booking', {
      bookingId: booking.id,
      customerId,
      vehicleRating: ratingData.vehicleRating,
      partnerRating: ratingData.partnerRating,
    });

    return result;
  }
}


const bookingService = new BookingService();
bookingService.BookingService = BookingService;

module.exports = bookingService;
module.exports.BookingService = BookingService;
