/**
 * snapshot_device_import.test.js
 * 
 * Automated Test Suite for Controlled v10 Snapshot Import & Replacement
 * 
 * Verifies:
 * 1. Confirmation Gate: Rejects immediately without touching database if confirmation is missing.
 * 2. Preflight Read-Only Inspection: Accurately validates snapshot without any local or cloud writes.
 * 3. Validation Failure Guards: Aborts before database changes if snapshot ID, cloud version,
 *    schema version, or entity counts mismatch.
 * 4. Successful Replacement: Cleanly replaces local data, verifies post-import counts, establishes
 *    base manifest, and records pre-replacement backup.
 * 5. Rollback on Failure: Catches insertion or post-verification failures and safely restores
 *    the original local database records and settings.
 * 6. Zero Cloud / Android Mutation: Performs only GET requests on Drive; makes zero uploads.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initDB, getDB, closeDB } from '../database/db.js';
import { getSetting, setSetting } from '../database/settings.js';
import { encryptBackupData } from '../utils/cryptoBackup.js';
import {
  importSnapshotV10ToDevice,
  preflightSnapshotV10Import,
  validateSnapshotV10Payload,
  verifyLocalRecoveryState,
  V10_TARGET_REFERENCE,
  SNAPSHOT_IMPORT_ERROR_CODES,
  SnapshotImportError
} from '../services/snapshotDeviceImport.js';
import { readLocalEntities } from '../services/cloudSyncEngine.js';

const TEST_PIN = '7410';
const TEST_TOKEN = 'mock_oauth_access_token_v10_import';

class MockDriveTransport {
  constructor() {
    this.files = new Map();
    this.readCallCount = 0;
    this.writeCallCount = 0;
  }

  async findAppDataFile(filename, token) {
    const f = this.files.get(filename);
    if (!f) return null;
    return { id: f.id, name: f.name, version: f.version, modifiedTime: f.modifiedTime };
  }

  async readAppDataFile(fileId, token) {
    this.readCallCount++;
    for (const f of this.files.values()) {
      if (f.id === fileId) return f.content;
    }
    throw new Error(`File not found: ${fileId}`);
  }

  async uploadAppDataFile(filename, content, mimeType, token) {
    this.writeCallCount++;
    throw new Error('UNAUTHORIZED_DRIVE_WRITE: Import must never upload to Drive!');
  }
}

/**
 * Builds a synthetic valid v10 test snapshot fixture matching V10_TARGET_REFERENCE
 */
