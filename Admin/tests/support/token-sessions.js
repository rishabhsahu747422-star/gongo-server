'use strict';

const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const userRepository = require('../../src/repositories/user.repository');
const { hashSessionToken } = require('../../src/utils/crypto');

/**
 * Maps fixed test tokens to admin sessions so suites can call protected routes with
 * `Authorization: Bearer <token>` exactly as the Admin Portal does after login.
 *
 * @param {Record<string, { user: object|null, expired?: boolean, revoked?: boolean }>} tokens
 */
function installTokenSessions(tokens) {
  const sessions = new Map();
  const users = new Map();
  Object.entries(tokens).forEach(([token, spec], i) => {
    const hash = hashSessionToken(token);
    sessions.set(hash, {
      id: `session-${i + 1}`,
      user_id: spec.user ? spec.user.id : `missing-user-${i}`,
      session_token: hash,
      is_active: !spec.revoked,
      expires_at: new Date(Date.now() + (spec.expired ? -60000 : 3600000)).toISOString(),
      last_active_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
    if (spec.user) users.set(spec.user.id, spec.user);
  });

  adminSessionRepository.constructor.setMockSessionResolver({
    findByToken: async (hash) => sessions.get(hash) || null,
    touchSession: async () => true,
  });
  jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
    const user = users.get(id);
    if (!user) return null;
    return { ...user, permissions: user.permissions ? [...user.permissions] : undefined };
  });

  return () => adminSessionRepository.constructor.resetMockSessionResolver();
}

module.exports = { installTokenSessions };
