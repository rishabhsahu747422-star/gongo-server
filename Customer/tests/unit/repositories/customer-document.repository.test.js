'use strict';

const CustomerDocumentRepository = require('../../../src/repositories/customer-document.repository');

describe('CustomerDocumentRepository Unit Tests', () => {
  let repository;
  let mockQuery;

  beforeEach(() => {
    repository = new CustomerDocumentRepository();
    mockQuery = jest.fn();
    repository.query = mockQuery;
  });

  describe('mapDocumentRow and toSafeDto', () => {
    it('should correctly map database row to domain entity and project to safe DTO', () => {
      const dbRow = {
        id: 'doc-uuid-1',
        customer_id: 'user-uuid-1',
        document_type: 'driving_license',
        verification_status: 'verified',
        storage_path: 'private/s3/path/doc.jpg',
        file_url: 'https://storage.supabase.co/doc.jpg',
        rejection_reason: null,
        verified_at: new Date('2026-01-01T00:00:00Z'),
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      };

      const entity = CustomerDocumentRepository.mapDocumentRow(dbRow);
      expect(entity).toMatchObject({
        id: 'doc-uuid-1',
        userId: 'user-uuid-1',
        documentType: 'DRIVING_LICENSE',
        status: 'VERIFIED',
        storageKey: 'private/s3/path/doc.jpg',
        rejectionReason: null,
        verifiedAt: new Date('2026-01-01T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });

      const safeDto = CustomerDocumentRepository.toSafeDto(entity);
      expect(safeDto).toEqual({
        id: 'doc-uuid-1',
        documentType: 'DRIVING_LICENSE',
        status: 'VERIFIED',
        rejectionReason: null,
        verifiedAt: new Date('2026-01-01T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });

      // Crucial: storage_key and internal metadata must NOT be present in safe DTO
      expect(safeDto.storageKey).toBeUndefined();
      expect(safeDto.metadata).toBeUndefined();
      expect(safeDto.userId).toBeUndefined();
    });

    it('should return null for null input', () => {
      expect(CustomerDocumentRepository.mapDocumentRow(null)).toBeNull();
      expect(CustomerDocumentRepository.toSafeDto(null)).toBeNull();
    });
  });

  describe('create', () => {
    it('should insert document with parameterized SQL and return mapped entity', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'new-doc-id',
            customer_id: 'user-123',
            document_type: 'driving_license',
            verification_status: 'pending',
            storage_path: 's3/key.pdf',
            file_url: 's3/key.pdf',
            rejection_reason: null,
            verified_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const result = await repository.create({
        userId: 'user-123',
        documentType: 'DRIVING_LICENSE',
        status: 'PENDING',
        storageKey: 's3/key.pdf',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO customer_documents'),
        ['user-123', 'driving_license', 's3/key.pdf', 's3/key.pdf', 'pending'],
      );
      expect(result.id).toBe('new-doc-id');
      expect(result.documentType).toBe('DRIVING_LICENSE');
    });
  });

  describe('findByUserId', () => {
    it('should query by user_id with parameterization and return list of entities', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'doc-1',
            customer_id: 'user-123',
            document_type: 'driving_license',
            verification_status: 'verified',
            storage_path: 's3/key1',
            file_url: 's3/key1',
            rejection_reason: null,
            verified_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const docs = await repository.findByUserId('user-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE customer_id = $1'),
        ['user-123'],
      );
      expect(docs).toHaveLength(1);
      expect(docs[0].id).toBe('doc-1');
    });
  });
});
