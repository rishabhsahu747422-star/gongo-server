const fs = require('fs');
const schema = JSON.parse(fs.readFileSync('scripts/supabase_schema.json', 'utf8'));

console.log('=== CHECK CONSTRAINTS ===');
for (const c of schema.checks) {
  console.log(`${c.table_name}.${c.constraint_name}: ${c.check_clause}`);
}
