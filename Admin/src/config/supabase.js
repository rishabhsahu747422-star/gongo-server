'use strict';

const { createClient } = require('@supabase/supabase-js');
const env = require('./env');
const logger = require('./logger');

let supabaseClient = null;

/**
 * Initializes and returns the singleton Supabase client.
 * Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 * The service role key is strictly privileged and MUST NEVER be exposed to the client.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
function initSupabase() {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    if (env.isProduction) {
      throw new Error(
        'FATAL STARTUP ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are strictly required in production. Server startup aborted.',
      );
    }

    logger.warn(
      'SUPABASE_SERVICE_ROLE_KEY not supplied. Initializing Supabase client in dev fallback mode. (Check .env configuration)',
    );

    // Development fallback singleton to allow offline / test bootstrapping
    supabaseClient = createClient(
      supabaseUrl || 'https://mtfljykvxyslhdvpfcil.supabase.co',
      serviceRoleKey || env.SUPABASE_ANON_KEY || 'dev-dummy-service-role-key',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
    return supabaseClient;
  }

  supabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  logger.info('Supabase environment configured');
  logger.info('Supabase database client initialized successfully as singleton');
  return supabaseClient;
}

const supabase = initSupabase();

/**
 * Health check probe for Supabase PostgreSQL database connection.
 * @returns {Promise<{ status: string, latencyMs?: number, error?: string }>}
 */
async function checkSupabaseHealth() {
  const start = Date.now();
  try {
    const client = getSupabase();
    // Query users table with limit 1
    const { error } = await client.from('users').select('id').limit(1);
    if (error && error.code !== 'PGRST116') {
      return {
        status: 'DEGRADED',
        latencyMs: Date.now() - start,
        error: error.message,
      };
    }
    return {
      status: 'UP',
      latencyMs: Date.now() - start,
      service: 'supabase-postgresql',
    };
  } catch (err) {
    return {
      status: 'DOWN',
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

function getSupabase() {
  if (!supabaseClient) {
    return initSupabase();
  }
  return supabaseClient;
}

function setMockSupabase(mock) {
  supabaseClient = mock;
}

function resetMockSupabase() {
  supabaseClient = null;
}

module.exports = {
  supabase,
  initSupabase,
  getSupabase,
  checkSupabaseHealth,
  setMockSupabase,
  resetMockSupabase,
};
