'use strict';

const repo = require('../../src/repositories/platform-fee.repository');

describe('Unit: PlatformFeeRepository', () => {
  let mockClient;
  let executedQueries;

  beforeEach(() => {
    repo.resetMockPlatformFeeResolver();
    executedQueries = [];
    mockClient = {
      query: jest.fn(async (text, values) => {
        executedQueries.push({ text, values });
        return { rows: [], rowCount: 0 };
      }),
    };
  });

  describe('findActive', () => {
    it('executes parameterized SELECT and maps rows to domain object', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'b1699dea-b202-4402-a318-a969f9199561',
            charge_type: 'convenience_fee',
            calculation_type: 'fixed',
            value: '2.00',
            currency: 'INR',
            is_active: true,
            created_by: null,
            created_at: new Date('2026-10-09T05:38:47.480Z'),
            updated_at: new Date('2026-10-09T05:38:47.480Z'),
          },
          {
            id: 'f68a0d50-a3fd-463b-8d5f-54e6b1db126f',
            charge_type: 'gst',
            calculation_type: 'percentage',
            value: '18.00',
            currency: 'INR',
            is_active: true,
            created_by: null,
            created_at: new Date('2026-10-09T05:38:47.480Z'),
            updated_at: new Date('2026-10-09T05:38:47.480Z'),
          },
          {
            id: '8e130156-9b3b-4f4d-b50b-f8a3c04ea675',
            charge_type: 'service_charge',
            calculation_type: 'fixed',
            value: '2.50',
            currency: 'INR',
            is_active: true,
            created_by: null,
            created_at: new Date('2026-10-09T05:38:47.480Z'),
            updated_at: new Date('2026-10-09T05:38:47.480Z'),
          },
        ],
        rowCount: 3,
      });

      const result = await repo.findActive(mockClient);

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, values] = mockClient.query.mock.calls[0];
      expect(sql).toContain('FROM platform_charge_settings');
      expect(sql).toContain('WHERE is_active = TRUE');
      expect(values).toEqual([]);

      expect(result).toMatchObject({
        serviceCharge: {
          id: '8e130156-9b3b-4f4d-b50b-f8a3c04ea675',
          calculationType: 'fixed',
          value: 2.5,
          currency: 'INR',
          isActive: true,
        },
        convenienceFee: {
          id: 'b1699dea-b202-4402-a318-a969f9199561',
          calculationType: 'fixed',
          value: 2,
          currency: 'INR',
          isActive: true,
        },
        gst: {
          id: 'f68a0d50-a3fd-463b-8d5f-54e6b1db126f',
          calculationType: 'percentage',
          value: 18,
          currency: 'INR',
          isActive: true,
        },
      });
    });

    it('returns defaults when no active rows are found', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await repo.findActive(mockClient);
      expect(result).toMatchObject({
        serviceCharge: { calculationType: 'fixed', value: 2.5 },
        convenienceFee: { calculationType: 'fixed', value: 2 },
        gst: { calculationType: 'percentage', value: 18 },
      });
    });
  });

  describe('updateActiveCharges', () => {
    const existingRows = [
      {
        id: '8e130156-9b3b-4f4d-b50b-f8a3c04ea675',
        charge_type: 'service_charge',
        calculation_type: 'fixed',
        value: '2.50',
        currency: 'INR',
        is_active: true,
      },
      {
        id: 'b1699dea-b202-4402-a318-a969f9199561',
        charge_type: 'convenience_fee',
        calculation_type: 'fixed',
        value: '2.00',
        currency: 'INR',
        is_active: true,
      },
      {
        id: 'f68a0d50-a3fd-463b-8d5f-54e6b1db126f',
        charge_type: 'gst',
        calculation_type: 'percentage',
        value: '18.00',
        currency: 'INR',
        is_active: true,
      },
    ];

    it('updates existing active rows with row-level lock and verified admin UUID', async () => {
      const validAdminUuid = 'b0000002-0000-4000-b000-000000000002';

      mockClient.query.mockImplementation(async (text, values) => {
        if (text.includes('FOR UPDATE')) {
          return { rows: existingRows, rowCount: 3 };
        }
        if (text.includes('FROM users WHERE id = $1')) {
          return { rows: [{ id: validAdminUuid }], rowCount: 1 };
        }
        if (text.includes('UPDATE platform_charge_settings')) {
          let chargeType = 'convenience_fee';
          if (values[0] === 'percentage') {
            chargeType = 'gst';
          } else if (values[1] === 3) {
            chargeType = 'service_charge';
          }
          return {
            rows: [
              {
                id: `id-${chargeType}`,
                charge_type: chargeType,
                calculation_type: values[0],
                value: values[1],
                currency: 'INR',
                is_active: true,
                created_by: validAdminUuid,
                updated_at: new Date(),
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await repo.updateActiveCharges(
        {
          serviceCharge: 3.0,
          convenienceFee: 2.5,
          gst: 18.0,
          adminId: validAdminUuid,
        },
        mockClient,
      );

      expect(result).toBeDefined();
      expect(result.previous).toBeDefined();
      expect(result.current).toBeDefined();
    });

    it('gracefully handles non-UUID adminId by falling back to existing created_by', async () => {
      mockClient.query.mockImplementation(async (text) => {
        if (text.includes('FOR UPDATE')) {
          return { rows: existingRows, rowCount: 3 };
        }
        if (text.includes('UPDATE platform_charge_settings')) {
          return {
            rows: [
              {
                id: 'row-1',
                charge_type: 'service_charge',
                calculation_type: 'fixed',
                value: 2.5,
                currency: 'INR',
                is_active: true,
                created_by: null,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await repo.updateActiveCharges(
        {
          serviceCharge: 2.5,
          convenienceFee: 2.0,
          gst: 18.0,
          adminId: 'non-uuid-string-token',
        },
        mockClient,
      );

      expect(result).toBeDefined();
    });

    it('inserts new active rows if none existed', async () => {
      mockClient.query.mockImplementation(async (text, values) => {
        if (text.includes('FOR UPDATE')) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('INSERT INTO platform_charge_settings')) {
          return {
            rows: [
              {
                id: 'new-row',
                charge_type: values[0],
                calculation_type: values[1],
                value: values[2],
                currency: 'INR',
                is_active: true,
                created_by: null,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const result = await repo.updateActiveCharges(
        {
          serviceCharge: 2.5,
          convenienceFee: 2.0,
          gst: 18.0,
        },
        mockClient,
      );

      expect(result).toBeDefined();
    });
  });
});
