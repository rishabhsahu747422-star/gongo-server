'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96 bits recommended for GCM
const AUTH_TAG_LENGTH_BYTES = 16; // 128 bits
const KEY_LENGTH_BYTES = 32; // 256 bits

/**
 * Normalizes and validates a 256-bit encryption key.
 *
 * @param {string|Buffer} secretKey
 * @returns {Buffer}
 */
function normalizeKey(secretKey) {
  if (!secretKey) {
    throw new Error('Encryption key is required');
  }

  let keyBuffer;
  if (Buffer.isBuffer(secretKey)) {
    keyBuffer = secretKey;
  } else if (typeof secretKey === 'string') {
    if (secretKey.length === 64 && /^[0-9a-fA-F]+$/.test(secretKey)) {
      keyBuffer = Buffer.from(secretKey, 'hex');
    } else {
      keyBuffer = Buffer.from(secretKey, 'utf8');
    }
  } else {
    throw new Error('Encryption key must be a string or Buffer');
  }

  if (keyBuffer.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `Encryption key must be exactly ${KEY_LENGTH_BYTES} bytes (256 bits). `
      + `Received ${keyBuffer.length} bytes.`,
    );
  }

  return keyBuffer;
}

/**
 * Creates SHA-256 hash of a string.
 * @param {string} data
 * @returns {string} Hex hash
 */
function sha256(data) {
  return crypto.createHash('sha256').update(String(data)).digest('hex');
}

/**
 * Hashes a session token for safe persistence.
 * Prevents session hijacking even if database records are exposed.
 * @param {string} token
 * @returns {string} Hex hash
 */
function hashSessionToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Session token must be a non-empty string');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Generates a cryptographically secure random token string.
 * @param {number} [byteLength=32] Number of random bytes
 * @returns {string} Hex-encoded random token
 */
function generateSecureToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Performs timing-safe comparison of two strings.
 * Prevents timing attacks on token/hash verification.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Authenticated Encryption using AES-256-GCM.
 * Never uses static IV or unauthenticated modes.
 *
 * @param {string} plaintext Plaintext string to encrypt
 * @param {string|Buffer} secretKey 256-bit encryption key
 * @returns {string} Encrypted payload formatted as `iv:authTag:ciphertext` (all hex)
 */
function encrypt(plaintext, secretKey) {
  if (typeof plaintext !== 'string') {
    throw new Error('Plaintext must be a string');
  }

  const key = normalizeKey(secretKey);
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Authenticated Decryption using AES-256-GCM.
 * Validates authentication tag and throws on tampering or incorrect key.
 *
 * @param {string} encryptedPayload Encrypted string in `iv:authTag:ciphertext` format
 * @param {string|Buffer} secretKey 256-bit encryption key
 * @returns {string} Decrypted plaintext string
 */
function decrypt(encryptedPayload, secretKey) {
  const key = normalizeKey(secretKey);

  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    throw new Error('Encrypted payload must be a non-empty string');
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload format. Expected iv:authTag:ciphertext');
  }

  const [ivHex, authTagHex, cipherHex] = parts;
  if (!ivHex || !authTagHex || !cipherHex) {
    throw new Error('Malformed encrypted payload: missing component');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(cipherHex, 'hex');

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error(`Invalid IV length. Expected ${IV_LENGTH_BYTES} bytes`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error(`Invalid authentication tag length. Expected ${AUTH_TAG_LENGTH_BYTES} bytes`);
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error('Decryption failed: invalid ciphertext, wrong key, or tampered payload');
  }
}

/**
 * Masks sensitive identifiers (e.g. phone, email, Aadhaar, PAN)
 * @param {string} value
 * @returns {string} Masked string
 */
function maskString(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= 4) return '****';
  const visible = value.slice(-4);
  return `${'*'.repeat(value.length - 4)}${visible}`;
}

module.exports = {
  sha256,
  hashSessionToken,
  generateSecureToken,
  timingSafeEqual,
  encrypt,
  decrypt,
  maskString,
};
