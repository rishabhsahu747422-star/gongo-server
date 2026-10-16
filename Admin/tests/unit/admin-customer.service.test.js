'use strict';

const adminCustomerService = require('../../src/services/admin-customer.service');
const adminCustomerRepository = require('../../src/repositories/admin-customer.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const auditService = require('../../src/services/audit.service');
const { ValidationError, NotFoundError } = require('../../src/errors');

describe('Unit: AdminCustomerService', () => {
  const CUSTOMER_ID = 'c1111111-1111-4111-a111-111111111111';

  const mockCustomerRecord = {
    id: CUSTOMER_ID,
    name: 'Aarav Patel',
    email: 'aarav@customer.in',
    phone: '9876543210',
    countryCode: '+91',
    avatarStorageKey: 'avatars/c111.png',
    isActive: true,
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    updatedAt: new Date('2026-09-01T10:00:00.000Z'),
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(adminCustomerRepository, 'withTransaction').mockImplementation(async (cb) => cb({}));
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
  });

  describe('listCustomers', () => {
    it('returns customers list and pagination metadata', async () => {
      jest.spyOn(adminCustomerRepository, 'listCustomers').mockResolvedValue({
        customers: [{ ...mockCustomerRecord, bookingCount: 2, totalSpend: 5000 }],
        total: 1,
      });

      const res = await adminCustomerService.listCustomers({ limit: '10', offset: '0' });

      expect(res.customers).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
      expect(res.pagination.limit).toBe(10);
      expect(res.pagination.offset).toBe(0);
      expect(res.pagination.pages).toBe(1);
    });

    it('rejects invalid isActive filter with ValidationError', async () => {
      await expect(
        adminCustomerService.listCustomers({ isActive: 'not-bool' }),
      ).rejects.toThrow(ValidationError);
    });

    it('validates date ranges and rejects start >= end', async () => {
      await expect(
        adminCustomerService.listCustomers({
          startDate: '2026-09-20',
          endDate: '2026-09-10',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects date range exceeding 366 days', async () => {
      await expect(
        adminCustomerService.listCustomers({
          startDate: '2023-01-01',
          endDate: '2026-01-01',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects negative or invalid pagination values', async () => {
      await expect(
        adminCustomerService.listCustomers({ limit: '-5' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        adminCustomerService.listCustomers({ offset: '-1' }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('getCustomerDetail', () => {
    it('returns customer detail with all operational summaries', async () => {
      jest.spyOn(adminCustomerRepository, 'findCustomerById').mockResolvedValue(mockCustomerRecord);
      jest.spyOn(adminCustomerRepository, 'getCustomerSummaries').mockResolvedValue({
        bookingSummary: { total: 5, upcoming: 1, active: 1, completed: 3, cancelled: 0 },
        paymentSummary: {
          totalPayments: 5,
          successfulPayments: 5,
          pendingPayments: 0,
          failedPayments: 0,
          totalSpent: 12000,
        },
        documentSummary: {
          totalDocuments: 1,
          verifiedDocuments: 1,
          pendingDocuments: 0,
          rejectedDocuments: 0,
        },
        addressCount: 2,
      });

      const res = await adminCustomerService.getCustomerDetail(CUSTOMER_ID);

      expect(res.customer.id).toBe(CUSTOMER_ID);
      expect(res.customer.name).toBe('Aarav Patel');
      expect(res.bookingSummary.total).toBe(5);
      expect(res.paymentSummary.totalSpent).toBe(12000);
      expect(res.documentSummary.verifiedDocuments).toBe(1);
      expect(res.addressCount).toBe(2);
    });

    it('throws NotFoundError when customer does not exist', async () => {
      jest.spyOn(adminCustomerRepository, 'findCustomerById').mockResolvedValue(null);

      await expect(
        adminCustomerService.getCustomerDetail(CUSTOMER_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid UUID format', async () => {
      await expect(
        adminCustomerService.getCustomerDetail('invalid-uuid'),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('updateCustomerStatus', () => {
    it('updates customer status and writes audit log', async () => {
      jest.spyOn(adminCustomerRepository, 'findCustomerById').mockResolvedValue(mockCustomerRecord);
      jest.spyOn(adminCustomerRepository, 'getActiveBookingCount').mockResolvedValue(0);
      jest.spyOn(adminCustomerRepository, 'updateCustomerStatus').mockResolvedValue({
        ...mockCustomerRecord,
        isActive: false,
      });

      const auditCtx = {
        actorId: 'admin-1',
        actorRole: 'ADMIN',
        permission: 'customers.update',
        requestId: 'req-123',
      };

      const res = await adminCustomerService.updateCustomerStatus(
        CUSTOMER_ID,
        { isActive: false, reason: 'Temporary suspension' },
        auditCtx,
      );

      expect(res.isActive).toBe(false);
      expect(adminCustomerRepository.withTransaction).toHaveBeenCalled();
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          action: 'CUSTOMER_SUSPEND',
          targetResource: 'CUSTOMER',
          targetResourceId: CUSTOMER_ID,
          beforeState: { isActive: true },
          afterState: { isActive: false },
        }),
        expect.anything(),
      );
      expect(auditService.logAdminAction).toHaveBeenCalled();
    });

    it('blocks deactivating customer with active bookings when force is false', async () => {
      jest.spyOn(adminCustomerRepository, 'findCustomerById').mockResolvedValue(mockCustomerRecord);
      jest.spyOn(adminCustomerRepository, 'getActiveBookingCount').mockResolvedValue(2);

      await expect(
        adminCustomerService.updateCustomerStatus(
          CUSTOMER_ID,
          { isActive: false },
          {},
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('allows deactivating customer with active bookings when force is true', async () => {
      jest.spyOn(adminCustomerRepository, 'findCustomerById').mockResolvedValue(mockCustomerRecord);
      jest.spyOn(adminCustomerRepository, 'getActiveBookingCount').mockResolvedValue(2);
      jest.spyOn(adminCustomerRepository, 'updateCustomerStatus').mockResolvedValue({
        ...mockCustomerRecord,
        isActive: false,
      });

      const res = await adminCustomerService.updateCustomerStatus(
        CUSTOMER_ID,
        { isActive: false, force: true },
        {},
      );

      expect(res.isActive).toBe(false);
    });

    it('rejects forbidden fields to prevent mass assignment', async () => {
      await expect(
        adminCustomerService.updateCustomerStatus(
          CUSTOMER_ID,
          { isActive: false, role: 'ADMIN' },
          {},
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError if customer does not exist', async () => {
      jest.spyOn(adminCustomerRepository, 'findCustomerById').mockResolvedValue(null);

      await expect(
        adminCustomerService.updateCustomerStatus(
          CUSTOMER_ID,
          { isActive: false },
          {},
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('subresource endpoints', () => {
    beforeEach(() => {
      jest.spyOn(adminCustomerRepository, 'findCustomerById').mockResolvedValue(mockCustomerRecord);
    });

    it('getCustomerBookings returns paginated bookings', async () => {
      jest.spyOn(adminCustomerRepository, 'getCustomerBookings').mockResolvedValue({
        bookings: [{ id: 'bk-1', bookingNumber: 'BK-1' }],
        total: 1,
      });

      const res = await adminCustomerService.getCustomerBookings(CUSTOMER_ID, { limit: 10 });
      expect(res.bookings).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
    });

    it('getCustomerPayments returns paginated payments', async () => {
      jest.spyOn(adminCustomerRepository, 'getCustomerPayments').mockResolvedValue({
        payments: [{ id: 'pay-1', amount: 1000 }],
        total: 1,
      });

      const res = await adminCustomerService.getCustomerPayments(CUSTOMER_ID, { limit: 10 });
      expect(res.payments).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
    });

    it('getCustomerDocuments returns documents', async () => {
      jest.spyOn(adminCustomerRepository, 'getCustomerDocuments').mockResolvedValue([
        { id: 'doc-1', documentType: 'DRIVING_LICENSE' },
      ]);

      const res = await adminCustomerService.getCustomerDocuments(CUSTOMER_ID);
      expect(res.documents).toHaveLength(1);
    });

    it('getCustomerAddresses returns addresses', async () => {
      jest.spyOn(adminCustomerRepository, 'getCustomerAddresses').mockResolvedValue([
        { id: 'addr-1', label: 'Home' },
      ]);

      const res = await adminCustomerService.getCustomerAddresses(CUSTOMER_ID);
      expect(res.addresses).toHaveLength(1);
    });

    it('getCustomerActivity returns activity trail', async () => {
      jest.spyOn(adminCustomerRepository, 'getCustomerActivity').mockResolvedValue({
        activity: [{ id: 'act-1', action: 'CUSTOMER_SUSPEND' }],
        total: 1,
      });

      const res = await adminCustomerService.getCustomerActivity(CUSTOMER_ID, { limit: 10 });
      expect(res.activity).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
    });

    it('throws NotFoundError for non-existent customer on subresources', async () => {
      jest.spyOn(adminCustomerRepository, 'findCustomerById').mockResolvedValue(null);

      await expect(
        adminCustomerService.getCustomerBookings(CUSTOMER_ID),
      ).rejects.toThrow(NotFoundError);

      await expect(
        adminCustomerService.getCustomerPayments(CUSTOMER_ID),
      ).rejects.toThrow(NotFoundError);

      await expect(
        adminCustomerService.getCustomerDocuments(CUSTOMER_ID),
      ).rejects.toThrow(NotFoundError);

      await expect(
        adminCustomerService.getCustomerAddresses(CUSTOMER_ID),
      ).rejects.toThrow(NotFoundError);

      await expect(
        adminCustomerService.getCustomerActivity(CUSTOMER_ID),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
