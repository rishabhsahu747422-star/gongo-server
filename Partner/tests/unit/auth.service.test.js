'use strict';

const authService = require('../../src/services/auth.service');
const { ConflictError, NotFoundError, ForbiddenError, ValidationError } = require('../../src/errors');

describe('Unit: AuthService', () => {
  let mockUserRepo;
  let mockPartnerRepo;
  let mockShopRepo;
  let mockWalletRepo;

  beforeEach(() => {
    mockUserRepo = {
      findByPhone: jest.fn(),
      findByAuthId: jest.fn(),
      createUser: jest.fn(),
    };
    mockPartnerRepo = {
      findByAuthId: jest.fn(),
      findById: jest.fn(),
      createPartner: jest.fn(),
    };
    mockShopRepo = {
      findByPartnerId: jest.fn(),
      createShop: jest.fn(),
    };
    mockWalletRepo = {
      createWallet: jest.fn(),
    };

    authService.userRepository = mockUserRepo;
    authService.partnerRepository = mockPartnerRepo;
    authService.shopRepository = mockShopRepo;
    authService.walletRepository = mockWalletRepo;
  });

  describe('checkPhone', () => {
    it('returns isExisting: true when active partner exists with that phone', async () => {
      mockUserRepo.findByPhone.mockResolvedValue({
        id: 'u-1',
        role: 'PARTNER',
        phone: '9876543210',
        is_active: true,
      });

      const res = await authService.checkPhone({ phone: '+91 98765 43210' });
      expect(res.isExisting).toBe(true);
      expect(res.phone).toBe('9876543210');
      // Must not leak internal user ID or KYC details
      expect(res.id).toBeUndefined();
      expect(res.kycStatus).toBeUndefined();
    });

    it('returns isExisting: false when phone does not exist in DB', async () => {
      mockUserRepo.findByPhone.mockResolvedValue(null);

      const res = await authService.checkPhone({ phone: '9123456780' });
      expect(res.isExisting).toBe(false);
      expect(res.phone).toBe('9123456780');
    });

    it('returns isExisting: false when user exists but role is not PARTNER', async () => {
      mockUserRepo.findByPhone.mockResolvedValue({
        id: 'u-cust',
        role: 'CUSTOMER',
        phone: '9876543210',
        is_active: true,
      });

      const res = await authService.checkPhone({ phone: '9876543210' });
      expect(res.isExisting).toBe(false);
    });

    it('returns isExisting: false when partner user is deactivated', async () => {
      mockUserRepo.findByPhone.mockResolvedValue({
        id: 'u-1',
        role: 'PARTNER',
        phone: '9876543210',
        is_active: false,
      });

      const res = await authService.checkPhone({ phone: '9876543210' });
      expect(res.isExisting).toBe(false);
    });
  });

  describe('createSession', () => {
    it('returns isRegistered: false when partner does not exist in DB', async () => {
      mockPartnerRepo.findByAuthId.mockResolvedValue(null);

      const res = await authService.createSession({
        authUser: { authId: 'fb-new-uid', phone: '+919876543210', email: 'new@gongo.in' },
      });

      expect(res.isRegistered).toBe(false);
      expect(res.user.authId).toBe('fb-new-uid');
      expect(res.message).toBe('Partner registration required');
    });

    it('returns full authoritative partner profile when partner exists', async () => {
      mockPartnerRepo.findByAuthId.mockResolvedValue({
        partnerId: 'part-123',
        userId: 'user-123',
        auth_id: 'fb-uid-1',
        role: 'PARTNER',
        name: 'Vikram Sharma',
        phone: '9876543210',
        email: 'vikram@gongo.in',
        is_active: true,
        partner_status: 'ONLINE',
        kyc_status: 'VERIFIED',
        rating: 4.9,
        review_count: 42,
        registered_since: 'Nov 2024',
        profile_image_url: 'https://images.gongo.in/profile.jpg',
      });

      mockShopRepo.findByPartnerId.mockResolvedValue({
        shop_name: 'Apex Wheels',
        shop_address: 'MP Nagar, Bhopal',
        city: 'Bhopal',
        operating_info: '08:00 AM - 10:00 PM',
      });

      const res = await authService.createSession({
        authUser: { authId: 'fb-uid-1', role: 'PARTNER' },
      });

      expect(res.isRegistered).toBe(true);
      expect(res.partner.id).toBe('part-123');
      expect(res.partner.partnerStatus).toBe('ONLINE');
      expect(res.partner.kycStatus).toBe('VERIFIED');
      expect(res.partner.shopName).toBe('Apex Wheels');
      expect(res.partner.city).toBe('Bhopal');
      expect(res.session.authenticated).toBe(true);
    });

    it('throws ForbiddenError when partner account is deactivated', async () => {
      mockPartnerRepo.findByAuthId.mockResolvedValue({
        partnerId: 'part-deactivated',
        is_active: false,
      });

      await expect(
        authService.createSession({ authUser: { authId: 'fb-uid-deact' } }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('getMe', () => {
    it('throws NotFoundError when partner profile does not exist', async () => {
      mockPartnerRepo.findById.mockResolvedValue(null);

      await expect(
        authService.getMe({ partnerId: 'non-existent' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when partner account is inactive', async () => {
      mockPartnerRepo.findById.mockResolvedValue({
        id: 'part-inact',
        is_active: false,
      });

      await expect(
        authService.getMe({ partnerId: 'part-inact' }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('returns authoritative live database state without caching', async () => {
      mockPartnerRepo.findById.mockResolvedValue({
        id: 'part-123',
        partnerId: 'part-123',
        userId: 'user-123',
        name: 'Vikram Live',
        phone: '9876543210',
        email: 'vikram@gongo.in',
        role: 'PARTNER',
        is_active: true,
        partner_status: 'OFFLINE',
        kyc_status: 'UNDER_REVIEW',
        rating: 5.0,
        review_count: 0,
      });

      mockShopRepo.findByPartnerId.mockResolvedValue({
        shop_name: 'Live Shop',
        city: 'Indore',
      });

      const res = await authService.getMe({ partnerId: 'part-123' });
      expect(res.partner.kycStatus).toBe('UNDER_REVIEW');
      expect(res.partner.partnerStatus).toBe('OFFLINE');
      expect(res.partner.shopName).toBe('Live Shop');
    });
  });

  describe('registerPartner duplicate guards', () => {
    it('throws ConflictError if Supabase auth ID is already registered', async () => {
      mockUserRepo.findByAuthId.mockResolvedValue({ id: 'existing-user-id' });

      await expect(
        authService.registerPartner({
          authUser: { authId: 'fb-existing' },
          registrationData: { name: 'Test', phone: '9876543210', shopName: 'Shop', city: 'Bhopal' },
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws ConflictError if phone number is already registered to another partner', async () => {
      mockUserRepo.findByAuthId.mockResolvedValue(null);
      mockUserRepo.findByPhone.mockResolvedValue({ id: 'other-user-id' });

      await expect(
        authService.registerPartner({
          authUser: { authId: 'fb-new-uid' },
          registrationData: { name: 'Test', phone: '9876543210', shopName: 'Shop', city: 'Bhopal' },
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws ValidationError if valid 10-digit mobile number is missing', async () => {
      mockUserRepo.findByAuthId.mockResolvedValue(null);

      await expect(
        authService.registerPartner({
          authUser: { authId: 'fb-new-uid' },
          registrationData: { name: 'Test', shopName: 'Shop', city: 'Bhopal' },
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('logout', () => {
    it('successfully handles logout and returns success message', async () => {
      const res = await authService.logout({
        authUser: { authId: 'uid-123', partnerId: 'part-123' },
      });
      expect(res.message).toBe('Logged out successfully');
    });
  });
});
