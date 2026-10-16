'use strict';

const VehicleRepository = require('../repositories/vehicle.repository');
const { redisClient } = require('../config/redis');
const logger = require('../config/logger');
const {
  PAGINATION,
  GEO_LIMITS,
  SORT_OPTIONS,
  CACHE_TTL,
} = require('../constants/vehicle');
const { NotFoundError } = require('../errors');
const { createPresignedGetUrl } = require('../providers/supabase');

const vehicleRepository = new VehicleRepository();

/**
 * VehicleService — vehicle discovery business logic.
 *
 * Responsibilities:
 *   - Enforce listing eligibility (active + approved partner + active shop)
 *   - Orchestrate filter/sort/pagination
 *   - Haversine location logic for nearby
 *   - Redis caching for stable catalogue data (categories, cities)
 *   - Map repository rows to customer-safe API shapes
 *   - Build image URL placeholders (S3 presigned URL generation is deferred)
 *
 * AVAILABILITY NOTE:
 *   This service checks only STATIC listing eligibility (listing_status = ACTIVE,
 *   partner verified, shop active). Booking-based date/time availability checking
 *   is intentionally deferred to the Booking module (Step 7+). The architecture
 *   is designed so booking availability can be integrated as an additional
 *   filter/join in the repository layer without restructuring this service.
 *   Clients must NOT rely on these results as a claim that a vehicle is available
 *   for a specific rental period.
 *
 * SECURITY:
 *   - registration_number is NEVER passed out of this service.
 *   - storage_key is NEVER passed out of this service.
 *   - All filter values are validated by the validator before reaching here.
 *   - Image URLs returned are placeholders; real presigned URL generation
 *     (with TTL, no permanent S3 credentials exposure) is deferred.
 */
class VehicleService {
  /**
   * Build a namespaced Redis cache key.
   *
   * @param {string} segment
   * @returns {string}
   */
  static cacheKey(segment) {
    return `gongo:vehicles:${segment}`;
  }

  /**
   * Safe Redis GET with fallback — never throws; returns null on failure.
   *
   * SECURITY: caching is used ONLY for stable catalogue data (categories,
   * cities). It is NEVER used for availability state so stale cache cannot
   * produce incorrect availability claims.
   *
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  static async cacheGet(key) {
    try {
      const raw = await redisClient.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      logger.warn('Vehicle cache GET failed — bypassing cache', {
        key,
        code: err.code || 'CACHE_ERROR',
      });
      return null;
    }
  }

  /**
   * Safe Redis SET with TTL — never throws.
   *
   * @param {string} key
   * @param {any} value
   * @param {number} ttlSeconds
   * @returns {Promise<void>}
   */
  static async cacheSet(key, value, ttlSeconds) {
    try {
      await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      logger.warn('Vehicle cache SET failed — continuing without cache', {
        key,
        code: err.code || 'CACHE_ERROR',
      });
    }
  }

  /**
   * Resolves a vehicle image storage path or key to a live signed URL.
   *
   * @param {string} storageKey
   * @returns {Promise<string|null>}
   */
  static async resolveImageUrl(storageKey) {
    if (!storageKey || typeof storageKey !== 'string') return null;
    if (storageKey.startsWith('http://') || storageKey.startsWith('https://')) {
      return storageKey;
    }
    const candidateBuckets = ['gongo-uploads', 'gongo-partner-documents'];
    for (const bucket of candidateBuckets) {
      try {
        const presigned = await createPresignedGetUrl({
          key: storageKey,
          bucket,
          expiresInSeconds: 86400,
        });
        if (presigned?.downloadUrl) {
          return presigned.downloadUrl;
        }
      } catch {
        // try next candidate bucket
      }
    }
    return null;
  }

  /**
   * Build public image shape from raw repository image rows.
   *
   * @param {object[]} imageRows
   * @returns {Promise<object[]>}
   */
  static async buildImageShapes(imageRows) {
    return Promise.all(
      imageRows.map(async (img) => {
        const rawUrl = img.file_url || img.image_url || img.storage_key || null;
        const resolvedUrl = await VehicleService.resolveImageUrl(rawUrl);
        return {
          id: img.id,
          displayOrder: Number(img.display_order || 0),
          isPrimary: Boolean(img.is_primary),
          imageUrl: resolvedUrl,
        };
      })
    );
  }

