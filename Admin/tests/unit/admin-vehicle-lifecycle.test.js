'use strict';

/**
 * Regression tests for the admin vehicle lifecycle actions (BLOCK / ACTIVATE / DEACTIVATE).
 *
 * NOTE: these are unit-level tests. They assert that the actions run inside a transaction and
 * take a row lock (SELECT ... FOR UPDATE) on the vehicle before writing, which is what serializes
 * them with Customer booking creation in PostgreSQL. Real PostgreSQL concurrency is NOT exercised.
 */

const adminVehicleService = require('../../src/services/admin-vehicle.service');
const adminVehicleRepository = require('../../src/repositories/admin-vehicle.repository');
const adminActionRepository = require('../../src/repositories/admin-action.repository');
const auditService = require('../../src/services/audit.service');
const { ValidationError, NotFoundError, ConflictError } = require('../../src/errors');

const VEHICLE_ID = 'e1111111-1111-4111-a111-111111111111';
const PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';

const lockedRow = (overrides = {}) => ({
  id: VEHICLE_ID,
  partnerId: PARTNER_ID,
  manualStatus: 'ONLINE',
  rentalStatus: 'IDLE',
  verificationStatus: 'VERIFIED',
  isArchived: false,
  isActive: true,
  offlineReason: null,
  ...overrides,
});

