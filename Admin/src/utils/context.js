'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

/**
 * Runs callback within an execution context preserving correlation IDs.
 *
 * @param {object} context
 * @param {Function} callback
 * @returns {*}
 */
function runWithContext(context, callback) {
  return asyncLocalStorage.run(context, callback);
}

/**
 * Gets current execution context.
 *
 * @returns {object|undefined}
 */
function getContext() {
  return asyncLocalStorage.getStore();
}

/**
 * Extracts active request ID from context if available.
 *
 * @returns {string|null}
 */
function getRequestId() {
  const store = asyncLocalStorage.getStore();
  return store && store.requestId ? store.requestId : null;
}

/**
 * Extracts active route from context if available.
 *
 * @returns {string|null}
 */
function getRoute() {
  const store = asyncLocalStorage.getStore();
  return store && store.route ? store.route : null;
}

module.exports = {
  asyncLocalStorage,
  runWithContext,
  getContext,
  getRequestId,
  getRoute,
};
