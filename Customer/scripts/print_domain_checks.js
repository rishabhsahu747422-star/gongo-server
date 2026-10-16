const fs = require('fs');
const schema = JSON.parse(fs.readFileSync('scripts/supabase_schema.json', 'utf8'));

const targets = [
  'bookings',
  'booking_cancellations',
  'payments',
  'payment_attempts',
  'payment_transactions',
  'refunds',
  'reviews',
  'coupons',
  'customer_documents',
  'customer_saved_addresses',
  'customer_profiles',
  'users',
  'support_tickets'
];

for (const c of schema.checks) {
  if (targets.includes(c.table_name) && !c.constraint_name.includes('_not_null')) {
    console.log(`${c.table_name}.${c.constraint_name}: ${c.check_clause}`);
  }
}
