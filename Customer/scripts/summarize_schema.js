const fs = require('fs');
const schema = JSON.parse(fs.readFileSync('scripts/supabase_schema.json', 'utf8'));

let output = '';

output += '=== ENUMS ===\n';
const enumsByName = {};
for (const e of schema.enums) {
  if (!enumsByName[e.enum_name]) enumsByName[e.enum_name] = [];
  enumsByName[e.enum_name].push(e.enum_value);
}
output += JSON.stringify(enumsByName, null, 2) + '\n\n';

output += '=== STORAGE BUCKETS ===\n';
output += JSON.stringify(schema.storageBuckets, null, 2) + '\n\n';

const keyTables = [
  'users',
  'customer_profiles',
  'customer_documents',
  'customer_identity_verifications',
  'customer_saved_addresses',
  'vehicles',
  'vehicle_categories',
  'vehicle_brands',
  'vehicle_models',
  'vehicle_pricing',
  'vehicle_pricing_rules',
  'vehicle_availability',
  'vehicle_images',
  'shops',
  'partners',
  'bookings',
  'booking_items',
  'booking_price_breakdown',
  'booking_customer_details',
  'booking_status_history',
  'booking_cancellations',
  'cancellation_policies',
  'payments',
  'payment_attempts',
  'payment_transactions',
  'refunds',
  'reviews',
  'coupons',
  'coupon_redemptions',
  'notifications',
  'support_tickets',
  'support_messages'
];

for (const tbl of keyTables) {
  output += `\n================ TABLE: ${tbl} ================\n`;
  const cols = schema.columns.filter(c => c.table_name === tbl);
  const pks = schema.primaryAndUniqueKeys.filter(k => k.table_name === tbl);
  const fks = schema.foreignKeys.filter(k => k.table_name === tbl);
  const checks = schema.checks.filter(c => c.table_name === tbl);

  output += 'COLUMNS:\n';
  for (const c of cols) {
    const nullable = c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
    const def = c.column_default ? ` DEFAULT ${c.column_default}` : '';
    output += `  - ${c.column_name}: ${c.udt_name} (${nullable})${def}\n`;
  }
  if (pks.length) {
    output += 'KEYS:\n';
    for (const k of pks) {
      output += `  - ${k.constraint_type}: ${k.constraint_name} (${k.column_name})\n`;
    }
  }
  if (fks.length) {
    output += 'FOREIGN KEYS:\n';
    for (const f of fks) {
      output += `  - ${f.column_name} -> ${f.foreign_table_name}(${f.foreign_column_name}) onDel=${f.delete_rule}\n`;
    }
  }
}

fs.writeFileSync('scripts/schema_summary.md', output, 'utf8');
console.log('Written to scripts/schema_summary.md');
