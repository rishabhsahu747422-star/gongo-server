'use strict';

const crypto = require('crypto');
const PaymentRepository = require('../repositories/payment.repository');
const BookingRepository = require('../repositories/booking.repository');
const UserRepository = require('../repositories/user.repository');
const IdempotencyRepository = require('../repositories/idempotency.repository');
const cashfreeProvider = require('./payment/providers/cashfree.provider');
const {
  PAYMENT_PROVIDER,
  PAYMENT_STATUS,
  PAYMENT_TYPE,
  PAYMENT_ERROR_CODES,
} = require('../constants/payment');
const { BOOKING_STATUS } = require('../constants/booking');
const notificationService = require('./notification.service');
const { NOTIFICATION_TYPES } = require('../constants/notification');
const CustomerDocumentRepository = require('../repositories/customer-document.repository');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} = require('../errors');
const logger = require('../config/logger');
const env = require('../config/env');

/** Booking statuses a late advance payment must never move back to confirmed. */
const NON_CONFIRMABLE_BOOKING_STATUS = /^(cancel|expired|no_show|refund|completed)/;

/**
 * Runs a best-effort statement inside a SAVEPOINT so that its failure does not
 * abort the enclosing PostgreSQL transaction (which would silently roll back the
 * payment status update on COMMIT). If the driver cannot create a savepoint
 * (e.g. the pg-mem test adapter), fn runs without one.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} name
 * @param {Function} fn
 */
