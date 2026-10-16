'use strict';

const adminReportsRepository = require('../repositories/admin-reports.repository');
const auditService = require('./audit.service');
const { PERMISSIONS } = require('../constants/permissions');
const { generateCsv } = require('../utils/csv');
const {
  BadRequestError,
  ForbiddenError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value, fieldName = 'id') {
  if (!value || typeof value !== 'string' || !UUID_REGEX.test(value.trim())) {
    throw new BadRequestError(`Invalid ${fieldName}: must be a valid UUID`, ERROR_CODES.VALIDATION_ERROR);
  }
  return value.trim();
}

/**
 * Validates bounded date range.
 *
 * @param {string} [startDateStr]
 * @param {string} [endDateStr]
 * @param {number} [maxDays=90]
 * @returns {{ startDate: Date|null, endDate: Date|null }}
 */
function assertValidDateRange(startDateStr, endDateStr, maxDays = 90) {
  let startDate = null;
  let endDate = null;

  if (startDateStr) {
    startDate = new Date(startDateStr);
    if (Number.isNaN(startDate.getTime())) {
      throw new BadRequestError('Invalid startDate: must be a valid ISO-8601 date string', ERROR_CODES.VALIDATION_ERROR);
    }
  }

  if (endDateStr) {
    endDate = new Date(endDateStr);
    if (Number.isNaN(endDate.getTime())) {
      throw new BadRequestError('Invalid endDate: must be a valid ISO-8601 date string', ERROR_CODES.VALIDATION_ERROR);
    }
  }

  if (startDate && endDate) {
    if (startDate.getTime() > endDate.getTime()) {
      throw new BadRequestError('startDate must be before or equal to endDate', ERROR_CODES.VALIDATION_ERROR);
    }

    const diffDays = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > maxDays) {
      throw new BadRequestError(`Date range exceeds maximum allowed limit of ${maxDays} days`, ERROR_CODES.VALIDATION_ERROR);
    }
  }

  return { startDate, endDate };
}

/**
 * Column definitions for CSV exports.
 */
