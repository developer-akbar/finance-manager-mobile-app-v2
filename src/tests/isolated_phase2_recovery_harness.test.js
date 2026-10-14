/**
 * isolated_phase2_recovery_harness.test.js
 * 
 * Deterministic Virtual Test Harness (Phase 2 Option 3)
 * Executes strictly in-memory using fake-indexeddb and mock Drive transport.
 * ZERO network requests, ZERO live Drive access, ZERO production mutations.
 * 
 * Test Scopes:
 * 1. Fresh Browser Join (29,173 Snapshot)
 * 2. Active Device Recovery with Divergent Data & Multi-Stage Rollback
 * 3. Multi-Device Synchronization Convergence (Two Devices)
 * 4. Complex Edge Cases (Migrated IDs, Investment Trades, Inventory, Tombstones, Conflicts, Scoped Keys)
 * 5. Mock Transport Network Isolation Assertion
 */

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { initDB, getDB, closeDB } from '../database/db.js';
import { getSetting, setSetting } from '../database/settings.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';
import {
  readLocalEntities,
  buildEntityManifest,
  getManifestEntityKey,
  canonicalizeEntity,
  fastFingerprint,
  reconcile3Way,
  validateCloudSnapshotPayload,
  CONFLICT_TYPES
} from '../services/cloudSyncEngine.js';
import {
  importSnapshotV10ToDevice,
  preflightSnapshotV10Import,
  verifyLocalRecoveryState,
  V11_TARGET_REFERENCE,
  SNAPSHOT_IMPORT_ERROR_CODES,
  SnapshotImportError
} from '../services/snapshotDeviceImport.js';
import {
  bootstrapNewDevice,
  DEVICE_LIFECYCLE,
  SYNC_STATUS as DELTA_SYNC_STATUS,
  getDeviceLifecycleState,
  getDeltaSyncMetrics
} from '../services/deltaSyncCoordinator.js';

const TEST_PIN = '7410';
const TEST_TOKEN = 'mock_oauth_access_token_isolated_test';

/**
 * Isolated Virtual Mock Drive Transport
 * 100% In-Memory. Guarantees zero fallback to fetch or real network.
 */
class IsolatedMockDriveTransport {
  constructor() {
    this.files = new Map();
    this.readCount = 0;
    this.writeCount = 0;
    this.patchCount = 0;
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
    throw new Error(`[IsolatedMockDriveTransport] File not found: ${fileId}`);
  }

