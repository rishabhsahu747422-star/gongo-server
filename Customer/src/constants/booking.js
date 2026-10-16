'use strict';

/**
 * Booking domain constants and lifecycle configuration.
 */

const BOOKING_STATUS = Object.freeze({
  INITIATED: 'initiated',
  PENDING: 'PENDING',
  PAYMENT_PENDING: 'payment_pending',
  PAYMENT_COMPLETED: 'payment_completed',
  CONFIRMED: 'confirmed',
  ACCEPTED: 'confirmed',
  PICKUP_SCHEDULED: 'pickup_scheduled',
  VEHICLE_PICKED: 'vehicle_picked',
  IN_PROGRESS: 'in_progress',
  RETURN_PENDING: 'return_pending',
  RETURNED: 'returned',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
});

/**
 * Statuses that block a vehicle from being booked by another customer.
 */
const BLOCKING_STATUSES = Object.freeze([
  BOOKING_STATUS.INITIATED,
  BOOKING_STATUS.PAYMENT_PENDING,
  BOOKING_STATUS.PAYMENT_COMPLETED,
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.PICKUP_SCHEDULED,
  BOOKING_STATUS.VEHICLE_PICKED,
  BOOKING_STATUS.IN_PROGRESS,
  BOOKING_STATUS.RETURN_PENDING,
  'ACTIVE',
  'active',
  'PENDING',
  'ACCEPTED',
  'PAYMENT_PENDING',
  'PAYMENT_COMPLETED',
  'PICKUP_SCHEDULED',
  'VEHICLE_PICKED',
  'IN_PROGRESS',
  'RETURN_PENDING',
  'return_pending',
  'BOOKED',
  'booked',
  'OVERDUE',
  'overdue',
]);

/**
 * Statuses from which a customer is permitted to cancel their booking.
 * Once a vehicle is picked up or marked in-progress, customer self-cancellation is disallowed.
 */
const CANCELLABLE_STATUSES = Object.freeze([
  BOOKING_STATUS.INITIATED,
  'INITIATED',
  'initiated',
  BOOKING_STATUS.PAYMENT_PENDING,
  BOOKING_STATUS.CONFIRMED,
  'PENDING',
  'ACCEPTED',
  'PAYMENT_PENDING',
  'CONFIRMED',
]);

const RENTAL_TYPE = Object.freeze({
  HOURLY: 'HOURLY',
  DAILY: 'DAILY',
  WEEKLY: 'WEEKLY',
  MONTHLY: 'MONTHLY',
});

const BOOKING_PAGINATION = Object.freeze({
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 50,
});

const DURATION_LIMITS = Object.freeze({
  MIN_HOURLY_HOURS: 1,
  MIN_DAILY_DAYS: 1,
  MIN_WEEKLY_DAYS: 7,
  MIN_MONTHLY_DAYS: 30,
  MAX_RENTAL_DAYS: 365,
});

module.exports = {
  BOOKING_STATUS,
  BLOCKING_STATUSES,
  CANCELLABLE_STATUSES,
  RENTAL_TYPE,
  BOOKING_PAGINATION,
  DURATION_LIMITS,
};
