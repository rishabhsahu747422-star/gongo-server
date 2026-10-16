'use strict';

const http = require('http');
const setupEnv = require('../setup');

// Initialize test environment variables before requiring any application modules
setupEnv();

// Polyfill minimal jest mock functions when running outside jest runner
if (typeof global.jest === 'undefined') {
  global.jest = {
    fn: (impl) => {
      let currentImpl = impl || (() => {});
      const wrapper = (...args) => currentImpl(...args);
      wrapper.mockImplementation = (fn) => {
        currentImpl = fn;
        return wrapper;
      };
      wrapper.mockResolvedValue = (val) => {
        currentImpl = async () => val;
        return wrapper;
      };
      return wrapper;
    },
  };
}

const { setupE2EEnvironment, signPayload } = require('../integration/e2e/e2e-helper');

/**
 * Boots a dedicated, isolated HTTP server for load and performance testing.
 * Runs on an ephemeral local port with zero live third-party dependencies.
 *
 * @returns {Promise<{
 *   server: http.Server,
 *   port: number,
 *   baseUrl: string,
 *   db: any,
 *   createCustomer: Function,
 *   signPayload: Function,
 *   capturedFCM: Array,
 *   close: () => Promise<void>
 * }>}
 */
async function startLoadTestServer() {
  const env = await setupE2EEnvironment();
  const { app } = env;

  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const close = () => new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  return {
    ...env,
    server,
    port,
    baseUrl,
    close,
  };
}

module.exports = {
  startLoadTestServer,
  signPayload,
};
