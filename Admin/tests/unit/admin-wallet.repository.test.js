'use strict';

const adminWalletRepository = require('../../src/repositories/admin-wallet.repository');

const { setMockWalletResolver, resetMockWalletResolver } = adminWalletRepository;

describe('Unit: AdminWalletRepository', () => {
  const TEST_WALLET_ID = 'w1111111-1111-4111-a111-111111111111';
  const TEST_PARTNER_ID = 'd1111111-1111-4111-a111-111111111111';
  const TEST_BANK_ACCOUNT_ID = 'ba111111-1111-4111-a111-111111111111';
  const TEST_PAYOUT_ID = 'p1111111-1111-4111-a111-111111111111';

  afterEach(() => {
    resetMockWalletResolver();
  });

  it('listWallets returns paginated wallets with filters', async () => {
    setMockWalletResolver(async (sql, params) => {
      expect(sql).toContain('FROM wallets w');
      expect(params).toContain(TEST_PARTNER_ID);
      return {
        rows: [
          {
            id: TEST_WALLET_ID,
            partner_id: TEST_PARTNER_ID,
            available_balance: '5000.00',
            pending_balance: '1200.00',
            total_credited: '10000.00',
            total_debited: '3800.00',
            currency: 'INR',
            created_at: new Date(),
            updated_at: new Date(),
            partner_business_name: 'Metro Motors',
            partner_status: 'ACTIVE',
            partner_owner_name: 'Jane Doe',
            partner_phone: '+919876543210',
            partner_email: 'jane@example.com',
            full_count: 1,
          },
        ],
      };
    });

    const result = await adminWalletRepository.listWallets({
      partnerId: TEST_PARTNER_ID,
      page: 1,
      limit: 10,
    });

    expect(result.pagination.totalItems).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(TEST_WALLET_ID);
    expect(result.items[0].availableBalance).toBe(5000.00);
    expect(result.items[0].partner.businessName).toBe('Metro Motors');
  });

  it('getWalletById returns wallet with joined partner details', async () => {
    setMockWalletResolver(async (sql, params) => {
      expect(sql).toContain('WHERE w.id = $1 OR w.partner_id = $1');
      expect(params[0]).toBe(TEST_WALLET_ID);
      return {
        rows: [
          {
            id: TEST_WALLET_ID,
            partner_id: TEST_PARTNER_ID,
            available_balance: '2500.00',
            pending_balance: '0.00',
            total_credited: '5000.00',
            total_debited: '2500.00',
            currency: 'INR',
            created_at: new Date(),
            updated_at: new Date(),
            partner_business_name: 'Metro Motors',
            partner_status: 'ACTIVE',
            partner_owner_name: 'Jane Doe',
            partner_phone: '+919876543210',
            partner_email: 'jane@example.com',
          },
        ],
      };
    });

    const wallet = await adminWalletRepository.getWalletById(TEST_WALLET_ID);
    expect(wallet).not.toBeNull();
    expect(wallet.id).toBe(TEST_WALLET_ID);
    expect(wallet.partnerId).toBe(TEST_PARTNER_ID);
    expect(wallet.availableBalance).toBe(2500.00);
  });

  it('only references users columns that exist (users has name/phone, not full_name/phone_number)', async () => {
    // Columns of public.users per Customer/Partner users migrations and the live schema export
    const USERS_COLUMNS = new Set([
      'id', 'phone', 'role', 'status', 'created_at', 'updated_at', 'deleted_at', 'firebase_uid',
      'auth_id', 'auth_provider', 'name', 'email', 'is_active', 'country_code', 'created_by',
      'customer_reference',
    ]);
    const captured = [];
    setMockWalletResolver(async (sql) => {
      captured.push(sql);
      return { rows: [] };
    });

    await adminWalletRepository.listWallets({ search: 'jane', page: 1, limit: 10 });
    await adminWalletRepository.getWalletById(TEST_WALLET_ID);
    await adminWalletRepository.listPayouts({ search: 'jane', page: 1, limit: 10 });

    const referenced = captured.flatMap((sql) => [...sql.matchAll(/\bu\.([a-z_]+)/g)].map((m) => m[1]));
    expect(referenced.length).toBeGreaterThan(0);
    const unknown = referenced.filter((col) => !USERS_COLUMNS.has(col));
    expect(unknown).toEqual([]);
  });

  it('listWalletTransactions returns paginated transactions', async () => {
    setMockWalletResolver(async (sql, params) => {
      expect(sql).toContain('FROM wallet_transactions wt');
      expect(params[0]).toBe(TEST_WALLET_ID);
      return {
        rows: [
          {
            id: 'tx1',
            wallet_id: TEST_WALLET_ID,
            partner_id: TEST_PARTNER_ID,
            transaction_type: 'BOOKING_PAYOUT',
            direction: 'CREDIT',
            amount: '1200.00',
            balance_after: '3700.00',
            reference_type: 'BOOKING',
            reference_id: 'bk1',
            status: 'COMPLETED',
            description: 'Settlement credit',
            metadata: {},
            created_at: new Date(),
            full_count: 1,
          },
        ],
      };
    });

    const result = await adminWalletRepository.listWalletTransactions(TEST_WALLET_ID, {
      page: 1,
      limit: 10,
    });

    expect(result.pagination.totalItems).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].direction).toBe('CREDIT');
    expect(result.items[0].amount).toBe(1200.00);
  });

  it('createWalletTransaction inserts transaction and returns row', async () => {
    setMockWalletResolver(async (sql, params) => {
      // wallet_id is first resolved from the partner's wallets row; none here, so the
      // caller's walletId is used
      if (/^SELECT id FROM wallets/.test(sql.trim())) {
        expect(params).toEqual([TEST_PARTNER_ID]);
        return { rows: [] };
      }
      expect(sql).toContain('INSERT INTO wallet_transactions');
      expect(params[0]).toBe(TEST_WALLET_ID);
      expect(params[4]).toBe(1000);
      return {
        rows: [
          {
            id: 'tx2',
            wallet_id: TEST_WALLET_ID,
            partner_id: TEST_PARTNER_ID,
            transaction_type: 'PAYOUT',
            direction: 'DEBIT',
            amount: '1000.00',
            balance_after: '1500.00',
            reference_type: 'PAYOUT',
            reference_id: TEST_PAYOUT_ID,
            status: 'COMPLETED',
          },
        ],
      };
    });

    const tx = await adminWalletRepository.createWalletTransaction(null, {
      walletId: TEST_WALLET_ID,
      partnerId: TEST_PARTNER_ID,
      transactionType: 'PAYOUT',
      direction: 'DEBIT',
      amount: 1000,
      balanceAfter: 1500,
      referenceType: 'PAYOUT',
      referenceId: TEST_PAYOUT_ID,
    });

    expect(tx.id).toBe('tx2');
    expect(tx.status).toBe('COMPLETED');
  });

  it('reconcileWallets checks stored balances against completed ledger records', async () => {
    setMockWalletResolver(async (sql) => {
      expect(sql).toContain('FROM wallets w');
      expect(sql).toContain('LEFT JOIN wallet_transactions wt');
      return {
        rows: [
          {
            wallet_id: TEST_WALLET_ID,
            partner_id: TEST_PARTNER_ID,
            partner_business_name: 'Metro Motors',
            stored_available_balance: '2500.00',
            ledger_calculated_balance: '2500.00',
            ledger_total_credits: '5000.00',
            ledger_total_debits: '2500.00',
            transaction_count: 5,
          },
        ],
      };
    });

    const report = await adminWalletRepository.reconcileWallets();
    expect(report.totalWallets).toBe(1);
    expect(report.reconciledWallets).toBe(1);
    expect(report.hasDiscrepancy).toBe(false);
  });

  it('listBankAccounts returns safe projection with masked account numbers', async () => {
    setMockWalletResolver(async (sql, params) => {
      expect(sql).toContain('FROM partner_bank_accounts ba');
      expect(sql).not.toContain('account_number_encrypted');
      expect(params).toContain(TEST_PARTNER_ID);
      return {
        rows: [
          {
            id: TEST_BANK_ACCOUNT_ID,
            partner_id: TEST_PARTNER_ID,
            account_holder_name: 'Jane Doe',
            account_number_masked: 'XXXX-XXXX-1234',
            ifsc_code: 'HDFC0001234',
            bank_name: 'HDFC Bank',
            is_primary: true,
            verification_status: 'VERIFIED',
            created_at: new Date(),
            updated_at: new Date(),
            partner_business_name: 'Metro Motors',
            full_count: 1,
          },
        ],
      };
    });

    const result = await adminWalletRepository.listBankAccounts({
      partnerId: TEST_PARTNER_ID,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].accountNumberMasked).toBe('XXXX-XXXX-1234');
    expect(result.items[0].accountNumberEncrypted).toBeUndefined();
  });

  it('listPayouts returns paginated payouts with partner and wallet joins', async () => {
    setMockWalletResolver(async (sql, params) => {
      expect(sql).toContain('FROM payouts p');
      // REQUESTED is an alias group for the stored lowercase 'pending'/'requested' statuses,
      // so it is applied as a fixed predicate rather than a bound parameter.
      expect(sql).toContain("(p.status = 'pending' OR p.status = 'requested')");
      // Only pagination values (limit, offset) are bound.
      expect(params).toEqual([20, 0]);
      return {
        rows: [
          {
            id: TEST_PAYOUT_ID,
            partner_id: TEST_PARTNER_ID,
            bank_account_id: TEST_BANK_ACCOUNT_ID,
            amount: '2000.00',
            status: 'REQUESTED',
            provider_transfer_id: null,
            failure_reason: null,
            idempotency_key: 'idem_key_1',
            requested_at: new Date(),
            processed_at: null,
            created_at: new Date(),
            updated_at: new Date(),
            partner_business_name: 'Metro Motors',
            partner_owner_name: 'Jane Doe',
            partner_phone: '+919876543210',
            account_number_masked: 'XXXX-XXXX-1234',
            bank_name: 'HDFC Bank',
            ifsc_code: 'HDFC0001234',
            account_holder_name: 'Jane Doe',
            wallet_id: TEST_WALLET_ID,
            wallet_available_balance: '3000.00',
            full_count: 1,
          },
        ],
      };
    });

    const result = await adminWalletRepository.listPayouts({
      status: 'REQUESTED',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(TEST_PAYOUT_ID);
    expect(result.items[0].amount).toBe(2000.00);
    expect(result.items[0].partner.businessName).toBe('Metro Motors');
    expect(result.items[0].bankAccount.accountNumberMasked).toBe('XXXX-XXXX-1234');
  });

  it('getPayoutReconciliationSummary calculates accurate totals across statuses', async () => {
    setMockWalletResolver(async (sql) => {
      expect(sql).toContain('FROM payouts');
      return {
        rows: [
          {
            total_payouts: 10,
            requested_count: 3,
            requested_amount: '6000.00',
            processing_count: 2,
            processing_amount: '4000.00',
            completed_count: 4,
            completed_amount: '8000.00',
            failed_count: 1,
            failed_amount: '1500.00',
            cancelled_count: 0,
            cancelled_amount: '0.00',
          },
        ],
      };
    });

    const summary = await adminWalletRepository.getPayoutReconciliationSummary();
    expect(summary.totalPayouts).toBe(10);
    expect(summary.requested.count).toBe(3);
    expect(summary.requested.amount).toBe(6000.00);
    expect(summary.completed.amount).toBe(8000.00);
  });
});
