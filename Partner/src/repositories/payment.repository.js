'use strict';

const BaseRepository = require('../db/base.repository');

/**
 * PaymentRepository — Database layer for payments and payment_events tables.
 */
class PaymentRepository extends BaseRepository {
  constructor() {
    super('payments', 'id');
  }

  /**
   * Find latest payment record for a booking by payment type.
   *
   * @param {string} bookingId
   * @param {string} paymentType
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findLatestByBookingAndType(bookingId, paymentType, client = null) {
    const text = `
      SELECT *
      FROM payments
      WHERE booking_id = $1 AND payment_type = $2
      ORDER BY created_at DESC
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [bookingId, paymentType])
      : await this.query(text, [bookingId, paymentType]);
    return res.rows[0] || null;
  }

  /**
   * Find all payments for a booking ordered chronologically.
   *
   * @param {string} bookingId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async findAllByBookingId(bookingId, client = null) {
    const text = `
      SELECT *
      FROM payments
      WHERE booking_id = $1
      ORDER BY created_at ASC;
    `;
    const res = client
      ? await client.query(text, [bookingId])
      : await this.query(text, [bookingId]);
    return res.rows;
  }

  /**
   * Find payment by provider order ID.
   *
   * @param {string} providerOrderId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object|null>}
   */
  async findByProviderOrderId(providerOrderId, client = null) {
    const text = `
      SELECT *
      FROM payments
      WHERE provider_order_id = $1
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [providerOrderId])
      : await this.query(text, [providerOrderId]);
    return res.rows[0] || null;
  }

  /**
   * Acquire a row-level lock on the payment record by provider order ID inside a transaction.
   *
   * @param {string} providerOrderId
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async lockByProviderOrderId(providerOrderId, client) {
    const text = `
      SELECT *
      FROM payments
      WHERE provider_order_id = $1
      FOR UPDATE;
    `;
    const res = await client.query(text, [providerOrderId]);
    return res.rows[0] || null;
  }

  /**
   * Update payment status and gateway identifiers.
   *
   * @param {string} id
   * @param {string} status
   * @param {object} [options={}]
   * @param {string} [options.providerPaymentId]
   * @param {object} [options.metadata]
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object>}
   */
  async updateStatus(id, status, options, client) {
    const { providerPaymentId = null, metadata = null } = options || {};
    const text = `
      UPDATE payments
      SET 
        status = $2,
        provider_payment_id = COALESCE($3, provider_payment_id),
        metadata = CASE 
          WHEN $4::jsonb IS NOT NULL THEN COALESCE(metadata, '{}'::jsonb) || $4::jsonb 
          ELSE metadata 
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *;
    `;
    const res = await client.query(text, [
      id,
      status,
      providerPaymentId,
      metadata ? JSON.stringify(metadata) : null,
    ]);
    return res.rows[0];
  }

  /**
   * Record gateway webhook event in payment_events table for idempotency.
   *
   * @param {object} eventData
   * @param {string} eventData.provider
   * @param {string} eventData.eventId
   * @param {string} eventData.eventType
   * @param {object} eventData.payload
   * @param {boolean} [eventData.isProcessed=true]
   * @param {import('pg').PoolClient} client
   * @returns {Promise<object|null>}
   */
  async recordEvent(
    { provider, eventId, eventType, payload, isProcessed = true },
    client,
  ) {
    const text = `
      INSERT INTO payment_events (
        provider,
        event_id,
        event_type,
        payload,
        is_processed
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (provider, event_id) DO NOTHING
      RETURNING *;
    `;
    const res = await client.query(text, [
      provider,
      eventId,
      eventType,
      JSON.stringify(payload),
      isProcessed,
    ]);
    return res.rows[0] || null;
  }

  /**
   * Check if a webhook event was already recorded and processed.
   *
   * @param {string} provider
   * @param {string} eventId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>}
   */
  async isEventProcessed(provider, eventId, client = null) {
    const text = `
      SELECT 1
      FROM payment_events
      WHERE provider = $1 AND event_id = $2
      LIMIT 1;
    `;
    const res = client
      ? await client.query(text, [provider, eventId])
      : await this.query(text, [provider, eventId]);
    return res.rowCount > 0;
  }
}

module.exports = new PaymentRepository();