const REPORT_COLUMNS = Object.freeze({
  bookings: [
    { key: 'bookingId', label: 'Booking ID' },
    { key: 'bookingNumber', label: 'Booking Number' },
    { key: 'customerName', label: 'Customer Name' },
    { key: 'customerPhone', label: 'Customer Phone' },
    { key: 'partnerBusinessName', label: 'Partner Business' },
    { key: 'vehicleRegistration', label: 'Vehicle Reg' },
    { key: 'vehicleBrand', label: 'Brand' },
    { key: 'vehicleModel', label: 'Model' },
    { key: 'city', label: 'City' },
    { key: 'bookingStatus', label: 'Status' },
    { key: 'paymentStatus', label: 'Payment Status' },
    { key: 'totalAmount', label: 'Total Amount (INR)' },
    { key: 'durationHours', label: 'Duration (Hours)' },
    { key: 'startDatetime', label: 'Start Time' },
    { key: 'endDatetime', label: 'End Time' },
    { key: 'cancellationReason', label: 'Cancellation Reason' },
    { key: 'createdAt', label: 'Created At' },
  ],
  customers: [
    { key: 'customerId', label: 'Customer ID' },
    { key: 'name', label: 'Customer Name' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'accountStatus', label: 'Status' },
    { key: 'totalBookings', label: 'Total Bookings' },
    { key: 'completedBookings', label: 'Completed Bookings' },
    { key: 'cancelledBookings', label: 'Cancelled Bookings' },
    { key: 'totalSpend', label: 'Total Spend (INR)' },
    { key: 'registrationDate', label: 'Registered Date' },
  ],
  partners: [
    { key: 'partnerId', label: 'Partner ID' },
    { key: 'businessName', label: 'Business Name' },
    { key: 'ownerName', label: 'Owner Name' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'city', label: 'City' },
    { key: 'partnerStatus', label: 'Status' },
    { key: 'kycStatus', label: 'KYC Status' },
    { key: 'totalVehicles', label: 'Total Vehicles' },
    { key: 'activeVehicles', label: 'Active Vehicles' },
    { key: 'totalBookings', label: 'Total Bookings' },
    { key: 'completedBookings', label: 'Completed Bookings' },
    { key: 'registrationDate', label: 'Registered Date' },
  ],
  vehicles: [
    { key: 'vehicleId', label: 'Vehicle ID' },
    { key: 'registrationNumber', label: 'Registration Number' },
    { key: 'partnerBusinessName', label: 'Partner Business' },
    { key: 'brand', label: 'Brand' },
    { key: 'model', label: 'Model' },
    { key: 'city', label: 'City' },
    { key: 'verificationStatus', label: 'Verification Status' },
    { key: 'rentalStatus', label: 'Rental Status' },
    { key: 'manualStatus', label: 'Manual Status' },
    { key: 'totalBookings', label: 'Total Bookings' },
    { key: 'completedBookings', label: 'Completed Bookings' },
    { key: 'totalRevenue', label: 'Total Revenue (INR)' },
    { key: 'createdAt', label: 'Created At' },
  ],
  payments: [
    { key: 'paymentId', label: 'Payment ID' },
    { key: 'bookingId', label: 'Booking ID' },
    { key: 'bookingNumber', label: 'Booking Number' },
    { key: 'customerName', label: 'Customer Name' },
    { key: 'partnerBusinessName', label: 'Partner Business' },
    { key: 'amount', label: 'Amount (INR)' },
    { key: 'currency', label: 'Currency' },
    { key: 'paymentType', label: 'Type' },
    { key: 'provider', label: 'Provider' },
    { key: 'providerReference', label: 'Provider Ref' },
    { key: 'status', label: 'Status' },
    { key: 'createdAt', label: 'Created At' },
  ],
  refunds: [
    { key: 'refundId', label: 'Refund ID' },
    { key: 'refundNumber', label: 'Refund Number' },
    { key: 'bookingNumber', label: 'Booking Number' },
    { key: 'customerName', label: 'Customer Name' },
    { key: 'requestedAmount', label: 'Requested Amount' },
    { key: 'approvedAmount', label: 'Approved Amount' },
    { key: 'refundedAmount', label: 'Refunded Amount' },
    { key: 'currency', label: 'Currency' },
    { key: 'status', label: 'Status' },
    { key: 'reason', label: 'Reason' },
    { key: 'provider', label: 'Provider' },
    { key: 'providerRefundId', label: 'Provider Refund Ref' },
    { key: 'processedAt', label: 'Processed At' },
    { key: 'createdAt', label: 'Created At' },
  ],
  commissions: [
    { key: 'commissionId', label: 'Commission ID' },
    { key: 'bookingId', label: 'Booking ID' },
    { key: 'bookingNumber', label: 'Booking Number' },
    { key: 'partnerBusinessName', label: 'Partner Business' },
    { key: 'commissionType', label: 'Type' },
    { key: 'commissionRate', label: 'Rate' },
    { key: 'grossBookingAmount', label: 'Gross Booking (INR)' },
    { key: 'commissionAmount', label: 'Commission Amount (INR)' },
    { key: 'partnerPayableAmount', label: 'Partner Payable (INR)' },
    { key: 'status', label: 'Status' },
    { key: 'createdAt', label: 'Created At' },
  ],
  wallets: [
    { key: 'transactionId', label: 'Transaction ID' },
    { key: 'walletId', label: 'Wallet ID' },
    { key: 'partnerBusinessName', label: 'Partner Business' },
    { key: 'transactionType', label: 'Type' },
    { key: 'amount', label: 'Amount (INR)' },
    { key: 'balanceAfter', label: 'Balance After (INR)' },
    { key: 'referenceType', label: 'Ref Type' },
    { key: 'referenceId', label: 'Ref ID' },
    { key: 'description', label: 'Description' },
    { key: 'createdAt', label: 'Created At' },
  ],
  payouts: [
    { key: 'payoutId', label: 'Payout ID' },
    { key: 'partnerId', label: 'Partner ID' },
    { key: 'partnerBusinessName', label: 'Partner Business' },
    { key: 'amount', label: 'Amount (INR)' },
    { key: 'status', label: 'Status' },
    { key: 'accountHolderName', label: 'Account Holder' },
    { key: 'bankName', label: 'Bank Name' },
    { key: 'accountNumberMasked', label: 'Account Number (Masked)' },
    { key: 'ifscCode', label: 'IFSC' },
    { key: 'requestedAt', label: 'Requested At' },
    { key: 'processedAt', label: 'Processed At' },
    { key: 'failureReason', label: 'Failure Reason' },
    { key: 'createdAt', label: 'Created At' },
  ],
  kyc: [
    { key: 'documentId', label: 'Document ID' },
    { key: 'entityType', label: 'Entity Type' },
    { key: 'entityId', label: 'Entity ID' },
    { key: 'entityName', label: 'Entity Name' },
    { key: 'documentType', label: 'Document Type' },
    { key: 'documentName', label: 'Document Name' },
    { key: 'verificationStatus', label: 'Verification Status' },
    { key: 'validTill', label: 'Valid Till' },
    { key: 'rejectionReason', label: 'Rejection Reason' },
    { key: 'submittedAt', label: 'Submitted At' },
  ],
  support: [
    { key: 'ticketId', label: 'Ticket ID' },
    { key: 'ticketNumber', label: 'Ticket Number' },
    { key: 'category', label: 'Category' },
    { key: 'priority', label: 'Priority' },
    { key: 'status', label: 'Status' },
    { key: 'customerName', label: 'Customer' },
    { key: 'partnerBusinessName', label: 'Partner' },
    { key: 'bookingNumber', label: 'Booking Number' },
    { key: 'assignedAdminName', label: 'Assigned Admin' },
    { key: 'resolutionDurationMinutes', label: 'Resolution (Mins)' },
    { key: 'createdAt', label: 'Created At' },
    { key: 'resolvedAt', label: 'Resolved At' },
    { key: 'closedAt', label: 'Closed At' },
  ],
  disputes: [
    { key: 'id', label: 'ID' },
    { key: 'reportType', label: 'Report Type' },
    { key: 'bookingNumber', label: 'Booking Number' },
    { key: 'customerName', label: 'Customer' },
    { key: 'partnerBusinessName', label: 'Partner' },
    { key: 'status', label: 'Status' },
    { key: 'amount', label: 'Amount (INR)' },
    { key: 'reasonOrDescription', label: 'Reason / Description' },
    { key: 'createdAt', label: 'Created At' },
    { key: 'resolvedAt', label: 'Resolved At' },
  ],
  notifications: [
    { key: 'notificationId', label: 'Notification ID' },
    { key: 'recipientRole', label: 'Role' },
    { key: 'recipientName', label: 'Recipient Name' },
    { key: 'channel', label: 'Channel' },
    { key: 'title', label: 'Title' },
    { key: 'status', label: 'Status' },
    { key: 'sentAt', label: 'Sent At' },
    { key: 'failedAt', label: 'Failed At' },
    { key: 'createdAt', label: 'Created At' },
  ],
  summary: [
    { key: 'metricGroup', label: 'Metric Category' },
    { key: 'metricName', label: 'Metric' },
    { key: 'metricValue', label: 'Value' },
  ],
});