  /**
   * Search and filter vehicles for customer discovery.
   *
   * @param {object} params — pre-validated by vehicle.validator
   * @returns {Promise<object>} paginated result
   */
  async searchVehicles(params) {
    const {
      city,
      categorySlug,
      brand,
      shopId,
      fuelType,
      transmission,
      minPrice,
      maxPrice,
      minRating,
      sort = SORT_OPTIONS.RELEVANCE,
      page = PAGINATION.DEFAULT_PAGE,
      limit = PAGINATION.DEFAULT_LIMIT,
      startAt,
      endAt,
    } = params;

    // Resolve city name → city ID if city filter is a name string
    // (the validator may have already resolved to cityId if UUID was passed)
    let cityId = params.cityId || null;
    if (city && !cityId) {
      cityId = await this.resolveCityIdByName(city);
      if (!cityId) {
        cityId = city;
      }
    }

    const { rows, total } = await vehicleRepository.searchVehicles({
      categorySlug: categorySlug || null,
      brand: brand || null,
      shopId: shopId || null,
      cityId: cityId || null,
      fuelType: fuelType || null,
      transmission: transmission || null,
      minPrice: minPrice !== undefined ? Number(minPrice) : undefined,
      maxPrice: maxPrice !== undefined ? Number(maxPrice) : undefined,
      minRating: minRating !== undefined ? Number(minRating) : undefined,
      sort,
      page: Number(page),
      limit: Number(limit),
      startAt: startAt || null,
      endAt: endAt || null,
    });

    const vehicles = await Promise.all(
      rows.map(async (row) => {
        const summary = VehicleRepository.mapVehicleSummary(row);
        if (summary.primaryImageUrl && !summary.primaryImageUrl.startsWith('http')) {
          summary.primaryImageUrl = await VehicleService.resolveImageUrl(summary.primaryImageUrl);
        }
        return summary;
      })
    );

    return {
      vehicles,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    };
  }

  /**
   * Resolve a city name to city ID (case-insensitive).
   * Used by the city-name filter pathway.
   *
   * @param {string} cityName
   * @returns {Promise<string|null>}
   */
  async resolveCityIdByName(cityName) {
    try {
      const result = await vehicleRepository.query(
        'SELECT id FROM cities WHERE LOWER(name) = LOWER($1) AND is_active = true LIMIT 1',
        [cityName],
      );
      return result.rows[0] ? result.rows[0].id : null;
    } catch (err) {
      logger.warn('City name resolution failed', { code: err.code || 'DB_ERROR' });
      return null;
    }
  }

  /**
   * Get full public vehicle details by ID.
   *
   * Enforces listing eligibility — returns 404 for:
   *   - Non-existent vehicle
   *   - DRAFT / INACTIVE / REJECTED / SUSPENDED vehicles
   *   - Vehicles from unverified/inactive partners or shops
   *
   * This prevents enumeration of private operational inventory.
   * registration_number and storage_key are NEVER returned.
   *
   * @param {string} vehicleId — pre-validated UUID
   * @returns {Promise<object>}
   * @throws {NotFoundError}
   */
  async getVehicleById(vehicleId) {
    const row = await vehicleRepository.findByIdPublic(vehicleId);
    if (!row) {
      throw new NotFoundError('Vehicle not found', 'VEHICLE_NOT_FOUND');
    }

    // Fetch images separately to avoid N+1 problem
    // (one additional query per detail request, not per row in a list)
    const imageRows = await vehicleRepository.findImagesByVehicleId(vehicleId);
    const images = await VehicleService.buildImageShapes(imageRows);

    const detail = VehicleRepository.mapVehicleDetail(row, images);
    if (detail.primaryImageUrl && !detail.primaryImageUrl.startsWith('http')) {
      detail.primaryImageUrl = await VehicleService.resolveImageUrl(detail.primaryImageUrl);
    }

    return detail;
  }

  /**
   * Get all vehicle categories (cached).
   *
   * @returns {Promise<object[]>}
   */
  async getCategories() {
    const key = VehicleService.cacheKey('categories');
    const cached = await VehicleService.cacheGet(key);
    if (cached) return cached;

    const rows = await vehicleRepository.findAllCategories();
    const categories = rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description || null,
      sortOrder: Number(r.sort_order),
    }));

    await VehicleService.cacheSet(key, categories, CACHE_TTL.CATEGORIES);
    return categories;
  }

  /**
   * Get cities that have at least one eligible/active vehicle (cached).
   *
   * @returns {Promise<object[]>}
   */
  async getCitiesWithVehicles() {
    const key = VehicleService.cacheKey('cities');
    const cached = await VehicleService.cacheGet(key);
    if (cached) return cached;

    const rows = await vehicleRepository.findCitiesWithVehicles();
    const cities = rows.map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state || null,
      countryCode: r.country_code,
    }));

    await VehicleService.cacheSet(key, cities, CACHE_TTL.CITIES);
    return cities;
  }

  /**
   * Nearby vehicle search.
   *
   * Distance is calculated SERVER-SIDE using the Haversine formula.
   * The client-supplied latitude/longitude are validated by the validator;
   * the distance in the response is always computed by the server.
   * The client cannot manipulate the returned distance.
   *
   * Radius is capped at GEO_LIMITS.MAX_RADIUS_KM (100 km).
   *
   * @param {object} params — pre-validated
   * @returns {Promise<object>}
   */
  async getNearbyVehicles(params) {
    const {
      latitude,
      longitude,
      radiusKm = GEO_LIMITS.DEFAULT_RADIUS_KM,
      page = PAGINATION.DEFAULT_PAGE,
      limit = PAGINATION.DEFAULT_LIMIT,
      startAt,
      endAt,
    } = params;

    const { rows, total } = await vehicleRepository.findNearby({
      latitude: Number(latitude),
      longitude: Number(longitude),
      radiusKm: Number(radiusKm),
      page: Number(page),
      limit: Number(limit),
      startAt: startAt || null,
      endAt: endAt || null,
    });

    const vehicles = rows.map((row) => VehicleRepository.mapVehicleSummary(row));

    return {
      vehicles,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    };
  }
}

module.exports = new VehicleService();
