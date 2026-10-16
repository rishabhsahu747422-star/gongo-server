'use strict';

const storageValidator = require('../../src/validators/storage.validator');
const { ValidationError } = require('../../src/errors');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Unit: StorageValidator', () => {
  describe('validatePresignInput', () => {
    it('accepts valid PROFILE_IMAGE payload', () => {
      const input = {
        entityType: 'PROFILE_IMAGE',
        fileName: 'avatar.jpg',
        contentType: 'image/jpeg',
      };

      const res = storageValidator.validatePresignInput(input);
      expect(res.entityType).toBe('PROFILE_IMAGE');
      expect(res.fileName).toBe('avatar.jpg');
      expect(res.contentType).toBe('image/jpeg');
      expect(res.fileExtension).toBe('.jpg');
      expect(res.maxSizeBytes).toBe(5 * 1024 * 1024);
    });

    it('accepts valid KYC_DOCUMENT payload with documentType', () => {
      const input = {
        entityType: 'KYC_DOCUMENT',
        fileName: 'aadhaar_card.pdf',
        contentType: 'application/pdf',
        documentType: 'AADHAAR',
        documentNumber: '123456789012',
      };

      const res = storageValidator.validatePresignInput(input);
      expect(res.entityType).toBe('KYC_DOCUMENT');
      expect(res.fileName).toBe('aadhaar_card.pdf');
      expect(res.contentType).toBe('application/pdf');
      expect(res.documentType).toBe('AADHAAR');
      expect(res.documentNumber).toBe('123456789012');
      expect(res.maxSizeBytes).toBe(10 * 1024 * 1024);
    });

    it('accepts valid VEHICLE_IMAGE payload with vehicleId', () => {
      const input = {
        entityType: 'VEHICLE_IMAGE',
        fileName: 'front_view.png',
        contentType: 'image/png',
        vehicleId: '11111111-1111-1111-1111-111111111111',
        isCover: true,
      };

      const res = storageValidator.validatePresignInput(input);
      expect(res.entityType).toBe('VEHICLE_IMAGE');
      expect(res.fileName).toBe('front_view.png');
      expect(res.contentType).toBe('image/png');
      expect(res.vehicleId).toBe('11111111-1111-1111-1111-111111111111');
      expect(res.isCover).toBe(true);
      expect(res.maxSizeBytes).toBe(10 * 1024 * 1024);
    });

    it('accepts valid VEHICLE_DOCUMENT payload with vehicleId and documentType', () => {
      const input = {
        entityType: 'VEHICLE_DOCUMENT',
        fileName: 'rc_book.pdf',
        contentType: 'application/pdf',
        vehicleId: '11111111-1111-1111-1111-111111111111',
        documentType: 'RC',
        documentNumber: 'MP04AB1234',
      };

      const res = storageValidator.validatePresignInput(input);
      expect(res.entityType).toBe('VEHICLE_DOCUMENT');
      expect(res.fileName).toBe('rc_book.pdf');
      expect(res.contentType).toBe('application/pdf');
      expect(res.vehicleId).toBe('11111111-1111-1111-1111-111111111111');
      expect(res.documentType).toBe('RC');
      expect(res.documentNumber).toBe('MP04AB1234');
      expect(res.maxSizeBytes).toBe(10 * 1024 * 1024);
    });

    it('rejects forbidden entityType', () => {
      expect(() => {
        storageValidator.validatePresignInput({
          entityType: 'BANK_DOCUMENT',
          fileName: 'statement.pdf',
          contentType: 'application/pdf',
        });
      }).toThrow(ValidationError);
    });

    it('rejects path traversal in fileName', () => {
      const badFileNames = [
        '../../etc/passwd.jpg',
        '..\\..\\boot.ini.png',
        '/root/photo.jpg',
        'sub/dir/photo.png',
      ];

      badFileNames.forEach((fileName) => {
        expect(() => {
          storageValidator.validatePresignInput({
            entityType: 'PROFILE_IMAGE',
            fileName,
            contentType: 'image/jpeg',
          });
        }).toThrow(ValidationError);
      });
    });

    it('rejects disallowed file extensions or unsupported MIME types', () => {
      // .exe extension
      expect(() => {
        storageValidator.validatePresignInput({
          entityType: 'PROFILE_IMAGE',
          fileName: 'virus.exe',
          contentType: 'application/octet-stream',
        });
      }).toThrow(ValidationError);

      // pdf not allowed for profile image
      expect(() => {
        storageValidator.validatePresignInput({
          entityType: 'PROFILE_IMAGE',
          fileName: 'profile.pdf',
          contentType: 'application/pdf',
        });
      }).toThrow(ValidationError);
    });

    it('rejects extension and contentType mismatch', () => {
      expect(() => {
        storageValidator.validatePresignInput({
          entityType: 'KYC_DOCUMENT',
          fileName: 'document.pdf',
          contentType: 'image/jpeg',
          documentType: 'PAN',
        });
      }).toThrow(ValidationError);
    });

    it('rejects client attempt to supply server-controlled fields (mass assignment)', () => {
      const maliciousFields = [
        { storageKey: 'partners/other/hacked.jpg' },
        { bucket: 'my-private-bucket' },
        { uploadUrl: 'https://evil.com' },
        { partnerId: '22222222-2222-2222-2222-222222222222' },
        { status: 'COMPLETED' },
        { expiresAt: new Date().toISOString() },
      ];

      maliciousFields.forEach((malicious) => {
        try {
          storageValidator.validatePresignInput({
            entityType: 'PROFILE_IMAGE',
            fileName: 'avatar.jpg',
            contentType: 'image/jpeg',
            ...malicious,
          });
          throw new Error('Should have thrown ValidationError');
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
        }
      });
    });

    it('rejects KYC_DOCUMENT without documentType', () => {
      expect(() => {
        storageValidator.validatePresignInput({
          entityType: 'KYC_DOCUMENT',
          fileName: 'doc.pdf',
          contentType: 'application/pdf',
        });
      }).toThrow(ValidationError);
    });

    it('rejects VEHICLE_IMAGE without valid vehicleId', () => {
      expect(() => {
        storageValidator.validatePresignInput({
          entityType: 'VEHICLE_IMAGE',
          fileName: 'car.jpg',
          contentType: 'image/jpeg',
        });
      }).toThrow(ValidationError);

      expect(() => {
        storageValidator.validatePresignInput({
          entityType: 'VEHICLE_IMAGE',
          fileName: 'car.jpg',
          contentType: 'image/jpeg',
          vehicleId: 'non-uuid-string',
        });
      }).toThrow(ValidationError);
    });
  });

  describe('validateCompleteInput', () => {
    it('accepts valid uploadId', () => {
      const res = storageValidator.validateCompleteInput({
        uploadId: '11111111-1111-1111-1111-111111111111',
      });
      expect(res.uploadId).toBe('11111111-1111-1111-1111-111111111111');
    });

    it('rejects non-UUID uploadId', () => {
      expect(() => {
        storageValidator.validateCompleteInput({
          uploadId: 'invalid-id',
        });
      }).toThrow(ValidationError);
    });

    it('rejects missing uploadId', () => {
      expect(() => {
        storageValidator.validateCompleteInput({});
      }).toThrow(ValidationError);
    });

    it('rejects mass assignment payload', () => {
      expect(() => {
        storageValidator.validateCompleteInput({
          uploadId: '11111111-1111-1111-1111-111111111111',
          status: 'COMPLETED',
        });
      }).toThrow(ValidationError);
    });
  });

  describe('validateAccessUrlInput', () => {
    it('accepts valid storageKey', () => {
      const res = storageValidator.validateAccessUrlInput({
        storageKey: 'partners/11111111-1111-1111-1111-111111111111/profile/pic.jpg',
      });
      expect(res.storageKey).toBe('partners/11111111-1111-1111-1111-111111111111/profile/pic.jpg');
    });

    it('rejects path traversal in storageKey', () => {
      expect(() => {
        storageValidator.validateAccessUrlInput({
          storageKey: '../secret/file.txt',
        });
      }).toThrow(ValidationError);
    });

    it('rejects empty storageKey', () => {
      expect(() => {
        storageValidator.validateAccessUrlInput({
          storageKey: '   ',
        });
      }).toThrow(ValidationError);
    });
  });
});
