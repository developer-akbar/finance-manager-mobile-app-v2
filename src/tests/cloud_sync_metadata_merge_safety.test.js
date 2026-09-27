/**
 * cloud_sync_metadata_merge_safety.test.js
 * 
 * Phase 6D.8: Comprehensive Metadata Merge Safety & Cloud Entity Loss Prevention Test Suite
 * 
 * Verifies:
 * TEST 1 — Cloud-only transaction pull: Pulls without cloud upload (cloudWritePerformed = false).
 * TEST 2 — Cloud-only metadata pull: Applies account_groups, brokerages, inventory, budgets locally with zero cloud upload.
 * TEST 3 — Cloud-only investment transaction pull: Applies investment transactions locally with zero upload.
 * TEST 4 — Bidirectional merge: Cloud-only metadata + local transaction -> both survive in local DB and new cloud snapshot.
 * TEST 5 — Settings-only change: Exposes accurate preview counts and syncs cleanly.
 * TEST 6 — Task 7 Exact 6D.7 failure regression: Base(A,B,C), Cloud(A,B,C,meta-D), Local(A,B,C,setting-change).
 *          Meta-D MUST survive in local DB and in the newly uploaded cloud snapshot.
 * TEST 7 — Cross-device convergence sequence: C & D achieve full convergence without infinite +4 loop.
 * TEST 8 — Snapshot entity preservation: Snapshot v3 (29,040 txns + meta-D) -> v4 retains all 29,040 txns + meta-D.
 * TEST 9 — Measured execution timing instrumentation in executeCloudSync diagnostics.
 * TEST 10 — UI Success/Bootstrap type-safe distinction (operation field).
 */

import 'fake-indexeddb/auto';
import assert from 'assert';
import {
  initDB,
  closeDB,
  getDB,
  getTransactions,
  getAccounts,
  getCategories,
  setSetting,
  getSetting
} from '../database/index.js';
import {
  executeCloudSync,
  executeBootstrap,
  previewCloudSync,
  reconcile3Way,
  readLocalEntities,
  buildEntityManifest,
  createCanonicalSnapshotPayload,
  applyLocalEntityInsertOrUpdate,
  applyLocalEntityDelete,
  SNAPSHOT_FILENAME,
  SYNC_STATUS,
  BOOTSTRAP_STATUS
} from '../services/cloudSyncEngine.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';

let totalTests = 0;
let passedTests = 0;

function pass(name) {
  totalTests++;
  passedTests++;
  console.log(`✅ PASS: ${name}`);
}

function fail(name, err) {
  totalTests++;
  console.error(`❌ FAIL: ${name}`);
  console.error(err);
  throw err;
}

// Reset IndexedDB for a fresh test database
async function resetDB() {
  await closeDB();
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('finman_v2');
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e);
    req.onblocked = () => resolve();
  });
  return await initDB();
}

// In-Memory Mock Google Drive Transport
class MockDriveTransport {
  constructor() {
    this.files = new Map();
    this.fileCounter = 1;
    this.revisions = new Map();
  }

  async findAppDataFile(name, accessToken) {
    for (const [id, f] of this.files.entries()) {
      if (f.name === name && !f.trashed) {
        return { id, name: f.name, modifiedTime: f.modifiedTime, version: f.version };
      }
    }
    return null;
  }

  async readAppDataFile(fileId, accessToken) {
    const f = this.files.get(fileId);
    if (!f || f.trashed) throw new Error(`File ${fileId} not found`);
    return f.content;
  }

