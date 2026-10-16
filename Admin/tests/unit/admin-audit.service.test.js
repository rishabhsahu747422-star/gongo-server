'use strict';

const { AdminAuditService } = require('../../src/services/admin-audit.service');
const { BadRequestError, NotFoundError } = require('../../src/errors');

const TEST_ADMIN_ID = 'a0000001-0000-4000-a000-000000000001';
const TEST_AUDIT_ID = 'da000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'c0000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'b0000001-0000-4000-a000-000000000001';

describe('Unit: AdminAuditService', () => {
  let service;
  let mockActionRepo;
  let mockUserRepo;

  beforeEach(() => {
    mockActionRepo = {
      listAuditActions: jest.fn(),
      findActionById: jest.fn(),
      findActionsByActor: jest.fn(),
      findActionsByResource: jest.fn(),
      findSecurityEvents: jest.fn(),
      getSecuritySummary: jest.fn(),
      getDistinctActionsAndResources: jest.fn(),
    };

    mockUserRepo = {
      findById: jest.fn(),
    };

    service = new AdminAuditService(mockActionRepo, mockUserRepo);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. listAudit', () => {
    it('successfully lists audit actions with valid parameters', async () => {
      mockActionRepo.listAuditActions.mockResolvedValueOnce({
        items: [{ id: TEST_AUDIT_ID }],
        pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });

      const result = await service.listAudit({
        page: 1,
        limit: 20,
        actorId: TEST_ADMIN_ID,
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-10T23:59:59.999Z',
      });

      expect(mockActionRepo.listAuditActions).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: TEST_ADMIN_ID,
          startDate: '2026-09-01T00:00:00.000Z',
          endDate: '2026-09-10T23:59:59.999Z',
        }),
      );
      expect(result.items).toHaveLength(1);
    });

    it('rejects malformed actorId UUID', async () => {
      await expect(
        service.listAudit({ actorId: 'not-a-valid-uuid' }),
      ).rejects.toThrow(BadRequestError);
      expect(mockActionRepo.listAuditActions).not.toHaveBeenCalled();
    });

    it('rejects invalid date range where start date is after end date', async () => {
      await expect(
        service.listAudit({
          startDate: '2026-09-15T00:00:00.000Z',
          endDate: '2026-09-10T00:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestError);
      expect(mockActionRepo.listAuditActions).not.toHaveBeenCalled();
    });

    it('rejects date range query window exceeding 90 days', async () => {
      await expect(
        service.listAudit({
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-06-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestError);
      expect(mockActionRepo.listAuditActions).not.toHaveBeenCalled();
    });

    it('rejects malformed date strings', async () => {
      await expect(
        service.listAudit({
          startDate: 'not-a-date',
        }),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('2. getAuditDetail', () => {
    it('returns audit detail for valid existing ID', async () => {
      const mockRecord = {
        id: TEST_AUDIT_ID,
        action: 'ADMIN_LOGIN',
        actor: { id: TEST_ADMIN_ID, name: 'Admin' },
      };
      mockActionRepo.findActionById.mockResolvedValueOnce(mockRecord);

      const record = await service.getAuditDetail(TEST_AUDIT_ID);
      expect(record).toEqual(mockRecord);
      expect(mockActionRepo.findActionById).toHaveBeenCalledWith(TEST_AUDIT_ID);
    });

    it('throws BadRequestError for malformed audit ID UUID', async () => {
      await expect(service.getAuditDetail('invalid-uuid-format')).rejects.toThrow(
        BadRequestError,
      );
      expect(mockActionRepo.findActionById).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when audit record does not exist', async () => {
      mockActionRepo.findActionById.mockResolvedValueOnce(null);

      await expect(service.getAuditDetail(TEST_AUDIT_ID)).rejects.toThrow(NotFoundError);
    });
  });

  describe('3. getDistinctActions', () => {
    it('delegates catalog query to repository', async () => {
      const catalog = {
        actions: ['ADMIN_LOGIN'],
        resources: ['ADMIN_SESSION'],
        categories: ['AUTHENTICATION'],
      };
      mockActionRepo.getDistinctActionsAndResources.mockResolvedValueOnce(catalog);

      const res = await service.getDistinctActions();
      expect(res).toEqual(catalog);
      expect(mockActionRepo.getDistinctActionsAndResources).toHaveBeenCalledTimes(1);
    });
  });

  describe('4. getSecurityEvents', () => {
    it('fetches security events with valid category', async () => {
      mockActionRepo.findSecurityEvents.mockResolvedValueOnce({
        items: [],
        pagination: { total: 0, page: 1, limit: 20, totalPages: 0 },
      });

      await service.getSecurityEvents({ category: 'AUTHENTICATION', page: 1 });

      expect(mockActionRepo.findSecurityEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'AUTHENTICATION',
          page: 1,
        }),
      );
    });

    it('throws BadRequestError for unrecognized security category', async () => {
      await expect(
        service.getSecurityEvents({ category: 'INVALID_CATEGORY_XYZ' }),
      ).rejects.toThrow(BadRequestError);
      expect(mockActionRepo.findSecurityEvents).not.toHaveBeenCalled();
    });

    it('validates date range for security events', async () => {
      await expect(
        service.getSecurityEvents({
          startDate: '2026-09-20T00:00:00Z',
          endDate: '2026-09-10T00:00:00Z',
        }),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('5. getAuditByAdmin', () => {
    it('validates actor UUID and confirms user exists with ADMIN role', async () => {
      mockUserRepo.findById.mockResolvedValueOnce({
        id: TEST_ADMIN_ID,
        role: 'ADMIN',
        name: 'Active Admin',
      });
      mockActionRepo.findActionsByActor.mockResolvedValueOnce({
        items: [],
        pagination: { total: 0, page: 1, limit: 20, totalPages: 0 },
      });

      const result = await service.getAuditByAdmin(TEST_ADMIN_ID, { page: 1, limit: 10 });

      expect(mockUserRepo.findById).toHaveBeenCalledWith(TEST_ADMIN_ID);
      expect(mockActionRepo.findActionsByActor).toHaveBeenCalledWith(
        TEST_ADMIN_ID,
        expect.objectContaining({
          page: 1,
          limit: 10,
        }),
      );
      expect(result).toBeDefined();
    });

    it('throws BadRequestError for malformed adminId UUID', async () => {
      await expect(
        service.getAuditByAdmin('not-a-uuid', {}),
      ).rejects.toThrow(BadRequestError);
      expect(mockUserRepo.findById).not.toHaveBeenCalled();
    });

    it('throws NotFoundError if target user does not exist', async () => {
      mockUserRepo.findById.mockResolvedValueOnce(null);

      await expect(
        service.getAuditByAdmin(TEST_ADMIN_ID, {}),
      ).rejects.toThrow(NotFoundError);
      expect(mockActionRepo.findActionsByActor).not.toHaveBeenCalled();
    });

    it('throws BadRequestError if target user exists but is not an ADMIN role', async () => {
      mockUserRepo.findById.mockResolvedValueOnce({
        id: TEST_CUSTOMER_ID,
        role: 'CUSTOMER',
        name: 'Customer User',
      });

      await expect(
        service.getAuditByAdmin(TEST_CUSTOMER_ID, {}),
      ).rejects.toThrow(BadRequestError);
      expect(mockActionRepo.findActionsByActor).not.toHaveBeenCalled();
    });
  });

  describe('6. getAuditByResource', () => {
    it('validates resourceType and resourceId and returns history', async () => {
      mockActionRepo.findActionsByResource.mockResolvedValueOnce({
        items: [],
        pagination: { total: 0, page: 1, limit: 20, totalPages: 0 },
      });

      await service.getAuditByResource('booking', TEST_BOOKING_ID, { page: 1 });

      expect(mockActionRepo.findActionsByResource).toHaveBeenCalledWith(
        'BOOKING',
        TEST_BOOKING_ID,
        expect.objectContaining({ page: 1 }),
      );
    });

    it('throws BadRequestError if resourceType is missing or invalid', async () => {
      await expect(
        service.getAuditByResource('', TEST_BOOKING_ID),
      ).rejects.toThrow(BadRequestError);
    });

    it('throws BadRequestError if resourceId is missing', async () => {
      await expect(
        service.getAuditByResource('BOOKING', ''),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('7. getSecuritySummary', () => {
    it('validates date range and calls getSecuritySummary on repository', async () => {
      mockActionRepo.getSecuritySummary.mockResolvedValueOnce({
        totalEvents: 10,
        securityEventsCount: 5,
        categoryBreakdown: {},
        topActors: [],
      });

      const summary = await service.getSecuritySummary({
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-02T00:00:00.000Z',
      });

      expect(mockActionRepo.getSecuritySummary).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: '2026-09-01T00:00:00.000Z',
          endDate: '2026-09-02T00:00:00.000Z',
        }),
      );
      expect(summary.totalEvents).toBe(10);
    });

    it('rejects query window exceeding 90 days for summary', async () => {
      await expect(
        service.getSecuritySummary({
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-06-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestError);
      expect(mockActionRepo.getSecuritySummary).not.toHaveBeenCalled();
    });
  });
});
