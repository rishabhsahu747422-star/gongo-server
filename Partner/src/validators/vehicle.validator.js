'use strict';

const { ValidationError } = require('../errors');
const { ERROR_CODES } = require('../constants/errors');
const { detectProtectedFields } = require('../middlewares/massAssignment');
const { PROTECTED_SERVER_FIELDS } = require('../constants/fields');
const pricingValidator = require('./pricing.validator');

const ALLOWED_CATEGORIES = Object.freeze(['Car', 'Bike', 'Scooter']);
const ALLOWED_FUEL_TYPES = Object.freeze(['Petrol', 'Diesel', 'EV', 'CNG']);
const ALLOWED_TRANSMISSIONS = Object.freeze(['Manual', 'Automatic']);
const ALLOWED_MANUAL_STATUSES = Object.freeze(['ONLINE', 'OFFLINE']);

const ALLOWED_VEHICLE_DOC_TYPES = Object.freeze([
  'RC',
  'Insurance',
  'PUC',
  'Fitness',
  'Other',
  'FITNESS_CERTIFICATE',
  'INSURANCE',
]);

const PROTECTED_DOCUMENT_FIELDS = Object.freeze([
  'id',
  'status',
  'verification_status',
  'verificationStatus',
  'verified',
  'is_verified',
  'isVerified',
  'approved',
  'is_approved',
  'isApproved',
  'valid',
  'is_valid',
  'isValid',
  'rejected',
  'is_rejected',
  'isRejected',
  'version',
  'rejection_reason',
  'rejectionReason',
  'uploaded_at',
  'uploadedAt',
  'verified_at',
  'verifiedAt',
  'verified_by',
  'verifiedBy',
  'reviewer_id',
  'reviewerId',
  'admin_notes',
  'adminNotes',
  'approval_timestamp',
  'approvalTimestamp',
  'approved_at',
  'approvedAt',
  'created_at',
  'updated_at',
  'createdAt',
  'updatedAt',
]);

const ALLOWED_VEHICLE_DOC_INPUT_FIELDS = Object.freeze([
  'vehicleId',
  'vehicle_id',
  'documentType',
  'document_type',
  'type',
  'storageKey',
  'storage_key',
  'uri',
  'documentNumber',
  'document_number',
  'number',
  'validTill',
  'valid_till',
  'documentName',
  'document_name',
  'name',
  'fileName',
  'file_name',
  'fileSize',
  'file_size',
  'mimeType',
  'mime_type',
]);

const PROTECTED_VEHICLE_FIELDS = Object.freeze([
  'id',
  'partner_id',
  'partnerId',
  'shop_id',
  'shopId',
  'manual_status',
  'manualStatus',
  'rental_status',
  'rentalStatus',
  'verification_status',
  'verificationStatus',
  'is_archived',
  'isArchived',
  'offline_reason',
  'offlineReason',
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
]);

const ALLOWED_CREATE_FIELDS = Object.freeze([
  'category',
  'type',
  'brand',
  'model',
  'variant',
  'registrationNumber',
  'registration_number',
  'year',
  'fuelType',
  'fuel_type',
  'transmission',
  'seats',
  'description',
  'pickupLocation',
  'pickup_location',
  'pricePerHour',
  'price_per_hour',
  'price3Hours',
  'price_3_hours',
  'price6Hours',
  'price_6_hours',
  'price12Hours',
  'price_12_hours',
  'pricePer4Hours',
  'price_per_4_hours',
  'pricePerDay',
  'price_per_day',
  'securityDeposit',
  'security_deposit',
  'extraKmCharge',
  'extra_km_charge',
  'currency',
  'pricing',
  'images',
  'documents',
  'leaseAgreementAccepted',
  'lease_agreement_accepted',
  'leaseConsent',
  'lease_consent',
]);

const ALLOWED_UPDATE_FIELDS = Object.freeze([
  'category',
  'type',
  'brand',
  'model',
  'variant',
  'year',
  'fuelType',
  'fuel_type',
  'transmission',
  'seats',
  'description',
  'pickupLocation',
  'pickup_location',
]);