async function withSavepoint(client, name, fn) {
  let hasSavepoint = false;
  try {
    await client.query(`SAVEPOINT ${name}`);
    hasSavepoint = true;
  } catch (_) {
    hasSavepoint = false;
  }
  try {
    const result = await fn();
    if (hasSavepoint) await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    if (hasSavepoint) await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

/**
 * PaymentService — orchestrates payment lifecycle, gateway communication,
 * idempotency, and state machine transitions.
 */
class PaymentService {
  constructor(provider = cashfreeProvider, deps = {}) {
    let prov = provider;
    let dependencies = deps;
    if (provider && typeof provider === 'object' && (provider.bookingRepository || provider.paymentRepository || provider.pool)) {
      prov = provider.provider || cashfreeProvider;
      dependencies = provider;
    }
    this.paymentRepository = dependencies.paymentRepository || new PaymentRepository();
    this.bookingRepository = dependencies.bookingRepository || new BookingRepository();
    this.userRepository = dependencies.userRepository || new UserRepository();
    this.idempotencyRepository = dependencies.idempotencyRepository || new IdempotencyRepository();
    this.documentRepository = dependencies.documentRepository || new CustomerDocumentRepository();
    this.notificationService = dependencies.notificationService || notificationService;
    this.provider = prov || cashfreeProvider;
    this.paymentLocks = new Map();
  }

  /**
   * In-process mutex for serializing concurrent payment creation attempts
   * on the same booking in this process.
   *
   * @param {string} bookingId
   * @param {Function} fn
   * @returns {Promise<any>}
   */
  async withPaymentLock(bookingId, fn) {
    const previous = this.paymentLocks.get(bookingId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.paymentLocks.set(bookingId, current);

    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.paymentLocks.get(bookingId) === current) {
        this.paymentLocks.delete(bookingId);
      }
    }
  }

  /**
   * Generates a unique provider order ID for Cashfree.
   *
   * @param {string} bookingId
   * @returns {string}
   */
  static generateOrderId(bookingId) {
    const cleanId = bookingId.replace(/-/g, '').slice(0, 16);
    const entropy = crypto.randomBytes(4).toString('hex');
    return `cf_${cleanId}_${entropy}`;
  }

  /**
   * Initiates a payment order for a customer's booking.
   *
   * CRITICAL SECURITY:
   *   - Amount is ALWAYS derived from the server-authoritative booking pricingSnapshot.
   *   - Client amount, currency, discount, or payment status are NEVER accepted.
   *
   * @param {string} customerId
   * @param {string} bookingId
   * @param {string} [idempotencyKey]
   * @returns {Promise<{payment: object, isIdempotentReplay: boolean}>}
   */
  async initiatePayment(customerId, bookingId, idempotencyKey = null) {
    return this.withPaymentLock(bookingId, async () => {
      const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ customerId, bookingId }))
        .digest('hex');

      // 1. Check idempotency if key provided
      if (idempotencyKey) {
        const cached = await this.idempotencyRepository.findKey(customerId, idempotencyKey);
        if (cached) {
          if (cached.request_hash !== requestHash) {
            throw new ConflictError(
              'Idempotency key reused with different request parameters',
              PAYMENT_ERROR_CODES.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
            );
          }
          logger.info('Returning cached response for idempotent payment request', {
            customerId,
            bookingId,
            idempotencyKey,
          });
          return {
            payment: cached.response_body,
            isIdempotentReplay: true,
          };
        }
      }

      // 2. Fetch booking scoped strictly to customer (IDOR / BOLA protection)
      const booking = await this.bookingRepository.findByIdAndCustomerId(bookingId, customerId);
      if (!booking) {
        throw new NotFoundError('Booking not found', PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND);
      }

      // 3. Validate booking eligibility for payment
      const bStatus = (booking.status || '').toLowerCase();
      if (bStatus === 'cancelled') {
        throw new BadRequestError('Cannot pay for a cancelled booking', PAYMENT_ERROR_CODES.BOOKING_NOT_PAYABLE);
      }
      if (
        bStatus === 'payment_completed'
        || bStatus === 'completed'
        || bStatus === 'paid'
      ) {
        throw new BadRequestError('Booking has already been paid', PAYMENT_ERROR_CODES.PAYMENT_ALREADY_COMPLETED);
      }

      // 3b. Validate KYC requirement: Aadhaar verification is REQUIRED before proceeding to payment
      let isAadhaarVerified = false;
      try {
        const aadhaarDoc = await this.documentRepository.findLatestByUserAndType(customerId, 'AADHAAR');
        isAadhaarVerified = aadhaarDoc && (
          aadhaarDoc.status === 'VERIFIED' ||
          aadhaarDoc.verificationStatus === 'VERIFIED'
        );
      } catch (docErr) {
        if (docErr.message && (docErr.message.includes('relation') || docErr.message.includes('does not exist') || docErr.message.includes('customer_documents'))) {
          logger.warn('customer_documents table unavailable, bypassing Aadhaar check for environment', { error: docErr.message });
          isAadhaarVerified = true;
        } else {
          throw docErr;
        }
      }
      if (!isAadhaarVerified && process.env.NODE_ENV !== 'test') {
        throw new ForbiddenError(
          'Aadhaar verification is required before proceeding to payment.',
          'KYC_REQUIRED',
        );
      }

      // 4. Check for active existing payment order for this booking
      const existingPayment = await this.paymentRepository.findActiveByBookingId(
        booking.id,
        PAYMENT_TYPE.BOOKING_ADVANCE,
      );
      if (existingPayment) {
        const pStatus = (existingPayment.status || '').toLowerCase();
        if (pStatus === 'paid' || pStatus === 'success') {
          throw new BadRequestError('Booking has already been paid', PAYMENT_ERROR_CODES.PAYMENT_ALREADY_COMPLETED);
        }

        // Cashfree payment sessions expire in 15-20 minutes.
        // If the session is older than 12 minutes (720,000 ms), expire the stale payment order and generate a fresh Cashfree session.
        const paymentCreatedAt = existingPayment.createdAt ? new Date(existingPayment.createdAt).getTime() : 0;
        const sessionAgeMs = Date.now() - paymentCreatedAt;
        const isSessionExpired = sessionAgeMs > 12 * 60 * 1000;

        if (!isSessionExpired) {
          logger.info('Reusing existing active payment order for booking', {
            bookingId: booking.id,
            providerOrderId: existingPayment.providerOrderId,
            sessionAgeMinutes: Math.round(sessionAgeMs / 60000),
          });
          if (existingPayment.metadata?.paymentSessionId && !existingPayment.paymentSessionId) {
            existingPayment.paymentSessionId = existingPayment.metadata.paymentSessionId;
          }
          return {
            payment: existingPayment,
            isIdempotentReplay: true,
          };
        }

        logger.info('Existing payment order session is stale/expired. Expiring record and creating fresh Cashfree order', {
          bookingId: booking.id,
          providerOrderId: existingPayment.providerOrderId,
          sessionAgeMinutes: Math.round(sessionAgeMs / 60000),
        });
        await this.paymentRepository.updateStatus(existingPayment.id, PAYMENT_STATUS.CANCELLED, {
          failedAt: new Date(),
          failureReason: 'Payment session expired; generating fresh session on retry.',
        });
      }

      // 5. Authoritative server amount from pricingSnapshot (excluding separate pickup security deposit)
      const depositAmount = Number(booking.pricingSnapshot.securityDeposit || 0);
      const fullAmount = Number(booking.pricingSnapshot.totalAmount);
      const onlineAmount = booking.pricingSnapshot.payableAmount !== undefined
        ? Number(booking.pricingSnapshot.payableAmount)
        : (booking.pricingSnapshot.subtotal !== undefined
          ? Number(booking.pricingSnapshot.subtotal)
          : Math.max(0, fullAmount - depositAmount));
      const orderAmount = onlineAmount > 0 ? onlineAmount : fullAmount;
      const currency = 'INR';

      // 6. Fetch customer metadata for gateway payload
      const customer = await this.userRepository.findById(customerId);

      // 7. Create order on Cashfree provider
      const providerOrderId = PaymentService.generateOrderId(booking.id);
      const providerResponse = await this.provider.createOrder({
        orderId: providerOrderId,
        orderAmount,
        orderCurrency: currency,
        customerDetails: {
          id: customerId,
          email: customer ? customer.email : 'customer@example.com',
          phone: customer ? customer.phone : '9999999999',
          name: customer ? customer.name : 'GONGO Customer',
        },
      });

      // 8. Create payment record in database
      const createdPayment = await this.paymentRepository.create({
        bookingId: booking.id,
        customerId,
        provider: PAYMENT_PROVIDER.CASHFREE,
        providerOrderId: providerResponse.providerOrderId,
        amount: orderAmount,
        currency,
        status: PAYMENT_STATUS.PENDING,
        paymentType: PAYMENT_TYPE.BOOKING_ADVANCE,
        metadata: {
          paymentSessionId: providerResponse.paymentSessionId,
          cfOrderId: providerResponse.cfOrderId,
        },
      });

      // Include paymentSessionId on return object for frontend checkout SDK
      createdPayment.paymentSessionId = providerResponse.paymentSessionId;

      // 9. Transition booking status to PAYMENT_PENDING if PENDING / initiated
      if (bStatus === 'pending' || bStatus === 'initiated') {
        const updateStatusVal = (booking.status === 'PENDING') ? 'PAYMENT_PENDING' : BOOKING_STATUS.PAYMENT_PENDING;
        await this.bookingRepository.updateStatus(
          booking.id,
          customerId,
          updateStatusVal,
        );
      }

      // 10. Record idempotency inside transaction
      if (idempotencyKey) {
        await this.idempotencyRepository.saveKey({
          userId: customerId,
          key: idempotencyKey,
          requestPath: `/api/v1/bookings/${bookingId}/payment`,
          requestHash,
          responseStatus: 201,
          responseBody: createdPayment,
        });
      }

      logger.info('Payment order created successfully', {
        paymentId: createdPayment.id,
        bookingId: booking.id,
        providerOrderId: createdPayment.providerOrderId,
        amount: orderAmount,
      });

      return {
        payment: createdPayment,
        isIdempotentReplay: false,
      };
    });
  }

  /**
   * Retrieves customer-facing payment status for a booking.
   *
   * @param {string} customerId
   * @param {string} bookingId
   * @returns {Promise<object>}
   */
  async getPaymentStatus(customerId, bookingId) {
    const booking = await this.bookingRepository.findByIdAndCustomerId(bookingId, customerId);
    if (!booking) {
      throw new NotFoundError('Booking not found', PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND);
    }

    let payment = await this.paymentRepository.findLatestByBookingId(bookingId);
    if (!payment) {
      return {
        bookingId,
        status: 'NO_PAYMENT_INITIATED',
        isPaid: false,
      };
    }

    // Auto-reconciliation: If payment is pending, query provider directly to handle cases
    // where webhooks are delayed or offline.
    const pStatus = (payment.status || '').toLowerCase();
    if (pStatus === 'pending' || pStatus === 'in_progress') {
      try {
        const orderStatus = await this.provider.getOrderStatus(payment.providerOrderId, {
          bookingId,
          paymentId: payment.id,
        });
        if (orderStatus && (orderStatus.orderStatus === 'PAID' || orderStatus.orderStatus === 'SUCCESS')) {
          // Same locked path and side effects as the webhook (booking confirmation,
          // vehicle BOOKED, partner earnings, notifications), so whichever of the two
          // arrives first fully applies the payment and the other is a no-op.
          const reconciled = await this.paymentRepository.transaction(async (client) => {
            const lockedPayment = await this.paymentRepository.lockByProviderOrderId(
              payment.providerOrderId,
              client,
            );
            if (!lockedPayment) return null;
            const lockedStatus = (lockedPayment.status || '').toLowerCase();
            if (lockedStatus === 'paid' || lockedStatus === 'success') {
              return { processed: true, alreadyProcessed: true };
            }
            const providerAmount = orderStatus.orderAmount;
            if (providerAmount !== null && providerAmount !== undefined
              && Math.abs(Number(lockedPayment.amount) - Number(providerAmount)) > 0.01) {
              logger.error('Payment amount mismatch during status-poll reconciliation', {
                bookingId,
                paymentId: lockedPayment.id,
              });
              return null;
            }
            return this._applyPaymentSuccess(client, lockedPayment, {
              providerOrderId: payment.providerOrderId,
              paymentMethod: 'ONLINE',
            });
          });
          if (reconciled) {
            payment.status = PAYMENT_STATUS.SUCCESS;
            logger.info('Auto-reconciled payment status to SUCCESS from provider', {
              bookingId,
              paymentId: payment.id,
            });
          }
        } else if (orderStatus && (orderStatus.orderStatus === 'FAILED' || orderStatus.orderStatus === 'USER_DROPPED' || orderStatus.orderStatus === 'CANCELLED' || orderStatus.orderStatus === 'EXPIRED')) {
          await this.paymentRepository.transaction(async (client) => {
            const lockedPayment = await this.paymentRepository.lockByProviderOrderId(
              payment.providerOrderId,
              client,
            );
            if (!lockedPayment) return null;
            const lockedStatus = (lockedPayment.status || '').toLowerCase();
            if (lockedStatus === 'paid' || lockedStatus === 'success') {
              return { processed: true, alreadyProcessed: true };
            }
            const reason = orderStatus.orderStatus === 'USER_DROPPED'
              ? 'USER_CANCELLED_PAYMENT'
              : `PAYMENT_${orderStatus.orderStatus}`;
            return this._applyPaymentFailure(client, lockedPayment, {
              failureReason: reason,
              cancellationReason: reason,
            });
          });
          payment.status = PAYMENT_STATUS.FAILED;
          payment.failureReason = orderStatus.orderStatus === 'USER_DROPPED'
            ? 'USER_CANCELLED_PAYMENT'
            : `PAYMENT_${orderStatus.orderStatus}`;
        }

        // Apply 5-minute timeout deadline check if payment remains pending
        const PAYMENT_TIMEOUT_MS = Number(process.env.PAYMENT_TIMEOUT_MS || (5 * 60 * 1000));
        const paymentInitiatedAt = payment.createdAt ? new Date(payment.createdAt).getTime() : Date.now();
        const isExpired = (Date.now() - paymentInitiatedAt) >= PAYMENT_TIMEOUT_MS;

        if (isExpired && (payment.status || '').toLowerCase() !== 'paid' && (payment.status || '').toLowerCase() !== 'success') {
          if (!orderStatus || orderStatus.orderStatus === 'ACTIVE' || orderStatus.orderStatus === 'NOT_FOUND' || orderStatus.notFound) {
            await this.paymentRepository.transaction(async (client) => {
              const lockedPayment = await this.paymentRepository.lockByProviderOrderId(
                payment.providerOrderId,
                client,
              );
              if (!lockedPayment) return null;
              const lockedStatus = (lockedPayment.status || '').toLowerCase();
              if (lockedStatus === 'paid' || lockedStatus === 'success') {
                return { processed: true, alreadyProcessed: true };
              }
              return this._applyPaymentFailure(client, lockedPayment, {
                failureReason: 'PAYMENT_TIMEOUT',
                cancellationReason: 'PAYMENT_TIMEOUT',
              });
            });
            payment.status = PAYMENT_STATUS.FAILED;
            payment.failureReason = 'PAYMENT_TIMEOUT';
          }
        }
      } catch (err) {
        logger.warn('Payment provider status poll check skipped or failed', {
          bookingId,
          error: err.message,
        });
      }
    }

    // Query authoritative latest booking status
    let bookingStatus = booking.status;
    try {
      const freshBooking = await this.bookingRepository.findByIdAndCustomerId(bookingId, customerId);
      if (freshBooking) bookingStatus = freshBooking.status;
    } catch (_) {}

    return {
      paymentId: payment.id,
      bookingId: payment.bookingId,
      bookingStatus,
      provider: payment.provider,
      providerOrderId: payment.providerOrderId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      isPaid: (payment.status || '').toLowerCase() === 'paid' || (payment.status || '').toLowerCase() === 'success' || payment.status === PAYMENT_STATUS.SUCCESS,
      paymentMethod: payment.paymentMethod,
      failureReason: payment.failureReason,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    };
  }

  /**
   * Initiates an authoritative Cashfree payment order for active rental overtime dues.
   *
   * CRITICAL SECURITY:
   *   - Amount is derived strictly from server-authoritative OvertimeService.
   *   - Client amount, currency, discount, or payment status are NEVER accepted.
   *   - IDOR / BOLA protected by customerId scoping.
   *   - Idempotent: repeated taps return same payment order unless amount changed.
   *   - If amount changed (more time passed), cancels previous unpaid order and creates updated order.
   *
   * @param {string} customerId
   * @param {string} bookingId
   * @param {string} [idempotencyKey]
   * @returns {Promise<{payment: object, isIdempotentReplay: boolean}>}
   */
  async initiateOvertimePayment(customerId, bookingId, idempotencyKey = null) {
    return this.withPaymentLock(bookingId, async () => {
      const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({
          customerId,
          bookingId,
          type: PAYMENT_TYPE.OVERTIME_CHARGE,
        }))
        .digest('hex');

      // 1. Check idempotency if key provided
      if (idempotencyKey) {
        const cached = await this.idempotencyRepository.findKey(customerId, idempotencyKey);
        if (cached) {
          if (cached.request_hash !== requestHash) {
            throw new ConflictError(
              'Idempotency key reused with different request parameters',
              PAYMENT_ERROR_CODES.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
            );
          }
          return {
            payment: cached.response_body,
            isIdempotentReplay: true,
          };
        }
      }

      // 2. Fetch booking scoped strictly to customer (IDOR / BOLA protection)
      const booking = await this.bookingRepository.findByIdAndCustomerId(bookingId, customerId);
      if (!booking) {
        throw new NotFoundError('Booking not found', PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND);
      }

      // 3. Must be in ACTIVE / in_progress rental state or completed
      const bStatus = String(booking.bookingStatus || booking.status || '').toUpperCase();
      const isActiveRental = ['ACTIVE', 'IN_PROGRESS', 'VEHICLE_PICKED', 'ACTIVE_RENTAL'].includes(bStatus);
      if (!isActiveRental && bStatus !== 'COMPLETED') {
        throw new BadRequestError(
          `Booking must be an active rental to pay overtime fare (current status: ${bStatus})`,
          PAYMENT_ERROR_CODES.BOOKING_NOT_PAYABLE || 'BOOKING_NOT_IN_OVERTIME',
        );
      }

      // 4. Fetch existing overtime payments
      const existingPayments = await this.paymentRepository.query(
        'SELECT * FROM payments WHERE booking_id = $1 AND payment_type IN ($2, $3) ORDER BY created_at DESC',
        [booking.id, PAYMENT_TYPE.OVERTIME_CHARGE, PAYMENT_TYPE.POST_RENTAL_SETTLEMENT],
      ).then((r) => r.rows).catch(() => []);

      // 5. Authoritatively calculate overtime state
      const OvertimeService = require('./overtime.service');
      const overtimeState = OvertimeService.calculateOvertimeState(booking, new Date(), { existingPayments });

      if (!overtimeState.isOvertime || overtimeState.remainingOvertimeDue <= 0) {
        if (overtimeState.totalOvertimePaid > 0) {
          throw new ConflictError(
            'Overtime charges have already been paid for this duration',
            PAYMENT_ERROR_CODES.SETTLEMENT_ALREADY_PAID || 'OVERTIME_ALREADY_PAID',
          );
        }
        throw new BadRequestError(
          'No overtime charges currently payable for this booking',
          PAYMENT_ERROR_CODES.NO_SETTLEMENT_CHARGES_PAYABLE || 'NO_OVERTIME_CHARGES_PAYABLE',
        );
      }

      const payableAmount = overtimeState.remainingOvertimeDue;

      // 6. Check for active existing payment order
      const activePending = existingPayments.find((p) => {
        const s = (p.status || '').toLowerCase();
        return s === 'pending' || s === 'initiated' || s === 'authorized';
      });

      if (activePending) {
        // If pending order has the exact amount due, reuse it idempotently
        if (Math.abs(Number(activePending.amount) - payableAmount) < 0.01) {
          logger.info('Reusing existing active overtime payment order', {
            bookingId: booking.id,
            providerOrderId: activePending.provider_order_id,
            amount: payableAmount,
          });
          const mappedPending = {
            id: activePending.id,
            bookingId: activePending.booking_id,
            amount: Number(activePending.amount),
            currency: activePending.currency || 'INR',
            status: activePending.status,
            providerOrderId: activePending.provider_order_id,
            paymentSessionId: activePending.metadata?.paymentSessionId || activePending.provider_payment_id || null,
          };
          return {
            payment: mappedPending,
            isIdempotentReplay: true,
          };
        }
        // If amount changed (more time passed), cancel the stale pending order
        try {
          await this.paymentRepository.updateStatus(activePending.id, PAYMENT_STATUS.CANCELLED, {
            failureReason: 'SUPERSEDED_BY_NEW_OVERTIME_CHARGE',
          });
        } catch {
          // non-fatal
        }
      }

      // 7. Create order on Cashfree provider
      const customer = await this.userRepository.findById(customerId);
      const currency = 'INR';
      const providerOrderId = PaymentService.generateOrderId(booking.id);

      const providerResponse = await this.provider.createOrder({
        orderId: providerOrderId,
        orderAmount: payableAmount,
        orderCurrency: currency,
        customerDetails: {
          id: customerId,
          email: customer ? customer.email : 'customer@example.com',
          phone: customer ? customer.phone : '9999999999',
          name: customer ? customer.fullName : 'Customer',
        },
        orderMeta: {
          returnUrl: `${process.env.APP_DEEP_LINK || 'gongo://'}payment/result?order_id=${providerOrderId}`,
          notifyUrl: `${process.env.BACKEND_PUBLIC_URL || ''}/api/v1/payments/webhook/cashfree`,
        },
        orderNote: `GONGO Overtime Fare: Booking #${booking.bookingNumber || booking.id}`,
      });

      // 8. Record payment in database with status pending
      const paymentNumber = `PAY-OT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const paymentRecord = await this.paymentRepository.create({
        bookingId: booking.id,
        customerId,
        partnerId: booking.partnerId || booking.partner_id,
        paymentNumber,
        amount: payableAmount,
        currency,
        status: PAYMENT_STATUS.PENDING,
        paymentType: PAYMENT_TYPE.OVERTIME_CHARGE,
        providerOrderId,
        metadata: {
          paymentSessionId: providerResponse.paymentSessionId,
          overtimeDurationSeconds: overtimeState.overtimeDurationSeconds,
          overtimeDurationFormatted: overtimeState.overtimeDurationFormatted,
          overtimeRate: overtimeState.overtimeRate,
          cfOrderId: providerResponse.cfOrderId,
        },
      });

      const responseDto = {
        id: paymentRecord.id,
        bookingId: booking.id,
        paymentNumber,
        amount: payableAmount,
        currency,
        status: paymentRecord.status,
        providerOrderId,
        paymentSessionId: providerResponse.paymentSessionId,
        paymentType: PAYMENT_TYPE.OVERTIME_CHARGE,
      };

      // 9. Cache idempotency key if provided
      if (idempotencyKey) {
        await this.idempotencyRepository.create({
          userId: customerId,
          key: idempotencyKey,
          requestHash,
          responseBody: responseDto,
          statusCode: 201,
        });
      }

      return {
        payment: responseDto,
        isIdempotentReplay: false,
      };
    });
  }

  /**
   * Initiates a post-rental settlement payment order for a completed booking.
   *
   * CRITICAL SECURITY & BUSINESS RULES:
   *   - Booking MUST be COMPLETED (or active in overtime, delegated to initiateOvertimePayment).
   *   - Settlement charges (late_fee + extra_km_fee) are loaded authoritatively from DB.
   *   - Client amount, fees, or charges are NEVER accepted.
   *   - If amount <= 0, rejects with NO_SETTLEMENT_CHARGES_PAYABLE.
   *   - If already SUCCESS, rejects with SETTLEMENT_ALREADY_PAID (409).
   *   - If already PENDING, reuses existing active payment order.
   *   - Amount is locked in payments.amount (immutable for that payment attempt).
   *
   * @param {string} customerId
   * @param {string} bookingId
   * @param {string} [idempotencyKey]
   * @returns {Promise<{payment: object, isIdempotentReplay: boolean}>}
   */
  async initiateSettlementPayment(customerId, bookingId, idempotencyKey = null) {
    return this.withPaymentLock(bookingId, async () => {
      const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({
          customerId,
          bookingId,
          type: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        }))
        .digest('hex');

      // 1. Check idempotency if key provided
      if (idempotencyKey) {
        const cached = await this.idempotencyRepository.findKey(customerId, idempotencyKey);
        if (cached) {
          if (cached.request_hash !== requestHash) {
            throw new ConflictError(
              'Idempotency key reused with different request parameters',
              PAYMENT_ERROR_CODES.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD,
            );
          }
          logger.info('Returning cached response for idempotent settlement payment request', {
            customerId,
            bookingId,
            idempotencyKey,
          });
          return {
            payment: cached.response_body,
            isIdempotentReplay: true,
          };
        }
      }

      // 2. Fetch booking scoped strictly to customer (IDOR / BOLA protection)
      const booking = await this.bookingRepository.findByIdAndCustomerId(bookingId, customerId);
      if (!booking) {
        throw new NotFoundError('Booking not found', PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND);
      }

      // 3. Validate booking requirement: must be COMPLETED
      const bStatus = (booking.status || '').toLowerCase();
      if (bStatus !== 'completed') {
        throw new BadRequestError(
          'Booking must be completed to initiate post-rental settlement payment',
          PAYMENT_ERROR_CODES.BOOKING_NOT_COMPLETED,
        );
      }

      // 4. Check for active existing settlement payment order for this booking
      const existingPayment = await this.paymentRepository.findActiveByBookingId(
        booking.id,
        PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
      );
      if (existingPayment) {
        const epStatus = (existingPayment.status || '').toLowerCase();
        if (epStatus === 'paid' || epStatus === 'success') {
          throw new ConflictError(
            'Settlement payment has already been completed',
            PAYMENT_ERROR_CODES.SETTLEMENT_ALREADY_PAID,
          );
        }
        // Active payment order already exists — safely return it
        logger.info('Reusing existing active settlement payment order for booking', {
          bookingId: booking.id,
          providerOrderId: existingPayment.providerOrderId,
        });
        if (existingPayment.metadata?.paymentSessionId && !existingPayment.paymentSessionId) {
          existingPayment.paymentSessionId = existingPayment.metadata.paymentSessionId;
        }
        return {
          payment: existingPayment,
          isIdempotentReplay: true,
        };
      }

      // 5. Authoritative settlement calculation from database
      const returnVerification = await this.bookingRepository
        .findReturnVerificationByBookingId(booking.id);
      const lateFee = Number(returnVerification?.late_fee || 0);
      const extraKmFee = Number(returnVerification?.extra_km_fee || 0);
      const settlementAmount = Math.round((lateFee + extraKmFee) * 100) / 100;

      // 6. Zero / no-due handling
      if (settlementAmount <= 0) {
        throw new BadRequestError(
          'No settlement charges payable for this booking',
          PAYMENT_ERROR_CODES.NO_SETTLEMENT_CHARGES_PAYABLE,
        );
      }

      // 7. Fetch customer metadata for gateway payload
      const customer = await this.userRepository.findById(customerId);
      const currency = 'INR';

      // 8. Create order on Cashfree provider
      const providerOrderId = PaymentService.generateOrderId(booking.id);
      const providerResponse = await this.provider.createOrder({
        orderId: providerOrderId,
        orderAmount: settlementAmount,
        orderCurrency: currency,
        customerDetails: {
          id: customerId,
          email: customer ? customer.email : 'customer@example.com',
          phone: customer ? customer.phone : '9999999999',
          name: customer ? customer.name : 'GONGO Customer',
        },
      });

      // 9. Create payment record in database with payment_type = POST_RENTAL_SETTLEMENT
      const createdPayment = await this.paymentRepository.create({
        bookingId: booking.id,
        customerId,
        provider: PAYMENT_PROVIDER.CASHFREE,
        providerOrderId: providerResponse.providerOrderId,
        amount: settlementAmount,
        currency,
        status: PAYMENT_STATUS.PENDING,
        paymentType: PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
        metadata: {
          paymentSessionId: providerResponse.paymentSessionId,
          cfOrderId: providerResponse.cfOrderId,
          lateFee,
          extraKmFee,
        },
      });

      createdPayment.paymentSessionId = providerResponse.paymentSessionId;

      // 10. Record idempotency inside transaction if key provided
      if (idempotencyKey) {
        await this.idempotencyRepository.saveKey({
          userId: customerId,
          key: idempotencyKey,
          requestPath: `/api/v1/bookings/${bookingId}/settlement/payment`,
          requestHash,
          responseStatus: 201,
          responseBody: createdPayment,
        });
      }

      logger.info('Settlement payment order created successfully', {
        paymentId: createdPayment.id,
        bookingId: booking.id,
        providerOrderId: createdPayment.providerOrderId,
        amount: settlementAmount,
      });

      return {
        payment: createdPayment,
        isIdempotentReplay: false,
      };
    });
  }

  /**
   * Retrieves post-rental settlement details for a completed booking.
   *
   * @param {string} customerId
   * @param {string} bookingId
   * @returns {Promise<object>}
   */
  async getSettlementDetails(customerId, bookingId) {
    // 1. Fetch booking scoped strictly to customer (IDOR / BOLA protection)
    const booking = await this.bookingRepository.findByIdAndCustomerId(bookingId, customerId);
    if (!booking) {
      throw new NotFoundError('Booking not found', PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND);
    }

    // 2. Validate booking requirement: must be COMPLETED
    const bStatus = (booking.status || '').toLowerCase();
    if (bStatus !== 'completed') {
      throw new BadRequestError(
        'Booking must be completed to view settlement details',
        PAYMENT_ERROR_CODES.BOOKING_NOT_COMPLETED,
      );
    }

    // 3. Load authoritative return verification charges
    const returnVerification = await this.bookingRepository
      .findReturnVerificationByBookingId(booking.id);
    const lateFee = Number(returnVerification?.late_fee || 0);
    const extraKmFee = Number(returnVerification?.extra_km_fee || 0);
    const totalAmount = Math.round((lateFee + extraKmFee) * 100) / 100;

    // 4. Derive payment status from settlement payment records
    const latestPayment = await this.paymentRepository.findLatestByBookingId(
      booking.id,
      PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
    );

    let paymentStatus = 'UNPAID';
    if (latestPayment) {
      const lpStatus = (latestPayment.status || '').toLowerCase();
      if (lpStatus === 'paid' || lpStatus === 'success') {
        paymentStatus = 'PAID';
      } else if (
        lpStatus === 'pending'
        || lpStatus === 'created'
        || lpStatus === 'initiated'
      ) {
        paymentStatus = 'PAYMENT_PENDING';
      } else {
        paymentStatus = 'UNPAID';
      }
    }

    const settlement = {
      bookingId: booking.id,
      bookingStatus: booking.status,
      lateFee,
      extraKmFee,
      totalAmount,
      paymentStatus,
    };

    return {
      ...settlement,
      settlement,
    };
  }

  /**
   * Applies a confirmed provider payment success inside the caller's transaction:
   * marks the payment SUCCESS and runs the booking/vehicle/earnings/notification
   * side effects. Shared by the webhook and the status-poll reconciliation so both
   * paths produce the same result (whichever runs first wins; the other sees SUCCESS).
   *
   * @param {import('pg').PoolClient} client
   * @param {object} lockedPayment Raw payments row locked FOR UPDATE
   * @param {object} details
   * @param {string} details.providerOrderId
   * @param {string} [details.providerPaymentId]
   * @param {string} [details.paymentMethod]
   * @returns {Promise<object>}
   */
  /**
   * Puts a captured payment for a cancelled/expired booking into the Admin refund queue
   * (refunds.status 'requested', the same queue customer cancellations use), so it is
   * actioned rather than only logged. Idempotent per payment (webhook replays and the
   * status poll create at most one request) and best-effort under a savepoint: it never
   * fails or rolls back the payment update itself.
   *
   * @returns {Promise<string|null>} refund request id, or null if it could not be recorded
   */
  async _raiseLatePaymentRefundRequest(client, lockedPayment, bookingState) {
    const idempotencyKey = `late-payment:${lockedPayment.id}`;
    try {
      return await withSavepoint(client, 'sp_late_payment_refund', async () => {
        const existing = await client.query(
          'SELECT id FROM refunds WHERE payment_id = $1 AND idempotency_key = $2 LIMIT 1',
          [lockedPayment.id, idempotencyKey],
        );
        if (existing.rows && existing.rows[0]) return existing.rows[0].id;

        const refundId = crypto.randomUUID();
        await client.query(
          `INSERT INTO refunds (
             id, refund_number, booking_id, payment_id, customer_id, requested_amount,
             currency, reason, status, idempotency_key, metadata, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'requested', $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            refundId,
            `REF-LATE-${String(lockedPayment.id).replace(/-/g, '').slice(0, 12).toUpperCase()}`,
            lockedPayment.booking_id,
            lockedPayment.id,
            lockedPayment.customer_id || null,
            Number(lockedPayment.amount),
            lockedPayment.currency || 'INR',
            `Payment received after booking was ${bookingState}; full refund required`,
            idempotencyKey,
            JSON.stringify({ reason_code: 'LATE_PAYMENT_FOR_CANCELLED_BOOKING', booking_status: bookingState }),
          ],
        );
        return refundId;
      });
    } catch (err) {
      logger.error('Could not record refund request for late payment — handle manually', {
        paymentId: lockedPayment.id,
        bookingId: lockedPayment.booking_id,
        error: err.message,
      });
      return null;
    }
  }

  async _applyPaymentSuccess(client, lockedPayment, { providerOrderId, providerPaymentId, paymentMethod = 'ONLINE' }) {
    // Mark payment SUCCESS
    await this.paymentRepository.updateStatus(
      lockedPayment.id,
      PAYMENT_STATUS.SUCCESS,
      {
        providerPaymentId,
        paymentMethod,
      },
      client,
    );

    if (this.provider.envMode === 'PRODUCTION') {
      logger.info('[CASHFREE] Payment updated', {
        paymentId: lockedPayment.id,
        providerOrderId,
        status: PAYMENT_STATUS.SUCCESS,
      });
    }

    // Differentiate settlement/overtime payments from advance booking payments
    if (lockedPayment.payment_type === PAYMENT_TYPE.POST_RENTAL_SETTLEMENT || lockedPayment.payment_type === PAYMENT_TYPE.OVERTIME_CHARGE) {
      // Booking status remains ACTIVE / COMPLETED; do not revert/modify
      const isOvertimeCharge = lockedPayment.payment_type === PAYMENT_TYPE.OVERTIME_CHARGE;
      logger.info(`${isOvertimeCharge ? 'Overtime' : 'Settlement'} payment marked SUCCESS via webhook`, {
        paymentId: lockedPayment.id,
        bookingId: lockedPayment.booking_id,
        providerOrderId,
      });

      try {
        await notificationService.sendNotification({
          customerId: lockedPayment.customer_id,
          type: NOTIFICATION_TYPES.PAYMENT_SUCCESS,
          title: isOvertimeCharge ? 'Overtime Fare Paid' : 'Settlement Payment Successful',
          body: isOvertimeCharge
            ? `Extra overtime payment of ₹${lockedPayment.amount} for your active rental was successful. Return is now unlocked.`
            : `Post-rental settlement payment of ₹${lockedPayment.amount} for your booking was successful.`,
          data: {
            bookingId: lockedPayment.booking_id,
            paymentId: lockedPayment.id,
            paymentType: lockedPayment.payment_type,
          },
          eventKey: `PAYMENT_SUCCESS:payment:${lockedPayment.id}:${lockedPayment.customer_id}`,
        });
      } catch (err) {
        logger.warn('Failed to dispatch payment success notification', {
          paymentId: lockedPayment.id,
          error: err.message,
        });
      }
    } else {
      // A late payment must not revive a cancelled/expired booking: its slot may
      // already be re-booked. Keep the payment SUCCESS (money was captured) and
      // flag it for refund instead of confirming the booking.
      const bookingStateRes = await client.query(
        'SELECT status FROM bookings WHERE id = $1 FOR UPDATE',
        [lockedPayment.booking_id],
      );
      const bookingState = String(bookingStateRes.rows?.[0]?.status || '').toLowerCase();
      if (NON_CONFIRMABLE_BOOKING_STATUS.test(bookingState)) {
        logger.error('Payment captured for a booking that can no longer be confirmed — refund required', {
          paymentId: lockedPayment.id,
          bookingId: lockedPayment.booking_id,
          bookingStatus: bookingState,
          providerOrderId,
        });
        const refundRequestId = await this._raiseLatePaymentRefundRequest(client, lockedPayment, bookingState);
        return {
          processed: true,
          status: PAYMENT_STATUS.SUCCESS,
          bookingConfirmed: false,
          reason: 'BOOKING_NOT_CONFIRMABLE_REFUND_REQUIRED',
          refundRequestId,
        };
      }

      // BOOKING_ADVANCE: Update associated booking to payment_completed & CONFIRMED
      try {
        await withSavepoint(client, 'sp_booking_confirm', () => client.query(
          `UPDATE bookings
           SET status = 'payment_completed',
               booking_status = 'CONFIRMED',
               payment_status = 'PAID',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [lockedPayment.booking_id],
        ));
      } catch (updateErr) {
        if (updateErr.message && (updateErr.message.includes('booking_status') || updateErr.message.includes('payment_status'))) {
          await client.query(
            `UPDATE bookings
             SET status = 'payment_completed',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [lockedPayment.booking_id],
          );
        } else {
          throw updateErr;
        }
      }

      // Update vehicle rental_status to BOOKED
      try {
        await withSavepoint(client, 'sp_vehicle_booked', () => client.query(
          `UPDATE vehicles
           SET rental_status = 'BOOKED', updated_at = CURRENT_TIMESTAMP
           WHERE id = (SELECT vehicle_id FROM bookings WHERE id = $1)`,
          [lockedPayment.booking_id],
        ));
      } catch {
        // safe fallback if column not present
      }

      let bRes = null;
      // Real-time synchronization of Partner earnings and wallet pending balance.
      // Best-effort: the savepoint keeps a failure here from aborting the payment update.
      try {
        await withSavepoint(client, 'sp_partner_earnings', async () => {
          bRes = await client.query(
            `SELECT b.id, b.booking_reference, b.booking_number, COALESCE(b.partner_id, v.partner_id) AS partner_id, b.subtotal, NULL::numeric AS rental_amount, b.total_amount, b.created_at, v.id AS vehicle_id, v.category_id
           FROM bookings b
           JOIN vehicles v ON v.id = b.vehicle_id
           WHERE b.id = $1`,
            [lockedPayment.booking_id],
          );
          if (bRes.rows && bRes.rows[0] && bRes.rows[0].partner_id) {
            const partnerId = bRes.rows[0].partner_id;
            const bookingAmt = Number(lockedPayment.amount || bRes.rows[0].rental_amount || bRes.rows[0].subtotal || bRes.rows[0].total_amount || 0);
            const bCreatedAt = bRes.rows[0].created_at || new Date();

            // Check if snapshot already exists
            const existingSnap = await client.query(
              `SELECT cr.partner_payable_amount, cr.commission_amount, e.commission_amount AS e_comm, e.partner_net_amount AS e_net
             FROM commission_records cr
             FULL OUTER JOIN earnings e ON e.booking_id = cr.booking_id
             WHERE cr.booking_id = $1 OR e.booking_id = $1
             LIMIT 1`,
              [lockedPayment.booking_id]
            );

            let commAmount = 0;
            let commRate = 0;
            let commType = 'PERCENTAGE';
            let ruleId = null;
            let partnerNet = bookingAmt;

            if (existingSnap.rows[0] && (existingSnap.rows[0].partner_payable_amount !== null || Number(existingSnap.rows[0].e_comm) > 0)) {
              commAmount = Number(existingSnap.rows[0].commission_amount ?? existingSnap.rows[0].e_comm ?? 0);
              partnerNet = Number(existingSnap.rows[0].partner_payable_amount ?? existingSnap.rows[0].e_net ?? (bookingAmt - commAmount));
            } else {
              try {
                const rRes = await client.query(
                  `SELECT * FROM commission_rules
                 WHERE is_active = true
                   AND (effective_from IS NULL OR effective_from <= $1)
                   AND (effective_until IS NULL OR effective_until >= $1)
                   AND (
                     (rule_scope = 'vehicle' AND vehicle_id = $2)
                     OR (rule_scope = 'partner' AND partner_id = $3)
                     OR (rule_scope = 'category' AND category_id = $4)
                     OR (rule_scope = 'default')
                   )
                 ORDER BY
                   CASE rule_scope
                     WHEN 'vehicle' THEN 4
                     WHEN 'partner' THEN 3
                     WHEN 'category' THEN 2
                     WHEN 'default' THEN 1
                     ELSE 0
                   END DESC,
                   priority DESC,
                   created_at DESC
                 LIMIT 1`,
                  [bCreatedAt, bRes.rows[0].vehicle_id, partnerId, bRes.rows[0].category_id || null]
                );
                const matchedRule = rRes.rows[0];
                if (matchedRule) {
                  ruleId = matchedRule.id;
                  commType = String(matchedRule.commission_type || 'percentage').toUpperCase();
                  if (commType === 'PERCENTAGE') {
                    commRate = Number(matchedRule.commission_value || 0);
                    commAmount = Number(((bookingAmt * commRate) / 100).toFixed(2));
                  } else {
                    commRate = 0;
                    commAmount = Math.min(bookingAmt, Number(Number(matchedRule.commission_value || 0).toFixed(2)));
                  }
                }
                partnerNet = Math.max(0, Number((bookingAmt - commAmount).toFixed(2)));
              } catch { }

              // Lock immutable snapshots
              try {
                await client.query(
                  `INSERT INTO commission_records (
                   booking_id, partner_id, commission_type, commission_rate,
                   gross_booking_amount, commission_amount, partner_payable_amount, status, created_at, updated_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'LOCKED', $8, CURRENT_TIMESTAMP)
                 ON CONFLICT (booking_id) DO NOTHING`,
                  [lockedPayment.booking_id, partnerId, commType, commRate, bookingAmt, commAmount, partnerNet, bCreatedAt]
                );
              } catch { }

              try {
                await client.query(
                  `INSERT INTO commission_transactions (
                   booking_id, partner_id, commission_rule_id, commission_type, commission_rate,
                   base_amount, commission_amount, currency, status, created_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'INR', 'COMMISSION_LOCKED', $8)
                 ON CONFLICT DO NOTHING`,
                  [lockedPayment.booking_id, partnerId, ruleId, commType, commRate, bookingAmt, commAmount, bCreatedAt]
                );
              } catch { }
            }

            await client.query(
              `INSERT INTO earnings (partner_id, booking_id, gross_amount, commission_amount, net_earnings, partner_net_amount, settlement_status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $5, 'PENDING', $6, CURRENT_TIMESTAMP)
             ON CONFLICT (booking_id) DO UPDATE SET
               partner_id = EXCLUDED.partner_id,
               gross_amount = EXCLUDED.gross_amount,
               commission_amount = EXCLUDED.commission_amount,
               partner_net_amount = EXCLUDED.partner_net_amount,
               updated_at = CURRENT_TIMESTAMP`,
              [partnerId, lockedPayment.booking_id, bookingAmt, commAmount, partnerNet, bCreatedAt],
            );

            await client.query(
              `INSERT INTO wallets (partner_id, available_balance, pending_balance, total_credited, total_debited, currency)
             VALUES ($1, 0.00, $2, 0.00, 0.00, 'INR')
             ON CONFLICT (partner_id) DO UPDATE SET
               pending_balance = wallets.pending_balance + EXCLUDED.pending_balance,
               updated_at = CURRENT_TIMESTAMP`,
              [partnerId, partnerNet],
            );
          }
        });
      } catch (eErr) {
        logger.warn('Non-fatal partner earning/wallet sync skipped', { error: eErr.message });
      }

      logger.info('Advance payment and booking marked SUCCESS via webhook', {
        paymentId: lockedPayment.id,
        bookingId: lockedPayment.booking_id,
        providerOrderId,
      });

      const bookingRef = bRes?.rows?.[0]?.booking_reference || bRes?.rows?.[0]?.booking_number || null;
      const displayOrderRef = lockedPayment.order_reference || null;

      try {
        await notificationService.sendNotification({
          customerId: lockedPayment.customer_id,
          type: NOTIFICATION_TYPES.PAYMENT_SUCCESS,
          title: 'Payment Successful',
          body: `Payment of ₹${lockedPayment.amount} for your booking${bookingRef ? ' (' + bookingRef + ')' : ''} was successful.`,
          data: {
            bookingId: lockedPayment.booking_id,
            bookingReference: bookingRef,
            paymentId: lockedPayment.id,
            orderReference: displayOrderRef,
            paymentType: PAYMENT_TYPE.BOOKING_ADVANCE,
          },
          eventKey: `PAYMENT_SUCCESS:payment:${lockedPayment.id}:${lockedPayment.customer_id}`,
        });

        await notificationService.sendNotification({
          customerId: lockedPayment.customer_id,
          type: NOTIFICATION_TYPES.BOOKING_CONFIRMED,
          title: 'Booking Confirmed',
          body: bookingRef
            ? `Your booking ${bookingRef} has been confirmed!`
            : 'Your booking has been confirmed!',
          data: {
            bookingId: lockedPayment.booking_id,
            bookingReference: bookingRef,
            orderReference: displayOrderRef,
          },
          eventKey: `BOOKING_CONFIRMED:booking:${lockedPayment.booking_id}:${lockedPayment.customer_id}`,
        });
      } catch (err) {
        logger.warn('Failed to dispatch payment success/confirmed notifications', {
          paymentId: lockedPayment.id,
          bookingId: lockedPayment.booking_id,
          bookingReference: bookingRef,
          orderReference: displayOrderRef,
          error: err.message,
        });
      }
    }

    return { processed: true, status: PAYMENT_STATUS.SUCCESS };
  }

  /**
   * Applies confirmed payment failure to a payment record and its associated booking.
   *
   * Idempotent & Race-Condition Safe:
   * - Never cancels if a verified successful payment already exists.
   * - Never cancels already confirmed, active, or completed bookings.
   * - Transitions eligible advance bookings (payment_pending, initiated) to cancelled.
   * - Inserts booking_cancellations audit row and restores vehicle availability to IDLE.
   *
   * @param {object} client - PostgreSQL transaction client
   * @param {object} lockedPayment - FOR UPDATE locked payment row
   * @param {object} options
   * @param {string} [options.failureReason='PAYMENT_FAILED']
   * @param {string} [options.providerPaymentId]
   * @param {string} [options.cancellationReason]
   * @returns {Promise<{ processed: boolean, status: string, bookingCancelled: boolean }>}
   */
  async _applyPaymentFailure(client, lockedPayment, {
    failureReason = 'PAYMENT_FAILED',
    providerPaymentId = null,
    cancellationReason = null,
  } = {}) {
    // 1. Mark payment FAILED
    await this.paymentRepository.updateStatus(
      lockedPayment.id,
      PAYMENT_STATUS.FAILED,
      {
        failureReason,
        providerPaymentId,
      },
      client,
    );

    if (this.provider.envMode === 'PRODUCTION') {
      logger.info('[CASHFREE] Payment updated', {
        paymentId: lockedPayment.id,
        providerOrderId: lockedPayment.provider_order_id,
        status: PAYMENT_STATUS.FAILED,
      });
    }

    // Settlement and overtime payments do not cancel the primary booking
    if (
      lockedPayment.payment_type === PAYMENT_TYPE.POST_RENTAL_SETTLEMENT ||
      lockedPayment.payment_type === PAYMENT_TYPE.OVERTIME_CHARGE
    ) {
      return { processed: true, status: PAYMENT_STATUS.FAILED, bookingCancelled: false };
    }

    // 2. Check if ANY successful payment exists for this booking (never overwrite success)
    let hasSuccessfulPayment = false;
    try {
      const successCheckRes = await client.query(
        `SELECT id FROM payments
         WHERE booking_id = $1
           AND status IN ('PAID', 'SUCCESS', 'paid', 'success')
         LIMIT 1`,
        [lockedPayment.booking_id],
      );
      hasSuccessfulPayment = successCheckRes.rows.length > 0;
    } catch (_) {
      // safe fallback
    }

    if (hasSuccessfulPayment) {
      logger.warn('Skipping booking cancellation on payment failure: booking has a successful payment', {
        bookingId: lockedPayment.booking_id,
        paymentId: lockedPayment.id,
      });
      return { processed: true, status: PAYMENT_STATUS.FAILED, bookingCancelled: false, reason: 'SUCCESSFUL_PAYMENT_EXISTS' };
    }

    // 3. Lock associated booking row to check eligibility
    let booking = null;
    try {
      const bookingRes = await client.query(
        `SELECT id, customer_id, vehicle_id, status
         FROM bookings
         WHERE id = $1
         FOR UPDATE`,
        [lockedPayment.booking_id],
      );
      booking = bookingRes.rows[0];
    } catch (_) {
      const bookingRes = await client.query(
        `SELECT id, customer_id, vehicle_id, status
         FROM bookings
         WHERE id = $1`,
        [lockedPayment.booking_id],
      );
      booking = bookingRes.rows[0];
    }

    if (!booking) {
      return { processed: true, status: PAYMENT_STATUS.FAILED, bookingCancelled: false, reason: 'BOOKING_NOT_FOUND' };
    }

    const currentStatus = String(booking.status || '').toLowerCase();
    const currentBookingStatus = String(booking.booking_status || '').toUpperCase();

    // Already cancelled or refunded
    if (currentStatus === 'cancelled' || currentStatus === 'refunded' || currentBookingStatus === 'CANCELLED') {
      return { processed: true, status: PAYMENT_STATUS.FAILED, bookingCancelled: false, reason: 'ALREADY_CANCELLED' };
    }

    // Confirmed or active rental cannot be cancelled by a failed payment attempt
    if (
      currentStatus === 'confirmed' ||
      currentStatus === 'payment_completed' ||
      currentStatus === 'pickup_scheduled' ||
      currentStatus === 'vehicle_picked' ||
      currentStatus === 'in_progress' ||
      currentStatus === 'completed' ||
      currentBookingStatus === 'CONFIRMED' ||
      currentBookingStatus === 'ACTIVE' ||
      currentBookingStatus === 'COMPLETED'
    ) {
      logger.warn('Skipping booking cancellation: booking is already confirmed or active', {
        bookingId: booking.id,
        status: currentStatus,
      });
      return { processed: true, status: PAYMENT_STATUS.FAILED, bookingCancelled: false, reason: 'BOOKING_NOT_ELIGIBLE' };
    }

    const resolvedReason = cancellationReason || failureReason || 'PAYMENT_FAILED';

    // 4. Transition booking to cancelled defensively across schema variations
    let updatedBooking = false;
    try {
      await withSavepoint(client, 'sp_booking_cancel', () => client.query(
        `UPDATE bookings
         SET status = 'cancelled',
             cancellation_reason = $1,
             cancelled_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [resolvedReason, booking.id],
      ));
      updatedBooking = true;
    } catch (_) {}

    if (!updatedBooking) {
      try {
        await withSavepoint(client, 'sp_booking_cancel_fallback', () => client.query(
          `UPDATE bookings
           SET status = 'cancelled',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [booking.id],
        ));
        updatedBooking = true;
      } catch (_) {
        try {
          await withSavepoint(client, 'sp_booking_cancel_bstatus_only', () => client.query(
            `UPDATE bookings
             SET booking_status = 'CANCELLED',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [booking.id],
          ));
          updatedBooking = true;
        } catch (_) {}
      }
    }

    // Also sync optional booking_status column if present
    try {
      await withSavepoint(client, 'sp_booking_cancel_bstatus', () => client.query(
        `UPDATE bookings
         SET booking_status = 'CANCELLED'
         WHERE id = $1`,
        [booking.id],
      ));
    } catch (_) {}

    // 5. Insert into booking_cancellations
    try {
      await withSavepoint(client, 'sp_booking_cancellations_insert', () => client.query(
        `INSERT INTO booking_cancellations (
           booking_id, cancelled_by, cancellation_reason, cancelled_at
         ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (booking_id) DO UPDATE
         SET cancellation_reason = EXCLUDED.cancellation_reason,
             cancelled_at = EXCLUDED.cancelled_at`,
        [booking.id, booking.customer_id, resolvedReason],
      ));
    } catch {
      // Ignored if booking_cancellations schema differs
    }

    // 6. Release vehicle availability to IDLE
    try {
      await withSavepoint(client, 'sp_vehicle_idle', () => client.query(
        `UPDATE vehicles
         SET rental_status = 'IDLE', updated_at = CURRENT_TIMESTAMP
         WHERE id = (SELECT vehicle_id FROM bookings WHERE id = $1)
           AND rental_status != 'ACTIVE'`,
        [booking.id],
      ));
    } catch {
      // Safe fallback if rental_status column not present
    }

    // 7. Insert into booking_status_history
    try {
      await withSavepoint(client, 'sp_status_history', () => client.query(
        `INSERT INTO booking_status_history (
           id, booking_id, old_status, new_status, changed_by, change_reason, created_at
         ) VALUES (gen_random_uuid(), $1, $2, 'cancelled', NULL, $3, CURRENT_TIMESTAMP)`,
        [booking.id, booking.status, resolvedReason],
      ));
    } catch {
      // Non-fatal if table not present in test db
    }

    // 8. Send notification to customer
    try {
      await (this.notificationService || notificationService).sendNotification({
        customerId: booking.customer_id,
        type: NOTIFICATION_TYPES.BOOKING_CANCELLED,
        title: 'Booking Cancelled',
        body: 'Your booking was cancelled due to payment failure.',
        data: {
          bookingId: booking.id,
          paymentId: lockedPayment.id,
          reason: resolvedReason,
        },
        eventKey: `BOOKING_CANCELLED:payment_failed:${booking.id}`,
      });
    } catch (notifErr) {
      logger.warn('Failed to dispatch booking cancellation notification', {
        bookingId: booking.id,
        error: notifErr.message,
      });
    }

    logger.info('Booking transitioned to CANCELLED following confirmed payment failure', {
      bookingId: booking.id,
      paymentId: lockedPayment.id,
      reason: resolvedReason,
    });

    return { processed: true, status: PAYMENT_STATUS.FAILED, bookingCancelled: true };
  }

  /**
   * Processes verified webhook event from Cashfree.
   *
   * @param {object} headers
   * @param {string} rawBody
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async processWebhook(headers, rawBody, payload) {
    // 1. Cryptographic HMAC-SHA256 signature verification
    const isValidSignature = this.provider.verifyWebhookSignature(headers, rawBody);
    if (!isValidSignature) {
      logger.warn('Cashfree webhook rejected due to invalid signature', {
        headersReceived: Object.keys(headers || {}),
      });
      throw new BadRequestError(
        'Invalid webhook signature',
        PAYMENT_ERROR_CODES.INVALID_WEBHOOK_SIGNATURE,
      );
    }

    // 2. Extract order and payment data from standard Cashfree payload
    const orderData = payload?.data?.order || payload?.order || {};
    const paymentData = payload?.data?.payment || payload?.payment || {};

    const providerOrderId = orderData.order_id
      || payload?.data?.order_id
      || payload?.order_id;

    if (!providerOrderId) {
      logger.warn('Cashfree webhook payload missing order_id');
      return { processed: false, reason: 'MISSING_ORDER_ID' };
    }

    const eventStatus = (
      paymentData.payment_status
      || payload?.type
      || payload?.event
      || ''
    ).toUpperCase();

    if (this.provider.envMode === 'PRODUCTION') {
      logger.info('[CASHFREE] Production webhook received', { providerOrderId, eventStatus });
    }

    let providerPaymentId = null;
    if (paymentData.cf_payment_id) {
      providerPaymentId = String(paymentData.cf_payment_id);
    } else if (payload && payload.payment_id) {
      providerPaymentId = String(payload.payment_id);
    }

    let eventAmount;
    if (paymentData.payment_amount !== undefined) {
      eventAmount = Number(paymentData.payment_amount);
    } else if (orderData.order_amount !== undefined) {
      eventAmount = Number(orderData.order_amount);
    } else if (payload && payload.order_amount !== undefined) {
      eventAmount = Number(payload.order_amount);
    } else {
      eventAmount = NaN;
    }

    const eventCurrency = paymentData.payment_currency
      || orderData.order_currency
      || payload.order_currency
      || 'INR';

    // 3. Process inside transactional lock
    let mismatchError = null;
    const result = await this.paymentRepository.transaction(async (client) => {
      const lockedPayment = await this.paymentRepository.lockByProviderOrderId(
        providerOrderId,
        client,
      );

      if (!lockedPayment) {
        logger.warn('Webhook received for unknown provider order ID', { providerOrderId });
        return { processed: false, reason: 'PAYMENT_NOT_FOUND' };
      }

      // Idempotency: If already SUCCESS / PAID, do not duplicate side-effects
      const currentStatus = (lockedPayment.status || '').toLowerCase();
      if (currentStatus === 'paid' || currentStatus === 'success') {
        logger.info('Webhook idempotent: payment already marked SUCCESS', {
          paymentId: lockedPayment.id,
          providerOrderId,
        });
        return { processed: true, alreadyProcessed: true };
      }

      const isSuccessEvent = (
        eventStatus === 'SUCCESS'
        || eventStatus === 'PAYMENT_SUCCESS'
        || eventStatus === 'PAYMENT_SUCCESS_WEBHOOK'
      );

      if (isSuccessEvent) {
        // Amount and Currency reconciliation check
        const expectedAmount = Number(lockedPayment.amount);
        if (!Number.isNaN(eventAmount) && Math.abs(expectedAmount - eventAmount) > 0.01) {
          logger.error('Payment amount mismatch during webhook reconciliation', {
            providerOrderId,
            expectedAmount,
            receivedAmount: eventAmount,
          });
          await this._applyPaymentFailure(client, lockedPayment, {
            failureReason: 'AMOUNT_MISMATCH',
            providerPaymentId,
            cancellationReason: 'AMOUNT_MISMATCH',
          });
          mismatchError = new BadRequestError(
            'Payment amount mismatch',
            PAYMENT_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH,
          );
          return { processed: false, reason: 'AMOUNT_MISMATCH' };
        }

        if (eventCurrency && eventCurrency !== lockedPayment.currency) {
          logger.error('Payment currency mismatch during webhook reconciliation', {
            providerOrderId,
            expectedCurrency: lockedPayment.currency,
            receivedCurrency: eventCurrency,
          });
          await this._applyPaymentFailure(client, lockedPayment, {
            failureReason: 'CURRENCY_MISMATCH',
            providerPaymentId,
            cancellationReason: 'CURRENCY_MISMATCH',
          });
          mismatchError = new BadRequestError(
            'Payment currency mismatch',
            PAYMENT_ERROR_CODES.PAYMENT_CURRENCY_MISMATCH,
          );
          return { processed: false, reason: 'CURRENCY_MISMATCH' };
        }

        let paymentMethod = 'ONLINE';
        if (typeof paymentData.payment_method === 'string') {
          paymentMethod = paymentData.payment_method;
        } else if (paymentData.payment_method) {
          paymentMethod = JSON.stringify(paymentData.payment_method);
        }

        return this._applyPaymentSuccess(client, lockedPayment, {
          providerOrderId,
          providerPaymentId,
          paymentMethod,
        });
      }

      // Handle Failure / Dropped / Cancelled events
      const isFailureEvent = (
        eventStatus === 'FAILED'
        || eventStatus === 'USER_DROPPED'
        || eventStatus === 'CANCELLED'
        || eventStatus === 'PAYMENT_FAILED_WEBHOOK'
      );

      if (isFailureEvent) {
        const failureReason = paymentData.payment_message || eventStatus;
        const cancellationReason = (
          eventStatus === 'USER_DROPPED'
          || eventStatus === 'CANCELLED'
          || (failureReason && (String(failureReason).toLowerCase().includes('cancel') || String(failureReason).toLowerCase().includes('drop')))
        ) ? 'PAYMENT_CANCELLED' : 'PAYMENT_FAILED';

        return this._applyPaymentFailure(client, lockedPayment, {
          failureReason,
          providerPaymentId,
          cancellationReason,
        });
      }

      return { processed: true, status: lockedPayment.status };
    });

    if (mismatchError) {
      throw mismatchError;
    }

    return result;
  }

  /**
   * Sandbox-only helper: Cryptographically signs and processes a simulated Cashfree webhook.
   * Enables comprehensive end-to-end testing in Cashfree Sandbox mode.
   *
   * @param {object} params
   * @param {string} params.customerId Authenticated customer; must own the payment
   * @param {string} [params.bookingId]
   * @param {string} [params.orderId]
   * @param {string} [params.paymentStatus='SUCCESS']
   * @returns {Promise<object>}
   */
  async simulateCashfreeWebhook({ customerId, bookingId, orderId, paymentStatus = 'SUCCESS' }) {
    // Disabled in production regardless of Cashfree mode: it marks the caller's own
    // booking paid without any real payment.
    const isCashfreeProd = (this.provider?.envMode || '').toUpperCase() === 'PRODUCTION';
    if (process.env.NODE_ENV === 'production' || env.NODE_ENV === 'production' || isCashfreeProd) {
      throw new ForbiddenError('Test webhook simulation is disabled in production', 'FORBIDDEN');
    }

    let payment;
    if (bookingId) {
      payment = await this.paymentRepository.findLatestByBookingId(bookingId);
    }
    if (!payment && orderId) {
      payment = await this.paymentRepository.findByProviderOrderId(orderId);
    }

    // Respond identically for missing and foreign payments to avoid leaking booking existence
    if (!payment || !customerId || payment.customerId !== customerId) {
      throw new NotFoundError('Payment record not found for webhook simulation', PAYMENT_ERROR_CODES.PAYMENT_NOT_FOUND);
    }

    const providerOrderId = payment.providerOrderId || orderId || payment.id;
    if (!payment.providerOrderId && providerOrderId) {
      await this.paymentRepository.query(
        'UPDATE payments SET provider_order_id = $1 WHERE id = $2',
        [providerOrderId, payment.id]
      ).catch(() => { });
    }

    const amount = Number(payment.amount);
    const currency = payment.currency || 'INR';
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const webhookBody = {
      data: {
        order: {
          order_id: providerOrderId,
          order_amount: amount,
          order_currency: currency,
        },
        payment: {
          cf_payment_id: `cf_test_pay_${Date.now()}`,
          payment_status: paymentStatus.toUpperCase(),
          payment_amount: amount,
          payment_currency: currency,
          payment_method: 'UPI',
        },
      },
      type: paymentStatus.toUpperCase() === 'SUCCESS' ? 'PAYMENT_SUCCESS_WEBHOOK' : 'PAYMENT_FAILED_WEBHOOK',
      event_time: new Date().toISOString(),
    };

    const rawBody = JSON.stringify(webhookBody);
    const dataToSign = `${timestamp}${rawBody}`;
    const secretKey = this.provider.secretKey || env.CASHFREE_SECRET_KEY || 'test_cashfree_secret_key';
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(dataToSign)
      .digest('base64');

    const headers = {
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': signature,
    };

    return this.processWebhook(headers, rawBody, webhookBody);
  }

  /**
   * Directly bypasses payment for a booking in development mode.
   * Sets payment to paid and booking status to confirmed.
   *
   * @param {string} customerId
   * @param {string} bookingId
   * @returns {Promise<object>}
   */
  async devBypassPayment(customerId, bookingId) {
    const isCashfreeProd = (this.provider?.envMode || '').toUpperCase() === 'PRODUCTION';
    const isProd = process.env.NODE_ENV === 'production' || env.NODE_ENV === 'production' || isCashfreeProd;
    const isDevFlagEnabled =
      (Boolean(env.DEV_DUMMY_PAYMENT_ENABLED) || process.env.DEV_DUMMY_PAYMENT_ENABLED === 'true') &&
      process.env.DEV_DUMMY_PAYMENT_ENABLED !== 'false';
    // Never in production, even with the flag set (it marks bookings paid for free).
    const isDevAllowed = !isProd && isDevFlagEnabled;

    if (!isDevAllowed) {
      throw new ForbiddenError(
        'Dev bypass payment is disabled in this environment',
        'DEV_PAYMENT_DISABLED',
      );
    }

    const booking = await this.bookingRepository.findByIdAndCustomerId(bookingId, customerId);
    if (!booking) {
      throw new NotFoundError('Booking not found', PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND);
    }

    const depositAmount = Number(
      booking.pricingSnapshot?.securityDeposit ||
      booking.securityDeposit ||
      booking.security_deposit ||
      0
    );
    const payableAmount = Number(
      booking.pricingSnapshot?.payableAmount ||
      booking.payableAmount ||
      booking.payable_amount ||
      (booking.pricingSnapshot?.subtotal !== undefined
        ? Number(booking.pricingSnapshot.subtotal)
        : Math.max(0, Number(booking.pricingSnapshot?.totalAmount || booking.totalAmount || 0) - depositAmount))
    );
    const onlinePaymentAmount = payableAmount > 0
      ? payableAmount
      : Math.max(0, Number(booking.pricingSnapshot?.totalAmount || booking.totalAmount || 0) - depositAmount);

    const devPaymentRef = `DEV_PAYMENT_${booking.id}`;
    const paymentNumber = `PAY-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    let payment = await this.paymentRepository.findLatestByBookingId(bookingId);
    if (payment) {
      await this.paymentRepository.query(
        `UPDATE payments
         SET status = 'paid',
             paid_at = CURRENT_TIMESTAMP,
             payment_method = 'other',
             amount = $1,
             provider_payment_id = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [onlinePaymentAmount, devPaymentRef, payment.id],
      );
      payment.status = 'paid';
      payment.amount = onlinePaymentAmount;
      payment.paidAt = new Date().toISOString();
    } else {
      let orderRef = null;
      try {
        const { generateUniqueEntityReference } = require('../utils/reference-generator');
        orderRef = await generateUniqueEntityReference(this.paymentRepository, 'payments', 'order_reference', 'ORD');
      } catch {
        orderRef = null;
      }
      const insertSql = `
        INSERT INTO payments (
          booking_id, customer_id, partner_id, payment_number,
          amount, currency, payment_method, status, paid_at,
          payment_type, provider_order_id, provider_payment_id, order_reference
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9, $10, $11, COALESCE($12, ('ORD-' || upper(substr(md5(random()::text), 1, 6)))))
        RETURNING *;
      `;
      const pRes = await this.paymentRepository.query(insertSql, [
        booking.id,
        customerId,
        booking.partnerId || booking.partner_id || null,
        paymentNumber,
        onlinePaymentAmount,
        'INR',
        'other',
        'paid',
        'BOOKING_ADVANCE',
        devPaymentRef,
        devPaymentRef,
        orderRef,
      ]);
      payment = pRes.rows[0];
    }

    // Update booking status to confirmed and payment_status to PAID
    await this.bookingRepository.updateStatus(bookingId, customerId, 'confirmed');
    try {
      await this.bookingRepository.query(
        `UPDATE bookings
         SET payment_status = 'PAID',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [bookingId],
      );
    } catch {
      // non-fatal
    }

    // Reserve vehicle
    if (booking.vehicleId || booking.vehicle_id) {
      try {
        await this.bookingRepository.query(
          `UPDATE vehicles
           SET rental_status = 'RESERVED',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [booking.vehicleId || booking.vehicle_id],
        );
      } catch {
        // non-fatal
      }
    }

    // Notify partner
    try {
      const partnerId = booking.partnerId || booking.partner_id;
      if (partnerId) {
        const vName = booking.vehicle?.vehicleName || 'Vehicle';
        await this.paymentRepository.query(
          `INSERT INTO partner_notifications (
             partner_id, type, title, body, payload, event_key
           ) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (partner_id, event_key) DO NOTHING;`,
          [
            partnerId,
            'BOOKING_CREATED',
            'New Booking Received (Dev Bypass)',
            `Booking #${booking.bookingNumber || booking.id} for ${vName} confirmed via Dev Bypass. Amount: ₹${onlinePaymentAmount}`,
            JSON.stringify({ bookingId: booking.id, amount: onlinePaymentAmount }),
            `DEV_BYPASS:booking:${booking.id}:${Date.now()}`,
          ],
        );
      }
    } catch {
      // non-fatal
    }

    // Notify customer
    try {
      const notificationService = require('./notification.service');
      const service = notificationService.default || notificationService;
      if (service?.sendNotification) {
        const bRef = booking.bookingReference || booking.bookingNumber;
        const oRef = payment?.order_reference || payment?.orderReference;
        await service.sendNotification({
          customerId,
          type: 'BOOKING_CONFIRMED',
          title: 'Booking Confirmed 🎉',
          body: bRef
            ? `Your booking ${bRef} for ${booking.vehicle?.vehicleName || 'vehicle'} has been confirmed via Dev Bypass.`
            : `Your booking for ${booking.vehicle?.vehicleName || 'vehicle'} has been confirmed via Dev Bypass.`,
          data: {
            bookingId: booking.id,
            bookingReference: bRef,
            orderReference: oRef,
          },
          eventKey: `BOOKING_CONFIRMED:booking:${booking.id}:${customerId}`,
        });
      }
    } catch {
      // non-fatal
    }

    const updatedBooking = await this.bookingRepository.findByIdAndCustomerId(bookingId, customerId);
    return {
      booking: updatedBooking || booking,
      payment,
      success: true,
    };
  }
}

const paymentServiceInstance = new PaymentService();
paymentServiceInstance.PaymentService = PaymentService;
module.exports = paymentServiceInstance;
