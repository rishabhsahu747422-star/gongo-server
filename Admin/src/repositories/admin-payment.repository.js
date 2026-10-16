'use strict';

const { query, transaction } = require('../db/pool');
const { escapeLikeString } = require('../db/sql-helpers');

let mockPaymentResolver = null;

function setMockPaymentResolver(resolver) {
  mockPaymentResolver = resolver;
}

function resetMockPaymentResolver() {
  mockPaymentResolver = null;
}

class AdminPaymentRepository {
  /**
   * Helper to route query through mock resolver if set, otherwise real DB pool/client.
   */
  async _exec(sql, params = [], client = null) {
    if (mockPaymentResolver && typeof mockPaymentResolver === 'function') {
      return mockPaymentResolver(sql, params);
    }
    if (client) {
      return client.query(sql, params);
    }
    return query(sql, params);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PAYMENTS
  // ══════════════════════════════════════════════════════════════════════════════

  async listPayments({
    search,
    bookingId,
    bookingNumber,
    customerId,
    partnerId,
    paymentType,
    status,
    provider,
    providerPaymentId,
    providerOrderId,
    amountMin,
    amountMax,
    currency,
    startDate,
    endDate,
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  }) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (search && search.trim() !== '') {
      const escaped = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(
        p.provider_order_id ILIKE $${paramIndex}
        OR p.order_reference ILIKE $${paramIndex}
        OR p.provider_payment_id ILIKE $${paramIndex}
        OR b.booking_number ILIKE $${paramIndex}
        OR b.booking_reference ILIKE $${paramIndex}
        OR u.name ILIKE $${paramIndex}
        OR u.email ILIKE $${paramIndex}
        OR u.phone ILIKE $${paramIndex}
      )`);
      params.push(escaped);
      paramIndex += 1;
    }

    if (bookingId) {
      conditions.push(`p.booking_id = $${paramIndex}`);
      params.push(bookingId);
      paramIndex += 1;
    }

    if (bookingNumber) {
      conditions.push(`b.booking_number = $${paramIndex}`);
      params.push(bookingNumber.trim());
      paramIndex += 1;
    }

    if (customerId) {
      conditions.push(`p.customer_id = $${paramIndex}`);
      params.push(customerId);
      paramIndex += 1;
    }

    if (partnerId) {
      conditions.push(`b.partner_id = $${paramIndex}`);
      params.push(partnerId);
      paramIndex += 1;
    }

    if (paymentType) {
      conditions.push(`p.payment_type = $${paramIndex}`);
      params.push(paymentType);
      paramIndex += 1;
    }

    if (status) {
      conditions.push(`p.status = $${paramIndex}`);
      params.push(status);
      paramIndex += 1;
    }

    if (provider) {
      conditions.push(`p.provider = $${paramIndex}`);
      params.push(provider);
      paramIndex += 1;
    }

    if (providerPaymentId) {
      conditions.push(`p.provider_payment_id = $${paramIndex}`);
      params.push(providerPaymentId.trim());
      paramIndex += 1;
    }

    if (providerOrderId) {
      conditions.push(`p.provider_order_id = $${paramIndex}`);
      params.push(providerOrderId.trim());
      paramIndex += 1;
    }

    if (amountMin !== undefined && amountMin !== null) {
      conditions.push(`p.amount >= $${paramIndex}`);
      params.push(Number(amountMin));
      paramIndex += 1;
    }

    if (amountMax !== undefined && amountMax !== null) {
      conditions.push(`p.amount <= $${paramIndex}`);
      params.push(Number(amountMax));
      paramIndex += 1;
    }

    if (currency) {
      conditions.push(`p.currency = $${paramIndex}`);
      params.push(currency.toUpperCase());
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`p.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`p.created_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSort = ['created_at', 'amount', 'status', 'updated_at'];
    const safeSortCol = allowedSort.includes(sortBy) ? `p.${sortBy}` : 'p.created_at';
    const safeDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const sql = `
      SELECT
        p.id,
        p.order_reference,
        p.booking_id,
        b.booking_reference,
        b.booking_number,
        b.status AS booking_status,
        b.partner_id,
        p.customer_id,
        u.customer_reference,
        'cashfree'::text AS provider,
        p.provider_order_id,
        p.provider_payment_id,
        p.amount,
        p.currency,
        p.status,
        p.payment_method,
        p.payment_type,
        NULL::text AS failure_reason,
        p.created_at,
        p.updated_at,
        u.name AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,
        pt.business_name AS partner_business_name,
        COUNT(*) OVER()::int AS full_count
      FROM payments p
      LEFT JOIN bookings b ON p.booking_id = b.id
      LEFT JOIN users u ON p.customer_id = u.id
      LEFT JOIN partners pt ON b.partner_id = pt.id
      ${whereClause}
      ORDER BY ${safeSortCol} ${safeDir}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(safeLimit, offset);

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
    const payments = result.rows.map((row) => {
      const paymentData = {
        ...row,
        orderReference: row.order_reference || null,
        bookingReference: row.booking_reference || row.booking_number || null,
        customerReference: row.customer_reference || null,
      };
      delete paymentData.full_count;
      return paymentData;
    });

    return {
      payments,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
    };
  }

  async getPaymentById(id) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id).trim());
    const idCond = isUuid ? 'p.id = $1' : '(p.order_reference = $1 OR p.provider_order_id = $1)';

    const sql = `
      SELECT
        p.id,
        p.order_reference,
        p.booking_id,
        p.customer_id,
        'cashfree'::text AS provider,
        p.provider_order_id,
        p.provider_payment_id,
        p.amount,
        p.currency,
        p.status,
        p.payment_method,
        p.payment_type,
        NULL::text AS failure_reason,
        '{}'::jsonb AS metadata,
        p.created_at,
        p.updated_at,
        b.id AS booking_id,
        b.booking_reference,
        b.booking_number,
        b.status AS booking_status,
        b.start_at AS booking_start_date,
        b.end_at AS booking_end_date,
        b.total_amount AS booking_total_amount,
        u.id AS customer_id,
        u.customer_reference,
        u.name AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,
        pt.id AS partner_id,
        pt.partner_reference,
        pt.business_name AS partner_business_name,
        pt.contact_phone AS partner_contact_phone
      FROM payments p
      LEFT JOIN bookings b ON p.booking_id = b.id
      LEFT JOIN users u ON p.customer_id = u.id
      LEFT JOIN partners pt ON b.partner_id = pt.id
      WHERE ${idCond}
    `;

    const result = await this._exec(sql, [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      booking_id: row.booking_id,
      customer_id: row.customer_id,
      provider: row.provider,
      provider_order_id: row.provider_order_id,
      provider_payment_id: row.provider_payment_id,
      amount: Number(row.amount),
      currency: row.currency,
      status: row.status,
      payment_method: row.payment_method,
      payment_type: row.payment_type,
      failure_reason: row.failure_reason,
      metadata: row.metadata || {},
      created_at: row.created_at,
      updated_at: row.updated_at,
      booking: row.booking_id ? {
        id: row.booking_id,
        booking_number: row.booking_number,
        status: row.booking_status,
        start_date: row.booking_start_date,
        end_date: row.booking_end_date,
        total_amount: Number(row.booking_total_amount || 0),
      } : null,
      customer: row.customer_id ? {
        id: row.customer_id,
        name: row.customer_name,
        email: row.customer_email,
        phone: row.customer_phone,
      } : null,
      partner: row.partner_id ? {
        id: row.partner_id,
        business_name: row.partner_business_name,
        contact_phone: row.partner_contact_phone,
      } : null,
    };
  }

  async getPaymentBooking(paymentId) {
    const sql = `
      SELECT
        b.id,
        b.booking_number,
        b.customer_id,
        b.partner_id,
        b.vehicle_id,
        b.status,
        b.start_date,
        b.end_date,
        b.total_amount,
        b.created_at,
        b.updated_at
      FROM payments p
      JOIN bookings b ON p.booking_id = b.id
      WHERE p.id = $1
    `;
    const result = await this._exec(sql, [paymentId]);
    return result.rows[0] || null;
  }

  async getPaymentCustomer(paymentId) {
    const sql = `
      SELECT
        u.id,
        u.name,
        u.email,
        u.phone,
        u.role,
        u.is_active,
        u.created_at
      FROM payments p
      JOIN users u ON p.customer_id = u.id
      WHERE p.id = $1
    `;
    const result = await this._exec(sql, [paymentId]);
    return result.rows[0] || null;
  }

  async getPaymentPartner(paymentId) {
    const sql = `
      SELECT
        pt.id,
        pt.business_name,
        pt.contact_phone,
        pt.kyc_status,
        pt.is_active,
        pt.created_at
      FROM payments p
      JOIN bookings b ON p.booking_id = b.id
      JOIN partners pt ON b.partner_id = pt.id
      WHERE p.id = $1
    `;
    const result = await this._exec(sql, [paymentId]);
    return result.rows[0] || null;
  }

  async getPaymentTimeline(paymentId) {
    const payment = await this.getPaymentById(paymentId);
    if (!payment) return null;

    const timeline = [
      {
        event: 'PAYMENT_CREATED',
        status: 'CREATED',
        timestamp: payment.created_at,
        details: { amount: payment.amount, provider: payment.provider },
      },
    ];

    if (payment.status === 'SUCCESS') {
      timeline.push({
        event: 'PAYMENT_CONFIRMED',
        status: 'SUCCESS',
        timestamp: payment.updated_at,
        details: { providerPaymentId: payment.provider_payment_id },
      });
    } else if (payment.status === 'FAILED') {
      timeline.push({
        event: 'PAYMENT_FAILED',
        status: 'FAILED',
        timestamp: payment.updated_at,
        details: { failureReason: payment.failure_reason },
      });
    } else if (payment.status === 'CANCELLED') {
      timeline.push({
        event: 'PAYMENT_CANCELLED',
        status: 'CANCELLED',
        timestamp: payment.updated_at,
      });
    }

    // Include any associated refunds in the timeline
    const refundsSql = `
      SELECT id, refund_number, requested_amount, refunded_amount, status, created_at, updated_at
      FROM refunds
      WHERE payment_id = $1
      ORDER BY created_at ASC
    `;
    try {
      const refundsRes = await this._exec(refundsSql, [paymentId]);
      refundsRes.rows.forEach((ref) => {
        timeline.push({
          event: `REFUND_${ref.status}`,
          status: ref.status,
          timestamp: ref.updated_at || ref.created_at,
          details: {
            refundNumber: ref.refund_number,
            amount: Number(ref.refunded_amount || ref.requested_amount),
          },
        });
      });
    } catch {
      // Refunds table might be empty or queryable
    }

    return timeline;
  }

  async getPaymentTransactions(paymentId) {
    const payment = await this.getPaymentById(paymentId);
    if (!payment) return null;

    const transactions = [
      {
        id: payment.id,
        type: 'PAYMENT',
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        provider: payment.provider,
        providerPaymentId: payment.provider_payment_id,
        createdAt: payment.created_at,
      },
    ];

    try {
      const refundsSql = `
        SELECT id, refund_number, refunded_amount, currency, status, provider_refund_id, created_at
        FROM refunds
        WHERE payment_id = $1
        ORDER BY created_at ASC
      `;
      const refundsRes = await this._exec(refundsSql, [paymentId]);
      refundsRes.rows.forEach((r) => {
        transactions.push({
          id: r.id,
          type: 'REFUND',
          amount: Number(r.refunded_amount),
          currency: r.currency,
          status: r.status,
          providerRefundId: r.provider_refund_id,
          referenceNumber: r.refund_number,
          createdAt: r.created_at,
        });
      });
    } catch {
      // refunds table query fallback
    }

    return transactions;
  }

  async getPaymentAttempts(paymentId) {
    try {
      const sql = `
        SELECT id, payment_id, attempt_number, gateway, gateway_order_id, gateway_payment_id,
               amount, currency, status, failure_code, failure_reason, created_at, updated_at
        FROM payment_attempts
        WHERE payment_id = $1
        ORDER BY attempt_number ASC, created_at ASC;
      `;
      const res = await this._exec(sql, [paymentId]);
      return res.rows.map((r) => ({
        id: r.id,
        paymentId: r.payment_id,
        attemptNumber: r.attempt_number,
        gateway: r.gateway,
        gatewayOrderId: r.gateway_order_id,
        gatewayPaymentId: r.gateway_payment_id,
        amount: Number(r.amount),
        currency: r.currency,
        status: r.status,
        failureCode: r.failure_code,
        failureReason: r.failure_reason,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch {
      return [];
    }
  }

  async getPaymentWebhooks(paymentId) {
    const payment = await this.getPaymentById(paymentId);
    if (!payment) return null;

    try {
      // First try canonical payment_webhooks table
      const sql1 = `
        SELECT id, gateway, event_type, gateway_event_id, gateway_order_id, gateway_payment_id,
               payload, signature_verified, processing_status, processing_error, received_at, processed_at, created_at
        FROM payment_webhooks
        WHERE gateway_order_id = $1 OR gateway_payment_id = $2
        ORDER BY received_at DESC
        LIMIT 50;
      `;
      const res1 = await this._exec(sql1, [payment.provider_order_id, payment.provider_payment_id]);
      if (res1.rows && res1.rows.length > 0) {
        return res1.rows.map((row) => ({
          id: row.id,
          gateway: row.gateway,
          eventType: row.event_type,
          gatewayEventId: row.gateway_event_id,
          gatewayOrderId: row.gateway_order_id,
          gatewayPaymentId: row.gateway_payment_id,
          payload: row.payload,
          signatureVerified: row.signature_verified,
          processingStatus: row.processing_status,
          processingError: row.processing_error,
          receivedAt: row.received_at,
          processedAt: row.processed_at,
          createdAt: row.created_at,
        }));
      }

      // Fallback to payment_events
      const sql2 = `
        SELECT id, provider, event_id, event_type, payload, is_processed, created_at
        FROM payment_events
        WHERE payload->'data'->'order'->>'order_id' = $1
           OR payload->>'order_id' = $1
        ORDER BY created_at DESC
        LIMIT 50;
      `;
      const res2 = await this._exec(sql2, [payment.provider_order_id]);
      return res2.rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        eventId: row.event_id,
        eventType: row.event_type,
        isProcessed: row.is_processed,
        createdAt: row.created_at,
        payload: row.payload,
      }));
    } catch {
      return [];
    }
  }

  async getPaymentForUpdate(client, id) {
    const sql = `
      SELECT *
      FROM payments
      WHERE id = $1
      FOR UPDATE
    `;
    const res = await this._exec(sql, [id], client);
    return res.rows[0] || null;
  }

  async updatePaymentStatus(client, id, { status, providerPaymentId, failureReason }) {
    const sql = `
      UPDATE payments
      SET
        status = $1,
        provider_payment_id = COALESCE($2, provider_payment_id),
        failure_reason = COALESCE($3, failure_reason),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `;
    const res = await this._exec(sql, [status, providerPaymentId, failureReason, id], client);
    return res.rows[0] || null;
  }

  async getPaymentRefundsSummary(paymentId, client = null) {
    const sql = `
      SELECT
        COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN refunded_amount ELSE 0 END), 0)::numeric AS completed_refund_amount,
        COALESCE(SUM(CASE WHEN status IN ('REQUESTED', 'UNDER_REVIEW') THEN requested_amount ELSE 0 END), 0)::numeric AS pending_refund_amount,
        COUNT(*)::int AS total_refunds_count
      FROM refunds
      WHERE payment_id = $1
    `;
    const res = await this._exec(sql, [paymentId], client);
    if (res.rows.length === 0) {
      return { completedRefundAmount: 0, pendingRefundAmount: 0, totalRefundsCount: 0 };
    }
    return {
      completedRefundAmount: Number(res.rows[0].completed_refund_amount),
      pendingRefundAmount: Number(res.rows[0].pending_refund_amount),
      totalRefundsCount: Number(res.rows[0].total_refunds_count),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // REFUNDS
  // ══════════════════════════════════════════════════════════════════════════════

  async listRefunds({
    search,
    bookingId,
    customerId,
    paymentId,
    status,
    startDate,
    endDate,
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  }) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (search && search.trim() !== '') {
      const escaped = `%${escapeLikeString(search.trim())}%`;
      conditions.push(`(
        r.refund_number ILIKE $${paramIndex}
        OR r.refund_reference ILIKE $${paramIndex}
        OR b.booking_number ILIKE $${paramIndex}
        OR b.booking_reference ILIKE $${paramIndex}
        OR u.name ILIKE $${paramIndex}
        OR r.reason ILIKE $${paramIndex}
      )`);
      params.push(escaped);
      paramIndex += 1;
    }

    if (bookingId) {
      conditions.push(`r.booking_id = $${paramIndex}`);
      params.push(bookingId);
      paramIndex += 1;
    }

    if (customerId) {
      conditions.push(`r.customer_id = $${paramIndex}`);
      params.push(customerId);
      paramIndex += 1;
    }

    if (paymentId) {
      conditions.push(`r.payment_id = $${paramIndex}`);
      params.push(paymentId);
      paramIndex += 1;
    }

    if (status) {
      conditions.push(`r.status = $${paramIndex}`);
      params.push(status);
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`r.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`r.created_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSort = ['created_at', 'requested_amount', 'refunded_amount', 'status'];
    const safeSortCol = allowedSort.includes(sortBy) ? `r.${sortBy}` : 'r.created_at';
    const safeDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const sql = `
      SELECT
        r.id,
        r.refund_reference,
        r.refund_number,
        r.booking_id,
        b.booking_reference,
        b.booking_number,
        r.payment_id,
        r.customer_id,
        u.customer_reference,
        r.requested_amount,
        r.approved_amount,
        r.refunded_amount,
        r.currency,
        r.reason,
        r.status,
        r.provider,
        r.provider_refund_id,
        r.rejection_reason,
        r.upi_id,
        r.original_paid_amount,
        r.refund_percentage,
        r.policy_name,
        r.utr,
        r.payment_method,
        r.notes,
        r.processed_by,
        r.processed_at,
        r.created_at,
        r.updated_at,
        u.name AS customer_name,
        u.email AS customer_email,
        COUNT(*) OVER()::int AS full_count
      FROM refunds r
      LEFT JOIN bookings b ON r.booking_id = b.id
      LEFT JOIN users u ON r.customer_id = u.id
      ${whereClause}
      ORDER BY ${safeSortCol} ${safeDir}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(safeLimit, offset);

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
    const refunds = result.rows.map((row) => {
      const refundData = {
        ...row,
        refundReference: row.refund_reference || null,
        bookingReference: row.booking_reference || row.booking_number || null,
        customerReference: row.customer_reference || null,
      };
      delete refundData.full_count;
      return refundData;
    });

    return {
      refunds,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
    };
  }

  async getRefundById(id) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id).trim());
    const idCond = isUuid ? 'r.id = $1' : '(r.refund_reference = $1 OR r.refund_number = $1)';

    const sql = `
      SELECT
        r.id,
        r.refund_reference,
        r.refund_number,
        r.booking_id,
        r.payment_id,
        r.customer_id,
        r.requested_amount,
        r.approved_amount,
        r.refunded_amount,
        r.currency,
        r.reason,
        r.status,
        r.provider,
        r.provider_refund_id,
        r.idempotency_key,
        r.rejection_reason,
        r.upi_id,
        r.original_paid_amount,
        r.refund_percentage,
        r.policy_name,
        r.utr,
        r.payment_method,
        r.notes,
        r.processed_by,
        r.processed_at,
        r.created_at,
        r.updated_at,
        b.booking_reference,
        b.booking_number,
        b.status AS booking_status,
        u.customer_reference,
        u.name AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,
        p.order_reference,
        p.amount AS payment_amount,
        p.status AS payment_status,
        p.provider_order_id,
        p.provider_payment_id
      FROM refunds r
      LEFT JOIN bookings b ON r.booking_id = b.id
      LEFT JOIN users u ON r.customer_id = u.id
      LEFT JOIN payments p ON r.payment_id = p.id
      WHERE ${idCond}
    `;

    const result = await this._exec(sql, [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      refundReference: row.refund_reference || null,
      refund_reference: row.refund_reference || null,
      refund_number: row.refund_number,
      booking_id: row.booking_id,
      payment_id: row.payment_id,
      customer_id: row.customer_id,
      requested_amount: Number(row.requested_amount),
      approved_amount: row.approved_amount !== null ? Number(row.approved_amount) : null,
      refunded_amount: Number(row.refunded_amount || 0),
      currency: row.currency,
      reason: row.reason,
      status: row.status,
      provider: row.provider,
      provider_refund_id: row.provider_refund_id,
      idempotency_key: row.idempotency_key,
      rejection_reason: row.rejection_reason,
      upi_id: row.upi_id,
      original_paid_amount: row.original_paid_amount !== null && row.original_paid_amount !== undefined ? Number(row.original_paid_amount) : null,
      refund_percentage: row.refund_percentage !== null && row.refund_percentage !== undefined ? Number(row.refund_percentage) : null,
      policy_name: row.policy_name,
      utr: row.utr,
      payment_method: row.payment_method,
      paymentMethod: row.payment_method,
      notes: row.notes,
      processed_by: row.processed_by,
      processed_at: row.processed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      booking: {
        id: row.booking_id,
        booking_reference: row.booking_reference || row.booking_number,
        bookingReference: row.booking_reference || row.booking_number,
        booking_number: row.booking_number,
        status: row.booking_status,
      },
      customer: {
        id: row.customer_id,
        customer_reference: row.customer_reference || null,
        customerReference: row.customer_reference || null,
        name: row.customer_name,
        email: row.customer_email,
        phone: row.customer_phone,
      },
      payment: {
        id: row.payment_id,
        order_reference: row.order_reference || null,
        orderReference: row.order_reference || null,
        amount: Number(row.payment_amount || 0),
        status: row.payment_status,
        provider_order_id: row.provider_order_id,
        provider_payment_id: row.provider_payment_id,
      },
    };
  }

  async getRefundByIdempotencyKey(key) {
    if (!key) return null;
    const sql = 'SELECT * FROM refunds WHERE idempotency_key = $1';
    const res = await this._exec(sql, [key]);
    return res.rows[0] || null;
  }

  async getRefundForUpdate(client, id) {
    const sql = 'SELECT * FROM refunds WHERE id = $1 FOR UPDATE';
    const res = await this._exec(sql, [id], client);
    return res.rows[0] || null;
  }

  async createRefund(client, {
    refundNumber,
    refundReference = null,
    bookingId,
    paymentId,
    customerId,
    requestedAmount,
    approvedAmount,
    refundedAmount = 0,
    currency = 'INR',
    reason,
    status = 'REQUESTED',
    provider = 'CASHFREE',
    providerRefundId = null,
    idempotencyKey = null,
    processedBy = null,
    processedAt = null,
  }) {
    let generatedRefundRef = refundReference;
    if (!generatedRefundRef) {
      try {
        const { generateUniqueEntityReference } = require('../utils/reference-generator');
        generatedRefundRef = await generateUniqueEntityReference(client || this, 'refunds', 'refund_reference', 'REF');
      } catch {
        generatedRefundRef = null;
      }
    }

    const sql = `
      INSERT INTO refunds (
        refund_number,
        booking_id,
        payment_id,
        customer_id,
        requested_amount,
        approved_amount,
        refunded_amount,
        currency,
        reason,
        status,
        provider,
        provider_refund_id,
        idempotency_key,
        processed_by,
        processed_at,
        refund_reference
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, COALESCE($16, ('REF-' || upper(substr(md5(random()::text), 1, 6)))))
      RETURNING *
    `;

    const params = [
      refundNumber,
      bookingId,
      paymentId,
      customerId,
      requestedAmount,
      approvedAmount,
      refundedAmount,
      currency,
      reason,
      status,
      provider,
      providerRefundId,
      idempotencyKey,
      processedBy,
      processedAt,
      generatedRefundRef,
    ];

    const res = await this._exec(sql, params, client);
    return res.rows[0];
  }

  async updateRefundStatus(client, id, {
    status,
    approvedAmount,
    refundedAmount,
    providerRefundId,
    rejectionReason,
    processedBy,
    processedAt,
    utr,
    paymentMethod,
    notes,
  }) {
    const sql = `
      UPDATE refunds
      SET
        status = $1,
        approved_amount = COALESCE($2, approved_amount),
        refunded_amount = COALESCE($3, refunded_amount),
        provider_refund_id = COALESCE($4, provider_refund_id),
        rejection_reason = COALESCE($5, rejection_reason),
        processed_by = COALESCE($6, processed_by),
        processed_at = COALESCE($7, processed_at),
        utr = COALESCE($8, utr),
        payment_method = COALESCE($9, payment_method),
        notes = COALESCE($10, notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING *
    `;

    const params = [
      status,
      approvedAmount,
      refundedAmount,
      providerRefundId,
      rejectionReason,
      processedBy,
      processedAt,
      utr !== undefined ? utr : null,
      paymentMethod !== undefined ? paymentMethod : null,
      notes !== undefined ? notes : null,
      id,
    ];

    const res = await this._exec(sql, params, client);
    return res.rows[0] || null;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // COMMISSIONS & RULES
  // ══════════════════════════════════════════════════════════════════════════════

  async listCommissions({
    bookingId,
    partnerId,
    status,
    startDate,
    endDate,
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  }) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (bookingId) {
      conditions.push(`cr.booking_id = $${paramIndex}`);
      params.push(bookingId);
      paramIndex += 1;
    }

    if (partnerId) {
      conditions.push(`cr.partner_id = $${paramIndex}`);
      params.push(partnerId);
      paramIndex += 1;
    }

    if (status) {
      conditions.push(`cr.status = $${paramIndex}`);
      params.push(status);
      paramIndex += 1;
    }

    if (startDate) {
      conditions.push(`cr.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex += 1;
    }

    if (endDate) {
      conditions.push(`cr.created_at <= $${paramIndex}`);
      params.push(endDate);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSort = ['created_at', 'commission_amount', 'gross_booking_amount', 'status'];
    const safeSortCol = allowedSort.includes(sortBy) ? `cr.${sortBy}` : 'cr.created_at';
    const safeDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const sql = `
      SELECT
        cr.id,
        cr.booking_id,
        cr.partner_id,
        cr.commission_type,
        cr.commission_rate,
        cr.commission_amount,
        cr.gross_booking_amount,
        cr.partner_payable_amount,
        cr.status,
        cr.created_at,
        cr.updated_at,
        b.booking_number,
        pt.business_name AS partner_business_name,
        COUNT(*) OVER()::int AS full_count
      FROM commission_records cr
      LEFT JOIN bookings b ON cr.booking_id = b.id
      LEFT JOIN partners pt ON cr.partner_id = pt.id
      ${whereClause}
      ORDER BY ${safeSortCol} ${safeDir}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(safeLimit, offset);

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
    const commissions = result.rows.map((row) => {
      const data = { ...row };
      delete data.full_count;
      return data;
    });

    return {
      commissions,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
    };
  }

  async getCommissionById(id) {
    const sql = `
      SELECT
        cr.id,
        cr.booking_id,
        cr.partner_id,
        cr.commission_type,
        cr.commission_rate,
        cr.commission_amount,
        cr.gross_booking_amount,
        cr.partner_payable_amount,
        cr.status,
        cr.created_at,
        cr.updated_at,
        b.booking_number,
        b.status AS booking_status,
        pt.business_name AS partner_business_name
      FROM commission_records cr
      LEFT JOIN bookings b ON cr.booking_id = b.id
      LEFT JOIN partners pt ON cr.partner_id = pt.id
      WHERE cr.id = $1
    `;

    const result = await this._exec(sql, [id]);
    return result.rows[0] || null;
  }

  async listCommissionRules({ ruleScope, isActive, page = 1, limit = 20 }) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (ruleScope) {
      conditions.push(`cr.rule_scope = $${paramIndex}`);
      params.push(ruleScope);
      paramIndex += 1;
    }

    if (isActive !== undefined && isActive !== null) {
      conditions.push(`cr.is_active = $${paramIndex}`);
      params.push(Boolean(isActive));
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const sql = `
      SELECT
        cr.id,
        cr.name,
        cr.rule_scope,
        cr.category_id,
        cr.partner_id,
        cr.vehicle_id,
        cr.commission_type,
        cr.commission_value,
        cr.priority,
        cr.effective_from,
        cr.effective_until,
        cr.is_active,
        cr.created_by,
        cr.created_at,
        cr.updated_at,
        vc.name AS category_name,
        pt.business_name AS partner_name,
        v.registration_number AS vehicle_registration,
        TRIM(CONCAT(v.brand, ' ', v.model)) AS vehicle_model,
        COUNT(*) OVER()::int AS full_count
      FROM commission_rules cr
      LEFT JOIN vehicle_categories vc ON cr.category_id = vc.id
      LEFT JOIN partners pt ON cr.partner_id = pt.id
      LEFT JOIN vehicles v ON cr.vehicle_id = v.id
      ${whereClause}
      ORDER BY cr.priority DESC, cr.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(safeLimit, offset);

    const result = await this._exec(sql, params);
    const total = result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;
    const rules = result.rows.map((row) => {
      const ruleData = { ...row };
      delete ruleData.full_count;

      let targetName = 'Global Platform Default';
      let targetId = null;
      if (row.rule_scope === 'category') {
        targetName = row.category_name || 'Vehicle Category';
        targetId = row.category_id;
      } else if (row.rule_scope === 'partner') {
        targetName = row.partner_name || 'Specific Partner';
        targetId = row.partner_id;
      } else if (row.rule_scope === 'vehicle') {
        targetName = row.vehicle_registration
          ? `${row.vehicle_registration}${row.vehicle_model ? ` (${row.vehicle_model})` : ''}`
          : 'Individual Vehicle';
        targetId = row.vehicle_id;
      }

      return {
        ...ruleData,
        target_id: targetId,
        target_name: targetName,
        target: targetName,
      };
    });

    return {
      rules,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
    };
  }

  async createCommissionRule({
    name,
    ruleScope = 'default',
    commissionType = 'percentage',
    commissionValue,
    priority = 0,
    targetId = null,
    categoryId = null,
    partnerId = null,
    vehicleId = null,
    effectiveFrom = null,
    effectiveUntil = null,
    isActive = true,
    createdBy = null,
  }) {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const toSafeUuid = (val) => (typeof val === 'string' && UUID_REGEX.test(val.trim()) ? val.trim() : null);

    const normalizedType = commissionType === 'flat' ? 'fixed' : (commissionType || 'percentage');

    let targetCatId = null;
    let targetPrtId = null;
    let targetVehId = null;

    if (ruleScope === 'category') {
      targetCatId = toSafeUuid(categoryId || targetId);
    } else if (ruleScope === 'partner') {
      targetPrtId = toSafeUuid(partnerId || targetId);
    } else if (ruleScope === 'vehicle') {
      targetVehId = toSafeUuid(vehicleId || targetId);
    }

    // Ensure createdBy is a valid UUID, otherwise null (prevents 22P02 invalid input syntax for type uuid)
    let safeCreatedBy = toSafeUuid(createdBy);
    if (safeCreatedBy) {
      try {
        const uRes = await this._exec('SELECT id FROM users WHERE id = $1', [safeCreatedBy]);
        if (!uRes.rows || !uRes.rows[0]) {
          safeCreatedBy = null;
        }
      } catch (_) {
        safeCreatedBy = null;
      }
    }

    const safeEffectiveFrom = (effectiveFrom && !Number.isNaN(Date.parse(effectiveFrom)))
      ? new Date(effectiveFrom).toISOString()
      : null;
    const safeEffectiveUntil = (effectiveUntil && !Number.isNaN(Date.parse(effectiveUntil)))
      ? new Date(effectiveUntil).toISOString()
      : null;

    const sql = `
      INSERT INTO commission_rules (
        name,
        rule_scope,
        category_id,
        partner_id,
        vehicle_id,
        commission_type,
        commission_value,
        priority,
        effective_from,
        effective_until,
        is_active,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, CURRENT_TIMESTAMP), $10, $11, $12)
      RETURNING *
    `;

    const params = [
      name,
      ruleScope,
      targetCatId,
      targetPrtId,
      targetVehId,
      normalizedType,
      commissionValue,
      priority,
      safeEffectiveFrom,
      safeEffectiveUntil,
      isActive,
      safeCreatedBy,
    ];

    const res = await this._exec(sql, params);
    const createdRow = res.rows[0];
    if (!createdRow) return null;

    const populated = await this.getCommissionRuleById(createdRow.id);
    return populated || createdRow;
  }

  async updateCommissionRule(id, {
    name,
    ruleScope,
    commissionType,
    commissionValue,
    priority,
    targetId,
    categoryId,
    partnerId,
    vehicleId,
    effectiveFrom,
    effectiveUntil,
    isActive,
  }) {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const toSafeUuid = (val) => (typeof val === 'string' && UUID_REGEX.test(val.trim()) ? val.trim() : null);

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      params.push(name);
      paramIndex += 1;
    }

    if (commissionType !== undefined) {
      const normalizedType = commissionType === 'flat' ? 'fixed' : commissionType;
      updates.push(`commission_type = $${paramIndex}`);
      params.push(normalizedType);
      paramIndex += 1;
    }

    if (commissionValue !== undefined) {
      updates.push(`commission_value = $${paramIndex}`);
      params.push(commissionValue);
      paramIndex += 1;
    }

    if (priority !== undefined) {
      updates.push(`priority = $${paramIndex}`);
      params.push(priority);
      paramIndex += 1;
    }

    if (ruleScope !== undefined) {
      updates.push(`rule_scope = $${paramIndex}`);
      params.push(ruleScope);
      paramIndex += 1;
    }

    if (targetId !== undefined || categoryId !== undefined || partnerId !== undefined || vehicleId !== undefined) {
      const catVal = toSafeUuid(categoryId !== undefined ? categoryId : (ruleScope === 'category' ? targetId : null));
      const prtVal = toSafeUuid(partnerId !== undefined ? partnerId : (ruleScope === 'partner' ? targetId : null));
      const vehVal = toSafeUuid(vehicleId !== undefined ? vehicleId : (ruleScope === 'vehicle' ? targetId : null));

      updates.push(`category_id = $${paramIndex}`);
      params.push(catVal);
      paramIndex += 1;

      updates.push(`partner_id = $${paramIndex}`);
      params.push(prtVal);
      paramIndex += 1;

      updates.push(`vehicle_id = $${paramIndex}`);
      params.push(vehVal);
      paramIndex += 1;
    }

    if (effectiveFrom !== undefined) {
      const safeFrom = (effectiveFrom && !Number.isNaN(Date.parse(effectiveFrom)))
        ? new Date(effectiveFrom).toISOString()
        : null;
      updates.push(`effective_from = $${paramIndex}`);
      params.push(safeFrom);
      paramIndex += 1;
    }

    if (effectiveUntil !== undefined) {
      const safeUntil = (effectiveUntil && !Number.isNaN(Date.parse(effectiveUntil)))
        ? new Date(effectiveUntil).toISOString()
        : null;
      updates.push(`effective_until = $${paramIndex}`);
      params.push(safeUntil);
      paramIndex += 1;
    }

    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex}`);
      params.push(isActive);
      paramIndex += 1;
    }

    if (updates.length === 0) {
      return this.getCommissionRuleById(id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const sql = `
      UPDATE commission_rules
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id
    `;

    const res = await this._exec(sql, params);
    if (!res.rows[0]) return null;

    const populated = await this.getCommissionRuleById(id);
    return populated || res.rows[0];
  }

  async getCommissionRuleById(id) {
    const sql = `
      SELECT
        cr.id,
        cr.name,
        cr.rule_scope,
        cr.category_id,
        cr.partner_id,
        cr.vehicle_id,
        cr.commission_type,
        cr.commission_value,
        cr.priority,
        cr.effective_from,
        cr.effective_until,
        cr.is_active,
        cr.created_by,
        cr.created_at,
        cr.updated_at,
        vc.name AS category_name,
        pt.business_name AS partner_name,
        v.registration_number AS vehicle_registration,
        TRIM(CONCAT(v.brand, ' ', v.model)) AS vehicle_model
      FROM commission_rules cr
      LEFT JOIN vehicle_categories vc ON cr.category_id = vc.id
      LEFT JOIN partners pt ON cr.partner_id = pt.id
      LEFT JOIN vehicles v ON cr.vehicle_id = v.id
      WHERE cr.id = $1
    `;
    const res = await this._exec(sql, [id]);
    const row = res.rows[0];
    if (!row) return null;

    let targetName = 'Global Platform Default';
    let targetId = null;
    if (row.rule_scope === 'category') {
      targetName = row.category_name || 'Vehicle Category';
      targetId = row.category_id;
    } else if (row.rule_scope === 'partner') {
      targetName = row.partner_name || 'Specific Partner';
      targetId = row.partner_id;
    } else if (row.rule_scope === 'vehicle') {
      targetName = row.vehicle_registration
        ? `${row.vehicle_registration}${row.vehicle_model ? ` (${row.vehicle_model})` : ''}`
        : 'Individual Vehicle';
      targetId = row.vehicle_id;
    }

    return {
      ...row,
      target_id: targetId,
      target_name: targetName,
      target: targetName,
    };
  }

  async deleteCommissionRule(id) {
    const sql = 'DELETE FROM commission_rules WHERE id = $1 RETURNING id;';
    const res = await this._exec(sql, [id]);
    return res.rows[0] || null;
  }

  async getCommissionRuleTargets() {
    const [categoriesRes, partnersRes, vehiclesRes] = await Promise.all([
      this._exec('SELECT id, name FROM vehicle_categories ORDER BY name ASC'),
      this._exec('SELECT id, business_name FROM partners WHERE is_active = true OR business_name IS NOT NULL ORDER BY business_name ASC LIMIT 100'),
      this._exec('SELECT id, registration_number, brand, model FROM vehicles WHERE is_active = true OR registration_number IS NOT NULL ORDER BY registration_number ASC LIMIT 100'),
    ]);

    return {
      categories: (categoriesRes.rows || []).map((r) => ({ id: r.id, name: r.name })),
      partners: (partnersRes.rows || []).map((r) => ({ id: r.id, name: r.business_name || 'Partner' })),
      vehicles: (vehiclesRes.rows || []).map((r) => ({
        id: r.id,
        name: `${r.registration_number}${r.brand || r.model ? ` (${[r.brand, r.model].filter(Boolean).join(' ')})` : ''}`,
      })),
    };
  }

  async listCommissionTransactions({ page = 1, limit = 20, startDate, endDate }) {
    return this.listCommissions({ page, limit, startDate, endDate });
  }

  async getCommissionTransactionById(id) {
    return this.getCommissionById(id);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // FINANCIAL OVERVIEW & AGGREGATE SUMMARY
  // ══════════════════════════════════════════════════════════════════════════════

  async getFinancialSummary({ startDate, endDate }) {
    const paymentConditions = [];
    const paymentParams = [];
    let pIdx = 1;

    if (startDate) {
      paymentConditions.push(`created_at >= $${pIdx}`);
      paymentParams.push(startDate);
      pIdx += 1;
    }
    if (endDate) {
      paymentConditions.push(`created_at <= $${pIdx}`);
      paymentParams.push(endDate);
      pIdx += 1;
    }

    const pWhere = paymentConditions.length > 0 ? `WHERE ${paymentConditions.join(' AND ')}` : '';

    const paymentsSql = `
      SELECT
        COUNT(*)::int AS total_payments,
        COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS successful_payments,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_payments,
        COUNT(*) FILTER (WHERE status IN ('CREATED', 'PENDING'))::int AS pending_payments,
        COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCESS'), 0)::numeric AS total_collected_amount
      FROM payments
      ${pWhere}
    `;

    const refundsSql = `
      SELECT
        COUNT(*)::int AS total_refunds,
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_refunds,
        COALESCE(SUM(refunded_amount) FILTER (WHERE status = 'COMPLETED'), 0)::numeric AS total_refunded_amount
      FROM refunds
      ${pWhere}
    `;

    const commissionsSql = `
      SELECT
        COALESCE(SUM(commission_amount), 0)::numeric AS total_commission_amount,
        COALESCE(SUM(partner_payable_amount), 0)::numeric AS total_partner_payable_amount
      FROM commission_records
      ${pWhere}
    `;

    const [paymentsRes, refundsRes, commissionsRes] = await Promise.all([
      this._exec(paymentsSql, paymentParams),
      this._exec(refundsSql, paymentParams),
      this._exec(commissionsSql, paymentParams),
    ]);

    const pRow = paymentsRes.rows[0] || {};
    const rRow = refundsRes.rows[0] || {};
    const cRow = commissionsRes.rows[0] || {};

    return {
      currency: 'INR',
      payments: {
        total: Number(pRow.total_payments || 0),
        successful: Number(pRow.successful_payments || 0),
        failed: Number(pRow.failed_payments || 0),
        pending: Number(pRow.pending_payments || 0),
        totalCollectedAmount: Number(pRow.total_collected_amount || 0),
      },
      refunds: {
        total: Number(rRow.total_refunds || 0),
        completed: Number(rRow.completed_refunds || 0),
        totalRefundedAmount: Number(rRow.total_refunded_amount || 0),
      },
      commissions: {
        totalCommissionAmount: Number(cRow.total_commission_amount || 0),
        totalPartnerPayableAmount: Number(cRow.total_partner_payable_amount || 0),
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TRANSACTION HELPER
  // ══════════════════════════════════════════════════════════════════════════════

  async executeInTransaction(callback) {
    if (mockPaymentResolver) {
      return callback({ query: (sql, p) => this._exec(sql, p) });
    }
    return transaction(callback);
  }
}

module.exports = new AdminPaymentRepository();
module.exports.AdminPaymentRepository = AdminPaymentRepository;
module.exports.setMockPaymentResolver = setMockPaymentResolver;
module.exports.resetMockPaymentResolver = resetMockPaymentResolver;
