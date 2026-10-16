'use strict';

const BaseRepository = require('../../src/db/base.repository');
const { ConflictError, NotFoundError } = require('../../src/errors');

describe('Unit: BaseRepository', () => {
  let repo;

  beforeEach(() => {
    repo = new BaseRepository('test_table', 'id');
  });

  it('translates Postgres error code 23505 to ConflictError', () => {
    const pgErr = new Error('Unique violation');
    pgErr.code = '23505';

    expect(() => {
      repo.handleDbError(pgErr, 'Test operation');
    }).toThrow(ConflictError);
  });

  it('translates Postgres error code 23503 to NotFoundError', () => {
    const pgErr = new Error('FK violation');
    pgErr.code = '23503';

    expect(() => {
      repo.handleDbError(pgErr, 'Test operation');
    }).toThrow(NotFoundError);
  });

  it('rethrows unexpected database errors unmodified', () => {
    const pgErr = new Error('Generic DB crash');
    pgErr.code = '58000';

    expect(() => {
      repo.handleDbError(pgErr, 'Test operation');
    }).toThrow(pgErr);
  });

  it('executes findById using client if provided', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: '123', name: 'Test' }] }),
    };

    const row = await repo.findById('123', mockClient);

    expect(row).toEqual({ id: '123', name: 'Test' });
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM test_table WHERE id = $1 LIMIT 1'),
      ['123'],
    );
  });

  it('executes findOneBy using client if provided', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: '456', email: 'test@gongo.in' }] }),
    };

    const row = await repo.findOneBy('email', 'test@gongo.in', mockClient);

    expect(row).toEqual({ id: '456', email: 'test@gongo.in' });
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM test_table WHERE email = $1 LIMIT 1'),
      ['test@gongo.in'],
    );
  });
});