class AdminReportsService {
  constructor(reportsRepo = adminReportsRepository, audit = auditService) {
    this.reportsRepo = reportsRepo;
    this.audit = audit;
  }

  /**
   * Helper to record non-sensitive audit trail for report operations.
   * @private
   */
  _recordReportAudit({ action, reportType, context = {}, filters = {}, rowCount = 0 }) {
    if (!this.audit || typeof this.audit.recordAction !== 'function') return;

    this.audit.recordAction({
      adminId: context.actorId || 'unknown-admin',
      role: context.actorRole || 'ADMIN',
      permission: context.permission || 'reports.read',
      action,
      targetResource: 'reports',
      targetResourceId: reportType,
      requestId: context.requestId || null,
      ipAddress: context.ipAddress || null,
      userAgent: context.userAgent || null,
      metadata: {
        reportType,
        filters: {
          startDate: filters.startDate || null,
          endDate: filters.endDate || null,
          status: filters.status || null,
          city: filters.city || null,
        },
        rowCount,
      },
    }).catch(() => {});
  }

  /**
   * Returns catalog of all supported administrative reports.
   *
   * @returns {object[]}
   */
  getReportCatalog() {
    return [
      {
        key: 'summary',
        name: 'Operational Summary Report',
        description: 'Platform-wide aggregated metrics across bookings, users, vehicles, payments, and support.',
        supportedFilters: ['startDate', 'endDate'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.DASHBOARD_READ],
      },
      {
        key: 'bookings',
        name: 'Bookings Report',
        description: 'Detailed rental reservations, duration, status, payment state, and cancellation metrics.',
        supportedFilters: ['startDate', 'endDate', 'status', 'city', 'partnerId', 'customerId', 'vehicleId'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.BOOKINGS_READ],
      },
      {
        key: 'customers',
        name: 'Customers Report',
        description: 'Customer account activity, total reservations, completed rides, and total spend.',
        supportedFilters: ['startDate', 'endDate', 'status', 'search'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.CUSTOMERS_READ],
      },
      {
        key: 'partners',
        name: 'Partners Report',
        description: 'Partner fleet providers, onboarding date, verification status, and fleet size.',
        supportedFilters: ['startDate', 'endDate', 'status', 'kycStatus', 'city', 'search'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.PARTNERS_READ],
      },
      {
        key: 'vehicles',
        name: 'Vehicles Report',
        description: 'Fleet inventory, rental status, verification state, and revenue generated per vehicle.',
        supportedFilters: ['startDate', 'endDate', 'partnerId', 'city', 'verificationStatus', 'rentalStatus', 'search'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.VEHICLES_READ],
      },
      {
        key: 'payments',
        name: 'Payments Report',
        description: 'Payment transactions, gateway references, settlement status, and captured volumes.',
        supportedFilters: ['startDate', 'endDate', 'status', 'provider'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.PAYMENTS_READ],
      },
      {
        key: 'refunds',
        name: 'Refunds Report',
        description: 'Refund disbursements, reasons, approval status, and gateway refund identifiers.',
        supportedFilters: ['startDate', 'endDate', 'status'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.REFUNDS_READ],
      },
      {
        key: 'commissions',
        name: 'Commission Report',
        description: 'Internal company commission transactions, rates, and platform revenue calculations.',
        supportedFilters: ['startDate', 'endDate', 'partnerId', 'status'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.COMMISSIONS_READ],
      },
      {
        key: 'wallets',
        name: 'Wallets & Earnings Report',
        description: 'Partner wallet ledger entries, transaction types, credits, debits, and balance updates.',
        supportedFilters: ['startDate', 'endDate', 'partnerId', 'transactionType'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.WALLETS_READ],
      },
      {
        key: 'payouts',
        name: 'Payouts Report',
        description: 'Partner bank payout requests, masked account numbers, and settlement timestamps.',
        supportedFilters: ['startDate', 'endDate', 'status', 'partnerId'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.PAYOUTS_READ],
      },
      {
        key: 'kyc',
        name: 'KYC & Verification Report',
        description: 'Document verification audit trail across partners, vehicles, and customer documents.',
        supportedFilters: ['startDate', 'endDate', 'entityType', 'status'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.KYC_READ],
      },
      {
        key: 'support',
        name: 'Support Tickets Report',
        description: 'Support inquiries, ticket priorities, resolution times, and assigned agents.',
        supportedFilters: ['startDate', 'endDate', 'status', 'priority', 'category'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.SUPPORT_READ],
      },
      {
        key: 'disputes',
        name: 'Damages & Disputes Report',
        description: 'Damage assessments, customer disputes, claims, and settlement amounts.',
        supportedFilters: ['startDate', 'endDate', 'status', 'reportType'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.DISPUTES_READ],
      },
      {
        key: 'notifications',
        name: 'Notifications Delivery Report',
        description: 'Notification delivery logs across SMS, WhatsApp, and push notification channels.',
        supportedFilters: ['startDate', 'endDate', 'channel', 'status', 'recipientType'],
        supportedExportFormats: ['csv'],
        permissionsRequired: [PERMISSIONS.REPORTS_READ, PERMISSIONS.NOTIFICATIONS_READ],
      },
    ];
  }

