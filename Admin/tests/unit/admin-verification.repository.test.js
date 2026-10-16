'use strict';

const adminVerificationRepository = require('../../src/repositories/admin-verification.repository');

describe('Unit: AdminVerificationRepository', () => {
  let mockClient;
  let executedQueries;

  const TEST_PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';
  const TEST_VEHICLE_ID = 'd1111111-1111-4111-a111-111111111111';
  const TEST_USER_ID = 'a1111111-1111-4111-a111-111111111111';
  const TEST_PARTNER_DOC_ID = 'e1111111-1111-4111-a111-111111111111';
  const TEST_VEHICLE_DOC_ID = 'e2222222-2222-4222-a222-222222222222';

  beforeEach(() => {
    adminVerificationRepository.constructor.resetMockVerificationResolver();
    executedQueries = [];
    mockClient = {
      query: jest.fn(async (text, values) => {
        executedQueries.push({ text, values });
        return { rows: [], rowCount: 0 };
      }),
    };
  });

  afterEach(() => {
    adminVerificationRepository.constructor.resetMockVerificationResolver();
  });

  it('escapes LIKE wildcards correctly', () => {
    expect(adminVerificationRepository._escapeLikeWildcards('foo%_\\bar'))
      .toBe('foo\\%\\_\\\\bar');
  });

  it('listPartnerVerifications executes parameterized search and filtering', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: TEST_PARTNER_ID,
          user_id: TEST_USER_ID,
          business_name: 'Apex Mobility',
          business_type: 'CAR_RENTAL',
          city: 'Bengaluru',
          kyc_status: 'PENDING',
          is_active: true,
          created_at: new Date('2026-09-01T10:00:00.000Z'),
          updated_at: new Date('2026-09-01T10:00:00.000Z'),
          owner_name: 'Suresh Patel',
          owner_email: 'suresh@apex.in',
          owner_phone: '9876543210',
          total_documents: 3,
          verified_documents: 1,
          pending_documents: 2,
          rejected_documents: 0,
          full_count: 1,
        },
      ],
      rowCount: 1,
    });

    const result = await adminVerificationRepository.listPartnerVerifications(
      {
        search: 'Apex',
        kycStatus: 'PENDING',
        city: 'Bengaluru',
        startDate: new Date('2026-09-01'),
        endDate: new Date('2026-09-05'),
        limit: 10,
        offset: 0,
        sortBy: 'created_at',
        sortOrder: 'DESC',
      },
      mockClient,
    );

    expect(result.partners).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.partners[0].businessName).toBe('Apex Mobility');
    expect(result.partners[0].documentCounts.pending).toBe(2);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('p.kyc_status = $'),
      expect.arrayContaining(['PENDING']),
    );
  });

  it('findPartnerVerificationById returns partner details with documents', async () => {
    mockClient.query = jest.fn().mockImplementation(async (text) => {
      if (text.includes('FROM partners p')) {
        return {
          rows: [
            {
              id: TEST_PARTNER_ID,
              user_id: TEST_USER_ID,
              business_name: 'Apex Mobility',
              business_type: 'CAR_RENTAL',
              city: 'Bengaluru',
              state: 'Karnataka',
              pincode: '560038',
              kyc_status: 'PENDING',
              is_active: true,
              owner_name: 'Suresh Patel',
              owner_email: 'suresh@apex.in',
              owner_phone: '9876543210',
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FROM partner_documents')) {
        return {
          rows: [
            {
              id: TEST_PARTNER_DOC_ID,
              partner_id: TEST_PARTNER_ID,
              document_type: 'PAN',
              document_number: 'ABCDE1234F',
              storage_key: 'partners/docs/pan.pdf',
              verification_status: 'PENDING',
              version: 1,
              rejection_reason: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const partner = await adminVerificationRepository.findPartnerVerificationById(
      TEST_PARTNER_ID,
      mockClient,
    );

    expect(partner).not.toBeNull();
    expect(partner.businessName).toBe('Apex Mobility');
    expect(partner.documents).toHaveLength(1);
    expect(partner.documents[0].documentType).toBe('PAN');
  });

  it('findPartnerByIdForUpdate acquires FOR UPDATE row lock', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: TEST_PARTNER_ID,
          user_id: TEST_USER_ID,
          business_name: 'Apex Mobility',
          kyc_status: 'PENDING',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const current = await adminVerificationRepository.findPartnerByIdForUpdate(
      TEST_PARTNER_ID,
      mockClient,
    );

    expect(current).not.toBeNull();
    expect(current.kycStatus).toBe('PENDING');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      [TEST_PARTNER_ID],
    );
  });

  it('updatePartnerKycStatus updates partners table and returns updated record', async () => {
    mockClient.query = jest.fn().mockImplementation(async (text) => {
      if (text.includes('UPDATE partners')) {
        return { rowCount: 1 };
      }
      if (text.includes('FROM partners p')) {
        return {
          rows: [
            {
              id: TEST_PARTNER_ID,
              user_id: TEST_USER_ID,
              business_name: 'Apex Mobility',
              kyc_status: 'VERIFIED',
              is_active: true,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FROM partner_documents')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    });

    const updated = await adminVerificationRepository.updatePartnerKycStatus(
      TEST_PARTNER_ID,
      'VERIFIED',
      mockClient,
    );

    expect(updated.kycStatus).toBe('VERIFIED');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE partners'),
      [TEST_PARTNER_ID, 'VERIFIED'],
    );
  });

  it('listVehicleVerifications executes parameterized search and filtering', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: TEST_VEHICLE_ID,
          partner_id: TEST_PARTNER_ID,
          category: 'CAR',
          brand: 'Tata',
          model: 'Nexon EV',
          variant: 'XZ+',
          registration_number: 'KA-01-MJ-9999',
          year: 2024,
          fuel_type: 'EV',
          transmission: 'Automatic',
          manual_status: 'ONLINE',
          rental_status: 'IDLE',
          verification_status: 'PENDING',
          is_archived: false,
          created_at: new Date(),
          updated_at: new Date(),
          partner_name: 'Apex Mobility',
          partner_city: 'Bengaluru',
          total_documents: 4,
          verified_documents: 2,
          pending_documents: 2,
          rejected_documents: 0,
          full_count: 1,
        },
      ],
      rowCount: 1,
    });

    const result = await adminVerificationRepository.listVehicleVerifications(
      {
        search: 'Nexon',
        verificationStatus: 'PENDING',
        partnerId: TEST_PARTNER_ID,
        category: 'CAR',
        limit: 10,
        offset: 0,
      },
      mockClient,
    );

    expect(result.vehicles).toHaveLength(1);
    expect(result.vehicles[0].registrationNumber).toBe('KA-01-MJ-9999');
    expect(result.vehicles[0].documentCounts.pending).toBe(2);
  });

  it('findVehicleVerificationById returns vehicle details with documents and images', async () => {
    mockClient.query = jest.fn().mockImplementation(async (text) => {
      if (text.includes('FROM vehicles v')) {
        return {
          rows: [
            {
              id: TEST_VEHICLE_ID,
              partner_id: TEST_PARTNER_ID,
              category: 'CAR',
              brand: 'Tata',
              model: 'Nexon EV',
              registration_number: 'KA-01-MJ-9999',
              verification_status: 'PENDING',
              is_archived: false,
              partner_name: 'Apex Mobility',
              partner_city: 'Bengaluru',
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FROM vehicle_documents')) {
        return {
          rows: [
            {
              id: TEST_VEHICLE_DOC_ID,
              vehicle_id: TEST_VEHICLE_ID,
              document_type: 'RC',
              document_name: 'Registration Certificate',
              document_number: 'KA01MJ9999RC',
              storage_key: 'vehicles/docs/rc.pdf',
              verification_status: 'PENDING',
              is_required: true,
              version: 1,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FROM vehicle_images')) {
        return {
          rows: [
            {
              id: 'img-1',
              vehicle_id: TEST_VEHICLE_ID,
              storage_key: 'vehicles/images/front.jpg',
              image_url: 'https://cdn.gongo.in/v1.jpg',
              is_cover: true,
              sort_order: 1,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [] };
    });

    const vehicle = await adminVerificationRepository.findVehicleVerificationById(
      TEST_VEHICLE_ID,
      mockClient,
    );

    expect(vehicle).not.toBeNull();
    expect(vehicle.registrationNumber).toBe('KA-01-MJ-9999');
    expect(vehicle.documents).toHaveLength(1);
    expect(vehicle.images).toHaveLength(1);
    expect(vehicle.documents[0].documentType).toBe('RC');
  });

  it('findDocumentById resolves partner document when found in partner_documents', async () => {
    mockClient.query = jest.fn().mockImplementation(async (text) => {
      if (text.includes('FROM partner_documents pd')) {
        return {
          rows: [
            {
              id: TEST_PARTNER_DOC_ID,
              partner_id: TEST_PARTNER_ID,
              document_type: 'GST',
              document_number: '29ABCDE1234F1Z5',
              storage_key: 'partners/docs/gst.pdf',
              verification_status: 'PENDING',
              version: 1,
              rejection_reason: null,
              created_at: new Date(),
              updated_at: new Date(),
              entity_name: 'Apex Mobility',
              entity_kyc_status: 'PENDING',
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [] };
    });

    const result = await adminVerificationRepository.findDocumentById(
      TEST_PARTNER_DOC_ID,
      mockClient,
    );

    expect(result).not.toBeNull();
    expect(result.entityType).toBe('PARTNER');
    expect(result.document.documentType).toBe('GST');
    expect(result.document.storageKey).toBe('partners/docs/gst.pdf');
  });

  it('findDocumentById resolves vehicle document when not found in partner_documents', async () => {
    mockClient.query = jest.fn().mockImplementation(async (text) => {
      if (text.includes('FROM partner_documents pd')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM vehicle_documents vd')) {
        return {
          rows: [
            {
              id: TEST_VEHICLE_DOC_ID,
              vehicle_id: TEST_VEHICLE_ID,
              document_type: 'INSURANCE',
              document_name: 'Commercial Insurance Policy',
              document_number: 'POL-2026-9999',
              valid_till: new Date('2027-09-01'),
              storage_key: 'vehicles/docs/insurance.pdf',
              verification_status: 'PENDING',
              is_required: true,
              version: 1,
              rejection_reason: null,
              created_at: new Date(),
              updated_at: new Date(),
              entity_name: 'KA-01-MJ-9999',
              entity_verification_status: 'PENDING',
              partner_id: TEST_PARTNER_ID,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [] };
    });

    const result = await adminVerificationRepository.findDocumentById(
      TEST_VEHICLE_DOC_ID,
      mockClient,
    );

    expect(result).not.toBeNull();
    expect(result.entityType).toBe('VEHICLE');
    expect(result.document.documentType).toBe('INSURANCE');
    expect(result.document.storageKey).toBe('vehicles/docs/insurance.pdf');
  });

  it('updatePartnerDocumentStatus updates verification status and rejection reason', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: TEST_PARTNER_DOC_ID,
          partner_id: TEST_PARTNER_ID,
          document_type: 'PAN',
          document_number: 'ABCDE1234F',
          storage_key: 'partners/docs/pan.pdf',
          verification_status: 'REJECTED',
          version: 1,
          rejection_reason: 'Image is blurry and unreadable',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const updated = await adminVerificationRepository.updatePartnerDocumentStatus(
      TEST_PARTNER_DOC_ID,
      { verificationStatus: 'REJECTED', rejectionReason: 'Image is blurry and unreadable' },
      mockClient,
    );

    expect(updated.verificationStatus).toBe('REJECTED');
    expect(updated.rejectionReason).toBe('Image is blurry and unreadable');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE partner_documents'),
      [TEST_PARTNER_DOC_ID, 'REJECTED', 'Image is blurry and unreadable'],
    );
  });

  it('updateVehicleDocumentStatus updates verification status and rejection reason', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: TEST_VEHICLE_DOC_ID,
          vehicle_id: TEST_VEHICLE_ID,
          document_type: 'RC',
          document_name: 'Registration Certificate',
          document_number: 'KA01MJ9999RC',
          storage_key: 'vehicles/docs/rc.pdf',
          verification_status: 'VERIFIED',
          is_required: true,
          version: 1,
          rejection_reason: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    });

    const updated = await adminVerificationRepository.updateVehicleDocumentStatus(
      TEST_VEHICLE_DOC_ID,
      { verificationStatus: 'VERIFIED', rejectionReason: null },
      mockClient,
    );

    expect(updated.verificationStatus).toBe('VERIFIED');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE vehicle_documents'),
      [TEST_VEHICLE_DOC_ID, 'VERIFIED', null],
    );
  });

  it('listKycVerifications executes unified query across partners and vehicles', async () => {
    mockClient.query = jest.fn().mockResolvedValue({
      rows: [
        {
          entity_id: TEST_PARTNER_ID,
          entity_type: 'PARTNER',
          entity_name: 'Apex Mobility',
          secondary_name: 'Suresh Patel',
          status: 'PENDING',
          created_at: new Date(),
          updated_at: new Date(),
          total_documents: 3,
          pending_documents: 2,
          full_count: 2,
        },
        {
          entity_id: TEST_VEHICLE_ID,
          entity_type: 'VEHICLE',
          entity_name: 'KA-01-MJ-9999',
          secondary_name: 'Tata Nexon EV',
          status: 'PENDING',
          created_at: new Date(),
          updated_at: new Date(),
          total_documents: 4,
          pending_documents: 1,
          full_count: 2,
        },
      ],
      rowCount: 2,
    });

    const res = await adminVerificationRepository.listKycVerifications(
      { status: 'PENDING', limit: 10, offset: 0 },
      mockClient,
    );

    expect(res.items).toHaveLength(2);
    expect(res.total).toBe(2);
    expect(res.items[0].entityType).toBe('PARTNER');
    expect(res.items[1].entityType).toBe('VEHICLE');
  });

  it('supports custom resolver injection for unit testing', async () => {
    adminVerificationRepository.constructor.setMockVerificationResolver({
      findPartnerVerificationById: async (id) => ({ id, mock: true }),
    });

    const res = await adminVerificationRepository.findPartnerVerificationById('custom-id');
    expect(res).toEqual({ id: 'custom-id', mock: true });
  });
});
