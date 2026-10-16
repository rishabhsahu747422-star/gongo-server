'use strict';

const BaseRepository = require('../db/base.repository');
const { createPresignedDownloadUrl } = require('../providers/supabase-storage');
const logger = require('../config/logger');

let mockPublicVehicleResolver = null;

class PublicVehicleRepository extends BaseRepository {
  constructor() {
    super('vehicles', 'id');
  }

  static setMockResolver(resolver) {
    mockPublicVehicleResolver = resolver;
  }

  static resetMockResolver() {
    mockPublicVehicleResolver = null;
  }

  async getCategories() {
    if (mockPublicVehicleResolver && mockPublicVehicleResolver.getCategories) {
      return mockPublicVehicleResolver.getCategories();
    }

    const sql = `
      SELECT
        id,
        name,
        COALESCE(code, UPPER(name)) AS slug,
        description
      FROM vehicle_categories
      WHERE is_active = true
      ORDER BY name ASC;
    `;
    const res = await this.query(sql);
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: (r.slug || '').toUpperCase(),
      description: r.description || null,
    }));
  }

  async getCities() {
    if (mockPublicVehicleResolver && mockPublicVehicleResolver.getCities) {
      return mockPublicVehicleResolver.getCities();
    }

    const sql = `
      SELECT DISTINCT
        COALESCE(c.id, sh.id) AS id,
        COALESCE(c.name, sh.city) AS name,
        COALESCE(sh.city, c.name) AS state,
        'IN' AS country_code
      FROM shops sh
      JOIN vehicles v ON v.shop_id = sh.id
        AND (v.is_archived IS NOT TRUE)
      JOIN partners p ON p.id = sh.partner_id
        AND p.is_active = true
        AND (p.status IS NULL OR LOWER(p.status) NOT IN ('suspended', 'deactivated', 'rejected'))
      LEFT JOIN cities c ON c.id = sh.city_id
      WHERE sh.is_active = true AND COALESCE(c.name, sh.city) IS NOT NULL
      ORDER BY name ASC;
    `;
    const res = await this.query(sql);
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state || null,
      countryCode: r.country_code || 'IN',
    }));
  }

  async searchVehicles({
    vehicleType = 'all',
    city = 'all',
    pickupDate = null,
    page = 1,
    limit = 20,
  } = {}) {
    if (mockPublicVehicleResolver && mockPublicVehicleResolver.searchVehicles) {
      return mockPublicVehicleResolver.searchVehicles({ vehicleType, city, pickupDate, page, limit });
    }

    const conditions = [
      'v.is_archived IS NOT TRUE',
      '(v.manual_status IS NULL OR UPPER(v.manual_status) != \'OFFLINE\')',
      '(v.status IN (\'active\', \'pending\') OR v.verification_status IN (\'VERIFIED\', \'APPROVED\', \'verified\', \'approved\') OR v.is_active = true)',
      'sh.is_active = true',
      'p.is_active = true',
      '(p.status IS NULL OR LOWER(p.status) NOT IN (\'suspended\', \'deactivated\', \'rejected\'))',
    ];

    const values = [];
    let idx = 1;

    // City filter
    if (city && city !== 'all' && typeof city === 'string' && city.trim()) {
      const sanitizedCity = city.trim().replace(/([%_\\])/g, '\\$1');
      conditions.push(`(sh.city ILIKE $${idx} OR c.name ILIKE $${idx} OR p.city ILIKE $${idx})`);
      values.push(`%${sanitizedCity}%`);
      idx += 1;
    }

    // Vehicle Type filter
    if (vehicleType && vehicleType !== 'all' && typeof vehicleType === 'string' && vehicleType.trim()) {
      const vt = vehicleType.trim().toLowerCase();
      if (vt === 'bike' || vt === 'bikes' || vt === 'motorcycle' || vt === 'motorcycles') {
        conditions.push(`(UPPER(vc.code) IN ('BIKE', 'MOTORCYCLE') OR v.category ILIKE '%bike%')`);
      } else if (vt === 'scooter' || vt === 'scooters' || vt === 'scooty') {
        conditions.push(`(UPPER(vc.code) IN ('SCOOTY', 'SCOOTER') OR v.category ILIKE '%scoot%' OR v.variant ILIKE '%scoot%')`);
      } else if (vt === 'car' || vt === 'cars') {
        conditions.push(`(UPPER(vc.code) = 'CAR' OR v.category ILIKE '%car%')`);
      } else if (vt === 'ev' || vt === 'electric') {
        conditions.push(`(UPPER(vc.code) = 'EV' OR v.fuel_type ILIKE 'electric%' OR v.category ILIKE '%ev%')`);
      } else {
        const sanitizedType = vt.replace(/([%_\\])/g, '\\$1');
        conditions.push(`(vc.code ILIKE $${idx} OR vc.name ILIKE $${idx} OR v.category ILIKE $${idx})`);
        values.push(`%${sanitizedType}%`);
        idx += 1;
      }
    }

    // Date Availability filter
    if (pickupDate && typeof pickupDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
      const startAtStr = `${pickupDate} 00:00:00+05:30`;
      const endAtStr = `${pickupDate} 23:59:59.999+05:30`;

      // 1. Exclude vehicles with active overlapping bookings
      conditions.push(`
        NOT EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.vehicle_id = v.id
            AND b.status IN ('CONFIRMED', 'ACTIVE', 'IN_PROGRESS', 'UPCOMING', 'BOOKED')
            AND b.start_at < $${idx + 1}::timestamptz
            AND (b.end_at + interval '1 hour') > $${idx}::timestamptz
        )
      `);

      // 2. Exclude vehicles with active overlapping availability blocks
      conditions.push(`
        NOT EXISTS (
          SELECT 1 FROM vehicle_availability_blocks vab
          WHERE vab.vehicle_id = v.id
            AND vab.is_active = true
            AND vab.start_time < $${idx + 1}::timestamptz
            AND vab.end_time > $${idx}::timestamptz
        )
      `);

      values.push(startAtStr, endAtStr);
      idx += 2;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Total count
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM vehicles v
      JOIN shops sh ON sh.id = v.shop_id
      JOIN partners p ON p.id = sh.partner_id
      LEFT JOIN vehicle_models vm ON vm.id = v.model_id
      LEFT JOIN vehicle_brands vb ON vb.id = vm.brand_id
      LEFT JOIN vehicle_categories vc ON (vc.id = vm.category_id OR vc.code = UPPER(v.category) OR UPPER(vc.name) = UPPER(v.category))
      LEFT JOIN cities c ON c.id = sh.city_id
      ${whereClause};
    `;
    const countRes = await this.query(countSql, values);
    const total = countRes.rows[0] ? countRes.rows[0].total : 0;

    // Paginated list
    const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const offset = (safePage - 1) * safeLimit;

    const listSql = `
      SELECT
        v.id,
        COALESCE(CONCAT(v.brand, ' ', v.model), v.vehicle_description, 'GONGO Vehicle') AS vehicle_name,
        COALESCE(vb.name, v.brand, 'GONGO') AS brand,
        COALESCE(vm.name, v.model, 'Model') AS model,
        COALESCE(v.manufacture_year, v.year) AS year,
        COALESCE(vc.code, UPPER(v.category), 'BIKE') AS category_slug,
        COALESCE(vc.name, v.category, 'Bike') AS category_name,
        COALESCE(v.fuel_type, 'PETROL') AS fuel_type,
        COALESCE(v.transmission, 'MANUAL') AS transmission,
        COALESCE(v.seats, CASE WHEN LOWER(v.category) = 'car' THEN 5 ELSE 2 END) AS seats,
        COALESCE(vp.price_per_day, vp.price, 899)::numeric AS price_per_day,
        COALESCE(vp.price_per_hour, (vp.price / 10.0), 99)::numeric AS price_per_hour,
        COALESCE(vp.security_deposit, 1000)::numeric AS security_deposit,
        COALESCE(c.name, sh.city, p.city) AS city,
        COALESCE(sh.name, sh.shop_name, p.business_name) AS shop_name,
        COALESCE(p.rating, 5.0)::numeric AS rating_avg,
        COALESCE(p.review_count, 0)::int AS rating_count,
        COALESCE(v.is_available, true) AS is_available,
        COALESCE(v.verification_status, 'VERIFIED') AS verification_status,
        (v.verification_status IN ('VERIFIED', 'APPROVED', 'verified', 'approved')) AS is_verified,
        v.primary_image_url,
        (
          SELECT COALESCE(vi.file_url, vi.image_url, vi.storage_key)
          FROM vehicle_images vi
          WHERE vi.vehicle_id = v.id AND (vi.is_active = true OR vi.is_active IS NULL)
          ORDER BY COALESCE(vi.is_cover, false) DESC, vi.is_primary DESC, COALESCE(vi.sort_order, vi.display_order, 0) ASC
          LIMIT 1
        ) AS fallback_image_url,
        v.created_at
      FROM vehicles v
      JOIN shops sh ON sh.id = v.shop_id
      JOIN partners p ON p.id = sh.partner_id
      LEFT JOIN vehicle_models vm ON vm.id = v.model_id
      LEFT JOIN vehicle_brands vb ON vb.id = vm.brand_id
      LEFT JOIN vehicle_categories vc ON (vc.id = vm.category_id OR vc.code = UPPER(v.category) OR UPPER(vc.name) = UPPER(v.category))
      LEFT JOIN cities c ON c.id = sh.city_id
      LEFT JOIN vehicle_pricing vp ON (vp.vehicle_id = v.id AND vp.is_active = true)
      ${whereClause}
      ORDER BY v.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1};
    `;

    const listRes = await this.query(listSql, [...values, safeLimit, offset]);

    const vehicles = await Promise.all(
      listRes.rows.map(async (row) => {
        let imageUrl = row.primary_image_url || row.fallback_image_url || null;
        if (imageUrl && !imageUrl.startsWith('http')) {
          try {
            const bucket = imageUrl.startsWith('partners/') ? 'gongo-partner-documents' : 'gongo-uploads';
            const res = await createPresignedDownloadUrl({ bucket, path: imageUrl, expiresInSeconds: 86400 });
            if (res?.downloadUrl) {
              imageUrl = res.downloadUrl;
            }
          } catch (err) {
            logger.warn('Failed to presign vehicle image in public search', { error: err.message, key: imageUrl });
          }
        }

        return {
          id: row.id,
          vehicleName: row.vehicle_name,
          brand: row.brand,
          model: row.model,
          year: row.year ? Number(row.year) : null,
          category: row.category_slug,
          categoryName: row.category_name,
          fuelType: row.fuel_type,
          transmission: row.transmission,
          seats: Number(row.seats || 2),
          pricePerDay: Number(row.price_per_day || 0),
          pricePerHour: Number(row.price_per_hour || 0),
          securityDeposit: Number(row.security_deposit || 0),
          city: row.city,
          shopName: row.shop_name,
          ratingAvg: Number(row.rating_avg || 5.0),
          ratingCount: Number(row.rating_count || 0),
          isAvailable: true,
          isVerified: Boolean(row.is_verified),
          primaryImageUrl: imageUrl,
          createdAt: row.created_at,
        };
      })
    );

    return {
      vehicles,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }
}

module.exports = new PublicVehicleRepository();
