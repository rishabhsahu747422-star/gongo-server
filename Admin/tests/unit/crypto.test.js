'use strict';

const { sha256, maskString } = require('../../src/utils/crypto');

describe('Unit: Crypto & Masking Utilities', () => {
  it('generates consistent sha256 hex string', () => {
    const hash1 = sha256('test-payload');
    const hash2 = sha256('test-payload');
    const hash3 = sha256('other-payload');

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toHaveLength(64);
  });

  it('masks string showing only last 4 characters', () => {
    expect(maskString('1234567890')).toBe('******7890');
    expect(maskString('1234')).toBe('****');
    expect(maskString('')).toBe('');
    expect(maskString(null)).toBe('');
  });
});
