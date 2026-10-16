'use strict';

const AdminDamageService = require('../../src/services/admin-damage.service').constructor;
const { BadRequestError } = require('../../src/errors');

describe('Unit: AdminDamageService', () => {
  let mockDamageRepo;
  let adminDamageService;

  beforeEach(() => {
    mockDamageRepo = {
      findPaginated: jest.fn(),
      findById: jest.fn(),
      updateStatus: jest.fn(),
    };
    adminDamageService = new AdminDamageService(mockDamageRepo);
  });

  describe('listDamages', () => {
    it('returns paginated formatted damage reports', async () => {
      mockDamageRepo.findPaginated.mockResolvedValue({
        rows: [
          {
            id: 'dmg-1',
            booking_id: 'book-1',
            booking_number: 'BK-1001',
            vehicle_id: 'veh-1',
            registration_number: 'KA01AB1234',
            brand: 'Honda',
            model: 'Activa',
            damage_type: 'SCRATCH',
            description: 'Scratch on front bumper',
            estimated_amount: '500.00',
            approved_amount: null,
            status: 'REPORTED',
          },
        ],
        total: 1,
      });

      const result = await adminDamageService.listDamages({ page: 1, limit: 20 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('dmg-1');
      expect(result.items[0].estimatedAmount).toBe(500.00);
      expect(result.items[0].bookingNumber).toBe('BK-1001');
      expect(result.items[0].vehicle.registrationNumber).toBe('KA01AB1234');
    });
  });

  describe('markUnderReview', () => {
    it('moves status from REPORTED to UNDER_REVIEW', async () => {
      mockDamageRepo.findById.mockResolvedValue({
        id: 'dmg-1',
        status: 'REPORTED',
      });
      mockDamageRepo.updateStatus.mockResolvedValue({
        id: 'dmg-1',
        status: 'UNDER_REVIEW',
      });

      const res = await adminDamageService.markUnderReview('dmg-1');
      expect(res.status).toBe('UNDER_REVIEW');
      expect(mockDamageRepo.updateStatus).toHaveBeenCalledWith('dmg-1', { status: 'UNDER_REVIEW' });
    });

    it('rejects transition if not in REPORTED status', async () => {
      mockDamageRepo.findById.mockResolvedValue({
        id: 'dmg-1',
        status: 'APPROVED',
      });

      await expect(
        adminDamageService.markUnderReview('dmg-1'),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('approveDamage', () => {
    it('approves damage with approvedAmount', async () => {
      mockDamageRepo.findById.mockResolvedValue({
        id: 'dmg-1',
        status: 'UNDER_REVIEW',
      });
      mockDamageRepo.updateStatus.mockResolvedValue({
        id: 'dmg-1',
        status: 'APPROVED',
        approved_amount: '800.00',
      });

      const res = await adminDamageService.approveDamage('dmg-1', { approvedAmount: 800.00 });
      expect(res.status).toBe('APPROVED');
      expect(res.approvedAmount).toBe(800.00);
    });

    it('rejects approval if already SETTLED', async () => {
      mockDamageRepo.findById.mockResolvedValue({
        id: 'dmg-1',
        status: 'SETTLED',
      });

      await expect(
        adminDamageService.approveDamage('dmg-1', { approvedAmount: 800.00 }),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('rejectDamage', () => {
    it('rejects damage report', async () => {
      mockDamageRepo.findById.mockResolvedValue({
        id: 'dmg-1',
        status: 'REPORTED',
      });
      mockDamageRepo.updateStatus.mockResolvedValue({
        id: 'dmg-1',
        status: 'REJECTED',
      });

      const res = await adminDamageService.rejectDamage('dmg-1', { reason: 'Pre-existing scratch' });
      expect(res.status).toBe('REJECTED');
    });
  });

  describe('settleDamage', () => {
    it('settles approved damage report', async () => {
      mockDamageRepo.findById.mockResolvedValue({
        id: 'dmg-1',
        status: 'APPROVED',
        approved_amount: '800.00',
      });
      mockDamageRepo.updateStatus.mockResolvedValue({
        id: 'dmg-1',
        status: 'SETTLED',
        approved_amount: '800.00',
      });

      const res = await adminDamageService.settleDamage('dmg-1');
      expect(res.status).toBe('SETTLED');
    });

    it('rejects settlement if not in APPROVED status', async () => {
      mockDamageRepo.findById.mockResolvedValue({
        id: 'dmg-1',
        status: 'REPORTED',
      });

      await expect(
        adminDamageService.settleDamage('dmg-1'),
      ).rejects.toThrow(BadRequestError);
    });
  });
});
