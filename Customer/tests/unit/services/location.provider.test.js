'use strict';

const LocationProvider = require('../../../src/services/location/location.provider');
const GoogleMapsProvider = require('../../../src/services/location/google-maps.provider');

describe('LocationProvider (abstract interface)', () => {
  it('throws when geocode() is called directly on the base class', async () => {
    const provider = new LocationProvider();
    await expect(provider.geocode('some address')).rejects.toThrow(
      'LocationProvider.geocode() must be implemented by subclass',
    );
  });

  it('throws when reverseGeocode() is called directly on the base class', async () => {
    const provider = new LocationProvider();
    await expect(provider.reverseGeocode(0, 0)).rejects.toThrow(
      'LocationProvider.reverseGeocode() must be implemented by subclass',
    );
  });
});

describe('GoogleMapsProvider', () => {
  it('is a subclass of LocationProvider', () => {
    const provider = new GoogleMapsProvider();
    expect(provider).toBeInstanceOf(LocationProvider);
  });

  describe('geocode() without API key', () => {
    let provider;

    beforeEach(() => {
      // GoogleMapsProvider reads the key at construction time; override for test
      provider = new GoogleMapsProvider();
      provider._apiKey = ''; // Simulate unconfigured key
    });

    it('throws ServiceUnavailableError when API key is not configured', async () => {
      await expect(provider.geocode('123 Test Street')).rejects.toMatchObject({
        code: 'GEOCODING_NOT_CONFIGURED',
      });
    });
  });

  describe('reverseGeocode() without API key', () => {
    it('throws ServiceUnavailableError when API key is not configured', async () => {
      const provider = new GoogleMapsProvider();
      provider._apiKey = '';

      await expect(provider.reverseGeocode(19.076, 72.877)).rejects.toMatchObject({
        code: 'GEOCODING_NOT_CONFIGURED',
      });
    });
  });

  describe('_get() parsing failure', () => {
    it('throws ServiceUnavailableError on malformed JSON response', async () => {
      const provider = new GoogleMapsProvider();
      provider._apiKey = 'fake-key';

      // Simulate the _get method returning bad JSON
      provider._get = jest.fn().mockRejectedValue(
        Object.assign(new Error('Geocoding service returned an unexpected response'), {
          code: 'GEOCODING_PARSE_ERROR',
        }),
      );

      await expect(provider.geocode('123 Test St')).rejects.toMatchObject({
        message: expect.stringContaining('Geocoding'),
      });
    });
  });

  describe('geocode() API status handling', () => {
    it('throws ServiceUnavailableError when API status is not OK', async () => {
      const provider = new GoogleMapsProvider();
      provider._apiKey = 'fake-key';
      provider._get = jest.fn().mockResolvedValue({ status: 'ZERO_RESULTS', results: [] });

      await expect(provider.geocode('Nonexistent Address 99999')).rejects.toMatchObject({
        code: 'GEOCODING_NO_RESULTS',
      });
    });

    it('returns lat/lng and formattedAddress on OK response', async () => {
      const provider = new GoogleMapsProvider();
      provider._apiKey = 'fake-key';
      provider._get = jest.fn().mockResolvedValue({
        status: 'OK',
        results: [
          {
            geometry: { location: { lat: 19.076, lng: 72.877 } },
            formatted_address: '123 Test Street, Mumbai, Maharashtra, India',
          },
        ],
      });

      const result = await provider.geocode('123 Test Street Mumbai');
      expect(result).toEqual({
        latitude: 19.076,
        longitude: 72.877,
        formattedAddress: '123 Test Street, Mumbai, Maharashtra, India',
      });
    });
  });

  describe('reverseGeocode() API status handling', () => {
    it('throws ServiceUnavailableError when API status is not OK', async () => {
      const provider = new GoogleMapsProvider();
      provider._apiKey = 'fake-key';
      provider._get = jest.fn().mockResolvedValue({ status: 'INVALID_REQUEST', results: [] });

      await expect(provider.reverseGeocode(999, 999)).rejects.toMatchObject({
        code: 'REVERSE_GEOCODING_NO_RESULTS',
      });
    });

    it('returns formattedAddress and components on OK response', async () => {
      const provider = new GoogleMapsProvider();
      provider._apiKey = 'fake-key';
      provider._get = jest.fn().mockResolvedValue({
        status: 'OK',
        results: [
          {
            formatted_address: '123 Test Street, Mumbai, Maharashtra, India',
            address_components: [
              { long_name: 'Mumbai', types: ['locality', 'political'] },
              { long_name: 'Maharashtra', types: ['administrative_area_level_1'] },
            ],
          },
        ],
      });

      const result = await provider.reverseGeocode(19.076, 72.877);
      expect(result.formattedAddress).toBe('123 Test Street, Mumbai, Maharashtra, India');
      expect(result.components.locality).toBe('Mumbai');
      expect(result.components.administrative_area_level_1).toBe('Maharashtra');
    });
  });
});
