/**
 * tombstone_instrumentation.test.js
 * 
 * Automated Test Suite for Deletion Tombstone Instrumentation:
 * - Transaction deletions
 * - Linked investment charge companion deletions
 * - Inventory item deletions
 * - Stock consumption non-deletion invariant
 * - Idempotency and stability of tombstones
 * 
 * Runs in an isolated memory environment using fake-indexeddb.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { initDB, getDB, closeDB } from '../database/db.js';
import { addTransaction, deleteTransaction, getTransactions } from '../database/transactions.js';
import { deleteInventoryItem, getInventoryItems, updateInventoryItem } from '../database/inventory.js';
import { getTombstones, getTombstoneIds } from '../database/tombstones.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed++;
    console.error(`❌ FAIL: ${message}`);
    throw new Error(message);
  } else {
    passed++;
    console.log(`✅ PASS: ${message}`);
  }
}

async function runTestSuite() {
  console.log('\n======================================================');
  console.log('   FINMAN TOMBSTONE INSTRUMENTATION TEST SUITE');
  console.log('======================================================\n');

  // Reset isolated DB
  closeDB();
  globalThis.indexedDB = new IDBFactory();
  await initDB();
  const db = getDB();

  // ─────────────────────────────────────────────────────────────
  // TEST A: Delete normal transaction -> One tombstone
  // ─────────────────────────────────────────────────────────────
  console.log('--- Test A: Delete normal transaction -> one tombstone ---');
  await db.run(
    'INSERT INTO transactions (id, date, inr, amount, type, category, account, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['txn-norm-101', '2026-09-21', 450, '450', 'Expense', 'Dining', 'HDFC', 'Lunch meeting']
  );

  const beforeTxns = await getTransactions();
  assert(beforeTxns.some(t => (t._id || t.ID) === 'txn-norm-101'), 'Transaction exists before delete');

  await deleteTransaction('txn-norm-101');

  const afterTxns = await getTransactions();
  assert(!afterTxns.some(t => (t._id || t.ID) === 'txn-norm-101'), 'Transaction removed from database');

  const tombstonesA = await getTombstones();
  const matchA = tombstonesA.find(t => t.id === 'txn-norm-101');
  assert(matchA !== undefined, 'Tombstone exists for deleted transaction');
  assert(matchA.entity_type === 'transaction', 'Tombstone entity_type is transaction');
  assert(!!matchA.deleted_at, 'Tombstone has ISO deleted_at timestamp');

  // ─────────────────────────────────────────────────────────────
  // TEST B & I: Repeated deletion is idempotent -> No duplicate tombstone
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test B & I: Repeated deletion idempotency ---');
  const countBeforeSecondDel = (await getTombstones()).length;
  await deleteTransaction('txn-norm-101');
  const countAfterSecondDel = (await getTombstones()).length;
  assert(countBeforeSecondDel === countAfterSecondDel, 'Repeated delete does not create duplicate tombstone');

  // ─────────────────────────────────────────────────────────────
  // TEST C: Delete investment BUY with linked charge -> Companion tombstones
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test C: Delete investment BUY with linked companion charge ---');
  const buyTxnId = 'txn-invest-buy-201';
  const chargeTxnId = 'txn-charge-comp-202';

  // Seed main BUY txn and linked companion charge
  await db.run(
    'INSERT INTO transactions (id, date, inr, amount, type, category, account, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [buyTxnId, '2026-09-22', 10000, '10000', 'Expense', 'Investment', 'Zerodha', 'Buy TATAMOTORS']
  );
  await db.run(
    'INSERT INTO investment_transactions (id, date, inr, amount, type, category, account, investment_transaction_type, security_symbol, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [buyTxnId, '2026-09-22', 10000, '10000', 'Expense', 'Investment', 'Zerodha', 'BUY', 'TATAMOTORS', 10, 1000]
  );
  await db.run(
    'INSERT INTO transactions (id, date, inr, amount, type, category, account, note, split_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [chargeTxnId, '2026-09-22', 25.5, '25.5', 'Expense', 'Charges', 'Zerodha', 'Brokerage & STT', `inv_charge_${buyTxnId}`]
  );
  await db.run(
    'INSERT INTO investment_transactions (id, date, inr, amount, type, category, account, split_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [chargeTxnId, '2026-09-22', 25.5, '25.5', 'Expense', 'Charges', 'Zerodha', `inv_charge_${buyTxnId}`]
  );

  await deleteTransaction(buyTxnId);

  // Verify both main and companion rows deleted
  const checkTxns = await getTransactions();
  assert(!checkTxns.some(t => (t._id || t.ID) === buyTxnId), 'Main investment BUY deleted');
  assert(!checkTxns.some(t => (t._id || t.ID) === chargeTxnId), 'Companion charge row deleted');

  // Verify tombstones exist for BOTH main transaction and companion charge
  const tombIds = await getTombstoneIds('transaction');
  assert(tombIds.has(buyTxnId), 'Tombstone exists for main BUY txn');
  assert(tombIds.has(chargeTxnId), 'Tombstone exists for companion charge row');

  // ─────────────────────────────────────────────────────────────
  // TEST C2: Delete investment SELL with linked charge -> Companion tombstones
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test C2: Delete investment SELL with linked companion charge ---');
  const sellTxnId = 'txn-invest-sell-203';
  const sellChargeId = 'txn-charge-comp-204';

  await db.run(
    'INSERT INTO transactions (id, date, inr, amount, type, category, account, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [sellTxnId, '2026-09-22', 15000, '15000', 'Income', 'Investment', 'Zerodha', 'Sell WIPRO']
  );
  await db.run(
    'INSERT INTO investment_transactions (id, date, inr, amount, type, category, account, investment_transaction_type, security_symbol, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [sellTxnId, '2026-09-22', 15000, '15000', 'Income', 'Investment', 'Zerodha', 'SELL', 'WIPRO', 30, 500]
  );
  await db.run(
    'INSERT INTO transactions (id, date, inr, amount, type, category, account, note, split_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [sellChargeId, '2026-09-22', 32.0, '32.0', 'Expense', 'Charges', 'Zerodha', 'STT & Brokerage', `inv_charge_${sellTxnId}`]
  );
  await db.run(
    'INSERT INTO investment_transactions (id, date, inr, amount, type, category, account, split_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [sellChargeId, '2026-09-22', 32.0, '32.0', 'Expense', 'Charges', 'Zerodha', `inv_charge_${sellTxnId}`]
  );

  await deleteTransaction(sellTxnId);

  const checkSellTxns = await getTransactions();
  assert(!checkSellTxns.some(t => (t._id || t.ID) === sellTxnId), 'Main investment SELL deleted');
  assert(!checkSellTxns.some(t => (t._id || t.ID) === sellChargeId), 'Companion SELL charge row deleted');

  const sellTombIds = await getTombstoneIds('transaction');
  assert(sellTombIds.has(sellTxnId), 'Tombstone exists for main SELL txn');
  assert(sellTombIds.has(sellChargeId), 'Tombstone exists for companion SELL charge row');

  // ─────────────────────────────────────────────────────────────
  // TEST D: Split transaction item deletion
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test D: Split transaction item deletion ---');
  const splitGroup = 'split_grp_sample_100';
  const splitItem1 = 'txn-split-001';
  const splitItem2 = 'txn-split-002';

  await db.run(
    'INSERT INTO transactions (id, date, inr, amount, type, category, account, note, split_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [splitItem1, '2026-09-23', 600, '600', 'Expense', 'Groceries', 'HDFC', 'Supermarket Food', splitGroup]
  );
  await db.run(
    'INSERT INTO transactions (id, date, inr, amount, type, category, account, note, split_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [splitItem2, '2026-09-23', 400, '400', 'Expense', 'Household', 'HDFC', 'Cleaning Supplies', splitGroup]
  );

  // Delete only item 1
  await deleteTransaction(splitItem1);

  const splitTxnsAfter = await getTransactions();
  assert(!splitTxnsAfter.some(t => (t._id || t.ID) === splitItem1), 'Deleted split item 1 removed');
  assert(splitTxnsAfter.some(t => (t._id || t.ID) === splitItem2), 'Sibling split item 2 retained');

  const splitTombs = await getTombstoneIds('transaction');
  assert(splitTombs.has(splitItem1), 'Tombstone recorded for deleted split item 1');
  assert(!splitTombs.has(splitItem2), 'No tombstone for active sibling split item 2');

  // ─────────────────────────────────────────────────────────────
  // TEST E: Delete inventory item -> Inventory tombstone
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test E: Delete inventory batch -> inventory tombstone ---');
  const invItemId = 'inv-item-301';
  await db.run(
    'INSERT INTO inventory (id, name, qty, unit, price, status) VALUES (?, ?, ?, ?, ?, ?)',
    [invItemId, 'Basmati Rice', 10, 'kg', 120, 'available']
  );

  const invBefore = await getInventoryItems();
  assert(invBefore.some(i => i.id === invItemId), 'Inventory item exists before delete');

  await deleteInventoryItem(invItemId);

  const invAfter = await getInventoryItems();
  assert(!invAfter.some(i => i.id === invItemId), 'Inventory item removed from database');

  const invTombIds = await getTombstoneIds('inventory');
  assert(invTombIds.has(invItemId), 'Tombstone created with entity_type inventory');

  // ─────────────────────────────────────────────────────────────
  // TEST F: Stock consumption -> NO deletion tombstone
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test F: Stock consumption must NOT create deletion tombstone ---');
  const consumeItemId = 'inv-item-401';
  await db.run(
    'INSERT INTO inventory (id, name, qty, unit, price, status) VALUES (?, ?, ?, ?, ?, ?)',
    [consumeItemId, 'Sugar', 5, 'kg', 45, 'available']
  );

  const tombsBeforeConsume = (await getTombstones()).length;
  await updateInventoryItem(consumeItemId, { name: 'Sugar', qty: 3, unit: 'kg', price: 45, status: 'available' });
  const tombsAfterConsume = (await getTombstones()).length;

  assert(tombsBeforeConsume === tombsAfterConsume, 'Stock consumption did NOT create deletion tombstone');
  const sugarItem = (await getInventoryItems()).find(i => i.id === consumeItemId);
  assert(parseFloat(sugarItem.qty) === 3, 'Stock quantity decremented properly (5 -> 3)');

  // ─────────────────────────────────────────────────────────────
  // TEST G & H: Tombstone Metadata Isolation & Stability
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test G & H: Tombstone Metadata Isolation ---');
  await db.run(
    'INSERT INTO transactions (id, date, inr, amount, type, category, account, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['txn-unrelated-501', '2026-09-23', 800, '800', 'Expense', 'Shopping', 'HDFC', 'Books']
  );

  const allActiveTxns = await getTransactions();
  const tombstoneList = await getTombstones();
  const tombstoneIdSet = new Set(tombstoneList.map(t => t.id));

  // Assert no tombstone ID is present in active transactions
  const leakFound = allActiveTxns.some(t => tombstoneIdSet.has(t._id || t.ID));
  assert(!leakFound, 'Zero tombstone records appear in getTransactions() list');

  const unrelated = allActiveTxns.find(t => (t._id || t.ID) === 'txn-unrelated-501');
  assert(unrelated !== undefined && parseFloat(unrelated.INR) === 800, 'Unrelated records completely intact');

  console.log('\n======================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) process.exit(1);
}

runTestSuite().catch(err => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
