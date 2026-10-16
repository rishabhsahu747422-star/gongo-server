'use strict';

const express = require('express');
const customerController = require('../controllers/customer.controller');
const addressController = require('../controllers/address.controller');
const notificationController = require('../controllers/notification.controller');
const supportController = require('../controllers/support.controller');
const authenticate = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const {
  validateUpdateProfile,
  validateCreateAddress,
  validateUpdateAddress,
  validateAddressId,
} = require('../validators');
const {
  validateRegisterDevice,
  validateListNotifications,
  validateNotificationId,
  validateDeviceId,
} = require('../validators/notification.validator');
const {
  validateCreateTicket,
  validateListTickets,
  validateTicketId,
  validateCreateMessage,
} = require('../validators/support.validator');
const {
  validateDocumentUploadUrl,
  validateDocumentCompletion,
  validateAvatarUploadUrl,
  validateAvatarCompletion,
} = require('../validators/storage.validator');

const router = express.Router();

/**
 * All customer endpoints require:
 * 1. Valid authenticated Firebase identity via Bearer token (authenticate)
 * 2. Strict role enforcement: role must be 'customer' (requireRole('customer'))
 */
router.use(authenticate);
router.use(requireRole('customer', 'CUSTOMER'));

/**
 * @route   GET /api/v1/customers/me
 * @desc    Get current authenticated customer's profile and verification status
 * @access  Private (Customer only)
 */
router.get('/me', (req, res, next) => customerController.getMe(req, res, next));

/**
 * @route   PATCH /api/v1/customers/me
 * @desc    Update current authenticated customer's allowlisted profile fields (name, email)
 * @access  Private (Customer only)
 */
router.patch('/me', validateUpdateProfile, (req, res, next) => (
  customerController.updateMe(req, res, next)
));

/**
 * @route   GET /api/v1/customers/me/documents
 * @desc    Get current authenticated customer's document verification records
 * @access  Private (Customer only)
 */
router.get('/me/documents', (req, res, next) => (
  customerController.getDocuments(req, res, next)
));

/**
 * @route   POST /api/v1/customers/me/documents/upload-url
 * @desc    Generate presigned upload URL for customer KYC document
 * @access  Private (Customer only)
 */
router.post(
  '/me/documents/upload-url',
  validateDocumentUploadUrl,
  (req, res, next) => customerController.getDocumentUploadUrl(req, res, next),
);

/**
 * @route   POST /api/v1/customers/me/documents
 * @desc    Confirm customer KYC document upload and persist record
 * @access  Private (Customer only)
 */
router.post(
  '/me/documents',
  validateDocumentCompletion,
  (req, res, next) => customerController.completeDocumentUpload(req, res, next),
);

/**
 * @route   POST /api/v1/customers/me/avatar/upload-url
 * @desc    Generate presigned upload URL for customer profile avatar
 * @access  Private (Customer only)
 */
router.post(
  '/me/avatar/upload-url',
  validateAvatarUploadUrl,
  (req, res, next) => customerController.getAvatarUploadUrl(req, res, next),
);

/**
 * @route   POST /api/v1/customers/me/avatar
 * @desc    Confirm customer profile avatar upload and update profile
 * @access  Private (Customer only)
 */
router.post(
  '/me/avatar',
  validateAvatarCompletion,
  (req, res, next) => customerController.completeAvatarUpload(req, res, next),
);

// ── Saved Addresses ──────────────────────────────────────────────────────────

/**
 * @route   POST /api/v1/customers/me/addresses
 * @desc    Create a new saved address for the authenticated customer
 * @access  Private (Customer only)
 */
router.post(
  '/me/addresses',
  validateCreateAddress,
  (req, res, next) => addressController.createAddress(req, res, next),
);

/**
 * @route   GET /api/v1/customers/me/addresses
 * @desc    List all saved addresses for the authenticated customer
 * @access  Private (Customer only)
 */
router.get('/me/addresses', (req, res, next) => addressController.listAddresses(req, res, next));

/**
 * @route   GET /api/v1/customers/me/addresses/:id
 * @desc    Get a single saved address by ID (must belong to authenticated customer)
 * @access  Private (Customer only)
 */
router.get(
  '/me/addresses/:id',
  validateAddressId,
  (req, res, next) => addressController.getAddress(req, res, next),
);

/**
 * @route   PATCH /api/v1/customers/me/addresses/:id
 * @desc    Update a saved address (must belong to authenticated customer)
 * @access  Private (Customer only)
 */
router.patch(
  '/me/addresses/:id',
  validateAddressId,
  validateUpdateAddress,
  (req, res, next) => addressController.updateAddress(req, res, next),
);

