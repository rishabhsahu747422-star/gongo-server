'use strict';

/**
 * Idempotent initial Super Admin provisioning.
 *
 *   npm run db:seed:super-admin                       # create/verify account, grant SUPER_ADMIN
 *   npm run db:seed:super-admin -- --dry-run          # show what would happen, then roll back
 *   npm run db:seed:super-admin -- --confirm-user-id=<uuid>
 *       (explicitly promote/reactivate an existing account)
 *
 * Initial password (only used when the account has no password yet; never overwrites one):
 *   SUPER_ADMIN_INITIAL_PASSWORD='<strong password>' npm run db:seed:super-admin
 * Set it only for this one command, then clear it from your shell/history. It is never
 * printed or logged, and the admin must change it at first login.
 */

require('dotenv').config();

const { pool } = require('../src/db/pool');
const { seedSuperAdmin, SUPER_ADMIN_ACCOUNT } = require('../src/db/seeds/super-admin.seed');

function parseArgs(argv) {
  const args = { dryRun: false, confirmUserId: null };
  argv.forEach((arg) => {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--confirm-user-id=')) args.confirmUserId = arg.slice('--confirm-user-id='.length).trim();
    else throw new Error(`Unknown argument: ${arg}`);
  });
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}
Usage: npm run db:seed:super-admin -- [--dry-run] [--confirm-user-id=<uuid>]
`);
    process.exitCode = 1;
    await pool.end().catch(() => {});
    return;
  }
  const initialPassword = process.env.SUPER_ADMIN_INITIAL_PASSWORD || null;
  delete process.env.SUPER_ADMIN_INITIAL_PASSWORD;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await seedSuperAdmin(client, {
      initialPassword,
      confirmUserId: args.confirmUserId,
    });
    await client.query(args.dryRun ? 'ROLLBACK' : 'COMMIT');

    process.stdout.write([
      `Super Admin seed${args.dryRun ? ' (DRY RUN — rolled back)' : ''}:`,
      `  email:      ${SUPER_ADMIN_ACCOUNT.email}`,
      `  user id:    ${result.userId}`,
      `  account:    ${result.account}`,
      `  permission: SUPER_ADMIN ${result.permission}`,
      `  password:   ${result.password}`,
      ...result.notes.map((n) => `  note:       ${n}`),
      '',
    ].join('\n'));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    process.stderr.write(`Super Admin seed failed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

main();
