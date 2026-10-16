'use strict';

const adminVehicleService = require('../../src/services/admin-vehicle.service');
const adminVehicleRepository = require('../../src/repositories/admin-vehicle.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const auditService = require('../../src/services/audit.service');
const { ValidationError, NotFoundError } = require('../../src/errors');

describe('Unit: AdminVehicleService', () => {
  const TEST_VEHICLE_ID = 'e1111111-1111-4111-a111-111111111111';
  const TEST_PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';

  const mockVehicleRecord = {
    id: TEST_VEHICLE_ID,
    partnerId: TEST_PARTNER_ID,
    shopId: null,
    category: 'CAR',
    brand: 'Hyundai',
    model: 'i20',
    variant: 'Asta',
    registrationNumber: 'KA-01-AB-1234',
    year: 2023,
    fuelType: 'Petrol',
    transmission: 'Manual',
    seats: 5,
    description: 'Well-maintained hatchback',
    manualStatus: 'ONLINE',
    rentalStatus: 'IDLE',
    verificationStatus: 'PENDING',
    isArchived: false,
    offlineReason: null,
    partner: {
      id: TEST_PARTNER_ID,
      businessName: 'Fast Wheels Mobility',
      city: 'Bengaluru',
      ownerName: 'Suresh Patel',
      ownerEmail: 'suresh@fastwheels.in',
      ownerPhone: '9123456780',
    },
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    updatedAt: new Date('2026-09-01T10:00:00.000Z'),
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(adminVehicleRepository, 'withTransaction').mockImplementation(async (cb) => cb({}));
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
  });

  describe('listVehicles', () => {
    it('returns vehicles list and pagination metadata', async () => {
      jest.spyOn(adminVehicleRepository, 'listVehicles').mockResolvedValue({
        vehicles: [{ ...mockVehicleRecord, pricePerDay: 2500, bookingCount: 5 }],
        total: 1,
      });

      const res = await adminVehicleService.listVehicles({ limit: '10', offset: '0' });

      expect(res.vehicles).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
      expect(res.pagination.limit).toBe(10);
      expect(res.pagination.offset).toBe(0);
      expect(res.pagination.pages).toBe(1);
    });

    it('rejects invalid category with ValidationError', async () => {
      await expect(
        adminVehicleService.listVehicles({ category: 'PLANE' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects invalid manualStatus with ValidationError', async () => {
      await expect(
        adminVehicleService.listVehicles({ manualStatus: 'INVALID' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects invalid rentalStatus with ValidationError', async () => {
      await expect(
        adminVehicleService.listVehicles({ rentalStatus: 'INVALID' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects invalid verificationStatus with ValidationError', async () => {
      await expect(
        adminVehicleService.listVehicles({ verificationStatus: 'INVALID' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects invalid isArchived filter with ValidationError', async () => {
      await expect(
        adminVehicleService.listVehicles({ isArchived: 'not-bool' }),
      ).rejects.toThrow(ValidationError);
    });

    it('validates date ranges and rejects start >= end', async () => {
      await expect(
        adminVehicleService.listVehicles({
          startDate: '2026-09-20',
          endDate: '2026-09-10',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects date range exceeding 366 days', async () => {
      await expect(
        adminVehicleService.listVehicles({
          startDate: '2023-01-01',
          endDate: '2026-01-01',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects negative or invalid pagination values', async () => {
      await expect(
        adminVehicleService.listVehicles({ limit: '-5' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        adminVehicleService.listVehicles({ offset: '-1' }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('getVehicleDetail', () => {
    it('returns vehicle detail with all operational summaries', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(mockVehicleRecord);
      jest.spyOn(adminVehicleRepository, 'getVehicleSummaries').mockResolvedValue({
        bookingSummary: { total: 20, upcoming: 2, active: 1, completed: 15, cancelled: 2 },
        documentsSummary: { total: 4, verified: 4, pending: 0, rejected: 0 },
        imagesCount: 6,
        pricing: { pricePerHour: 150, pricePerDay: 2500, currency: 'INR' },
        availability: { activeBlocksCount: 1 },
      });

      const res = await adminVehicleService.getVehicleDetail(TEST_VEHICLE_ID);

      expect(res.vehicle.id).toBe(TEST_VEHICLE_ID);
      expect(res.vehicle.brand).toBe('Hyundai');
      expect(res.bookingSummary.total).toBe(20);
      expect(res.documentsSummary.verified).toBe(4);
      expect(res.imagesCount).toBe(6);
      expect(res.pricing.pricePerDay).toBe(2500);
    });

    it('resolves presigned image and document URLs and selects canonical cover image', async () => {
      const s3Provider = require('../../src/providers/s3');
      jest.spyOn(s3Provider, 'createPresignedGetUrl').mockImplementation(async ({ key }) => ({
        downloadUrl: `https://signed.cdn.gongo.io/${key}`,
        key,
      }));

      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue({
        ...mockVehicleRecord,
        coverImageUrl: 'partners/p-1/vehicles/v-1/cover.jpg',
      });
      jest.spyOn(adminVehicleRepository, 'getVehicleSummaries').mockResolvedValue({
        bookingSummary: { total: 5, upcoming: 1, active: 1, completed: 3, cancelled: 0, revenue: 4500 },
        documentsSummary: { total: 1, verified: 1, pending: 0, rejected: 0 },
        imagesCount: 2,
        pricing: { pricePerHour: 100, pricePerDay: 1500 },
      });
      jest.spyOn(adminVehicleRepository, 'getVehicleImages').mockResolvedValue([
        { id: 'img-1', storageKey: 'partners/p-1/vehicles/v-1/img1.jpg', isCover: false, sortOrder: 1 },
        { id: 'img-2', storageKey: 'partners/p-1/vehicles/v-1/img2.jpg', isCover: true, sortOrder: 0 },
      ]);
      jest.spyOn(adminVehicleRepository, 'getVehicleDocuments').mockResolvedValue([
        { id: 'doc-1', documentType: 'RC', storageKey: 'partners/p-1/vehicles/v-1/rc.pdf', verificationStatus: 'VERIFIED' },
      ]);

      const res = await adminVehicleService.getVehicleDetail(TEST_VEHICLE_ID);

      expect(res.images).toHaveLength(2);
      expect(res.images[0].imageUrl).toContain('https://signed.cdn.gongo.io/');
      expect(res.images[1].imageUrl).toContain('https://signed.cdn.gongo.io/');
      // Cover image should be img-2 since it has isCover = true
      expect(res.vehicle.coverImageUrl).toBe('https://signed.cdn.gongo.io/partners/p-1/vehicles/v-1/img2.jpg');
      expect(res.documents).toHaveLength(1);
      expect(res.documents[0].downloadUrl).toContain('https://signed.cdn.gongo.io/partners/p-1/vehicles/v-1/rc.pdf');
      expect(res.bookingStats.total).toBe(5);
    });

    it('throws NotFoundError when vehicle does not exist', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(null);

      await expect(
        adminVehicleService.getVehicleDetail(TEST_VEHICLE_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid UUID format', async () => {
      await expect(
        adminVehicleService.getVehicleDetail('not-a-uuid'),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('updateVehicleStatus', () => {
    it('updates vehicle status and writes audit log', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(mockVehicleRecord);
      jest.spyOn(adminVehicleRepository, 'getActiveBookingCount').mockResolvedValue(0);
      jest.spyOn(adminVehicleRepository, 'updateVehicleStatus').mockResolvedValue({
        ...mockVehicleRecord,
        manualStatus: 'OFFLINE',
        offlineReason: 'Maintenance',
      });

      const auditCtx = {
        actorId: 'admin-1',
        actorRole: 'ADMIN',
        permission: 'vehicles.update',
        requestId: 'req-123',
      };

      const res = await adminVehicleService.updateVehicleStatus(
        TEST_VEHICLE_ID,
        { manualStatus: 'OFFLINE', offlineReason: 'Maintenance' },
        auditCtx,
      );

      expect(res.manualStatus).toBe('OFFLINE');
      expect(adminVehicleRepository.withTransaction).toHaveBeenCalled();
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          action: 'VEHICLE_STATUS_CHANGE',
          targetResource: 'VEHICLE',
          targetResourceId: TEST_VEHICLE_ID,
        }),
        expect.anything(),
      );
      expect(auditService.logAdminAction).toHaveBeenCalled();
    });

    it('blocks offlining vehicle with active bookings when force is false', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(mockVehicleRecord);
      jest.spyOn(adminVehicleRepository, 'getActiveBookingCount').mockResolvedValue(3);

      await expect(
        adminVehicleService.updateVehicleStatus(
          TEST_VEHICLE_ID,
          { manualStatus: 'OFFLINE' },
          {},
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('allows offlining vehicle with active bookings when force is true', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(mockVehicleRecord);
      jest.spyOn(adminVehicleRepository, 'getActiveBookingCount').mockResolvedValue(3);
      jest.spyOn(adminVehicleRepository, 'updateVehicleStatus').mockResolvedValue({
        ...mockVehicleRecord,
        manualStatus: 'OFFLINE',
      });

      const res = await adminVehicleService.updateVehicleStatus(
        TEST_VEHICLE_ID,
        { manualStatus: 'OFFLINE', force: true },
        {},
      );

      expect(res.manualStatus).toBe('OFFLINE');
    });

    it('archives vehicle with VEHICLE_ARCHIVE audit action', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(mockVehicleRecord);
      jest.spyOn(adminVehicleRepository, 'getActiveBookingCount').mockResolvedValue(0);
      jest.spyOn(adminVehicleRepository, 'updateVehicleStatus').mockResolvedValue({
        ...mockVehicleRecord,
        isArchived: true,
      });

      const res = await adminVehicleService.updateVehicleStatus(
        TEST_VEHICLE_ID,
        { isArchived: true, reason: 'Sold off' },
        {},
      );

      expect(res.isArchived).toBe(true);
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'VEHICLE_ARCHIVE' }),
        expect.anything(),
      );
    });

    it('rejects forbidden fields to prevent mass assignment', async () => {
      await expect(
        adminVehicleService.updateVehicleStatus(
          TEST_VEHICLE_ID,
          { manualStatus: 'OFFLINE', partnerId: 'fake' },
          {},
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError if vehicle does not exist', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(null);

      await expect(
        adminVehicleService.updateVehicleStatus(
          TEST_VEHICLE_ID,
          { manualStatus: 'OFFLINE' },
          {},
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateVehicleStatus lifecycle invariants (generic status cannot bypass holds)', () => {
    const verifiedActive = {
      ...mockVehicleRecord,
      manualStatus: 'OFFLINE',
      verificationStatus: 'VERIFIED',
      isActive: true,
      isArchived: false,
    };

    const lockAs = (overrides) => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue({ ...verifiedActive });
      jest.spyOn(adminVehicleRepository, 'findVehicleByIdForUpdate')
        .mockResolvedValue({ ...verifiedActive, ...overrides });
      jest.spyOn(adminVehicleRepository, 'getActiveBookingCount').mockResolvedValue(0);
      jest.spyOn(adminVehicleRepository, 'updateVehicleStatus')
        .mockImplementation(async (id, updates) => ({ ...verifiedActive, ...overrides, ...updates }));
    };

    it.each([
      ['blocked (is_active=false)', { isActive: false, isArchived: false }],
      ['archived/deactivated', { isActive: false, isArchived: true }],
      ['PENDING', { verificationStatus: 'PENDING' }],
      ['UNDER_REVIEW', { verificationStatus: 'UNDER_REVIEW' }],
      ['unverified (null)', { verificationStatus: null }],
      ['REJECTED', { verificationStatus: 'REJECTED' }],
      ['rejected (lowercase)', { verificationStatus: 'rejected' }],
    ])('refuses ONLINE with 409 for a %s vehicle and writes nothing', async (_label, overrides) => {
      lockAs(overrides);
      await expect(
        adminVehicleService.updateVehicleStatus(TEST_VEHICLE_ID, { manualStatus: 'ONLINE' }, {}),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(adminVehicleRepository.updateVehicleStatus).not.toHaveBeenCalled();
      expect(adminActionRepository.createAction).not.toHaveBeenCalled();
    });

    it('also refuses ONLINE via the snake_case manual_status key', async () => {
      lockAs({ isActive: false });
      await expect(
        adminVehicleService.updateVehicleStatus(TEST_VEHICLE_ID, { manual_status: 'online' }, {}),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(adminVehicleRepository.updateVehicleStatus).not.toHaveBeenCalled();
    });

    it('evaluates the row-locked state, not the stale pre-read (concurrent block between read and lock)', async () => {
      lockAs({ isActive: false });
      // pre-read (findVehicleById) still says active + verified
      await expect(
        adminVehicleService.updateVehicleStatus(TEST_VEHICLE_ID, { manualStatus: 'ONLINE' }, {}),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(adminVehicleRepository.findVehicleByIdForUpdate).toHaveBeenCalled();
      expect(adminVehicleRepository.updateVehicleStatus).not.toHaveBeenCalled();
    });

    it('refuses isArchived=false on a blocked vehicle (would otherwise clear is_active)', async () => {
      lockAs({ isActive: false, isArchived: false });
      await expect(
        adminVehicleService.updateVehicleStatus(TEST_VEHICLE_ID, { isArchived: false }, {}),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(adminVehicleRepository.updateVehicleStatus).not.toHaveBeenCalled();
    });

    it('refuses un-archiving (and un-archive + ONLINE in one request) on a deactivated vehicle', async () => {
      lockAs({ isActive: false, isArchived: true });
      await expect(
        adminVehicleService.updateVehicleStatus(TEST_VEHICLE_ID, { is_archived: 'false' }, {}),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        adminVehicleService.updateVehicleStatus(
          TEST_VEHICLE_ID,
          { isArchived: false, manualStatus: 'ONLINE' },
          {},
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(adminVehicleRepository.updateVehicleStatus).not.toHaveBeenCalled();
    });

    it('refuses archiving and ONLINE in the same request', async () => {
      lockAs({});
      await expect(
        adminVehicleService.updateVehicleStatus(
          TEST_VEHICLE_ID,
          { isArchived: true, manualStatus: 'ONLINE' },
          {},
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it.each(['VERIFIED', 'APPROVED', 'approved'])(
      'allows ONLINE for an active, non-archived %s vehicle',
      async (verificationStatus) => {
        lockAs({ verificationStatus });
        const res = await adminVehicleService.updateVehicleStatus(
          TEST_VEHICLE_ID,
          { manualStatus: 'ONLINE' },
          {},
        );
        expect(res.manualStatus).toBe('ONLINE');
        expect(adminVehicleRepository.updateVehicleStatus).toHaveBeenCalledWith(
          TEST_VEHICLE_ID,
          { manualStatus: 'ONLINE' },
          expect.anything(),
        );
      },
    );

    it('still allows taking a blocked/archived/rejected vehicle OFFLINE', async () => {
      lockAs({ isActive: false, isArchived: true, verificationStatus: 'REJECTED', manualStatus: 'ONLINE' });
      const res = await adminVehicleService.updateVehicleStatus(
        TEST_VEHICLE_ID,
        { manualStatus: 'OFFLINE', offlineReason: 'Ops' },
        {},
      );
      expect(res.manualStatus).toBe('OFFLINE');
    });

    it('writes the generic status reason only to offlineReason (never rejection_reason)', async () => {
      lockAs({ manualStatus: 'ONLINE' });
      await adminVehicleService.updateVehicleStatus(
        TEST_VEHICLE_ID,
        { manualStatus: 'OFFLINE', offlineReason: 'Service', reason: 'audit note' },
        {},
      );
      const updates = adminVehicleRepository.updateVehicleStatus.mock.calls[0][1];
      expect(updates).toEqual({ manualStatus: 'OFFLINE', offlineReason: 'Service' });
      expect(updates).not.toHaveProperty('rejectionReason');
    });
  });

  describe('approveVehicle & rejectVehicle', () => {
    it('approves vehicle and logs VEHICLE_APPROVED audit action', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(mockVehicleRecord);
      jest.spyOn(adminVehicleRepository, 'updateVehicleVerification').mockResolvedValue({
        ...mockVehicleRecord,
        verificationStatus: 'VERIFIED',
      });

      const res = await adminVehicleService.approveVehicle(
        TEST_VEHICLE_ID,
        { reason: 'Verified papers' },
        { actorId: 'admin-1' },
      );

      expect(res.verificationStatus).toBe('VERIFIED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'VEHICLE_APPROVED' }),
        expect.anything(),
      );
    });

    it('blocks approving an archived vehicle', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue({
        ...mockVehicleRecord,
        isArchived: true,
      });

      await expect(
        adminVehicleService.approveVehicle(TEST_VEHICLE_ID, {}, {}),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects vehicle with required reason and logs VEHICLE_REJECTED action', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(mockVehicleRecord);
      jest.spyOn(adminVehicleRepository, 'updateVehicleVerification').mockResolvedValue({
        ...mockVehicleRecord,
        verificationStatus: 'REJECTED',
      });

      const res = await adminVehicleService.rejectVehicle(
        TEST_VEHICLE_ID,
        { reason: 'Insurance expired' },
        { actorId: 'admin-1' },
      );

      expect(res.verificationStatus).toBe('REJECTED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'VEHICLE_REJECTED' }),
        expect.anything(),
      );
    });

    it('rejects vehicle rejection without reason', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(mockVehicleRecord);

      await expect(
        adminVehicleService.rejectVehicle(TEST_VEHICLE_ID, {}, {}),
      ).rejects.toThrow(ValidationError);
    });

    it('updateVehicleVerification routes to approveVehicle when status is VERIFIED', async () => {
      const approveSpy = jest.spyOn(adminVehicleService, 'approveVehicle').mockResolvedValue({
        ...mockVehicleRecord,
        verificationStatus: 'VERIFIED',
      });

      const res = await adminVehicleService.updateVehicleVerification(
        TEST_VEHICLE_ID,
        { status: 'VERIFIED', reason: 'Checked' },
        {},
      );

      expect(res.verificationStatus).toBe('VERIFIED');
      expect(approveSpy).toHaveBeenCalledWith(
        TEST_VEHICLE_ID,
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('subresource endpoints', () => {
    beforeEach(() => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(mockVehicleRecord);
    });

    it('getVehicleDocuments returns documents', async () => {
      jest.spyOn(adminVehicleRepository, 'getVehicleDocuments').mockResolvedValue([
        { id: 'doc-1', documentType: 'RC' },
      ]);

      const res = await adminVehicleService.getVehicleDocuments(TEST_VEHICLE_ID);
      expect(res.documents).toHaveLength(1);
    });

    it('getVehicleDocumentDetail returns specific document with presigned URL and MIME type', async () => {
      const docId = 'd0000001-0000-4000-a000-000000000001';
      jest.spyOn(adminVehicleRepository, 'findVehicleDocumentById').mockResolvedValue({
        id: docId,
        vehicleId: TEST_VEHICLE_ID,
        documentType: 'RC',
        storageKey: 'partners/p-1/vehicles/v-1/documents/rc/test.pdf',
        verificationStatus: 'VERIFIED',
      });

      const res = await adminVehicleService.getVehicleDocumentDetail(TEST_VEHICLE_ID, docId);
      expect(res.document.id).toBe(docId);
      expect(res.document.mimeType).toBe('application/pdf');
      expect(res.document.fileType).toBe('pdf');
      expect(res.document.documentUrl).toContain('test.pdf');
    });

    it('getVehicleDocumentDetail throws NotFoundError if document does not belong to vehicle', async () => {
      const docId = 'd0000001-0000-4000-a000-000000000001';
      jest.spyOn(adminVehicleRepository, 'findVehicleDocumentById').mockResolvedValue(null);

      await expect(
        adminVehicleService.getVehicleDocumentDetail(TEST_VEHICLE_ID, docId)
      ).rejects.toThrow(NotFoundError);
    });

    it('getVehicleImages returns images', async () => {
      jest.spyOn(adminVehicleRepository, 'getVehicleImages').mockResolvedValue([
        { id: 'img-1', imageUrl: 'https://cdn.gongo.in/1.jpg' },
      ]);

      const res = await adminVehicleService.getVehicleImages(TEST_VEHICLE_ID);
      expect(res.images).toHaveLength(1);
    });

    it('getVehicleBookings returns paginated bookings', async () => {
      jest.spyOn(adminVehicleRepository, 'getVehicleBookings').mockResolvedValue({
        bookings: [{ id: 'bk-1', bookingNumber: 'BK-1001' }],
        total: 1,
      });

      const res = await adminVehicleService.getVehicleBookings(TEST_VEHICLE_ID, { limit: 10 });
      expect(res.bookings).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
    });

    it('getVehicleAvailability returns availability blocks', async () => {
      jest.spyOn(adminVehicleRepository, 'getVehicleAvailability').mockResolvedValue([
        { id: 'avail-1', reason: 'Maintenance' },
      ]);

      const res = await adminVehicleService.getVehicleAvailability(TEST_VEHICLE_ID);
      expect(res.vehicleId).toBe(TEST_VEHICLE_ID);
      expect(res.availabilityBlocks).toHaveLength(1);
    });

    it('getVehiclePricing returns pricing', async () => {
      jest.spyOn(adminVehicleRepository, 'getVehiclePricing').mockResolvedValue({
        pricePerHour: 150,
        pricePerDay: 2500,
      });

      const res = await adminVehicleService.getVehiclePricing(TEST_VEHICLE_ID);
      expect(res.vehicleId).toBe(TEST_VEHICLE_ID);
      expect(res.pricing.pricePerDay).toBe(2500);
    });

    it('getVehicleEarnings returns earnings', async () => {
      jest.spyOn(adminVehicleRepository, 'getVehicleEarnings').mockResolvedValue({
        totalPayments: 10,
        grossRevenue: 30000,
      });

      const res = await adminVehicleService.getVehicleEarnings(TEST_VEHICLE_ID);
      expect(res.grossRevenue).toBe(30000);
    });

    it('getVehicleHistory returns history', async () => {
      jest.spyOn(adminVehicleRepository, 'getVehicleHistory').mockResolvedValue({
        history: [{ id: 'act-1', action: 'VEHICLE_STATUS_CHANGE' }],
        total: 1,
      });

      const res = await adminVehicleService.getVehicleHistory(TEST_VEHICLE_ID, { limit: 10 });
      expect(res.history).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
    });

    it('throws NotFoundError for non-existent vehicle across subresources', async () => {
      jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue(null);

      await expect(
        adminVehicleService.getVehicleDocuments(TEST_VEHICLE_ID),
      ).rejects.toThrow(NotFoundError);

      await expect(
        adminVehicleService.getVehicleImages(TEST_VEHICLE_ID),
      ).rejects.toThrow(NotFoundError);

      await expect(
        adminVehicleService.getVehicleBookings(TEST_VEHICLE_ID),
      ).rejects.toThrow(NotFoundError);

      await expect(
        adminVehicleService.getVehicleAvailability(TEST_VEHICLE_ID),
      ).rejects.toThrow(NotFoundError);

      await expect(
        adminVehicleService.getVehiclePricing(TEST_VEHICLE_ID),
      ).rejects.toThrow(NotFoundError);

      await expect(
        adminVehicleService.getVehicleEarnings(TEST_VEHICLE_ID),
      ).rejects.toThrow(NotFoundError);

      await expect(
        adminVehicleService.getVehicleHistory(TEST_VEHICLE_ID),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
