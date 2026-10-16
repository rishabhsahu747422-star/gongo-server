'use strict';

const crypto = require('crypto');
const UserRepository = require('../repositories/user.repository');
const PartnerRepository = require('../repositories/partner.repository');
const ShopRepository = require('../repositories/shop.repository');
const WalletRepository = require('../repositories/wallet.repository');
const BankAccountRepository = require('../repositories/bank-account.repository');
const RatingRepository = require('../repositories/rating.repository');
const db = require('../db/pool');
const env = require('../config/env');
const logger = require('../config/logger');
const { getSupabaseAuth } = require('../providers/supabase');
const storageProvider = require('../providers/storage');
const auditService = require('./audit.service');
const {
  ConflictError,
  NotFoundError,
  ForbiddenError,
  ValidationError,
  UnauthorizedError,
} = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { resolveWorkingHoursFromRows, formatOperatingInfo } = require('../utils/working-hours');
const consentRepository = require('../repositories/consent.repository');
const { DOCUMENT_TYPES, LEGAL_DOCUMENTS } = require('../constants/legal.constants');

class AuthService {
  constructor() {
    this.userRepository = new UserRepository();
    this.partnerRepository = new PartnerRepository();
    this.shopRepository = new ShopRepository();
    this.walletRepository = new WalletRepository();
    this.bankAccountRepository = new BankAccountRepository();
    this.ratingRepository = new RatingRepository();
  }

  /**
   * Check whether a phone number belongs to an existing active partner.
   * Minimal data returned to prevent account enumeration.
   *
   * @param {object} params
   * @param {string} params.phone
   * @returns {Promise<{ isExisting: boolean, phone: string }>}
   */
  async checkPhone({ phone }) {
    const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);
    const user = await this.userRepository.findByPhone(cleanPhone);

    const isExisting = Boolean(user && user.is_active && String(user.role || '').toUpperCase() === 'PARTNER');

