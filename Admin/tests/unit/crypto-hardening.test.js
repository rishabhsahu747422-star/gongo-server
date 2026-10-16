'use strict';

const crypto = require('crypto');
const {
  encrypt,
  decrypt,
  generateSecureToken,
  hashSessionToken,
  timingSafeEqual,
} = require('../../src/utils/crypto');

describe('Unit: Cryptographic Safety & Authenticated Encryption', () => {
  const validKey = crypto.randomBytes(32);
  const hexKey = validKey.toString('hex');
  const samplePlaintext = 'Confidential Admin Secret Payload: 12345';

  describe('1. Authenticated Encryption (AES-256-GCM)', () => {
    it('encrypts and decrypts roundtrip successfully with Buffer key', () => {
      const ciphertext = encrypt(samplePlaintext, validKey);
      expect(typeof ciphertext).toBe('string');
      expect(ciphertext.split(':')).toHaveLength(3);

      const decrypted = decrypt(ciphertext, validKey);
      expect(decrypted).toBe(samplePlaintext);
    });

    it('encrypts and decrypts roundtrip successfully with 64-char hex key', () => {
      const ciphertext = encrypt(samplePlaintext, hexKey);
      const decrypted = decrypt(ciphertext, hexKey);
      expect(decrypted).toBe(samplePlaintext);
    });

    it('generates random IV for each encryption call (zero static IV reuse)', () => {
      const cipher1 = encrypt(samplePlaintext, validKey);
      const cipher2 = encrypt(samplePlaintext, validKey);

      expect(cipher1).not.toBe(cipher2);

      const iv1 = cipher1.split(':')[0];
      const iv2 = cipher2.split(':')[0];
      expect(iv1).not.toBe(iv2);
    });

    it('fails decryption and throws safe error when ciphertext is tampered with', () => {
      const ciphertext = encrypt(samplePlaintext, validKey);
      const parts = ciphertext.split(':');
      // Tamper with the ciphertext byte
      const tamperedBytes = Buffer.from(parts[2], 'hex');
      tamperedBytes[0] = tamperedBytes[0] === 0 ? 1 : 0;
      const tamperedPayload = `${parts[0]}:${parts[1]}:${tamperedBytes.toString('hex')}`;

      expect(() => {
        decrypt(tamperedPayload, validKey);
      }).toThrow(/Decryption failed: invalid ciphertext, wrong key, or tampered payload/);
    });

    it('fails decryption and throws safe error when auth tag is tampered with', () => {
      const ciphertext = encrypt(samplePlaintext, validKey);
      const parts = ciphertext.split(':');
      // Tamper with the auth tag
      const tamperedTag = Buffer.from(parts[1], 'hex');
      tamperedTag[0] = tamperedTag[0] === 0 ? 1 : 0;
      const tamperedPayload = `${parts[0]}:${tamperedTag.toString('hex')}:${parts[2]}`;

      expect(() => {
        decrypt(tamperedPayload, validKey);
      }).toThrow(/Decryption failed/);
    });

    it('fails decryption when decrypted with a different key', () => {
      const ciphertext = encrypt(samplePlaintext, validKey);
      const wrongKey = crypto.randomBytes(32);

      expect(() => {
        decrypt(ciphertext, wrongKey);
      }).toThrow(/Decryption failed/);
    });

    it('rejects keys with invalid lengths', () => {
      const shortKey = crypto.randomBytes(16); // 128-bit key is rejected (requires 256-bit)
      expect(() => {
        encrypt(samplePlaintext, shortKey);
      }).toThrow(/Encryption key must be exactly 32 bytes/);

      expect(() => {
        decrypt('iv:tag:data', shortKey);
      }).toThrow(/Encryption key must be exactly 32 bytes/);
    });

    it('rejects missing or non-string ciphertext payloads', () => {
      expect(() => decrypt(null, validKey)).toThrow(/Encrypted payload must be a non-empty string/);
      expect(() => decrypt('', validKey)).toThrow(/Encrypted payload must be a non-empty string/);
      expect(() => decrypt('invalid-format', validKey)).toThrow(/Malformed encrypted payload format/);
    });
  });

  describe('2. Secure Token Generation & Session Hashing', () => {
    it('generates cryptographically random tokens with proper byte lengths', () => {
      const token1 = generateSecureToken(32);
      const token2 = generateSecureToken(32);

      expect(typeof token1).toBe('string');
      expect(token1).toHaveLength(64); // 32 bytes = 64 hex chars
      expect(token1).not.toBe(token2);
    });

    it('hashes session tokens consistently using SHA-256', () => {
      const token = 'session-secret-token-xyz';
      const hash1 = hashSessionToken(token);
      const hash2 = hashSessionToken(token);

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(token);
    });

    it('rejects empty or invalid session tokens in hashSessionToken', () => {
      expect(() => hashSessionToken('')).toThrow(/Session token must be a non-empty string/);
      expect(() => hashSessionToken(null)).toThrow(/Session token must be a non-empty string/);
    });
  });

  describe('3. Timing-Safe Comparison', () => {
    it('returns true for identical strings and false for differing strings', () => {
      const strA = 'admin_secret_signature_9876';
      const strB = 'admin_secret_signature_9876';
      const strC = 'admin_secret_signature_9875';

      expect(timingSafeEqual(strA, strB)).toBe(true);
      expect(timingSafeEqual(strA, strC)).toBe(false);
    });

    it('safely handles strings of unequal length without throwing exceptions', () => {
      expect(timingSafeEqual('short', 'much_longer_string')).toBe(false);
      expect(timingSafeEqual(null, 'abc')).toBe(false);
    });
  });
});
