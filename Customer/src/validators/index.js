'use strict';

const authValidator = require('./auth.validator');
const customerValidator = require('./customer.validator');
const addressValidator = require('./address.validator');
const vehicleValidator = require('./vehicle.validator');
const bookingValidator = require('./booking.validator');

module.exports = {
  ...authValidator,
  ...customerValidator,
  ...addressValidator,
  ...vehicleValidator,
  ...bookingValidator,
};