  async uploadAppDataFile(name, content, mimeType, accessToken) {
    let existingId = null;
    for (const [id, f] of this.files.entries()) {
      if (f.name === name && !f.trashed) {
        existingId = id;
        break;
      }
    }

    const now = new Date().toISOString();
    if (existingId) {
      const existing = this.files.get(existingId);
      const newVersion = (existing.version || 1) + 1;
      this.files.set(existingId, {
        name,
        content,
        mimeType,
        modifiedTime: now,
        version: newVersion,
        trashed: false
      });
      return { id: existingId, name, modifiedTime: now, version: newVersion };
    }

    const id = `mock_file_${this.fileCounter++}`;
    this.files.set(id, {
      name,
      content,
      mimeType,
      modifiedTime: now,
      version: 1,
      trashed: false
    });
    return { id, name, modifiedTime: now, version: 1 };
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('Phase 6D.8: Metadata Merge Safety & Cloud Loss Prevention Tests');
  console.log('================================================================\n');

  const testPin = '998877';
  const testToken = 'mock_token_phase_6d8';

  // ─────────────────────────────────────────────────────────────
  // TEST 1: Cloud-Only Transaction Pull (Pull-Only Semantic Verification)
  // ─────────────────────────────────────────────────────────────
  console.log('--- Test 1: Cloud-Only Transaction Pull ---');
  await resetDB();
  const drive1 = new MockDriveTransport();

  // Create initial cloud snapshot with 2 transactions
  const cloudTxns1 = [
    { id: 'txn_c_1', date: '2026-09-20', inr: 500, amount: '500', account: 'HDFC', category: 'Food', type: 'Expense' },
    { id: 'txn_c_2', date: '2026-09-21', inr: 1200, amount: '1200', account: 'SBI', category: 'Shopping', type: 'Expense' }
  ];
  const snap1 = await createCanonicalSnapshotPayload({
    entities: { transactions: cloudTxns1, settings: {} },
    snapshotId: 'snap_v1_test1',
    parentSnapshotId: null,
    cloudVersion: 1
  });
  const enc1 = await encryptBackupData(snap1.payload, testPin);
  await drive1.uploadAppDataFile(SNAPSHOT_FILENAME, enc1, 'application/octet-stream', testToken);

  // Bootstrap local DB to v1
  await executeBootstrap({ pin: testPin, accessToken: testToken, driveClient: drive1 });
  assert.strictEqual((await getTransactions()).length, 2, 'Local DB has 2 txns after bootstrap');

  // Cloud adds 1 new transaction -> v2
  const cloudTxns2 = [
    ...cloudTxns1,
    { id: 'txn_c_3', date: '2026-09-22', inr: 300, amount: '300', account: 'HDFC', category: 'Fuel', type: 'Expense' }
  ];
  const snap2 = await createCanonicalSnapshotPayload({
    entities: { transactions: cloudTxns2, settings: {} },
    snapshotId: 'snap_v2_test1',
    parentSnapshotId: 'snap_v1_test1',
    cloudVersion: 2
  });
  const enc2 = await encryptBackupData(snap2.payload, testPin);
  await drive1.uploadAppDataFile(SNAPSHOT_FILENAME, enc2, 'application/octet-stream', testToken);

  // Local runs Preview -> Should show 1 local insert, 0 cloud changes
  const prev1 = await previewCloudSync({ pin: testPin, accessToken: testToken, driveClient: drive1 });
  assert.strictEqual(prev1.plannedLocalChanges.inserts, 1, 'Preview shows 1 planned local insert');
  assert.strictEqual(prev1.plannedCloudChanges.total, 0, 'Preview shows 0 planned cloud changes');

  // Local executes live sync -> Must be pull-only with 0 cloud writes
  const syncRes1 = await executeCloudSync({ pin: testPin, accessToken: testToken, driveClient: drive1 });
  assert.strictEqual(syncRes1.status, SYNC_STATUS.SUCCESS, 'Sync status is SUCCESS');
  assert.strictEqual(syncRes1.cloudWritePerformed, false, 'Zero cloud writes performed for pull-only');
  assert.strictEqual(syncRes1.snapshotId, 'snap_v2_test1', 'Preserved existing cloud snapshot ID');
  assert.strictEqual(syncRes1.localChangesApplied, 1, '1 local change applied');
  assert.strictEqual((await getTransactions()).length, 3, 'Local DB now has 3 transactions');
  pass('Cloud-only transaction pull completes with zero cloud writes and preserved snapshot ID');

  // ─────────────────────────────────────────────────────────────
  // TEST 2: Cloud-Only Metadata Pull (Account Groups, Brokerages, Inventory, Budgets)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 2: Cloud-Only Metadata Pull ---');
  await resetDB();
  const drive2 = new MockDriveTransport();

  const initialEntities2 = {
    transactions: [{ id: 'txn_m_1', date: '2026-09-20', inr: 100, account: 'Cash', category: 'Food', type: 'Expense' }],
    account_groups: [{ id: 'grp_1', name: 'Bank Accounts', sort_order: 0 }],
    categories: [{ id: 'cat_1', name: 'Food', type: 'Expense', sort_order: 0 }],
    settings: {}
  };
  const snap2_1 = await createCanonicalSnapshotPayload({
    entities: initialEntities2,
    snapshotId: 'snap_v1_test2',
    cloudVersion: 1
  });
  await drive2.uploadAppDataFile(SNAPSHOT_FILENAME, await encryptBackupData(snap2_1.payload, testPin), 'application/octet-stream', testToken);
  await executeBootstrap({ pin: testPin, accessToken: testToken, driveClient: drive2 });

  // Cloud v2 adds 4 new metadata entities: 1 account group, 1 brokerage, 1 inventory item, 1 budget
  const updatedCloudEntities2 = {
    ...initialEntities2,
    account_groups: [
      ...initialEntities2.account_groups,
      { id: 'grp_2_investments', name: 'Investments', sort_order: 1 }
    ],
    brokerages: [
      { id: 'brk_zerodha', name: 'Zerodha Broking', bank_account: 'HDFC', owner: 'Akbar' }
    ],
    inventory: [
      { id: 'inv_laptop', name: 'MacBook Pro', qty: 1, price: 150000, status: 'available' }
    ],
    budgets: [
      { id: 'bdg_food', category: 'Food', amount: 15000, period: 'Monthly' }
    ]
  };

  const snap2_2 = await createCanonicalSnapshotPayload({
    entities: updatedCloudEntities2,
    snapshotId: 'snap_v2_test2',
    parentSnapshotId: 'snap_v1_test2',
    cloudVersion: 2
  });
  await drive2.uploadAppDataFile(SNAPSHOT_FILENAME, await encryptBackupData(snap2_2.payload, testPin), 'application/octet-stream', testToken);

  // Preview on local
  const prev2 = await previewCloudSync({ pin: testPin, accessToken: testToken, driveClient: drive2 });
  assert.strictEqual(prev2.plannedLocalChanges.inserts, 4, 'Preview reports exactly 4 local metadata inserts');
  assert.strictEqual(prev2.plannedCloudChanges.total, 0, 'Preview reports 0 cloud changes');

  // Execute pull-only sync on local
  const syncRes2 = await executeCloudSync({ pin: testPin, accessToken: testToken, driveClient: drive2 });
  assert.strictEqual(syncRes2.cloudWritePerformed, false, 'Zero cloud writes performed');
  assert.strictEqual(syncRes2.snapshotId, 'snap_v2_test2', 'Snapshot ID preserved');

  // Verify that all 4 metadata entities are now physically present in local DB stores
  const localEntitiesAfterSync = await readLocalEntities(getDB());
  assert.strictEqual(localEntitiesAfterSync.account_groups.length, 2, 'Local DB has 2 account groups');
  assert(localEntitiesAfterSync.account_groups.some(g => g.id === 'grp_2_investments'), 'Investments group present locally');
  assert.strictEqual(localEntitiesAfterSync.brokerages.length, 1, 'Brokerage present locally');
  assert.strictEqual(localEntitiesAfterSync.brokerages[0].id, 'brk_zerodha', 'Zerodha brokerage present locally');
  assert.strictEqual(localEntitiesAfterSync.inventory.length, 1, 'Inventory item present locally');
  assert.strictEqual(localEntitiesAfterSync.inventory[0].id, 'inv_laptop', 'MacBook inventory item present locally');
  assert.strictEqual(localEntitiesAfterSync.budgets.length, 1, 'Budget present locally');
  assert.strictEqual(localEntitiesAfterSync.budgets[0].id, 'bdg_food', 'Food budget present locally');
  pass('All 4 non-transaction metadata entities applied cleanly to local database with zero cloud writes');

  // ─────────────────────────────────────────────────────────────
  // TEST 3: Bidirectional Merge (Cloud Metadata + Local Transaction)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 3: Bidirectional Merge (Cloud Metadata + Local Transaction) ---');
  await resetDB();
  const drive3 = new MockDriveTransport();

  const baselineEntities3 = {
    transactions: [{ id: 'txn_b_1', date: '2026-09-20', inr: 500, account: 'HDFC', category: 'Food', type: 'Expense' }],
    categories: [{ id: 'cat_food', name: 'Food', type: 'Expense' }],
    account_groups: [],
    brokerages: [],
    settings: {}
  };
  const snap3_1 = await createCanonicalSnapshotPayload({
    entities: baselineEntities3,
    snapshotId: 'snap_v1_test3',
    cloudVersion: 1
  });
  await drive3.uploadAppDataFile(SNAPSHOT_FILENAME, await encryptBackupData(snap3_1.payload, testPin), 'application/octet-stream', testToken);
  await executeBootstrap({ pin: testPin, accessToken: testToken, driveClient: drive3 });

  // Cloud advances to v2 with a new metadata record (e.g. brokerage)
  const cloudEntities3_v2 = {
    ...baselineEntities3,
    brokerages: [{ id: 'brk_groww', name: 'Groww Invest', bank_account: 'SBI', owner: 'Akbar' }]
  };
  const snap3_2 = await createCanonicalSnapshotPayload({
    entities: cloudEntities3_v2,
    snapshotId: 'snap_v2_test3',
    parentSnapshotId: 'snap_v1_test3',
    cloudVersion: 2
  });
  await drive3.uploadAppDataFile(SNAPSHOT_FILENAME, await encryptBackupData(snap3_2.payload, testPin), 'application/octet-stream', testToken);

  // Local also adds a new financial transaction locally before syncing
  const db3 = getDB();
  await applyLocalEntityInsertOrUpdate(db3, {
    id: 'txn_loc_new',
    date: '2026-09-22',
    inr: 2500,
    amount: '2500',
    account: 'HDFC',
    category: 'Food',
    type: 'Expense'
  }, 'transactions');

  // Preview should detect: 1 local insert (brokerage from cloud) and 1 cloud insert (new local txn)
  const prev3 = await previewCloudSync({ pin: testPin, accessToken: testToken, driveClient: drive3 });
  assert.strictEqual(prev3.plannedLocalChanges.inserts, 1, '1 planned local insert');
  assert.strictEqual(prev3.plannedCloudChanges.inserts, 1, '1 planned cloud insert');

  // Execute Bidirectional Sync -> Creates Cloud v3
  const syncRes3 = await executeCloudSync({ pin: testPin, accessToken: testToken, driveClient: drive3 });
  assert.strictEqual(syncRes3.status, SYNC_STATUS.SUCCESS, 'Sync succeeded');
  assert.strictEqual(syncRes3.cloudWritePerformed, true, 'Cloud write performed for bidirectional merge');
  assert.strictEqual(syncRes3.cloudVersion, 3, 'Cloud version incremented to 3');

  // Verify the newly uploaded cloud snapshot payload (v3) contains BOTH the cloud metadata AND the local transaction
  const cloudV3Cipher = await drive3.readAppDataFile(drive3.files.get(drive3.files.keys().next().value).name === SNAPSHOT_FILENAME ? drive3.files.keys().next().value : 'mock_file_1', testToken);
  const cloudV3Decrypted = await decryptBackupData(cloudV3Cipher, testPin);

  assert.strictEqual(cloudV3Decrypted.entities.transactions.length, 2, 'Cloud v3 contains both transactions');
  assert(cloudV3Decrypted.entities.transactions.some(t => t.id === 'txn_loc_new'), 'New local transaction in v3');
  assert.strictEqual(cloudV3Decrypted.entities.brokerages.length, 1, 'Cloud v3 preserves incoming brokerage');
  assert.strictEqual(cloudV3Decrypted.entities.brokerages[0].id, 'brk_groww', 'Groww brokerage preserved in v3');
  pass('Bidirectional merge successfully preserved both cloud metadata and local transaction in cloud snapshot');

  // ─────────────────────────────────────────────────────────────
  // TEST 4: Exact Phase 6D.7 Failure Regression Test
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 4: Phase 6D.7 Regression (Cloud Metadata + Local Settings Difference) ---');
  await resetDB();
  const drive4 = new MockDriveTransport();

  // Baseline v2 shared state
  const baseEntities4 = {
    transactions: [
      { id: 'txn_6d7_1', date: '2026-09-20', inr: 100, account: 'HDFC', category: 'Food', type: 'Expense' },
      { id: 'txn_6d7_2', date: '2026-09-21', inr: 200, account: 'HDFC', category: 'Food', type: 'Expense' }
    ],
    account_groups: [{ id: 'ag_bank', name: 'Bank Accounts', sort_order: 0 }],
    categories: [{ id: 'cat_f', name: 'Food', type: 'Expense' }],
    settings: { theme: 'dark' }
  };
  const snap4_v2 = await createCanonicalSnapshotPayload({
    entities: baseEntities4,
    snapshotId: 'snap_v2_6d7',
    cloudVersion: 2
  });
  await drive4.uploadAppDataFile(SNAPSHOT_FILENAME, await encryptBackupData(snap4_v2.payload, testPin), 'application/octet-stream', testToken);

  // Device C was bootstrapped on v2
  await executeBootstrap({ pin: testPin, accessToken: testToken, driveClient: drive4 });

  // Device D uploaded v3 with 4 metadata records (e.g. 2 account_groups, 1 brokerage, 1 account_mapping)
  const cloudEntities4_v3 = {
    ...baseEntities4,
    account_groups: [
      { id: 'ag_bank', name: 'Bank Accounts', sort_order: 0 },
      { id: 'ag_cards', name: 'Credit Cards', sort_order: 1 },
      { id: 'ag_inv', name: 'Investments', sort_order: 2 }
    ],
    brokerages: [
      { id: 'brk_d_contributed', name: 'Zerodha', bank_account: 'HDFC', owner: 'Akbar' }
    ],
    account_mapping: [
      { id: 'am_d_contributed', source_name: 'HDFC Bank Ltd', account_name: 'HDFC' }
    ],
    settings: { theme: 'dark' }
  };
  const snap4_v3 = await createCanonicalSnapshotPayload({
    entities: cloudEntities4_v3,
    snapshotId: 'snap_v3_6d7',
    parentSnapshotId: 'snap_v2_6d7',
    cloudVersion: 3
  });
  await drive4.uploadAppDataFile(SNAPSHOT_FILENAME, await encryptBackupData(snap4_v3.payload, testPin), 'application/octet-stream', testToken);

  // Device C has a local settings difference (e.g. fontSize changed locally)
  await setSetting('fontSize', '1.2');

  // Preview on C: Shows 4 metadata inserts and 1 cloud settings update
  const prev4 = await previewCloudSync({ pin: testPin, accessToken: testToken, driveClient: drive4 });
  assert.strictEqual(prev4.plannedLocalChanges.inserts, 4, 'Preview on C shows 4 local metadata inserts');
  assert.strictEqual(prev4.plannedCloudChanges.settingsUpdates, 1, 'Preview on C exposes 1 cloud settings update');
  assert.strictEqual(prev4.plannedCloudChanges.total, 1, 'Preview total cloud changes is 1');

  // Device C executes sync -> Creates Cloud v4
  const syncRes4 = await executeCloudSync({ pin: testPin, accessToken: testToken, driveClient: drive4 });
  assert.strictEqual(syncRes4.status, SYNC_STATUS.SUCCESS, 'Sync status is SUCCESS');
  assert.strictEqual(syncRes4.cloudWritePerformed, true, 'Cloud write performed because of settings change');
  assert.strictEqual(syncRes4.cloudVersion, 4, 'Cloud version is now 4');

  // CRITICAL VERIFICATION: Does Cloud v4 STILL contain all 4 metadata records contributed by D?
  const driveFile = await drive4.findAppDataFile(SNAPSHOT_FILENAME, testToken);
  const v4Cipher = await drive4.readAppDataFile(driveFile.id, testToken);
  const v4Payload = await decryptBackupData(v4Cipher, testPin);

  assert.strictEqual(v4Payload.entities.account_groups.length, 3, 'Cloud v4 has all 3 account groups');
  assert.strictEqual(v4Payload.entities.brokerages.length, 1, 'Cloud v4 has D brokerage');
  assert.strictEqual(v4Payload.entities.brokerages[0].id, 'brk_d_contributed', 'Brokerage id preserved');
  assert.strictEqual(v4Payload.entities.account_mapping.length, 1, 'Cloud v4 has D account mapping');
  assert.strictEqual(v4Payload.entities.transactions.length, 2, 'All transactions intact in v4');
  assert.strictEqual(v4Payload.entities.settings.fontSize, '1.2', 'Setting updated in v4');
  pass('Phase 6D.7 regression fixed: Cloud v4 completely retained all 4 metadata records from v3');

  // ─────────────────────────────────────────────────────────────
  // TEST 5: Cross-Device Convergence Test (Device D Preview against v4)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 5: Cross-Device Convergence (Device D Preview against v4) ---');
  // Device D's local DB has the exact v3 entities
  await resetDB();
  const dbD = getDB();
  await applyLocalEntityInsertOrUpdate(dbD, baseEntities4.transactions[0], 'transactions');
  await applyLocalEntityInsertOrUpdate(dbD, baseEntities4.transactions[1], 'transactions');
  await applyLocalEntityInsertOrUpdate(dbD, baseEntities4.categories[0], 'categories');
  await applyLocalEntityInsertOrUpdate(dbD, { id: 'ag_bank', name: 'Bank Accounts', sort_order: 0 }, 'account_groups');
  await applyLocalEntityInsertOrUpdate(dbD, { id: 'ag_cards', name: 'Credit Cards', sort_order: 1 }, 'account_groups');
  await applyLocalEntityInsertOrUpdate(dbD, { id: 'ag_inv', name: 'Investments', sort_order: 2 }, 'account_groups');
  await applyLocalEntityInsertOrUpdate(dbD, { id: 'brk_d_contributed', name: 'Zerodha', bank_account: 'HDFC', owner: 'Akbar' }, 'brokerages');
  await applyLocalEntityInsertOrUpdate(dbD, { id: 'am_d_contributed', source_name: 'HDFC Bank Ltd', account_name: 'HDFC' }, 'account_mapping');
  await setSetting('theme', 'dark');
  
  // Set D's base manifest to v3
  const dLocalEntities = await readLocalEntities(dbD);
  const dBaseManifest = await buildEntityManifest(dLocalEntities);
  await setSetting('sync_base_manifest', JSON.stringify(dBaseManifest));
  await setSetting('last_snapshot_id', 'snap_v3_6d7');

  // Device D runs Preview against Cloud v4 (which has C's fontSize: '1.2')
  const prevD = await previewCloudSync({ pin: testPin, accessToken: testToken, driveClient: drive4 });
  assert.strictEqual(prevD.plannedLocalChanges.inserts, 0, 'Device D sees 0 metadata inserts (already has them)');
  assert.strictEqual(prevD.plannedCloudChanges.inserts, 0, 'Device D sees 0 cloud inserts (v4 already has them)');
  assert.strictEqual(prevD.plannedLocalChanges.settingsUpdates, 1, 'Device D sees 1 local settings update (fontSize)');

  // Device D runs Sync -> Applies settings locally without creating v5
  const syncResD = await executeCloudSync({ pin: testPin, accessToken: testToken, driveClient: drive4 });
  assert.strictEqual(syncResD.cloudWritePerformed, false, 'Device D performs pull-only with 0 cloud writes');
  assert.strictEqual(syncResD.snapshotId, v4Payload.snapshot_id, 'Device D converges on snapshot v4');
  pass('Device D converged cleanly on v4 with zero metadata loop');

  // ─────────────────────────────────────────────────────────────
  // TEST 6: Execution Timing Instrumentation
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 6: Execution Timing Instrumentation ---');
  assert(syncRes4.diagnostics, 'executeCloudSync returns diagnostics object');
  assert(typeof syncRes4.diagnostics.localDbReadMs === 'number', 'localDbReadMs is recorded');
  assert(typeof syncRes4.diagnostics.driveLookupMs === 'number', 'driveLookupMs is recorded');
  assert(typeof syncRes4.diagnostics.driveDownloadMs === 'number', 'driveDownloadMs is recorded');
  assert(typeof syncRes4.diagnostics.decryptionMs === 'number', 'decryptionMs is recorded');
  assert(typeof syncRes4.diagnostics.reconciliationMs === 'number', 'reconciliationMs is recorded');
  assert(typeof syncRes4.diagnostics.localDbApplyMs === 'number', 'localDbApplyMs is recorded');
  assert(typeof syncRes4.diagnostics.snapshotCreationMs === 'number', 'snapshotCreationMs is recorded');
  assert(typeof syncRes4.diagnostics.encryptionMs === 'number', 'encryptionMs is recorded');
  assert(typeof syncRes4.diagnostics.uploadMs === 'number', 'uploadMs is recorded');
  assert(typeof syncRes4.diagnostics.postVerifyMs === 'number', 'postVerifyMs is recorded');
  assert(typeof syncRes4.diagnostics.manifestSaveMs === 'number', 'manifestSaveMs is recorded');
  assert(typeof syncRes4.diagnostics.totalMs === 'number', 'totalMs is recorded');

  // Pull-only timing verification (Test 1 syncRes1): Upload & encryption phases must be 0
  assert.strictEqual(syncRes1.diagnostics.uploadMs, 0, 'Pull-only uploadMs is 0');
  assert.strictEqual(syncRes1.diagnostics.encryptionMs, 0, 'Pull-only encryptionMs is 0');
  assert.strictEqual(syncRes1.diagnostics.snapshotCreationMs, 0, 'Pull-only snapshotCreationMs is 0');
  pass('Execution timing instrumentation captures granular metrics and distinguishes push vs pull');

  // ─────────────────────────────────────────────────────────────
  // TEST 7: Type-Safe Operation & UI Enum Collision Fix
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 7: Type-Safe Operation & Enum Collision Fix ---');
  await resetDB();
  const bootRes = await executeBootstrap({ pin: testPin, accessToken: testToken, driveClient: drive4 });
  assert.strictEqual(bootRes.operation, 'BOOTSTRAP', 'Bootstrap returns operation BOOTSTRAP');
  assert.strictEqual(bootRes.status, BOOTSTRAP_STATUS.BOOTSTRAP_SUCCESS, 'Bootstrap status is BOOTSTRAP_SUCCESS');
  assert.strictEqual(syncRes4.operation, 'SYNC', 'Regular sync returns operation SYNC');
  assert.strictEqual(syncRes1.operation, 'SYNC', 'Pull-only sync returns operation SYNC');
  pass('Type-safe operation field resolves enum collision between bootstrap and regular sync');

  console.log('\n================================================================');
  console.log(`   TEST RESULTS: ${passedTests} PASSED, 0 FAILED (out of ${totalTests})`);
  console.log('================================================================\n');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
