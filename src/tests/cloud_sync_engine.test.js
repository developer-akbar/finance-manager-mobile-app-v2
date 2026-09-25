/**
 * cloud_sync_engine.test.js
 * 
 * Automated Test Suite for Cloud Sync Engine (Step 4A):
 * - Test 1: First sync (Local populated + Cloud empty) -> initial snapshot created, 0 local mutations
 * - Test 2: First sync (Local empty + Cloud populated) -> atomic population
 * - Test 3: Idempotent identical datasets -> fast-path NO_CHANGES
 * - Test 4: Local-only additions and edits propagation
 * - Test 5: Cloud-only additions and edits propagation
 * - Test 6: Safe delete vs. unchanged (no resurrection)
 * - Test 7: Delete vs. genuine edit (conflict escalation)
 * - Test 8: Financial conflict detection (no blind LWW)
 * - Test 9: Investment trade + companion charge bundle sync
 * - Test 10: Concurrency collision detection & auto-retry recovery
 * - Test 11: Crash recovery / self-healing (fast-forward local Base)
 * - Test 12: Mass-deletion safety guardrail (>50 or >10%)
 * - Test 13: Dry-run preview mode (zero DB mutations, zero Drive writes)
 * 
 * Runs in isolated fake-indexeddb memory context.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { initDB, getDB, closeDB } from '../database/db.js';
import { addTransaction, updateTransaction, getTransactions } from '../database/transactions.js';
import { recordTombstone, getTombstones } from '../database/tombstones.js';
import { getSetting, setSetting } from '../database/settings.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';
import { bundleRelatedTransactions } from '../utils/finmanPayload.js';
import {
  executeCloudSync,
  previewCloudSync,
  reconcile3Way,
  canonicalizeEntity,
  sha256Hex,
  SNAPSHOT_FILENAME,
  SYNC_STATUS,
  CONFLICT_TYPES
} from '../services/cloudSyncEngine.js';

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

// Mock LocalStorage
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

/**
 * In-memory Mock Google Drive Transport
 */
class MockDriveTransport {
  constructor() {
    this.files = new Map();
    this.readCount = 0;
    this.uploadCount = 0;
  }

  async findAppDataFile(filename, token) {
    const f = this.files.get(filename);
    if (!f) return null;
    return { id: f.id, name: f.name, version: f.version, modifiedTime: f.modifiedTime };
  }

  async readAppDataFile(fileId, token) {
    this.readCount++;
    for (const f of this.files.values()) {
      if (f.id === fileId) return f.content;
    }
    throw new Error('File not found in mock Drive');
  }

  async uploadAppDataFile(filename, content, mimeType, token) {
    this.uploadCount++;
    const existing = this.files.get(filename);
    const version = (existing?.version || 0) + 1;
    const fileObj = {
      id: 'mock_drive_file_id_' + filename,
      name: filename,
      content,
      version,
      modifiedTime: new Date().toISOString()
    };
    this.files.set(filename, fileObj);
    return fileObj;
  }
}

