'use strict';

/**
 * Abstract PaymentProvider interface.
 * Any payment gateway provider (Cashfree, etc.) must implement these methods.
 */
class PaymentProvider {
  /**
   * Create an order on the payment provider.
   *
   * @param {object} params
   * @param {string} params.orderId
   * @param {number} params.orderAmount
   * @param {string} params.orderCurrency
   * @param {object} params.customerDetails
   * @param {string} [params.returnUrl]
   * @returns {Promise<{providerOrderId: string, paymentSessionId: string|null,
   *   orderStatus: string}>}
   */
  async createOrder() {
    throw new Error('PaymentProvider.createOrder must be implemented by subclass');
  }

  /**
   * Fetch order status from the payment provider.
   *
   * @param {string} providerOrderId
   * @returns {Promise<object>}
   */
  async getOrderStatus() {
    throw new Error('PaymentProvider.getOrderStatus must be implemented by subclass');
  }

  /**
   * Verify authenticity of an incoming webhook using HMAC signature.
   *
   * @param {object} headers
   * @param {string} rawBody
   * @returns {boolean}
   */
  verifyWebhookSignature() {
    throw new Error('PaymentProvider.verifyWebhookSignature must be implemented by subclass');
  }
}

module.exports = PaymentProvider;
