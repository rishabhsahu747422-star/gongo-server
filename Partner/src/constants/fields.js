'use strict';

/**
 * Server-owned fields that must never be set directly by client requests.
 * These are strictly calculated, generated, or maintained by backend services.
 */
const PROTECTED_SERVER_FIELDS = Object.freeze([
  'id',
  'partnerId',
  'userId',
  'authId',
  'role',
  'status',
  'partnerStatus',
  'kycStatus',
  'verificationStatus',
  'rejectionReason',
  'rating',
  'reviewCount',
  'registeredSince',
  'isNewPartner',
  'storageKey',
  'walletBalance',
  'availableBalance',
  'commission',
  'commissionRate',
  'commissionAmount',
  'partnerNetAmount',
  'paymentStatus',
  'payoutStatus',
  'isActive',
  'createdAt',
  'updatedAt',
]);

module.exports = { PROTECTED_SERVER_FIELDS };
