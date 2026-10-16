'use strict';

const request = require('supertest');


// Mock logger to suppress console noise during testing
jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  http: jest.fn(),
}));

const userRepository = require('../../src/repositories/user.repository');
const adminSessionRepository = require('../../src/repositories/admin-session.repository');
const adminPermissionRepository = require('../../src/repositories/admin-permission.repository');
const adminWalletRepository = require('../../src/repositories/admin-wallet.repository');
const auditService = require('../../src/services/audit.service');
const cashfreeProvider = require('../../src/providers/cashfree');
const { hashSessionToken } = require('../../src/utils/crypto');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { createApp } = require('../../src/app');

const app = createApp();

// ── Test User Fixtures ────────────────────────────────────────────────────────

const SUPER_ADMIN_USER = {
  id: 'a0000001-0000-4000-a000-000000000001',
  auth_id: 'sup-super-admin',
  role: 'ADMIN',
  name: 'Super Admin',
  email: 'superadmin@gongo.in',
  is_active: true,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const FINANCE_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000002',
  auth_id: 'sup-finance-admin',
  role: 'ADMIN',
  name: 'Finance Admin',
  email: 'financeadmin@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.WALLETS_READ,
    PERMISSIONS.PAYOUTS_READ,
    PERMISSIONS.PAYOUTS_APPROVE,
  ],
};

const READONLY_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000003',
  auth_id: 'sup-readonly-admin',
  role: 'ADMIN',
  name: 'Readonly Admin',
  email: 'readonlyadmin@gongo.in',
  is_active: true,
  permissions: [
    PERMISSIONS.WALLETS_READ,
    PERMISSIONS.PAYOUTS_READ,
  ],
};

const NO_PERM_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000004',
  auth_id: 'sup-noperm-admin',
  role: 'ADMIN',
  name: 'No Perm Admin',
  email: 'nopermadmin@gongo.in',
  is_active: true,
  permissions: [],
};

const DEACTIVATED_ADMIN = {
  id: 'a0000001-0000-4000-a000-000000000005',
  auth_id: 'sup-deactivated-admin',
  role: 'ADMIN',
  name: 'Deactivated Admin',
  email: 'deactivated@gongo.in',
  is_active: false,
  permissions: [PERMISSIONS.SUPER_ADMIN],
};

const CUSTOMER_USER = {
  id: 'c0000001-0000-4000-c000-000000000001',
  auth_id: 'sup-customer',
  role: 'CUSTOMER',
  name: 'Regular Customer',
  email: 'customer@gongo.in',
  is_active: true,
  permissions: [],
};

const SESSIONS = {
  superAdmin: 'sess_superadmin_wallet_token_001',
  financeAdmin: 'sess_financeadmin_wallet_token_002',
  readonlyAdmin: 'sess_readonlyadmin_wallet_token_003',
  noPermAdmin: 'sess_nopermadmin_wallet_token_004',
  deactivatedAdmin: 'sess_deactivatedadmin_wallet_token_005',
  customer: 'sess_customer_wallet_token_006',
};

const TEST_WALLET_ID = 'a1111111-1111-4111-a111-111111111111';
const TEST_PARTNER_ID = 'b1111111-1111-4111-a111-111111111111';
const TEST_PAYOUT_ID = 'c1111111-1111-4111-a111-111111111111';
const TEST_BANK_ACCOUNT_ID = 'd1111111-1111-4111-a111-111111111111';

