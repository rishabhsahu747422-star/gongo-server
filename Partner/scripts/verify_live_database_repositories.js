'use strict';
require('dotenv').config();

const UserRepository = require('../src/repositories/user.repository');
const PartnerRepository = require('../src/repositories/partner.repository');
const ShopRepository = require('../src/repositories/shop.repository');
const vehicleRepository = require('../src/repositories/vehicle.repository');
const pricingRepository = require('../src/repositories/pricing.repository');
const PartnerDocumentRepository = require('../src/repositories/partnerDocument.repository');
const BankAccountRepository = require('../src/repositories/bank-account.repository');
const WalletRepository = require('../src/repositories/wallet.repository');
const WalletTransactionRepository = require('../src/repositories/wallet-transaction.repository');
const PayoutRepository = require('../src/repositories/payout.repository');
const NotificationRepository = require('../src/repositories/notification.repository');
const SupportTicketRepository = require('../src/repositories/support-ticket.repository');
const bookingRepository = require('../src/repositories/booking.repository');
const availabilityRepository = require('../src/repositories/availability.repository');
const CommissionRepository = require('../src/repositories/commission.repository');
const DamageReportRepository = require('../src/repositories/damage-report.repository');
const EarningsRepository = require('../src/repositories/earnings.repository');
const paymentRepository = require('../src/repositories/payment.repository');
const OutboxRepository = require('../src/repositories/outbox.repository');
const storageUploadRepository = require('../src/repositories/storageUpload.repository');

const dummyId = '00000000-0000-0000-0000-000000000000';

async function runRepoVerification() {
  console.log('Testing all 20 repositories against live Supabase PostgreSQL...\n');

  const tests = [
    { name: '1. UserRepository.findById', fn: () => new UserRepository().findById(dummyId) },
    { name: '2. PartnerRepository.findByUserId', fn: () => new PartnerRepository().findByUserId(dummyId) },
    { name: '3. ShopRepository.findByPartnerId', fn: () => new ShopRepository().findByPartnerId(dummyId) },
    { name: '4. VehicleRepository.findById', fn: () => vehicleRepository.findById(dummyId) },
    { name: '5. PricingRepository.findByVehicleId', fn: () => pricingRepository.findByVehicleId(dummyId) },
    { name: '6. PartnerDocumentRepository.findByPartnerId', fn: () => new PartnerDocumentRepository().findByPartnerId(dummyId) },
    { name: '7. BankAccountRepository.findByPartnerId', fn: () => new BankAccountRepository().findByPartnerId(dummyId) },
    { name: '8. WalletRepository.findByPartnerId', fn: () => new WalletRepository().findByPartnerId(dummyId) },
    { name: '9. WalletTransactionRepository.findPaginatedByPartnerId', fn: () => new WalletTransactionRepository().findPaginatedByPartnerId(dummyId, { limit: 1 }) },
    { name: '10. PayoutRepository.findPaginatedByPartnerId', fn: () => new PayoutRepository().findPaginatedByPartnerId(dummyId, { limit: 1 }) },
    { name: '11. NotificationRepository.findPaginatedByPartnerId', fn: () => new NotificationRepository().findPaginatedByPartnerId(dummyId, { limit: 1 }) },
    { name: '12. SupportTicketRepository.findTicketsByPartnerId', fn: () => new SupportTicketRepository().findTicketsByPartnerId(dummyId, { limit: 1 }) },
    { name: '13. BookingRepository.findBookingsByPartnerId', fn: () => bookingRepository.findBookingsByPartnerId(dummyId, { limit: 1 }) },
    { name: '14. AvailabilityRepository.findBlocksByVehicleId', fn: () => availabilityRepository.findBlocksByVehicleId(dummyId, { limit: 1 }) },
    { name: '15. CommissionRepository.findPaginated', fn: () => new CommissionRepository().findPaginated({ limit: 1 }) },
    { name: '16. DamageReportRepository.findPaginated', fn: () => new DamageReportRepository().findPaginated({ limit: 1 }) },
    { name: '17. EarningsRepository.findPaginatedByPartnerId', fn: () => new EarningsRepository().findPaginatedByPartnerId(dummyId, { limit: 1 }) },
    { name: '18. PaymentRepository.findAllByBookingId', fn: () => paymentRepository.findAllByBookingId(dummyId) },
    { name: '19. OutboxRepository.fetchPendingEvents', fn: () => new OutboxRepository().fetchPendingEvents(1) },
    { name: '20. StorageUploadRepository.findById', fn: () => storageUploadRepository.findById(dummyId) },
  ];

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`[PASS] ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${t.name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nVerification Summary: ${passed} PASSED, ${failed} FAILED out of ${tests.length} repositories.`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runRepoVerification().catch(err => {
  console.error('Fatal verification failure:', err);
  process.exit(1);
});
