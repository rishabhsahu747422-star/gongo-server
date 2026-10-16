'use strict';

/**
 * LocationProvider — abstract interface for geocoding services.
 *
 * All concrete providers (Google Maps, HERE, Mapbox, etc.) must extend this
 * class and implement its methods.
 *
 * This abstraction ensures:
 *   1. The controller and service layers are never coupled to a specific vendor.
 *   2. Providers can be swapped or stubbed in tests without any application changes.
 *   3. API keys are handled exclusively within the concrete provider class and
 *      NEVER surface to controllers or HTTP responses.
 */
class LocationProvider {
  /**
   * Geocodes a human-readable address into coordinates.
   *
   * @param {string} address - Full address string to geocode
   * @returns {Promise<{latitude: number, longitude: number, formattedAddress: string}>}
   * @throws {Error} Subclasses must throw ServiceUnavailableError on failure
   * @abstract
   */
  // eslint-disable-next-line no-unused-vars
  async geocode(address) {
    throw new Error('LocationProvider.geocode() must be implemented by subclass');
  }

  /**
   * Reverse geocodes coordinates into a human-readable address.
   *
   * @param {number} latitude
   * @param {number} longitude
   * @returns {Promise<{formattedAddress: string, components: object}>}
   * @throws {Error} Subclasses must throw ServiceUnavailableError on failure
   * @abstract
   */
  // eslint-disable-next-line no-unused-vars
  async reverseGeocode(latitude, longitude) {
    throw new Error('LocationProvider.reverseGeocode() must be implemented by subclass');
  }
}

module.exports = LocationProvider;