  /**
   * Retrieves operational summary across platform tables.
   */
  async getOperationalSummary(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 366);
    const summary = await this.reportsRepo.getOperationalSummary(startDate, endDate);

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'summary',
      context,
      filters: query,
    });

    return summary;
  }

  /**
   * Retrieves bookings report.
   */
  async getBookingsReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 90);
    const partnerId = query.partnerId ? assertUuid(query.partnerId, 'partnerId') : undefined;
    const customerId = query.customerId ? assertUuid(query.customerId, 'customerId') : undefined;
    const vehicleId = query.vehicleId ? assertUuid(query.vehicleId, 'vehicleId') : undefined;

    const data = await this.reportsRepo.getBookingsReport({
      ...query,
      startDate,
      endDate,
      partnerId,
      customerId,
      vehicleId,
    });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'bookings',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves customers report.
   */
  async getCustomersReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 366);
    const data = await this.reportsRepo.getCustomersReport({ ...query, startDate, endDate });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'customers',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves partners report.
   */
  async getPartnersReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 366);
    const data = await this.reportsRepo.getPartnersReport({ ...query, startDate, endDate });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'partners',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves vehicles report.
   */
  async getVehiclesReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 366);
    const partnerId = query.partnerId ? assertUuid(query.partnerId, 'partnerId') : undefined;
    const data = await this.reportsRepo.getVehiclesReport({
      ...query,
      startDate,
      endDate,
      partnerId,
    });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'vehicles',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves payments report.
   */
  async getPaymentsReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 90);
    const data = await this.reportsRepo.getPaymentsReport({ ...query, startDate, endDate });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'payments',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves refunds report.
   */
  async getRefundsReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 90);
    const data = await this.reportsRepo.getRefundsReport({ ...query, startDate, endDate });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'refunds',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves commissions report (Finance Internal Data).
   */
  async getCommissionsReport(query = {}, context = {}) {
    const user = context.user || {};
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    const isSuperAdmin = user.role === 'SUPER_ADMIN' || perms.includes('SUPER_ADMIN');
    const hasFinance = isSuperAdmin || perms.includes(PERMISSIONS.COMMISSIONS_READ);

    if (!hasFinance) {
      throw new ForbiddenError('Insufficient permissions to view internal commission data', ERROR_CODES.FORBIDDEN);
    }

    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 90);
    const partnerId = query.partnerId ? assertUuid(query.partnerId, 'partnerId') : undefined;
    const data = await this.reportsRepo.getCommissionsReport({
      ...query,
      startDate,
      endDate,
      partnerId,
    });

    this._recordReportAudit({
      action: 'REPORT_FINANCIAL_VIEWED',
      reportType: 'commissions',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves wallets report.
   */
  async getWalletsReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 90);
    const partnerId = query.partnerId ? assertUuid(query.partnerId, 'partnerId') : undefined;
    const data = await this.reportsRepo.getWalletsReport({
      ...query,
      startDate,
      endDate,
      partnerId,
    });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'wallets',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves payouts report.
   */
  async getPayoutsReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 90);
    const partnerId = query.partnerId ? assertUuid(query.partnerId, 'partnerId') : undefined;
    const data = await this.reportsRepo.getPayoutsReport({
      ...query,
      startDate,
      endDate,
      partnerId,
    });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'payouts',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves KYC verification report.
   */
  async getKycReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 90);
    const data = await this.reportsRepo.getKycReport({ ...query, startDate, endDate });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'kyc',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves support report.
   */
  async getSupportReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 90);
    const data = await this.reportsRepo.getSupportReport({ ...query, startDate, endDate });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'support',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves disputes and damage reports.
   */
  async getDisputesReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 90);
    const data = await this.reportsRepo.getDisputesReport({ ...query, startDate, endDate });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'disputes',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Retrieves notifications delivery report.
   */
  async getNotificationsReport(query = {}, context = {}) {
    const { startDate, endDate } = assertValidDateRange(query.startDate, query.endDate, 90);
    const data = await this.reportsRepo.getNotificationsReport({ ...query, startDate, endDate });

    this._recordReportAudit({
      action: 'REPORT_VIEWED',
      reportType: 'notifications',
      context,
      filters: query,
      rowCount: data.items.length,
    });

    return data;
  }

  /**
   * Generates a controlled CSV export for any valid report type.
   *
   * @param {object} payload
   * @param {string} payload.reportType
   * @param {string} [payload.format='csv']
   * @param {object} [payload.filters={}]
   * @param {number} [payload.limit=1000]
   * @param {object} [context={}]
   * @returns {Promise<{ csv: string, filename: string, rowCount: number, generatedAt: string }>}
   */
  async exportReport(payload = {}, context = {}) {
    const { reportType, format = 'csv', filters = {}, limit = 1000 } = payload;

    if (!reportType || typeof reportType !== 'string') {
      throw new BadRequestError('reportType is required', ERROR_CODES.VALIDATION_ERROR);
    }

    const cleanType = reportType.toLowerCase().trim();
    const columns = REPORT_COLUMNS[cleanType];
    if (!columns) {
      throw new BadRequestError(`Unsupported reportType: '${reportType}'`, ERROR_CODES.VALIDATION_ERROR);
    }

    if (format && format.toLowerCase() !== 'csv') {
      throw new BadRequestError("Only 'csv' format is supported for data export", ERROR_CODES.VALIDATION_ERROR);
    }

    // Security Guard: Commission reports require explicit commissions.read or SUPER_ADMIN
    if (cleanType === 'commissions') {
      const user = context.user || {};
      const perms = Array.isArray(user.permissions) ? user.permissions : [];
      const isSuperAdmin = user.role === 'SUPER_ADMIN' || perms.includes('SUPER_ADMIN');
      const hasFinance = isSuperAdmin || perms.includes(PERMISSIONS.COMMISSIONS_READ);

      if (!hasFinance) {
        throw new ForbiddenError('Insufficient permissions to export internal commission data', ERROR_CODES.FORBIDDEN);
      }
    }

    // Enforce safe export size cap (max 5,000 rows)
    const exportLimit = Math.max(1, Math.min(5000, parseInt(limit, 10) || 1000));
    const queryOptions = {
      ...filters,
      page: 1,
      limit: exportLimit,
      maxLimit: 5000,
    };

    let items = [];

    if (cleanType === 'summary') {
      const summary = await this.getOperationalSummary(filters, context);
      items = [
        { metricGroup: 'Customers', metricName: 'Total Customers', metricValue: summary.customers.total },
        { metricGroup: 'Customers', metricName: 'Active Customers', metricValue: summary.customers.active },
        { metricGroup: 'Partners', metricName: 'Total Partners', metricValue: summary.partners.total },
        { metricGroup: 'Partners', metricName: 'Verified Partners', metricValue: summary.partners.verified },
        { metricGroup: 'Partners', metricName: 'Pending KYC', metricValue: summary.partners.pendingKyc },
        { metricGroup: 'Vehicles', metricName: 'Total Vehicles', metricValue: summary.vehicles.total },
        { metricGroup: 'Vehicles', metricName: 'Active Vehicles', metricValue: summary.vehicles.active },
        { metricGroup: 'Bookings', metricName: 'Total Bookings', metricValue: summary.bookings.total },
        { metricGroup: 'Bookings', metricName: 'Completed Bookings', metricValue: summary.bookings.completed },
        { metricGroup: 'Bookings', metricName: 'Cancelled Bookings', metricValue: summary.bookings.cancelled },
        { metricGroup: 'Bookings', metricName: 'Gross Booking Value (INR)', metricValue: summary.bookings.grossBookingValue },
        { metricGroup: 'Payments', metricName: 'Collected (INR)', metricValue: summary.payments.collected },
        { metricGroup: 'Refunds', metricName: 'Refunded (INR)', metricValue: summary.refunds.totalRefunded },
        { metricGroup: 'Payouts', metricName: 'Completed Payouts (INR)', metricValue: summary.payouts.completed },
        { metricGroup: 'Support', metricName: 'Open Tickets', metricValue: summary.support.open },
        { metricGroup: 'Notifications', metricName: 'Total Sent', metricValue: summary.notifications.sent },
      ];
    } else {
      const reportMap = {
        bookings: () => this.getBookingsReport(queryOptions, context),
        customers: () => this.getCustomersReport(queryOptions, context),
        partners: () => this.getPartnersReport(queryOptions, context),
        vehicles: () => this.getVehiclesReport(queryOptions, context),
        payments: () => this.getPaymentsReport(queryOptions, context),
        refunds: () => this.getRefundsReport(queryOptions, context),
        commissions: () => this.getCommissionsReport(queryOptions, context),
        wallets: () => this.getWalletsReport(queryOptions, context),
        payouts: () => this.getPayoutsReport(queryOptions, context),
        kyc: () => this.getKycReport(queryOptions, context),
        support: () => this.getSupportReport(queryOptions, context),
        disputes: () => this.getDisputesReport(queryOptions, context),
        notifications: () => this.getNotificationsReport(queryOptions, context),
      };

      const result = await reportMap[cleanType]();
      items = result.items || [];
    }

    const csv = generateCsv(items, columns);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `report-${cleanType}-${timestamp}.csv`;

    this._recordReportAudit({
      action: 'REPORT_EXPORTED',
      reportType: cleanType,
      context,
      filters,
      rowCount: items.length,
    });

    return {
      csv,
      filename,
      rowCount: items.length,
      generatedAt: new Date().toISOString(),
    };
  }
}

const instance = new AdminReportsService();
instance.AdminReportsService = AdminReportsService;

module.exports = instance;
