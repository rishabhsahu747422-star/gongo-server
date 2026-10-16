'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/server.js', // Entry point — not unit-testable
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  // Load .env.test before tests (falls back to .env.example values via defaults)
  globalSetup: './tests/setup.js',
  verbose: true,
};
