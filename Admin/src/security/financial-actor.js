'use strict';

const { ForbiddenError } = require('../errors');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolves the users.id of the authenticated admin performing a financial action
 * (payout mark-paid/reject, refund approval, wallet adjustment) for processed_by-style
 * audit columns.
 *
 * Only the actor's own identity is used: their UUID if it exists in users, else their
 * email. There is deliberately no "any admin" fallback — recording another person as
 * the actor would corrupt the audit trail. If the actor cannot be resolved the action is
 * refused.
 *
 * @param {import('pg').PoolClient} client Transaction client
 * @param {{ id?: string, email?: string }} adminUser Authenticated actor (req.user)
 * @returns {Promise<string>}
 * @throws {ForbiddenError} when the actor cannot be resolved
 */
async function resolveFinancialActorId(client, adminUser) {
  if (adminUser && typeof adminUser.id === 'string' && UUID_REGEX.test(adminUser.id.trim())) {
    const res = await client.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [adminUser.id.trim()]);
    if (res.rows && res.rows.length > 0) return res.rows[0].id;
  }

  if (adminUser && typeof adminUser.email === 'string' && adminUser.email.trim()) {
    const res = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [adminUser.email.trim()],
    );
    if (res.rows && res.rows.length > 0) return res.rows[0].id;
  }

  throw new ForbiddenError(
    'Unable to attribute this financial action to your administrator account. Please sign in again.',
    'ADMIN_ACTOR_UNRESOLVED',
  );
}

module.exports = { resolveFinancialActorId };
