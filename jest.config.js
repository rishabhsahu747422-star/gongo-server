'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/tests/**/*.test.js',
  ],
  setupFiles: [
    '<rootDir>/tests/setup.js',
  ],
  globalSetup: '<rootDir>/tests/setup.js',
  verbose: true,
  forceExit: true,
  testTimeout: 15000,
};
