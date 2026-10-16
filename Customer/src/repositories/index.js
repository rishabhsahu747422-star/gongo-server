'use strict';

const BaseRepository = require('./base.repository');
const UserRepository = require('./user.repository');
const CustomerRepository = require('./customer.repository');
const CustomerDocumentRepository = require('./customer-document.repository');
const AddressRepository = require('./address.repository');
const VehicleRepository = require('./vehicle.repository');
const BookingRepository = require('./booking.repository');
const IdempotencyRepository = require('./idempotency.repository');
const PlatformFeeRepository = require('./platform-fee.repository');

module.exports = {
  BaseRepository,
  UserRepository,
  CustomerRepository,
  CustomerDocumentRepository,
  AddressRepository,
  VehicleRepository,
  BookingRepository,
  IdempotencyRepository,
  PlatformFeeRepository,
};
