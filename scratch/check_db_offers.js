'use strict';
require('dotenv').config({ path: 'server/.env' });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  try {
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND (table_name LIKE '%offer%' OR table_name LIKE '%coupon%' OR table_name LIKE '%promo%');
    `);
    console.log('--- MATCHING TABLES ---');
    console.log(tables.rows);

    for (const t of tables.rows) {
      const tableName = t.table_name;
      const count = await pool.query(`SELECT COUNT(*) FROM "${tableName}"`);
      console.log(`\n--- COUNT IN ${tableName}: ${count.rows[0].count} ---`);

      const cols = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = '${tableName}'
      `);
      console.log(`COLUMNS in ${tableName}:`, cols.rows.map(c => `${c.column_name} (${c.data_type})`));

      const rows = await pool.query(`SELECT * FROM "${tableName}" LIMIT 10`);
      console.log(`ROWS in ${tableName}:`, JSON.stringify(rows.rows, null, 2));
    }
  } catch (err) {
    console.error('Error querying DB:', err);
  } finally {
    await pool.end();
  }
}

run();