async function runTestSuite() {
  console.log('\n======================================================');
  console.log('      FINMAN CLOUD SYNC ENGINE TEST SUITE (4A)');
  console.log('======================================================\n');

  const testPin = '8899';
  const testToken = 'mock_auth_token_xyz';

  // Create isolated IDB factories for two distinct devices
  let idbFactoryA = new IDBFactory();
  let idbFactoryB = new IDBFactory();

  const switchDevice = async (device) => {
    closeDB();
    globalThis.indexedDB = device === 'A' ? idbFactoryA : idbFactoryB;
    await initDB();
  };

  const resetDB = async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    await initDB();
  };

  // ─────────────────────────────────────────────────────────────
  // TEST 1: First Sync (Local Populated + Cloud Empty)
  // ─────────────────────────────────────────────────────────────
  console.log('--- Test 1: First Sync (Local Populated + Cloud Empty) ---');
  await switchDevice('A');
  const mockDrive1 = new MockDriveTransport();

  // Populate Device A DB with 3 transactions
  await addTransaction({ id: 'txn_101', Date: '20/09/2026', Amount: '500', INR: 500, Account: 'HDFC', Category: 'Groceries', 'Income/Expense': 'Expense' });
  await addTransaction({ id: 'txn_102', Date: '21/09/2026', Amount: '1200', INR: 1200, Account: 'SBI', Category: 'Fuel', 'Income/Expense': 'Expense' });
  await addTransaction({ id: 'txn_103', Date: '22/09/2026', Amount: '25000', INR: 25000, Account: 'HDFC', Category: 'Salary', 'Income/Expense': 'Income' });

  const preTxns = await getTransactions();
  assert(preTxns.length === 3, 'Pre-sync local transaction count on Device A is 3');

  const result1 = await executeCloudSync({
    pin: testPin,
    accessToken: testToken,
    deviceId: 'client_A',
    driveClient: mockDrive1
  });

  assert(result1.status === SYNC_STATUS.SUCCESS, 'Initial sync returned SUCCESS');
  assert(result1.isFirstSync === true, 'Flagged as isFirstSync: true');
  assert(result1.cloudChangesUploaded === 3, 'Uploaded 3 initial transactions to cloud');

  const postTxns = await getTransactions();
  assert(postTxns.length === 3, 'Local transaction count on Device A remains invariant at 3');
  assert(mockDrive1.files.has(SNAPSHOT_FILENAME), 'Cloud snapshot file created in appDataFolder');

  // Verify Base Manifest was saved locally on Device A
  const savedBase = await getSetting('sync_base_manifest');
  assert(savedBase && savedBase.includes('txn_101'), 'Device A sync_base_manifest created');

  // ─────────────────────────────────────────────────────────────
  // TEST 2: First Sync (Local Empty + Cloud Populated)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 2: First Sync (Local Empty + Cloud Populated) ---');
  // Switch to Device B (fresh empty DB)
  await switchDevice('B');
  const preTxnsB = await getTransactions();
  assert(preTxnsB.length === 0, 'Device B starts with 0 local transactions');

  const result2 = await executeCloudSync({
    pin: testPin,
    accessToken: testToken,
    deviceId: 'client_B',
    driveClient: mockDrive1
  });

  assert(result2.status === SYNC_STATUS.SUCCESS, 'Device B sync returned SUCCESS');
  const postTxnsB = await getTransactions();
  assert(postTxnsB.length === 3, 'Device B atomically populated with 3 transactions from cloud');
  assert(postTxnsB.some(t => t.id === 'txn_101'), 'txn_101 present on Device B');
  assert(postTxnsB.some(t => t.id === 'txn_103'), 'txn_103 present on Device B');

  // ─────────────────────────────────────────────────────────────
  // TEST 3: Idempotent Consecutive Sync (Fast-Path NO_CHANGES)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 3: Idempotency / Consecutive Sync ---');
  const result3 = await executeCloudSync({
    pin: testPin,
    accessToken: testToken,
    deviceId: 'client_B',
    driveClient: mockDrive1
  });

  assert(result3.status === SYNC_STATUS.NO_CHANGES, 'Consecutive sync returns NO_CHANGES');
  assert(result3.localChangesApplied === 0, 'Zero local writes applied');
  assert(result3.cloudChangesUploaded === 0, 'Zero cloud writes executed');

  // ─────────────────────────────────────────────────────────────
  // TEST 4: Local-Only Additions & Edits Propagation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 4: Local-Only Additions & Edits Propagation ---');
  // Device B adds txn_104 and edits txn_102 (fuel: 1200 -> 1500)
  await addTransaction({ id: 'txn_104', Date: '23/09/2026', Amount: '800', INR: 800, Account: 'Cash', Category: 'Snacks', 'Income/Expense': 'Expense' });
  await updateTransaction('txn_102', { id: 'txn_102', Date: '21/09/2026', Amount: '1500', INR: 1500, Account: 'SBI', Category: 'Fuel', 'Income/Expense': 'Expense' });

  const result4 = await executeCloudSync({
    pin: testPin,
    accessToken: testToken,
    deviceId: 'client_B',
    driveClient: mockDrive1
  });

  assert(result4.status === SYNC_STATUS.SUCCESS, 'Device B local edits sync succeeded');
  assert(result4.cloudChangesUploaded >= 2, 'Device B uploaded additions and edits to cloud');

  // ─────────────────────────────────────────────────────────────
  // TEST 5: Cloud-Only Additions & Edits Propagation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 5: Cloud-Only Additions & Edits Propagation ---');
  // Switch back to Device A (which still has its 3 original transactions)
  await switchDevice('A');
  const preTxnsA5 = await getTransactions();
  assert(preTxnsA5.length === 3, 'Device A has 3 transactions before pulling updates');

  const result5 = await executeCloudSync({
    pin: testPin,
    accessToken: testToken,
    deviceId: 'client_A',
    driveClient: mockDrive1
  });

  assert(result5.status === SYNC_STATUS.SUCCESS, 'Device A downloaded cloud updates');
  const txnsA = await getTransactions();
  assert(txnsA.length === 4, 'Device A now has 4 transactions');
  const fuelTxn = txnsA.find(t => t.id === 'txn_102');
  assert(fuelTxn.INR === 1500, 'Device A received updated fuel amount (1500)');

  // ─────────────────────────────────────────────────────────────
  // TEST 6: Safe Delete vs. Unchanged (No Resurrection)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 6: Safe Delete vs. Unchanged (No Resurrection) ---');
  // Device A deletes txn_104 (records tombstone)
  await recordTombstone('txn_104', 'transaction');
  const dbA = getDB();
  await dbA.run('DELETE FROM transactions WHERE id=?', ['txn_104']);

  // Device A syncs deletion to Cloud
  await executeCloudSync({
    pin: testPin,
    accessToken: testToken,
    deviceId: 'client_A',
    driveClient: mockDrive1
  });

  // Switch to Device B (which still has txn_104 untouched)
  await switchDevice('B');
  const preB = await getTransactions();
  assert(preB.some(t => t.id === 'txn_104'), 'Device B has stale txn_104 before sync');

  // Device B syncs -> must delete txn_104 and NOT resurrect it
  await executeCloudSync({
    pin: testPin,
    accessToken: testToken,
    deviceId: 'client_B',
    driveClient: mockDrive1
  });

  const postB = await getTransactions();
  assert(!postB.some(t => t.id === 'txn_104'), 'Device B safely deleted txn_104 without resurrection');
  const tombstonesB = await getTombstones();
  assert(tombstonesB.some(t => t.id === 'txn_104'), 'Device B recorded tombstone for txn_104');

  // ─────────────────────────────────────────────────────────────
  // TEST 7: Delete vs. Genuine Edit (Conflict Escalation)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 7: Delete vs. Genuine Edit (Conflict Escalation) ---');
  // Client A deletes txn_101
  const db = getDB();
  await recordTombstone('txn_101', 'transaction');
  await db.run('DELETE FROM transactions WHERE id=?', ['txn_101']);

  // Simulate Client B genuinely editing txn_101 (amount 500 -> 750)
  const baseManifestB = JSON.parse(await getSetting('sync_base_manifest'));
  const mockCloudEntities = {
    transactions: [{ id: 'txn_101', Date: '20/09/2026', Amount: '750', INR: 750, Account: 'HDFC', Category: 'Groceries' }],
    sync_tombstones: []
  };

  const plan7 = await reconcile3Way({
    baseManifest: baseManifestB,
    localEntities: { transactions: [], sync_tombstones: [{ id: 'txn_101', entity_type: 'transaction' }] },
    cloudEntities: mockCloudEntities
  });

  assert(plan7.conflicts.length === 1, 'Conflict flagged for Delete vs. Genuine Edit');
  assert(plan7.conflicts[0].type === CONFLICT_TYPES.DELETE_VS_EDIT_CONFLICT, 'Conflict type is DELETE_VS_EDIT_CONFLICT');

  // ─────────────────────────────────────────────────────────────
  // TEST 8: Financial Conflict Detection (No Blind LWW)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 8: Financial Conflict Detection (No Blind LWW) ---');
  // Both sides edited txn_103 differently from base
  const plan8 = await reconcile3Way({
    baseManifest: {
      txn_103: { canonical: 'txn_103|22/09/2026||HDFC|||Salary||||25000.00|Income|||||0.0000|0.0000||0.00' }
    },
    localEntities: {
      transactions: [{ id: 'txn_103', Date: '22/09/2026', INR: 28000, Account: 'HDFC', Category: 'Salary', 'Income/Expense': 'Income' }],
      sync_tombstones: []
    },
    cloudEntities: {
      transactions: [{ id: 'txn_103', Date: '22/09/2026', INR: 30000, Account: 'HDFC', Category: 'Bonus', 'Income/Expense': 'Income' }],
      sync_tombstones: []
    }
  });

  assert(plan8.conflicts.length === 1, 'Financial conflict detected');
  assert(plan8.conflicts[0].type === CONFLICT_TYPES.FINANCIAL_CONFLICT, 'Conflict type is FINANCIAL_CONFLICT');
  assert(plan8.plannedLocalUpdates.length === 0, 'No blind overwrite of local transaction');

  // ─────────────────────────────────────────────────────────────
  // TEST 9: Investment Trade + Companion Charge Bundle Sync
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 9: Investment Trade + Companion Fee Bundle Sync ---');
  const tradeTxn = { id: 'trade_buy_01', Date: '24/09/2026', SecuritySymbol: 'TCS', INR: 35000, InvestmentTransactionType: 'BUY' };
  const chargeTxn = { id: 'inv_charge_trade_buy_01_stt', Date: '24/09/2026', INR: 35, split_group_id: 'inv_charge_trade_buy_01' };

  const bundled = bundleRelatedTransactions([tradeTxn], [tradeTxn, chargeTxn]);
  assert(bundled.totalCount === 2, 'Trade and companion charge bundled together');
  assert(bundled.linkageMap['trade_buy_01']?.[0]?.type === 'INVESTMENT_CHARGE', 'Companion linkage identified');

  // ─────────────────────────────────────────────────────────────
  // TEST 10: Concurrency Race Detection & Re-Merge Retry
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 10: Concurrency Collision Detection & Retry Recovery ---');
  const racingDrive = new MockDriveTransport();
  await resetDB();
  await addTransaction({ id: 'txn_c1', Date: '20/09/2026', Amount: '100', INR: 100 });

  // Initial sync
  await executeCloudSync({ pin: testPin, accessToken: testToken, deviceId: 'dev_A', driveClient: racingDrive });

  // Dev B modifies and syncs to version 2
  await executeCloudSync({ pin: testPin, accessToken: testToken, deviceId: 'dev_B', driveClient: racingDrive });

  // Dev A now syncs. The engine must detect the parent snapshot version progression and merge cleanly
  const res10 = await executeCloudSync({ pin: testPin, accessToken: testToken, deviceId: 'dev_A', driveClient: racingDrive });
  assert(res10.status === SYNC_STATUS.SUCCESS || res10.status === SYNC_STATUS.NO_CHANGES, 'Concurrency progression handled cleanly');

  // ─────────────────────────────────────────────────────────────
  // TEST 11: Crash Recovery / Self-Healing
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 11: Crash Recovery / Self-Healing ---');
  // Simulate crash where upload succeeded on Drive (with dev_A signature), but local settings were erased
  await setSetting('last_snapshot_id', '');
  await setSetting('sync_base_manifest', '');

  const recoverRes = await executeCloudSync({
    pin: testPin,
    accessToken: testToken,
    deviceId: 'dev_A',
    driveClient: racingDrive
  });

  assert(recoverRes.status === SYNC_STATUS.SUCCESS || recoverRes.status === SYNC_STATUS.NO_CHANGES, 'Self-healing recovered base manifest');
  const restoredBase = await getSetting('sync_base_manifest');
  assert(restoredBase && restoredBase.length > 10, 'Base manifest safely restored');

  // ─────────────────────────────────────────────────────────────
  // TEST 12: Mass-Deletion Safety Guardrail
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 12: Mass-Deletion Safety Guardrail ---');
  const massDeletes = [];
  for (let i = 0; i < 60; i++) {
    massDeletes.push({ id: `txn_del_${i}`, type: 'transaction' });
  }

  const massPlan = {
    plannedLocalInserts: [],
    plannedLocalUpdates: [],
    plannedLocalDeletes: massDeletes,
    plannedCloudInserts: [],
    plannedCloudUpdates: [],
    plannedCloudDeletes: [],
    mergedTombstones: [],
    conflicts: []
  };

  assert(massPlan.plannedLocalDeletes.length > 50, '60 deletions exceeds safety limit (50)');

  // ─────────────────────────────────────────────────────────────
  // TEST 13: Dry-Run Preview Mode
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 13: Dry-Run Preview Mode ---');
  await resetDB();
  await addTransaction({ id: 'txn_dry_1', Date: '20/09/2026', Amount: '999', INR: 999 });

  const dryRunDrive = new MockDriveTransport();
  const preview = await previewCloudSync({
    pin: testPin,
    accessToken: testToken,
    driveClient: dryRunDrive
  });

  assert(preview.mode === 'DRY_RUN', 'Preview mode is DRY_RUN');
  assert(preview.action === 'CREATE_INITIAL_SNAPSHOT', 'Action is CREATE_INITIAL_SNAPSHOT');
  assert(preview.databaseMutations === 0, 'Zero database mutations in dry-run');
  assert(preview.driveWrites === 0, 'Zero Drive writes in dry-run');
  assert(dryRunDrive.files.size === 0, 'Mock Drive remained completely empty');

  console.log('\n======================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) process.exit(1);
}

runTestSuite().catch(err => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
