'use strict';

const fs = require('fs');
const path = require('path');
const { getSupabaseClient } = require('../src/providers/supabase');
const { pool } = require('../src/db/pool');

async function seedCustomerBanners() {
  const supabase = getSupabaseClient();
  const bucket = 'gongo-uploads';

  const banners = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Your City. Your Ride.',
      subtitle: 'Premium rides for every journey across your city.',
      tag: 'INSTANT SELF-DRIVE FLEET',
      filePath: path.resolve(__dirname, '../../../frontend/Customer/src/assets/images/gongo-hero-bg.png'),
      storageName: 'banners/seed_hero_fleet.png',
      contentType: 'image/png',
      displayOrder: 1,
      ctaLabel: 'Book Now',
      ctaDestination: 'VehicleListScreen',
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      title: 'Make Every Journey Yours.',
      subtitle: 'Find the right self-drive car for your trip.',
      tag: 'CARS & ROAD TRIPS',
      filePath: path.resolve(__dirname, '../../../frontend/Customer/src/assets/images/hero/banner_car.jpg'),
      storageName: 'banners/seed_hero_car.jpg',
      contentType: 'image/jpeg',
      displayOrder: 2,
      ctaLabel: 'Explore Cars',
      ctaDestination: 'CAR',
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      title: 'Your Next Ride Awaits.',
      subtitle: 'Explore freely on two wheels across your city.',
      tag: 'BIKE ADVENTURES',
      filePath: path.resolve(__dirname, '../../../frontend/Customer/src/assets/images/hero/banner_bike.jpg'),
      storageName: 'banners/seed_hero_bike.jpg',
      contentType: 'image/jpeg',
      displayOrder: 3,
      ctaLabel: 'Rent a Bike',
      ctaDestination: 'BIKE',
    },
  ];

  for (const b of banners) {
    if (!fs.existsSync(b.filePath)) {
      console.warn('File not found:', b.filePath);
      continue;
    }

    const buf = fs.readFileSync(b.filePath);
    console.log(`Uploading ${b.storageName} (${buf.length} bytes)...`);

    const { error: uploadError } = await supabase.storage.from(bucket).upload(b.storageName, buf, {
      contentType: b.contentType,
      upsert: true,
    });

    if (uploadError) {
      console.error(`Upload error for ${b.storageName}:`, uploadError.message);
    } else {
      console.log(`Uploaded ${b.storageName}`);
    }

    const { data: pubData } = supabase.storage.from(bucket).getPublicUrl(b.storageName);
    const pubUrl = pubData.publicUrl;

    const res = await pool.query(
      `
      INSERT INTO home_banners (
        id, title, subtitle, tag, asset_type, asset_url, storage_path,
        version, content_hash, is_active, display_order, cta_label, cta_destination,
        metadata, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'IMAGE', $5, $6,
        '1', 'seed_hash', true, $7, $8, $9,
        '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        subtitle = EXCLUDED.subtitle,
        tag = EXCLUDED.tag,
        asset_url = EXCLUDED.asset_url,
        storage_path = EXCLUDED.storage_path,
        display_order = EXCLUDED.display_order,
        cta_label = EXCLUDED.cta_label,
        cta_destination = EXCLUDED.cta_destination,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, title, display_order, is_active;
      `,
      [
        b.id,
        b.title,
        b.subtitle,
        b.tag,
        pubUrl,
        b.storageName,
        b.displayOrder,
        b.ctaLabel,
        b.ctaDestination,
      ]
    );

    console.log('Seeded in DB:', res.rows[0]);
  }

  await pool.end();
}

if (require.main === module) {
  seedCustomerBanners()
    .then(() => {
      console.log('Seeding complete.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}

module.exports = { seedCustomerBanners };