function createValidV10Fixture() {
  const regTxns = [];
  for (let i = 0; i < V10_TARGET_REFERENCE.regularTransactionsCount; i++) {
    regTxns.push({
      id: `txn_v10_${String(i).padStart(6, '0')}`,
      Date: '2026-10-12',
      Time: '12:00',
      Account: 'HDFC',
      Category: 'Food',
      Subcategory: 'Groceries',
      Note: `Valid regular transaction ${i}`,
      Description: `Description ${i}`,
      INR: 100 + (i % 50),
      'Income/Expense': 'Expense',
      tags: '#v10-import'
    });
  }

  const invTxns = [];
  for (let i = 0; i < V10_TARGET_REFERENCE.investmentTransactionsCount; i++) {
    invTxns.push({
      id: `inv_v10_${String(i).padStart(4, '0')}`,
      Date: '2026-10-12',
      Time: '14:30',
      Account: 'HDFC',
      Category: 'Investments',
      Subcategory: 'Mutual Funds',
      Note: `Investment ${i}`,
      Description: `Fund purchase ${i}`,
      INR: 5000,
      'Income/Expense': 'Transfer-Out',
      InvestmentTransactionType: 'BUY',
      Brokerage: 'Zerodha',
      SecuritySymbol: 'NIFTY50',
      SecurityISIN: 'INF204K01XI3',
      Quantity: 10,
      UnitPrice: 500,
      TotalCharges: 20
    });
  }

  const accounts = [];
  // Authoritative Cash account matching Android v10 exactly
  accounts.push({
    id: 'Cash',
    name: 'Cash',
    type: 'Bank Accounts',
    group: 'Cash',
    order: 0,
    currency: 'INR'
  });
  // Marriage account sharing ID with category Marriage
  accounts.push({
    id: 'Marriage',
    name: 'Marriage',
    type: 'Bank Accounts',
    group: 'Family',
    order: 1,
    currency: 'INR'
  });
  for (let i = 2; i < V10_TARGET_REFERENCE.accountsCount; i++) {
    accounts.push({
      id: `acc_v10_${i}`,
      name: `Account ${i}`,
      group: 'Bank Accounts',
      order: i
    });
  }

  const inventory = [];
  for (let i = 0; i < V10_TARGET_REFERENCE.inventoryCount; i++) {
    inventory.push({
      id: `inv_item_v10_${i}`,
      name: `Item ${i}`,
      qty: 10,
      price: 25,
      purchased_date: '2026-10-01'
    });
  }

  return {
    snapshot_id: V10_TARGET_REFERENCE.snapshotId,
    cloud_version: V10_TARGET_REFERENCE.cloudVersion,
    schema_version: V10_TARGET_REFERENCE.schemaVersion,
    parent_snapshot_id: V10_TARGET_REFERENCE.parentSnapshotId,
    device_id: 'dev_authoritative_source',
    created_at: new Date().toISOString(),
    entities: {
      transactions: regTxns,
      investment_transactions: invTxns,
      accounts,
      inventory,
      account_groups: [
        { id: 'Cash', name: 'Cash', order: 1 },
        { id: 'Bank Accounts', name: 'Bank Accounts', order: 2 }
      ],
      categories: [
        { id: 'Food', name: 'Food', type: 'Expense' },
        { id: 'Marriage', name: 'Marriage', type: 'Expense' }
      ],
      subcategories: [{ id: 'Groceries', name: 'Groceries', category_id: 'Food' }],
      brokerages: [{ id: 'Zerodha', name: 'Zerodha', bank_account: 'HDFC', owner: 'Akbar' }],
      settings: {
        theme: 'dark'
      }
    }
  };
}

