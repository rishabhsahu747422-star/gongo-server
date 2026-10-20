'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { BadRequestError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');

// Maximum allowed file sizes
const MAX_FILE_SIZES = {
  IMAGE: 5 * 1024 * 1024,   // 5 MB
  GIF: 10 * 1024 * 1024,    // 10 MB
  VIDEO: 25 * 1024 * 1024,  // 25 MB
};

/**
 * Checks if an IPv4 or IPv6 address is in a private, loopback, or reserved range.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateOrReservedIp(ip) {
  if (!ip) return true;

  // Normalize IPv6 mapped IPv4 (e.g. ::ffff:127.0.0.1)
  const normalized = ip.startsWith('::ffff:') ? ip.replace('::ffff:', '') : ip;

  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    // 0.0.0.0/8 (broadcast/current network)
    if (parts[0] === 0) return true;
    // 10.0.0.0/8 (private)
    if (parts[0] === 10) return true;
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (link-local, cloud metadata)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12 (private)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 (private)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 224.0.0.0/4 (multicast)
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIPv6(normalized)) {
    const lower = normalized.toLowerCase();
    // ::1 loopback
    if (lower === '::1' || lower === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
    // :: unspecified
    if (lower === '::') return true;
    // fc00::/7 (unique local address)
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // fe80::/10 (link-local)
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    return false;
  }

  return true;
}

/**
 * Validates a remote URL and guards against SSRF attacks.
 * @param {string} urlStr
 * @param {object} [options]
 * @param {boolean} [options.allowLocalhost=false]
 * @returns {Promise<URL>}
 */
async function validateRemoteUrl(urlStr, { allowLocalhost = false } = {}) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new BadRequestError('Asset URL is required and must be a string', ERROR_CODES.VALIDATION_ERROR);
  }

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new BadRequestError('Invalid asset URL format', ERROR_CODES.VALIDATION_ERROR);
  }

  const protocol = parsed.protocol.toLowerCase();
  const allowedProtocols = process.env.NODE_ENV === 'production' ? ['https:'] : ['http:', 'https:'];
  if (!allowedProtocols.includes(protocol)) {
    throw new BadRequestError(
      `Disallowed URL protocol '${protocol}'. Only HTTPS is permitted.`,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // Explicitly check for cloud metadata / localhost strings
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'metadata.google.internal' ||
    hostname === '169.254.169.254' ||
    hostname === 'instance-data'
  ) {
    if (!allowLocalhost) {
      throw new BadRequestError('Access to internal or private hosts is prohibited', ERROR_CODES.FORBIDDEN);
    }
  }

  // Resolve hostname DNS to check IP range if not in test mock mode
  if (!allowLocalhost && process.env.NODE_ENV !== 'test') {
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      for (const addr of addresses) {
        if (isPrivateOrReservedIp(addr.address)) {
          throw new BadRequestError(
            `Destination '${hostname}' resolves to restricted IP '${addr.address}'`,
            ERROR_CODES.FORBIDDEN,
          );
        }
      }
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      throw new BadRequestError(`Unable to resolve host '${hostname}': ${err.message}`, ERROR_CODES.VALIDATION_ERROR);
    }
  }

  return parsed;
}

/**
 * Detects the actual file type from binary buffer using magic bytes.
 * @param {Buffer} buffer
 * @returns {{ assetType: 'IMAGE'|'GIF'|'VIDEO', mimeType: string, extension: string }}
 */
function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    throw new BadRequestError('File content is empty or too small to inspect', ERROR_CODES.VALIDATION_ERROR);
  }

  // 1. JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { assetType: 'IMAGE', mimeType: 'image/jpeg', extension: 'jpg' };
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A
  ) {
    return { assetType: 'IMAGE', mimeType: 'image/png', extension: 'png' };
  }

  // 3. GIF: 47 49 46 38 (GIF87a or GIF89a)
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { assetType: 'GIF', mimeType: 'image/gif', extension: 'gif' };
  }

  // 4. WebP: 52 49 46 46 (RIFF) ... 57 45 42 50 (WEBP)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { assetType: 'IMAGE', mimeType: 'image/webp', extension: 'webp' };
  }

  // 5. MP4: Byte 4-7 are 'ftyp' (0x66, 0x74, 0x79, 0x70)
  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return { assetType: 'VIDEO', mimeType: 'video/mp4', extension: 'mp4' };
  }

  throw new BadRequestError(
    'Unsupported file format. Allowed formats: JPEG, PNG, WebP, animated GIF, or MP4 video.',
    ERROR_CODES.VALIDATION_ERROR,
  );
}

/**
 * Validates file buffer against expected asset type and size limits.
 * @param {Buffer} buffer
 * @param {string} [expectedAssetType]
 * @returns {{ assetType: 'IMAGE'|'GIF'|'VIDEO', mimeType: string, extension: string, contentHash: string }}
 */
function validateFileBuffer(buffer, expectedAssetType) {
  const detected = detectFileType(buffer);

  if (expectedAssetType && detected.assetType !== expectedAssetType.toUpperCase()) {
    throw new BadRequestError(
      `File format mismatch: Detected '${detected.assetType}' (${detected.mimeType}) but requested type is '${expectedAssetType}'.`,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  const maxSize = MAX_FILE_SIZES[detected.assetType];
  if (buffer.length > maxSize) {
    const maxMb = Math.round(maxSize / (1024 * 1024));
    throw new BadRequestError(
      `File size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds maximum allowed limit of ${maxMb} MB for ${detected.assetType}.`,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    ...detected,
    contentHash,
    size: buffer.length,
  };
}

module.exports = {
  MAX_FILE_SIZES,
  isPrivateOrReservedIp,
  validateRemoteUrl,
  detectFileType,
  validateFileBuffer,
};
