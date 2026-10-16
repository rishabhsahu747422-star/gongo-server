'use strict';

const BankAccountService = require('../../src/services/bank-account.service').constructor;
const { NotFoundError, ConflictError } = require('../../src/errors');
const { pool } = require('../../src/db/pool');

describe('Unit: BankAccountService', () => {
  let mockBankAccountRepo;
  let bankAccountService;
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    jest.spyOn(pool, 'connect').mockResolvedValue(mockClient);

    mockBankAccountRepo = {
      createBankAccount: jest.fn(),
      findByPartnerId: jest.fn(),
      findByIdAndPartnerId: jest.fn(),
      findPrimaryByPartnerId: jest.fn(),
      unsetPrimary: jest.fn(),
      setPrimary: jest.fn(),
      hasActivePayouts: jest.fn(),
      deleteByIdAndPartnerId: jest.fn(),
    };

    bankAccountService = new BankAccountService(mockBankAccountRepo);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('addBankAccount', () => {
    it('masks and encrypts account number and sets primary if first account', async () => {
      mockBankAccountRepo.findByPartnerId.mockResolvedValue([]);
      mockBankAccountRepo.createBankAccount.mockResolvedValue({
        id: 'bank-1',
        partner_id: 'partner-1',
        account_holder_name: 'Rahul Sharma',
        account_number_masked: '•••• •••• 9012',
        ifsc_code: 'HDFC0001234',
        bank_name: 'HDFC Bank',
        is_primary: true,
        verification_status: 'VERIFIED',
        created_at: '2026-03-01T10:00:00.000Z',
        updated_at: '2026-03-01T10:00:00.000Z',
      });

      const result = await bankAccountService.addBankAccount('partner-1', {
        accountHolderName: 'Rahul Sharma',
        accountNumber: '123456789012',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
      });

      expect(result.id).toBe('bank-1');
      expect(result.accountNumberMasked).toBe('•••• •••• 9012');
      expect(result.verificationStatus).toBe('VERIFIED');
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockBankAccountRepo.createBankAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          accountNumberMasked: '•••• •••• 9012',
          accountNumberEncrypted: expect.any(String),
          isPrimary: true,
        }),
        mockClient,
      );
    });
  });

  describe('deleteBankAccount', () => {
    it('deletes bank account when no active payouts exist', async () => {
      mockBankAccountRepo.findByIdAndPartnerId.mockResolvedValue({
        id: 'bank-1',
        partner_id: 'partner-1',
        is_primary: false,
      });
      mockBankAccountRepo.hasActivePayouts.mockResolvedValue(false);
      mockBankAccountRepo.deleteByIdAndPartnerId.mockResolvedValue(true);

      const res = await bankAccountService.deleteBankAccount('partner-1', 'bank-1');
      expect(res.deleted).toBe(true);
      expect(mockBankAccountRepo.deleteByIdAndPartnerId).toHaveBeenCalledWith('bank-1', 'partner-1', mockClient);
    });

    it('rejects deletion with ConflictError when active payouts exist', async () => {
      mockBankAccountRepo.findByIdAndPartnerId.mockResolvedValue({
        id: 'bank-1',
        partner_id: 'partner-1',
        is_primary: false,
      });
      mockBankAccountRepo.hasActivePayouts.mockResolvedValue(true);

      await expect(
        bankAccountService.deleteBankAccount('partner-1', 'bank-1'),
      ).rejects.toThrow(ConflictError);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('throws NotFoundError when bank account does not exist or not owned', async () => {
      mockBankAccountRepo.findByIdAndPartnerId.mockResolvedValue(null);

      await expect(
        bankAccountService.deleteBankAccount('partner-1', 'bank-foreign'),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