describe('Integration: Admin Wallet & Payout Management (Phase 13)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cashfreeProvider.resetMockDelegate();

    // Session resolution mock
    jest.spyOn(adminSessionRepository, 'findByToken').mockImplementation(async (tokenHash) => {
      const match = Object.entries(SESSIONS).find(
        ([, rawToken]) => hashSessionToken(rawToken) === tokenHash,
      );
      if (!match) return null;
      const key = match[0];
      const userMap = {
        superAdmin: SUPER_ADMIN_USER,
        financeAdmin: FINANCE_ADMIN,
        readonlyAdmin: READONLY_ADMIN,
        noPermAdmin: NO_PERM_ADMIN,
        deactivatedAdmin: DEACTIVATED_ADMIN,
        customer: CUSTOMER_USER,
      };
      const user = userMap[key];
      return {
        id: `sess-${key}`,
        user_id: user.id,
        session_token: tokenHash,
        ip_address: '127.0.0.1',
        user_agent: 'JestTestRunner/1.0',
        is_active: user.is_active !== false,
        created_at: new Date(),
        last_active_at: new Date(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        revoked_at: null,
      };
    });

    // User lookup mock
    jest.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
      const allUsers = [
        SUPER_ADMIN_USER,
        FINANCE_ADMIN,
        READONLY_ADMIN,
        NO_PERM_ADMIN,
        DEACTIVATED_ADMIN,
        CUSTOMER_USER,
      ];
      return allUsers.find((u) => u.id === id) || null;
    });

    jest.spyOn(adminSessionRepository, 'touchSession').mockResolvedValue(true);

    // Permissions lookup mock
    jest.spyOn(adminPermissionRepository, 'findPermissionsByUserId').mockImplementation(async (id) => {
      const allUsers = [
        SUPER_ADMIN_USER,
        FINANCE_ADMIN,
        READONLY_ADMIN,
        NO_PERM_ADMIN,
        DEACTIVATED_ADMIN,
        CUSTOMER_USER,
      ];
      const found = allUsers.find((u) => u.id === id);
      return found ? found.permissions : [];
    });

    jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation(async (cb) => cb({}));

    // Mock audit service to prevent crashes
    jest.spyOn(auditService, 'logAdminAction').mockResolvedValue(true);
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Authentication & RBAC Guards
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Authentication & Role Guards', () => {
    it('returns 401 Unauthorized when unauthenticated', async () => {
      const res = await request(app).get('/api/v1/admin/wallets');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when CUSTOMER token is used', async () => {
      const res = await request(app)
        .get('/api/v1/admin/wallets')
        .set('Authorization', `Bearer ${SESSIONS.customer}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when deactivated admin token is used', async () => {
      const res = await request(app)
        .get('/api/v1/admin/wallets')
        .set('Authorization', `Bearer ${SESSIONS.deactivatedAdmin}`);
      expect([401, 403]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when admin lacks required wallets.read permission', async () => {
      const res = await request(app)
        .get('/api/v1/admin/wallets')
        .set('Authorization', `Bearer ${SESSIONS.noPermAdmin}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 Forbidden when readonly admin attempts payout approval', async () => {
      const res = await request(app)
        .post(`/api/v1/admin/payouts/${TEST_PAYOUT_ID}/approve`)
        .set('Authorization', `Bearer ${SESSIONS.readonlyAdmin}`)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Wallet Endpoints
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Wallet Endpoints', () => {
    it('GET /api/v1/admin/wallets lists wallets with pagination and filters', async () => {
      jest.spyOn(adminWalletRepository, 'listWallets').mockResolvedValue({
        items: [
          {
            id: TEST_WALLET_ID,
            partnerId: TEST_PARTNER_ID,
            availableBalance: 4500.00,
            pendingBalance: 500.00,
            currency: 'INR',
            partner: {
              businessName: 'Metro Motors',
            },
          },
        ],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      });

      const res = await request(app)
        .get('/api/v1/admin/wallets')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].id).toBe(TEST_WALLET_ID);
    });

    it('GET /api/v1/admin/wallets/:id returns wallet detail', async () => {
      jest.spyOn(adminWalletRepository, 'getWalletById').mockResolvedValue({
        id: TEST_WALLET_ID,
        partnerId: TEST_PARTNER_ID,
        availableBalance: 4500.00,
        pendingBalance: 500.00,
        currency: 'INR',
        partner: {
          businessName: 'Metro Motors',
        },
      });

      const res = await request(app)
        .get(`/api/v1/admin/wallets/${TEST_WALLET_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(TEST_WALLET_ID);
      expect(res.body.data.availableBalance).toBe(4500.00);
    });

    it('GET /api/v1/admin/wallets/:id/transactions returns ledger items', async () => {
      jest.spyOn(adminWalletRepository, 'getWalletById').mockResolvedValue({
        id: TEST_WALLET_ID,
        partnerId: TEST_PARTNER_ID,
      });
      jest.spyOn(adminWalletRepository, 'listWalletTransactions').mockResolvedValue({
        items: [
          {
            id: 'tx-1',
            direction: 'CREDIT',
            amount: 1500.00,
            balanceAfter: 4500.00,
          },
        ],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 1,
        },
      });

      const res = await request(app)
        .get(`/api/v1/admin/wallets/${TEST_WALLET_ID}/transactions`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].direction).toBe('CREDIT');
    });

    it('GET /api/v1/admin/wallets/:id/earnings returns partner earnings', async () => {
      jest.spyOn(adminWalletRepository, 'getWalletById').mockResolvedValue({
        id: TEST_WALLET_ID,
        partnerId: TEST_PARTNER_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletEarnings').mockResolvedValue({
        items: [
          {
            id: 'earn-1',
            grossAmount: 2000.00,
            partnerNetAmount: 1600.00,
          },
        ],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 1,
        },
      });

      const res = await request(app)
        .get(`/api/v1/admin/wallets/${TEST_WALLET_ID}/earnings`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
    });

    it('GET /api/v1/admin/wallets/:id/payouts returns partner payouts', async () => {
      jest.spyOn(adminWalletRepository, 'getWalletById').mockResolvedValue({
        id: TEST_WALLET_ID,
        partnerId: TEST_PARTNER_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletPayouts').mockResolvedValue({
        items: [
          {
            id: TEST_PAYOUT_ID,
            amount: 1500.00,
            status: 'COMPLETED',
          },
        ],
        pagination: {
          page: 1,
          limit: 20,
          totalItems: 1,
        },
      });

      const res = await request(app)
        .get(`/api/v1/admin/wallets/${TEST_WALLET_ID}/payouts`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
    });

    it('GET /api/v1/admin/wallets/reconciliation runs balance audit', async () => {
      jest.spyOn(adminWalletRepository, 'reconcileWallets').mockResolvedValue({
        totalWallets: 5,
        reconciledWallets: 5,
        hasDiscrepancy: false,
        discrepancies: [],
      });

      const res = await request(app)
        .get('/api/v1/admin/wallets/reconciliation')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.reconciledWallets).toBe(5);
    });

    it('GET /api/v1/admin/financials/reconciliation also runs balance audit', async () => {
      jest.spyOn(adminWalletRepository, 'reconcileWallets').mockResolvedValue({
        totalWallets: 5,
        reconciledWallets: 5,
        hasDiscrepancy: false,
      });

      const res = await request(app)
        .get('/api/v1/admin/financials/reconciliation')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.reconciledWallets).toBe(5);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Bank Account Endpoints
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Bank Account Endpoints', () => {
    it('GET /api/v1/admin/bank-accounts returns list with masked account numbers', async () => {
      jest.spyOn(adminWalletRepository, 'listBankAccounts').mockResolvedValue({
        items: [
          {
            id: TEST_BANK_ACCOUNT_ID,
            accountHolderName: 'Jane Doe',
            accountNumberMasked: 'XXXX-XXXX-1234',
            bankName: 'HDFC Bank',
          },
        ],
        pagination: { page: 1, limit: 20, totalItems: 1 },
      });

      const res = await request(app)
        .get('/api/v1/admin/bank-accounts')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items[0].accountNumberMasked).toBe('XXXX-XXXX-1234');
      expect(res.body.data.items[0].accountNumberEncrypted).toBeUndefined();
    });

    it('GET /api/v1/admin/bank-accounts/:id returns single bank account', async () => {
      jest.spyOn(adminWalletRepository, 'getBankAccountById').mockResolvedValue({
        id: TEST_BANK_ACCOUNT_ID,
        accountHolderName: 'Jane Doe',
        accountNumberMasked: 'XXXX-XXXX-1234',
        bankName: 'HDFC Bank',
      });

      const res = await request(app)
        .get(`/api/v1/admin/bank-accounts/${TEST_BANK_ACCOUNT_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accountNumberMasked).toBe('XXXX-XXXX-1234');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Payout Endpoints
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Payout Endpoints', () => {
    it('GET /api/v1/admin/payouts lists payouts with filters', async () => {
      jest.spyOn(adminWalletRepository, 'listPayouts').mockResolvedValue({
        items: [
          {
            id: TEST_PAYOUT_ID,
            amount: 2500.00,
            status: 'REQUESTED',
            partner: { businessName: 'Metro Motors' },
          },
        ],
        pagination: { page: 1, limit: 20, totalItems: 1 },
      });

      const res = await request(app)
        .get('/api/v1/admin/payouts?status=REQUESTED')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].amount).toBe(2500.00);
    });

    it('GET /api/v1/admin/payouts/:id returns payout detail', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutById').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        amount: 2500.00,
        status: 'REQUESTED',
        bankAccount: { accountNumberMasked: 'XXXX-XXXX-1234' },
      });

      const res = await request(app)
        .get(`/api/v1/admin/payouts/${TEST_PAYOUT_ID}`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(TEST_PAYOUT_ID);
    });

    it('GET /api/v1/admin/payouts/reconciliation returns summary aggregates', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutReconciliationSummary').mockResolvedValue({
        totalPayouts: 15,
        requested: { count: 3, amount: 6000.00 },
        completed: { count: 10, amount: 25000.00 },
      });

      const res = await request(app)
        .get('/api/v1/admin/payouts/reconciliation')
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.totalPayouts).toBe(15);
    });

    it('POST /api/v1/admin/payouts/:id/approve moves payout to PROCESSING / COMPLETED', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'REQUESTED',
        amount: '2000.00',
        partner_id: TEST_PARTNER_ID,
        bank_account_id: TEST_BANK_ACCOUNT_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID,
        partner_id: TEST_PARTNER_ID,
        available_balance: '5000.00',
      });
      jest.spyOn(adminWalletRepository, 'getBankAccountById').mockResolvedValue({
        id: TEST_BANK_ACCOUNT_ID,
        verificationStatus: 'VERIFIED',
        accountNumberMasked: 'XXXX-XXXX-1234',
        ifscCode: 'HDFC0001234',
        accountHolderName: 'Jane Doe',
      });

      cashfreeProvider.setMockDelegate({
        initiatePayoutTransfer: jest.fn().mockResolvedValue({
          providerTransferId: 'cf_pot_approve_001',
          transferStatus: 'SUCCESS',
        }),
      });

      jest.spyOn(adminWalletRepository, 'updatePayoutStatus').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'COMPLETED',
        provider_transfer_id: 'cf_pot_approve_001',
      });

      const res = await request(app)
        .post(`/api/v1/admin/payouts/${TEST_PAYOUT_ID}/approve`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({ remarks: 'Approve disbursement' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('COMPLETED');
    });

    it('POST /api/v1/admin/payouts/:id/reject rejects payout and restores balance', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'REQUESTED',
        amount: '1000.00',
        partner_id: TEST_PARTNER_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID,
        partner_id: TEST_PARTNER_ID,
        available_balance: '1000.00',
        total_debited: '2000.00',
      });
      jest.spyOn(adminWalletRepository, 'updateWalletBalances').mockResolvedValue({});
      const holdSpy = jest.spyOn(adminWalletRepository, 'adjustPayoutHold').mockResolvedValue();
      const createTxSpy = jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockResolvedValue({});

      // rejectPayout resolves processed_by and updates partner_payouts with raw SQL on the
      // transaction client (status 'rejected', per migration 050/053 status constraint), so
      // the transaction client must support query().
      const fakeClient = {
        query: jest.fn().mockImplementation(async (sql) => {
          if (sql.includes('SELECT id FROM users WHERE id')) {
            return { rows: [{ id: FINANCE_ADMIN.id }] };
          }
          if (sql.includes('UPDATE partner_payouts')) {
            return {
              rows: [{
                id: TEST_PAYOUT_ID,
                status: 'rejected',
                failure_reason: 'KYC discrepancy on bank account',
              }],
            };
          }
          return { rows: [] };
        }),
      };
      jest.spyOn(adminWalletRepository, 'executeInTransaction').mockImplementation(async (cb) => cb(fakeClient));

      const res = await request(app)
        .post(`/api/v1/admin/payouts/${TEST_PAYOUT_ID}/reject`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({ reason: 'KYC discrepancy on bank account' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('rejected');
      // Amount held at request time is released back to the partner's balance
      expect(holdSpy).toHaveBeenCalledWith(fakeClient, TEST_PARTNER_ID, 1000);
      expect(createTxSpy).toHaveBeenCalledWith(
        fakeClient,
        expect.objectContaining({ direction: 'CREDIT', amount: 1000, balanceAfter: 2000 }),
      );
    });

    it('POST /api/v1/admin/payouts/:id/retry retries failed payout', async () => {
      jest.spyOn(adminWalletRepository, 'getPayoutForUpdate').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'FAILED',
        amount: '1000.00',
        partner_id: TEST_PARTNER_ID,
      });
      jest.spyOn(adminWalletRepository, 'getWalletByPartnerIdForUpdate').mockResolvedValue({
        id: TEST_WALLET_ID,
        partner_id: TEST_PARTNER_ID,
        available_balance: '2000.00',
        total_debited: '500.00',
      });
      jest.spyOn(adminWalletRepository, 'updateWalletBalances').mockResolvedValue({});
      jest.spyOn(adminWalletRepository, 'adjustPayoutHold').mockResolvedValue();
      jest.spyOn(adminWalletRepository, 'createWalletTransaction').mockResolvedValue({});
      jest.spyOn(adminWalletRepository, 'updatePayoutStatus').mockResolvedValue({
        id: TEST_PAYOUT_ID,
        status: 'REQUESTED',
      });

      const res = await request(app)
        .post(`/api/v1/admin/payouts/${TEST_PAYOUT_ID}/retry`)
        .set('Authorization', `Bearer ${SESSIONS.financeAdmin}`)
        .send({ reason: 'Admin retry after bank downtime resolved' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('REQUESTED');
    });
  });
});
