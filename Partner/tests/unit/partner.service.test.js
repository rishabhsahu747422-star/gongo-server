'use strict';

const partnerService = require('../../src/services/partner.service');
const { NotFoundError, ForbiddenError } = require('../../src/errors');

describe('Unit: PartnerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getProfile', () => {
    it('returns full authoritative profile with derived completion flags', async () => {
      jest.spyOn(partnerService.partnerRepository, 'findById').mockResolvedValue({
        id: 'partner-123',
        partnerId: 'partner-123',
        userId: 'user-123',
        name: 'Vikram Sharma',
        phone: '9876543210',
        email: 'vikram@gongo.in',
        role: 'PARTNER',
        is_active: true,
        partner_status: 'OFFLINE',
        kyc_status: 'PENDING',
        rating: 5.0,
        review_count: 0,
        registered_since: 'Sep 2026',
        profile_image_url: null,
      });

      jest.spyOn(partnerService.shopRepository, 'findByPartnerId').mockResolvedValue({
        id: 'shop-123',
        partner_id: 'partner-123',
        shop_name: 'Apex Hub',
        shop_address: 'MP Nagar Zone 1',
        city: 'Bhopal',
        operating_info: '08:00 AM - 10:00 PM',
      });

      jest.spyOn(partnerService.partnerRepository, 'countVehicles').mockResolvedValue(0);

      const result = await partnerService.getProfile('partner-123');

      expect(result.user.name).toBe('Vikram Sharma');
      expect(result.user.phone).toBe('+91 9876543210');
      expect(result.partner.partnerStatus).toBe('OFFLINE');
      expect(result.partner.kycStatus).toBe('PENDING');
      expect(result.partner.isNewPartner).toBe(true);
      expect(result.completion.isProfileComplete).toBe(true);
      expect(result.completion.isShopComplete).toBe(true);
      expect(result.completion.isKycComplete).toBe(false);
    });

    it('derives isNewPartner as false when partner has listed vehicles', async () => {
      jest.spyOn(partnerService.partnerRepository, 'findById').mockResolvedValue({
        id: 'partner-123',
        partnerId: 'partner-123',
        userId: 'user-123',
        name: 'Vikram Sharma',
        phone: '9876543210',
        role: 'PARTNER',
        is_active: true,
        partner_status: 'ONLINE',
        kyc_status: 'VERIFIED',
      });

      jest.spyOn(partnerService.shopRepository, 'findByPartnerId').mockResolvedValue({
        shop_name: 'Apex Hub',
        shop_address: 'MP Nagar',
        city: 'Bhopal',
      });

      jest.spyOn(partnerService.partnerRepository, 'countVehicles').mockResolvedValue(5);

      const result = await partnerService.getProfile('partner-123');
      expect(result.partner.isNewPartner).toBe(false);
      expect(result.completion.isKycComplete).toBe(true);
    });

    it('throws NotFoundError if partner record does not exist', async () => {
      jest.spyOn(partnerService.partnerRepository, 'findById').mockResolvedValue(null);

      await expect(partnerService.getProfile('non-existent-id')).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError if partner account is deactivated', async () => {
      jest.spyOn(partnerService.partnerRepository, 'findById').mockResolvedValue({
        id: 'partner-deactivated',
        is_active: false,
      });

      await expect(partnerService.getProfile('partner-deactivated')).rejects.toThrow(ForbiddenError);
    });
  });

  describe('updateProfile', () => {
    it('throws NotFoundError when updating non-existent partner', async () => {
      jest.spyOn(partnerService.partnerRepository, 'findById').mockResolvedValue(null);

      await expect(
        partnerService.updateProfile('unknown', { name: 'Vikram' }),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
