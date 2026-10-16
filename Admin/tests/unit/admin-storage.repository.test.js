'use strict';

const adminStorageRepository = require('../../src/repositories/admin-storage.repository');

const TEST_DOC_ID = 'da000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'ba000001-0000-4000-a000-000000000001';
const TEST_VEHICLE_ID = 'ea000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'ca000001-0000-4000-a000-000000000001';

describe('Unit: AdminStorageRepository', () => {
  let mockQuery;

  beforeEach(() => {
    mockQuery = jest.fn();
    adminStorageRepository.query = mockQuery;
    adminStorageRepository.constructor.resetMockStorageResolver();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    adminStorageRepository.constructor.resetMockStorageResolver();
  });

  describe('1. listDocuments', () => {
    it('executes count and items queries with pagination defaults', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '1' }] }) // Count query
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_DOC_ID,
              owner_type: 'PARTNER',
              owner_id: TEST_PARTNER_ID,
              owner_name: 'Fast Car Rentals',
              owner_email: 'fast@rentals.com',
              owner_phone: '+919876543210',
              document_type: 'PAN',
              document_name: 'PAN Card',
              document_number: 'ABCDE1234F',
              valid_till: null,
              storage_key: 'partners/docs/pan-1.pdf',
              verification_status: 'VERIFIED',
              is_required: true,
              version: 1,
              rejection_reason: null,
              created_at: new Date('2026-09-01T10:00:00Z'),
              updated_at: new Date('2026-09-01T10:00:00Z'),
            },
          ],
        });

      const result = await adminStorageRepository.listDocuments({ page: 1, limit: 10 });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(10);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(TEST_DOC_ID);
      expect(result.items[0].ownerType).toBe('PARTNER');
      expect(result.items[0].hasFile).toBe(true);
      expect(result.items[0].owner.name).toBe('Fast Car Rentals');
    });

    it('applies filters: ownerType, ownerId, partnerId, vehicleId, customerId, status', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [] });

      await adminStorageRepository.listDocuments({
        ownerType: 'PARTNER',
        ownerId: TEST_PARTNER_ID,
        partnerId: TEST_PARTNER_ID,
        vehicleId: TEST_VEHICLE_ID,
        customerId: TEST_CUSTOMER_ID,
        verificationStatus: 'PENDING',
        documentType: 'AADHAAR',
        hasFile: true,
      });

      const [countSql, countValues] = mockQuery.mock.calls[0];
      expect(countSql).toContain('owner_type = $');
      expect(countSql).toContain('owner_id = $');
      expect(countSql).toContain('partner_id = $');
      expect(countSql).toContain('vehicle_id = $');
      expect(countSql).toContain('customer_id = $');
      expect(countSql).toContain('verification_status = $');
      expect(countSql).toContain('document_type = $');
      expect(countSql).toContain("storage_key IS NOT NULL AND storage_key != ''");

      expect(countValues).toContain('PARTNER');
      expect(countValues).toContain(TEST_PARTNER_ID);
      expect(countValues).toContain(TEST_VEHICLE_ID);
      expect(countValues).toContain(TEST_CUSTOMER_ID);
      expect(countValues).toContain('PENDING');
      expect(countValues).toContain('AADHAAR');
    });

    it('applies date range bounds (startDate, endDate)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await adminStorageRepository.listDocuments({
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-10T23:59:59.999Z',
      });

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('created_at >= $');
      expect(sql).toContain('created_at <= $');
      expect(values).toContain('2026-09-01T00:00:00.000Z');
      expect(values).toContain('2026-09-10T23:59:59.999Z');
    });

    it('applies search term across document and owner fields', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await adminStorageRepository.listDocuments({
        search: 'Fast%Rental',
      });

      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('ILIKE $');
      expect(values[0]).toBe('%Fast\\%Rental%');
    });

    it('enforces safe sorting allowlist and falls back on invalid column', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ total: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await adminStorageRepository.listDocuments({
        sortBy: 'malicious_col; DROP TABLE users;',
        sortOrder: 'asc',
      });

      const [, selectSql] = mockQuery.mock.calls.map((c) => c[0]);
      expect(selectSql).toContain('ORDER BY created_at ASC');
      expect(selectSql).not.toContain('malicious_col');
    });
  });

  describe('2. findDocumentById', () => {
    it('returns formatted document when found in unified view', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DOC_ID,
            owner_type: 'VEHICLE',
            owner_id: TEST_VEHICLE_ID,
            owner_name: 'KA01AB1234',
            owner_email: 'owner@fast.com',
            owner_phone: '+919999999999',
            document_type: 'RC',
            document_name: 'Registration Certificate',
            document_number: 'RC-998877',
            valid_till: new Date('2028-01-01'),
            storage_key: 'vehicles/docs/rc-1.pdf',
            verification_status: 'VERIFIED',
            is_required: true,
            version: 1,
            rejection_reason: null,
            created_at: new Date('2026-09-02T10:00:00Z'),
            updated_at: new Date('2026-09-02T10:00:00Z'),
          },
        ],
      });

      const doc = await adminStorageRepository.findDocumentById(TEST_DOC_ID);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('WHERE id = $1::uuid');
      expect(values[0]).toBe(TEST_DOC_ID);

      expect(doc).toBeDefined();
      expect(doc.id).toBe(TEST_DOC_ID);
      expect(doc.ownerType).toBe('VEHICLE');
      expect(doc.owner.name).toBe('KA01AB1234');
      expect(doc.storageKey).toBe('vehicles/docs/rc-1.pdf');
      expect(doc.hasFile).toBe(true);
    });

    it('returns null when document is not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const doc = await adminStorageRepository.findDocumentById(TEST_DOC_ID);
      expect(doc).toBeNull();
    });
  });

  describe('3. findDocumentsByPartner', () => {
    it('returns partner summary and documents array', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_PARTNER_ID,
              business_name: 'Partner Wheels',
              kyc_status: 'VERIFIED',
              city: 'Bengaluru',
              owner_name: 'John Partner',
              email: 'john@wheels.com',
              phone: '+919876543210',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_DOC_ID,
              partner_id: TEST_PARTNER_ID,
              document_type: 'GST',
              document_name: 'GST Certificate',
              document_number: '29ABCDE1234F1Z5',
              valid_till: null,
              storage_key: 'partners/docs/gst-1.pdf',
              verification_status: 'VERIFIED',
              is_required: false,
              version: 1,
              rejection_reason: null,
              created_at: new Date('2026-09-01T12:00:00Z'),
              updated_at: new Date('2026-09-01T12:00:00Z'),
            },
          ],
        });

      const res = await adminStorageRepository.findDocumentsByPartner(TEST_PARTNER_ID);

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(res.partner.id).toBe(TEST_PARTNER_ID);
      expect(res.partner.businessName).toBe('Partner Wheels');
      expect(res.documents).toHaveLength(1);
      expect(res.documents[0].documentType).toBe('GST');
    });

    it('returns null when partner does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await adminStorageRepository.findDocumentsByPartner(TEST_PARTNER_ID);
      expect(res).toBeNull();
    });
  });

  describe('4. findDocumentsByVehicle', () => {
    it('returns vehicle summary and documents array', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_VEHICLE_ID,
              partner_id: TEST_PARTNER_ID,
              registration_number: 'KA05CD5678',
              brand: 'Hyundai',
              model: 'Creta',
              verification_status: 'VERIFIED',
              partner_name: 'Partner Wheels',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_DOC_ID,
              vehicle_id: TEST_VEHICLE_ID,
              document_type: 'INSURANCE',
              document_name: 'Comprehensive Insurance',
              document_number: 'POL-112233',
              valid_till: new Date('2027-01-01'),
              storage_key: 'vehicles/docs/insurance-1.pdf',
              verification_status: 'VERIFIED',
              is_required: true,
              version: 1,
              rejection_reason: null,
              created_at: new Date('2026-09-01T12:00:00Z'),
              updated_at: new Date('2026-09-01T12:00:00Z'),
            },
          ],
        });

      const res = await adminStorageRepository.findDocumentsByVehicle(TEST_VEHICLE_ID);

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(res.vehicle.id).toBe(TEST_VEHICLE_ID);
      expect(res.vehicle.registrationNumber).toBe('KA05CD5678');
      expect(res.documents).toHaveLength(1);
      expect(res.documents[0].documentType).toBe('INSURANCE');
    });

    it('returns null when vehicle does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await adminStorageRepository.findDocumentsByVehicle(TEST_VEHICLE_ID);
      expect(res).toBeNull();
    });
  });

  describe('5. findDocumentsByCustomer', () => {
    it('returns customer summary and documents array', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_CUSTOMER_ID,
              name: 'Alice Customer',
              email: 'alice@example.com',
              phone: '+919988776655',
              role: 'CUSTOMER',
              is_active: true,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: TEST_DOC_ID,
              user_id: TEST_CUSTOMER_ID,
              document_type: 'DRIVING_LICENSE',
              storage_key: 'customers/docs/dl-1.pdf',
              verification_status: 'VERIFIED',
              rejection_reason: null,
              created_at: new Date('2026-09-01T12:00:00Z'),
              updated_at: new Date('2026-09-01T12:00:00Z'),
            },
          ],
        });

      const res = await adminStorageRepository.findDocumentsByCustomer(TEST_CUSTOMER_ID);

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(res.customer.id).toBe(TEST_CUSTOMER_ID);
      expect(res.customer.name).toBe('Alice Customer');
      expect(res.documents).toHaveLength(1);
      expect(res.documents[0].documentType).toBe('DRIVING_LICENSE');
    });

    it('returns null when customer does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await adminStorageRepository.findDocumentsByCustomer(TEST_CUSTOMER_ID);
      expect(res).toBeNull();
    });
  });

  describe('6. findDocumentHistory', () => {
    it('queries admin_actions for target_resource_id or metadata->>documentId', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'act-1',
            actor_id: 'usr-1',
            actor_role: 'ADMIN',
            action: 'APPROVE_PARTNER_DOCUMENT',
            target_resource: 'PARTNER_DOCUMENT',
            target_resource_id: TEST_DOC_ID,
            request_id: 'req-1',
            metadata: { documentId: TEST_DOC_ID },
            created_at: new Date('2026-09-02T14:00:00Z'),
            actor_name: 'Super Admin',
            actor_email: 'admin@gongo.in',
          },
        ],
      });

      const history = await adminStorageRepository.findDocumentHistory(TEST_DOC_ID);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toContain('a.target_resource_id = $1');
      expect(sql).toContain("(a.metadata->>'documentId') = $1");
      expect(values[0]).toBe(TEST_DOC_ID);

      expect(history).toHaveLength(1);
      expect(history[0].action).toBe('APPROVE_PARTNER_DOCUMENT');
      expect(history[0].actor.name).toBe('Super Admin');
    });
  });
});
