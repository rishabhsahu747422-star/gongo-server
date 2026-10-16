'use strict';

const adminCustomerRepository = require('../repositories/admin-customer.repository');
const adminActionRepository = require('../repositories/admin-action.repository');
const auditService = require('./audit.service');
const { ValidationError, NotFoundError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const logger = require('../config/logger');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SORT_COLS = new Set(['created_at', 'updated_at', 'name', 'email', 'phone']);
const ALLOWED_UPDATE_FIELDS = new Set(['isActive', 'is_active', 'reason', 'force']);

class AdminCustomerService {
  /**
   * Asserts valid UUID format for customer identifiers.
   * @private
   */
  _assertUuid(id, paramName = 'id') {
    if (!id || typeof id !== 'string') {
      throw new ValidationError(`Invalid ${paramName}: must be a valid identifier`, [
        { field: paramName, message: 'Invalid identifier format' },
      ]);
    }
    const trimmed = id.trim();
    const isDevMockId = process.env.NODE_ENV !== 'test' && /^(bkg|cust|prt|veh|shop|usr|admin)-[0-9]+$/i.test(trimmed);
    if (!UUID_REGEX.test(trimmed) && !isDevMockId) {
      throw new ValidationError(`Invalid ${paramName}: must be a valid identifier`, [
        { field: paramName, message: 'Invalid identifier format' },
      ]);
    }
    return trimmed;
  }

  /**
   * Validates and normalizes date range parameters for listing queries.
   * @private
   */
  _parseDates(startDateStr, endDateStr) {
    if (!startDateStr && !endDateStr) {
      return { startDate: null, endDate: null };
    }

    if (!startDateStr || !endDateStr) {
      throw new ValidationError('Both startDate and endDate are required for date range filter');
    }

    const start = new Date(startDateStr);
    const end = new Date(endDateStr);

    if (Number.isNaN(start.getTime())) {
      throw new ValidationError('Invalid startDate format');
    }
    if (Number.isNaN(end.getTime())) {
      throw new ValidationError('Invalid endDate format');
    }

    let adjustedEnd = end;
    if (/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
      adjustedEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    }

    if (start >= adjustedEnd) {
      throw new ValidationError('startDate must be before endDate');
    }

    if (adjustedEnd.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) {
      throw new ValidationError('Date range cannot exceed 366 days');
    }

    return { startDate: start, endDate: adjustedEnd };
  }

  /**
   * GET /api/v1/admin/customers
   * Lists customers with pagination, search, and multidimensional filters.
   *
   * @param {object} [query={}]
   * @returns {Promise<object>}
   */
  async listCustomers(query = {}) {
    const rawSearch = query.search || query.q;
    const search = rawSearch && typeof rawSearch === 'string'
      ? rawSearch.trim().slice(0, 100)
      : null;

    let isActive = null;
    if (query.isActive !== undefined || query.is_active !== undefined) {
      const val = query.isActive !== undefined ? query.isActive : query.is_active;
      if (val === true || val === 'true') isActive = true;
      else if (val === false || val === 'false') isActive = false;
      else {
        throw new ValidationError('isActive must be a boolean (true or false)');
      }
    }

    const { startDate, endDate } = this._parseDates(
      query.startDate || query.from,
      query.endDate || query.to,
    );

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 10;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    if (Number.isNaN(limit) || limit < 1) {
      throw new ValidationError('limit must be a positive integer between 1 and 50');
    }
    if (Number.isNaN(offset) || offset < 0) {
      throw new ValidationError('offset must be a non-negative integer');
    }

    const safeLimit = Math.min(limit, 50);
    const safeOffset = offset;

    const rawSortBy = query.sortBy || query.sort;
    const sortBy = rawSortBy && ALLOWED_SORT_COLS.has(rawSortBy.toLowerCase().trim())
      ? rawSortBy.toLowerCase().trim()
      : 'created_at';

    const rawSortOrder = query.sortOrder || query.order;
    const sortOrder = rawSortOrder && String(rawSortOrder).toUpperCase().trim() === 'ASC'
      ? 'ASC'
      : 'DESC';

    logger.info('Listing admin customers', {
      search,
      isActive,
      limit: safeLimit,
      offset: safeOffset,
      sortBy,
      sortOrder,
    });

    const { customers, total } = await adminCustomerRepository.listCustomers({
      search,
      isActive,
      startDate,
      endDate,
      limit: safeLimit,
      offset: safeOffset,
      sortBy,
      sortOrder,
    });

    const pages = Math.ceil(total / safeLimit) || 1;

    return {
      customers,
      pagination: {
        total,
        limit: safeLimit,
        offset: safeOffset,
        pages,
      },
    };
  }

  /**
   * GET /api/v1/admin/customers/:id
   * Retrieves customer detail view with booking, payment, document, and address summaries.
   *
   * @param {string} customerId
   * @returns {Promise<object>}
   */
  async getCustomerDetail(customerId) {
    const validId = this._assertUuid(customerId);

    const customer = await adminCustomerRepository.findCustomerById(validId);
    if (!customer) {
      throw new NotFoundError('Customer not found', ERROR_CODES.NOT_FOUND);
    }

    const [summaries, documents, verifications, bookingsData, paymentsData, support, activityData] =
      await Promise.all([
        adminCustomerRepository.getCustomerSummaries(validId),
        adminCustomerRepository.getCustomerDocuments(validId).catch(() => []),
        adminCustomerRepository.getCustomerVerifications(validId).catch(() => []),
        adminCustomerRepository.getCustomerBookings(validId, { limit: 10 }).catch(() => ({ bookings: [] })),
        adminCustomerRepository.getCustomerPayments(validId, { limit: 10 }).catch(() => ({ payments: [] })),
        adminCustomerRepository.getCustomerSupportTickets(validId).catch(() => []),
        adminCustomerRepository.getCustomerActivity(validId, { limit: 10 }).catch(() => ({ activity: [] })),
      ]);

    return {
      customer,
      basicProfile: customer,
      documents: documents || [],
      identityVerification: verifications || [],
      bookings: bookingsData?.bookings || [],
      payments: paymentsData?.payments || [],
      support: support || [],
      activity: activityData?.activity || [],
      ...(summaries || {}),
    };
  }

  async getCustomerVerifications(customerId) {
    const validId = this._assertUuid(customerId);
    const verifications = await adminCustomerRepository.getCustomerVerifications(validId);
    return { verifications };
  }

  async getCustomerSupportTickets(customerId) {
    const validId = this._assertUuid(customerId);
    const supportTickets = await adminCustomerRepository.getCustomerSupportTickets(validId);
    return { supportTickets, tickets: supportTickets };
  }

  /**
   * PATCH /api/v1/admin/customers/:id/status
   * Updates customer active/inactive status with deactivation safety and audit logging.
   *
   * @param {string} customerId
   * @param {object} body
   * @param {object} auditContext
   * @returns {Promise<object>}
   */
  async updateCustomerStatus(customerId, body = {}, auditContext = {}) {
    const validId = this._assertUuid(customerId);

    if (!body || typeof body !== 'object') {
      throw new ValidationError('Request body is required');
    }

    // Mass-assignment protection
    Object.keys(body).forEach((key) => {
      if (!ALLOWED_UPDATE_FIELDS.has(key)) {
        throw new ValidationError(`Field '${key}' is not allowed in customer status update`);
      }
    });

    let newIsActive = null;
    if (body.isActive !== undefined || body.is_active !== undefined) {
      const val = body.isActive !== undefined ? body.isActive : body.is_active;
      if (typeof val === 'boolean') {
        newIsActive = val;
      } else if (val === 'true') {
        newIsActive = true;
      } else if (val === 'false') {
        newIsActive = false;
      } else {
        throw new ValidationError('isActive must be a boolean');
      }
    }

    if (newIsActive === null) {
      throw new ValidationError('isActive parameter is required');
    }

    const reason = body.reason && typeof body.reason === 'string'
      ? body.reason.trim().slice(0, 500)
      : null;

    const force = Boolean(body.force);

    const customer = await adminCustomerRepository.findCustomerById(validId);
    if (!customer) {
      throw new NotFoundError('Customer not found', ERROR_CODES.NOT_FOUND);
    }

    const beforeState = { isActive: customer.isActive };
    const action = newIsActive === false ? 'CUSTOMER_SUSPEND' : 'CUSTOMER_STATUS_CHANGE';

    const updated = await adminCustomerRepository.withTransaction(async (client) => {
      const lockedCustomer = await adminCustomerRepository.findCustomerByIdForUpdate(
        validId,
        client,
      );
      if (!lockedCustomer) {
        throw new NotFoundError('Customer not found', ERROR_CODES.NOT_FOUND);
      }

      // Deactivation safety: check active/ongoing bookings under row lock
      // unless force is explicitly set
      if (newIsActive === false && lockedCustomer.isActive === true) {
        const activeBookings = await adminCustomerRepository.getActiveBookingCount(validId, client);
        if (activeBookings > 0 && !force) {
          throw new ValidationError(
            `Cannot deactivate customer with ${activeBookings} active/upcoming bookings. `
            + 'Cancel or complete bookings first or specify force: true.',
            [{ field: 'isActive', message: 'Customer has active bookings', count: activeBookings }],
          );
        }
      }

      const res = await adminCustomerRepository.updateCustomerStatus(
        validId,
        newIsActive,
        client,
      );

      await adminActionRepository.createAction({
        actorId: auditContext.actorId || 'system-admin',
        actorRole: auditContext.actorRole || 'ADMIN',
        permission: auditContext.permission || 'customers.update',
        action,
        targetResource: 'CUSTOMER',
        targetResourceId: validId,
        requestId: auditContext.requestId || null,
        ipAddress: auditContext.ipAddress || null,
        userAgent: auditContext.userAgent || null,
        beforeState,
        afterState: { isActive: res.isActive },
        metadata: { reason, force },
      }, client);

      return res;
    });

    auditService.logAdminAction({
      actorId: auditContext.actorId || 'system-admin',
      actorRole: auditContext.actorRole || 'ADMIN',
      permission: auditContext.permission || 'customers.update',
      action,
      targetResource: 'CUSTOMER',
      targetResourceId: validId,
      requestId: auditContext.requestId || null,
      ipAddress: auditContext.ipAddress || null,
      userAgent: auditContext.userAgent || null,
      beforeState,
      afterState: { isActive: updated.isActive },
      metadata: { reason, force },
    });

    return updated;
  }

  /**
   * GET /api/v1/admin/customers/:id/bookings
   */
  async getCustomerBookings(customerId, query = {}) {
    const validId = this._assertUuid(customerId);
    const customer = await adminCustomerRepository.findCustomerById(validId);
    if (!customer) {
      throw new NotFoundError('Customer not found', ERROR_CODES.NOT_FOUND);
    }

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 10;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    const { bookings, total } = await adminCustomerRepository.getCustomerBookings(
      validId,
      {
        status: query.status || query.booking_status || null,
        limit,
        offset,
      },
    );

    return {
      bookings,
      pagination: {
        total,
        limit: Math.min(Math.max(1, limit), 50),
        offset: Math.max(0, offset),
      },
    };
  }

  /**
   * GET /api/v1/admin/customers/:id/payments
   */
  async getCustomerPayments(customerId, query = {}) {
    const validId = this._assertUuid(customerId);
    const customer = await adminCustomerRepository.findCustomerById(validId);
    if (!customer) {
      throw new NotFoundError('Customer not found', ERROR_CODES.NOT_FOUND);
    }

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 10;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    const { payments, total } = await adminCustomerRepository.getCustomerPayments(
      validId,
      {
        status: query.status || null,
        limit,
        offset,
      },
    );

    return {
      payments,
      pagination: {
        total,
        limit: Math.min(Math.max(1, limit), 50),
        offset: Math.max(0, offset),
      },
    };
  }

  /**
   * GET /api/v1/admin/customers/:id/documents
   */
  async getCustomerDocuments(customerId) {
    const validId = this._assertUuid(customerId);
    const customer = await adminCustomerRepository.findCustomerById(validId);
    if (!customer) {
      throw new NotFoundError('Customer not found', ERROR_CODES.NOT_FOUND);
    }

    const documents = await adminCustomerRepository.getCustomerDocuments(validId);
    return { documents };
  }

  /**
   * GET /api/v1/admin/customers/:id/addresses
   */
  async getCustomerAddresses(customerId) {
    const validId = this._assertUuid(customerId);
    const customer = await adminCustomerRepository.findCustomerById(validId);
    if (!customer) {
      throw new NotFoundError('Customer not found', ERROR_CODES.NOT_FOUND);
    }

    const addresses = await adminCustomerRepository.getCustomerAddresses(validId);
    return { addresses };
  }

  /**
   * GET /api/v1/admin/customers/:id/activity
   */
  async getCustomerActivity(customerId, query = {}) {
    const validId = this._assertUuid(customerId);
    const customer = await adminCustomerRepository.findCustomerById(validId);
    if (!customer) {
      throw new NotFoundError('Customer not found', ERROR_CODES.NOT_FOUND);
    }

    const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 10;
    const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;

    const { activity, total } = await adminCustomerRepository.getCustomerActivity(
      validId,
      { limit, offset },
    );

    return {
      activity,
      pagination: {
        total,
        limit: Math.min(Math.max(1, limit), 50),
        offset: Math.max(0, offset),
      },
    };
  }
}

module.exports = new AdminCustomerService();
