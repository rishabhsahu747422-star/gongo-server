'use strict';

const {
  detectProtectedFields,
  stripProtectedFields,
  filterDto,
} = require('../../src/middlewares/massAssignment');

describe('Unit: Mass Assignment Helpers', () => {
  it('detects top-level protected fields', () => {
    const payload = {
      name: 'Test Vehicle',
      walletBalance: 500,
      partnerId: 'partner-123',
    };

    const detected = detectProtectedFields(payload);
    expect(detected).toContain('walletBalance');
    expect(detected).toContain('partnerId');
    expect(detected).not.toContain('name');
  });

  it('detects nested protected fields', () => {
    const payload = {
      meta: {
        status: 'ACTIVE',
        commission: { rate: 0.1 },
      },
    };

    const detected = detectProtectedFields(payload);
    expect(detected).toContain('meta.status');
    expect(detected).toContain('meta.commission');
  });

  it('strips protected fields safely without mutating original object', () => {
    const original = {
      title: 'Bike Rental',
      walletBalance: 1000,
      availableBalance: 800,
      commissionAmount: 100,
    };

    const cleaned = stripProtectedFields(original);

    expect(cleaned.title).toBe('Bike Rental');
    expect(cleaned.walletBalance).toBeUndefined();
    expect(cleaned.availableBalance).toBeUndefined();
    expect(cleaned.commissionAmount).toBeUndefined();
    expect(original.walletBalance).toBe(1000); // Unmutated
  });

  it('filters DTO with strict whitelist', () => {
    const input = {
      brand: 'Yamaha',
      model: 'FZ',
      injectedRole: 'ADMIN',
      injectedPartnerId: 'hack',
    };

    const allowed = ['brand', 'model'];
    const filtered = filterDto(input, allowed);

    expect(filtered).toEqual({ brand: 'Yamaha', model: 'FZ' });
  });
});
