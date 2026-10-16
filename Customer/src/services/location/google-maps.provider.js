'use strict';

const https = require('https');
const LocationProvider = require('./location.provider');
const env = require('../../config/env');
const { ServiceUnavailableError } = require('../../errors');
const { logger } = require('../../config');

/**
 * GoogleMapsProvider — concrete LocationProvider backed by the Google Maps
 * Geocoding API.
 *
 * Security rules:
 *   - The API key is read from env.GOOGLE_MAPS_API_KEY at instantiation time
 *     and is NEVER logged, serialised, or returned in any response.
 *   - No API key = no geocoding; the provider throws immediately rather than
 *     making an anonymous request that would silently fail or expose usage.
 *   - All network errors are mapped to ServiceUnavailableError so callers
 *     receive a consistent, safe error with no internal details.
 */
class GoogleMapsProvider extends LocationProvider {
  constructor() {
    super();
    this._apiKey = env.GOOGLE_MAPS_API_KEY;
  }

  /**
   * Makes a HTTPS GET request to the given URL and resolves with parsed JSON.
   *
   * @param {string} url
   * @returns {Promise<object>}
   */
  _get(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new ServiceUnavailableError(
              'Geocoding service returned an unexpected response',
              'GEOCODING_PARSE_ERROR',
            ));
          }
        });
      }).on('error', () => {
        reject(new ServiceUnavailableError(
          'Geocoding service is temporarily unavailable',
          'GEOCODING_UNAVAILABLE',
        ));
      });
    });
  }

  /**
   * Geocodes an address string into coordinates using the Google Maps API.
   *
   * @param {string} address
   * @returns {Promise<{latitude: number, longitude: number, formattedAddress: string}>}
   */
  async geocode(address) {
    if (!this._apiKey) {
      throw new ServiceUnavailableError(
        'Geocoding is not configured on this server',
        'GEOCODING_NOT_CONFIGURED',
      );
    }

    const encoded = encodeURIComponent(address);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${this._apiKey}`;

    let result;
    try {
      result = await this._get(url);
    } catch (err) {
      logger.warn('Google Maps geocode request failed', { error: err.message });
      throw err instanceof ServiceUnavailableError ? err : new ServiceUnavailableError(
        'Geocoding service is temporarily unavailable',
        'GEOCODING_UNAVAILABLE',
      );
    }

    if (result.status !== 'OK' || !result.results || result.results.length === 0) {
      logger.warn('Google Maps geocode returned no results', { status: result.status });
      throw new ServiceUnavailableError(
        'Could not geocode the provided address',
        'GEOCODING_NO_RESULTS',
      );
    }

    const { lat, lng } = result.results[0].geometry.location;
    return {
      latitude: lat,
      longitude: lng,
      formattedAddress: result.results[0].formatted_address,
    };
  }

  /**
   * Reverse geocodes coordinates into a human-readable address.
   *
   * @param {number} latitude
   * @param {number} longitude
   * @returns {Promise<{formattedAddress: string, components: object}>}
   */
  async reverseGeocode(latitude, longitude) {
    if (!this._apiKey) {
      throw new ServiceUnavailableError(
        'Geocoding is not configured on this server',
        'GEOCODING_NOT_CONFIGURED',
      );
    }

    const url = [
      'https://maps.googleapis.com/maps/api/geocode/json',
      `?latlng=${latitude},${longitude}&key=${this._apiKey}`,
    ].join('');

    let result;
    try {
      result = await this._get(url);
    } catch (err) {
      logger.warn('Google Maps reverse geocode request failed', { error: err.message });
      throw err instanceof ServiceUnavailableError ? err : new ServiceUnavailableError(
        'Geocoding service is temporarily unavailable',
        'GEOCODING_UNAVAILABLE',
      );
    }

    if (result.status !== 'OK' || !result.results || result.results.length === 0) {
      logger.warn('Google Maps reverse geocode returned no results', { status: result.status });
      throw new ServiceUnavailableError(
        'Could not resolve the provided coordinates to an address',
        'REVERSE_GEOCODING_NO_RESULTS',
      );
    }

    const top = result.results[0];
    const components = {};
    (top.address_components || []).forEach((c) => {
      (c.types || []).forEach((t) => {
        components[t] = c.long_name;
      });
    });

    return {
      formattedAddress: top.formatted_address,
      components,
    };
  }
}

module.exports = GoogleMapsProvider;
