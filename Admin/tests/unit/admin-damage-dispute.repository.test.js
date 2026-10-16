'use strict';

const adminDamageDisputeRepository = require('../../src/repositories/admin-damage-dispute.repository');

const TEST_DAMAGE_ID = 'a0000001-0000-4000-a000-000000000001';
const TEST_DISPUTE_ID = 'd0000001-0000-4000-a000-000000000001';
const TEST_BOOKING_ID = 'b0000001-0000-4000-a000-000000000001';
const TEST_VEHICLE_ID = 'v0000001-0000-4000-a000-000000000001';
const TEST_PARTNER_ID = 'p0000001-0000-4000-a000-000000000001';
const TEST_CUSTOMER_ID = 'c0000001-0000-4000-a000-000000000001';
const TEST_ADMIN_ID = 'adm00001-0000-4000-a000-000000000001';

describe('Unit: Admin Damage & Dispute Repository', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    adminDamageDisputeRepository.setMockDamageDisputeResolver(
      (sql, params) => mockClient.query(sql, params),
    );
  });

  afterEach(() => {
    adminDamageDisputeRepository.resetMockDamageDisputeResolver();
    jest.restoreAllMocks();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // DAMAGE REPORTS
  // ══════════════════════════════════════════════════════════════════════════════

  describe('1. Damage Reports', () => {
    it('listDamages constructs SQL with filters, pagination, and single-pass count', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DAMAGE_ID,
            booking_id: TEST_BOOKING_ID,
            vehicle_id: TEST_VEHICLE_ID,
            reported_by: TEST_PARTNER_ID,
            damage_type: 'SCRATCH',
            description: 'Scratch on rear door',
            estimated_amount: '1500.00',
            approved_amount: '1200.00',
            status: 'APPROVED',
            photos: ['damages/dmg-1.jpg'],
            created_at: new Date('2026-03-01T10:00:00Z'),
            updated_at: new Date('2026-03-01T12:00:00Z'),
            booking_number: 'BK-1001',
            booking_status: 'COMPLETED',
            partner_id: TEST_PARTNER_ID,
            customer_id: TEST_CUSTOMER_ID,
            registration_number: 'KA-01-AB-1234',
            vehicle_brand: 'Hyundai',
            vehicle_model: 'i20',
            partner_business_name: 'Metro Fleet',
            customer_name: 'John Doe',
            customer_phone: '+919876543210',
            full_count: 1,
          },
        ],
        rowCount: 1,
      });

      const res = await adminDamageDisputeRepository.listDamages({
        search: 'scratch',
        bookingId: TEST_BOOKING_ID,
        vehicleId: TEST_VEHICLE_ID,
        partnerId: TEST_PARTNER_ID,
        customerId: TEST_CUSTOMER_ID,
        status: 'APPROVED',
        damageType: 'SCRATCH',
        startDate: '2026-03-01',
        endDate: '2026-03-05',
        page: 1,
        limit: 10,
        sortBy: 'created_at',
        sortOrder: 'DESC',
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('FROM damage_reports d');
      expect(sql).toContain('COUNT(*) OVER()::int AS full_count');
      expect(params).toContain(TEST_BOOKING_ID);
      expect(params).toContain('APPROVED');
      expect(res.total).toBe(1);
      expect(res.damages).toHaveLength(1);
      expect(res.damages[0].id).toBe(TEST_DAMAGE_ID);
      expect(res.damages[0].estimatedAmount).toBe(1500.00);
      expect(res.damages[0].approvedAmount).toBe(1200.00);
    });

    it('getDamageById returns mapped damage details with joined summaries', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DAMAGE_ID,
            booking_id: TEST_BOOKING_ID,
            vehicle_id: TEST_VEHICLE_ID,
            reported_by: TEST_PARTNER_ID,
            damage_type: 'DENT',
            description: 'Dent on rear bumper',
            estimated_amount: '3000.00',
            approved_amount: null,
            status: 'REPORTED',
            photos: ['damages/dent.jpg'],
            created_at: new Date('2026-03-01T10:00:00Z'),
            updated_at: new Date('2026-03-01T10:00:00Z'),
            booking_number: 'BK-1002',
            booking_status: 'ACTIVE',
            booking_start_date: new Date('2026-03-01T09:00:00Z'),
            booking_end_date: new Date('2026-03-03T09:00:00Z'),
            partner_id: TEST_PARTNER_ID,
            customer_id: TEST_CUSTOMER_ID,
            registration_number: 'KA-05-XY-9999',
            vehicle_brand: 'Tata',
            vehicle_model: 'Nexon',
            vehicle_year: 2023,
            vehicle_color: 'White',
            partner_business_name: 'Metro Fleet',
            partner_email: 'partner@metro.in',
            partner_phone: '+919999999999',
            customer_name: 'Jane Smith',
            customer_email: 'jane@example.com',
            customer_phone: '+919888888888',
            reporter_name: 'Partner Admin',
            reporter_role: 'PARTNER',
          },
        ],
        rowCount: 1,
      });

      const damage = await adminDamageDisputeRepository.getDamageById(TEST_DAMAGE_ID);
      expect(damage).not.toBeNull();
      expect(damage.id).toBe(TEST_DAMAGE_ID);
      expect(damage.booking.bookingNumber).toBe('BK-1002');
      expect(damage.vehicle.registrationNumber).toBe('KA-05-XY-9999');
      expect(damage.partner.businessName).toBe('Metro Fleet');
      expect(damage.customer.name).toBe('Jane Smith');
      expect(damage.reporter.role).toBe('PARTNER');
    });

    it('getDamageById returns null if record does not exist', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const damage = await adminDamageDisputeRepository.getDamageById(TEST_DAMAGE_ID);
      expect(damage).toBeNull();
    });

    it('getDamageForUpdate executes SELECT FOR UPDATE', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: TEST_DAMAGE_ID, status: 'REPORTED' }],
        rowCount: 1,
      });

      const res = await adminDamageDisputeRepository.getDamageForUpdate(mockClient, TEST_DAMAGE_ID);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE'),
        [TEST_DAMAGE_ID],
      );
      expect(res.id).toBe(TEST_DAMAGE_ID);
    });

    it('updateDamageStatus updates status and approved_amount', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: TEST_DAMAGE_ID, status: 'APPROVED', approved_amount: '2500.00' }],
        rowCount: 1,
      });

      const res = await adminDamageDisputeRepository.updateDamageStatus(
        mockClient,
        TEST_DAMAGE_ID,
        {
          status: 'APPROVED',
          approvedAmount: 2500.00,
        },
      );

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE damage_reports'),
        ['APPROVED', 2500.00, TEST_DAMAGE_ID],
      );
      expect(res.status).toBe('APPROVED');
    });

    it('getDamageInspections queries pickup and return verifications', async () => {
      mockClient.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'pk-1',
              booking_id: TEST_BOOKING_ID,
              is_verified: true,
              verified_at: new Date('2026-03-01T09:00:00Z'),
              odometer_start: '12000.50',
              fuel_level_start: 'FULL',
              photos: ['pickup.jpg'],
              notes: 'Clean car',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'ret-1',
              booking_id: TEST_BOOKING_ID,
              returned_at: new Date('2026-03-03T18:00:00Z'),
              odometer_end: '12250.00',
              fuel_level_end: 'FULL',
              late_minutes: 30,
              late_fee: '200.00',
              extra_km: '50.00',
              extra_km_fee: '500.00',
              photos: ['return.jpg'],
              notes: 'Bumper scratch found',
            },
          ],
        });

      const inspections = await adminDamageDisputeRepository.getDamageInspections(TEST_BOOKING_ID);
      expect(inspections.pickup).not.toBeNull();
      expect(inspections.pickup.odometerStart).toBe(12000.50);
      expect(inspections.return).not.toBeNull();
      expect(inspections.return.lateMinutes).toBe(30);
      expect(inspections.return.lateFee).toBe(200.00);
    });

    it('createDamageReport inserts new record', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: TEST_DAMAGE_ID, status: 'REPORTED' }],
        rowCount: 1,
      });

      const res = await adminDamageDisputeRepository.createDamageReport({
        bookingId: TEST_BOOKING_ID,
        vehicleId: TEST_VEHICLE_ID,
        reportedBy: TEST_PARTNER_ID,
        description: 'New dent',
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO damage_reports'),
        expect.any(Array),
      );
      expect(res.id).toBe(TEST_DAMAGE_ID);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // DISPUTES
  // ══════════════════════════════════════════════════════════════════════════════

  describe('2. Disputes', () => {
    it('listDisputes constructs SQL with filters, pagination, and count', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DISPUTE_ID,
            dispute_number: 'DSP-2026-001',
            booking_id: TEST_BOOKING_ID,
            customer_id: TEST_CUSTOMER_ID,
            partner_id: TEST_PARTNER_ID,
            vehicle_id: TEST_VEHICLE_ID,
            damage_report_id: TEST_DAMAGE_ID,
            claimant_id: TEST_CUSTOMER_ID,
            respondent_id: TEST_PARTNER_ID,
            dispute_type: 'DAMAGE_CHARGE',
            status: 'OPEN',
            priority: 'HIGH',
            disputed_amount: '3500.00',
            settled_amount: '0.00',
            currency: 'INR',
            description: 'Customer denies causing front bumper scratch',
            evidence: ['disputes/ev-1.jpg'],
            assigned_to: TEST_ADMIN_ID,
            assigned_at: new Date('2026-03-02T10:00:00Z'),
            resolution: null,
            resolution_reason: null,
            resolved_by: null,
            resolved_at: null,
            rejection_reason: null,
            financial_action: null,
            financial_reference_id: null,
            metadata: {},
            created_at: new Date('2026-03-02T09:00:00Z'),
            updated_at: new Date('2026-03-02T10:00:00Z'),
            booking_number: 'BK-1001',
            registration_number: 'KA-01-AB-1234',
            partner_business_name: 'Metro Fleet',
            customer_name: 'John Doe',
            customer_phone: '+919876543210',
            claimant_name: 'John Doe',
            assigned_to_name: 'Support Officer',
            full_count: 1,
          },
        ],
        rowCount: 1,
      });

      const res = await adminDamageDisputeRepository.listDisputes({
        search: 'denies',
        status: 'OPEN',
        priority: 'HIGH',
        disputeType: 'DAMAGE_CHARGE',
        bookingId: TEST_BOOKING_ID,
        customerId: TEST_CUSTOMER_ID,
        partnerId: TEST_PARTNER_ID,
        assignedTo: TEST_ADMIN_ID,
        page: 1,
        limit: 20,
      });

      expect(mockClient.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockClient.query.mock.calls[0];
      expect(sql).toContain('FROM disputes dp');
      expect(sql).toContain('COUNT(*) OVER()::int AS full_count');
      expect(params).toContain('OPEN');
      expect(params).toContain('HIGH');
      expect(res.total).toBe(1);
      expect(res.disputes).toHaveLength(1);
      expect(res.disputes[0].disputeNumber).toBe('DSP-2026-001');
      expect(res.disputes[0].disputedAmount).toBe(3500.00);
    });

    it('getDisputeById returns mapped dispute projection with joined models', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_DISPUTE_ID,
            dispute_number: 'DSP-2026-002',
            booking_id: TEST_BOOKING_ID,
            customer_id: TEST_CUSTOMER_ID,
            partner_id: TEST_PARTNER_ID,
            vehicle_id: TEST_VEHICLE_ID,
            damage_report_id: TEST_DAMAGE_ID,
            claimant_id: TEST_CUSTOMER_ID,
            respondent_id: TEST_PARTNER_ID,
            dispute_type: 'SECURITY_DEPOSIT',
            status: 'RESOLVED',
            priority: 'MEDIUM',
            disputed_amount: '2000.00',
            settled_amount: '2000.00',
            currency: 'INR',
            description: 'Deposit not refunded',
            evidence: ['deposit_receipt.pdf'],
            assigned_to: TEST_ADMIN_ID,
            assigned_at: new Date('2026-03-02T10:00:00Z'),
            resolution: 'Refund processed to customer',
            resolution_reason: 'Deposit was verified unreturned without damages',
            resolved_by: TEST_ADMIN_ID,
            resolved_at: new Date('2026-03-03T11:00:00Z'),
            rejection_reason: null,
            financial_action: 'REFUND_CUSTOMER',
            financial_reference_id: 'ref-12345',
            metadata: {},
            created_at: new Date('2026-03-02T09:00:00Z'),
            updated_at: new Date('2026-03-03T11:00:00Z'),
            booking_number: 'BK-1002',
            booking_status: 'COMPLETED',
            registration_number: 'KA-01-AB-1234',
            vehicle_brand: 'Hyundai',
            vehicle_model: 'i20',
            partner_business_name: 'Metro Fleet',
            partner_phone: '+919999999999',
            customer_name: 'John Doe',
            customer_email: 'john@example.com',
            customer_phone: '+919876543210',
            claimant_name: 'John Doe',
            claimant_role: 'CUSTOMER',
            respondent_name: 'Metro Partner',
            respondent_role: 'PARTNER',
            assigned_to_name: 'Agent Smith',
            assigned_to_email: 'agent@gongo.in',
            resolved_by_name: 'Agent Smith',
            damage_report_type: 'SCRATCH',
            damage_report_status: 'SETTLED',
            damage_estimated_amount: '1500.00',
            damage_approved_amount: '1500.00',
          },
        ],
        rowCount: 1,
      });

      const dispute = await adminDamageDisputeRepository.getDisputeById(TEST_DISPUTE_ID);
      expect(dispute).not.toBeNull();
      expect(dispute.disputeNumber).toBe('DSP-2026-002');
      expect(dispute.customer.email).toBe('john@example.com');
      expect(dispute.claimant.role).toBe('CUSTOMER');
      expect(dispute.assignedAdmin.email).toBe('agent@gongo.in');
      expect(dispute.damageReport.damageType).toBe('SCRATCH');
      expect(dispute.settledAmount).toBe(2000.00);
      expect(dispute.financialAction).toBe('REFUND_CUSTOMER');
    });

    it('getDisputeForUpdate executes SELECT FOR UPDATE', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: TEST_DISPUTE_ID, status: 'OPEN' }],
        rowCount: 1,
      });

      const res = await adminDamageDisputeRepository.getDisputeForUpdate(
        mockClient,
        TEST_DISPUTE_ID,
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE'),
        [TEST_DISPUTE_ID],
      );
      expect(res.id).toBe(TEST_DISPUTE_ID);
    });

    it('createDispute inserts row into disputes table', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: TEST_DISPUTE_ID, dispute_number: 'DSP-1001' }],
        rowCount: 1,
      });

      const res = await adminDamageDisputeRepository.createDispute({
        disputeNumber: 'DSP-1001',
        bookingId: TEST_BOOKING_ID,
        customerId: TEST_CUSTOMER_ID,
        partnerId: TEST_PARTNER_ID,
        claimantId: TEST_CUSTOMER_ID,
        description: 'Test dispute description',
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO disputes'),
        expect.any(Array),
      );
      expect(res.id).toBe(TEST_DISPUTE_ID);
    });

    it('assignDispute updates assigned_to and status', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: TEST_DISPUTE_ID, assigned_to: TEST_ADMIN_ID, status: 'UNDER_INVESTIGATION' }],
        rowCount: 1,
      });

      const res = await adminDamageDisputeRepository.assignDispute(mockClient, TEST_DISPUTE_ID, {
        assignedTo: TEST_ADMIN_ID,
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE disputes'),
        expect.any(Array),
      );
      expect(res.assigned_to).toBe(TEST_ADMIN_ID);
    });

    it('updateDisputeStatus updates resolution and financial outcome', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ id: TEST_DISPUTE_ID, status: 'RESOLVED', settled_amount: '1500.00' }],
        rowCount: 1,
      });

      const res = await adminDamageDisputeRepository.updateDisputeStatus(
        mockClient,
        TEST_DISPUTE_ID,
        {
          status: 'RESOLVED',
          resolution: 'Refund granted',
          resolutionReason: 'Partner agreed to refund',
          settledAmount: 1500.00,
          resolvedBy: TEST_ADMIN_ID,
          financialAction: 'REFUND_CUSTOMER',
        },
      );

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE disputes'),
        expect.any(Array),
      );
      expect(res.status).toBe('RESOLVED');
    });

    it('getDisputeTimeline queries admin_actions table for DISPUTE actions', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'act-1',
            actor_id: TEST_ADMIN_ID,
            actor_role: 'ADMIN',
            permission: 'disputes.resolve',
            action: 'DISPUTE_ASSIGN',
            target_resource: 'DISPUTE',
            target_resource_id: TEST_DISPUTE_ID,
            request_id: 'req-1',
            before_state: { status: 'OPEN' },
            after_state: { status: 'UNDER_INVESTIGATION' },
            metadata: { note: 'assigned' },
            created_at: new Date('2026-03-02T10:00:00Z'),
          },
        ],
      });

      const timeline = await adminDamageDisputeRepository.getDisputeTimeline(TEST_DISPUTE_ID);
      expect(timeline).toHaveLength(1);
      expect(timeline[0].action).toBe('DISPUTE_ASSIGN');
    });

    it('getActiveAdminUser queries users table for role and active status', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: TEST_ADMIN_ID,
            role: 'ADMIN',
            is_active: true,
            name: 'Active Admin',
            email: 'admin@gongo.in',
          },
        ],
      });

      const user = await adminDamageDisputeRepository.getActiveAdminUser(TEST_ADMIN_ID);
      expect(user).not.toBeNull();
      expect(user.role).toBe('ADMIN');
      expect(user.is_active).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // MOCK RESOLVER HOOKS
  // ══════════════════════════════════════════════════════════════════════════════

  describe('3. Mock Resolver Hooks', () => {
    it('uses mock resolver when set', async () => {
      const mockResolver = jest.fn().mockResolvedValue({ rows: [{ id: 'mock-1' }] });
      adminDamageDisputeRepository.setMockDamageDisputeResolver(mockResolver);

      const res = await adminDamageDisputeRepository._exec('SELECT 1');
      expect(mockResolver).toHaveBeenCalledWith('SELECT 1', []);
      expect(res.rows[0].id).toBe('mock-1');
    });
  });
});