describe('Unit: admin vehicle lifecycle (block / activate / deactivate)', () => {
  const TX_CLIENT = { query: jest.fn(), isTxClient: true };

  beforeEach(() => {
    jest.restoreAllMocks();
    adminVehicleRepository.constructor.resetMockVehicleResolver();
    TX_CLIENT.query.mockReset();
    jest.spyOn(adminVehicleRepository, 'withTransaction').mockImplementation(async (cb) => cb(TX_CLIENT));
    jest.spyOn(adminVehicleRepository, 'getActiveBookingCount').mockResolvedValue(0);
    jest.spyOn(adminVehicleRepository, 'updateVehicleStatus').mockImplementation(
      async (id, updates) => ({ id, ...updates }),
    );
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);
  });

  const mockLocked = (row) => jest
    .spyOn(adminVehicleRepository, 'findVehicleByIdForUpdate')
    .mockResolvedValue(row);

  describe('blockVehicle', () => {
    it('sets a temporary admin hold: OFFLINE, is_active=false, is_archived=false, and persists the reason', async () => {
      mockLocked(lockedRow());
      const res = await adminVehicleService.blockVehicle(VEHICLE_ID, { reason: 'Insurance expired' }, { actorId: 'admin-1' });

      expect(adminVehicleRepository.updateVehicleStatus).toHaveBeenCalledWith(
        VEHICLE_ID,
        {
          manualStatus: 'OFFLINE', isActive: false, isArchived: false, offlineReason: 'Insurance expired',
        },
        TX_CLIENT,
      );
      expect(res.message).toBe('Vehicle blocked successfully');
      expect(adminActionRepository.createAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'BLOCK_VEHICLE', targetResourceId: VEHICLE_ID }),
        TX_CLIENT,
      );
    });

    it('locks the vehicle row inside the transaction before writing (no unlocked read path)', async () => {
      const order = [];
      const findSpy = jest.spyOn(adminVehicleRepository, 'findVehicleById');
      jest.spyOn(adminVehicleRepository, 'findVehicleByIdForUpdate').mockImplementation(async (id, client) => {
        order.push(['lock', client]);
        return lockedRow();
      });
      adminVehicleRepository.updateVehicleStatus.mockImplementation(async (id, updates, client) => {
        order.push(['update', client]);
        return { id, ...updates };
      });

      await adminVehicleService.blockVehicle(VEHICLE_ID, {});

      expect(adminVehicleRepository.withTransaction).toHaveBeenCalledTimes(1);
      expect(order).toEqual([['lock', TX_CLIENT], ['update', TX_CLIENT]]);
      expect(findSpy).not.toHaveBeenCalled();
    });

    it('blocks a vehicle that has active/upcoming bookings, keeps them intact and reports the count', async () => {
      mockLocked(lockedRow());
      adminVehicleRepository.getActiveBookingCount.mockResolvedValue(2);

      const res = await adminVehicleService.blockVehicle(VEHICLE_ID, {});
      expect(res.vehicle.isActive).toBe(false);
      expect(res.existingActiveBookings).toBe(2);
      expect(adminVehicleRepository.updateVehicleStatus).toHaveBeenCalledTimes(1);
      // Only the vehicle row is written; no booking mutation is issued
      expect(TX_CLIENT.query).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the locked row does not exist', async () => {
      mockLocked(null);
      await expect(adminVehicleService.blockVehicle(VEHICLE_ID, {})).rejects.toThrow(NotFoundError);
    });

    it('rejects an invalid vehicle id', async () => {
      await expect(adminVehicleService.blockVehicle('not-a-uuid', {})).rejects.toThrow(ValidationError);
    });
  });

  describe('deactivateVehicle', () => {
    it('permanently archives: OFFLINE, is_active=false, is_archived=true (distinct from block)', async () => {
      mockLocked(lockedRow({ manualStatus: 'OFFLINE' }));
      const res = await adminVehicleService.deactivateVehicle(VEHICLE_ID, { reason: 'Partner exited' });

      expect(adminVehicleRepository.updateVehicleStatus).toHaveBeenCalledWith(
        VEHICLE_ID,
        {
          manualStatus: 'OFFLINE', isActive: false, isArchived: true, offlineReason: 'Partner exited',
        },
        TX_CLIENT,
      );
      expect(res.message).toBe('Vehicle deactivated successfully');
      expect(adminVehicleRepository.findVehicleByIdForUpdate)
        .toHaveBeenCalledWith(VEHICLE_ID, TX_CLIENT);
    });

    it('deactivates a vehicle with active/upcoming bookings without cancelling them and reports the count', async () => {
      mockLocked(lockedRow());
      adminVehicleRepository.getActiveBookingCount.mockResolvedValue(1);

      const res = await adminVehicleService.deactivateVehicle(VEHICLE_ID, {});
      expect(res.existingActiveBookings).toBe(1);
      expect(adminVehicleRepository.updateVehicleStatus).toHaveBeenCalledTimes(1);
      // Only the vehicle row is written; no booking mutation is issued.
      expect(TX_CLIENT.query).not.toHaveBeenCalled();
    });
  });

  describe('activateVehicle', () => {
    it('activate after block restores ONLINE for a VERIFIED vehicle and clears the admin hold', async () => {
      mockLocked(lockedRow({
        manualStatus: 'OFFLINE', isActive: false, isArchived: false, offlineReason: 'Blocked by admin',
      }));
      const res = await adminVehicleService.activateVehicle(VEHICLE_ID, {});

      expect(adminVehicleRepository.updateVehicleStatus).toHaveBeenCalledWith(
        VEHICLE_ID,
        {
          manualStatus: 'ONLINE', isActive: true, isArchived: false, offlineReason: null,
        },
        TX_CLIENT,
      );
      expect(res.message).toBe('Vehicle activated successfully');
      // Activation never needs the booking guard
      expect(adminVehicleRepository.getActiveBookingCount).not.toHaveBeenCalled();
    });

    it('treats verification status case-insensitively and accepts legacy APPROVED', async () => {
      mockLocked(lockedRow({ verificationStatus: 'approved', manualStatus: 'OFFLINE', isArchived: true }));
      await adminVehicleService.activateVehicle(VEHICLE_ID, {});
      expect(adminVehicleRepository.updateVehicleStatus.mock.calls[0][1].manualStatus).toBe('ONLINE');
    });

    it('refuses to activate a REJECTED vehicle with 409 ConflictError and writes nothing', async () => {
      mockLocked(lockedRow({ verificationStatus: 'REJECTED', manualStatus: 'OFFLINE', isActive: false }));

      const err = await adminVehicleService.activateVehicle(VEHICLE_ID, {}).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.statusCode).toBe(409);
      expect(err.message).toMatch(/re-verified/);
      expect(adminVehicleRepository.updateVehicleStatus).not.toHaveBeenCalled();
      expect(adminActionRepository.createAction).not.toHaveBeenCalled();
    });

    it.each(['PENDING', 'UNDER_REVIEW', null])(
      'activating an unverified (%s) vehicle lifts the admin hold but keeps it OFFLINE',
      async (verificationStatus) => {
        mockLocked(lockedRow({
          verificationStatus, manualStatus: 'OFFLINE', isActive: false, isArchived: true,
        }));
        const res = await adminVehicleService.activateVehicle(VEHICLE_ID, {});

        expect(adminVehicleRepository.updateVehicleStatus).toHaveBeenCalledWith(
          VEHICLE_ID,
          {
            manualStatus: 'OFFLINE', isActive: true, isArchived: false, offlineReason: null,
          },
          TX_CLIENT,
        );
        expect(res.message).toMatch(/remains OFFLINE until its verification is approved/);
      },
    );
  });
});