/**
 * @route   DELETE /api/v1/customers/me/addresses/:id
 * @desc    Delete a saved address (must belong to authenticated customer)
 *          Note: if the deleted address was the default, no auto-promotion occurs.
 * @access  Private (Customer only)
 */
router.delete(
  '/me/addresses/:id',
  validateAddressId,
  (req, res, next) => addressController.deleteAddress(req, res, next),
);

/**
 * @route   PATCH /api/v1/customers/me/addresses/:id/default
 * @desc    Set a saved address as the default (atomically clears previous default)
 * @access  Private (Customer only)
 */
router.patch(
  '/me/addresses/:id/default',
  validateAddressId,
  (req, res, next) => addressController.setDefaultAddress(req, res, next),
);

// ── Customer Devices (FCM) ──────────────────────────────────────────────────

/**
 * @route   POST /api/v1/customers/me/devices
 * @desc    Register a new device token or refresh an existing one
 * @access  Private (Customer only)
 */
router.post(
  '/me/devices',
  validateRegisterDevice,
  (req, res, next) => notificationController.registerDevice(req, res, next),
);

/**
 * @route   GET /api/v1/customers/me/devices
 * @desc    List all registered devices for the authenticated customer
 * @access  Private (Customer only)
 */
router.get(
  '/me/devices',
  (req, res, next) => notificationController.listDevices(req, res, next),
);

/**
 * @route   DELETE /api/v1/customers/me/devices/:deviceId
 * @desc    Deactivate a device token belonging to the customer
 * @access  Private (Customer only)
 */
router.delete(
  '/me/devices/:deviceId',
  validateDeviceId,
  (req, res, next) => notificationController.removeDevice(req, res, next),
);

// ── Notifications ───────────────────────────────────────────────────────────

/**
 * @route   GET /api/v1/customers/me/notifications/unread-count
 * @desc    Get count of unread notifications for authenticated customer
 * @access  Private (Customer only)
 */
router.get(
  '/me/notifications/unread-count',
  (req, res, next) => notificationController.getUnreadCount(req, res, next),
);

/**
 * @route   PATCH /api/v1/customers/me/notifications/read-all
 * @desc    Mark all unread notifications as read for authenticated customer
 * @access  Private (Customer only)
 */
router.patch(
  '/me/notifications/read-all',
  (req, res, next) => notificationController.markAllAsRead(req, res, next),
);

/**
 * @route   GET /api/v1/customers/me/notifications
 * @desc    List paginated notifications for the customer
 * @access  Private (Customer only)
 */
router.get(
  '/me/notifications',
  validateListNotifications,
  (req, res, next) => notificationController.listNotifications(req, res, next),
);

/**
 * @route   GET /api/v1/customers/me/notifications/:notificationId
 * @desc    Get details of a single notification (must belong to customer)
 * @access  Private (Customer only)
 */
router.get(
  '/me/notifications/:notificationId',
  validateNotificationId,
  (req, res, next) => notificationController.getNotification(req, res, next),
);

/**
 * @route   PATCH /api/v1/customers/me/notifications/:notificationId/read
 * @desc    Mark a single notification as read (must belong to customer)
 * @access  Private (Customer only)
 */
router.patch(
  '/me/notifications/:notificationId/read',
  validateNotificationId,
  (req, res, next) => notificationController.markAsRead(req, res, next),
);

// ── Support Tickets & Conversations ─────────────────────────────────────────

/**
 * @route   POST /api/v1/customers/me/support/tickets
 * @desc    Create a new support ticket and initial customer message
 * @access  Private (Customer only)
 */
router.post(
  '/me/support/tickets',
  validateCreateTicket,
  (req, res, next) => supportController.createTicket(req, res, next),
);

/**
 * @route   GET /api/v1/customers/me/support/tickets
 * @desc    List support tickets belonging to the customer
 * @access  Private (Customer only)
 */
router.get(
  '/me/support/tickets',
  validateListTickets,
  (req, res, next) => supportController.listTickets(req, res, next),
);

/**
 * @route   GET /api/v1/customers/me/support/tickets/:ticketId
 * @desc    Get details and message history of a single support ticket
 * @access  Private (Customer only)
 */
router.get(
  '/me/support/tickets/:ticketId',
  validateTicketId,
  (req, res, next) => supportController.getTicket(req, res, next),
);

/**
 * @route   POST /api/v1/customers/me/support/tickets/:ticketId/messages
 * @desc    Send a message in a support ticket thread
 * @access  Private (Customer only)
 */
router.post(
  '/me/support/tickets/:ticketId/messages',
  validateTicketId,
  validateCreateMessage,
  (req, res, next) => supportController.addMessage(req, res, next),
);

module.exports = router;
