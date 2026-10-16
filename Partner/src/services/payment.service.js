'use strict';

const bookingRepository = require('../repositories/booking.repository');
const paymentRepository = require('../repositories/payment.repository');
const cashfreeProvider = require('../providers/cashfree.provider');
const WalletRepository = require('../repositories/wallet.repository');
const WalletTransactionRepository = require('../repositories/wallet-transaction.repository');
const EarningsRepository = require('../repositories/earnings.repository');
const PayoutRepository = require('../repositories/payout.repository');
const NotificationRepository = require('../repositories/notification.repository');
const { pool } = require('../db/pool');
const {
  PAYMENT_STATUS,
  PAYMENT_TYPE,
  SETTLEMENT_STATUS,
  PAYMENT_ERROR_CODES,
} = require('../constants/payment');
const {
  WALLET_TRANSACTION_TYPE,
  TRANSACTION_DIRECTION,
  TRANSACTION_STATUS,
  WALLET_REFERENCE_TYPE,
} = require('../constants/wallet');
const { NotFoundError, BadRequestError } = require('../errors');
const logger = require('../config/logger');
const metrics = require('../utils/metrics');
const outboxService = require('./outbox.service');

/**
 * PaymentService — Orchestrates post-rental settlement lookups, payment audit history,
 * and cryptographic Cashfree webhook handling.
 *
 * CRITICAL BUSINESS LOCKS:
 * 1. The Customer is the sole payer and payment-order initiator (Customer Backend).
 * 2. Partner endpoints are strictly READ-ONLY (operational visibility).
 * 3. Payable amount is derived strictly from server records (late_fee + extra_km_fee).
 * 4. damage_reports.estimated_amount is NOT payable; damage collection is deferred.
 * 5. Reuses Customer Backend PG v2023-08-01 cryptographic verification & reconciliation.
 * 6. Phase 12A: Atomically credits Partner wallet and appends immutable ledger entry on settlement.
 * 7. Phase 12C: Records partner earnings synchronized with settlement wallet transactions.
 * 8. Phase 13: Handles Cashfree Payout webhooks for automated transfer completion or reversal.
 */
class PaymentService {
  constructor(
    bookingRepo = bookingRepository,
    paymentRepo = paymentRepository,
    provider = cashfreeProvider,
    walletRepo = new WalletRepository(),
    walletTxRepo = new WalletTransactionRepository(),
    earningsRepo = new EarningsRepository(),
    payoutRepo = new PayoutRepository(),
    notificationRepo = new NotificationRepository(),
  ) {
    this.bookingRepository = bookingRepo;
    this.paymentRepository = paymentRepo;
    this.provider = provider;
    this.walletRepository = walletRepo;
    this.walletTransactionRepository = walletTxRepo;
    this.earningsRepository = earningsRepo;
    this.payoutRepository = payoutRepo;
    this.notificationRepository = notificationRepo;
  }