describe('Unit: AdminVehicleRepository lifecycle SQL', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    adminVehicleRepository.constructor.resetMockVehicleResolver();
  });

  it('findVehicleByIdForUpdate issues SELECT ... FOR UPDATE and maps is_archived / is_active independently', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          id: VEHICLE_ID,
          partner_id: PARTNER_ID,
          manual_status: 'OFFLINE',
          verification_status: 'VERIFIED',
          is_archived: false,
          is_active: false,
          offline_reason: 'Blocked by admin',
        }],
      }),
    };

    const row = await adminVehicleRepository.findVehicleByIdForUpdate(VEHICLE_ID, client);
    const sql = client.query.mock.calls[0][0];

    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/COALESCE\(is_archived, false\) AS is_archived/);
    expect(sql).not.toMatch(/NOT is_active\) AS is_archived/);
    expect(row.isArchived).toBe(false);
    expect(row.isActive).toBe(false);
    expect(row.offlineReason).toBe('Blocked by admin');
  });

  it('updateVehicleStatus writes is_active and is_archived independently for a BLOCK and the reason to offline_reason', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue({ id: VEHICLE_ID });

    await adminVehicleRepository.updateVehicleStatus(
      VEHICLE_ID,
      {
        manualStatus: 'OFFLINE', isActive: false, isArchived: false, offlineReason: 'Blocked',
      },
      client,
    );

    const [sql, values] = client.query.mock.calls[0];
    expect(sql).toMatch(/manual_status = \$2/);
    expect(sql).toMatch(/is_available = false/);
    expect(sql).toMatch(/offline_reason = \$3/);
    expect(sql).not.toMatch(/rejection_reason/);
    expect(sql).toMatch(/is_active = \$4/);
    expect(sql).toMatch(/is_archived = \$5/);
    expect(values).toEqual([VEHICLE_ID, 'OFFLINE', 'Blocked', false, false]);
    expect(adminVehicleRepository.findVehicleById).toHaveBeenCalledWith(VEHICLE_ID, client);
  });

  it('updateVehicleStatus still derives is_active = !isArchived when isActive is not given (PATCH /status)', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue({ id: VEHICLE_ID });

    await adminVehicleRepository.updateVehicleStatus(VEHICLE_ID, { isArchived: true }, client);

    const [sql, values] = client.query.mock.calls[0];
    expect(sql).toMatch(/is_active = \$2/);
    expect(sql).toMatch(/is_archived = \$3/);
    expect(values).toEqual([VEHICLE_ID, false, true]);
  });

  it('end-to-end with the real repository: block locks the row then updates it on the same transaction client', async () => {
    const statements = [];
    const client = {
      query: jest.fn(async (text) => {
        statements.push(text.replace(/\s+/g, ' ').trim());
        if (/FOR UPDATE/.test(text)) {
          return {
            rows: [{
              id: VEHICLE_ID,
              partner_id: PARTNER_ID,
              manual_status: 'ONLINE',
              verification_status: 'VERIFIED',
              is_archived: false,
              is_active: true,
            }],
          };
        }
        if (/FROM bookings/.test(text) && /COUNT/.test(text)) return { rows: [{ count: 0 }] };
        return { rows: [] };
      }),
    };
    jest.spyOn(adminVehicleRepository, 'withTransaction').mockImplementation(async (cb) => cb(client));
    jest.spyOn(adminVehicleRepository, 'findVehicleById').mockResolvedValue({ id: VEHICLE_ID, manualStatus: 'OFFLINE' });
    jest.spyOn(adminActionRepository, 'createAction').mockResolvedValue({ id: 'act-1' });
    jest.spyOn(auditService, 'logAdminAction').mockImplementation((evt) => evt);

    await adminVehicleService.blockVehicle(VEHICLE_ID, { reason: 'Hold' });

    const lockIdx = statements.findIndex((s) => /FROM vehicles WHERE id = \$1 FOR UPDATE/.test(s));
    const updateIdx = statements.findIndex((s) => /^UPDATE vehicles SET/.test(s));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(lockIdx);
    expect(statements[updateIdx]).toMatch(/is_active = \$\d+/);
  });
});
