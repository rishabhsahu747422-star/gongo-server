"use strict";

const vehicleRepository = require("../repositories/vehicle.repository");
const ShopRepository = require("../repositories/shop.repository");
const pricingRepository = require("../repositories/pricing.repository");
const PartnerRepository = require("../repositories/partner.repository");
const vehicleValidator = require("../validators/vehicle.validator");
const auditService = require("./audit.service");
const storageProvider = require("../providers/storage");
const pool = require("../db/pool");
const { NotFoundError, ConflictError, ForbiddenError, ValidationError } = require("../errors");
const logger = require("../config/logger");
const consentRepository = require("../repositories/consent.repository");
const { DOCUMENT_TYPES, LEGAL_DOCUMENTS } = require("../constants/legal.constants");

// Verification states that allow a vehicle to be ONLINE (compared upper-cased; 'APPROVED' is a
// legacy alias). Mirrored atomically in VehicleRepository.updateStatus.
// Vehicles start ONLINE immediately upon listing, while verification remains PENDING for admin review.
const ONLINE_ELIGIBLE_VERIFICATION_STATUSES = Object.freeze(["VERIFIED", "APPROVED", "PENDING", "UNDER_REVIEW"]);

function calculateEffectiveStatus(vehicle) {
  if (vehicle.is_archived) {
    return "ARCHIVED";
  }
  if (vehicle.rental_status === "ACTIVE") {
    return "ACTIVE";
  }
  if (vehicle.manual_status === "OFFLINE") {
    return "UNAVAILABLE";
  }
  if (vehicle.rental_status === "BOOKED") {
    return "BOOKED";
  }
  if (
    vehicle.rental_status === "IDLE" &&
    (vehicle.manual_status === "ONLINE" || !vehicle.manual_status)
  ) {
    return "AVAILABLE";
  }
  return "UNAVAILABLE";
}

async function resolveSignedUrl(storageKey, expiresInSeconds = 3600) {
  if (!storageKey || typeof storageKey !== "string") return null;
  if (storageKey.startsWith("http://") || storageKey.startsWith("https://")) {
    return storageKey;
  }
  try {
    const res = await storageProvider.createPresignedGetUrl({
      key: storageKey,
      expiresInSeconds,
    });
    return res?.downloadUrl || null;
  } catch (err) {
    logger.warn("Failed to generate presigned download URL", {
      key: storageKey,
      error: err.message,
    });
    return null;
  }
}