  /**
   * Retrieves post-rental settlement charges breakdown and payment status for a booking.
   * Enforces Partner BOLA / double ownership.
   *
   * @param {string} partnerId
   * @param {string} bookingId
   * @returns {Promise<object>}
   */
  async getSettlementDetails(partnerId, bookingId) {
    // 1. Enforce Partner BOLA / double ownership check
    const booking = await this.bookingRepository.findPartnerBookingById(partnerId, bookingId);
    if (!booking) {
      throw new NotFoundError('Booking not found', PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND);
    }

    // 2. Fetch return inspection records
    const returnVerif = await this.bookingRepository.findReturnVerificationByBookingId(booking.id);
    const lateMinutes = returnVerif ? Number(returnVerif.late_minutes || 0) : 0;
    const lateFee = returnVerif ? Number(returnVerif.late_fee || 0) : 0;
    const extraKm = returnVerif ? Number(returnVerif.extra_km || 0) : 0;
    const extraKmFee = returnVerif ? Number(returnVerif.extra_km_fee || 0) : 0;

    // 3. Fetch damage reports (informative assessment only; estimatedAmount is NEVER payable)
    const damages = await this.bookingRepository.findDamageReportsByBookingId(booking.id);

    // 4. Server-authoritative post-rental payable amount: ONLY late_fee + extra_km_fee
    const totalSettlementPayable = Number((lateFee + extraKmFee).toFixed(2));

    // 5. Check post-rental settlement payment status
    const settlementPayment = await this.paymentRepository.findLatestByBookingAndType(
      booking.id,
      PAYMENT_TYPE.POST_RENTAL_SETTLEMENT,
    );

    let settlementStatus;
    if (totalSettlementPayable <= 0) {
      settlementStatus = SETTLEMENT_STATUS.NO_CHARGE;
    } else if (settlementPayment && settlementPayment.status === PAYMENT_STATUS.SUCCESS) {
      settlementStatus = SETTLEMENT_STATUS.PAID;
    } else if (settlementPayment && settlementPayment.status === PAYMENT_STATUS.PENDING) {
      settlementStatus = SETTLEMENT_STATUS.PAYMENT_PENDING;
    } else {
      settlementStatus = SETTLEMENT_STATUS.UNPAID;
    }

    return {
      bookingId: booking.id,
      bookingNumber: booking.booking_number,
      vehicleId: booking.vehicle_id,
      registrationNumber: booking.registration_number,
      returnVerification: returnVerif ? {
        returnedAt: returnVerif.returned_at,
        odometerEnd: returnVerif.odometer_end !== null ? Number(returnVerif.odometer_end) : null,
        lateMinutes,
        lateFee,
        extraKm,
        extraKmFee,
        returnStatus: returnVerif.return_status,
      } : null,
      damageReports: (damages || []).map((d) => ({
        id: d.id,
        damageType: d.damage_type,
        description: d.description,
        estimatedAmount: Number(d.estimated_amount),
        status: d.status,
        action: 'DEFERRED_APPROVAL',
        note: 'Damage estimates are not payable in Phase 11. Collection is deferred until formal approval.',
      })),
      charges: {
        lateFee,
        extraKmFee,
        approvedDamageFee: 0.00,
        totalSettlementPayable,
      },
      settlementStatus,
      payment: settlementPayment ? {
        id: settlementPayment.id,
        paymentType: settlementPayment.payment_type,
        provider: settlementPayment.provider,
        providerOrderId: settlementPayment.provider_order_id,
        amount: Number(settlementPayment.amount),
        currency: settlementPayment.currency,
        status: settlementPayment.status,
        createdAt: settlementPayment.created_at,
        updatedAt: settlementPayment.updated_at,
      } : null,
    };
  }

