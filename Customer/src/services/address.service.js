'use strict';

const { AddressRepository, CustomerRepository } = require('../repositories');
const { NotFoundError, ForbiddenError } = require('../errors');
const { logger } = require('../config');

/**
 * AddressService manages business logic for customer saved addresses.
 *
 * Security invariant: userId is ALWAYS sourced from the authenticated token
 * (req.user.id), never from the request body or URL params when determining
 * ownership. All repository calls enforce ownership via the userId parameter.
 *
 * Delete behaviour: when the default address is deleted, no address is
 * auto-promoted. The customer simply has no default address. They must
 * explicitly set a new default via the /default endpoint.
 * This avoids surprising side effects and gives the customer full control.
 */
class AddressService {
  constructor({
    addressRepo = new AddressRepository(),
    customerRepo = new CustomerRepository(),
  } = {}) {
    this.addressRepository = addressRepo;
    this.customerRepository = customerRepo;
  }

  /**
   * Verifies the user exists and is active.
   * Throws appropriate errors if not.
   *
   * @param {string} userId
   * @returns {Promise<object>} User record
   */
  async _requireActiveUser(userId) {
    const user = await this.customerRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('Customer profile not found', 'CUSTOMER_NOT_FOUND');
    }
    if (!user.isActive) {
      throw new ForbiddenError(
        'Your account has been deactivated. Please contact support.',
        'AUTH_USER_INACTIVE',
      );
    }
    return user;
  }

  /**
   * Creates a new address for the authenticated customer.
   * If isDefault is true, sets it as default using the atomic setDefault flow.
   *
   * @param {string} userId - From authenticated token
   * @param {object} data - Validated address fields
   * @returns {Promise<object>} Created address DTO
   */
  async createAddress(userId, data) {
    await this._requireActiveUser(userId);

    const { isDefault, ...addressFields } = data;

    // Create the address first
    const address = await this.addressRepository.create(userId, addressFields);

    // If caller requested this to be the default, atomically set it
    if (isDefault) {
      const updated = await this.addressRepository.setDefault(address.id, userId);
      logger.info('Address created and set as default', { userId, addressId: updated.id });
      return updated;
    }

    logger.info('Address created', { userId, addressId: address.id });
    return address;
  }

  /**
   * Lists all saved addresses for the authenticated customer.
   *
   * @param {string} userId - From authenticated token
   * @returns {Promise<object[]>} Address DTOs (default first, then newest)
   */
  async listAddresses(userId) {
    await this._requireActiveUser(userId);
    return this.addressRepository.findByUserId(userId);
  }

  /**
   * Retrieves a single address by id for the authenticated customer.
   * Throws NotFoundError if address does not exist or belongs to another user.
   *
   * @param {string} userId - From authenticated token
   * @param {string} addressId
   * @returns {Promise<object>} Address DTO
   */
  async getAddress(userId, addressId) {
    await this._requireActiveUser(userId);

    const address = await this.addressRepository.findByIdAndUserId(addressId, userId);
    if (!address) {
      throw new NotFoundError('Address not found', 'ADDRESS_NOT_FOUND');
    }
    return address;
  }

  /**
   * Updates allowlisted fields of an address belonging to the authenticated customer.
   * Throws NotFoundError if address does not exist or belongs to another user.
   *
   * @param {string} userId - From authenticated token
   * @param {string} addressId
   * @param {object} data - Validated update fields
   * @returns {Promise<object>} Updated address DTO
   */
  async updateAddress(userId, addressId, data) {
    await this._requireActiveUser(userId);

    const updated = await this.addressRepository.update(addressId, userId, data);
    logger.info('Address updated', { userId, addressId });
    return updated;
  }

  /**
   * Deletes an address belonging to the authenticated customer.
   * If the deleted address was the default, no other address is auto-promoted.
   * Throws NotFoundError if address does not exist or belongs to another user.
   *
   * @param {string} userId - From authenticated token
   * @param {string} addressId
   * @returns {Promise<void>}
   */
  async deleteAddress(userId, addressId) {
    await this._requireActiveUser(userId);

    await this.addressRepository.deleteByIdAndUserId(addressId, userId);
    logger.info('Address deleted', { userId, addressId });
  }

  /**
   * Sets the specified address as the default for the authenticated customer.
   * Atomically clears the previous default and sets the new one.
   * Throws NotFoundError if address does not exist or belongs to another user.
   *
   * @param {string} userId - From authenticated token
   * @param {string} addressId
   * @returns {Promise<object>} Updated address DTO
   */
  async setDefaultAddress(userId, addressId) {
    await this._requireActiveUser(userId);

    const updated = await this.addressRepository.setDefault(addressId, userId);
    logger.info('Default address set', { userId, addressId });
    return updated;
  }
}

module.exports = new AddressService();
