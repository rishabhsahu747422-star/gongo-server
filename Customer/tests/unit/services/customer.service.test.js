'use strict';

const CustomerService = require('../../../src/services/customer.service');
const { NotFoundError, ForbiddenError, ConflictError } = require('../../../src/errors');

describe('CustomerService Unit Tests', () => {
  let service;
  let mockCustomerRepo;
  let mockDocumentRepo;

  const mockUser = {
    id: 'user-uuid-1',
    role: 'customer',
    name: 'John Doe',
    countryCode: '+91',
    phone: '9876543210',
    email: 'john@example.com',
    authProvider: 'firebase',
    authId: 'firebase-uid-1',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  const mockDlDoc = {
    id: 'doc-uuid-1',
    userId: 'user-uuid-1',
    documentType: 'DRIVING_LICENSE',
    status: 'VERIFIED',
    storageKey: 'private/key.jpg',
    metadata: {},
    rejectionReason: null,
    verifiedAt: new Date('2026-01-02T00:00:00Z'),
    createdAt: new Date('2026-01-02T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

  beforeEach(() => {
    mockCustomerRepo = {
      findById: jest.fn(),
      updateProfile: jest.fn(),
    };
    mockDocumentRepo = {
      findByUserId: jest.fn(),
      findLatestByUserAndType: jest.fn(),
    };

    service = new CustomerService.constructor({
      customerRepo: mockCustomerRepo,
      documentRepo: mockDocumentRepo,
    });
  });

  describe('getProfile', () => {
    it('should return safe customer profile DTO with verification status', async () => {
      mockCustomerRepo.findById.mockResolvedValue(mockUser);
      mockDocumentRepo.findLatestByUserAndType.mockResolvedValue(mockDlDoc);

      const profile = await service.getProfile('user-uuid-1');

      expect(profile).toEqual({
        id: 'user-uuid-1',
        role: 'customer',
        name: 'John Doe',
        countryCode: '+91',
        phone: '9876543210',
        email: 'john@example.com',
        avatarUrl: null,
        profileImage: null,
        profilePhoto: null,
        customerReference: null,
        verificationStatus: {
          isProfileComplete: true,
          drivingLicenseStatus: 'VERIFIED',
        },
        createdAt: mockUser.createdAt,
        updatedAt: mockUser.updatedAt,
      });

      // No secrets or auth identifiers
      expect(profile.authId).toBeUndefined();
      expect(profile.authProvider).toBeUndefined();
    });

    it('should set drivingLicenseStatus to NOT_SUBMITTED when no document exists', async () => {
      mockCustomerRepo.findById.mockResolvedValue({
        ...mockUser,
        name: null,
      });
      mockDocumentRepo.findLatestByUserAndType.mockResolvedValue(null);

      const profile = await service.getProfile('user-uuid-1');

      expect(profile.verificationStatus.drivingLicenseStatus).toBe('NOT_SUBMITTED');
      expect(profile.verificationStatus.isProfileComplete).toBe(false);
    });

    it('should throw NotFoundError if customer record does not exist', async () => {
      mockCustomerRepo.findById.mockResolvedValue(null);

      await expect(service.getProfile('unknown-id')).rejects.toThrow(NotFoundError);
    });

    it('should throw ForbiddenError if customer account is deactivated', async () => {
      mockCustomerRepo.findById.mockResolvedValue({
        ...mockUser,
        isActive: false,
      });

      await expect(service.getProfile('user-uuid-1')).rejects.toThrow(ForbiddenError);
    });
  });

  describe('updateProfile', () => {
    it('should update name and email and return updated profile DTO', async () => {
      mockCustomerRepo.findById.mockResolvedValue(mockUser);
      mockCustomerRepo.updateProfile.mockResolvedValue({
        ...mockUser,
        name: 'Jane Doe',
        email: 'jane@example.com',
      });
      mockDocumentRepo.findLatestByUserAndType.mockResolvedValue(mockDlDoc);

      const result = await service.updateProfile('user-uuid-1', {
        name: 'Jane Doe',
        email: 'jane@example.com',
      });

      expect(mockCustomerRepo.updateProfile).toHaveBeenCalledWith('user-uuid-1', {
        name: 'Jane Doe',
        email: 'jane@example.com',
      });
      expect(result.name).toBe('Jane Doe');
      expect(result.email).toBe('jane@example.com');
    });

    it('should map duplicate email error to ConflictError with safe message', async () => {
      mockCustomerRepo.findById.mockResolvedValue(mockUser);
      const dbErr = new ConflictError('A record with the provided information already exists', 'DUPLICATE_RESOURCE');
      mockCustomerRepo.updateProfile.mockRejectedValue(dbErr);

      await expect(
        service.updateProfile('user-uuid-1', { email: 'alreadytaken@example.com' }),
      ).rejects.toThrow(
        expect.objectContaining({
          statusCode: 409,
          code: 'EMAIL_ALREADY_IN_USE',
        }),
      );
    });
  });

  describe('getDocuments', () => {
    it('should return safe document DTOs without storageKey or metadata', async () => {
      mockCustomerRepo.findById.mockResolvedValue(mockUser);
      mockDocumentRepo.findByUserId.mockResolvedValue([mockDlDoc]);

      const docs = await service.getDocuments('user-uuid-1');

      expect(docs).toHaveLength(1);
      expect(docs[0]).toEqual({
        id: 'doc-uuid-1',
        documentType: 'DRIVING_LICENSE',
        status: 'VERIFIED',
        rejectionReason: null,
        verifiedAt: mockDlDoc.verifiedAt,
        createdAt: mockDlDoc.createdAt,
        updatedAt: mockDlDoc.updatedAt,
      });

      expect(docs[0].storageKey).toBeUndefined();
      expect(docs[0].metadata).toBeUndefined();
    });
  });
});