  /**
   * Retrieves complete payment history for a partner's booking.
   * Enforces Partner BOLA / double ownership.
   *
   * @param {string} partnerId
   * @param {string} bookingId
   * @returns {Promise<object>}
   */
  async getBookingPayments(partnerId, bookingId) {
    const booking = await this.bookingRepository.findPartnerBookingById(partnerId, bookingId);
    if (!booking) {
      throw new NotFoundError('Booking not found', PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND);
    }

    const payments = await this.paymentRepository.findAllByBookingId(booking.id);

    return {
      bookingId: booking.id,
      bookingNumber: booking.booking_number,
      totalPayments: payments.length,
      payments: payments.map((p) => ({
        id: p.id,
        paymentType: p.payment_type,
        provider: p.provider,
        providerOrderId: p.provider_order_id,
        providerPaymentId: p.provider_payment_id,
        amount: Number(p.amount),
        currency: p.currency,
        status: p.status,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    };
  }

  /**
   * Processes verified Cashfree webhook callback.
   * Uses raw byte body for cryptographic HMAC verification, enforces idempotency,
   * acquires row lock, and reconciles amount and currency.
   *
   * @param {object} headers
   * @param {string} rawBody
   * @param {object} payload
   * @returns {Promise<{processed: boolean, status?: string, reason?: string,
   *   duplicate?: boolean, alreadyProcessed?: boolean}>}
   */
  async processCashfreeWebhook(headers, rawBody, payload) {
    // 1. Cryptographic HMAC-SHA256 signature verification
    const isValidSignature = this.provider.verifyWebhookSignature(headers, rawBody);
    if (!isValidSignature) {
      logger.warn('Cashfree webhook rejected: signature invalid or outside replay window');
      throw new BadRequestError(
        'Invalid webhook signature',
        PAYMENT_ERROR_CODES.INVALID_WEBHOOK_SIGNATURE,
      );
    }

    // 2. Extract order and payment data from standard Cashfree PG v2023-08-01 payload
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
      || payload?.order_currency
      || 'INR';

    const eventId = paymentData.cf_payment_id
      ? String(paymentData.cf_payment_id)
      : (payload?.event_id || `${providerOrderId}_${eventStatus}_${Date.now()}`);

    // 3. Check event idempotency via payment_events table
    const alreadyProcessedEvent = await this.paymentRepository.isEventProcessed('CASHFREE', eventId);
    if (alreadyProcessedEvent) {
      logger.info('Cashfree webhook event already processed (idempotent)', {
        eventId,
        providerOrderId,
      });
      return { processed: true, duplicate: true };
    }

    // 4. Process inside transaction with row-level locking on payments table
    return this.paymentRepository.withTransaction(async (client) => {
      const lockedPayment = await this.paymentRepository.lockByProviderOrderId(
        providerOrderId,
        client,
      );

      if (!lockedPayment) {
        logger.warn('Cashfree webhook received for unknown provider order ID', {
          providerOrderId,
        });
        return { processed: false, reason: 'PAYMENT_NOT_FOUND' };
      }

      // Record event in payment_events table
      await this.paymentRepository.recordEvent({
        provider: 'CASHFREE',
        eventId,
        eventType: eventStatus || 'UNKNOWN',
        payload,
        isProcessed: true,
      }, client);

      // If payment already marked SUCCESS, safely return (idempotency)
      if (lockedPayment.status === PAYMENT_STATUS.SUCCESS) {
        logger.info('Webhook idempotent: payment already marked SUCCESS', {
          paymentId: lockedPayment.id,
          providerOrderId,
        });
        return { processed: true, alreadyProcessed: true, status: PAYMENT_STATUS.SUCCESS };
      }

      const isSuccessEvent = (
        eventStatus === 'SUCCESS'
        || eventStatus === 'PAYMENT_SUCCESS'
        || eventStatus === 'PAYMENT_SUCCESS_WEBHOOK'
      );

      if (isSuccessEvent) {
        // Amount reconciliation
        const expectedAmount = Number(lockedPayment.amount);
        if (!Number.isNaN(eventAmount) && Math.abs(expectedAmount - eventAmount) > 0.01) {
          logger.error('Payment amount mismatch during webhook reconciliation', {
            providerOrderId,
            expectedAmount,
            receivedAmount: eventAmount,
          });
          await this.paymentRepository.updateStatus(
            lockedPayment.id,
            PAYMENT_STATUS.FAILED,
            { metadata: { failureReason: 'AMOUNT_MISMATCH', receivedAmount: eventAmount } },
            client,
          );
          throw new BadRequestError(
            'Payment amount mismatch',
            PAYMENT_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH,
          );
        }

        // Currency reconciliation
        if (eventCurrency && eventCurrency !== lockedPayment.currency) {
          logger.error('Payment currency mismatch during webhook reconciliation', {
            providerOrderId,
            expectedCurrency: lockedPayment.currency,
            receivedCurrency: eventCurrency,
          });
          await this.paymentRepository.updateStatus(
            lockedPayment.id,
            PAYMENT_STATUS.FAILED,
            { metadata: { failureReason: 'CURRENCY_MISMATCH', receivedCurrency: eventCurrency } },
            client,
          );
          throw new BadRequestError(
            'Payment currency mismatch',
            PAYMENT_ERROR_CODES.PAYMENT_CURRENCY_MISMATCH,
          );
        }

        // Mark payment SUCCESS
        await this.paymentRepository.updateStatus(
          lockedPayment.id,
          PAYMENT_STATUS.SUCCESS,
          {
            providerPaymentId,
            metadata: {
              settledAt: new Date().toISOString(),
              eventStatus,
            },
          },
          client,
        );

        logger.info('Payment marked SUCCESS via Cashfree webhook', {
          paymentId: lockedPayment.id,
          providerOrderId,
          amount: lockedPayment.amount,
        });

        // Phase 12A: If post-rental settlement or overtime charge, credit Partner wallet
        // and record immutable ledger entry
        if (lockedPayment.payment_type === PAYMENT_TYPE.POST_RENTAL_SETTLEMENT || lockedPayment.payment_type === PAYMENT_TYPE.OVERTIME_CHARGE) {
          const bookingRes = await client.query(
            'SELECT id, partner_id, booking_number FROM bookings WHERE id = $1',
            [lockedPayment.booking_id],
          );
          const bookingRow = bookingRes.rows[0];
          if (!bookingRow || !bookingRow.partner_id) {
            logger.error('Settlement credit aborted: booking or partner not found', {
              bookingId: lockedPayment.booking_id,
              paymentId: lockedPayment.id,
            });
            throw new NotFoundError(
              'Booking or partner not found for settlement credit',
              PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND,
            );
          }

          // Check if settlement credit ledger entry already exists (Idempotency barrier)
          const existingTx = await this.walletTransactionRepository.findByReference({
            referenceType: WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT,
            referenceId: lockedPayment.id,
            direction: TRANSACTION_DIRECTION.CREDIT,
            client,
          });

          if (!existingTx) {
            const settlementAmount = Number(lockedPayment.amount);
            if (Number.isNaN(settlementAmount) || settlementAmount <= 0) {
              logger.error('Settlement credit aborted: invalid payment amount', {
                amount: lockedPayment.amount,
                paymentId: lockedPayment.id,
              });
              throw new BadRequestError(
                'Invalid settlement payment amount',
                PAYMENT_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH,
              );
            }

            // Atomically lock wallet and update balances
            const creditResult = await this.walletRepository.creditWallet(
              bookingRow.partner_id,
              settlementAmount,
              client,
            );

            if (!creditResult) {
              logger.error('Settlement credit aborted: partner wallet not found', {
                partnerId: bookingRow.partner_id,
                paymentId: lockedPayment.id,
              });
              throw new NotFoundError(
                'Partner wallet not found for settlement credit',
                PAYMENT_ERROR_CODES.BOOKING_NOT_FOUND,
              );
            }

            // Append immutable transaction ledger entry
            const ledgerEntry = await this.walletTransactionRepository.createLedgerEntry({
              walletId: creditResult.wallet.id,
              partnerId: bookingRow.partner_id,
              transactionType: WALLET_TRANSACTION_TYPE.SETTLEMENT_PAYMENT,
              direction: TRANSACTION_DIRECTION.CREDIT,
              amount: settlementAmount,
              balanceAfter: creditResult.newAvailable,
              referenceType: WALLET_REFERENCE_TYPE.POST_RENTAL_SETTLEMENT,
              referenceId: lockedPayment.id,
              status: TRANSACTION_STATUS.COMPLETED,
              description: `Post-rental settlement credit for booking #${bookingRow.booking_number}`,
              metadata: {
                bookingId: lockedPayment.booking_id,
                paymentId: lockedPayment.id,
                providerOrderId: lockedPayment.provider_order_id,
                lateFee: Number(lockedPayment.metadata?.lateFee || 0),
                extraKmFee: Number(lockedPayment.metadata?.extraKmFee || 0),
              },
            }, client);

            // Phase 12C: Record synchronized partner earnings record
            if (this.earningsRepository && typeof this.earningsRepository.upsertBookingEarning === 'function') {
              await this.earningsRepository.upsertBookingEarning({
                bookingId: lockedPayment.booking_id,
                partnerId: bookingRow.partner_id,
                grossAmount: settlementAmount,
                partnerNetAmount: settlementAmount,
                settlementStatus: 'SETTLED',
                walletTransactionId: ledgerEntry.id,
                settledAt: new Date().toISOString(),
              }, client);
            }

            logger.info('Partner wallet credited and ledger entry created for settlement', {
              partnerId: bookingRow.partner_id,
              walletId: creditResult.wallet.id,
              paymentId: lockedPayment.id,
              amount: settlementAmount,
              balanceAfter: creditResult.newAvailable,
            });
          } else {
            logger.info('Settlement credit already recorded in ledger (idempotent)', {
              paymentId: lockedPayment.id,
              txId: existingTx.id,
            });
          }

          // Notify partner (preserving existing notification behavior)
          try {
            await client.query(
              `INSERT INTO partner_notifications (
                partner_id, type, title, body, payload, event_key
              ) VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (partner_id, event_key) DO NOTHING`,
              [
                bookingRow.partner_id,
                'POST_RENTAL_SETTLEMENT_SUCCESS',
                'Post-Rental Settlement Received',
                `Post-rental charges of ₹${lockedPayment.amount} for booking #${bookingRow.booking_number} have been collected.`,
                JSON.stringify({
                  bookingId: lockedPayment.booking_id,
                  paymentId: lockedPayment.id,
                  amount: lockedPayment.amount,
                }),
                `SETTLEMENT_PAID:${lockedPayment.id}`,
              ],
            );
          } catch (notifErr) {
            logger.warn('Failed to dispatch partner notification for settlement payment', {
              paymentId: lockedPayment.id,
              error: notifErr.message,
            });
          }

          // Atomic outbox event registration for guaranteed asynchronous side-effects
          await outboxService.recordEvent({
            eventType: 'SETTLEMENT_RECEIVED',
            aggregateType: 'PAYMENT',
            aggregateId: lockedPayment.id,
            payload: {
              partnerId: bookingRow.partner_id,
              paymentId: lockedPayment.id,
              bookingId: lockedPayment.booking_id,
              amount: Number(lockedPayment.amount),
            },
          }, client);

          metrics.recordSettlementWebhook(true);
        }

        return { processed: true, status: PAYMENT_STATUS.SUCCESS };
      }

      // Handle Failure / Dropped / Cancelled events
      const isFailureEvent = (
        eventStatus === 'FAILED'
        || eventStatus === 'USER_DROPPED'
        || eventStatus === 'CANCELLED'
        || eventStatus === 'PAYMENT_FAILED_WEBHOOK'
      );

      if (isFailureEvent) {
        await this.paymentRepository.updateStatus(
          lockedPayment.id,
          PAYMENT_STATUS.FAILED,
          {
            providerPaymentId,
            metadata: {
              failureReason: paymentData.payment_message || eventStatus,
              failedAt: new Date().toISOString(),
            },
          },
          client,
        );

        logger.info('Payment marked FAILED via Cashfree webhook', {
          paymentId: lockedPayment.id,
          providerOrderId,
          reason: paymentData.payment_message || eventStatus,
        });

        return { processed: true, status: PAYMENT_STATUS.FAILED };
      }

      return { processed: true, status: lockedPayment.status };
    });
  }

  /**
   * Cryptographically verifies and processes Cashfree Payout Webhooks.
   * On SUCCESS: Marks payout COMPLETED, records transfer ID, notifies partner.
   * On FAILED / REVERSED: Atomically reverses wallet debit, creates immutable
   * PAYOUT_REVERSAL ledger entry, marks payout FAILED, and notifies partner.
   *
   * @param {object} params
   * @param {object} params.headers
   * @param {string} params.rawBody
   * @param {object} params.payload
   * @returns {Promise<object>}
   */
  async processCashfreePayoutWebhook({ headers, rawBody, payload }) {
    // 1. Cryptographic HMAC signature verification & replay protection
    const isValidSignature = this.provider.verifyWebhookSignature(headers, rawBody);
    if (!isValidSignature) {
      logger.warn('Cashfree payout webhook rejected: invalid cryptographic signature');
      throw new BadRequestError(
        'Invalid webhook signature',
        PAYMENT_ERROR_CODES.INVALID_WEBHOOK_SIGNATURE,
      );
    }

    // 2. Extract event attributes
    const rawEvent = payload?.event
      || payload?.event_type
      || payload?.type
      || payload?.data?.event
      || payload?.data?.status
      || payload?.status
      || '';
    const normalizedEventType = String(rawEvent).toUpperCase();

    const transferId = payload?.data?.transfer_id
      || payload?.data?.transferId
      || payload?.transfer_id
      || payload?.transferId
      || null;

    const referenceId = payload?.data?.reference_id
      || payload?.data?.referenceId
      || payload?.reference_id
      || payload?.referenceId
      || null;

    const failureReason = payload?.data?.reason
      || payload?.data?.failure_reason
      || payload?.reason
      || payload?.message
      || 'Payout transfer failed at provider';

    const eventId = payload?.event_id
      || payload?.data?.event_id
      || (transferId ? `${transferId}_${normalizedEventType}` : null)
      || (referenceId ? `${referenceId}_${normalizedEventType}` : null)
      || `PAYOUT_${Date.now()}`;

    // 3. Idempotency check via payment_events
    const alreadyProcessed = await this.paymentRepository.isEventProcessed(
      'CASHFREE_PAYOUT',
      eventId,
    );
    if (alreadyProcessed) {
      logger.info('Cashfree payout webhook already processed (idempotent)', { eventId });
      return { processed: true, duplicate: true };
    }

    // 4. Atomic transaction processing
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const payout = await this.payoutRepository.findByTransferOrReferenceIdForUpdate(
        { providerTransferId: transferId, referenceId },
        client,
      );

      if (!payout) {
        logger.warn('Payout record not found for payout webhook', { transferId, referenceId });
        await this.paymentRepository.recordEvent({
          provider: 'CASHFREE_PAYOUT',
          eventId,
          eventType: normalizedEventType,
          payload,
          isProcessed: true,
        }, client);
        await client.query('COMMIT');
        return { processed: false, reason: 'PAYOUT_NOT_FOUND' };
      }

      await this.paymentRepository.recordEvent({
        provider: 'CASHFREE_PAYOUT',
        eventId,
        eventType: normalizedEventType,
        payload,
        isProcessed: true,
      }, client);

      const isSuccess = ['TRANSFER_SUCCESS', 'SUCCESS', 'COMPLETED'].includes(normalizedEventType);
      const isFailure = [
        'TRANSFER_FAILED',
        'FAILED',
        'TRANSFER_REVERSED',
        'REVERSED',
        'CANCELLED',
      ].includes(normalizedEventType);

      if (isSuccess) {
        if (payout.status === 'COMPLETED') {
          await client.query('COMMIT');
          return { processed: true, alreadyProcessed: true, status: 'COMPLETED' };
        }

        await this.payoutRepository.updateStatus(payout.id, {
          status: 'COMPLETED',
          providerTransferId: transferId || payout.provider_transfer_id,
        }, client);

        await outboxService.recordEvent({
          eventType: 'PAYOUT_COMPLETED',
          aggregateType: 'PAYOUT',
          aggregateId: payout.id,
          payload: {
            partnerId: payout.partner_id,
            payoutId: payout.id,
            amount: payout.amount,
            transferId,
          },
        }, client);

        metrics.recordPayoutWebhook(true);

        await client.query('COMMIT');

        try {
          await this.notificationRepository.createNotification({
            partnerId: payout.partner_id,
            type: 'PAYOUT_COMPLETED',
            title: 'Payout Disbursed',
            body: `Your payout withdrawal of ₹${Number(payout.amount).toFixed(2)} has been successfully transferred to your bank account.`,
            payload: { payoutId: payout.id, amount: payout.amount, transferId },
            eventKey: `PAYOUT_COMPLETED:${payout.id}`,
          });
        } catch (notifErr) {
          logger.warn('Failed to dispatch payout success notification', {
            error: notifErr.message,
          });
        }

        return { processed: true, status: 'COMPLETED' };
      }

      if (isFailure) {
        if (['FAILED', 'CANCELLED'].includes(payout.status)) {
          await client.query('COMMIT');
          return { processed: true, alreadyProcessed: true, status: 'FAILED' };
        }

        const reversalAmount = Number(payout.amount);
        const reverseResult = await this.walletRepository.reverseDebitWallet(
          payout.partner_id,
          reversalAmount,
          client,
        );

        await this.walletTransactionRepository.createLedgerEntry({
          walletId: reverseResult.wallet.id,
          partnerId: payout.partner_id,
          transactionType: WALLET_TRANSACTION_TYPE.PAYOUT_REVERSAL,
          direction: TRANSACTION_DIRECTION.CREDIT,
          amount: reversalAmount,
          balanceAfter: reverseResult.newAvailable,
          referenceType: WALLET_REFERENCE_TYPE.PAYOUT_REVERSAL,
          referenceId: payout.id,
          status: TRANSACTION_STATUS.COMPLETED,
          description: `Payout webhook reversal: ${failureReason}`,
          metadata: {
            payoutId: payout.id,
            providerTransferId: transferId,
            failureReason,
          },
        }, client);

        await this.payoutRepository.updateStatus(payout.id, {
          status: 'FAILED',
          providerTransferId: transferId || payout.provider_transfer_id,
          failureReason,
        }, client);

        await outboxService.recordEvent({
          eventType: 'PAYOUT_REVERSED',
          aggregateType: 'PAYOUT',
          aggregateId: payout.id,
          payload: {
            partnerId: payout.partner_id,
            payoutId: payout.id,
            amount: payout.amount,
            failureReason,
          },
        }, client);

        metrics.recordPayoutWebhook(false);
        metrics.recordPayoutReversal();

        await client.query('COMMIT');

        try {
          await this.notificationRepository.createNotification({
            partnerId: payout.partner_id,
            type: 'PAYOUT_FAILED',
            title: 'Payout Failed & Balance Restored',
            body: `Your payout withdrawal of ₹${Number(payout.amount).toFixed(2)} could not be processed: ${failureReason}. The amount has been credited back to your wallet.`,
            payload: { payoutId: payout.id, amount: payout.amount, failureReason },
            eventKey: `PAYOUT_FAILED:${payout.id}`,
          });
        } catch (notifErr) {
          logger.warn('Failed to dispatch payout failure notification', {
            error: notifErr.message,
          });
        }

        return { processed: true, status: 'FAILED' };
      }

      await client.query('COMMIT');
      return { processed: true, status: payout.status };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = new PaymentService();
