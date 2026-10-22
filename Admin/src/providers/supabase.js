'use strict';

const { createClient } = require('@supabase/supabase-js');
const env = require('../config/env');
const logger = require('../config/logger');

const { getSupabase, setMockSupabase, resetMockSupabase } = require('../config/supabase');

function getSupabaseClient() {
  return getSupabase();
}

function setMockSupabaseClient(mockClient) {
  setMockSupabase(mockClient);
}

function resetSupabaseClient() {
  resetMockSupabase();
}

/**
 * Verifies an email + password pair against Supabase Auth.
 * Used only for the one-time migration of admins whose password still lives in
 * Supabase Auth (see AdminAuthService._tryLegacySupabaseMigration).
 * Uses a throwaway client so the shared service-role client never adopts a user session.
 *
 * @param {object} params
 * @param {string} params.email
 * @param {string} params.password
 * @returns {Promise<{ valid: boolean, userId: string|null }>}
 */
async function verifyPasswordCredentials({ email, password }) {
  if (!email || !password) {
    return { valid: false, userId: null };
  }

  try {
    // Tests inject mocks through the shared client; real runs use an isolated client
    const authClient = env.NODE_ENV === 'test'
      ? getSupabaseClient()
      : createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error || !data?.user) {
      return { valid: false, userId: null };
    }
    return { valid: true, userId: data.user.id };
  } catch (err) {
    logger.warn('Supabase password verification failed', { error: err.message });
    return { valid: false, userId: null };
  }
}

module.exports = {
  getSupabaseClient,
  getSupabaseAdmin: getSupabaseClient,
  setMockSupabaseClient,
  resetSupabaseClient,
  verifyPasswordCredentials,
};
