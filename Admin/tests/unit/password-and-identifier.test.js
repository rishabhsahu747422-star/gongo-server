'use strict';

const {
  hashPassword, verifyPassword, verifyAgainstDummy, needsRehash, validatePasswordPolicy,
} = require('../../src/utils/password');
const { normalizeLoginIdentifier, normalizeEmail, normalizeMobile } = require('../../src/utils/login-identifier');

describe('Unit: admin password hashing', () => {
  it('hashes with scrypt, salts every hash, and verifies correctly', async () => {
    const a = await hashPassword('Correct#Horse-42');
    const b = await hashPassword('Correct#Horse-42');
    expect(a).toMatch(/^scrypt\$v=1\$N=32768,r=8,p=1\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('Correct#Horse-42');
    expect(await verifyPassword('Correct#Horse-42', a)).toBe(true);
    expect(await verifyPassword('correct#horse-42', a)).toBe(false);
    expect(needsRehash(a)).toBe(false);
  });

  it('rejects malformed, tampered or resource-exhausting hashes', async () => {
    const good = await hashPassword('Correct#Horse-42');
    expect(await verifyPassword('Correct#Horse-42', 'plaintext')).toBe(false);
    expect(await verifyPassword('Correct#Horse-42', good.replace('N=32768', 'N=1048576'))).toBe(false);
    expect(await verifyPassword('Correct#Horse-42', good.replace('N=32768', 'N=1000'))).toBe(false);
    expect(await verifyPassword('', good)).toBe(false);
    expect(await verifyPassword('x'.repeat(300), good)).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('dummy verification always fails', async () => {
    await expect(verifyAgainstDummy('anything')).resolves.toBe(false);
  });

  it('enforces the password policy', () => {
    expect(validatePasswordPolicy('Strong#Pass-2026')).toEqual([]);
    expect(validatePasswordPolicy('short1A!')).not.toEqual([]);
    expect(validatePasswordPolicy('alllowercaseletters')).not.toEqual([]);
    expect(validatePasswordPolicy(undefined)).not.toEqual([]);
  });
});

describe('Unit: admin login identifier normalization', () => {
  it.each([
    ['  GongoRental@Gmail.COM ', { type: 'email', value: 'gongorental@gmail.com' }],
    ['8989232398', { type: 'mobile', value: '8989232398' }],
    ['+91 89892 32398', { type: 'mobile', value: '8989232398' }],
    ['+91-8989-232-398', { type: 'mobile', value: '8989232398' }],
    ['918989232398', { type: 'mobile', value: '8989232398' }],
    ['08989232398', { type: 'mobile', value: '8989232398' }],
  ])('normalizes %p', (input, expected) => {
    expect(normalizeLoginIdentifier(input)).toEqual(expected);
  });

  it.each(['', '   ', 'not-an-email', 'a@b', '12345', '1234567890', '+1 415 555 0100', null, 42, "x' OR '1'='1"])(
    'rejects %p',
    (input) => {
      expect(normalizeLoginIdentifier(input)).toBeNull();
    },
  );

  it('exposes the individual normalizers', () => {
    expect(normalizeEmail('A@B.CO')).toBe('a@b.co');
    expect(normalizeMobile('+919876543210')).toBe('9876543210');
  });
});