    return {
      isExisting,
      phone: cleanPhone,
    };
  }

  /**
   * Authoritative session creation / exchange from verified Supabase user.
   *
   * @param {object} params
   * @param {object} params.authUser
   * @param {string} [params.requestId]
   * @returns {Promise<object>}
   */
  async createSession({ authUser, requestId = null }) {
    const authId = authUser.authId || authUser.uid;
    const partner = await this.partnerRepository.findByAuthId(authId);

    // Case A: Partner does not exist in DB yet -> Registration required
    if (!partner || !partner.partnerId) {
      return {
        isRegistered: false,
        user: {
          authId,
          phone: authUser.phone || null,
          email: authUser.email || null,
        },
        message: 'Partner registration required',
      };
    }

    // Case B: Partner exists -> verify active status
    if (partner.is_active === false) {
      throw new ForbiddenError('Partner account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    const shopPromise = this.shopRepository
      && typeof this.shopRepository.findByPartnerId === 'function'
      ? this.shopRepository.findByPartnerId(partner.partnerId).catch(() => null)
      : Promise.resolve(null);

    const bankPromise = this.bankAccountRepository
      && typeof this.bankAccountRepository.findPrimaryByPartnerId === 'function'
      ? this.bankAccountRepository.findPrimaryByPartnerId(partner.partnerId).catch(() => null)
      : Promise.resolve(null);

    const vehiclePromise = this.partnerRepository
      && typeof this.partnerRepository.countVehicles === 'function'
      ? this.partnerRepository.countVehicles(partner.partnerId).catch(() => 0)
      : Promise.resolve(0);

    const ratingPromise = this.ratingRepository
      && typeof this.ratingRepository.getPartnerSummary === 'function'
      ? this.ratingRepository.getPartnerSummary(partner.partnerId).catch(() => null)
      : Promise.resolve(null);

    const [shop, primaryBank, vehicleCount, ratingSummary] = await Promise.all([
      shopPromise,
      bankPromise,
      vehiclePromise,
      ratingPromise,
    ]);

    const bankAccount = primaryBank ? {
      id: primaryBank.id,
      bankName: primaryBank.bank_name,
      accountHolderName: primaryBank.account_holder_name,
      accountNumberMasked: primaryBank.account_number_masked,
      ifscCode: primaryBank.ifsc_code,
      isPrimary: primaryBank.is_primary,
      verificationStatus: primaryBank.verification_status,
    } : null;

    auditService.logEvent({
      actorId: partner.partnerId,
      actorRole: 'PARTNER',
      action: 'AUTH_SESSION_CREATED',
      entityType: 'PARTNER',
      entityId: partner.partnerId,
      requestId,
      metadata: {
        authId,
        role: partner.role,
        kycStatus: partner.kyc_status,
      },
    });

    const reviewCount = ratingSummary && ratingSummary.totalReviews > 0
      ? ratingSummary.totalReviews
      : Number(partner.review_count || 0);

    const ratingVal = ratingSummary && ratingSummary.totalReviews > 0
      ? ratingSummary.averageRating
      : (partner.rating !== null && partner.rating !== undefined ? Number(partner.rating) : 5.0);

    let profileImageUrl = partner.profile_image_url || null;
    if (profileImageUrl) {
      profileImageUrl = (await storageProvider.resolveSignedUrl(profileImageUrl)) || profileImageUrl;
    }

    const shopName = (shop && shop.shop_name) || partner.business_name || null;
    const shopAddress = (shop && shop.shop_address) || partner.business_address || null;
    const landmark = (shop && shop.landmark) || partner.landmark || null;
    const city = (shop && shop.city) || partner.city || null;
    const area = (shop && (shop.area || shop.locality)) || partner.area || partner.locality || null;
    const latitude = (partner.latitude !== null && partner.latitude !== undefined)
      ? Number(partner.latitude)
      : ((shop && shop.latitude !== null && shop.latitude !== undefined) ? Number(shop.latitude) : null);
    const longitude = (partner.longitude !== null && partner.longitude !== undefined)
      ? Number(partner.longitude)
      : ((shop && shop.longitude !== null && shop.longitude !== undefined) ? Number(shop.longitude) : null);
    const locationAccuracy = (partner.location_accuracy !== null && partner.location_accuracy !== undefined)
      ? Number(partner.location_accuracy)
      : ((shop && shop.location_accuracy !== null && shop.location_accuracy !== undefined) ? Number(shop.location_accuracy) : null);
    const locationSource = partner.location_source || (shop ? shop.location_source : null) || null;
    const workingHoursInfo = resolveWorkingHoursFromRows(partner, shop);

    return {
      isRegistered: true,
      user: {
        id: partner.userId,
        name: partner.name || null,
        phone: partner.phone ? `+91 ${partner.phone}` : null,
        email: partner.email || null,
        role: partner.role,
        isActive: partner.is_active,
      },
      partner: {
        id: partner.partnerId,
        name: partner.name || null,
        phone: partner.phone ? `+91 ${partner.phone}` : null,
        email: partner.email || null,
        partnerStatus: partner.partner_status,
        kycStatus: partner.kyc_status,
        rating: ratingVal,
        averageRating: ratingVal,
        reviewCount,
        totalReviews: reviewCount,
        registeredSince: partner.registered_since || null,
        profileImage: profileImageUrl,
        shopName,
        businessName: shopName,
        shopAddress,
        businessAddress: shopAddress,
        landmark,
        city,
        area,
        locality: area,
        latitude,
        longitude,
        locationAccuracy,
        locationSource,
        operatingInfo: workingHoursInfo.operatingInfo,
        openingTime: workingHoursInfo.openingTime,
        closingTime: workingHoursInfo.closingTime,
        isOpen24Hours: workingHoursInfo.isOpen24Hours,
        workingHours: workingHoursInfo.workingHours,
        bankAccount,
        isNewPartner: vehicleCount === 0,
      },
      session: {
        authenticated: true,
        authProvider: 'supabase',
      },
    };
  }

  /**
   * First-time Partner atomic onboarding / registration.
   * Creates users (PARTNER), partners, shops, and wallets in a single transaction.
   *
   * @param {object} params
   * @param {object} params.authUser Verified Supabase token identity
   * @param {object} params.registrationData
   * @param {string} [params.requestId]
   * @returns {Promise<object>}
   */
  async registerPartner({ authUser, registrationData, requestId = null }) {
    const authId = authUser.authId || authUser.uid;

    // 1. Check if user already exists with this Supabase auth ID
    const existingAuthUser = await this.userRepository.findByAuthId(authId);
    if (existingAuthUser) {
      throw new ConflictError('Partner account already registered for this authentication identity', ERROR_CODES.CONFLICT);
    }

    // 2. Resolve authoritative phone number
    // If Supabase claim has verified phone, use it; otherwise use validated registration phone
    let phoneToUse = null;
    if (authUser.phone) {
      phoneToUse = String(authUser.phone).replace(/[^0-9]/g, '').slice(-10);
    } else if (registrationData.phone) {
      phoneToUse = String(registrationData.phone).replace(/[^0-9]/g, '').slice(-10);
    }

    if (!phoneToUse || phoneToUse.length !== 10) {
      throw new ValidationError('A valid 10-digit mobile number is required for partner registration', {
        field: 'phone',
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }

    // Check if phone number is already associated with another user
    const existingPhoneUser = await this.userRepository.findByPhone(phoneToUse);
    if (existingPhoneUser) {
      throw new ConflictError('Mobile number already registered to another partner', ERROR_CODES.DUPLICATE_RESOURCE);
    }

    let emailToUse = null;
    if (registrationData.email) {
      emailToUse = registrationData.email.trim().toLowerCase();
    } else if (authUser.email) {
      emailToUse = authUser.email.trim().toLowerCase();
    }

    const rawArea = registrationData.area !== undefined ? registrationData.area : registrationData.locality;
    const areaToUse = rawArea ? String(rawArea).trim() : null;
    const latToUse = (registrationData.latitude !== undefined && registrationData.latitude !== null && registrationData.latitude !== '')
      ? Number(registrationData.latitude)
      : null;
    const lngToUse = (registrationData.longitude !== undefined && registrationData.longitude !== null && registrationData.longitude !== '')
      ? Number(registrationData.longitude)
      : null;
    const accToUse = (registrationData.locationAccuracy !== undefined && registrationData.locationAccuracy !== null && registrationData.locationAccuracy !== '')
      ? Number(registrationData.locationAccuracy)
      : null;
    const srcToUse = registrationData.locationSource
      || (latToUse !== null && lngToUse !== null ? 'GPS' : null);

    const whObj = registrationData.workingHours && typeof registrationData.workingHours === 'object'
      ? registrationData.workingHours
      : null;
    const isOpen24Hours = Boolean(
      registrationData.isOpen24Hours !== undefined
        ? registrationData.isOpen24Hours
        : (whObj && whObj.isOpen24Hours),
    );
    const openingTime = isOpen24Hours
      ? null
      : (registrationData.openingTime || (whObj && whObj.openingTime) || null);
    const closingTime = isOpen24Hours
      ? null
      : (registrationData.closingTime || (whObj && whObj.closingTime) || null);
    const operatingInfo = registrationData.operatingInfo
      || formatOperatingInfo({ openingTime, closingTime, isOpen24Hours })
      || '08:00 AM - 10:00 PM (All Days)';

    // 3. Execute atomic creation transaction
    let created;
    try {
      created = await db.transaction(async (client) => {
        // Step A: Create User
        const user = await this.userRepository.createUser({
          authId,
          authProvider: 'supabase',
          role: 'PARTNER',
          name: registrationData.name,
          phone: phoneToUse,
          email: emailToUse,
          isActive: true,
        }, client);

        // Step B: Create Partner
        const partner = await this.partnerRepository.createPartner({
          userId: user.id,
          businessName: registrationData.shopName,
          businessAddress: registrationData.shopAddress,
          landmark: registrationData.landmark ? registrationData.landmark.trim() : null,
          city: registrationData.city,
          area: areaToUse,
          locality: areaToUse,
          latitude: latToUse,
          longitude: lngToUse,
          locationAccuracy: accToUse,
          locationSource: srcToUse,
          operatingInfo,
          openingTime,
          closingTime,
          isOpen24Hours,
          partnerStatus: 'OFFLINE',
          kycStatus: 'PENDING',
          registeredSince: new Date().toLocaleString('en-IN', { month: 'short', year: 'numeric' }),
          isActive: true,
        }, client);

        // Step C: Create Shop
        const shop = await this.shopRepository.createShop({
          partnerId: partner.id,
          shopName: registrationData.shopName,
          shopAddress: registrationData.shopAddress,
          landmark: registrationData.landmark ? registrationData.landmark.trim() : null,
          city: registrationData.city,
          area: areaToUse,
          locality: areaToUse,
          latitude: latToUse,
          longitude: lngToUse,
          locationAccuracy: accToUse,
          locationSource: srcToUse,
          operatingInfo,
          openingTime,
          closingTime,
          isOpen24Hours,
          isActive: true,
        }, client);

        // Step D: Initialize Partner Wallet (0.00 balance)
        await this.walletRepository.createWallet(partner.id, client);

        // Step D.2: Record Immutable Consent for GONGO Terms & Conditions
        await consentRepository.recordConsent({
          userId: user.id,
          partnerId: partner.id,
          documentType: DOCUMENT_TYPES.GONGO_TERMS,
          documentVersion: LEGAL_DOCUMENTS.GONGO_TERMS.version,
          contentHash: LEGAL_DOCUMENTS.GONGO_TERMS.contentHash,
          ipAddress: authUser.ip || null,
          userAgent: authUser.userAgent || null,
          metadata: {
            source: 'partner_registration',
            registrationPhone: phoneToUse,
            shopName: registrationData.shopName,
          },
          client,
        });

        return { user, partner, shop };
      });
    } catch (txErr) {
      if (txErr.code === '23505') {
        throw new ConflictError('Mobile number or account already registered to another partner', ERROR_CODES.DUPLICATE_RESOURCE);
      }
      throw txErr;
    }

    // Step E: Emit security audit log
    auditService.logEvent({
      actorId: created.partner.id,
      actorRole: 'PARTNER',
      action: 'PARTNER_REGISTERED',
      entityType: 'PARTNER',
      entityId: created.partner.id,
      requestId,
      metadata: {
        userId: created.user.id,
        authId,
        phone: phoneToUse,
        shopName: created.shop.shop_name,
        city: created.shop.city,
      },
    });

    const regRatingVal = (created.partner.rating !== null && created.partner.rating !== undefined)
      ? Number(created.partner.rating)
      : 5.0;

    const workingHoursInfo = resolveWorkingHoursFromRows(created.partner, created.shop);
    const savedArea = created.shop.area || created.partner.area || areaToUse || null;
    const savedLat = (created.shop.latitude !== null && created.shop.latitude !== undefined)
      ? Number(created.shop.latitude)
      : ((created.partner.latitude !== null && created.partner.latitude !== undefined) ? Number(created.partner.latitude) : latToUse);
    const savedLng = (created.shop.longitude !== null && created.shop.longitude !== undefined)
      ? Number(created.shop.longitude)
      : ((created.partner.longitude !== null && created.partner.longitude !== undefined) ? Number(created.partner.longitude) : lngToUse);

    return {
      isRegistered: true,
      user: {
        id: created.user.id,
        name: created.user.name,
        phone: `+91 ${created.user.phone}`,
        email: created.user.email,
        role: created.user.role,
        isActive: created.user.is_active,
      },
      partner: {
        id: created.partner.id,
        name: created.user.name,
        phone: `+91 ${created.user.phone}`,
        email: created.user.email,
        partnerStatus: created.partner.partner_status,
        kycStatus: created.partner.kyc_status,
        rating: regRatingVal,
        reviewCount: created.partner.review_count || 0,
        registeredSince: created.partner.registered_since,
        profileImage: created.partner.profile_image_url || null,
        shopName: created.shop.shop_name,
        businessName: created.shop.shop_name,
        shopAddress: created.shop.shop_address,
        businessAddress: created.shop.shop_address,
        landmark: created.shop.landmark || created.partner.landmark || (registrationData.landmark ? registrationData.landmark.trim() : null),
        city: created.shop.city,
        area: savedArea,
        locality: savedArea,
        latitude: savedLat,
        longitude: savedLng,
        locationAccuracy: accToUse,
        locationSource: srcToUse,
        operatingInfo: workingHoursInfo.operatingInfo || created.shop.operating_info,
        openingTime: workingHoursInfo.openingTime,
        closingTime: workingHoursInfo.closingTime,
        isOpen24Hours: workingHoursInfo.isOpen24Hours,
        workingHours: workingHoursInfo.workingHours,
        bankAccount: null,
        isNewPartner: true,
      },
      session: {
        authenticated: true,
        authProvider: 'supabase',
      },
    };
  }

  /**
   * Resolves current, live, authoritative profile from PostgreSQL.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.partnerId
   * @returns {Promise<object>}
   */
  async getMe({ userId, partnerId }) {
    const targetId = partnerId || userId;
    const partner = await this.partnerRepository.findById(targetId);

    if (!partner) {
      throw new NotFoundError('Partner account profile not found', ERROR_CODES.NOT_FOUND);
    }

    if (partner.is_active === false) {
      throw new ForbiddenError('Partner account has been deactivated', ERROR_CODES.ACCOUNT_DEACTIVATED);
    }

    const effectivePartnerId = partner.partnerId || partner.id;
    const shopPromise = this.shopRepository
      && typeof this.shopRepository.findByPartnerId === 'function'
      ? this.shopRepository.findByPartnerId(effectivePartnerId).catch(() => null)
      : Promise.resolve(null);

    const bankPromise = this.bankAccountRepository
      && typeof this.bankAccountRepository.findPrimaryByPartnerId === 'function'
      ? this.bankAccountRepository.findPrimaryByPartnerId(effectivePartnerId).catch(() => null)
      : Promise.resolve(null);

    const vehiclePromise = this.partnerRepository
      && typeof this.partnerRepository.countVehicles === 'function'
      ? this.partnerRepository.countVehicles(effectivePartnerId).catch(() => 0)
      : Promise.resolve(0);

    const ratingPromise = this.ratingRepository
      && typeof this.ratingRepository.getPartnerSummary === 'function'
      ? this.ratingRepository.getPartnerSummary(effectivePartnerId).catch(() => null)
      : Promise.resolve(null);

    const [shop, primaryBank, vehicleCount, ratingSummary] = await Promise.all([
      shopPromise,
      bankPromise,
      vehiclePromise,
      ratingPromise,
    ]);

    const bankAccount = primaryBank ? {
      id: primaryBank.id,
      bankName: primaryBank.bank_name,
      accountHolderName: primaryBank.account_holder_name,
      accountNumberMasked: primaryBank.account_number_masked,
      ifscCode: primaryBank.ifsc_code,
      isPrimary: primaryBank.is_primary,
      verificationStatus: primaryBank.verification_status,
    } : null;

    const reviewCount = ratingSummary && ratingSummary.totalReviews > 0
      ? ratingSummary.totalReviews
      : Number(partner.review_count || 0);

    const meRatingVal = ratingSummary && ratingSummary.totalReviews > 0
      ? ratingSummary.averageRating
      : (partner.rating !== null && partner.rating !== undefined ? Number(partner.rating) : 5.0);

    let profileImageUrl = partner.profile_image_url || null;
    if (profileImageUrl) {
      profileImageUrl = (await storageProvider.resolveSignedUrl(profileImageUrl)) || profileImageUrl;
    }

    const shopName = (shop && shop.shop_name) || partner.business_name || null;
    const shopAddress = (shop && shop.shop_address) || partner.business_address || null;
    const landmark = (shop && shop.landmark) || partner.landmark || null;
    const city = (shop && shop.city) || partner.city || null;
    const area = (shop && (shop.area || shop.locality)) || partner.area || partner.locality || null;
    const latitude = (partner.latitude !== null && partner.latitude !== undefined)
      ? Number(partner.latitude)
      : ((shop && shop.latitude !== null && shop.latitude !== undefined) ? Number(shop.latitude) : null);
    const longitude = (partner.longitude !== null && partner.longitude !== undefined)
      ? Number(partner.longitude)
      : ((shop && shop.longitude !== null && shop.longitude !== undefined) ? Number(shop.longitude) : null);
    const locationAccuracy = (partner.location_accuracy !== null && partner.location_accuracy !== undefined)
      ? Number(partner.location_accuracy)
      : ((shop && shop.location_accuracy !== null && shop.location_accuracy !== undefined) ? Number(shop.location_accuracy) : null);
    const locationSource = partner.location_source || (shop ? shop.location_source : null) || null;
    const workingHoursInfo = resolveWorkingHoursFromRows(partner, shop);

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
        id: effectivePartnerId,
        name: partner.name,
        phone: partner.phone ? `+91 ${partner.phone}` : null,
        email: partner.email,
        partnerStatus: partner.partner_status,
        kycStatus: partner.kyc_status,
        rating: meRatingVal,
        averageRating: meRatingVal,
        reviewCount,
        totalReviews: reviewCount,
        registeredSince: partner.registered_since,
        profileImage: profileImageUrl,
        shopName,
        businessName: shopName,
        shopAddress,
        businessAddress: shopAddress,
        landmark,
        city,
        area,
        locality: area,
        latitude,
        longitude,
        locationAccuracy,
        locationSource,
        operatingInfo: workingHoursInfo.operatingInfo,
        openingTime: workingHoursInfo.openingTime,
        closingTime: workingHoursInfo.closingTime,
        isOpen24Hours: workingHoursInfo.isOpen24Hours,
        workingHours: workingHoursInfo.workingHours,
        bankAccount,
        isNewPartner: vehicleCount === 0,
      },
    };
  }

  /**
   * Secure server-side logout.
   * Revokes Supabase tokens/sessions and logs audit event.
   *
   * @param {object} params
   * @param {object} params.authUser
   * @param {string} [params.requestId]
   * @returns {Promise<{ message: string }>}
   */
  async logout({ authUser, requestId = null, token = null }) {
    const authId = authUser.authId || authUser.uid;

    if (token) {
      try {
        const { redisClient } = require('../providers/redis');
        await redisClient.del(`auth:session:${token}`);
      } catch (redisErr) {
        // Ignore
      }
    }

    try {
      const supabaseAuth = getSupabaseAuth();
      if (supabaseAuth) {
        if (typeof supabaseAuth.admin?.signOut === 'function') {
          await supabaseAuth.admin.signOut(authId);
        } else if (typeof supabaseAuth.revokeRefreshTokens === 'function') {
          await supabaseAuth.revokeRefreshTokens(authId);
        } else if (typeof supabaseAuth.signOut === 'function') {
          await supabaseAuth.signOut();
        }
      }
    } catch (err) {
      // If revocation fails, log warning but do not crash response
    }

    if (authUser.partnerId) {
      auditService.logEvent({
        actorId: authUser.partnerId,
        actorRole: 'PARTNER',
        action: 'PARTNER_LOGGED_OUT',
        entityType: 'PARTNER',
        entityId: authUser.partnerId,
        requestId,
        metadata: {
          authId,
        },
      });
    }

    return {
      message: 'Logged out successfully',
    };
  }

  /**
   * Development-only deterministic authentication token generation.
   * Strictly non-production and PARTNER_DEV_AUTH_ENABLED.
   *
   * @param {object} params
   * @param {string} [params.authId]
   * @param {string} [params.phone]
   * @returns {Promise<object>}
   */
  async devLogin({ authId, phone } = {}) {
    if (env.isProduction || !env.PARTNER_DEV_AUTH_ENABLED || (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test')) {
      throw new NotFoundError('Endpoint not found', ERROR_CODES.NOT_FOUND);
    }

    const targetAuthId = authId || env.PARTNER_DEV_AUTH_ID || 'dev-partner-auth-id';
    const targetPhone = phone ? String(phone).replace(/[^0-9]/g, '').slice(-10) : null;

    let partner = await this.partnerRepository.findByAuthId(targetAuthId);
    if (!partner && targetPhone) {
      const user = await this.userRepository.findByPhone(targetPhone);
      if (user && user.auth_id) {
        partner = await this.partnerRepository.findByAuthId(user.auth_id);
      }
    }

    const token = targetAuthId === (env.PARTNER_DEV_AUTH_ID || 'dev-partner-auth-id')
      ? 'dev-partner-token'
      : `dev-token-${targetAuthId}`;

    if (!partner || !partner.partnerId) {
      return {
        token,
        isRegistered: false,
        authId: targetAuthId,
        message: 'Development user is not yet registered as a partner. Call POST /api/v1/auth/register with Authorization Bearer token to complete onboarding.',
      };
    }

    const sessionData = await this.createSession({
      authUser: {
        authId: targetAuthId,
        phone: partner.phone,
        email: partner.email,
      },
    });

    return {
      token,
      ...sessionData,
    };
  }

  /**
   * Dedicated Partner Dev Login / Bypass endpoint implementation.
   * Strictly non-production and PARTNER_DEV_LOGIN_ENABLED.
   *
   * @param {object} params
   * @param {string} params.phone
   * @param {string} params.devCode
   * @returns {Promise<object>}
   */
  async partnerDevLogin({ phone, devCode } = {}) {
    const devLoginSetting = process.env.PARTNER_DEV_LOGIN_ENABLED !== undefined
      ? (process.env.PARTNER_DEV_LOGIN_ENABLED === 'true' || process.env.PARTNER_DEV_LOGIN_ENABLED === true)
      : Boolean(env.PARTNER_DEV_LOGIN_ENABLED || env.PARTNER_DEV_AUTH_ENABLED || process.env.PARTNER_DEV_AUTH_ENABLED === 'true');

    const isDevAllowed =
      process.env.NODE_ENV !== 'production' &&
      env.NODE_ENV !== 'production' &&
      !env.isProduction &&
      devLoginSetting;

    if (!isDevAllowed) {
      throw new ForbiddenError('Development login is disabled.', 'DEV_LOGIN_DISABLED');
    }

    const configuredPhone = (env.PARTNER_DEV_PHONE || '9999999999').replace(/[^0-9]/g, '').slice(-10);
    const configuredCode = String(env.PARTNER_DEV_CODE || '123456').trim();

    const inputPhone = String(phone || '').replace(/[^0-9]/g, '').slice(-10);
    const inputCode = String(devCode || '').trim();

    if (inputPhone !== configuredPhone || inputCode !== configuredCode) {
      throw new UnauthorizedError('Invalid development credentials.', 'INVALID_DEV_CREDENTIALS');
    }

    const targetAuthId = env.PARTNER_DEV_AUTH_ID || 'dev-partner-auth-id';

    // 1. Look up existing dev partner
    let partner = await this.partnerRepository.findByAuthId(targetAuthId);
    if (!partner) {
      partner = await this.partnerRepository.findByPhone(configuredPhone);
    }

    // 2. If development Partner does not exist in DB, create dedicated dev partner record
    if (!partner || !partner.partnerId) {
      let user = await this.userRepository.findByAuthId(targetAuthId);
      if (!user) {
        user = await this.userRepository.findByPhone(configuredPhone);
      }
      if (!user) {
        user = await this.userRepository.create({
          auth_id: targetAuthId,
          auth_provider: 'supabase',
          role: 'PARTNER',
          name: 'Development Partner',
          phone: `+91${configuredPhone}`,
          country_code: '+91',
          email: 'dev.partner@gongo.in',
          is_active: true,
        });
      }

      const createdPartner = await this.partnerRepository.create({
        user_id: user.id,
        partner_code: 'PTR-DEV-001',
        business_name: 'GONGO Dev Partner Hub',
        partner_status: 'ONLINE',
        kyc_status: 'VERIFIED',
        city: 'Bhopal',
        business_address: 'Dev Hub, Bhopal',
        is_active: true,
      });

      partner = await this.partnerRepository.findById(createdPartner.id);
    }

    // 3. Generate authenticated session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionData = await this.createSession({
      authUser: {
        authId: targetAuthId,
        phone: partner.phone || configuredPhone,
        email: partner.email || 'dev.partner@gongo.in',
      },
    });

    // 4. Save session in Redis with 30-day TTL
    const { redisClient } = require('../providers/redis');
    const sessionPayload = JSON.stringify({
      uid: targetAuthId,
      userId: partner.userId || partner.id,
      phone: partner.phone || configuredPhone,
      email: partner.email || 'dev.partner@gongo.in',
      role: 'PARTNER',
      partnerId: partner.partnerId || partner.id,
      createdAt: new Date().toISOString(),
    });

    await Promise.all([
      redisClient.set(`auth:session:${sessionToken}`, sessionPayload, 'EX', 30 * 24 * 3600),
      redisClient.set('auth:session:dev-partner-token', sessionPayload, 'EX', 30 * 24 * 3600),
    ]);

    logger.info('Partner Dev Login successful', {
      phone: configuredPhone,
      partnerId: partner.partnerId || partner.id,
    });

    return {
      token: sessionToken,
      isRegistered: true,
      ...sessionData,
    };
  }

  /**
   * Fetch live consent acceptance records for the authenticated partner.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} [params.userId]
   * @returns {Promise<Array<object>>}
   */
  async getPartnerConsents({ partnerId, userId }) {
    let records = [];
    if (partnerId) {
      records = await consentRepository.getLatestConsentsByPartnerId(partnerId);
    }
    if ((!records || records.length === 0) && userId) {
      records = await consentRepository.getLatestConsentsByUserId(userId);
    }
    return (records || []).map((r) => ({
      id: r.id,
      documentType: r.document_type,
      documentVersion: r.document_version,
      contentHash: r.content_hash,
      acceptedAt: r.accepted_at,
      vehicleId: r.vehicle_id || null,
      metadata: r.metadata || {},
    }));
  }
}

module.exports = new AuthService();
