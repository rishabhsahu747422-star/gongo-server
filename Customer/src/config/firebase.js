'use strict';

const env = require('./env');
const logger = require('./logger');

let firebaseApp = null;
let firebaseMessaging = null;
let mockFirebaseMessaging = null;
let mockFirebaseAuth = null;

/**
 * Initializes and returns the Firebase Cloud Messaging (FCM) client singleton.
 *
 * Isolated solely for FCM push notifications — NOT executed during application startup.
 * Firebase Admin is only loaded on-demand when FCM functionality is actually requested.
 *
 * In test environment, returns null (or mock if injected via setMockFirebaseMessaging).
 * If credentials are missing or invalid, logs a warning/error and safely returns null
 * so notification services can handle FCM_NOT_INITIALIZED gracefully.
 *
 * @returns {import('firebase-admin/messaging').Messaging|null}
 */
function getFirebaseMessaging() {
  if (mockFirebaseMessaging) {
    return mockFirebaseMessaging;
  }
  if (firebaseMessaging) {
    return firebaseMessaging;
  }

  // Hermetic test environment isolation
  if (env.NODE_ENV === 'test') {
    return null;
  }

  // Verify FCM credentials exist
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    logger.warn('FCM credentials not configured; Firebase Cloud Messaging unavailable');
    return null;
  }

  try {
    // eslint-disable-next-line global-require
    const { initializeApp, cert, getApps, getApp } = require('firebase-admin/app');
    // eslint-disable-next-line global-require
    const { getMessaging } = require('firebase-admin/messaging');

    if (getApps().length > 0) {
      firebaseApp = getApp();
    } else {
      const formattedPrivateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      firebaseApp = initializeApp({
        credential: cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey: formattedPrivateKey,
        }),
      });
    }

    firebaseMessaging = getMessaging(firebaseApp);
    logger.info('Firebase Admin SDK (FCM) initialized successfully');
    return firebaseMessaging;
  } catch (err) {
    logger.error('Failed to initialize Firebase Admin SDK for FCM', {
      name: err.name,
      code: err.code || 'FIREBASE_INIT_ERROR',
      message: err.message,
    });
    return null;
  }
}

/**
 * Allows injecting a mock Firebase Messaging instance for tests.
 * @param {object|null} mockMessaging
 */
function setMockFirebaseMessaging(mockMessaging) {
  mockFirebaseMessaging = mockMessaging;
}

/**
 * Legacy Firebase Auth getter.
 * Firebase Auth is REMOVED from production/dev; Supabase Auth is the identity provider.
 * Returns mock auth in test environments if injected via setMockFirebaseAuth.
 *
 * @returns {object|null}
 */
function getFirebaseAuth() {
  return mockFirebaseAuth;
}

/**
 * Injects a mock Firebase Auth instance for testing, and syncs it with Supabase provider mock.
 * @param {object|null} mockAuth
 */
function setMockFirebaseAuth(mockAuth) {
  mockFirebaseAuth = mockAuth;
  try {
    // Synchronize mock with Supabase provider for backward compatibility in tests
    // eslint-disable-next-line global-require
    const supabaseProvider = require('../providers/supabase');
    if (typeof supabaseProvider.setMockSupabaseAuth === 'function') {
      supabaseProvider.setMockSupabaseAuth(mockAuth);
    }
  } catch (_) {
    // Ignore in case of circular require during test bootstrap
  }
}

module.exports = {
  get firebaseApp() {
    return firebaseApp;
  },
  getFirebaseAuth,
  setMockFirebaseAuth,
  getFirebaseMessaging,
  setMockFirebaseMessaging,
};