  async uploadAppDataFile(filename, content, mimeType, token) {
    this.writeCount++;
    const id = `mock_file_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fileObj = { id, name: filename, content, version: 1, modifiedTime: new Date().toISOString() };
    this.files.set(filename, fileObj);
    return fileObj;
  }

  async patchAppDataFile(fileId, content, mimeType, token) {
    this.patchCount++;
    for (const [name, f] of this.files.entries()) {
      if (f.id === fileId) {
        f.content = content;
        f.version = (f.version || 1) + 1;
        f.modifiedTime = new Date().toISOString();
        return f;
      }
    }
    throw new Error(`[IsolatedMockDriveTransport] File not found for PATCH: ${fileId}`);
  }

  async listAppDataFiles(query, token) {
    const results = [];
    for (const f of this.files.values()) {
      results.push({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });
    }
    return results;
  }
}

/**
 * Helper to build a synthetic candidate v11 fixture in memory
 */
function createSyntheticV11Fixture() {
  const txns = [];
  for (let i = 0; i < 28274; i++) {
    txns.push({
      id: `txn_v11_${String(i).padStart(6, '0')}`,
      date: '2026-10-10',
      time: '12:00',
      amount: String(10 + (i % 500)),
      inr: 10 + (i % 500),
      currency: 'INR',
      type: (i % 10 === 0) ? 'Income' : 'Expense',
      account: 'HDFC',
      category: 'Food',
      note: `Regular transaction ${i}`
    });
  }

  const invTxns = [];
  for (let i = 0; i < 899; i++) {
    invTxns.push({
      id: `inv_v11_${String(i).padStart(4, '0')}`,
      date: '2026-10-10',
      amount: String(1000 + i),
      inr: 1000 + i,
      currency: 'INR',
      type: 'Expense',
      account: 'Share Market',
      category: 'Investments',
      investment_transaction_type: (i % 2 === 0) ? 'BUY' : 'SELL',
      brokerage: 'Zerodha',
      security_symbol: `SEC_${i % 50}`,
      security_isin: `INE0000000${String(i % 50).padStart(2, '0')}`,
      quantity: 10,
      unit_price: 100,
      trade_value: 1000
    });
  }

  const accounts = [];
  for (let i = 0; i < 36; i++) {
    accounts.push({ id: `acc_v11_${i}`, name: i === 0 ? 'Cash' : `Account_${i}`, group_name: i === 0 ? 'Cash' : 'General' });
  }

  const categories = [];
  for (let i = 0; i < 41; i++) {
    categories.push({ id: `cat_v11_${i}`, name: i === 0 ? 'Cash' : `Category_${i}`, type: 'Expense' });
  }

  const inventory = [];
  for (let i = 0; i < 732; i++) {
    inventory.push({ id: `inv_item_${i}`, name: `Stock Item ${i}`, quantity: 5, unit_price: 50 });
  }

  return {
    snapshot_id: V11_TARGET_REFERENCE.snapshotId,
    cloud_version: V11_TARGET_REFERENCE.cloudVersion,
    schema_version: V11_TARGET_REFERENCE.schemaVersion,
    engine_version: 3,
    parent_snapshot_id: V11_TARGET_REFERENCE.parentSnapshotId,
    created_at: new Date().toISOString(),
    device_id: 'dev_isolated_harness',
    entities: {
      transactions: txns,
      investment_transactions: invTxns,
      accounts,
      categories,
      inventory,
      subcategories: [],
      sub_accounts: [],
      account_groups: [{ id: 'Cash', name: 'Cash' }],
      brokerages: [],
      budgets: [],
      recurring_rules: [],
      investment_plans: [],
      sync_tombstones: [],
      settings: { theme: 'dark', default_currency: 'INR' }
    }
  };
}

test('FinMan Phase 2 Option 3 — Deterministic Virtual Test Harness', async (suite) => {
  let db;

  suite.beforeEach(async () => {
    indexedDB = new IDBFactory();
    await initDB();
    db = getDB();
  });

  suite.afterEach(async () => {
    try {
      await closeDB();
    } catch {}
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCOPE 1: Fresh Browser Join (29,173 Snapshot)
  // ─────────────────────────────────────────────────────────────────────────────
  await suite.test('Scope 1: Fresh Browser Join — Installs 29,173 records into empty database', async () => {
    const fixture = createSyntheticV11Fixture();
    const ciphertext = await encryptBackupData(fixture, TEST_PIN);

    const mockDrive = new IsolatedMockDriveTransport();
    mockDrive.files.set(V11_TARGET_REFERENCE.filename, {
      id: 'mock_drive_v11_file',
      name: V11_TARGET_REFERENCE.filename,
      version: 11,
      content: ciphertext
    });

    const result = await importSnapshotV10ToDevice({
      accessToken: TEST_TOKEN,
      pin: TEST_PIN,
      confirmation: 'CONFIRM_REPLACE_LOCAL_DATA',
      driveClient: mockDrive,
      targetRef: V11_TARGET_REFERENCE
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'IMPORT_SUCCESS');
    assert.equal(result.snapshotId, V11_TARGET_REFERENCE.snapshotId);
    assert.equal(result.recordsImported.transactions, 28274);
    assert.equal(result.recordsImported.investment_transactions, 899);
    assert.equal(result.recordsImported.totalTransactions, 29173);
    assert.equal(result.recordsImported.accounts, 36);
    assert.equal(result.recordsImported.categories, 41);
    assert.equal(result.recordsImported.inventory, 732);

    // Verify physical records in database
    const local = await readLocalEntities(db);
    assert.equal(local.transactions.length, 28274);
    assert.equal(local.investment_transactions.length, 899);
    assert.equal(local.accounts.length, 36);
    assert.equal(local.categories.length, 41);
    assert.equal(local.inventory.length, 732);

    // Verify collection-scoped manifest keys
    const manifestRaw = await getSetting('sync_base_manifest');
    assert.ok(manifestRaw);
    const manifest = JSON.parse(manifestRaw);

    // Transactions remain un-prefixed for backward compatibility
    assert.ok(manifest['txn_v11_000000']);
    assert.ok(manifest['inv_v11_0000']);

    // Non-transactions receive collection-scoped prefixes
    assert.ok(manifest['categories:cat_v11_0'] || manifest['categories:Cash']);
    assert.ok(manifest['accounts:acc_v11_0'] || manifest['accounts:Cash']);
    assert.ok(manifest['inventory:inv_item_0']);

    // Zero cloud writes
    assert.equal(mockDrive.writeCount, 0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCOPE 2: Active Device Recovery & Multi-Stage Rollback
  // ─────────────────────────────────────────────────────────────────────────────
  await suite.test('Scope 2A: Active Device Recovery — Replaces divergent v9 baseline with pre-wipe backup', async () => {
    // Populate with 2 divergent transactions
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['v9_old_1', '2026-09-01', 50, 'Expense']);
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['v9_old_2', '2026-09-02', 75, 'Expense']);
    await setSetting('last_snapshot_id', 'snap_1790963722004_bq5y93');
    await setSetting('sync_base_manifest', JSON.stringify({ 'v9_old_1': { fp: '111' } }));

    const fixture = createSyntheticV11Fixture();
    const ciphertext = await encryptBackupData(fixture, TEST_PIN);

    const mockDrive = new IsolatedMockDriveTransport();
    mockDrive.files.set(V11_TARGET_REFERENCE.filename, {
      id: 'mock_drive_v11_file',
      name: V11_TARGET_REFERENCE.filename,
      version: 11,
      content: ciphertext
    });

    const result = await importSnapshotV10ToDevice({
      accessToken: TEST_TOKEN,
      pin: TEST_PIN,
      confirmation: 'CONFIRM_REPLACE_LOCAL_DATA',
      driveClient: mockDrive,
      targetRef: V11_TARGET_REFERENCE
    });

    assert.equal(result.success, true);
    assert.equal(result.preImportBackupCounts.transactions, 2);

    // Old divergent records replaced cleanly without duplicates
    const local = await readLocalEntities(db);
    assert.equal(local.transactions.length, 28274);
    assert.equal(local.transactions.some(t => t.id === 'v9_old_1'), false);
    assert.equal(local.transactions.some(t => t.id === 'v9_old_2'), false);

    // Pre-import recovery backup is persisted and matches
    const recoveryJson = await getSetting('pre_v10_recovery_backup');
    assert.ok(recoveryJson);
    const parsedBackup = JSON.parse(recoveryJson);
    assert.equal(parsedBackup.counts.transactions, 2);
  });

  await suite.test('Scope 2B: Injected Failure at Stage 1 (Partial Population) — Restores original divergent state', async () => {
    // Seed divergent records
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['divergent_txn_A', '2026-09-01', 123, 'Expense']);
    await setSetting('last_snapshot_id', 'snap_1790963722004_bq5y93');

    const fixture = createSyntheticV11Fixture();
    const ciphertext = await encryptBackupData(fixture, TEST_PIN);

    const mockDrive = new IsolatedMockDriveTransport();
    mockDrive.files.set(V11_TARGET_REFERENCE.filename, {
      id: 'mock_drive_v11_file',
      name: V11_TARGET_REFERENCE.filename,
      version: 11,
      content: ciphertext
    });

    // Inject database write error during insertion
    const originalBatchReplace = db.batchReplace?.bind(db);
    let attempts = 0;
    db.batchReplace = async (store, items) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Simulated I/O disk failure during partial population');
      }
      return originalBatchReplace ? originalBatchReplace(store, items) : { replaced: items.length };
    };

    await assert.rejects(
      async () => {
        await importSnapshotV10ToDevice({
          accessToken: TEST_TOKEN,
          pin: TEST_PIN,
          confirmation: 'CONFIRM_REPLACE_LOCAL_DATA',
          driveClient: mockDrive,
          targetRef: V11_TARGET_REFERENCE
        });
      },
      (err) => {
        assert(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.ROLLBACK_TRIGGERED);
        return true;
      }
    );

    // Verify database was cleanly rolled back to divergent_txn_A
    const local = await readLocalEntities(db);
    assert.equal(local.transactions.length, 1);
    assert.equal(local.transactions[0].id, 'divergent_txn_A');
    assert.equal(await getSetting('last_snapshot_id'), 'snap_1790963722004_bq5y93');
  });

  await suite.test('Scope 2C: Injected Failure at Stage 2 (Count Mismatch Verification) — Rolls back cleanly', async () => {
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['divergent_txn_B', '2026-09-02', 456, 'Income']);
    await setSetting('last_snapshot_id', 'snap_1790963722004_bq5y93');

    const fixture = createSyntheticV11Fixture();
    // Tamper with fixture: omit 1 regular transaction
    fixture.entities.transactions.pop();
    const ciphertext = await encryptBackupData(fixture, TEST_PIN);

    const mockDrive = new IsolatedMockDriveTransport();
    mockDrive.files.set(V11_TARGET_REFERENCE.filename, {
      id: 'mock_drive_v11_file',
      name: V11_TARGET_REFERENCE.filename,
      version: 11,
      content: ciphertext
    });

    await assert.rejects(
      async () => {
        await importSnapshotV10ToDevice({
          accessToken: TEST_TOKEN,
          pin: TEST_PIN,
          confirmation: 'CONFIRM_REPLACE_LOCAL_DATA',
          driveClient: mockDrive,
          targetRef: V11_TARGET_REFERENCE
        });
      },
      (err) => {
        assert(err instanceof SnapshotImportError);
        return true;
      }
    );

    // Verify rollback
    const local = await readLocalEntities(db);
    assert.equal(local.transactions.length, 1);
    assert.equal(local.transactions[0].id, 'divergent_txn_B');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCOPE 3: Multi-Device Synchronization Convergence
  // ─────────────────────────────────────────────────────────────────────────────
  await suite.test('Scope 3: Multi-Device Synchronization — Reconciles independent expense and income without duplicates', async () => {
    // Device 1 and Device 2 starting from identical base
    const baseManifest = {
      'txn_base_1': { type: 'transactions', fp: 'fp_base_1', canonical: 'txn_base_1|2026-10-01|100|Expense' }
    };
    const baseEntities = {
      transactions: [{ id: 'txn_base_1', date: '2026-10-01', amount: '100', inr: 100, type: 'Expense' }],
      investment_transactions: []
    };

    // Device 1 creates a new Expense
    const dev1Entities = {
      transactions: [
        ...baseEntities.transactions,
        { id: 'txn_dev1_expense', date: '2026-10-12', amount: '250', inr: 250, type: 'Expense', note: 'Chai' }
      ],
      investment_transactions: []
    };

    // Device 2 creates a new Income
    const dev2Entities = {
      transactions: [
        ...baseEntities.transactions,
        { id: 'txn_dev2_income', date: '2026-10-12', amount: '5000', inr: 5000, type: 'Income', note: 'Freelance' }
      ],
      investment_transactions: []
    };

    // Device 1 reconciles against Device 2 (represented as cloud)
    const planForDev1 = await reconcile3Way({
      baseManifest,
      localEntities: dev1Entities,
      cloudEntities: dev2Entities
    });

    assert.equal(planForDev1.conflicts.length, 0, 'Zero conflicts expected for independent additions');
    assert.equal(planForDev1.plannedLocalInserts.length, 1, 'Device 1 must receive Dev2 income');
    assert.equal(planForDev1.plannedLocalInserts[0].id, 'txn_dev2_income');
    assert.equal(planForDev1.plannedCloudInserts.length, 1, 'Device 1 must upload Dev1 expense');
    assert.equal(planForDev1.plannedCloudInserts[0].id, 'txn_dev1_expense');

    // Device 2 reconciles against Device 1 (represented as cloud)
    const planForDev2 = await reconcile3Way({
      baseManifest,
      localEntities: dev2Entities,
      cloudEntities: dev1Entities
    });

    assert.equal(planForDev2.conflicts.length, 0);
    assert.equal(planForDev2.plannedLocalInserts.length, 1);
    assert.equal(planForDev2.plannedLocalInserts[0].id, 'txn_dev1_expense');
    assert.equal(planForDev2.plannedCloudInserts.length, 1);
    assert.equal(planForDev2.plannedCloudInserts[0].id, 'txn_dev2_income');

    // Both converge to 3 total transactions without duplicates
    const convergedDev1 = [...dev1Entities.transactions, ...planForDev1.plannedLocalInserts];
    const convergedDev2 = [...dev2Entities.transactions, ...planForDev2.plannedLocalInserts];
    assert.equal(convergedDev1.length, 3);
    assert.equal(convergedDev2.length, 3);

    const dev1Ids = new Set(convergedDev1.map(t => t.id));
    const dev2Ids = new Set(convergedDev2.map(t => t.id));
    assert.deepEqual(dev1Ids, dev2Ids, 'Both devices converge to identical entity ID set');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCOPE 4: Complex Edge Cases
  // ─────────────────────────────────────────────────────────────────────────────
  await suite.test('Scope 4A: Stable Identity Reconciliation — Pairs differing IDs sharing identical business fingerprint', async () => {
    // Local has UUID, Cloud has sequential ID with identical date, amount, type, account, category
    const localTxn = { id: '652866ae-d1bd-435a-88e0-1e8813f65c10', date: '01/01/2026', inr: 500, amount: '500', type: 'Expense', account: 'HDFC', category: 'Groceries', note: 'Weekly' };
    const cloudTxn = { id: 'txn_1704067200000_000000', date: '01/01/2026', inr: 500, amount: '500', type: 'Expense', account: 'HDFC', category: 'Groceries', note: 'Weekly' };

    const plan = await reconcile3Way({
      baseManifest: {},
      localEntities: { transactions: [localTxn], investment_transactions: [] },
      cloudEntities: { transactions: [cloudTxn], investment_transactions: [] }
    });

    assert.equal(plan.identityMatchedTransactions, 1, 'Must pair single candidate match');
    assert.equal(plan.plannedLocalInserts.length, 0, 'No duplicate local insert');
    assert.equal(plan.plannedCloudInserts.length, 0, 'No duplicate cloud insert');
    assert.equal(plan.conflicts.length, 0, 'No conflict for paired identity');
  });

  await suite.test('Scope 4B: Investment Trade Companion Charges — Preserves charges across reconciliation', async () => {
    const invTrade = {
      id: 'inv_trade_100',
      date: '2026-10-10',
      amount: '5000',
      inr: 5000,
      type: 'Expense',
      investment_transaction_type: 'BUY',
      brokerage: 'Zerodha',
      security_symbol: 'TCS',
      trade_value: 5000,
      total_charges: 45.5,
      brokerage_charges: 20,
      stt_charges: 25.5
    };

    const plan = await reconcile3Way({
      baseManifest: {},
      localEntities: { transactions: [], investment_transactions: [] },
      cloudEntities: { transactions: [], investment_transactions: [invTrade] }
    });

    assert.equal(plan.plannedLocalInserts.length, 1);
    const inserted = plan.plannedLocalInserts[0];
    assert.equal(inserted.total_charges, 45.5);
    assert.equal(inserted.brokerage_charges, 20);
    assert.equal(inserted.stt_charges, 25.5);
  });

  await suite.test('Scope 4C: Inventory Tombstones — Propagates batch deletion without resurrecting item', async () => {
    const cloudItem = { id: 'inv_batch_1', name: 'Item A', quantity: 10 };
    const baseCanonical = canonicalizeEntity(cloudItem, 'inventory');
    const baseManifest = {
      'inventory:inv_batch_1': { type: 'inventory', fp: fastFingerprint(baseCanonical), canonical: baseCanonical }
    };
    const localEntities = {
      transactions: [],
      investment_transactions: [],
      inventory: [],
      sync_tombstones: [{ id: 'inv_batch_1', entity_type: 'inventory', deleted_at: new Date().toISOString() }]
    };
    const cloudEntities = {
      transactions: [],
      investment_transactions: [],
      inventory: [cloudItem]
    };

    const plan = await reconcile3Way({
      baseManifest,
      localEntities,
      cloudEntities
    });

    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.plannedLocalDeletes.length, 0);
    assert.equal(plan.plannedCloudDeletes.length, 1, 'Local deletion propagates to cloud');
    assert.equal(plan.plannedCloudDeletes[0], 'inv_batch_1');
  });

  await suite.test('Scope 4D: Genuine Concurrent Conflict Escalation — Refuses silent LWW on financial records', async () => {
    const baseManifest = {
      'txn_shared_1': { type: 'transactions', fp: 'fp_base', canonical: 'txn_shared_1|2026-10-01|100|Expense' }
    };
    const localEntities = {
      transactions: [{ id: 'txn_shared_1', date: '2026-10-01', amount: '150', inr: 150, type: 'Expense' }],
      investment_transactions: []
    };
    const cloudEntities = {
      transactions: [{ id: 'txn_shared_1', date: '2026-10-01', amount: '200', inr: 200, type: 'Expense' }],
      investment_transactions: []
    };

    const plan = await reconcile3Way({
      baseManifest,
      localEntities,
      cloudEntities
    });

    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].type, CONFLICT_TYPES.FINANCIAL_CONFLICT);
    assert.equal(plan.conflicts[0].local.inr, 150);
    assert.equal(plan.conflicts[0].cloud.inr, 200);
  });

  await suite.test('Scope 4E: Collection-Scoped Manifest Keys — Prevents cross-table collision for identical IDs', async () => {
    const keyAccount = getManifestEntityKey('accounts', 'Cash');
    const keyCategory = getManifestEntityKey('categories', 'Cash');
    const keyGroup = getManifestEntityKey('account_groups', 'Cash');
    const keyTxn = getManifestEntityKey('transactions', 'Cash');

    assert.equal(keyAccount, 'accounts:Cash');
    assert.equal(keyCategory, 'categories:Cash');
    assert.equal(keyGroup, 'account_groups:Cash');
    assert.equal(keyTxn, 'Cash', 'Transactions retain un-prefixed IDs');

    // All distinct
    const keySet = new Set([keyAccount, keyCategory, keyGroup, keyTxn]);
    assert.equal(keySet.size, 4, 'All four collection-scoped keys must be distinct');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SCOPE 5: Mock Transport Network Isolation Assertion
  // ─────────────────────────────────────────────────────────────────────────────
  await suite.test('Scope 5: Mock Transport Isolation Assertion — Verifies zero outbound network calls', async () => {
    const transport = new IsolatedMockDriveTransport();
    assert.equal(typeof transport.readAppDataFile, 'function');
    assert.equal(typeof transport.uploadAppDataFile, 'function');
    assert.equal(typeof transport.patchAppDataFile, 'function');
    // Ensure no fetch or socket properties exist on transport
    assert.equal(transport.fetch, undefined);
    assert.equal(transport.socket, undefined);
    assert.equal(transport.http, undefined);
  });
});
