'use strict';

const DOCUMENT_TYPES = Object.freeze({
  GONGO_TERMS: 'GONGO_TERMS',
  VEHICLE_LEASE_AGREEMENT: 'VEHICLE_LEASE_AGREEMENT',
});

const LEGAL_DOCUMENTS = Object.freeze({
  GONGO_TERMS: {
    type: 'GONGO_TERMS',
    title: 'GONGO Terms & Conditions',
    version: '1.0.0',
    contentHash: 'c8f28791e066bbd6bd1b0f133e6373a99f03e000fa87f74b6d5b09e6759dabfb',
  },
  VEHICLE_LEASE_AGREEMENT: {
    type: 'VEHICLE_LEASE_AGREEMENT',
    title: 'Vehicle Lease Agreement',
    version: '1.0.0',
    contentHash: '5fe8a5581f796ac00d0247f98a68192c3dfac120da93abb8a736a3d5ab197300',
    isIncomplete: true,
  },
});

module.exports = {
  DOCUMENT_TYPES,
  LEGAL_DOCUMENTS,
};