// Normalizes Indian vehicle registration number (trim, single-space, uppercase)
function normalizeRegistrationNumber(reg) {
  if (!reg || typeof reg !== 'string') return '';
  return reg.trim().replace(/\s+/g, ' ').toUpperCase();
}

class VehicleValidator {
  /**
   * Validate vehicle creation input.
   *
   * @param {object} body
   * @returns {object} Validated payload
   */
  validateCreateVehicle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    // Mass assignment check
    const baseViolations = detectProtectedFields(body);
    const extraViolations = PROTECTED_VEHICLE_FIELDS.filter(
      (f) => Object.prototype.hasOwnProperty.call(body, f),
    );
    const allViolations = Array.from(new Set([...baseViolations, ...extraViolations]));

    if (allViolations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${allViolations.join(', ')}] cannot be provided`,
        allViolations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    // Whitelist check
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_CREATE_FIELDS.includes(k));
    if (unknownFields.length > 0) {
      throw new ValidationError(
        `Unknown field(s) [${unknownFields.join(', ')}] are not permitted for vehicle creation`,
        unknownFields.map((f) => ({ field: f, message: 'Field not permitted' })),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const errors = [];

    // 1. category (supporting type alias)
    let category = null;
    const rawCategory = body.category !== undefined ? body.category : body.type;
    if (!rawCategory || typeof rawCategory !== 'string' || !rawCategory.trim()) {
      errors.push({ field: 'category', message: 'category is required' });
    } else {
      const normCat = rawCategory.trim();
      const matched = ALLOWED_CATEGORIES.find((c) => c.toUpperCase() === normCat.toUpperCase());
      if (!matched) {
        errors.push({
          field: 'category',
          message: `category must be one of: [${ALLOWED_CATEGORIES.join(', ')}]`,
        });
      } else {
        category = matched;
      }
    }

    // 2. brand
    let brand = null;
    if (!body.brand || typeof body.brand !== 'string' || !body.brand.trim()) {
      errors.push({ field: 'brand', message: 'brand is required' });
    } else if (body.brand.trim().length > 100) {
      errors.push({ field: 'brand', message: 'brand cannot exceed 100 characters' });
    } else {
      brand = body.brand.trim();
    }

    // 3. model
    let model = null;
    if (!body.model || typeof body.model !== 'string' || !body.model.trim()) {
      errors.push({ field: 'model', message: 'model is required' });
    } else if (body.model.trim().length > 100) {
      errors.push({ field: 'model', message: 'model cannot exceed 100 characters' });
    } else {
      model = body.model.trim();
    }

    // 4. variant
    let variant = null;
    if (body.variant !== undefined && body.variant !== null) {
      if (typeof body.variant !== 'string' || body.variant.trim().length > 100) {
        errors.push({ field: 'variant', message: 'variant must be a string up to 100 characters' });
      } else {
        variant = body.variant.trim() || null;
      }
    }

    // 5. registrationNumber
    const rawReg = body.registrationNumber || body.registration_number;
    let registrationNumber = null;
    if (!rawReg || typeof rawReg !== 'string' || !rawReg.trim()) {
      errors.push({ field: 'registrationNumber', message: 'registrationNumber is required' });
    } else {
      registrationNumber = normalizeRegistrationNumber(rawReg);
      if (registrationNumber.length < 4 || registrationNumber.length > 20) {
        errors.push({
          field: 'registrationNumber',
          message: 'registrationNumber must be between 4 and 20 characters',
        });
      }
    }

    // 6. year
    let year = null;
    const currentYear = new Date().getFullYear();
    if (body.year === undefined || body.year === null) {
      errors.push({ field: 'year', message: 'year is required' });
    } else {
      const parsedYear = Number(body.year);
      if (!Number.isInteger(parsedYear) || parsedYear < 1990 || parsedYear > currentYear + 1) {
        errors.push({
          field: 'year',
          message: `year must be an integer between 1990 and ${currentYear + 1}`,
        });
      } else {
        year = parsedYear;
      }
    }

    // 7. fuelType (normalizing Electric / ELECTRICAL to EV)
    const rawFuel = body.fuelType || body.fuel_type;
    let fuelType = null;
    if (!rawFuel || typeof rawFuel !== 'string' || !rawFuel.trim()) {
      errors.push({ field: 'fuelType', message: 'fuelType is required' });
    } else {
      let normFuel = rawFuel.trim().toUpperCase();
      if (normFuel === 'ELECTRIC' || normFuel === 'ELECTRICAL') {
        normFuel = 'EV';
      }
      const matchedFuel = ALLOWED_FUEL_TYPES.find(
        (f) => f.toUpperCase() === normFuel,
      );
      if (!matchedFuel) {
        errors.push({
          field: 'fuelType',
          message: `fuelType must be one of: [${ALLOWED_FUEL_TYPES.join(', ')}]`,
        });
      } else {
        fuelType = matchedFuel;
      }
    }

    // 8. transmission
    let transmission = 'Manual';
    if (body.transmission !== undefined && body.transmission !== null) {
      const normTrans = String(body.transmission).trim();
      const matchedTrans = ALLOWED_TRANSMISSIONS.find(
        (t) => t.toUpperCase() === normTrans.toUpperCase(),
      );
      if (!matchedTrans) {
        errors.push({
          field: 'transmission',
          message: `transmission must be one of: [${ALLOWED_TRANSMISSIONS.join(', ')}]`,
        });
      } else {
        transmission = matchedTrans;
      }
    }

    // 9. seats
    let seats = category === 'Car' ? 5 : 2;
    if (body.seats !== undefined && body.seats !== null) {
      const parsedSeats = Number(body.seats);
      if (!Number.isInteger(parsedSeats) || parsedSeats < 1 || parsedSeats > 50) {
        errors.push({ field: 'seats', message: 'seats must be an integer between 1 and 50' });
      } else {
        seats = parsedSeats;
      }
    }

    // 10. description
    let description = null;
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string' || body.description.trim().length > 1000) {
        errors.push({
          field: 'description',
          message: 'description must be a string up to 1000 characters',
        });
      } else {
        description = body.description.trim() || null;
      }
    }

    // 11. pickupLocation
    const rawPickup = body.pickupLocation || body.pickup_location;
    let pickupLocation = null;
    if (rawPickup !== undefined && rawPickup !== null) {
      if (typeof rawPickup !== 'string' || rawPickup.trim().length > 500) {
        errors.push({
          field: 'pickupLocation',
          message: 'pickupLocation must be a string up to 500 characters',
        });
      } else {
        pickupLocation = rawPickup.trim() || null;
      }
    }

    // 12. Optional inline pricing (for frontend vehicle creation wizard)
    let pricing = null;
    const nestedPricing = (body.pricing && typeof body.pricing === 'object' && !Array.isArray(body.pricing))
      ? body.pricing
      : {};
    const rawPricePerDay = body.pricePerDay !== undefined
      ? body.pricePerDay
      : (body.price_per_day !== undefined ? body.price_per_day : nestedPricing.pricePerDay ?? nestedPricing.price_per_day);
    const rawPricePerHour = body.pricePerHour !== undefined
      ? body.pricePerHour
      : (body.price_per_hour !== undefined ? body.price_per_hour : nestedPricing.pricePerHour ?? nestedPricing.price_per_hour);
    const rawPrice3Hours = body.price3Hours !== undefined
      ? body.price3Hours
      : (body.price_3_hours !== undefined ? body.price_3_hours : nestedPricing.price3Hours ?? nestedPricing.price_3_hours);
    const rawPrice6Hours = body.price6Hours !== undefined
      ? body.price6Hours
      : (body.price_6_hours !== undefined ? body.price_6_hours : nestedPricing.price6Hours ?? nestedPricing.price_6_hours);
    const rawPrice12Hours = body.price12Hours !== undefined
      ? body.price12Hours
      : (body.price_12_hours !== undefined ? body.price_12_hours : nestedPricing.price12Hours ?? nestedPricing.price_12_hours);
    const rawPricePer4Hours = body.pricePer4Hours !== undefined
      ? body.pricePer4Hours
      : (body.price_per_4_hours !== undefined ? body.price_per_4_hours : nestedPricing.pricePer4Hours ?? nestedPricing.price_per_4_hours);
    const rawSecurityDeposit = body.securityDeposit !== undefined
      ? body.securityDeposit
      : (body.security_deposit !== undefined ? body.security_deposit : nestedPricing.securityDeposit ?? nestedPricing.security_deposit);
    const rawExtraKmCharge = body.extraKmCharge !== undefined
      ? body.extraKmCharge
      : (body.extra_km_charge !== undefined ? body.extra_km_charge : nestedPricing.extraKmCharge ?? nestedPricing.extra_km_charge);
    const rawCurrency = body.currency !== undefined
      ? body.currency
      : nestedPricing.currency;

    const hasPricingField = rawPricePerDay !== undefined
      || rawPricePerHour !== undefined
      || rawPrice3Hours !== undefined
      || rawPrice6Hours !== undefined
      || rawPrice12Hours !== undefined
      || rawPricePer4Hours !== undefined
      || rawSecurityDeposit !== undefined
      || rawExtraKmCharge !== undefined
      || rawCurrency !== undefined
      || (body.pricing && typeof body.pricing === 'object');

    if (hasPricingField) {
      const pricingPayload = {};
      if (rawPricePerDay !== undefined && rawPricePerDay !== null && rawPricePerDay !== '') {
        pricingPayload.pricePerDay = rawPricePerDay;
      } else if (rawPricePerHour !== undefined
        && rawPricePerHour !== null
        && rawPricePerHour !== '') {
        pricingPayload.pricePerDay = Number((Number(rawPricePerHour) * 15).toFixed(2));
      }
      if (rawPricePerHour !== undefined && rawPricePerHour !== null && rawPricePerHour !== '') {
        pricingPayload.pricePerHour = rawPricePerHour;
      }
      if (rawPrice3Hours !== undefined && rawPrice3Hours !== null && rawPrice3Hours !== '') {
        pricingPayload.price3Hours = rawPrice3Hours;
      }
      if (rawPrice6Hours !== undefined && rawPrice6Hours !== null && rawPrice6Hours !== '') {
        pricingPayload.price6Hours = rawPrice6Hours;
      }
      if (rawPrice12Hours !== undefined && rawPrice12Hours !== null && rawPrice12Hours !== '') {
        pricingPayload.price12Hours = rawPrice12Hours;
      }
      if (rawPricePer4Hours !== undefined
        && rawPricePer4Hours !== null
        && rawPricePer4Hours !== '') {
        pricingPayload.pricePer4Hours = rawPricePer4Hours;
      }
      if (rawSecurityDeposit !== undefined
        && rawSecurityDeposit !== null
        && rawSecurityDeposit !== '') {
        pricingPayload.securityDeposit = rawSecurityDeposit;
      }
      if (rawExtraKmCharge !== undefined
        && rawExtraKmCharge !== null
        && rawExtraKmCharge !== '') {
        pricingPayload.extraKmCharge = rawExtraKmCharge;
      }
      if (rawCurrency !== undefined && rawCurrency !== null && rawCurrency !== '') {
        pricingPayload.currency = rawCurrency;
      }

      try {
        pricing = pricingValidator.validatePricing(pricingPayload);
      } catch (err) {
        if (err instanceof ValidationError && Array.isArray(err.details)) {
          err.details.forEach((d) => errors.push(d));
        } else {
          errors.push({ field: 'pricing', message: err.message });
        }
      }
    }

    // 13. Optional inline images
    let images = null;
    if (body.images !== undefined && body.images !== null) {
      if (!Array.isArray(body.images)) {
        errors.push({ field: 'images', message: 'images must be an array' });
      } else {
        images = body.images;
      }
    }

    // 14. Optional inline documents
    let documents = null;
    if (body.documents !== undefined && body.documents !== null) {
      if (!Array.isArray(body.documents)) {
        errors.push({ field: 'documents', message: 'documents must be an array' });
      } else {
        for (const doc of body.documents) {
          if (!doc || typeof doc !== 'object') continue;
          const docViolations = PROTECTED_DOCUMENT_FIELDS.filter((f) =>
            Object.prototype.hasOwnProperty.call(doc, f),
          );
          if (docViolations.length > 0) {
            throw new ValidationError(
              `Mass assignment detected: Server-controlled field(s) [${docViolations.join(', ')}] cannot be provided in document evidence`,
              docViolations.map((f) => ({ field: f, message: 'Server-controlled field' })),
              ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
            );
          }
          const dType = doc.type || doc.documentType || doc.document_type;
          if (dType) {
            const matched = ALLOWED_VEHICLE_DOC_TYPES.find(
              (t) => t.toUpperCase() === String(dType).trim().toUpperCase(),
            );
            if (!matched) {
              errors.push({
                field: 'documents',
                message: `document type '${dType}' is not allowed. Allowed types: [${ALLOWED_VEHICLE_DOC_TYPES.join(', ')}]`,
              });
            }
          }
        }
        documents = body.documents;
      }
    }

    // 15. Mandatory Vehicle Lease Agreement acceptance
    const leaseAccepted = body.leaseAgreementAccepted === true
      || body.lease_agreement_accepted === true
      || body.leaseConsent === true
      || body.lease_consent === true;
    if (!leaseAccepted) {
      errors.push({
        field: 'leaseAgreementAccepted',
        message: 'You must read and agree to the Vehicle Lease Agreement to list a vehicle',
      });
    }

    if (errors.length > 0) {
      throw new ValidationError(errors[0].message, errors);
    }

    return {
      category,
      brand,
      model,
      variant,
      registrationNumber,
      year,
      fuelType,
      transmission,
      seats,
      description,
      pickupLocation,
      pricing,
      images,
      documents,
      leaseAgreementAccepted: true,
    };
  }

  /**
   * Validate vehicle update input.
   *
   * @param {object} body
   * @returns {object} Validated updates
   */
  validateUpdateVehicle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    // Registration number immutability check
    if (
      Object.prototype.hasOwnProperty.call(body, 'registrationNumber')
      || Object.prototype.hasOwnProperty.call(body, 'registration_number')
    ) {
      throw new ValidationError(
        'Vehicle registration number cannot be changed after creation. Please contact support if required.',
        [{ field: 'registrationNumber', message: 'Registration number is immutable' }],
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    // Mass assignment check
    const baseViolations = detectProtectedFields(body);
    const extraViolations = PROTECTED_VEHICLE_FIELDS.filter(
      (f) => Object.prototype.hasOwnProperty.call(body, f),
    );
    const allViolations = Array.from(new Set([...baseViolations, ...extraViolations]));

    if (allViolations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${allViolations.join(', ')}] cannot be provided`,
        allViolations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    // Whitelist check
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_UPDATE_FIELDS.includes(k));
    if (unknownFields.length > 0) {
      throw new ValidationError(
        `Unknown field(s) [${unknownFields.join(', ')}] are not permitted for vehicle update`,
        unknownFields.map((f) => ({ field: f, message: 'Field not permitted' })),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const updates = {};
    const errors = [];

    const rawCategory = body.category !== undefined ? body.category : body.type;
    if (rawCategory !== undefined) {
      if (typeof rawCategory !== 'string' || !rawCategory.trim()) {
        errors.push({ field: 'category', message: 'category cannot be empty' });
      } else {
        const matched = ALLOWED_CATEGORIES.find(
          (c) => c.toUpperCase() === rawCategory.trim().toUpperCase(),
        );
        if (!matched) {
          errors.push({
            field: 'category',
            message: `category must be one of: [${ALLOWED_CATEGORIES.join(', ')}]`,
          });
        } else {
          updates.category = matched;
        }
      }
    }

    if (body.brand !== undefined) {
      if (typeof body.brand !== 'string' || !body.brand.trim()) {
        errors.push({ field: 'brand', message: 'brand cannot be empty' });
      } else if (body.brand.trim().length > 100) {
        errors.push({ field: 'brand', message: 'brand cannot exceed 100 characters' });
      } else {
        updates.brand = body.brand.trim();
      }
    }

    if (body.model !== undefined) {
      if (typeof body.model !== 'string' || !body.model.trim()) {
        errors.push({ field: 'model', message: 'model cannot be empty' });
      } else if (body.model.trim().length > 100) {
        errors.push({ field: 'model', message: 'model cannot exceed 100 characters' });
      } else {
        updates.model = body.model.trim();
      }
    }

    if (body.variant !== undefined) {
      if (body.variant === null || body.variant === '') {
        updates.variant = null;
      } else if (typeof body.variant !== 'string' || body.variant.trim().length > 100) {
        errors.push({ field: 'variant', message: 'variant must be a string up to 100 characters' });
      } else {
        updates.variant = body.variant.trim();
      }
    }

    if (body.year !== undefined) {
      const currentYear = new Date().getFullYear();
      const parsedYear = Number(body.year);
      if (!Number.isInteger(parsedYear) || parsedYear < 1990 || parsedYear > currentYear + 1) {
        errors.push({
          field: 'year',
          message: `year must be an integer between 1990 and ${currentYear + 1}`,
        });
      } else {
        updates.year = parsedYear;
      }
    }

    const rawFuel = body.fuelType !== undefined ? body.fuelType : body.fuel_type;
    if (rawFuel !== undefined) {
      if (typeof rawFuel !== 'string' || !rawFuel.trim()) {
        errors.push({ field: 'fuelType', message: 'fuelType cannot be empty' });
      } else {
        let normFuel = rawFuel.trim().toUpperCase();
        if (normFuel === 'ELECTRIC' || normFuel === 'ELECTRICAL') {
          normFuel = 'EV';
        }
        const matchedFuel = ALLOWED_FUEL_TYPES.find(
          (f) => f.toUpperCase() === normFuel,
        );
        if (!matchedFuel) {
          errors.push({
            field: 'fuelType',
            message: `fuelType must be one of: [${ALLOWED_FUEL_TYPES.join(', ')}]`,
          });
        } else {
          updates.fuelType = matchedFuel;
        }
      }
    }

    if (body.transmission !== undefined) {
      const matchedTrans = ALLOWED_TRANSMISSIONS.find(
        (t) => t.toUpperCase() === String(body.transmission).trim().toUpperCase(),
      );
      if (!matchedTrans) {
        errors.push({
          field: 'transmission',
          message: `transmission must be one of: [${ALLOWED_TRANSMISSIONS.join(', ')}]`,
        });
      } else {
        updates.transmission = matchedTrans;
      }
    }

    if (body.seats !== undefined) {
      const parsedSeats = Number(body.seats);
      if (!Number.isInteger(parsedSeats) || parsedSeats < 1 || parsedSeats > 50) {
        errors.push({ field: 'seats', message: 'seats must be an integer between 1 and 50' });
      } else {
        updates.seats = parsedSeats;
      }
    }

    if (body.description !== undefined) {
      if (body.description === null || body.description === '') {
        updates.description = null;
      } else if (typeof body.description !== 'string' || body.description.trim().length > 1000) {
        errors.push({ field: 'description', message: 'description must be a string up to 1000 characters' });
      } else {
        updates.description = body.description.trim();
      }
    }

    const rawPickup = body.pickupLocation !== undefined
      ? body.pickupLocation
      : body.pickup_location;
    if (rawPickup !== undefined) {
      if (rawPickup === null || rawPickup === '') {
        updates.pickupLocation = null;
      } else if (typeof rawPickup !== 'string' || rawPickup.trim().length > 500) {
        errors.push({
          field: 'pickupLocation',
          message: 'pickupLocation must be a string up to 500 characters',
        });
      } else {
        updates.pickupLocation = rawPickup.trim();
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(errors[0].message, errors);
    }

    if (Object.keys(updates).length === 0) {
      throw new ValidationError('At least one field must be provided for update');
    }

    return updates;
  }

  /**
   * Validate status update payload.
   *
   * @param {object} body
   * @returns {object} Validated status payload
   */
  validateStatusUpdate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    const STATUS_PROTECTED_FIELDS = PROTECTED_SERVER_FIELDS.filter(
      (f) => f.toLowerCase() !== 'status' && f.toLowerCase() !== 'reason',
    );
    const baseViolations = detectProtectedFields(body, STATUS_PROTECTED_FIELDS);
    const extraViolations = PROTECTED_VEHICLE_FIELDS.filter(
      (f) => Object.prototype.hasOwnProperty.call(body, f)
        && !['status', 'manualstatus', 'reason', 'offlinereason'].includes(f.toLowerCase()),
    );
    const violations = Array.from(new Set([...baseViolations, ...extraViolations]));
    if (violations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${violations.join(', ')}] cannot be provided`,
        violations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    const ALLOWED_STATUS_FIELDS = ['status', 'manualStatus', 'reason', 'offlineReason'];
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_STATUS_FIELDS.includes(k));
    if (unknownFields.length > 0) {
      throw new ValidationError(
        `Unknown field(s) [${unknownFields.join(', ')}] are not permitted for status update`,
        unknownFields.map((f) => ({ field: f, message: 'Field not permitted' })),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const rawStatus = body.status || body.manualStatus;
    if (!rawStatus || typeof rawStatus !== 'string' || !rawStatus.trim()) {
      throw new ValidationError('status is required and must be ONLINE or OFFLINE');
    }

    const normStatus = rawStatus.trim().toUpperCase();
    if (!ALLOWED_MANUAL_STATUSES.includes(normStatus)) {
      throw new ValidationError(`status must be one of: [${ALLOWED_MANUAL_STATUSES.join(', ')}]`);
    }

    const rawReason = body.reason || body.offlineReason;
    let offlineReason = null;
    if (rawReason !== undefined && rawReason !== null) {
      if (typeof rawReason !== 'string' || rawReason.trim().length > 200) {
        throw new ValidationError('reason must be a string up to 200 characters');
      }
      offlineReason = rawReason.trim() || null;
    }

    return {
      manualStatus: normStatus,
      offlineReason,
    };
  }

  /**
   * Validate vehicle list query parameters.
   *
   * @param {object} query
   * @returns {object} Validated query
   */
  validateVehicleListQuery(query = {}) {
    const validated = {
      page: 1,
      limit: 20,
      offset: 0,
      category: null,
      status: null,
      search: null,
    };

    if (query.page !== undefined) {
      const pageNum = parseInt(query.page, 10);
      if (Number.isNaN(pageNum) || pageNum < 1) {
        throw new ValidationError('page query parameter must be a positive integer');
      }
      validated.page = pageNum;
    }

    if (query.limit !== undefined) {
      const limitNum = parseInt(query.limit, 10);
      if (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        throw new ValidationError('limit query parameter must be an integer between 1 and 100');
      }
      validated.limit = limitNum;
    }

    validated.offset = (validated.page - 1) * validated.limit;

    if (query.category) {
      const cat = String(query.category).trim();
      const matched = ALLOWED_CATEGORIES.find((c) => c.toUpperCase() === cat.toUpperCase());
      if (matched) {
        validated.category = matched;
      }
    }

    if (query.status) {
      const allowedQueryStatuses = ['AVAILABLE', 'BOOKED', 'ACTIVE', 'UNAVAILABLE', 'ARCHIVED', 'ONLINE', 'OFFLINE'];
      const st = String(query.status).trim().toUpperCase();
      if (allowedQueryStatuses.includes(st)) {
        validated.status = st;
      }
    }

    if (query.search && typeof query.search === 'string' && query.search.trim()) {
      validated.search = query.search.trim().slice(0, 100);
    }

    return validated;
  }

  /**
   * Validate vehicle document creation/submission input.
   *
   * @param {object} body
   * @returns {object} Validated document payload
   */
  validateCreateVehicleDocument(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    // Detect attempts to manipulate server-controlled verification state
    const docViolations = PROTECTED_DOCUMENT_FIELDS.filter((f) =>
      Object.prototype.hasOwnProperty.call(body, f),
    );
    if (docViolations.length > 0) {
      throw new ValidationError(
        `Mass assignment detected: Server-controlled field(s) [${docViolations.join(', ')}] cannot be provided`,
        docViolations.map((f) => ({ field: f, message: 'Server-controlled field' })),
        ERROR_CODES.MASS_ASSIGNMENT_VIOLATION,
      );
    }

    // Whitelist check
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_VEHICLE_DOC_INPUT_FIELDS.includes(k));
    if (unknownFields.length > 0) {
      throw new ValidationError(
        `Disallowed or unknown field(s) [${unknownFields.join(', ')}] detected in document payload`,
        unknownFields.map((f) => ({ field: f, message: 'Field not permitted' })),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const errors = [];
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // 1. vehicleId
    const rawVehicleId = body.vehicleId || body.vehicle_id;
    if (!rawVehicleId || typeof rawVehicleId !== 'string' || !UUID_REGEX.test(rawVehicleId.trim())) {
      errors.push({ field: 'vehicleId', message: 'vehicleId is required and must be a valid UUID' });
    }
    const vehicleId = rawVehicleId ? rawVehicleId.trim() : null;

    // 2. documentType
    const rawDocType = body.documentType || body.document_type || body.type;
    let documentType = null;
    if (!rawDocType || typeof rawDocType !== 'string' || !rawDocType.trim()) {
      errors.push({ field: 'documentType', message: 'documentType is required' });
    } else {
      const trimmed = rawDocType.trim();
      const matched = ALLOWED_VEHICLE_DOC_TYPES.find(
        (t) => t.toUpperCase() === trimmed.toUpperCase(),
      );
      if (!matched) {
        errors.push({
          field: 'documentType',
          message: `documentType must be one of: [${ALLOWED_VEHICLE_DOC_TYPES.join(', ')}]`,
        });
      } else {
        documentType = matched;
      }
    }

    // 3. storageKey
    const rawStorageKey = body.storageKey || body.storage_key || body.uri;
    let storageKey = null;
    if (rawStorageKey !== undefined && rawStorageKey !== null) {
      if (typeof rawStorageKey !== 'string' || !rawStorageKey.trim()) {
        errors.push({ field: 'storageKey', message: 'storageKey must be a non-empty string' });
      } else {
        const key = rawStorageKey.trim();
        if (key.length > 500) {
          errors.push({ field: 'storageKey', message: 'storageKey cannot exceed 500 characters' });
        } else if (key.includes('..') || key.startsWith('/') || key.startsWith('\\')) {
          errors.push({ field: 'storageKey', message: 'storageKey contains invalid or traversal characters' });
        } else {
          storageKey = key;
        }
      }
    }

    // 4. documentNumber
    const rawDocNumber = body.documentNumber || body.document_number || body.number;
    let documentNumber = null;
    if (rawDocNumber !== undefined && rawDocNumber !== null) {
      if (typeof rawDocNumber !== 'string' || rawDocNumber.trim().length > 100) {
        errors.push({ field: 'documentNumber', message: 'documentNumber must be a string up to 100 characters' });
      } else {
        documentNumber = rawDocNumber.trim() || null;
      }
    }

    // 5. validTill
    const rawValidTill = body.validTill || body.valid_till;
    let validTill = null;
    if (rawValidTill !== undefined && rawValidTill !== null && rawValidTill !== '') {
      const parsedDate = new Date(rawValidTill);
      if (Number.isNaN(parsedDate.getTime())) {
        errors.push({ field: 'validTill', message: 'validTill must be a valid date' });
      } else {
        validTill = rawValidTill;
      }
    }

    // 6. documentName
    const rawDocName = body.documentName || body.document_name || body.name;
    let documentName = null;
    if (rawDocName !== undefined && rawDocName !== null) {
      if (typeof rawDocName !== 'string' || rawDocName.trim().length > 150) {
        errors.push({ field: 'documentName', message: 'documentName must be a string up to 150 characters' });
      } else {
        documentName = rawDocName.trim() || null;
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(errors[0].message, errors);
    }

    return {
      vehicleId,
      documentType,
      documentNumber,
      validTill,
      documentName: documentName || documentType,
      storageKey,
    };
  }
}

module.exports = new VehicleValidator();