test('FinMan Controlled v10 Snapshot Device Import Suite', async (t) => {
  let db;

  t.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    db = await initDB();
  });

  t.afterEach(async () => {
    closeDB();
  });

  await t.test('1. Confirmation Gate — Rejects without touching local database if confirmation is missing', async () => {
    // Populate local database with initial stale records
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['local_tx_1', '2026-09-01', 50, 'Expense']);
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['local_tx_2', '2026-09-02', 75, 'Expense']);

    const mockDrive = new MockDriveTransport();

    await assert.rejects(
      async () => {
        await importSnapshotV10ToDevice({
          accessToken: TEST_TOKEN,
          pin: TEST_PIN,
          confirmation: false, // Missing confirmation!
          driveClient: mockDrive
        });
      },
      (err) => {
        assert(err instanceof SnapshotImportError, 'Throws SnapshotImportError');
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.CONFIRMATION_REQUIRED);
        return true;
      }
    );

    // Verify local DB was completely untouched
    const entities = await readLocalEntities(db);
    assert.equal(entities.transactions.length, 2, 'Local transactions must remain 2');
    assert.equal(mockDrive.readCallCount, 0, 'No Drive read calls executed');
  });

  await t.test('2. Snapshot Validation Gate — Rejects if snapshot ID or entity counts mismatch', async () => {
    // A: Snapshot ID mismatch
    const badIdFixture = createValidV10Fixture();
    badIdFixture.snapshot_id = 'snap_invalid_id_999';
    assert.throws(
      () => validateSnapshotV10Payload(badIdFixture),
      (err) => {
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED);
        assert(err.message.includes('Snapshot ID mismatch'));
        return true;
      }
    );

    // B: Cloud Version mismatch
    const badVerFixture = createValidV10Fixture();
    badVerFixture.cloud_version = 9;
    assert.throws(
      () => validateSnapshotV10Payload(badVerFixture),
      (err) => {
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED);
        assert(err.message.includes('Cloud version mismatch'));
        return true;
      }
    );

    // C: Schema Version mismatch
    const badSchemaFixture = createValidV10Fixture();
    badSchemaFixture.schema_version = 12;
    assert.throws(
      () => validateSnapshotV10Payload(badSchemaFixture),
      (err) => {
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED);
        assert(err.message.includes('Schema version mismatch'));
        return true;
      }
    );

    // D: Transaction count mismatch
    const badCountFixture = createValidV10Fixture();
    badCountFixture.entities.transactions.pop(); // Remove 1 transaction
    assert.throws(
      () => validateSnapshotV10Payload(badCountFixture),
      (err) => {
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED);
        assert(err.message.includes('Regular transactions count mismatch'));
        return true;
      }
    );

    // E: Accounts count mismatch
    const badAccountsFixture = createValidV10Fixture();
    badAccountsFixture.entities.accounts.pop(); // Remove 1 account
    assert.throws(
      () => validateSnapshotV10Payload(badAccountsFixture),
      (err) => {
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED);
        assert(err.message.includes('Accounts count mismatch'));
        return true;
      }
    );

    // F: Inventory count mismatch
    const badInvFixture = createValidV10Fixture();
    badInvFixture.entities.inventory.pop(); // Remove 1 inventory item
    assert.throws(
      () => validateSnapshotV10Payload(badInvFixture),
      (err) => {
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED);
        assert(err.message.includes('Inventory count mismatch'));
        return true;
      }
    );
  });

  await t.test('3. Preflight Read-Only Inspection — Downloads & validates without modifying DB or Drive', async () => {
    // Populate local database with 3 test items
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['stale_1', '2026-09-01', 10, 'Expense']);
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['stale_2', '2026-09-02', 20, 'Expense']);
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['stale_3', '2026-09-03', 30, 'Expense']);

    const validFixture = createValidV10Fixture();
    const encryptedCiphertext = await encryptBackupData(validFixture, TEST_PIN);

    const mockDrive = new MockDriveTransport();
    mockDrive.files.set(V10_TARGET_REFERENCE.filename, {
      id: 'mock_drive_file_id_v10',
      name: V10_TARGET_REFERENCE.filename,
      version: 10,
      content: encryptedCiphertext
    });

    const preflight = await preflightSnapshotV10Import({
      accessToken: TEST_TOKEN,
      pin: TEST_PIN,
      driveClient: mockDrive
    });

    assert.equal(preflight.ready, true);
    assert.equal(preflight.targetSnapshotId, V10_TARGET_REFERENCE.snapshotId);
    assert.equal(preflight.cloudVersion, 10);
    assert.equal(preflight.schemaVersion, 13);
    assert.equal(preflight.incomingCounts.totalTransactions, 29158);
    assert.equal(preflight.incomingCounts.accounts, 36);
    assert.equal(preflight.incomingCounts.inventory, 732);
    assert.equal(preflight.localCounts.transactions, 3);

    // Verify local DB was untouched
    const local = await readLocalEntities(db);
    assert.equal(local.transactions.length, 3);
    assert.equal(mockDrive.writeCallCount, 0, 'Zero writes to Drive');
  });

  await t.test('4. Successful Replacement — Cleanly replaces local data and establishes base manifest', async () => {
    // Populate local DB with stale test data
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['stale_old_1', '2026-08-01', 99, 'Expense']);
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['old_acc', 'Old Account', 'Old Group']);
    await setSetting('last_snapshot_id', 'snap_stale_v7');
    await setSetting('sync_base_manifest', JSON.stringify({ old: { fp: '123' } }));

    const validFixture = createValidV10Fixture();
    const encryptedCiphertext = await encryptBackupData(validFixture, TEST_PIN);

    const mockDrive = new MockDriveTransport();
    mockDrive.files.set(V10_TARGET_REFERENCE.filename, {
      id: 'mock_drive_file_id_v10',
      name: V10_TARGET_REFERENCE.filename,
      version: 10,
      content: encryptedCiphertext
    });

    const result = await importSnapshotV10ToDevice({
      accessToken: TEST_TOKEN,
      pin: TEST_PIN,
      confirmation: 'CONFIRM_REPLACE_LOCAL_DATA',
      driveClient: mockDrive
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'IMPORT_SUCCESS');
    assert.equal(result.snapshotId, V10_TARGET_REFERENCE.snapshotId);
    assert.equal(result.recordsImported.transactions, 28259);
    assert.equal(result.recordsImported.investment_transactions, 899);
    assert.equal(result.recordsImported.totalTransactions, 29158);
    assert.equal(result.recordsImported.accounts, 36);
    assert.equal(result.recordsImported.inventory, 732);
    assert.equal(result.preImportBackupCounts.transactions, 1);

    // Verify local database contents
    const postEntities = await readLocalEntities(db);
    assert.equal(postEntities.transactions.length, 28259);
    assert.equal(postEntities.investment_transactions.length, 899);
    assert.equal(postEntities.accounts.length, 36);
    assert.equal(postEntities.inventory.length, 732);

    // Verify Cash account and Cash account group both exist without collision
    const cashAcc = postEntities.accounts.find(a => a.id === 'Cash');
    assert.ok(cashAcc, 'Account Cash must exist in postEntities');
    assert.equal(cashAcc.name, 'Cash');
    const cashGroup = postEntities.account_groups.find(g => g.id === 'Cash');
    assert.ok(cashGroup, 'Account group Cash must exist in postEntities without colliding');
    assert.equal(cashGroup.name, 'Cash');

    // Stale records must be gone
    assert.equal(postEntities.transactions.some(t => t.id === 'stale_old_1'), false);

    // Settings must be updated to align with v10
    const newSnapId = await getSetting('last_snapshot_id');
    assert.equal(newSnapId, V10_TARGET_REFERENCE.snapshotId);
    const newManifestRaw = await getSetting('sync_base_manifest');
    const newManifest = JSON.parse(newManifestRaw);
    assert.ok(Object.keys(newManifest).length >= 29158, 'Manifest should contain all imported entities');

    // Pre-import backup must be recorded in settings
    const preBackup = await getSetting('pre_v10_recovery_backup');
    assert(preBackup && preBackup.includes('transactions'));

    // Zero Drive writes
    assert.equal(mockDrive.writeCallCount, 0);
  });

  await t.test('5. Rollback on Failure — Safely restores original local database records and settings if population fails', async () => {
    // Populate local DB with valuable records
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['precious_tx_1', '2026-09-15', 500, 'Income']);
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['precious_tx_2', '2026-09-16', 300, 'Expense']);
    await setSetting('last_snapshot_id', 'snap_original_preserve_v8');
    await setSetting('sync_base_manifest', JSON.stringify({ precious: { fp: 'abc' } }));

    const validFixture = createValidV10Fixture();
    const encryptedCiphertext = await encryptBackupData(validFixture, TEST_PIN);

    const mockDrive = new MockDriveTransport();
    mockDrive.files.set(V10_TARGET_REFERENCE.filename, {
      id: 'mock_drive_file_id_v10',
      name: V10_TARGET_REFERENCE.filename,
      version: 10,
      content: encryptedCiphertext
    });

    // Simulate database failure during batchReplace or insertion
    const originalBatchReplace = db.batchReplace?.bind(db);
    let callCount = 0;
    db.batchReplace = async (store, items) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Simulated disk/indexedDB write failure during transactions import!');
      }
      return originalBatchReplace ? originalBatchReplace(store, items) : { replaced: items.length };
    };

    await assert.rejects(
      async () => {
        await importSnapshotV10ToDevice({
          accessToken: TEST_TOKEN,
          pin: TEST_PIN,
          confirmation: 'CONFIRM_REPLACE_LOCAL_DATA',
          driveClient: mockDrive
        });
      },
      (err) => {
        assert(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.ROLLBACK_TRIGGERED);
        assert(err.message.includes('rolled back'));
        return true;
      }
    );

    // Verify rollback restored the precious records
    const restoredEntities = await readLocalEntities(db);
    assert.equal(restoredEntities.transactions.length, 2, 'Restored transactions count must match original (2)');
    assert.equal(restoredEntities.transactions[0].id, 'precious_tx_1');
    assert.equal(restoredEntities.transactions[1].id, 'precious_tx_2');

    // Verify settings were restored
    const restoredSnap = await getSetting('last_snapshot_id');
    assert.equal(restoredSnap, 'snap_original_preserve_v8');

    // Verify read-only verifyLocalRecoveryState check confirms complete restoration
    const recoveryCheck = await verifyLocalRecoveryState(db);
    assert.equal(recoveryCheck.status, 'RECOVERED_MATCHES_BACKUP');
    assert.equal(recoveryCheck.matchesBackup, true);
    assert.equal(recoveryCheck.currentCounts.totalTransactions, 2);
    assert.equal(recoveryCheck.lastSnapshotId, 'snap_original_preserve_v8');
  });
});
