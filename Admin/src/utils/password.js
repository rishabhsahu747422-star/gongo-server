'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

/**
 * Admin password hashing (scrypt, Node.js built-in — no native dependency).
 *
 * Stored format: scrypt$v=1$N=<N>,r=<r>,p=<p>$<salt b64>$<hash b64>
 * Parameters live in the hash so they can be raised later without invalidating
 * existing hashes (see needsRehash).
 */
const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1 });
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs 128 * N * r bytes; the Node default (32 MiB) is exactly at the limit for N=2^15.
const MAX_MEMORY = 128 * 1024 * 1024;

const PASSWORD_MIN_LENGTH = 12;
// Upper bound keeps hashing cost predictable for hostile input.
const PASSWORD_MAX_LENGTH = 256;

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {{N: number, r: number, p: number}} params
 * @returns {Promise<Buffer>}
 */
function derive(password, salt, params) {
  return scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEMORY,
  });
}

/**
 * Hashes a plaintext password. The plaintext is never persisted or logged.
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$v=1$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Parses a stored hash; returns null for anything malformed or with out-of-range parameters.
 *
 * @param {string} stored
 * @returns {{ params: {N: number, r: number, p: number}, salt: Buffer, key: Buffer }|null}
 */
function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'scrypt' || parts[1] !== 'v=1') return null;

  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[2]);
  if (!match) return null;
  const params = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  // Bound parameters so a tampered row cannot make verification exhaust memory/CPU.
  // eslint-disable-next-line no-bitwise
  const isPowerOfTwo = params.N > 1 && (params.N & (params.N - 1)) === 0;
  const inBounds = params.N <= 2 ** 17 && params.r >= 1 && params.r <= 16
    && params.p >= 1 && params.p <= 4;
  if (!isPowerOfTwo || !inBounds) {
    return null;
  }

  const salt = Buffer.from(parts[3], 'base64');
  const key = Buffer.from(parts[4], 'base64');
  if (salt.length < 16 || key.length !== KEY_LENGTH) return null;
  return { params, salt, key };
}

/**
 * Verifies a plaintext password against a stored hash in constant time.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX_LENGTH) {
    return false;
  }
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.params);
  return crypto.timingSafeEqual(candidate, parsed.key);
}

/**
 * @param {string} stored
 * @returns {boolean} true when the hash uses weaker parameters than the current policy
 */
function needsRehash(stored) {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.params.N < SCRYPT_PARAMS.N || parsed.params.r < SCRYPT_PARAMS.r;
}

let dummyHashPromise = null;

/**
 * Burns the same work as a real verification. Used when no account/credential exists so
 * response timing does not reveal whether an identifier is registered.
 *
 * @param {string} password
 * @returns {Promise<false>}
 */
async function verifyAgainstDummy(password) {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(24).toString('hex'));
  }
  const dummy = await dummyHashPromise;
  await verifyPassword(typeof password === 'string' && password ? password : 'x', dummy);
  return false;
}

/**
 * Validates a new password against the admin password policy.
 *
 * @param {string} password
 * @returns {string[]} list of policy violations (empty when valid)
 */
function validatePasswordPolicy(password) {
  const problems = [];
  if (typeof password !== 'string') {
    return ['Password must be a string'];
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    problems.push('Password must contain at least three of: lowercase, uppercase, digit, symbol');
  }
  return problems;
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  needsRehash,
  validatePasswordPolicy,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
};
