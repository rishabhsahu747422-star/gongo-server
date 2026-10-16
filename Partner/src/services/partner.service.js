'use strict';

const PartnerRepository = require('../repositories/partner.repository');
const UserRepository = require('../repositories/user.repository');
const ShopRepository = require('../repositories/shop.repository');
const BankAccountRepository = require('../repositories/bank-account.repository');
const auditService = require('./audit.service');
const storageProvider = require('../providers/storage');
const RatingRepository = require('../repositories/rating.repository');
const db = require('../db/pool');
const { NotFoundError, ForbiddenError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { invalidateAuthCache } = require('../middlewares/auth');
const { resolveWorkingHoursFromRows, isOvernightSchedule, formatOperatingInfo } = require('../utils/working-hours');

const dashboardCache = new Map();
const DASHBOARD_CACHE_TTL_MS = 15000;

class PartnerService {
  constructor() {
    this.partnerRepository = new PartnerRepository();
    this.userRepository = new UserRepository();
    this.shopRepository = new ShopRepository();
    this.bankAccountRepository = new BankAccountRepository();
    this.ratingRepository = new RatingRepository();
  }

  /**
   * Retrieves full partner profile with derived completion status and business context.
   *
   * @param {string} partnerId Authenticated partner's ID
   * @returns {Promise<object>} Complete frontend profile contract
   */
  async getProfile(partnerId) {
    let partner;
    let shop = null;
    let vehicleCount = 0;
    let primaryBank = null;

    if (this.partnerRepository && typeof this.partnerRepository.getFullProfile === 'function') {
      const full = await this.partnerRepository.getFullProfile(partnerId);
      if (full) {
        partner = full.partner;
        shop = full.shop;
        vehicleCount = full.vehicleCount;
        primaryBank = full.primaryBank;
      }
    }

    if (!partner) {
      partner = await this.partnerRepository.findById(partnerId);

      if (!partner) {
        throw new NotFoundError('Partner account profile not found', ERROR_CODES.NOT_FOUND);
      }

      if (partner.is_active === false) {
        throw new ForbiddenError('Partner account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
      }

      const shopPromise = this.shopRepository
        && typeof this.shopRepository.findByPartnerId === 'function'
        ? this.shopRepository.findByPartnerId(partnerId).catch(() => null)
        : Promise.resolve(null);

      const vehiclePromise = this.partnerRepository
        && typeof this.partnerRepository.countVehicles === 'function'
        ? this.partnerRepository.countVehicles(partnerId).catch(() => 0)
        : Promise.resolve(0);

      const bankPromise = this.bankAccountRepository
        && typeof this.bankAccountRepository.findPrimaryByPartnerId === 'function'
        ? this.bankAccountRepository.findPrimaryByPartnerId(partnerId).catch(() => null)
        : Promise.resolve(null);

      const [resShop, resVehCount, resBank] = await Promise.all([
        shopPromise,
        vehiclePromise,
        bankPromise,
      ]);

      shop = resShop;
      vehicleCount = resVehCount;
      primaryBank = resBank;
    } else if (partner.is_active === false) {
      throw new ForbiddenError('Partner account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    const bankAccount = primaryBank ? {
      id: primaryBank.id,
      bankName: primaryBank.bank_name,
      accountHolderName: primaryBank.account_holder_name,
      accountNumberMasked: primaryBank.account_number_masked,
      ifscCode: primaryBank.ifsc_code,
      isPrimary: primaryBank.is_primary,
      verificationStatus: primaryBank.verification_status,
    } : null;

    // Derive profile and onboarding completion state from canonical persistent state
    const businessName = partner.business_name || (shop ? shop.shop_name : null);
    const businessAddress = partner.business_address || (shop ? shop.shop_address : null);
    const landmark = partner.landmark || (shop ? shop.landmark : null);
    const city = partner.city || (shop ? shop.city : null);
    const area = partner.area || partner.locality || (shop ? (shop.area || shop.locality) : null) || null;
    let latitude = null;
    if (partner.latitude !== null && partner.latitude !== undefined) {
      latitude = Number(partner.latitude);
    } else if (shop && shop.latitude !== null && shop.latitude !== undefined) {
      latitude = Number(shop.latitude);
    }

    let longitude = null;
    if (partner.longitude !== null && partner.longitude !== undefined) {
      longitude = Number(partner.longitude);
    } else if (shop && shop.longitude !== null && shop.longitude !== undefined) {
      longitude = Number(shop.longitude);
    }

    const locationAccuracy = (partner.location_accuracy !== null && partner.location_accuracy !== undefined)
      ? Number(partner.location_accuracy)
      : ((shop && shop.location_accuracy !== null && shop.location_accuracy !== undefined) ? Number(shop.location_accuracy) : null);
    const locationSource = partner.location_source || (shop ? shop.location_source : null) || null;

    const workingHoursInfo = resolveWorkingHoursFromRows(partner, shop);
    const operatingInfo = workingHoursInfo.operatingInfo;

    const isProfileComplete = Boolean(partner.name && partner.phone);
    const isBusinessComplete = Boolean(businessName && businessAddress && city);
    const isKycComplete = partner.kyc_status === 'VERIFIED';

    const ratingSummary = await this.ratingRepository.getPartnerSummary(partnerId).catch(() => null);
    const ratingVal = ratingSummary && ratingSummary.totalReviews > 0
      ? ratingSummary.averageRating
      : null;
    const reviewCount = ratingSummary ? ratingSummary.totalReviews : 0;

    let profileImageUrl = partner.profile_image_url || null;
    if (profileImageUrl) {
      profileImageUrl = (await storageProvider.resolveSignedUrl(profileImageUrl)) || profileImageUrl;
    }

    return {
      user: {
        id: partner.userId,
        name: partner.name,
        phone: partner.phone ? `+91 ${partner.phone}` : null,
        email: partner.email,
        role: partner.role,
        isActive: partner.is_active,
      },
      partner: {
        id: partner.partnerId || partner.id,
        name: partner.name,
        phone: partner.phone ? `+91 ${partner.phone}` : null,
        email: partner.email,
        partnerStatus: partner.partner_status,
        kycStatus: partner.kyc_status,
        rating: ratingVal,
        averageRating: ratingVal,
        reviewCount,
        totalReviews: reviewCount,
        registeredSince: partner.registered_since,
        profileImage: profileImageUrl,
        businessName,
        businessAddress,
        landmark,
        city,
        area,
        locality: area,
        latitude,
        longitude,
        locationAccuracy,
        locationSource,
        operatingInfo,
        openingTime: workingHoursInfo.openingTime,
        closingTime: workingHoursInfo.closingTime,
        isOpen24Hours: workingHoursInfo.isOpen24Hours,
        workingHours: workingHoursInfo.workingHours,
        // Legacy frontend backward-compatibility aliases:
        shopName: businessName,
        shopAddress: businessAddress,
        shopLandmark: landmark,
        bankAccount,
        isNewPartner: vehicleCount === 0,
      },
      completion: {
        isProfileComplete,
        isBusinessComplete,
        isShopComplete: isBusinessComplete, // Alias for frontend
        isKycComplete,
      },
    };
  }

  /**
   * Atomically updates partner, user, and business profile details.
   * Enforces that phone and server-controlled status flags remain immutable.
   *
   * @param {string} partnerId Authenticated partner's ID
   * @param {object} updates Validated updates from PartnerValidator
   * @param {string} [requestId] Correlation Request ID
   * @returns {Promise<object>} Updated authoritative profile
   */
  async updateProfile(partnerId, updates, requestId = null) {
    const partner = await this.partnerRepository.findById(partnerId);

    if (!partner) {
      throw new NotFoundError('Partner account profile not found', ERROR_CODES.NOT_FOUND);
    }

    if (partner.is_active === false) {
      throw new ForbiddenError('Partner account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    await db.transaction(async (client) => {
      // 1. Update user fields (name, email)
      if (updates.name !== undefined || updates.email !== undefined) {
        await this.userRepository.updateUser(
          partner.userId,
          {
            name: updates.name,
            email: updates.email,
          },
          client,
        );
      }

      // 2. Update canonical partner record (profile image, business details, location, working hours)
      const partnerUpdates = {};
      if (updates.profileImageUrl !== undefined) {
        partnerUpdates.profileImageUrl = updates.profileImageUrl;
      }

      const businessName = updates.businessName !== undefined
        ? updates.businessName
        : updates.shopName;
      if (businessName !== undefined) {
        partnerUpdates.businessName = businessName;
      }

      const businessAddress = updates.businessAddress !== undefined
        ? updates.businessAddress
        : updates.shopAddress;
      if (businessAddress !== undefined) {
        partnerUpdates.businessAddress = businessAddress;
      }

      if (updates.landmark !== undefined) {
        partnerUpdates.landmark = updates.landmark;
      }

      if (updates.city !== undefined) partnerUpdates.city = updates.city;
      if (updates.area !== undefined) partnerUpdates.area = updates.area;
      if (updates.locality !== undefined) partnerUpdates.locality = updates.locality;
      if (updates.latitude !== undefined) partnerUpdates.latitude = updates.latitude;
      if (updates.longitude !== undefined) partnerUpdates.longitude = updates.longitude;
      if (updates.locationAccuracy !== undefined) partnerUpdates.locationAccuracy = updates.locationAccuracy;
      if (updates.locationSource !== undefined) partnerUpdates.locationSource = updates.locationSource;
      if (updates.isOpen24Hours === true) {
        partnerUpdates.isOpen24Hours = true;
        partnerUpdates.openingTime = null;
        partnerUpdates.closingTime = null;
        partnerUpdates.operatingInfo = 'Open 24 Hours';
      } else {
        if (updates.isOpen24Hours !== undefined) partnerUpdates.isOpen24Hours = updates.isOpen24Hours;
        if (updates.openingTime !== undefined) partnerUpdates.openingTime = updates.openingTime;
        if (updates.closingTime !== undefined) partnerUpdates.closingTime = updates.closingTime;
        if (updates.operatingInfo !== undefined) {
          partnerUpdates.operatingInfo = updates.operatingInfo;
        } else if (updates.openingTime && updates.closingTime) {
          const isOvernight = isOvernightSchedule(updates.openingTime, updates.closingTime);
          partnerUpdates.operatingInfo = `${updates.openingTime} - ${updates.closingTime}${isOvernight ? ' (Next Day)' : ''}`;
        }
      }

      if (Object.keys(partnerUpdates).length > 0) {
        await this.partnerRepository.updatePartner(partnerId, partnerUpdates, client);
      }

      // 3. Keep legacy shops table synchronized for backward compatibility
      const hasShopUpdates = updates.shopName !== undefined
        || updates.businessName !== undefined
        || updates.shopAddress !== undefined
        || updates.businessAddress !== undefined
        || updates.landmark !== undefined
        || updates.city !== undefined
        || updates.area !== undefined
        || updates.locality !== undefined
        || updates.latitude !== undefined
        || updates.longitude !== undefined
        || updates.locationAccuracy !== undefined
        || updates.locationSource !== undefined
        || updates.operatingInfo !== undefined
        || updates.openingTime !== undefined
        || updates.closingTime !== undefined
        || updates.isOpen24Hours !== undefined;

      if (hasShopUpdates) {
        await this.shopRepository.updateShop(
          partnerId,
          {
            shopName: businessName,
            shopAddress: businessAddress,
            landmark: updates.landmark,
            city: updates.city,
            area: updates.area,
            locality: updates.locality,
            latitude: updates.latitude,
            longitude: updates.longitude,
            locationAccuracy: updates.locationAccuracy,
            locationSource: updates.locationSource,
            operatingInfo: partnerUpdates.operatingInfo !== undefined ? partnerUpdates.operatingInfo : updates.operatingInfo,
            openingTime: partnerUpdates.openingTime !== undefined ? partnerUpdates.openingTime : updates.openingTime,
            closingTime: partnerUpdates.closingTime !== undefined ? partnerUpdates.closingTime : updates.closingTime,
            isOpen24Hours: partnerUpdates.isOpen24Hours !== undefined ? partnerUpdates.isOpen24Hours : updates.isOpen24Hours,
          },
          client,
        );
      }
    });

    // 4. Invalidate auth cache so changes reflect immediately
    invalidateAuthCache(partnerId);

    // 5. Audit profile modification
    auditService.logEvent({
      actorId: partnerId,
      actorRole: 'PARTNER',
      action: 'PARTNER_PROFILE_UPDATED',
      entityType: 'PARTNER',
      entityId: partnerId,
      requestId,
      metadata: {
        updatedFields: Object.keys(updates),
      },
    });

    return this.getProfile(partnerId);
  }

  /**
   * Clears dashboard cache for a specific partner or all partners.
   *
   * @param {string|null} [partnerId]
   */
  invalidateDashboardCache(partnerId = null) {
    if (partnerId) {
      dashboardCache.delete(partnerId);
    } else {
      dashboardCache.clear();
    }
  }

  /**
   * Retrieves aggregated dashboard statistics for authenticated partner.
   *
   * @param {string} partnerId Authenticated partner's ID
   * @returns {Promise<object>} Dashboard metrics and active alerts
   */
  async getDashboardStats(partnerId) {
    if (!partnerId) {
      throw new NotFoundError('Partner account profile not found', ERROR_CODES.NOT_FOUND);
    }

    if (process.env.NODE_ENV !== 'test') {
      const cached = dashboardCache.get(partnerId);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.stats;
      }
    }

    const partner = await this.partnerRepository.findById(partnerId);

    if (!partner) {
      throw new NotFoundError('Partner account profile not found', ERROR_CODES.NOT_FOUND);
    }

    if (partner.is_active === false) {
      throw new ForbiddenError('Partner account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    const stats = await this.partnerRepository.getDashboardStats(partnerId);

    if (process.env.NODE_ENV !== 'test') {
      dashboardCache.set(partnerId, {
        stats,
        expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS,
      });
    }

    return stats;
  }
}

const partnerServiceInstance = new PartnerService();
module.exports = partnerServiceInstance;
module.exports.invalidateDashboardCache = partnerServiceInstance.invalidateDashboardCache.bind(partnerServiceInstance);
