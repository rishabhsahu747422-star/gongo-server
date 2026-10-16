'use strict';

const adminPartnerService = require('../../src/services/admin-partner.service');
const adminPartnerRepository = require('../../src/repositories/admin-partner.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const auditService = require('../../src/services/audit.service');
const { ValidationError, NotFoundError } = require('../../src/errors');

describe('Unit: AdminPartnerService', () => {
  const PARTNER_ID = 'a1111111-1111-4111-a111-111111111111';

  const mockPartnerRecord = {
    id: PARTNER_ID,
    userId: 'u1111111-1111-4111-u111-111111111111',
    name: 'Rajesh Sharma',
    email: 'rajesh@partner.in',
    phone: '9876543210',
    countryCode: '+91',
    businessName: 'Fast Wheels Hub',
    city: 'Bengaluru',
    partnerStatus: 'ONLINE',
    kycStatus: 'PENDING',
    rating: 4.85,
    reviewCount: 24,
    isActive: true,
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(adminPartnerRepository, 'withTransaction').mockImplementation(async (cb) => cb({}));
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
  });

  describe('listPartners', () => {
    it('returns partners list and pagination', async () => {
      jest.spyOn(adminPartnerRepository, 'listPartners').mockResolvedValue({
        partners: [mockPartnerRecord],
        total: 1,
      });

      const res = await adminPartnerService.listPartners({ limit: '10', offset: '0' });

      expect(res.partners).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
      expect(res.pagination.limit).toBe(10);
      expect(res.pagination.offset).toBe(0);
      expect(res.pagination.pages).toBe(1);
    });

    it('rejects invalid partnerStatus with ValidationError', async () => {
      await expect(
        adminPartnerService.listPartners({ partnerStatus: 'INVALID' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects invalid kycStatus with ValidationError', async () => {
      await expect(
        adminPartnerService.listPartners({ kycStatus: 'INVALID' }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects invalid isActive filter with ValidationError', async () => {
      await expect(
        adminPartnerService.listPartners({ isActive: 'not-bool' }),
      ).rejects.toThrow(ValidationError);
    });

    it('validates date ranges and rejects start >= end', async () => {
      await expect(
        adminPartnerService.listPartners({
          startDate: '2026-09-20',
          endDate: '2026-09-10',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects date range exceeding 366 days', async () => {
      await expect(
        adminPartnerService.listPartners({
          startDate: '2023-01-01',
          endDate: '2026-01-01',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects negative or invalid pagination values', async () => {
      await expect(
        adminPartnerService.listPartners({ limit: '-5' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        adminPartnerService.listPartners({ offset: '-1' }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('getPartnerDetail', () => {
    it('returns partner detail with fleet, booking, kyc, and financial summaries', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(mockPartnerRecord);
      jest.spyOn(adminPartnerRepository, 'getPartnerSummaries').mockResolvedValue({
        fleetSummary: { total: 10 },
        bookingSummary: { total: 50 },
        kycSummary: { totalDocuments: 4 },
        financialSummary: { grossAmount: 50000 },
      });

      const res = await adminPartnerService.getPartnerDetail(PARTNER_ID);

      expect(res.partner.id).toBe(PARTNER_ID);
      expect(res.fleetSummary.total).toBe(10);
      expect(res.bookingSummary.total).toBe(50);
      expect(res.financialSummary.grossAmount).toBe(50000);
    });

    it('throws ValidationError if partnerId is not a UUID', async () => {
      await expect(
        adminPartnerService.getPartnerDetail('not-a-uuid'),
      ).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError if partner does not exist', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(null);

      await expect(
        adminPartnerService.getPartnerDetail(PARTNER_ID),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('updatePartnerStatus', () => {
    it('updates partner status and records audit event', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(mockPartnerRecord);
      jest.spyOn(adminPartnerRepository, 'updatePartnerStatus').mockResolvedValue({
        ...mockPartnerRecord,
        partnerStatus: 'OFFLINE',
      });

      const res = await adminPartnerService.updatePartnerStatus(
        PARTNER_ID,
        { partnerStatus: 'OFFLINE', reason: 'Routine offline toggle' },
        { actorId: 'admin-1', actorRole: 'ADMIN' },
      );

      expect(res.partnerStatus).toBe('OFFLINE');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PARTNER_STATUS_CHANGE',
          targetResource: 'PARTNER',
          targetResourceId: PARTNER_ID,
        }),
        expect.anything(),
      );
      expect(auditService.logAdminAction).toHaveBeenCalled();
    });

    it('rejects mass-assignment attempts of unauthorized fields', async () => {
      await expect(
        adminPartnerService.updatePartnerStatus(
          PARTNER_ID,
          { partnerStatus: 'OFFLINE', rating: 5.0, user_id: 'malicious' },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects deactivation when partner has active bookings and force is false', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(mockPartnerRecord);
      jest.spyOn(adminPartnerRepository, 'getActiveBookingCount').mockResolvedValue(2);

      await expect(
        adminPartnerService.updatePartnerStatus(
          PARTNER_ID,
          { isActive: false },
          { actorId: 'admin-1' },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('allows deactivation when force is true even if active bookings exist', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(mockPartnerRecord);
      jest.spyOn(adminPartnerRepository, 'getActiveBookingCount').mockResolvedValue(2);
      jest.spyOn(adminPartnerRepository, 'updatePartnerStatus').mockResolvedValue({
        ...mockPartnerRecord,
        isActive: false,
      });

      const res = await adminPartnerService.updatePartnerStatus(
        PARTNER_ID,
        { isActive: false, force: true, reason: 'Emergency suspension' },
        { actorId: 'admin-1' },
      );

      expect(res.isActive).toBe(false);
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PARTNER_SUSPEND',
          metadata: expect.objectContaining({ force: true }),
        }),
        expect.anything(),
      );
    });
  });

  describe('approvePartner', () => {
    it('approves partner verification and logs PARTNER_APPROVED audit event', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(mockPartnerRecord);
      jest.spyOn(adminPartnerRepository, 'updateKycStatus').mockResolvedValue({
        ...mockPartnerRecord,
        kycStatus: 'VERIFIED',
      });

      const res = await adminPartnerService.approvePartner(
        PARTNER_ID,
        { reason: 'Documents fully verified' },
        { actorId: 'admin-1' },
      );

      expect(res.kycStatus).toBe('VERIFIED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PARTNER_APPROVED',
          targetResource: 'PARTNER',
          targetResourceId: PARTNER_ID,
        }),
        expect.anything(),
      );
    });
  });

  describe('rejectPartner', () => {
    it('rejects partner verification with mandatory reason', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(mockPartnerRecord);
      jest.spyOn(adminPartnerRepository, 'updateKycStatus').mockResolvedValue({
        ...mockPartnerRecord,
        kycStatus: 'REJECTED',
      });

      const res = await adminPartnerService.rejectPartner(
        PARTNER_ID,
        { reason: 'PAN card image is unreadable' },
        { actorId: 'admin-1' },
      );

      expect(res.kycStatus).toBe('REJECTED');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PARTNER_REJECTED',
          metadata: expect.objectContaining({ reason: 'PAN card image is unreadable' }),
        }),
        expect.anything(),
      );
    });

    it('throws ValidationError if rejection reason is missing or too short', async () => {
      await expect(
        adminPartnerService.rejectPartner(PARTNER_ID, { reason: '' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        adminPartnerService.rejectPartner(PARTNER_ID, { reason: 'no' }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('suspendPartner', () => {
    it('suspends partner and creates SUSPEND_PARTNER audit record', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(mockPartnerRecord);
      jest.spyOn(adminPartnerRepository, 'getActiveBookingCount').mockResolvedValue(0);
      jest.spyOn(adminPartnerRepository, 'updatePartnerStatus').mockResolvedValue({
        ...mockPartnerRecord,
        isActive: false,
        partnerStatus: 'OFFLINE',
      });
      jest.spyOn(adminPartnerRepository, 'insertVerificationHistory').mockResolvedValue({});

      const res = await adminPartnerService.suspendPartner(
        PARTNER_ID,
        { reason: 'Violated partner guidelines' },
        { actorId: 'admin-1' },
      );

      expect(res.isActive).toBe(false);
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SUSPEND_PARTNER',
          targetResource: 'PARTNER',
          targetResourceId: PARTNER_ID,
        }),
        expect.anything(),
      );
    });

    it('rejects suspend if active bookings exist and force is not true', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(mockPartnerRecord);
      jest.spyOn(adminPartnerRepository, 'getActiveBookingCount').mockResolvedValue(3);

      await expect(
        adminPartnerService.suspendPartner(PARTNER_ID, { reason: 'Policy issue' }, { actorId: 'admin-1' }),
      ).rejects.toThrow(ValidationError);
    });

    it('allows suspend if active bookings exist when force is true', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(mockPartnerRecord);
      jest.spyOn(adminPartnerRepository, 'getActiveBookingCount').mockResolvedValue(3);
      jest.spyOn(adminPartnerRepository, 'updatePartnerStatus').mockResolvedValue({
        ...mockPartnerRecord,
        isActive: false,
        partnerStatus: 'OFFLINE',
      });
      jest.spyOn(adminPartnerRepository, 'insertVerificationHistory').mockResolvedValue({});

      const res = await adminPartnerService.suspendPartner(
        PARTNER_ID,
        { reason: 'Emergency suspension', force: true },
        { actorId: 'admin-1' },
      );

      expect(res.isActive).toBe(false);
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SUSPEND_PARTNER',
          metadata: expect.objectContaining({ force: true }),
        }),
        expect.anything(),
      );
    });
  });

  describe('reactivatePartner', () => {
    it('reactivates suspended partner and creates REACTIVATE_PARTNER audit record', async () => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue({
        ...mockPartnerRecord,
        isActive: false,
        partnerStatus: 'OFFLINE',
      });
      jest.spyOn(adminPartnerRepository, 'updatePartnerStatus').mockResolvedValue({
        ...mockPartnerRecord,
        isActive: true,
        partnerStatus: 'ONLINE',
      });
      jest.spyOn(adminPartnerRepository, 'insertVerificationHistory').mockResolvedValue({});

      const res = await adminPartnerService.reactivatePartner(
        PARTNER_ID,
        { reason: 'Issue resolved' },
        { actorId: 'admin-1' },
      );

      expect(res.isActive).toBe(true);
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REACTIVATE_PARTNER',
          targetResource: 'PARTNER',
          targetResourceId: PARTNER_ID,
        }),
        expect.anything(),
      );
    });
  });

  describe('Sub-resource getters', () => {
    beforeEach(() => {
      jest.spyOn(adminPartnerRepository, 'findPartnerById').mockResolvedValue(mockPartnerRecord);
    });

    it('getPartnerDocuments returns documents', async () => {
      jest.spyOn(adminPartnerRepository, 'getPartnerDocuments').mockResolvedValue([
        { id: 'doc-1', documentType: 'AADHAAR' },
      ]);

      const res = await adminPartnerService.getPartnerDocuments(PARTNER_ID);
      expect(res.documents).toHaveLength(1);
    });

    it('getPartnerBankAccounts returns bank accounts', async () => {
      jest.spyOn(adminPartnerRepository, 'getPartnerBankAccounts').mockResolvedValue([
        { id: 'bank-1', accountNumberMasked: 'XXXX-1234' },
      ]);

      const res = await adminPartnerService.getPartnerBankAccounts(PARTNER_ID);
      expect(res.bankAccounts).toHaveLength(1);
    });

    it('getPartnerVehicles returns vehicles list with pagination', async () => {
      jest.spyOn(adminPartnerRepository, 'getPartnerVehicles').mockResolvedValue({
        vehicles: [{ id: 'veh-1' }],
        total: 1,
      });

      const res = await adminPartnerService.getPartnerVehicles(PARTNER_ID, { limit: 10 });
      expect(res.vehicles).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
    });

    it('getPartnerBookings returns bookings list with pagination', async () => {
      jest.spyOn(adminPartnerRepository, 'getPartnerBookings').mockResolvedValue({
        bookings: [{ id: 'b-1' }],
        total: 1,
      });

      const res = await adminPartnerService.getPartnerBookings(PARTNER_ID, { limit: 10 });
      expect(res.bookings).toHaveLength(1);
      expect(res.pagination.total).toBe(1);
    });

    it('getPartnerEarnings returns earnings summary', async () => {
      jest.spyOn(adminPartnerRepository, 'getPartnerSummaries').mockResolvedValue({
        financialSummary: { grossAmount: 15000, completedPayouts: 10000 },
      });

      const res = await adminPartnerService.getPartnerEarnings(PARTNER_ID);
      expect(res.partnerId).toBe(PARTNER_ID);
      expect(res.earnings.grossAmount).toBe(15000);
    });
  });
});
