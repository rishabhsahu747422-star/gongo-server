'use strict';

/**
 * Lightweight, in-memory, thread-safe operational metrics collector.
 * Tracks HTTP requests, financial events, and infrastructure health metrics.
 */
class MetricsCollector {
  constructor() {
    this.reset();
  }

  /**
   * Resets metrics to initial zero values.
   */
  reset() {
    this.http = {
      totalRequests: 0,
      byStatus: {},
      byMethod: {},
      byRoute: {},
      totalDurationMs: 0,
      minDurationMs: Infinity,
      maxDurationMs: 0,
      recentDurationsMs: [], // Bounded ring buffer for percentiles
    };

    this.financial = {
      settlementWebhookSuccess: 0,
      settlementWebhookFailure: 0,
      payoutCreationSuccess: 0,
      payoutCreationFailure: 0,
      payoutWebhookSuccess: 0,
      payoutWebhookFailure: 0,
      payoutReversals: 0,
      reconciliationMismatches: 0,
    };

    this.infrastructure = {
      cashfreeTimeouts: 0,
      providerErrors: 0,
      databaseErrors: 0,
      outboxDispatches: 0,
      outboxFailures: 0,
    };

    this.startTime = Date.now();
  }

  /**
   * Record HTTP request details.
   *
   * @param {object} params
   * @param {string} params.method
   * @param {string} params.route
   * @param {number} params.statusCode
   * @param {number} params.durationMs
   */
  recordHttpRequest({ method, route, statusCode, durationMs }) {
    this.http.totalRequests += 1;

    // Track by status code
    const statusKey = String(statusCode);
    this.http.byStatus[statusKey] = (this.http.byStatus[statusKey] || 0) + 1;

    // Track by method
    const methodKey = (method || 'UNKNOWN').toUpperCase();
    this.http.byMethod[methodKey] = (this.http.byMethod[methodKey] || 0) + 1;

    // Track by normalized route
    const routeKey = route || 'unknown';
    this.http.byRoute[routeKey] = (this.http.byRoute[routeKey] || 0) + 1;

    // Track duration stats
    const duration = Math.max(0, durationMs || 0);
    this.http.totalDurationMs += duration;
    if (duration < this.http.minDurationMs) this.http.minDurationMs = duration;
    if (duration > this.http.maxDurationMs) this.http.maxDurationMs = duration;

    // Keep up to 1000 recent samples for percentiles
    if (this.http.recentDurationsMs.length >= 1000) {
      this.http.recentDurationsMs.shift();
    }
    this.http.recentDurationsMs.push(duration);
  }

  recordSettlementWebhook(isSuccess) {
    if (isSuccess) {
      this.financial.settlementWebhookSuccess += 1;
    } else {
      this.financial.settlementWebhookFailure += 1;
    }
  }

  recordPayoutCreation(isSuccess) {
    if (isSuccess) {
      this.financial.payoutCreationSuccess += 1;
    } else {
      this.financial.payoutCreationFailure += 1;
    }
  }

  recordPayoutWebhook(isSuccess) {
    if (isSuccess) {
      this.financial.payoutWebhookSuccess += 1;
    } else {
      this.financial.payoutWebhookFailure += 1;
    }
  }

  recordPayoutReversal() {
    this.financial.payoutReversals += 1;
  }

  recordReconciliationMismatch(count = 1) {
    this.financial.reconciliationMismatches += count;
  }

  recordProviderTimeout() {
    this.infrastructure.cashfreeTimeouts += 1;
  }

  recordProviderError() {
    this.infrastructure.providerErrors += 1;
  }

  recordDatabaseError() {
    this.infrastructure.databaseErrors += 1;
  }

  recordOutboxDispatch(isSuccess) {
    if (isSuccess) {
      this.infrastructure.outboxDispatches += 1;
    } else {
      this.infrastructure.outboxFailures += 1;
    }
  }

  /**
   * Generates a sanitized operational metrics report.
   *
   * @returns {object}
   */
  getSummary() {
    const total = this.http.totalRequests;
    const avgDuration = total > 0 ? Number((this.http.totalDurationMs / total).toFixed(2)) : 0;
    const minDuration = this.http.minDurationMs === Infinity ? 0 : this.http.minDurationMs;

    // Calculate percentiles from sample buffer
    let p50 = 0;
    let p95 = 0;
    let p99 = 0;

    if (this.http.recentDurationsMs.length > 0) {
      const sorted = [...this.http.recentDurationsMs].sort((a, b) => a - b);
      const len = sorted.length;
      p50 = sorted[Math.floor(len * 0.50)] || 0;
      p95 = sorted[Math.floor(len * 0.95)] || 0;
      p99 = sorted[Math.floor(len * 0.99)] || 0;
    }

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
      http: {
        totalRequests: this.http.totalRequests,
        byStatus: { ...this.http.byStatus },
        byMethod: { ...this.http.byMethod },
        byRoute: { ...this.http.byRoute },
        latencyMs: {
          avg: avgDuration,
          min: minDuration,
          max: this.http.maxDurationMs,
          p50,
          p95,
          p99,
        },
      },
      financial: {
        settlementWebhookSuccess: this.financial.settlementWebhookSuccess,
        settlementWebhookFailure: this.financial.settlementWebhookFailure,
        payoutCreationSuccess: this.financial.payoutCreationSuccess,
        payoutCreationFailure: this.financial.payoutCreationFailure,
        payoutWebhookSuccess: this.financial.payoutWebhookSuccess,
        payoutWebhookFailure: this.financial.payoutWebhookFailure,
        payoutReversals: this.financial.payoutReversals,
        reconciliationMismatches: this.financial.reconciliationMismatches,
      },
      infrastructure: {
        cashfreeTimeouts: this.infrastructure.cashfreeTimeouts,
        providerErrors: this.infrastructure.providerErrors,
        databaseErrors: this.infrastructure.databaseErrors,
        outboxDispatches: this.infrastructure.outboxDispatches,
        outboxFailures: this.infrastructure.outboxFailures,
      },
    };
  }
}

module.exports = new MetricsCollector();
