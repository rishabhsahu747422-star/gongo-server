process.env.NODE_ENV = 'test';
require('dotenv').config();
const db = require('../src/db/pool');
const { redisClient } = require('../src/providers/redis');
const otpService = require('../src/services/otp.service');
const authService = require('../src/services/auth.service');
const UserRepository = require('../src/repositories/user.repository');
const PartnerRepository = require('../src/repositories/partner.repository');
const ShopRepository = require('../src/repositories/shop.repository');
const WalletRepository = require('../src/repositories/wallet.repository');

const userRepo = new UserRepository();
const partnerRepo = new PartnerRepository();
const shopRepo = new ShopRepository();
const walletRepo = new WalletRepository();

const TEST_PHONE = '9999900088';
const TEST_NAME = 'Test Partner Live Registration';
const TEST_SHOP = 'Test Live Garage Hub';
const TEST_CITY = 'Bhopal';

async function cleanupTestRecords() {
  const existingUser = await userRepo.findByPhone(TEST_PHONE);
  if (existingUser) {
    const existingPartner = await partnerRepo.findByAuthId(existingUser.auth_id);
    if (existingPartner) {
      await db.query('DELETE FROM wallets WHERE partner_id = $1', [existingPartner.id]);
      await db.query('DELETE FROM shops WHERE partner_id = $1', [existingPartner.id]);
      await db.query('DELETE FROM partners WHERE id = $1', [existingPartner.id]);
    }
    await db.query('DELETE FROM users WHERE id = $1', [existingUser.id]);
  }
  await redisClient.del(`partner:otp:${TEST_PHONE}`);
  await redisClient.del(`partner:otp:cooldown:${TEST_PHONE}`);
  await redisClient.del(`partner:otp:attempts:${TEST_PHONE}`);
}

async function runLiveTest() {
  console.log('\n================================================================');
  console.log('GONGO Partner App — Real Database & Redis End-to-End Registration');
  console.log('================================================================\n');

  try {
    // 0. Initial Cleanup
    await cleanupTestRecords();
    console.log('1. Pre-test cleanup completed.');

    // 1. Send OTP
    const sendRes = await otpService.sendPartnerOtp({ phone: TEST_PHONE });
    console.log('2. OTP generated:', { devOtp: sendRes.devOtp, cooldown: sendRes.cooldown });
    const otp = sendRes.devOtp;

    // 2. Verify OTP with requireExisting: false (Register Flow)
    const verifyRes = await otpService.verifyPartnerOtp({
      phone: TEST_PHONE,
      otp,
      requireExisting: false,
    });
    console.log('3. Registration OTP verified:', {
      isRegistered: verifyRes.isRegistered,
      tokenIssued: Boolean(verifyRes.token),
    });

    if (verifyRes.isRegistered !== false || !verifyRes.token) {
      throw new Error('Expected isRegistered: false and registration session token');
    }

    const regSessionToken = verifyRes.token;

    // Verify session token payload in Redis
    const sessionRaw = await redisClient.get(`auth:session:${regSessionToken}`);
    const session = JSON.parse(sessionRaw);
    console.log('4. Redis registration session verified:', {
      status: session.status,
      phone: session.phone,
      uid: session.uid,
    });

    const TEST_LANDMARK = 'Near SBI Bank, opposite City Mall';

    // 3. Complete Partner Registration (Simulating POST /api/v1/auth/register)
    const regResult = await authService.registerPartner({
      authUser: {
        authId: session.uid,
        uid: session.uid,
        phone: session.phone,
      },
      registrationData: {
        name: TEST_NAME,
        shopName: TEST_SHOP,
        city: TEST_CITY,
        shopAddress: 'Zone 1, MP Nagar',
        landmark: TEST_LANDMARK,
        phone: TEST_PHONE,
      },
      requestId: 'req-live-e2e-test',
    });

    console.log('5. Partner registration transaction succeeded:');
    console.log('   - User ID:', regResult.user.id);
    console.log('   - Partner ID:', regResult.partner.id);
    console.log('   - Shop Name:', regResult.partner.shopName);
    console.log('   - Landmark:', regResult.partner.landmark);
    console.log('   - Partner Status:', regResult.partner.partnerStatus);
    console.log('   - KYC Status:', regResult.partner.kycStatus);

    if (regResult.partner.landmark !== TEST_LANDMARK) {
      throw new Error(`Expected regResult.partner.landmark to be "${TEST_LANDMARK}", got "${regResult.partner.landmark}"`);
    }

    // 4. Verify all records in PostgreSQL
    const dbUser = await userRepo.findById(regResult.user.id);
    const dbPartner = await partnerRepo.findById(regResult.partner.id);
    const dbShop = await shopRepo.findByPartnerId(regResult.partner.id);
    const dbWallet = await walletRepo.findByPartnerId(regResult.partner.id);

    if (!dbUser || !dbPartner || !dbShop || !dbWallet) {
      throw new Error('One or more required database records missing after registration');
    }

    if (dbShop.landmark !== TEST_LANDMARK) {
      throw new Error(`Expected dbShop.landmark to be "${TEST_LANDMARK}", got "${dbShop.landmark}"`);
    }

    if (dbPartner.landmark !== TEST_LANDMARK) {
      throw new Error(`Expected dbPartner.landmark to be "${TEST_LANDMARK}", got "${dbPartner.landmark}"`);
    }

    console.log('6. Authoritative Database Records Verified:');
    console.log('   - User record verified (phone:', dbUser.phone, ')');
    console.log('   - Partner record verified (partner_reference:', dbPartner.partner_reference, ', landmark:', dbPartner.landmark, ')');
    console.log('   - Shop record verified (shop_name:', dbShop.shop_name, ', landmark:', dbShop.landmark, ')');
    console.log('   - Wallet record verified (available_balance:', dbWallet.available_balance, ')');

    // 5. Verify that existing registration rejects duplicate registration
    let duplicateRejected = false;
    try {
      await authService.registerPartner({
        authUser: { authId: session.uid, phone: TEST_PHONE },
        registrationData: { name: TEST_NAME, shopName: TEST_SHOP, city: TEST_CITY, phone: TEST_PHONE },
      });
    } catch (dupErr) {
      duplicateRejected = true;
      console.log('7. Duplicate registration correctly rejected:', dupErr.message);
    }
    if (!duplicateRejected) {
      throw new Error('Duplicate registration should have been rejected!');
    }

    // 6. Verify that new partner can now login via normal Login flow
    const loginSend = await otpService.sendPartnerOtp({ phone: TEST_PHONE });
    const loginVerify = await otpService.verifyPartnerOtp({
      phone: TEST_PHONE,
      otp: loginSend.devOtp,
      requireExisting: true,
    });

    console.log('8. Subsequent Login Verified for newly registered Partner:');
    console.log('   - Login successful:', loginVerify.isRegistered === true);
    console.log('   - Token issued:', Boolean(loginVerify.token));
    console.log('   - Partner ID:', loginVerify.partner.id);

    // 7. Cleanup
    await cleanupTestRecords();
    console.log('9. Post-test cleanup completed successfully.\n');
    console.log('>>> ALL REAL DATABASE & REDIS REGISTRATION CHECKS PASSED! <<<\n');
    process.exit(0);
  } catch (err) {
    console.error('\nTest failed with error:', err);
    await cleanupTestRecords().catch(() => {});
    process.exit(1);
  }
}

runLiveTest();
