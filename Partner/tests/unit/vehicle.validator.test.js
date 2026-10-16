'use strict';

const vehicleValidator = require('../../src/validators/vehicle.validator');
const { ValidationError } = require('../../src/errors');
const { ERROR_CODES } = require('../../src/constants/errors');

describe('Unit: VehicleValidator', () => {
  describe('validateCreateVehicle', () => {
    const validVehicle = {
      category: 'Car',
      brand: 'Maruti Suzuki',
      model: 'Swift Dzire',
      variant: 'VXI',
      registrationNumber: 'MP 04 AB 1234',
      year: 2023,
      fuelType: 'Petrol',
      transmission: 'Manual',
      seats: 5,
      description: 'Well maintained sedan with AC',
      pickupLocation: 'Shop 101, Main Market',
      leaseAgreementAccepted: true,
    };

    it('accepts a valid vehicle creation payload with normalized registration', () => {
      const res = vehicleValidator.validateCreateVehicle(validVehicle);
      expect(res.category).toBe('Car');
      expect(res.brand).toBe('Maruti Suzuki');
      expect(res.model).toBe('Swift Dzire');
      expect(res.variant).toBe('VXI');
      expect(res.registrationNumber).toBe('MP 04 AB 1234');
      expect(res.year).toBe(2023);
      expect(res.fuelType).toBe('Petrol');
      expect(res.transmission).toBe('Manual');
      expect(res.seats).toBe(5);
      expect(res.pickupLocation).toBe('Shop 101, Main Market');
      expect(res.leaseAgreementAccepted).toBe(true);
    });

    it('accepts Bike category with default seats', () => {
      const bike = {
        category: 'Bike',
        brand: 'Royal Enfield',
        model: 'Classic 350',
        registrationNumber: 'DL01XY9999',
        year: 2022,
        fuelType: 'Petrol',
        leaseAgreementAccepted: true,
      };
      const res = vehicleValidator.validateCreateVehicle(bike);
      expect(res.category).toBe('Bike');
      expect(res.seats).toBe(2);
      expect(res.transmission).toBe('Manual');
      expect(res.leaseAgreementAccepted).toBe(true);
    });

    it('rejects vehicle creation if leaseAgreementAccepted is missing or false', () => {
      const withoutLease = { ...validVehicle };
      delete withoutLease.leaseAgreementAccepted;
      expect(() => vehicleValidator.validateCreateVehicle(withoutLease)).toThrow(ValidationError);
      expect(() => vehicleValidator.validateCreateVehicle({ ...validVehicle, leaseAgreementAccepted: false })).toThrow(ValidationError);
    });

    it('rejects forbidden category taxonomy (e.g. MOTORCYCLE)', () => {
      expect(() => {
        vehicleValidator.validateCreateVehicle({
          ...validVehicle,
          category: 'MOTORCYCLE',
        });
      }).toThrow(ValidationError);
    });

    it('rejects missing brand or model', () => {
      expect(() => {
        vehicleValidator.validateCreateVehicle({
          ...validVehicle,
          brand: '',
        });
      }).toThrow(ValidationError);

      expect(() => {
        vehicleValidator.validateCreateVehicle({
          ...validVehicle,
          model: '   ',
        });
      }).toThrow(ValidationError);
    });

    it('rejects missing or invalid registration number', () => {
      expect(() => {
        vehicleValidator.validateCreateVehicle({
          ...validVehicle,
          registrationNumber: '',
        });
      }).toThrow(ValidationError);

      expect(() => {
        vehicleValidator.validateCreateVehicle({
          ...validVehicle,
          registrationNumber: 'AB',
        });
      }).toThrow(ValidationError);
    });

    it('rejects year out of range', () => {
      expect(() => {
        vehicleValidator.validateCreateVehicle({
          ...validVehicle,
          year: 1980,
        });
      }).toThrow(ValidationError);

      expect(() => {
        vehicleValidator.validateCreateVehicle({
          ...validVehicle,
          year: 2099,
        });
      }).toThrow(ValidationError);
    });

    it('rejects invalid fuel type', () => {
      expect(() => {
        vehicleValidator.validateCreateVehicle({
          ...validVehicle,
          fuelType: 'Hydrogen',
        });
      }).toThrow(ValidationError);
    });

    it('rejects server-controlled fields with MASS_ASSIGNMENT_VIOLATION', () => {
      const protectedPayloads = [
        { ...validVehicle, manualStatus: 'ONLINE' },
        { ...validVehicle, rentalStatus: 'ACTIVE' },
        { ...validVehicle, verificationStatus: 'VERIFIED' },
        { ...validVehicle, isArchived: true },
        { ...validVehicle, partnerId: '4b3d7a8e-2890-482a-a92c-f67f67cbfa21' },
      ];

      protectedPayloads.forEach((payload) => {
        try {
          vehicleValidator.validateCreateVehicle(payload);
          throw new Error('Should have thrown ValidationError');
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
        }
      });
    });

    it('rejects unknown fields in create payload', () => {
      expect(() => {
        vehicleValidator.validateCreateVehicle({
          ...validVehicle,
          unexpectedKey: 'hack',
        });
      }).toThrow(ValidationError);
    });
  });

  describe('validateUpdateVehicle', () => {
    it('accepts valid update with editable fields', () => {
      const updates = {
        model: 'Swift Dzire Facelift',
        fuelType: 'CNG',
        pickupLocation: 'Shop 202, Sector 5',
      };
      const res = vehicleValidator.validateUpdateVehicle(updates);
      expect(res.model).toBe('Swift Dzire Facelift');
      expect(res.fuelType).toBe('CNG');
      expect(res.pickupLocation).toBe('Shop 202, Sector 5');
    });

    it('rejects attempt to update registration number (immutable)', () => {
      expect(() => {
        vehicleValidator.validateUpdateVehicle({
          registrationNumber: 'MP 04 CC 9999',
        });
      }).toThrow('Vehicle registration number cannot be changed after creation');
    });

    it('rejects server-controlled fields in update', () => {
      try {
        vehicleValidator.validateUpdateVehicle({
          manualStatus: 'OFFLINE',
        });
        throw new Error('Should have thrown ValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
      }
    });

    it('rejects empty update payload', () => {
      expect(() => {
        vehicleValidator.validateUpdateVehicle({});
      }).toThrow(ValidationError);
    });
  });

  describe('validateStatusUpdate', () => {
    it('accepts valid ONLINE status', () => {
      const res = vehicleValidator.validateStatusUpdate({ status: 'ONLINE' });
      expect(res.manualStatus).toBe('ONLINE');
      expect(res.offlineReason).toBeNull();
    });

    it('accepts valid OFFLINE status with reason', () => {
      const res = vehicleValidator.validateStatusUpdate({
        status: 'OFFLINE',
        reason: 'Scheduled maintenance and tyre replacement',
      });
      expect(res.manualStatus).toBe('OFFLINE');
      expect(res.offlineReason).toBe('Scheduled maintenance and tyre replacement');
    });

    it('rejects invalid status', () => {
      expect(() => {
        vehicleValidator.validateStatusUpdate({ status: 'SUSPENDED' });
      }).toThrow(ValidationError);
    });

    it('rejects mass assignment in status update', () => {
      try {
        vehicleValidator.validateStatusUpdate({
          status: 'ONLINE',
          rentalStatus: 'IDLE',
        });
        throw new Error('Should have thrown ValidationError');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.code).toBe(ERROR_CODES.MASS_ASSIGNMENT_VIOLATION);
      }
    });
  });

  describe('validateVehicleListQuery', () => {
    it('defaults pagination to page 1 and limit 20', () => {
      const res = vehicleValidator.validateVehicleListQuery({});
      expect(res.page).toBe(1);
      expect(res.limit).toBe(20);
      expect(res.offset).toBe(0);
      expect(res.category).toBeNull();
      expect(res.status).toBeNull();
      expect(res.search).toBeNull();
    });

    it('sanitizes valid filters and query parameters', () => {
      const res = vehicleValidator.validateVehicleListQuery({
        page: '2',
        limit: '10',
        category: 'bike',
        status: 'available',
        search: 'Royal Enfield',
      });
      expect(res.page).toBe(2);
      expect(res.limit).toBe(10);
      expect(res.offset).toBe(10);
      expect(res.category).toBe('Bike');
      expect(res.status).toBe('AVAILABLE');
      expect(res.search).toBe('Royal Enfield');
    });

    it('rejects invalid page or limit', () => {
      expect(() => {
        vehicleValidator.validateVehicleListQuery({ page: '-1' });
      }).toThrow(ValidationError);

      expect(() => {
        vehicleValidator.validateVehicleListQuery({ limit: '500' });
      }).toThrow(ValidationError);
    });
  });
});
