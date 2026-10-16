'use strict';

const adminReportsRepository = require('../../src/repositories/admin-reports.repository');

describe('Unit: AdminReportsRepository', () => {
  let mockExecutor;

  beforeEach(() => {
    mockExecutor = jest.fn();
    adminReportsRepository.query = mockExecutor;
    adminReportsRepository.constructor.resetMockReportsResolver();
  });

  afterEach(() => {
    jest.clearAllMocks();
    adminReportsRepository.constructor.resetMockReportsResolver();
  });

  describe('1. getOperationalSummary', () => {
    it('executes single-pass aggregation queries across platform tables', async () => {
      mockExecutor
        .mockResolvedValueOnce({ rows: [{ total: 100, active: 80, in_range: 20 }] })
        .mockResolvedValueOnce({ rows: [{ total: 50, online: 30, verified: 40, pending_kyc: 5 }] })
        .mockResolvedValueOnce({ rows: [{ total: 200, active: 150, idle: 100, booked: 50 }] })
        .mockResolvedValueOnce({
          rows: [{
            total: 500,
            completed: 400,
            cancelled: 50,
            active: 50,
            gross_booking_value: '125000.50',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            total: 600,
            successful: 550,
            collected: '150000.00',
            pending: '5000.00',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: 30, completed: 25, total_refunded: '8000.00' }] })
        .mockResolvedValueOnce({ rows: [{ total_commission: '25000.00' }] })
        .mockResolvedValueOnce({ rows: [{ completed: '85000.00', pending: '12000.00' }] })
        .mockResolvedValueOnce({ rows: [{ total: 80, open_tickets: 15, resolved_tickets: 65 }] })
        .mockResolvedValueOnce({ rows: [{ total: 1000, sent: 980, failed: 20 }] });

      const summary = await adminReportsRepository.getOperationalSummary();

      expect(summary.customers.total).toBe(100);
      expect(summary.partners.total).toBe(50);
      expect(summary.vehicles.total).toBe(200);
      expect(summary.bookings.completed).toBe(400);
      expect(summary.bookings.grossBookingValue).toBe(125000.5);
      expect(summary.payments.collected).toBe(150000);
      expect(summary.refunds.totalRefunded).toBe(8000);
      expect(summary.commissions.totalCommissionEarned).toBe(25000);
      expect(summary.payouts.completed).toBe(85000);
      expect(summary.support.open).toBe(15);
      expect(summary.notifications.sent).toBe(980);
      expect(summary.generatedAt).toBeDefined();
    });
  });

  describe('2. getBookingsReport', () => {
    it('executes parameterized query with filters and bounded pagination', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            bookingId: 'b0000000-0000-0000-0000-000000000001',
            bookingNumber: 'BKG-1001',
            customerName: 'Alice',
            customerPhone: '+919876543210',
            partnerBusinessName: 'Swift Rentals',
            vehicleRegistration: 'MH01AB1234',
            vehicleBrand: 'Tata',
            vehicleModel: 'Nexon',
            city: 'Mumbai',
            bookingStatus: 'COMPLETED',
            paymentStatus: 'PAID',
            totalAmount: '4500.00',
            startDatetime: new Date('2026-09-01T10:00:00Z'),
            endDatetime: new Date('2026-09-02T10:00:00Z'),
            durationHours: '24.0',
            cancellationReason: null,
            createdAt: new Date('2026-08-30T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getBookingsReport({
        status: 'COMPLETED',
        city: 'Mumbai',
        page: 1,
        limit: 20,
      });

      expect(res.items).toHaveLength(1);
      expect(res.items[0].bookingNumber).toBe('BKG-1001');
      expect(res.items[0].totalAmount).toBe(4500);
      expect(res.items[0].durationHours).toBe(24);
      expect(res.pagination.total).toBe(1);
    });
  });

  describe('3. getCustomersReport', () => {
    it('returns customer metrics aggregated across reservations', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            customerId: 'c0000000-0000-0000-0000-000000000001',
            name: 'John Doe',
            email: 'john@example.com',
            phone: '+919999999999',
            accountStatus: 'ACTIVE',
            registrationDate: new Date('2026-01-15T00:00:00Z'),
            totalBookings: 12,
            completedBookings: 10,
            cancelledBookings: 2,
            totalSpend: '36000.00',
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getCustomersReport({ page: 1, limit: 10 });
      expect(res.items).toHaveLength(1);
      expect(res.items[0].name).toBe('John Doe');
      expect(res.items[0].totalSpend).toBe(36000);
    });
  });

  describe('4. getPartnersReport', () => {
    it('returns partner metrics including vehicle and booking counts', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            partnerId: 'p0000000-0000-0000-0000-000000000001',
            businessName: 'Royal Motors',
            ownerName: 'Robert',
            email: 'robert@royal.com',
            phone: '+918888888888',
            city: 'Delhi',
            partnerStatus: 'ONLINE',
            kycStatus: 'VERIFIED',
            totalVehicles: 8,
            activeVehicles: 7,
            totalBookings: 45,
            completedBookings: 40,
            registrationDate: new Date('2026-02-01T00:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getPartnersReport({ city: 'Delhi' });
      expect(res.items).toHaveLength(1);
      expect(res.items[0].businessName).toBe('Royal Motors');
      expect(res.items[0].totalVehicles).toBe(8);
    });
  });

  describe('5. getVehiclesReport', () => {
    it('returns vehicle metrics with utilization and revenue', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            vehicleId: 'v0000000-0000-0000-0000-000000000001',
            registrationNumber: 'DL01XY9999',
            partnerBusinessName: 'Royal Motors',
            brand: 'Hyundai',
            model: 'Creta',
            city: 'Delhi',
            verificationStatus: 'VERIFIED',
            rentalStatus: 'IDLE',
            manualStatus: 'ONLINE',
            totalBookings: 15,
            completedBookings: 14,
            totalRevenue: '56000.00',
            createdAt: new Date('2026-02-10T00:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getVehiclesReport();
      expect(res.items).toHaveLength(1);
      expect(res.items[0].registrationNumber).toBe('DL01XY9999');
      expect(res.items[0].totalRevenue).toBe(56000);
    });
  });

  describe('6. getPaymentsReport and getRefundsReport', () => {
    it('getPaymentsReport queries payments with safe projection', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            paymentId: 'py000000-0000-0000-0000-000000000001',
            bookingId: 'b0000000-0000-0000-0000-000000000001',
            bookingNumber: 'BKG-1001',
            customerName: 'Alice',
            partnerBusinessName: 'Swift Rentals',
            amount: '4500.00',
            currency: 'INR',
            paymentType: 'CARD',
            provider: 'CASHFREE',
            providerReference: 'cf_pay_9988',
            status: 'SUCCESS',
            createdAt: new Date('2026-09-01T10:00:00Z'),
            updatedAt: new Date('2026-09-01T10:05:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getPaymentsReport({ status: 'SUCCESS' });
      expect(res.items).toHaveLength(1);
      expect(res.items[0].amount).toBe(4500);
      expect(res.items[0].provider).toBe('CASHFREE');
    });

    it('getRefundsReport queries refunds table', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            refundId: 'rf000000-0000-0000-0000-000000000001',
            refundNumber: 'RF-5001',
            paymentId: 'py000000-0000-0000-0000-000000000001',
            bookingId: 'b0000000-0000-0000-0000-000000000001',
            bookingNumber: 'BKG-1001',
            customerName: 'Alice',
            requestedAmount: '1000.00',
            approvedAmount: '1000.00',
            refundedAmount: '1000.00',
            currency: 'INR',
            status: 'COMPLETED',
            reason: 'Security deposit refund',
            provider: 'CASHFREE',
            providerRefundId: 'cf_ref_1122',
            processedAt: new Date('2026-09-03T10:00:00Z'),
            createdAt: new Date('2026-09-02T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getRefundsReport();
      expect(res.items).toHaveLength(1);
      expect(res.items[0].refundNumber).toBe('RF-5001');
      expect(res.items[0].refundedAmount).toBe(1000);
    });
  });

  describe('7. getCommissionsReport', () => {
    it('queries internal commission transactions', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            commissionId: 'cm000000-0000-0000-0000-000000000001',
            bookingId: 'b0000000-0000-0000-0000-000000000001',
            bookingNumber: 'BKG-1001',
            partnerBusinessName: 'Swift Rentals',
            commissionType: 'percentage',
            commissionRate: 15,
            grossBookingAmount: '4500.00',
            commissionAmount: '675.00',
            partnerPayableAmount: '3825.00',
            status: 'CALCULATED',
            createdAt: new Date('2026-09-01T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getCommissionsReport();
      expect(res.items).toHaveLength(1);
      expect(res.items[0].commissionAmount).toBe(675);
      expect(res.items[0].partnerPayableAmount).toBe(3825);
    });
  });

  describe('8. getWalletsReport and getPayoutsReport', () => {
    it('getWalletsReport queries ledger entries with partner details', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            transactionId: 'wt000000-0000-0000-0000-000000000001',
            walletId: 'w0000000-0000-0000-0000-000000000001',
            partnerBusinessName: 'Swift Rentals',
            transactionType: 'EARNING_CREDIT',
            amount: '3825.00',
            balanceAfter: '15000.00',
            referenceType: 'BOOKING',
            referenceId: 'b0000000-0000-0000-0000-000000000001',
            description: 'Rental earnings',
            createdAt: new Date('2026-09-02T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getWalletsReport();
      expect(res.items).toHaveLength(1);
      expect(res.items[0].amount).toBe(3825);
    });

    it('getPayoutsReport queries payouts with masked bank accounts', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            payoutId: 'po000000-0000-0000-0000-000000000001',
            partnerId: 'p0000000-0000-0000-0000-000000000001',
            partnerBusinessName: 'Swift Rentals',
            amount: '10000.00',
            status: 'COMPLETED',
            accountHolderName: 'Swift Rentals Ltd',
            bankName: 'HDFC Bank',
            accountNumberMasked: 'XXXXXX1234',
            ifscCode: 'HDFC0001234',
            requestedAt: new Date('2026-09-03T10:00:00Z'),
            processedAt: new Date('2026-09-03T14:00:00Z'),
            failureReason: null,
            createdAt: new Date('2026-09-03T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getPayoutsReport();
      expect(res.items).toHaveLength(1);
      expect(res.items[0].accountNumberMasked).toBe('XXXXXX1234');
      expect(res.items[0].amount).toBe(10000);
    });
  });

  describe('9. getKycReport, getSupportReport, getDisputesReport, getNotificationsReport', () => {
    it('getKycReport queries unified verification CTE', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            documentId: 'd0000000-0000-0000-0000-000000000001',
            entityType: 'PARTNER',
            entityId: 'p0000000-0000-0000-0000-000000000001',
            entityName: 'Swift Rentals',
            documentType: 'GST',
            documentName: 'GST Certificate',
            verificationStatus: 'VERIFIED',
            validTill: null,
            rejectionReason: null,
            submittedAt: new Date('2026-08-01T00:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getKycReport();
      expect(res.items).toHaveLength(1);
      expect(res.items[0].documentType).toBe('GST');
    });

    it('getSupportReport queries tickets with duration', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            ticketId: 'st000000-0000-0000-0000-000000000001',
            ticketNumber: 'TKT-901',
            category: 'BILLING',
            priority: 'HIGH',
            status: 'RESOLVED',
            customerName: 'Alice',
            partnerBusinessName: 'Swift Rentals',
            bookingNumber: 'BKG-1001',
            assignedAdminName: 'Support Agent Bob',
            createdAt: new Date('2026-09-01T10:00:00Z'),
            resolvedAt: new Date('2026-09-01T12:30:00Z'),
            closedAt: null,
            resolutionDurationMinutes: '150.0',
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getSupportReport();
      expect(res.items).toHaveLength(1);
      expect(res.items[0].resolutionDurationMinutes).toBe(150);
    });

    it('getDisputesReport queries union of damages and disputes', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            id: 'dp000000-0000-0000-0000-000000000001',
            reportType: 'DISPUTE',
            bookingNumber: 'BKG-1001',
            customerName: 'Alice',
            partnerBusinessName: 'Swift Rentals',
            status: 'SETTLED',
            amount: '2500.00',
            reasonOrDescription: 'Fuel charge dispute',
            createdAt: new Date('2026-09-02T10:00:00Z'),
            resolvedAt: new Date('2026-09-02T16:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getDisputesReport();
      expect(res.items).toHaveLength(1);
      expect(res.items[0].reportType).toBe('DISPUTE');
      expect(res.items[0].amount).toBe(2500);
    });

    it('getNotificationsReport queries notifications delivery records', async () => {
      mockExecutor.mockResolvedValueOnce({
        rows: [
          {
            notificationId: 'nt000000-0000-0000-0000-000000000001',
            recipientRole: 'CUSTOMER',
            recipientName: 'Alice',
            channel: 'SMS',
            title: 'Booking Confirmed',
            status: 'SENT',
            sentAt: new Date('2026-09-01T10:01:00Z'),
            failedAt: null,
            createdAt: new Date('2026-09-01T10:00:00Z'),
            full_count: 1,
          },
        ],
      });

      const res = await adminReportsRepository.getNotificationsReport();
      expect(res.items).toHaveLength(1);
      expect(res.items[0].channel).toBe('SMS');
      expect(res.items[0].status).toBe('SENT');
    });
  });
});
