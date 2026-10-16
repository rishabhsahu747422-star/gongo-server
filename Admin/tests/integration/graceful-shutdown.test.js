'use strict';

const { createApp } = require('../../src/app');
const { gracefulShutdown } = require('../../src/server');
const { disconnectDatabase } = require('../../src/db/pool');
const { disconnectRedis } = require('../../src/providers/redis');

jest.mock('../../src/db/pool', () => {
  const actual = jest.requireActual('../../src/db/pool');
  return {
    ...actual,
    disconnectDatabase: jest.fn().mockResolvedValue(),
  };
});

jest.mock('../../src/providers/redis', () => {
  const actual = jest.requireActual('../../src/providers/redis');
  return {
    ...actual,
    disconnectRedis: jest.fn().mockResolvedValue(),
  };
});

describe('Integration: Graceful Shutdown Lifecycle', () => {
  let app;
  let server;

  beforeEach((done) => {
    app = createApp();
    server = app.listen(0, () => {
      done();
    });
  });

  afterEach((done) => {
    if (server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  it('executes graceful shutdown closing connections cleanly without throwing', async () => {
    // Call gracefulShutdown with shouldExit=false to prevent killing the test runner process
    await expect(gracefulShutdown('SIGTERM', false)).resolves.not.toThrow();

    expect(disconnectRedis).toHaveBeenCalled();
    expect(disconnectDatabase).toHaveBeenCalled();
  });
});
