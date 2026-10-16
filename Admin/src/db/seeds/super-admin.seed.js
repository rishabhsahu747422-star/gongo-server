'use strict';

const { hashPassword, validatePasswordPolicy } = require('../../utils/password');
const { normalizeEmail, normalizeMobile } = require('../../utils/login-identifier');

/**
 * Canonical initial Super Admin. Only these exact values are provisioned, and only by an
 * operator running this seed — never at runtime because a login happens to match them.
 */
const SUPER_ADMIN_ACCOUNT = Object.freeze({
  email: normalizeEmail('gongorental@gmail.com'),
  mobile: normalizeMobile('8989232398'),
  name: 'GONGO Super Admin',
  role: 'super_admin',
});

const SUPER_ADMIN_PERMISSION = 'SUPER_ADMIN';

class SeedConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedConflictError';
  }
}

const PHONE_MATCH_SQL = "regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') IN ($1, '91' || $1, '0' || $1)";

/**
 * Idempotently provisions the initial Super Admin inside the caller's transaction.
 *
 * Safety rules:
 * - An existing account is only promoted or re-activated when the operator passes its exact
 *   id as confirmUserId; matching email/mobile alone never grants anything.
 * - The mobile number is never taken from, or written over, another account.
 * - An existing password is never overwritten. A password is only set when none exists and
 *   initialPassword is provided; it is stored as a scrypt hash and must be changed at first login.
 *
 * @param {import('pg').PoolClient} client Client with an open transaction
 * @param {object} [options]
 * @param {string|null} [options.initialPassword]
 * @param {string|null} [options.confirmUserId]
 * @returns {Promise<{
 *   userId: string, account: string, permission: string, password: string, notes: string[]
 * }>}
 */
async function seedSuperAdmin(client, { initialPassword = null, confirmUserId = null } = {}) {
  const { email, mobile, name, role } = SUPER_ADMIN_ACCOUNT;
  const notes = [];

  const byEmail = (await client.query(
    `SELECT id, role, phone, status, is_active FROM users
     WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
    [email],
  )).rows;
  if (byEmail.length > 1) {
    throw new SeedConflictError(`Multiple accounts use ${email}; resolve the duplicates manually first.`);
  }
  const byPhone = (await client.query(
    `SELECT id FROM users WHERE ${PHONE_MATCH_SQL} AND deleted_at IS NULL`,
    [mobile],
  )).rows;

  let user = byEmail[0] || null;
  const phoneOwnedElsewhere = byPhone.some((row) => !user || row.id !== user.id);
  if (phoneOwnedElsewhere) {
    throw new SeedConflictError(
      'The Super Admin mobile number already belongs to a different account; resolve it manually '
      + `(account id(s): ${byPhone.map((r) => r.id).join(', ')}).`,
    );
  }

  let account;
  if (!user) {
    const inserted = await client.query(
      `INSERT INTO users (email, phone, name, role, status, is_active, auth_provider)
       VALUES ($1, $2, $3, $4, 'active', true, 'admin_password')
       RETURNING id, role, phone, status, is_active`,
      [email, mobile, name, role],
    );
    [user] = inserted.rows;
    account = 'created';
  } else {
    const currentRole = String(user.role || '').toLowerCase();
    const isActive = String(user.status || 'active').toLowerCase() === 'active' && user.is_active !== false;
    const needsPromotion = currentRole !== role;
    const needsActivation = !isActive;

    if ((needsPromotion || needsActivation) && confirmUserId !== user.id) {
      const change = needsPromotion ? `promote it from role '${currentRole}' to '${role}'` : 'reactivate it';
      throw new SeedConflictError(
        `An existing account (${user.id}) uses ${email}. Refusing to ${change} automatically. `
        + `If this is the intended Super Admin account, re-run with --confirm-user-id=${user.id}`,
      );
    }
    if (needsPromotion) {
      await client.query('UPDATE users SET role = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id, role]);
      notes.push(`role changed from '${currentRole}' to '${role}' (confirmed by operator)`);
    }
    if (needsActivation) {
      await client.query(
        "UPDATE users SET status = 'active', is_active = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [user.id],
      );
      notes.push('account reactivated (confirmed by operator)');
    }
    if (!user.phone) {
      await client.query('UPDATE users SET phone = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id, mobile]);
      notes.push('mobile number added');
    } else if (normalizeMobile(String(user.phone)) !== mobile) {
      notes.push('existing account has a different mobile number; left unchanged');
    }
    account = needsPromotion || needsActivation ? 'updated' : 'unchanged';
  }

  const hasPermission = (await client.query(
    'SELECT 1 FROM admin_permissions WHERE user_id = $1 AND permission = $2',
    [user.id, SUPER_ADMIN_PERMISSION],
  )).rows.length > 0;
  if (!hasPermission) {
    await client.query(
      `INSERT INTO admin_permissions (user_id, permission)
       VALUES ($1, $2)
       ON CONFLICT (user_id, permission) DO NOTHING`,
      [user.id, SUPER_ADMIN_PERMISSION],
    );
  }
  const permission = hasPermission ? 'already present' : 'granted';

  const credential = (await client.query(
    'SELECT user_id FROM admin_credentials WHERE user_id = $1',
    [user.id],
  )).rows[0];

  let password;
  if (credential) {
    password = 'existing password preserved';
  } else if (initialPassword) {
    const problems = validatePasswordPolicy(initialPassword);
    if (problems.length > 0) {
      throw new SeedConflictError(`SUPER_ADMIN_INITIAL_PASSWORD rejected: ${problems.join('; ')}`);
    }
    const passwordHash = await hashPassword(initialPassword);
    const inserted = await client.query(
      `INSERT INTO admin_credentials (user_id, password_hash, must_change_password)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id`,
      [user.id, passwordHash],
    );
    password = inserted.rows.length > 0
      ? 'initial password set (must be changed at first login)'
      : 'existing password preserved';
  } else {
    password = 'not set — provide SUPER_ADMIN_INITIAL_PASSWORD and re-run to set it';
  }

  return { userId: user.id, account, permission, password, notes };
}

module.exports = {
  seedSuperAdmin,
  SeedConflictError,
  SUPER_ADMIN_ACCOUNT,
};
