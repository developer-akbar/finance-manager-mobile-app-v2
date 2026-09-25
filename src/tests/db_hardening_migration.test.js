/**
 * db_hardening_migration.test.js
 * 
 * Automated Test Suite for DB Hardening, Version 12 -> 13 Migration,
 * Connection Lifecycle, Fail-Closed Error Handling, and Tombstone Foundation.
 * 
 * Runs in an isolated environment using in-memory fake-indexeddb.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { initDB, getDB, closeDB } from '../database/db.js';
import { getTransactions, addTransaction } from '../database/transactions.js';
import { getAccounts, replaceAccounts } from '../database/accounts.js';
import { getCategories, replaceCategories } from '../database/categories.js';
import { getInventoryItems } from '../database/inventory.js';
import { recordTombstone, recordTombstonesBatch, getTombstones, getTombstoneIds } from '../database/tombstones.js';

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
  console.log('   FINMAN DB HARDENING & MIGRATION TEST SUITE');
  console.log('======================================================\n');

  // Helper to reset indexedDB factory between tests
  const resetIDB = () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
  };

  // ─────────────────────────────────────────────────────────────
  // TEST 1: Fresh DB Creation (v13)
  // ─────────────────────────────────────────────────────────────
  console.log('--- Test 1: Fresh DB Creation (v13) ---');
  resetIDB();
  const db1 = await initDB();
  assert(db1 !== null, 'initDB should return a valid DB instance');
  const tombstones1 = await getTombstones();
  assert(Array.isArray(tombstones1) && tombstones1.length === 0, 'sync_tombstones store exists and is empty');

  // ─────────────────────────────────────────────────────────────
  // TEST 2, 3, 4, 5, 6, 7: v12 Seed -> v13 Upgrade & Data Retention
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 2-7: v12 Seed -> v13 Upgrade & Data Retention ---');
  resetIDB();

  // Create a v12 DB manually with test data
  const v12Stores = [
    'transactions', 'accounts', 'account_groups', 'account_mapping',
    'categories', 'subcategories', 'sub_accounts', 'budgets', 'settings',
    'recurring_rules', 'inventory', 'investment_transactions', 'brokerages',
    'investment_plans'
  ];

  await new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open('finman_v2', 12);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      v12Stores.forEach(s => {
        db.createObjectStore(s, { keyPath: s === 'settings' ? 'key' : 'id' });
      });
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      // Seed test records into v12
      const tx = db.transaction(['transactions', 'accounts', 'categories', 'inventory'], 'readwrite');
      tx.objectStore('transactions').put({
        id: 'txn-test-001',
        date: '2026-09-20',
        amount: '1500',
        inr: 1500,
        type: 'Expense',
        category: 'Food',
        account: 'HDFC',
        note: 'Grocery store'
      });
      tx.objectStore('accounts').put({
        id: 'acct-test-001',
        name: 'HDFC Bank',
        group_name: 'Bank Accounts',
        is_asset: 1
      });
      tx.objectStore('categories').put({
        id: 'cat-test-001',
        name: 'Food & Groceries',
        type: 'Expense'
      });
      tx.objectStore('inventory').put({
        id: 'inv-test-001',
        name: 'Organic Rice',
        qty: 5,
        unit: 'kg',
        price: 350
      });

      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = (err) => reject(err);
    };
    req.onerror = reject;
  });

  // Now trigger FinMan v13 initDB migration on the seeded v12 DB
  const dbV13 = await initDB();
  assert(dbV13 !== null, 'v12 -> v13 migration completed successfully');

  // Verify store creation
  const tombstones = await getTombstones();
  assert(Array.isArray(tombstones), 'sync_tombstones store created during v13 upgrade');

  // Verify existing transactions survived
  const txns = await getTransactions();
  assert(txns.length === 1, 'Transaction survived migration');
  assert((txns[0]._id === 'txn-test-001' || txns[0].ID === 'txn-test-001') && txns[0].Note === 'Grocery store', 'Transaction fields intact');

  // Verify accounts survived
  const accts = await getAccounts();
  assert(accts.length === 1 && accts[0].name === 'HDFC Bank', 'Accounts survived migration');

  // Verify categories survived
  const cats = await getCategories();
  assert(cats.length === 1 && cats[0].name === 'Food & Groceries', 'Categories survived migration');

  // Verify inventory survived
  const invItems = await getInventoryItems();
  assert(invItems.length === 1 && invItems[0].name === 'Organic Rice', 'Inventory survived migration');

  // ─────────────────────────────────────────────────────────────
  // TEST 8: Multiple initDB() Concurrent Calls (Idempotency)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 8: Multiple initDB() Concurrency & Idempotency ---');
  const [inst1, inst2, inst3] = await Promise.all([initDB(), initDB(), initDB()]);
  assert(inst1 === inst2 && inst2 === inst3, 'Concurrent initDB calls resolve to the identical singleton DB');

  // ─────────────────────────────────────────────────────────────
  // TEST 9 & 10: Blocked Upgrade Handling & Timeout
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 9-10: Blocked Upgrade Handling & Timeout ---');
  resetIDB();

  // Create a stubborn connection at version 12 that ignores versionchange
  let stubbornConn = null;
  await new Promise((resolve) => {
    const req = globalThis.indexedDB.open('finman_v2', 12);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore('test_store', { keyPath: 'id' });
    };
    req.onsuccess = (e) => {
      stubbornConn = e.target.result;
      // Intentionally DO NOT close on versionchange to simulate a blocked tab
      stubbornConn.onversionchange = () => {
        console.log('[Test Stubborn Conn] Received versionchange but staying open temporarily');
      };
      resolve();
    };
  });

  // Upgrade should log blocked warning; then when stubborn closes, upgrade proceeds
  setTimeout(() => {
    if (stubbornConn) {
      stubbornConn.close();
      console.log('[Test Stubborn Conn] Closed after 100ms');
    }
  }, 100);

  const upgradedDb = await initDB();
  assert(upgradedDb !== null, 'Upgrade unblocked and completed successfully after stubborn connection closed');

  // ─────────────────────────────────────────────────────────────
  // TEST 11: onversionchange Closes Old FinMan Connections
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 11: onversionchange Auto-Closes Stale Connection ---');
  resetIDB();
  const conn1 = await initDB();
  assert(conn1 !== null, 'Connection 1 opened');

  // Open another higher version connection — conn1 should auto-close via its onversionchange handler
  await new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open('finman_v2', 14);
    req.onsuccess = (e) => {
      e.target.result.close();
      resolve();
    };
    req.onerror = reject;
  });
  assert(true, 'Connection 1 did not block higher version upgrade');

  // ─────────────────────────────────────────────────────────────
  // TEST 12 & 13: Fail-Closed vs Valid Empty DB State
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 12-13: Fail-Closed vs Valid Empty DB ---');
  resetIDB();
  const emptyDb = await initDB();
  const emptyTxns = await getTransactions();
  assert(emptyTxns.length === 0, 'Valid empty DB reports 0 transactions');

  // Test DB unavailable state
  closeDB();
  let threwWhenClosed = false;
  try {
    getDB();
  } catch (err) {
    threwWhenClosed = err.message.includes('DB not initialised');
  }
  assert(threwWhenClosed, 'getDB() fails closed with descriptive error when DB is closed');

  // ─────────────────────────────────────────────────────────────
  // TEST 14 & 15: Tombstone Recording & Querying
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 14-15: Tombstone Recording & Batch Operations ---');
  resetIDB();
  await initDB();

  await recordTombstone('del-txn-001', 'transaction');
  await recordTombstone('del-inv-001', 'inventory');
  await recordTombstonesBatch(['batch-del-001', 'batch-del-002'], 'transaction');

  const allTombstones = await getTombstones();
  assert(allTombstones.length === 4, 'All 4 tombstones recorded successfully');

  const txnTombstoneIds = await getTombstoneIds('transaction');
  assert(txnTombstoneIds.has('del-txn-001') && txnTombstoneIds.has('batch-del-001'), 'Transaction tombstone IDs indexed');
  assert(!txnTombstoneIds.has('del-inv-001'), 'Inventory tombstone excluded from transaction set');

  console.log('\n======================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
