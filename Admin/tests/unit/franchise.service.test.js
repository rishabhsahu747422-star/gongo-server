'use strict';

const franchiseService = require('../../src/services/franchise.service');
const franchiseRepository = require('../../src/repositories/franchise.repository');
const { ConflictError, NotFoundError } = require('../../src/errors');

describe('Unit: FranchiseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    FranchiseRepositoryMock();
  });

  function FranchiseRepositoryMock() {
    jest.spyOn(franchiseRepository, 'findRecentDuplicate').mockResolvedValue(null);
    jest.spyOn(franchiseRepository, 'createApplication').mockImplementation(async (data) => ({
      id: 'app-uuid-001',
      applicant_name: data.applicantName,
      phone: data.phone,
      email: data.email,
      city: data.city,
      state: data.state || '',
      investment_capacity: data.investmentCapacity || '25-50',
      business_experience: data.businessExperience || 'none',
      message: data.message || '',
      status: 'new',
      admin_notes: null,
      reviewed_by: null,
      reviewed_at: null,
      created_at: '2026-10-09T10:00:00Z',
      updated_at: '2026-10-09T10:00:00Z',
    }));

    jest.spyOn(franchiseRepository, 'listApplications').mockResolvedValue({
      items: [
        {
          id: 'app-uuid-001',
          applicant_name: 'Aman Patel',
          phone: '9876543210',
          email: 'aman@patel.in',
          city: 'Indore',
          state: 'MP',
          investment_capacity: '25-50',
          business_experience: 'fleet',
          message: 'Fleet owner',
          status: 'new',
          admin_notes: null,
          reviewed_by: null,
          reviewed_at: null,
          reviewer_email: null,
          reviewer_name: null,
          created_at: '2026-10-09T10:00:00Z',
          updated_at: '2026-10-09T10:00:00Z',
        },
      ],
      total: 1,
    });

    jest.spyOn(franchiseRepository, 'getApplicationById').mockImplementation(async (id) => {
      if (id === 'app-uuid-001') {
        return {
          id: 'app-uuid-001',
          applicant_name: 'Aman Patel',
          phone: '9876543210',
          email: 'aman@patel.in',
          city: 'Indore',
          state: 'MP',
          investment_capacity: '25-50',
          business_experience: 'fleet',
          message: 'Fleet owner',
          status: 'new',
          admin_notes: null,
          reviewed_by: null,
          reviewed_at: null,
          reviewer_email: null,
          reviewer_name: null,
          created_at: '2026-10-09T10:00:00Z',
          updated_at: '2026-10-09T10:00:00Z',
        };
      }
      return null;
    });

    jest.spyOn(franchiseRepository, 'updateStatus').mockImplementation(async (id, { status, adminNotes, reviewedBy }) => ({
      id,
      applicant_name: 'Aman Patel',
      phone: '9876543210',
      email: 'aman@patel.in',
      city: 'Indore',
      state: 'MP',
      investment_capacity: '25-50',
      business_experience: 'fleet',
      message: 'Fleet owner',
      status,
      admin_notes: adminNotes,
      reviewed_by: reviewedBy,
      reviewed_at: '2026-10-09T11:00:00Z',
      reviewer_email: 'admin@gongo.in',
      reviewer_name: 'Admin User',
      created_at: '2026-10-09T10:00:00Z',
      updated_at: '2026-10-09T11:00:00Z',
    }));
  }

  describe('submitApplication', () => {
    it('successfully creates new franchise application with default "new" status', async () => {
      const payload = {
        applicantName: 'Aman Patel',
        phone: '9876543210',
        email: 'aman@patel.in',
        city: 'Indore',
        state: 'MP',
        investmentCapacity: '25-50',
        businessExperience: 'fleet',
        message: 'Fleet owner',
      };

      const result = await franchiseService.submitApplication(payload, '127.0.0.1');

      expect(result).toHaveProperty('id', 'app-uuid-001');
      expect(result).toHaveProperty('status', 'new');
      expect(result).toHaveProperty('applicantName', 'Aman Patel');
      expect(franchiseRepository.createApplication).toHaveBeenCalledWith(payload);
    });

    it('rejects duplicate application submitted within 10 minutes', async () => {
      jest.spyOn(franchiseRepository, 'findRecentDuplicate').mockResolvedValueOnce({
        id: 'existing-id',
        created_at: new Date(),
      });

      await expect(
        franchiseService.submitApplication({
          applicantName: 'Aman Patel',
          phone: '9876543210',
          email: 'aman@patel.in',
          city: 'Indore',
        }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('listApplications', () => {
    it('returns formatted applications with pagination metadata', async () => {
      const res = await franchiseService.listApplications({ page: 1, limit: 10, status: 'all' });
      expect(res.items).toHaveLength(1);
      expect(res.total).toBe(1);
      expect(res.page).toBe(1);
      expect(res.totalPages).toBe(1);
      expect(res.items[0]).toHaveProperty('applicantName', 'Aman Patel');
    });
  });

  describe('getApplicationById', () => {
    it('returns application details when found', async () => {
      const res = await franchiseService.getApplicationById('app-uuid-001');
      expect(res.id).toBe('app-uuid-001');
      expect(res.city).toBe('Indore');
    });

    it('throws NotFoundError when application does not exist', async () => {
      await expect(franchiseService.getApplicationById('non-existent')).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateApplicationStatus', () => {
    it('updates status and triggers audit logging', async () => {
      const mockAudit = jest.fn();
      const auditCtx = {
        actorId: 'admin-001',
        audit: mockAudit,
      };

      const res = await franchiseService.updateApplicationStatus(
        'app-uuid-001',
        { status: 'in_review', adminNotes: 'Initial background check passed' },
        auditCtx,
      );

      expect(res.status).toBe('in_review');
      expect(res.adminNotes).toBe('Initial background check passed');
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'FRANCHISE_APPLICATION_STATUS_UPDATE',
          targetResource: 'franchise_applications',
          targetResourceId: 'app-uuid-001',
        }),
      );
    });
  });
});
