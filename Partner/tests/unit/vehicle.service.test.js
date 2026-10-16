'use strict';

const vehicleService = require('../../src/services/vehicle.service');
const vehicleRepository = require('../../src/repositories/vehicle.repository');
const s3Provider = require('../../src/providers/s3');
const pool = require('../../src/db/pool');
const { NotFoundError, ConflictError } = require('../../src/errors');

describe('Unit: VehicleService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createVehicle', () => {
    it('creates vehicle and resolves legacy shop ID if present', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const input = {
        category: 'Car',
        brand: 'Maruti Suzuki',
        model: 'Swift',
        registrationNumber: 'MP 04 AB 1234',
        year: 2023,
        fuelType: 'Petrol',
        leaseAgreementAccepted: true,
      };

      jest.spyOn(vehicleRepository, 'findByRegistrationNumber').mockResolvedValue(null);
      jest.spyOn(vehicleService.shopRepository, 'findByPartnerId').mockResolvedValue({ id: 'shop-abc' });
      jest.spyOn(vehicleService.partnerRepository, 'findById').mockResolvedValue({ user_id: 'user-123' });
      const consentRepository = require('../../src/repositories/consent.repository');
      jest.spyOn(consentRepository, 'recordConsent').mockResolvedValue({ id: 'consent-123' });
      jest.spyOn(pool, 'transaction').mockImplementation(async (cb) => cb({}));
      jest.spyOn(vehicleRepository, 'createVehicle').mockResolvedValue({
        id: 'veh-123',
        partner_id: partnerId,
        shop_id: 'shop-abc',
        category: 'Car',
        brand: 'Maruti Suzuki',
        model: 'Swift',
        variant: null,
        registration_number: 'MP 04 AB 1234',
        year: 2023,
        fuel_type: 'Petrol',
        transmission: 'Manual',
        seats: 5,
        description: null,
        pickup_location: null,
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
        verification_status: 'VERIFIED',
        is_archived: false,
        offline_reason: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const res = await vehicleService.createVehicle({ partnerId, input });
      // A new vehicle is PENDING verification, and is created ONLINE so customers can immediately discover it.
      expect(vehicleRepository.createVehicle).toHaveBeenCalledWith(
        expect.objectContaining({ manualStatus: 'ONLINE', verificationStatus: 'PENDING' }),
        expect.anything(),
      );
      expect(res.id).toBe('veh-123');
      expect(res.registrationNumber).toBe('MP 04 AB 1234');
      expect(res.effectiveStatus).toBe('AVAILABLE');
      expect(res.shopId).toBe('shop-abc');
      expect(consentRepository.recordConsent).toHaveBeenCalled();
    });

    it('throws ConflictError if registration number already exists', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const input = {
        category: 'Car',
        brand: 'Honda',
        model: 'City',
        registrationNumber: 'MP 04 AB 1234',
        year: 2022,
        fuelType: 'Petrol',
        leaseAgreementAccepted: true,
      };

      jest.spyOn(vehicleRepository, 'findByRegistrationNumber')
        .mockResolvedValue({ id: 'existing-id' });

      await expect(
        vehicleService.createVehicle({ partnerId, input }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('getVehicles', () => {
    it('returns vehicles with pagination and computed effectiveStatus', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      jest.spyOn(vehicleRepository, 'findManyByPartnerId').mockResolvedValue([
        {
          id: 'v1',
          partner_id: partnerId,
          category: 'Bike',
          brand: 'Royal Enfield',
          model: 'Hunter 350',
          registration_number: 'MP04BK1111',
          manual_status: 'ONLINE',
          rental_status: 'IDLE',
          is_archived: false,
          cover_image_key: 'partners/img1.jpg',
        },
        {
          id: 'v2',
          partner_id: partnerId,
          category: 'Car',
          brand: 'Hyundai',
          model: 'i20',
          registration_number: 'MP04CR2222',
          manual_status: 'OFFLINE',
          rental_status: 'IDLE',
          is_archived: false,
          cover_image_key: null,
        },
      ]);
      jest.spyOn(vehicleRepository, 'countByPartnerId').mockResolvedValue(2);

      const res = await vehicleService.getVehicles({ partnerId, query: { page: 1, limit: 10 } });
      expect(res.vehicles).toHaveLength(2);
      expect(res.vehicles[0].effectiveStatus).toBe('AVAILABLE');
      expect(res.vehicles[1].effectiveStatus).toBe('UNAVAILABLE');
      expect(res.pagination.total).toBe(2);
      expect(res.pagination.totalPages).toBe(1);
    });
  });

  describe('getVehicleById', () => {
    it('returns full vehicle details with images and documents', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        category: 'Car',
        brand: 'Tata',
        model: 'Nexon',
        registration_number: 'MP04NX3333',
        manual_status: 'ONLINE',
        rental_status: 'BOOKED',
        is_archived: false,
      });

      jest.spyOn(vehicleRepository, 'getVehicleImages').mockResolvedValue([
        {
          id: 'img-1',
          vehicle_id: vehicleId,
          storage_key: 'partners/img1.jpg',
          image_url: 'partners/img1.jpg',
          sort_order: 0,
          is_cover: true,
          created_at: new Date().toISOString(),
        },
      ]);

      jest.spyOn(vehicleRepository, 'getVehicleDocuments').mockResolvedValue([
        {
          id: 'doc-1',
          vehicle_id: vehicleId,
          document_type: 'RC',
          document_name: 'RC',
          document_number: 'MP04NX3333',
          storage_key: 'partners/rc.pdf',
          verification_status: 'VERIFIED',
          is_required: true,
          version: 1,
          created_at: new Date().toISOString(),
        },
      ]);

      const res = await vehicleService.getVehicleById({ partnerId, vehicleId });
      expect(res.id).toBe(vehicleId);
      expect(res.effectiveStatus).toBe('BOOKED');
      expect(res.images).toHaveLength(1);
      expect(res.images[0].isCover).toBe(true);
      expect(res.documents).toHaveLength(1);
      expect(res.documents[0].documentType).toBe('RC');
    });

    it('throws NotFoundError if vehicle not found for partner (BOLA)', async () => {
      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue(null);

      await expect(
        vehicleService.getVehicleById({
          partnerId: 'partner-1',
          vehicleId: 'vehicle-other',
        }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateVehicleStatus', () => {
    it('updates status to OFFLINE with reason', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        manual_status: 'ONLINE',
        rental_status: 'IDLE',
        is_archived: false,
      });

      jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        manual_status: 'OFFLINE',
        rental_status: 'IDLE',
        offline_reason: 'Routine servicing',
        is_archived: false,
      });

      const res = await vehicleService.updateVehicleStatus({
        partnerId,
        vehicleId,
        input: { status: 'OFFLINE', reason: 'Routine servicing' },
      });

      expect(res.manualStatus).toBe('OFFLINE');
      expect(res.offlineReason).toBe('Routine servicing');
      expect(res.effectiveStatus).toBe('UNAVAILABLE');
    });

    it('throws ConflictError if rental_status is ACTIVE (trip in progress)', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        manual_status: 'ONLINE',
        rental_status: 'ACTIVE',
        is_archived: false,
      });

      await expect(
        vehicleService.updateVehicleStatus({
          partnerId,
          vehicleId,
          input: { status: 'OFFLINE' },
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('AD-2: rejects ONLINE for an admin-deactivated vehicle (is_active = false) without writing', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        manual_status: 'OFFLINE',
        rental_status: 'IDLE',
        verification_status: 'VERIFIED',
        is_archived: false,
        is_active: false,
      });
      const updateSpy = jest.spyOn(vehicleRepository, 'updateStatus');

      for (const input of [{ status: 'ONLINE' }, { manualStatus: 'ONLINE' }]) {
        await expect(
          vehicleService.updateVehicleStatus({ partnerId, vehicleId, input }),
        ).rejects.toThrow(/deactivated by admin/);
      }
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('AD-2: rejects when the guarded UPDATE matches no row (archived concurrently)', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        manual_status: 'OFFLINE',
        rental_status: 'IDLE',
        is_archived: false,
      });
      jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue(null);

      await expect(
        vehicleService.updateVehicleStatus({ partnerId, vehicleId, input: { status: 'OFFLINE' } }),
      ).rejects.toThrow(ConflictError);
    });

    describe('admin lifecycle states (state written by Admin block / deactivate)', () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';
      const base = {
        id: vehicleId,
        partner_id: partnerId,
        manual_status: 'OFFLINE',
        rental_status: 'IDLE',
        verification_status: 'VERIFIED',
      };

      it('admin BLOCK (OFFLINE, is_active=false, is_archived=false): partner ONLINE is refused with 409', async () => {
        jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
          ...base, is_active: false, is_archived: false,
        });
        jest.spyOn(vehicleService.partnerRepository, 'findById').mockResolvedValue({ kyc_status: 'VERIFIED' });
        const updateSpy = jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({ ...base });

        const err = await vehicleService
          .updateVehicleStatus({ partnerId, vehicleId, input: { manualStatus: 'ONLINE' } })
          .catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.statusCode).toBe(409);
        expect(err.message).toMatch(/blocked or deactivated by admin/);
        expect(updateSpy).not.toHaveBeenCalled();
      });

      it('admin BLOCK: partner may still keep/set the vehicle OFFLINE', async () => {
        jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
          ...base, is_active: false, is_archived: false,
        });
        jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({ ...base, is_archived: false });

        const res = await vehicleService.updateVehicleStatus({
          partnerId, vehicleId, input: { manualStatus: 'OFFLINE', offlineReason: 'Service' },
        });
        expect(res.manualStatus).toBe('OFFLINE');
      });

      it('admin DEACTIVATE (is_archived=true): partner ONLINE is refused with 409', async () => {
        jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
          ...base, is_active: false, is_archived: true,
        });
        const updateSpy = jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({ ...base });

        const err = await vehicleService
          .updateVehicleStatus({ partnerId, vehicleId, input: { manualStatus: 'ONLINE' } })
          .catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.statusCode).toBe(409);
        expect(updateSpy).not.toHaveBeenCalled();
      });

      it('admin ACTIVATE after block (is_active=true, is_archived=false): partner ONLINE is allowed again', async () => {
        jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
          ...base, is_active: true, is_archived: false,
        });
        jest.spyOn(vehicleService.partnerRepository, 'findById').mockResolvedValue({ kyc_status: 'VERIFIED' });
        jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({
          ...base, manual_status: 'ONLINE', is_archived: false,
        });

        const res = await vehicleService.updateVehicleStatus({
          partnerId, vehicleId, input: { manualStatus: 'ONLINE' },
        });
        expect(res.manualStatus).toBe('ONLINE');
      });

      it('blocked concurrently between read and guarded UPDATE (UPDATE matches no row) -> 409', async () => {
        jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
          ...base, is_active: true, is_archived: false,
        });
        jest.spyOn(vehicleService.partnerRepository, 'findById').mockResolvedValue({ kyc_status: 'VERIFIED' });
        jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue(null);

        await expect(
          vehicleService.updateVehicleStatus({ partnerId, vehicleId, input: { manualStatus: 'ONLINE' } }),
        ).rejects.toThrow(/blocked\/deactivated by admin/);
      });
    });

    describe('verification gate applies regardless of request key (status / manualStatus)', () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';
      const base = {
        id: vehicleId,
        partner_id: partnerId,
        manual_status: 'OFFLINE',
        rental_status: 'IDLE',
        is_archived: false,
        is_active: true,
      };
      const keys = [
        { status: 'ONLINE' },
        { manualStatus: 'ONLINE' },
        { manualStatus: 'online' },
        { status: ' Online ', reason: 'x' },
      ];

      it.each(['REJECTED', 'rejected'])(
        'refuses ONLINE with 409 for verification_status=%p via every accepted key, without writing',
        async (verificationStatus) => {
          jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
            ...base, verification_status: verificationStatus,
          });
          jest.spyOn(vehicleService.partnerRepository, 'findById').mockResolvedValue({ kyc_status: 'VERIFIED' });
          const updateSpy = jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({ ...base });

          for (const input of keys) {
            const err = await vehicleService
              .updateVehicleStatus({ partnerId, vehicleId, input })
              .catch((e) => e);
            expect(err).toBeInstanceOf(ConflictError);
            expect(err.statusCode).toBe(409);
            expect(err.message).toMatch(/rejected/i);
          }
          expect(updateSpy).not.toHaveBeenCalled();
        },
      );

      it.each(['', null, undefined])(
        'refuses ONLINE with 409 for missing verification_status=%p via every accepted key, without writing',
        async (verificationStatus) => {
          jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
            ...base, verification_status: verificationStatus,
          });
          jest.spyOn(vehicleService.partnerRepository, 'findById').mockResolvedValue({ kyc_status: 'VERIFIED' });
          const updateSpy = jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({ ...base });

          for (const input of keys) {
            const err = await vehicleService
              .updateVehicleStatus({ partnerId, vehicleId, input })
              .catch((e) => e);
            expect(err).toBeInstanceOf(ConflictError);
            expect(err.statusCode).toBe(409);
            expect(err.message).toMatch(/until verified and approved/);
          }
          expect(updateSpy).not.toHaveBeenCalled();
        },
      );

      it.each(['VERIFIED', 'verified', 'APPROVED', 'approved', 'PENDING', 'pending', 'UNDER_REVIEW', 'under_review'])(
        'allows ONLINE for an active, non-archived %s vehicle via the manualStatus key',
        async (verificationStatus) => {
          jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
            ...base, verification_status: verificationStatus,
          });
          jest.spyOn(vehicleService.partnerRepository, 'findById').mockResolvedValue({ kyc_status: 'VERIFIED' });
          const updateSpy = jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({
            ...base, verification_status: verificationStatus, manual_status: 'ONLINE',
          });

          const res = await vehicleService.updateVehicleStatus({
            partnerId, vehicleId, input: { manualStatus: 'ONLINE' },
          });
          expect(res.manualStatus).toBe('ONLINE');
          expect(updateSpy).toHaveBeenCalledWith(vehicleId, partnerId, 'ONLINE', null);
        },
      );

      it('still refuses ONLINE for a VERIFIED vehicle when partner KYC is not verified', async () => {
        jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
          ...base, verification_status: 'VERIFIED',
        });
        jest.spyOn(vehicleService.partnerRepository, 'findById').mockResolvedValue({ kyc_status: 'PENDING' });
        const updateSpy = jest.spyOn(vehicleRepository, 'updateStatus');

        await expect(
          vehicleService.updateVehicleStatus({ partnerId, vehicleId, input: { manualStatus: 'ONLINE' } }),
        ).rejects.toThrow(/partner KYC/);
        expect(updateSpy).not.toHaveBeenCalled();
      });

      it('a PENDING/REJECTED vehicle may still be set OFFLINE', async () => {
        jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
          ...base, manual_status: 'ONLINE', verification_status: 'REJECTED',
        });
        jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue({ ...base, verification_status: 'REJECTED' });

        const res = await vehicleService.updateVehicleStatus({
          partnerId, vehicleId, input: { manualStatus: 'OFFLINE' },
        });
        expect(res.manualStatus).toBe('OFFLINE');
      });

      it('admin rejects/blocks concurrently between read and write: guarded UPDATE returns no row -> 409, never silent success', async () => {
        jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
          ...base, verification_status: 'VERIFIED',
        });
        jest.spyOn(vehicleService.partnerRepository, 'findById').mockResolvedValue({ kyc_status: 'VERIFIED' });
        jest.spyOn(vehicleRepository, 'updateStatus').mockResolvedValue(null);

        const err = await vehicleService
          .updateVehicleStatus({ partnerId, vehicleId, input: { status: 'ONLINE' } })
          .catch((e) => e);
        expect(err).toBeInstanceOf(ConflictError);
        expect(err.statusCode).toBe(409);
        expect(err.message).toMatch(/not verified/);
      });
    });
  });

  describe('archiveVehicle', () => {
    it('archives an idle vehicle', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        rental_status: 'IDLE',
        is_archived: false,
        registration_number: 'MP04XX9999',
      });

      jest.spyOn(vehicleRepository, 'archiveVehicle').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        is_archived: true,
      });

      const res = await vehicleService.archiveVehicle({ partnerId, vehicleId });
      expect(res.message).toBe('Vehicle successfully archived');
    });

    it('rejects archiving when vehicle is BOOKED or ACTIVE', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({
        id: vehicleId,
        partner_id: partnerId,
        rental_status: 'BOOKED',
        is_archived: false,
      });

      await expect(
        vehicleService.archiveVehicle({ partnerId, vehicleId }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('images & documents management', () => {
    it('sets cover image successfully', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';
      const imageId = '33333333-3333-3333-3333-333333333333';

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId')
        .mockResolvedValue({ id: vehicleId, partner_id: partnerId });
      jest.spyOn(vehicleRepository, 'findVehicleImageById')
        .mockResolvedValue({ id: imageId, vehicle_id: vehicleId });
      jest.spyOn(vehicleRepository, 'setCoverImage').mockResolvedValue({
        id: imageId,
        vehicle_id: vehicleId,
        storage_key: 'key1.jpg',
        is_cover: true,
      });

      const res = await vehicleService.setCoverImage({ partnerId, vehicleId, imageId });
      expect(res.isCover).toBe(true);
    });

    it('deletes vehicle image and triggers s3 cleanup', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';
      const imageId = '33333333-3333-3333-3333-333333333333';

      jest.spyOn(vehicleRepository, 'findByIdAndPartnerId').mockResolvedValue({ id: vehicleId, partner_id: partnerId });
      jest.spyOn(vehicleRepository, 'findVehicleImageById').mockResolvedValue({
        id: imageId,
        vehicle_id: vehicleId,
        storage_key: 'partners/img.jpg',
      });
      jest.spyOn(vehicleRepository, 'deleteVehicleImage').mockResolvedValue({});
      const s3Spy = jest.spyOn(s3Provider, 'deleteObject').mockResolvedValue({});

      const res = await vehicleService.deleteVehicleImage({ partnerId, vehicleId, imageId });
      expect(res.message).toBe('Image successfully deleted');
      expect(s3Spy).toHaveBeenCalledWith({ key: 'partners/img.jpg' });
    });
  });

  describe('getVehicleRentalHistory', () => {
    it('returns rental history and trip statistics for a vehicle', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = '22222222-2222-2222-2222-222222222222';

      const mockHistoryData = {
        vehicle: {
          id: vehicleId,
          brand: 'Honda',
          model: 'Activa 6G',
          registrationNumber: 'DL01AB1234',
          manualStatus: 'AVAILABLE',
          rentalStatus: 'IDLE',
          totalTrips: 1,
          totalEarnings: 850.00,
        },
        history: [
          {
            id: 'booking-1',
            bookingNumber: 'BK-202610-001',
            status: 'COMPLETED',
            rentalStatus: 'COMPLETED',
            customerName: 'Aarav Patel',
            customerPhone: '+919876543210',
            startAt: '2026-10-01T08:00:00.000Z',
            expectedReturnAt: '2026-10-01T16:00:00.000Z',
            handoverAt: '2026-10-01T08:05:00.000Z',
            returnedAt: '2026-10-01T16:15:00.000Z',
            actualReturnAt: '2026-10-01T16:15:00.000Z',
            durationMinutes: 490,
            earnings: 850.00,
            earningsAmount: 850.00,
            totalDistance: 45,
            lateMinutes: 15,
            lateFee: 100.00,
          },
        ],
        bookings: [
          {
            id: 'booking-1',
            bookingNumber: 'BK-202610-001',
            status: 'COMPLETED',
            rentalStatus: 'COMPLETED',
            customerName: 'Aarav Patel',
            customerPhone: '+919876543210',
            startAt: '2026-10-01T08:00:00.000Z',
            expectedReturnAt: '2026-10-01T16:00:00.000Z',
            handoverAt: '2026-10-01T08:05:00.000Z',
            returnedAt: '2026-10-01T16:15:00.000Z',
            actualReturnAt: '2026-10-01T16:15:00.000Z',
            durationMinutes: 490,
            earnings: 850.00,
            earningsAmount: 850.00,
            totalDistance: 45,
            lateMinutes: 15,
            lateFee: 100.00,
          },
        ],
      };

      jest.spyOn(vehicleRepository, 'getVehicleRentalHistory').mockResolvedValue(mockHistoryData);

      const result = await vehicleService.getVehicleRentalHistory({ partnerId, vehicleId });
      expect(result.vehicle.id).toBe(vehicleId);
      expect(result.history).toHaveLength(1);
      expect(result.bookings).toHaveLength(1);
      expect(result.history[0].bookingNumber).toBe('BK-202610-001');
      expect(result.bookings[0].actualReturnAt).toBe('2026-10-01T16:15:00.000Z');
      expect(result.bookings[0].earningsAmount).toBe(850.00);
    });

    it('throws NotFoundError if vehicle not found for partner', async () => {
      const partnerId = '11111111-1111-1111-1111-111111111111';
      const vehicleId = 'non-existent-vehicle';

      jest.spyOn(vehicleRepository, 'getVehicleRentalHistory').mockResolvedValue(null);

      await expect(
        vehicleService.getVehicleRentalHistory({ partnerId, vehicleId }),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
