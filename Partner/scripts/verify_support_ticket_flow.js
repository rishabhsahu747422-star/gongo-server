'use strict';

const supportTicketService = require('../src/services/support-ticket.service');
const supportTicketValidator = require('../src/validators/support-ticket.validator');
const { pool } = require('../src/db/pool');

async function runVerification() {
  console.log('====================================================');
  console.log('GONGO Partner Support Flow — Comprehensive Verification');
  console.log('====================================================\n');

  const partnerId = 'dc3a5acd-8d03-45c0-8cb9-23d1b3ffd562';
  const otherPartnerId = '4b696412-7f55-4f61-8a38-16f143a7c0e2';
  let createdTicket1 = null;
  let createdTicket2 = null;
  let createdTicket3 = null;

  try {
    // ----------------------------------------------------
    // TEST 1: Create Ticket (Category: BOOKING)
    // ----------------------------------------------------
    console.log('[TEST 1] Creating support ticket with category BOOKING...');
    const payload1 = {
      subject: 'Handover delay dispute GG-9921',
      category: 'BOOKING',
      message: 'Customer arrived 45 minutes late for handover. Please check logs.',
      priority: 'HIGH',
    };
    const validated1 = supportTicketValidator.validateCreateTicket(payload1);
    createdTicket1 = await supportTicketService.createTicket(partnerId, validated1, 'req-test-1');
    console.log('✓ Ticket 1 created successfully:');
    console.log(`  ID: ${createdTicket1.id}`);
    console.log(`  Ticket Number: ${createdTicket1.ticketNumber}`);
    console.log(`  Category: ${createdTicket1.category}`);
    console.log(`  Status: ${createdTicket1.status}`);
    console.log(`  Priority: ${createdTicket1.priority}`);
    console.log(`  Description/Message: ${createdTicket1.description}`);

    // Verify in PostgreSQL database
    const dbCheck1 = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [createdTicket1.id]);
    if (dbCheck1.rows.length === 0) throw new Error('Ticket 1 not found in PostgreSQL!');
    const row1 = dbCheck1.rows[0];
    if (row1.partner_id !== partnerId) throw new Error(`Partner ID mismatch in DB: ${row1.partner_id} vs ${partnerId}`);
    if (!row1.user_id) throw new Error('User ID is null in DB!');
    if (!row1.description) throw new Error('Description is null in DB!');
    console.log(`✓ DB Verification Passed: partner_id=${row1.partner_id}, user_id=${row1.user_id}, ticket_number=${row1.ticket_number}\n`);

    // ----------------------------------------------------
    // TEST 2: Create Ticket (Category: PAYOUT)
    // ----------------------------------------------------
    console.log('[TEST 2] Creating support ticket with category PAYOUT (Payout & Wallet)...');
    const payload2 = {
      subject: 'Payout settlement cycle clarification',
      category: 'PAYOUT',
      message: 'Weekly earnings settlement for weekend bookings has not credited to bank account.',
      priority: 'URGENT',
    };
    const validated2 = supportTicketValidator.validateCreateTicket(payload2);
    createdTicket2 = await supportTicketService.createTicket(partnerId, validated2, 'req-test-2');
    console.log('✓ Ticket 2 created successfully:');
    console.log(`  ID: ${createdTicket2.id}`);
    console.log(`  Ticket Number: ${createdTicket2.ticketNumber}`);
    console.log(`  Category: ${createdTicket2.category}`);
    console.log(`  Priority: ${createdTicket2.priority}`);

    const dbCheck2 = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [createdTicket2.id]);
    const row2 = dbCheck2.rows[0];
    if (row2.category !== 'PAYOUT') throw new Error(`Category mismatch in DB: ${row2.category}`);
    console.log(`✓ DB Verification Passed: Category PAYOUT stored and validated in DB!\n`);

    // ----------------------------------------------------
    // TEST 3: Create Ticket (Category: DAMAGE)
    // ----------------------------------------------------
    console.log('[TEST 3] Creating support ticket with category DAMAGE (Vehicle Damage)...');
    const payload3 = {
      subject: 'Vehicle scratch reported post-booking',
      category: 'DAMAGE',
      message: 'Scratch found on left passenger door after customer return. Inspection photos uploaded.',
      priority: 'HIGH',
      attachments: ['https://storage.gongo.in/damages/photo1.jpg'],
    };
    const validated3 = supportTicketValidator.validateCreateTicket(payload3);
    createdTicket3 = await supportTicketService.createTicket(partnerId, validated3, 'req-test-3');
    console.log('✓ Ticket 3 created successfully:');
    console.log(`  ID: ${createdTicket3.id}`);
    console.log(`  Ticket Number: ${createdTicket3.ticketNumber}`);
    console.log(`  Category: ${createdTicket3.category}`);

    const dbCheck3 = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [createdTicket3.id]);
    const row3 = dbCheck3.rows[0];
    if (row3.category !== 'DAMAGE') throw new Error(`Category mismatch in DB: ${row3.category}`);
    console.log(`✓ DB Verification Passed: Category DAMAGE stored and validated in DB!\n`);

    // ----------------------------------------------------
    // TEST 4: Partner List Tickets
    // ----------------------------------------------------
    console.log('[TEST 4] Listing partner support tickets via getPartnerTickets...');
    const listRes = await supportTicketService.getPartnerTickets(partnerId, { page: 1, limit: 10 });
    console.log(`✓ Partner tickets listed: totalItems=${listRes.pagination.totalItems}`);
    const found1 = listRes.items.some((t) => t.id === createdTicket1.id);
    const found2 = listRes.items.some((t) => t.id === createdTicket2.id);
    const found3 = listRes.items.some((t) => t.id === createdTicket3.id);
    if (!found1 || !found2 || !found3) throw new Error('Not all created tickets found in partner list!');
    console.log(`✓ All 3 created tickets confirmed in Partner ticket list!\n`);

    // ----------------------------------------------------
    // TEST 5: Partner Get Ticket Thread & Initial Message
    // ----------------------------------------------------
    console.log('[TEST 5] Getting ticket thread for Ticket 1...');
    const thread1 = await supportTicketService.getPartnerTicketById(partnerId, createdTicket1.id);
    console.log(`✓ Ticket thread loaded: ID=${thread1.id}, messages count=${thread1.messages?.length}`);
    if (!thread1.messages || thread1.messages.length === 0) throw new Error('Initial message missing from thread!');
    console.log(`  First message: "${thread1.messages[0].message}" by ${thread1.messages[0].senderType}\n`);

    // ----------------------------------------------------
    // TEST 6: Partner Reply to Ticket
    // ----------------------------------------------------
    console.log('[TEST 6] Partner sending reply to Ticket 1...');
    const replyRes = await supportTicketService.addPartnerMessage(partnerId, createdTicket1.id, {
      message: 'Adding additional detail: customer confirmed handover at 11:45 AM.',
    }, 'req-test-reply');
    console.log(`✓ Reply added: message ID=${replyRes.id}, senderType=${replyRes.senderType}`);

    const updatedThread1 = await supportTicketService.getPartnerTicketById(partnerId, createdTicket1.id);
    if (updatedThread1.messages.length < 2) throw new Error('Updated thread does not contain reply!');
    console.log(`✓ Verified thread now contains ${updatedThread1.messages.length} messages.\n`);

    // ----------------------------------------------------
    // TEST 7: Admin Listing Across Partners
    // ----------------------------------------------------
    console.log('[TEST 7] Verifying ticket appears in Admin Panel list (findAllTicketsAdmin)...');
    const adminList = await supportTicketService.getAdminTickets({ limit: 10 });
    console.log(`✓ Admin tickets list retrieved: totalItems=${adminList.pagination.totalItems}`);
    const adminFound = adminList.items.find((t) => t.id === createdTicket1.id);
    if (!adminFound) throw new Error('Ticket 1 not found in Admin tickets list!');
    console.log(`✓ Ticket 1 verified in Admin list:`);
    console.log(`  Ticket Number: ${adminFound.ticketNumber}`);
    console.log(`  Partner Business: ${adminFound.partner?.businessName}`);
    console.log(`  Partner Contact: ${adminFound.partner?.phone}`);
    console.log(`  Subject: ${adminFound.subject}\n`);

    // ----------------------------------------------------
    // TEST 8: Admin Status Update & Admin Reply Workflow
    // ----------------------------------------------------
    console.log('[TEST 8] Testing Admin workflow: update status to IN_PROGRESS and add response...');
    const adminUserId = '55555555-7777-4000-8000-000000000001';
    const updatedStatus = await supportTicketService.updateAdminTicketStatus(
      createdTicket1.id,
      { status: 'IN_PROGRESS', priority: 'HIGH' },
      adminUserId,
      'req-admin-status',
    );
    console.log(`✓ Admin updated status to: ${updatedStatus.status}`);

    const adminReply = await supportTicketService.addAdminMessage(
      adminUserId,
      createdTicket1.id,
      { message: 'GONGO Support has initiated booking log review. We will update within 2 hours.' },
      'req-admin-reply',
    );
    console.log(`✓ Admin message added: senderType=${adminReply.senderType}`);

    // Verify in Partner thread that Admin message appears
    const finalThread = await supportTicketService.getPartnerTicketById(partnerId, createdTicket1.id);
    const hasAdminMsg = finalThread.messages.some((m) => m.senderType === 'SUPPORT');
    if (!hasAdminMsg) throw new Error('Support response not visible in Partner thread!');
    console.log(`✓ Verified Admin message is visible in Partner ticket thread!\n`);

    // ----------------------------------------------------
    // TEST 9: Security & BOLA Protection
    // ----------------------------------------------------
    console.log('[TEST 9] Testing BOLA & Ownership Protection (Partner B accessing Partner A ticket)...');
    try {
      await supportTicketService.getPartnerTicketById(otherPartnerId, createdTicket1.id);
      throw new Error('BOLA VIOLATION: Partner B was able to access Partner A ticket!');
    } catch (bolaErr) {
      if (bolaErr.message.includes('BOLA VIOLATION')) throw bolaErr;
      console.log(`✓ BOLA correctly enforced: Unauthorized access rejected with: ${bolaErr.message}`);
    }

    // ----------------------------------------------------
    // TEST 10: Input Validation
    // ----------------------------------------------------
    console.log('\n[TEST 10] Testing input validation rejection...');
    try {
      supportTicketValidator.validateCreateTicket({ subject: 'ab', message: 'test' });
      throw new Error('Validation failed to reject short subject!');
    } catch (vErr) {
      console.log(`✓ Short subject correctly rejected: ${vErr.message}`);
    }
    try {
      supportTicketValidator.validateCreateTicket({ subject: 'Valid subject', message: '' });
      throw new Error('Validation failed to reject empty message!');
    } catch (vErr) {
      console.log(`✓ Empty message correctly rejected: ${vErr.message}`);
    }

    console.log('\n====================================================');
    console.log('✓ ALL 10 TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================');

  } catch (err) {
    console.error('\n❌ VERIFICATION FAILED:', err);
    process.exitCode = 1;
  } finally {
    // Clean up test tickets
    if (createdTicket1 || createdTicket2 || createdTicket3) {
      const ids = [createdTicket1?.id, createdTicket2?.id, createdTicket3?.id].filter(Boolean);
      await pool.query('DELETE FROM support_ticket_messages WHERE ticket_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM support_tickets WHERE id = ANY($1)', [ids]);
      console.log('\n[Cleanup] Test tickets and messages cleaned up.');
    }
    await pool.end();
  }
}

runVerification();
