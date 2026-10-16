'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

/**
 * Runs callback within an execution context preserving correlation IDs and route metadata.
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

module.exports = {
  asyncLocalStorage,
  runWithContext,
  getContext,
  getRequestId,
};
