'use strict';

const partnerValidator = require('../../src/validators/partner.validator');
const { ValidationError } = require('../../src/errors');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Unit: PartnerValidator', () => {
  describe('validateProfileUpdate', () => {
    it('accepts valid profile update with whitelisted fields', () => {
      const input = {
        name: 'Vikram Sharma',
        email: 'vikram@gongo.in',
        profileImage: 'https://images.gongo.in/photo.jpg',
        shopName: 'Apex Wheels & Rentals',
        shopAddress: 'Plot 42, Sector 18, Bhopal',
        city: 'Bhopal',
        operatingInfo: '08:00 AM - 10:00 PM',
      };

      const result = partnerValidator.validateProfileUpdate(input);
      expect(result.name).toBe('Vikram Sharma');
      expect(result.email).toBe('vikram@gongo.in');
      expect(result.profileImageUrl).toBe('https://images.gongo.in/photo.jpg');
      expect(result.shopName).toBe('Apex Wheels & Rentals');
      expect(result.city).toBe('Bhopal');
    });

    it('rejects attempt to update registered mobile number (phone immutability)', () => {
      expect(() => {
        partnerValidator.validateProfileUpdate({
          phone: '+919999988888',
        });
      }).toThrow(ValidationError);

      try {
        partnerValidator.validateProfileUpdate({ phone: '9999988888' });
      } catch (err) {
        expect(err.message).toContain('Phone is tied to authentication identity');
      }
    });

    it('rejects server-controlled fields with MASS_ASSIGNMENT_VIOLATION', () => {
      const maliciousPayloads = [
        { kycStatus: 'VERIFIED' },
        { partnerStatus: 'ONLINE' },
        { rating: 5.0 },
        { reviewCount: 100 },
        { walletBalance: 50000 },
        { commission: 0 },
        { role: 'ADMIN' },
        { isNewPartner: false },
        { registeredSince: '2020-01-01' },
      ];

      maliciousPayloads.forEach((payload) => {
        try {
          partnerValidator.validateProfileUpdate(payload);
          throw new Error('Should have failed');
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
        }
      });
    });

    it('rejects unknown or invalid fields', () => {
      expect(() => {
        partnerValidator.validateProfileUpdate({
          name: 'Vikram',
          unsupportedField: 'hack',
        });
      }).toThrow(ValidationError);
    });

    it('rejects invalid email format', () => {
      expect(() => {
        partnerValidator.validateProfileUpdate({
          email: 'not-an-email',
        });
      }).toThrow(ValidationError);
    });

    it('rejects empty payload', () => {
      expect(() => {
        partnerValidator.validateProfileUpdate({});
      }).toThrow(ValidationError);
    });
  });

  describe('validateShopUpdate', () => {
    it('accepts valid shop update with coordinates', () => {
      const input = {
        shopName: 'Metro Rentals',
        shopAddress: '12 Link Road, Zone 1, Bhopal',
        city: 'Bhopal',
        latitude: 23.2599,
        longitude: 77.4126,
        operatingInfo: '09:00 AM - 09:00 PM',
      };

      const result = partnerValidator.validateShopUpdate(input);
      expect(result.shopName).toBe('Metro Rentals');
      expect(result.latitude).toBe(23.2599);
      expect(result.longitude).toBe(77.4126);
    });

    it('rejects latitude greater than 90 degrees', () => {
      expect(() => {
        partnerValidator.validateShopUpdate({
          latitude: 91.5,
        });
      }).toThrow(ValidationError);
    });

    it('rejects latitude less than -90 degrees', () => {
      expect(() => {
        partnerValidator.validateShopUpdate({
          latitude: -95.0,
        });
      }).toThrow(ValidationError);
    });

    it('rejects longitude greater than 180 degrees', () => {
      expect(() => {
        partnerValidator.validateShopUpdate({
          longitude: 185.0,
        });
      }).toThrow(ValidationError);
    });

    it('accepts and validates locationAccuracy and locationSource', () => {
      const result = partnerValidator.validateShopUpdate({
        latitude: 23.25,
        longitude: 77.41,
        locationAccuracy: 12.5,
        locationSource: 'GPS',
      });
      expect(result.locationAccuracy).toBe(12.5);
      expect(result.locationSource).toBe('GPS');

      const manualResult = partnerValidator.validateShopUpdate({
        latitude: 23.25,
        longitude: 77.41,
        locationAccuracy: null,
        locationSource: 'MANUAL_PIN',
      });
      expect(manualResult.locationAccuracy).toBeNull();
      expect(manualResult.locationSource).toBe('MANUAL_PIN');
    });

    it('rejects invalid locationSource or negative locationAccuracy', () => {
      expect(() => {
        partnerValidator.validateShopUpdate({
          locationSource: 'SATELLITE_INVALID',
        });
      }).toThrow(ValidationError);

      expect(() => {
        partnerValidator.validateShopUpdate({
          locationAccuracy: -5,
        });
      }).toThrow(ValidationError);
    });

    it('rejects longitude less than -180 degrees', () => {
      expect(() => {
        partnerValidator.validateShopUpdate({
          longitude: -181.0,
        });
      }).toThrow(ValidationError);
    });

    it('rejects server-controlled fields in shop update', () => {
      try {
        partnerValidator.validateShopUpdate({
          id: 'shop-uuid-override',
          shopName: 'New Name',
        });
        throw new Error('Should have failed');
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
      }
    });
  });

  describe('validateKycDocument', () => {
    it('accepts valid document metadata for AADHAAR', () => {
      const input = {
        documentType: 'AADHAAR',
        documentNumber: '123456788910',
      };

      const result = partnerValidator.validateKycDocument(input);
      expect(result.documentType).toBe('AADHAAR');
      expect(result.documentNumber).toBe('123456788910');
    });

    it('accepts valid document metadata for PAN', () => {
      const input = {
        documentType: 'PAN',
        documentNumber: 'ABCDE1234F',
      };

      const result = partnerValidator.validateKycDocument(input);
      expect(result.documentType).toBe('PAN');
      expect(result.documentNumber).toBe('ABCDE1234F');
    });

    it('rejects invalid document type', () => {
      expect(() => {
        partnerValidator.validateKycDocument({
          documentType: 'PASSPORT_UNSUPPORTED',
        });
      }).toThrow(ValidationError);
    });

    it('rejects Aadhaar number that does not have 12 digits', () => {
      expect(() => {
        partnerValidator.validateKycDocument({
          documentType: 'AADHAAR',
          documentNumber: '1234',
        });
      }).toThrow(ValidationError);
    });

    it('rejects invalid PAN format', () => {
      expect(() => {
        partnerValidator.validateKycDocument({
          documentType: 'PAN',
          documentNumber: 'INVALIDPAN',
        });
      }).toThrow(ValidationError);
    });

    it('rejects client attempt to inject verificationStatus or kycStatus', () => {
      try {
        partnerValidator.validateKycDocument({
          documentType: 'AADHAAR',
          verificationStatus: 'VERIFIED',
        });
        throw new Error('Should have failed');
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
      }

      try {
        partnerValidator.validateKycDocument({
          documentType: 'AADHAAR',
          kycStatus: 'VERIFIED',
        });
        throw new Error('Should have failed');
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
      }
    });

    it('rejects client attempt to inject storageKey', () => {
      try {
        partnerValidator.validateKycDocument({
          documentType: 'AADHAAR',
          storageKey: 's3://untrusted-bucket/fake.pdf',
        });
        throw new Error('Should have failed');
      } catch (err) {
        expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
      }
    });
  });
});