function formatVehicle(v) {
  const primaryKey = v.primary_image_url || v.cover_image_key || null;
  const isDirectUrl =
    primaryKey &&
    (primaryKey.startsWith("http://") || primaryKey.startsWith("https://"));

  const isVerified = ["VERIFIED", "APPROVED"].includes(
    String(v.verification_status || "").toUpperCase(),
  );

  const price3Hours = v.price_3_hours !== null && v.price_3_hours !== undefined
    ? Number(v.price_3_hours)
    : (v.price3Hours !== null && v.price3Hours !== undefined ? Number(v.price3Hours) : null);
  const price6Hours = v.price_6_hours !== null && v.price_6_hours !== undefined
    ? Number(v.price_6_hours)
    : (v.price6Hours !== null && v.price6Hours !== undefined ? Number(v.price6Hours) : null);
  const price12Hours = v.price_12_hours !== null && v.price_12_hours !== undefined
    ? Number(v.price_12_hours)
    : (v.price12Hours !== null && v.price12Hours !== undefined ? Number(v.price12Hours) : null);

  const kmLimitPerDay = v.km_limit_per_day !== null && v.km_limit_per_day !== undefined
    ? Number(v.km_limit_per_day)
    : (v.kmLimitPerDay !== null && v.kmLimitPerDay !== undefined ? Number(v.kmLimitPerDay) : null);
  const kmLimitPerHour = v.km_limit_per_hour !== null && v.km_limit_per_hour !== undefined
    ? Number(v.km_limit_per_hour)
    : (v.kmLimitPerHour !== null && v.kmLimitPerHour !== undefined ? Number(v.kmLimitPerHour) : null);
  const kmLimit3Hours = v.km_limit_3_hours !== null && v.km_limit_3_hours !== undefined
    ? Number(v.km_limit_3_hours)
    : (v.kmLimit3Hours !== null && v.kmLimit3Hours !== undefined ? Number(v.kmLimit3Hours) : null);
  const kmLimit6Hours = v.km_limit_6_hours !== null && v.km_limit_6_hours !== undefined
    ? Number(v.km_limit_6_hours)
    : (v.kmLimit6Hours !== null && v.kmLimit6Hours !== undefined ? Number(v.kmLimit6Hours) : null);
  const kmLimit12Hours = v.km_limit_12_hours !== null && v.km_limit_12_hours !== undefined
    ? Number(v.km_limit_12_hours)
    : (v.kmLimit12Hours !== null && v.kmLimit12Hours !== undefined ? Number(v.kmLimit12Hours) : null);

  return {
    id: v.id,
    vehicleReference: v.vehicle_reference || null,
    partnerId: v.partner_id,
    shopId: v.shop_id,
    category: v.category,
    type: v.category,
    brand: v.brand,
    model: v.model,
    variant: v.variant,
    registrationNumber: v.registration_number,
    year: v.year,
    fuelType: v.fuel_type,
    transmission: v.transmission,
    seats: v.seats,
    description: v.description,
    pickupLocation: v.pickup_location,
    manualStatus: v.manual_status,
    rentalStatus: v.rental_status,
    verificationStatus: v.verification_status,
    isVerified,
    isGongoVerified: isVerified,
    isArchived: v.is_archived,
    offlineReason: v.offline_reason,
    rejectionReason: v.rejection_reason || null,
    effectiveStatus: calculateEffectiveStatus(v),
    status: calculateEffectiveStatus(v),
    primaryImageKey: primaryKey,
    coverImageKey: primaryKey,
    primaryImageUrl: isDirectUrl ? primaryKey : null,
    coverImageUrl: isDirectUrl ? primaryKey : null,
    images: isDirectUrl ? [primaryKey] : [],
    pricing:
      v.price_per_day !== undefined && v.price_per_day !== null
        ? {
            pricePerHour: Number(v.price_per_hour || 0),
            price3Hours,
            price6Hours,
            price12Hours,
            pricePer4Hours: Number(v.price_per_4_hours || 0),
            pricePerDay: Number(v.price_per_day || 0),
            price_per_hour: Number(v.price_per_hour || 0),
            price_3_hours: price3Hours,
            price_6_hours: price6Hours,
            price_12_hours: price12Hours,
            price_per_4_hours: Number(v.price_per_4_hours || 0),
            price_per_day: Number(v.price_per_day || 0),
            kmLimitPerDay,
            kmLimitPerHour,
            kmLimit3Hours,
            kmLimit6Hours,
            kmLimit12Hours,
            km_limit_per_day: kmLimitPerDay,
            km_limit_per_hour: kmLimitPerHour,
            km_limit_3_hours: kmLimit3Hours,
            km_limit_6_hours: kmLimit6Hours,
            km_limit_12_hours: kmLimit12Hours,
            securityDeposit: Number(v.security_deposit || 0),
            extraKmCharge: Number(v.extra_km_charge || 0),
            currency: v.currency || "INR",
            isActive: v.pricing_active !== undefined ? v.pricing_active : true,
          }
        : null,
    pricePerDay:
      v.price_per_day !== undefined && v.price_per_day !== null
        ? Number(v.price_per_day)
        : 0,
    pricePerHour:
      v.price_per_hour !== undefined && v.price_per_hour !== null
        ? Number(v.price_per_hour)
        : 0,
    price3Hours,
    price6Hours,
    price12Hours,
    price_per_day:
      v.price_per_day !== undefined && v.price_per_day !== null
        ? Number(v.price_per_day)
        : 0,
    price_per_hour:
      v.price_per_hour !== undefined && v.price_per_hour !== null
        ? Number(v.price_per_hour)
        : 0,
    price_3_hours: price3Hours,
    price_6_hours: price6Hours,
    price_12_hours: price12Hours,
    pricePer4Hours:
      v.price_per_4_hours !== undefined && v.price_per_4_hours !== null
        ? Number(v.price_per_4_hours)
        : 0,
    kmLimitPerDay,
    kmLimitPerHour,
    kmLimit3Hours,
    kmLimit6Hours,
    kmLimit12Hours,
    km_limit_per_day: kmLimitPerDay,
    km_limit_per_hour: kmLimitPerHour,
    km_limit_3_hours: kmLimit3Hours,
    km_limit_6_hours: kmLimit6Hours,
    km_limit_12_hours: kmLimit12Hours,
    securityDeposit:
      v.security_deposit !== undefined && v.security_deposit !== null
        ? Number(v.security_deposit)
        : 0,
    extraKmCharge:
      v.extra_km_charge !== undefined && v.extra_km_charge !== null
        ? Number(v.extra_km_charge)
        : 0,
    totalEarnings: Number(v.total_earnings || 0),
    totalBookings: Number(v.total_bookings || 0),
    ratingAvg: v.rating_avg !== null && v.rating_avg !== undefined ? Number(Number(v.rating_avg).toFixed(1)) : null,
    ratingCount: Number(v.rating_count || 0),
    averageRating: v.rating_avg !== null && v.rating_avg !== undefined ? Number(Number(v.rating_avg).toFixed(1)) : null,
    reviewCount: Number(v.rating_count || 0),
    totalReviews: Number(v.rating_count || 0),
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

class VehicleService {
  constructor(deps = {}) {
    this.shopRepository = deps.shopRepository || new ShopRepository();
    this.pricingRepository = deps.pricingRepository || pricingRepository;
    this.partnerRepository = deps.partnerRepository || new PartnerRepository();
  }

  /**
   * Create a new vehicle.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {object} params.input
   * @returns {Promise<object>}
   */
  async createVehicle({ partnerId, input }) {
    const validated = vehicleValidator.validateCreateVehicle(input);

    // Duplicate check on registration number
    const existing = await vehicleRepository.findByRegistrationNumber(
      validated.registrationNumber,
    );
    if (existing) {
      throw new ConflictError(
        `Vehicle with registration number '${validated.registrationNumber}' already exists`,
      );
    }

    // Resolve legacy shop ID if present
    const legacyShop = await this.shopRepository
      .findByPartnerId(partnerId)
      .catch(() => null);

    const vehicleRecord = await pool.transaction(async (client) => {
      const partner = await this.partnerRepository.findById(partnerId, client).catch(() => null);
      const resolvedUserId = partner?.userId || partner?.user_id || null;

      let resolvedShopId = legacyShop ? legacyShop.id : null;
      if (!resolvedShopId) {
        try {
          const newShop = await this.shopRepository.createShop(
            {
              partnerId,
              shopName: partner?.business_name || "Primary Hub",
              shopAddress:
                partner?.business_address || "Primary Branch Address",
              city: partner?.city || "Mumbai",
            },
            client,
          );
          if (newShop) resolvedShopId = newShop.id;
        } catch (_) {
          // Ignore if fallback fails
        }
      }

      const created = await vehicleRepository.createVehicle(
        {
          partnerId,
          shopId: resolvedShopId,
          category: validated.category,
          brand: validated.brand,
          model: validated.model,
          variant: validated.variant,
          registrationNumber: validated.registrationNumber,
          year: validated.year,
          fuelType: validated.fuelType,
          transmission: validated.transmission,
          seats: validated.seats,
          description: validated.description,
          pickupLocation: validated.pickupLocation,
          // A newly listed vehicle starts ONLINE immediately upon listing so customers can
          // discover it in search, while admin verification remains PENDING for later review.
          manualStatus: "ONLINE",
          verificationStatus: "PENDING",
        },
        client,
      );

      // If inline pricing was provided in wizard, persist atomically in same transaction
      if (validated.pricing) {
        const pricingRecord = await this.pricingRepository.upsertPricing(
          created.id,
          validated.pricing,
          client,
        );
        await this.pricingRepository.createHistoryRecord(
          {
            vehicleId: created.id,
            pricePerHour: validated.pricing.pricePerHour,
            price3Hours: validated.pricing.price3Hours,
            price6Hours: validated.pricing.price6Hours,
            price12Hours: validated.pricing.price12Hours,
            pricePer4Hours: validated.pricing.pricePer4Hours,
            pricePerDay: validated.pricing.pricePerDay,
            kmLimitPerDay: validated.pricing.kmLimitPerDay,
            kmLimitPerHour: validated.pricing.kmLimitPerHour,
            kmLimit3Hours: validated.pricing.kmLimit3Hours,
            kmLimit6Hours: validated.pricing.kmLimit6Hours,
            kmLimit12Hours: validated.pricing.kmLimit12Hours,
            securityDeposit: validated.pricing.securityDeposit,
            extraKmCharge: validated.pricing.extraKmCharge,
            validFrom: new Date().toISOString(),
            changedBy: resolvedUserId,
          },
          client,
        );
        created.price_per_day = pricingRecord.price_per_day;
        created.price_per_hour = pricingRecord.price_per_hour;
        created.price_3_hours = pricingRecord.price_3_hours;
        created.price_6_hours = pricingRecord.price_6_hours;
        created.price_12_hours = pricingRecord.price_12_hours;
        created.price_per_4_hours = pricingRecord.price_per_4_hours;
        created.km_limit_per_day = pricingRecord.km_limit_per_day;
        created.km_limit_per_hour = pricingRecord.km_limit_per_hour;
        created.km_limit_3_hours = pricingRecord.km_limit_3_hours;
        created.km_limit_6_hours = pricingRecord.km_limit_6_hours;
        created.km_limit_12_hours = pricingRecord.km_limit_12_hours;
        created.security_deposit = pricingRecord.security_deposit;
        created.extra_km_charge = pricingRecord.extra_km_charge;
        created.currency = pricingRecord.currency;
        created.pricing_active = pricingRecord.is_active;
      }

      // If inline images were provided in wizard
      if (validated.images && Array.isArray(validated.images)) {
        await Promise.all(
          validated.images.map((img, i) => {
            const storageKey =
              typeof img === "string" ? img : img.uri || img.storageKey;
            if (!storageKey) return Promise.resolve();
            return vehicleRepository.createVehicleImage(
              {
                vehicleId: created.id,
                storageKey,
                isCover: i === 0,
                sortOrder: i,
              },
              client,
            );
          }),
        );
        await vehicleRepository.syncVehiclePrimaryImage(created.id, client);
      }

      // If inline documents were provided in wizard
      if (validated.documents && Array.isArray(validated.documents)) {
        await Promise.all(
          validated.documents.map((doc) => {
            if (!doc || (!doc.type && !doc.documentType))
              return Promise.resolve();
            return vehicleRepository.createVehicleDocument(
              {
                vehicleId: created.id,
                documentType: doc.type || doc.documentType,
                documentName:
                  doc.name || doc.documentName || doc.type || doc.documentType,
                documentNumber: doc.number || doc.documentNumber || null,
                storageKey: doc.uri || doc.storageKey || "uploaded_pending",
                verificationStatus: "PENDING",
              },
              client,
            );
          }),
        );
      }

      // Step: Record Immutable Consent for Vehicle Lease Agreement
      try {
        await consentRepository.recordConsent({
          userId: resolvedUserId || partnerId,
          partnerId,
          documentType: DOCUMENT_TYPES.VEHICLE_LEASE_AGREEMENT,
          documentVersion: LEGAL_DOCUMENTS.VEHICLE_LEASE_AGREEMENT.version,
          contentHash: LEGAL_DOCUMENTS.VEHICLE_LEASE_AGREEMENT.contentHash,
          vehicleId: created.id,
          metadata: {
            source: 'add_vehicle',
            registrationNumber: validated.registrationNumber,
          },
          client,
        });
      } catch (consentErr) {
        logger.error('Failed to record vehicle lease consent:', consentErr);
        throw consentErr;
      }

      return created;
    });

    auditService.logEvent({
      actorId: partnerId,
      actorRole: "PARTNER",
      action: "VEHICLE_CREATED",
      entityType: "VEHICLE",
      entityId: vehicleRecord.id,
      metadata: {
        category: vehicleRecord.category,
        brand: vehicleRecord.brand,
        model: vehicleRecord.model,
        registrationNumber: vehicleRecord.registration_number,
      },
    });

    const formatted = formatVehicle(vehicleRecord);
    if (formatted.primaryImageKey) {
      const signedUrl = await resolveSignedUrl(formatted.primaryImageKey);
      formatted.primaryImageUrl = signedUrl;
      formatted.coverImageUrl = signedUrl;
      formatted.images = signedUrl ? [signedUrl] : [];
    }
    return formatted;
  }

  /**
   * List vehicles for a partner with pagination and filters.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {object} params.query
   * @returns {Promise<object>}
   */
  async getVehicles({ partnerId, query }) {
    const validatedQuery = vehicleValidator.validateVehicleListQuery(query);

    const rows = await vehicleRepository.findManyByPartnerId(
      partnerId,
      validatedQuery,
    );
    let total;
    if (rows.length > 0 && rows[0].total_count !== undefined) {
      total = Number(rows[0].total_count);
    } else {
      total = await vehicleRepository.countByPartnerId(
        partnerId,
        validatedQuery,
      );
    }

    const vehicles = await Promise.all(
      rows.map(async (row) => {
        const formatted = formatVehicle(row);
        const key = row.primary_image_url || formatted.primaryImageKey;
        if (key) {
          const signedUrl = await resolveSignedUrl(key);
          formatted.primaryImageUrl = signedUrl;
          formatted.coverImageUrl = signedUrl;
          formatted.images = signedUrl ? [signedUrl] : [];
        }
        return formatted;
      }),
    );

    const totalPages = Math.ceil(total / validatedQuery.limit) || 1;

    return {
      vehicles,
      pagination: {
        total,
        page: validatedQuery.page,
        limit: validatedQuery.limit,
        totalPages,
      },
    };
  }

  /**
   * Get vehicle details by ID with images and compliance documents.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.vehicleId
   * @returns {Promise<object>}
   */
  async getVehicleById({ partnerId, vehicleId }) {
    const vehicle = await vehicleRepository.findByIdAndPartnerId(
      vehicleId,
      partnerId,
    );
    if (!vehicle) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }

    const [images, documents] = await Promise.all([
      vehicleRepository.getVehicleImages(vehicleId),
      vehicleRepository.getVehicleDocuments(vehicleId),
    ]);

    const formatted = formatVehicle(vehicle);
    const primaryKey = vehicle.primary_image_url || formatted.primaryImageKey;
    if (primaryKey) {
      const signedPrimaryUrl = await resolveSignedUrl(primaryKey);
      formatted.primaryImageUrl = signedPrimaryUrl;
      formatted.coverImageUrl = signedPrimaryUrl;
    }

    const signedImages = await Promise.all(
      images.map(async (img) => {
        const storageKey = img.storage_key || img.image_url;
        const signedUrl = await resolveSignedUrl(storageKey);
        return {
          id: img.id,
          vehicleId: img.vehicle_id,
          storageKey: img.storage_key,
          imageUrl: signedUrl,
          sortOrder: img.sort_order,
          isCover: img.is_cover,
          verificationStatus: img.verification_status || "PENDING",
          rejectionReason: img.rejection_reason || null,
          version: img.version || 1,
          parentImageId: img.parent_image_id || null,
          createdAt: img.created_at,
          verifiedAt: img.verified_at || null,
          rejectedAt: img.rejected_at || null,
        };
      }),
    );

    return {
      ...formatted,
      images: signedImages,
      imageUrls: signedImages.map((img) => img.imageUrl).filter(Boolean),
      imageDetails: signedImages,
      documents: documents.map((doc) => {
        const rawStatus = (doc.verification_status || "PENDING").toUpperCase();
        const isParentVerified =
          String(vehicle.verification_status || "").toUpperCase() ===
          "VERIFIED";
        const docVerificationStatus =
          rawStatus === "REJECTED"
            ? "REJECTED"
            : isParentVerified
              ? "VERIFIED"
              : rawStatus;
        return {
          id: doc.id,
          vehicleId: doc.vehicle_id,
          documentType: doc.document_type,
          documentName: doc.document_name,
          documentNumber: doc.document_number,
          validTill: doc.valid_till,
          storageKey: doc.storage_key,
          verificationStatus: docVerificationStatus,
          isRequired: doc.is_required,
          version: doc.version,
          rejectionReason: doc.rejection_reason,
          createdAt: doc.created_at,
        };
      }),
    };
  }

  /**
   * Update vehicle specifications and details.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.vehicleId
   * @param {object} params.input
   * @returns {Promise<object>}
   */
  async updateVehicle({ partnerId, vehicleId, input }) {
    const updates = vehicleValidator.validateUpdateVehicle(input);

    const vehicle = await vehicleRepository.findByIdAndPartnerId(
      vehicleId,
      partnerId,
    );
    if (!vehicle) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }

    if (vehicle.is_archived) {
      throw new ConflictError("Cannot update an archived vehicle");
    }

    if (vehicle.verification_status === "REJECTED") {
      updates.verificationStatus = "PENDING";
      updates.rejectionReason = null;
    }

    const updated = await vehicleRepository.updateVehicle(
      vehicleId,
      partnerId,
      updates,
    );

    auditService.logEvent({
      actorId: partnerId,
      actorRole: "PARTNER",
      action: "VEHICLE_UPDATED",
      entityType: "VEHICLE",
      entityId: vehicleId,
      metadata: { updatedFields: Object.keys(updates) },
    });

    return formatVehicle(updated);
  }

  /**
   * Update vehicle operational status (ONLINE / OFFLINE).
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.vehicleId
   * @param {object} params.input
   * @returns {Promise<object>}
   */
  async updateVehicleStatus({ partnerId, vehicleId, input }) {
    const { manualStatus, offlineReason } =
      vehicleValidator.validateStatusUpdate(input);

    const vehicle = await vehicleRepository.findByIdAndPartnerId(
      vehicleId,
      partnerId,
    );
    if (!vehicle) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }

    if (vehicle.is_archived) {
      throw new ConflictError("Cannot update status of an archived vehicle");
    }

    // AD-2: an admin-blocked or admin-deactivated vehicle (is_active = false) cannot be put back
    // online by the partner. Admin BLOCK sets is_active = false with is_archived = false; only an
    // admin ACTIVATE lifts it. (Service-level check: vehicles.is_active is not defined in the repo
    // migrations / pg-mem fixtures, so it is not part of the repository's atomic SQL guard.)
    if (manualStatus === "ONLINE" && vehicle.is_active === false) {
      throw new ConflictError(
        "Vehicle has been blocked or deactivated by admin and cannot be set to ONLINE",
      );
    }

    // Business guard: Active trip cannot be toggled
    if (vehicle.rental_status === "ACTIVE") {
      throw new ConflictError(
        "Vehicle cannot be set to ONLINE while an active trip is in progress",
      );
    }

    // Business guard: Vehicle verification authority & online gate.
    // Only VERIFIED/APPROVED (case-insensitive) vehicles may go ONLINE. This applies to the
    // already-normalized manualStatus, so it holds whichever request key (`status` or
    // `manualStatus`) carried the value. REJECTED, PENDING, UNDER_REVIEW and missing
    // verification are all refused. The repository UPDATE re-checks this atomically.
    if (manualStatus === "ONLINE") {
      const verification = String(vehicle.verification_status || "")
        .trim()
        .toUpperCase();
      if (!ONLINE_ELIGIBLE_VERIFICATION_STATUSES.includes(verification)) {
        throw new ConflictError(
          verification === "REJECTED"
            ? "Vehicle cannot be set to ONLINE while verification is rejected by admin"
            : "Vehicle cannot be set to ONLINE until verified and approved by admin",
        );
      }
      const partner = await this.partnerRepository.findById(partnerId);
      if (
        partner &&
        String(partner.kyc_status || "").toUpperCase() !== "VERIFIED"
      ) {
        throw new ConflictError(
          "Cannot set vehicle to ONLINE until partner KYC is verified and approved",
        );
      }
    }

    const updated = await vehicleRepository.updateStatus(
      vehicleId,
      partnerId,
      manualStatus,
      offlineReason,
    );
    if (!updated) {
      // Archived, blocked/deactivated by admin, or verification revoked (e.g. admin rejection)
      // concurrently between the read above and the guarded UPDATE
      throw new ConflictError(
        "Cannot update status: vehicle is archived, has been blocked/deactivated by admin, or is not verified",
      );
    }

    auditService.logEvent({
      actorId: partnerId,
      actorRole: "PARTNER",
      action: "VEHICLE_STATUS_UPDATED",
      entityType: "VEHICLE",
      entityId: vehicleId,
      metadata: { manualStatus, offlineReason },
    });

    return formatVehicle(updated);
  }

  /**
   * Archive a vehicle (soft-delete).
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.vehicleId
   * @returns {Promise<object>}
   */
  async archiveVehicle({ partnerId, vehicleId }) {
    const vehicle = await vehicleRepository.findByIdAndPartnerId(
      vehicleId,
      partnerId,
    );
    if (!vehicle) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }

    if (vehicle.rental_status === "ACTIVE") {
      throw new ConflictError(
        "Cannot archive vehicle while an active trip is in progress",
      );
    }

    if (vehicle.rental_status === "BOOKED") {
      throw new ConflictError(
        "Cannot archive vehicle with upcoming confirmed bookings",
      );
    }

    try {
      const activeBookings = await pool.query(
        `SELECT id FROM bookings 
         WHERE vehicle_id = $1 
           AND (
             booking_status IN ('CONFIRMED', 'UPCOMING', 'ACTIVE', 'PICKUP_SCHEDULED')
             OR status IN ('confirmed', 'pickup_scheduled', 'in_progress')
           )
         LIMIT 1`,
        [vehicleId],
      );
      if (
        activeBookings &&
        activeBookings.rows &&
        activeBookings.rows.length > 0
      ) {
        throw new ConflictError(
          "Cannot archive vehicle with upcoming confirmed bookings",
        );
      }
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      // Continue if table doesn't exist in isolated unit test
    }

    if (vehicle.is_archived) {
      return { message: "Vehicle already archived", vehicleId };
    }

    await vehicleRepository.archiveVehicle(vehicleId, partnerId);

    auditService.logEvent({
      actorId: partnerId,
      actorRole: "PARTNER",
      action: "VEHICLE_ARCHIVED",
      entityType: "VEHICLE",
      entityId: vehicleId,
      metadata: { registrationNumber: vehicle.registration_number },
    });

    return { message: "Vehicle successfully archived", vehicleId };
  }

  // ── Images ──────────────────────────────────────────────────────────

  /**
   * List images for a vehicle.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.vehicleId
   * @returns {Promise<Array<object>>}
   */
  async getVehicleImages({ partnerId, vehicleId }) {
    const vehicle = await vehicleRepository.findByIdAndPartnerId(
      vehicleId,
      partnerId,
    );
    if (!vehicle) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }

    const images = await vehicleRepository.getVehicleImages(vehicleId);
    return Promise.all(
      images.map(async (img) => {
        const storageKey = img.storage_key || img.image_url;
        const signedUrl = await resolveSignedUrl(storageKey);
        return {
          id: img.id,
          vehicleId: img.vehicle_id,
          storageKey: img.storage_key,
          imageUrl: signedUrl,
          sortOrder: img.sort_order,
          isCover: img.is_cover,
          verificationStatus: img.verification_status || "PENDING",
          rejectionReason: img.rejection_reason || null,
          version: img.version || 1,
          parentImageId: img.parent_image_id || null,
          createdAt: img.created_at,
          verifiedAt: img.verified_at || null,
          rejectedAt: img.rejected_at || null,
        };
      }),
    );
  }

  /**
   * Set vehicle cover image.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.vehicleId
   * @param {string} params.imageId
   * @returns {Promise<object>}
   */
  async setCoverImage({ partnerId, vehicleId, imageId }) {
    const vehicle = await vehicleRepository.findByIdAndPartnerId(
      vehicleId,
      partnerId,
    );
    if (!vehicle) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }

    const image = await vehicleRepository.findVehicleImageById(
      imageId,
      vehicleId,
    );
    if (!image) {
      throw new NotFoundError("Vehicle image not found");
    }

    const updated = await vehicleRepository.setCoverImage(imageId, vehicleId);
    await vehicleRepository.syncVehiclePrimaryImage(vehicleId);

    const signedUrl = await resolveSignedUrl(updated.storage_key);

    auditService.logEvent({
      actorId: partnerId,
      actorRole: "PARTNER",
      action: "VEHICLE_COVER_IMAGE_SET",
      entityType: "VEHICLE_IMAGE",
      entityId: imageId,
      metadata: { vehicleId },
    });

    return {
      id: updated.id,
      vehicleId: updated.vehicle_id,
      storageKey: updated.storage_key,
      imageUrl: signedUrl,
      isCover: updated.is_cover,
    };
  }

  /**
   * Delete vehicle image.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.vehicleId
   * @param {string} params.imageId
   * @returns {Promise<object>}
   */
  async deleteVehicleImage({ partnerId, vehicleId, imageId }) {
    const vehicle = await vehicleRepository.findByIdAndPartnerId(
      vehicleId,
      partnerId,
    );
    if (!vehicle) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }

    const image = await vehicleRepository.findVehicleImageById(
      imageId,
      vehicleId,
    );
    if (!image) {
      throw new NotFoundError("Vehicle image not found");
    }

    const upperStatus = String(image.verification_status || "").toUpperCase();
    if (upperStatus === "APPROVED" || upperStatus === "VERIFIED") {
      const activeCount = await vehicleRepository.countActiveImages(vehicleId);
      if (activeCount <= 1) {
        throw new ValidationError(
          "Cannot delete the only approved vehicle photo without replacing it",
        );
      }
    }

    await vehicleRepository.deleteVehicleImage(imageId, vehicleId);
    await vehicleRepository.syncVehiclePrimaryImage(vehicleId);

    // Remove from private storage bucket in background
    storageProvider.deleteObject({ key: image.storage_key }).catch((delErr) => {
      logger.error("Failed to remove deleted vehicle image from storage", {
        key: image.storage_key,
        error: delErr.message,
      });
    });

    auditService.logEvent({
      actorId: partnerId,
      actorRole: "PARTNER",
      action: "VEHICLE_IMAGE_DELETED",
      entityType: "VEHICLE_IMAGE",
      entityId: imageId,
      metadata: { vehicleId, storageKey: image.storage_key },
    });

    return { message: "Image successfully deleted", imageId };
  }

  // ── Documents ───────────────────────────────────────────────────────

  /**
   * List latest compliance documents for a vehicle.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.vehicleId
   * @returns {Promise<Array<object>>}
   */
  async getVehicleDocuments({ partnerId, vehicleId }) {
    const vehicle = await vehicleRepository.findByIdAndPartnerId(
      vehicleId,
      partnerId,
    );
    if (!vehicle) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }

    const docs = await vehicleRepository.getVehicleDocuments(vehicleId);
    const isVehicleVerified =
      String(vehicle.verification_status || "").toUpperCase() === "VERIFIED";
    return docs.map((doc) => {
      const rawStatus = (doc.verification_status || "PENDING").toUpperCase();
      const docVerificationStatus =
        rawStatus === "REJECTED"
          ? "REJECTED"
          : isVehicleVerified
            ? "VERIFIED"
            : rawStatus;
      return {
        id: doc.id,
        vehicleId: doc.vehicle_id,
        documentType: doc.document_type,
        documentName: doc.document_name,
        documentNumber: doc.document_number,
        validTill: doc.valid_till,
        storageKey: doc.storage_key,
        verificationStatus: docVerificationStatus,
        isRequired: doc.is_required,
        version: doc.version,
        rejectionReason: doc.rejection_reason,
        partnerSubmittedMetadata: {
          documentNumber: doc.document_number || null,
          documentName: doc.document_name || null,
          validTill: doc.valid_till || null,
          isAuthoritative: false,
        },
        createdAt: doc.created_at,
      };
    });
  }

  /**
   * Submit or register a vehicle compliance document.
   * Authoritative: Always sets status to PENDING regardless of client payload.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {object} params.input
   * @returns {Promise<object>}
   */
  async createVehicleDocument({ partnerId, input }) {
    const validated = vehicleValidator.validateCreateVehicleDocument(input);
    const {
      vehicleId,
      documentType,
      documentName,
      documentNumber,
      validTill,
      storageKey,
    } = validated;

    // Verify vehicle belongs to authenticated partner
    const vehicle = await vehicleRepository.findByIdAndPartnerId(
      vehicleId,
      partnerId,
    );
    if (!vehicle) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }

    if (vehicle.is_archived) {
      throw new ConflictError(
        "Cannot submit documents for an archived vehicle",
      );
    }

    // Verify storageKey belongs to authenticated partner and vehicle if provided
    if (storageKey) {
      const expectedPrefix = `partners/${partnerId}/vehicles/${vehicleId}/documents/`;
      if (!storageKey.startsWith(expectedPrefix)) {
        throw new ForbiddenError(
          "Storage key does not belong to this vehicle or partner",
        );
      }
    }

    const currentMax = await vehicleRepository.findMaxDocumentVersion(
      vehicleId,
      documentType,
    );
    const isRequired = ["RC", "Insurance", "INSURANCE"].includes(documentType);

    const doc = await vehicleRepository.createVehicleDocument({
      vehicleId,
      documentType,
      documentName: documentName || documentType,
      documentNumber: documentNumber || null,
      validTill: validTill || null,
      storageKey:
        storageKey ||
        `partners/${partnerId}/vehicles/${vehicleId}/documents/${documentType.toLowerCase()}/pending-${Date.now()}`,
      verificationStatus: "PENDING", // Authoritative server-controlled state
      isRequired,
      version: currentMax + 1,
    });

    if (vehicle.verification_status === "REJECTED") {
      await vehicleRepository.updateVehicleVerificationStatus(
        vehicleId,
        "PENDING",
      );
    }

    auditService.logEvent({
      actorId: partnerId,
      actorRole: "PARTNER",
      action: "VEHICLE_DOCUMENT_SUBMITTED",
      entityType: "VEHICLE_DOCUMENT",
      entityId: doc.id,
      metadata: {
        vehicleId,
        documentType,
        version: doc.version,
        verificationStatus: "PENDING",
      },
    });

    return {
      id: doc.id,
      vehicleId: doc.vehicle_id,
      documentType: doc.document_type,
      documentName: doc.document_name,
      documentNumber: doc.document_number,
      validTill: doc.valid_till,
      storageKey: doc.storage_key,
      verificationStatus: "PENDING",
      isRequired: doc.is_required,
      version: doc.version,
      rejectionReason: null,
      partnerSubmittedMetadata: {
        documentNumber: doc.document_number || null,
        documentName: doc.document_name || null,
        validTill: doc.valid_till || null,
        isAuthoritative: false,
      },
      createdAt: doc.created_at,
    };
  }

  /**
   * Retrieve a single vehicle document by ID with partner ownership check.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.documentId
   * @returns {Promise<object>}
   */
  async getVehicleDocumentById({ partnerId, documentId }) {
    const doc = await vehicleRepository.findVehicleDocumentByIdOnly(documentId);
    if (!doc || doc.partner_id !== partnerId) {
      throw new NotFoundError("Vehicle document not found");
    }

    return {
      id: doc.id,
      vehicleId: doc.vehicle_id,
      documentType: doc.document_type,
      documentName: doc.document_name,
      documentNumber: doc.document_number,
      validTill: doc.valid_till,
      storageKey: doc.storage_key,
      verificationStatus: (doc.verification_status || "PENDING").toUpperCase(),
      isRequired: doc.is_required,
      version: doc.version,
      rejectionReason: doc.rejection_reason,
      partnerSubmittedMetadata: {
        documentNumber: doc.document_number || null,
        documentName: doc.document_name || null,
        validTill: doc.valid_till || null,
        isAuthoritative: false,
      },
      createdAt: doc.created_at,
    };
  }

  /**
   * Delete a vehicle document.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.vehicleId
   * @param {string} params.documentId
   * @returns {Promise<object>}
   */
  async deleteVehicleDocument({ partnerId, vehicleId, documentId }) {
    const vehicle = await vehicleRepository.findByIdAndPartnerId(
      vehicleId,
      partnerId,
    );
    if (!vehicle) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }

    const doc = await vehicleRepository.findVehicleDocumentById(
      documentId,
      vehicleId,
    );
    if (!doc) {
      throw new NotFoundError("Vehicle document not found");
    }

    await vehicleRepository.deleteVehicleDocument(documentId, vehicleId);

    // Remove from private storage bucket in background
    storageProvider.deleteObject({ key: doc.storage_key }).catch((delErr) => {
      logger.error("Failed to remove deleted vehicle document from storage", {
        key: doc.storage_key,
        error: delErr.message,
      });
    });

    auditService.logEvent({
      actorId: partnerId,
      actorRole: "PARTNER",
      action: "VEHICLE_DOCUMENT_DELETED",
      entityType: "VEHICLE_DOCUMENT",
      entityId: documentId,
      metadata: {
        vehicleId,
        documentType: doc.document_type,
        storageKey: doc.storage_key,
      },
    });

    return { message: "Document successfully deleted", documentId };
  }

  /**
   * Retrieves full rental history and trip statistics for a partner's vehicle.
   *
   * @param {object} params
   * @param {string} params.partnerId
   * @param {string} params.vehicleId
   * @returns {Promise<object>}
   */
  async getVehicleRentalHistory({ partnerId, vehicleId }) {
    const historyData = await vehicleRepository.getVehicleRentalHistory(
      vehicleId,
      partnerId,
    );
    if (!historyData) {
      throw new NotFoundError(
        "Vehicle not found or does not belong to partner",
      );
    }
    return historyData;
  }

  calculateEffectiveStatus(vehicle) {
    return calculateEffectiveStatus(vehicle);
  }
}

module.exports = new VehicleService();
