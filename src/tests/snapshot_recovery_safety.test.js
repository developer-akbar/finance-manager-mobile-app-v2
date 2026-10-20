/**
 * snapshot_recovery_safety.test.js
 * 
 * Comprehensive Test Suite for Snapshot Recovery Safety:
 * Fix A — Snapshot/delta lineage transition & delta queue quarantine
 * Fix B — Durable pre-import recovery, fail-closed pre-backup guard, and crash recovery
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initDB, getDB, closeDB, getRawIDB } from '../database/db.js';
import { getSetting, setSetting } from '../database/settings.js';
import { encryptBackupData } from '../utils/cryptoBackup.js';
import {
  importSnapshotV10ToDevice,
  restorePreImportBackup,
  verifyLocalRecoveryState,
  createDurablePreImportBackup,
  quarantinePendingDeltas,
  alignSnapshotSyncLineage,
  V10_TARGET_REFERENCE,
  SNAPSHOT_IMPORT_ERROR_CODES,
  SnapshotImportError
} from '../services/snapshotDeviceImport.js';
import { readLocalEntities } from '../services/cloudSyncEngine.js';

const TEST_PIN = '7410';
const TEST_TOKEN = 'mock_oauth_token_recovery_safety';

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
    throw new Error('UNAUTHORIZED_DRIVE_WRITE: Recovery import must never upload to Drive!');
  }
}

/**
 * Creates a synthetic valid v10 test snapshot fixture matching V10_TARGET_REFERENCE
 * with embedded covered_peer_watermarks
 */
function createSyntheticV10Fixture() {
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
  accounts.push({ id: 'Cash', name: 'Cash', type: 'Bank Accounts', group: 'Cash', order: 0, currency: 'INR' });
  accounts.push({ id: 'Marriage', name: 'Marriage', type: 'Bank Accounts', group: 'Family', order: 1, currency: 'INR' });
  for (let i = 2; i < V10_TARGET_REFERENCE.accountsCount; i++) {
    accounts.push({ id: `acc_v10_${i}`, name: `Account ${i}`, group: 'Bank Accounts', order: i });
  }

  const inventory = [];
  for (let i = 0; i < V10_TARGET_REFERENCE.inventoryCount; i++) {
    inventory.push({ id: `inv_item_v10_${i}`, name: `Item ${i}`, qty: 10, price: 25, purchased_date: '2026-10-01' });
  }

  return {
    snapshot_id: V10_TARGET_REFERENCE.snapshotId,
    cloud_version: V10_TARGET_REFERENCE.cloudVersion,
    schema_version: V10_TARGET_REFERENCE.schemaVersion,
    parent_snapshot_id: V10_TARGET_REFERENCE.parentSnapshotId,
    device_id: 'dev_authoritative_source',
    created_at: new Date().toISOString(),
    covered_peer_watermarks: {
      dev_6edc69e37943: 4,
      dev_b91065cd877f: 6,
      dev_f31f6e6d6628: 12
    },
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
      brokerages: [{ id: 'Zerodha', name: 'Zerodha', bank_account: 'HDFC', owner: 'Akbar' }]
    }
  };
}

test('FinMan Phase 12 — Snapshot Recovery Safety Test Suite', async (t) => {
  let db;

  t.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    db = await initDB();
  });

  t.afterEach(async () => {
    closeDB();
  });

  await t.test('FIX A.1: Pending delta events are quarantined with auditable metadata and never replayed against new baseline', async () => {
    // 1. Seed device with 3 unacknowledged pending delta events
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_pending_1', 'dev_local', 1, '2026-10-13T10:00:00Z', 'transactions', 'txn_old_1', 'UPDATE', JSON.stringify({ amount: 150 }), 'PENDING']
    );
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_pending_2', 'dev_local', 2, '2026-10-13T10:05:00Z', 'transactions', 'txn_old_2', 'INSERT', JSON.stringify({ amount: 250 }), 'PENDING']
    );
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_acked_3', 'dev_local', 3, '2026-10-13T10:10:00Z', 'transactions', 'txn_old_3', 'UPDATE', JSON.stringify({ amount: 350 }), 'ACKNOWLEDGED']
    );

    // 2. Prepare valid fixture and mock transport
    const fixture = createSyntheticV10Fixture();
    const encrypted = await encryptBackupData(fixture, TEST_PIN);
    const mockDrive = new MockDriveTransport();
    mockDrive.files.set(V10_TARGET_REFERENCE.filename, {
      id: 'file_id_v10',
      name: V10_TARGET_REFERENCE.filename,
      version: 10,
      content: encrypted
    });

    // 3. Import snapshot
    const result = await importSnapshotV10ToDevice({
      accessToken: TEST_TOKEN,
      pin: TEST_PIN,
      confirmation: 'CONFIRM_REPLACE_LOCAL_DATA',
      driveClient: mockDrive
    });

    assert.equal(result.success, true);
    assert.equal(result.quarantinedDeltaEventsCount, 3, 'Must report 3 quarantined delta events');

    // 4. Assert: sync_delta_queue is completely empty (zero ghost replays)
    const remainingQueue = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(remainingQueue.length, 0, 'sync_delta_queue must be reset to 0 so no old events can replay');

    // 5. Assert: pre_recovery_quarantined_deltas contains all 3 events with auditable reason
    const quarantineJson = await getSetting('pre_recovery_quarantined_deltas');
    assert.ok(quarantineJson, 'Quarantine record must be persisted in settings');
    const quarantine = JSON.parse(quarantineJson);

    assert.equal(quarantine.reason, 'SNAPSHOT_LINEAGE_RESET');
    assert.equal(quarantine.target_snapshot_id, V10_TARGET_REFERENCE.snapshotId);
    assert.equal(quarantine.target_cloud_version, 10);
    assert.equal(quarantine.counts.total, 3);
    assert.equal(quarantine.counts.unacknowledged, 2);
    assert.equal(quarantine.counts.acknowledged, 1);
    assert.equal(quarantine.events.length, 3);
    const eventMap = Object.fromEntries(quarantine.events.map(e => [e.event_id, e]));
    assert.ok(eventMap['evt_pending_1'], 'evt_pending_1 must be quarantined');
    assert.ok(eventMap['evt_pending_2'], 'evt_pending_2 must be quarantined');
    assert.ok(eventMap['evt_acked_3'], 'evt_acked_3 must be quarantined');

    // Assert original payloads are preserved and not silently lost
    assert.ok(eventMap['evt_pending_1'].payload.includes('150'));
    assert.ok(eventMap['evt_pending_2'].payload.includes('250'));
    assert.ok(eventMap['evt_acked_3'].payload.includes('350'));
  });

  await t.test('FIX A.2: State store lineage alignment aligns sequence counters, covered peer watermarks, and purges stale stores', async () => {
    // 1. Seed stale sync state belonging to an older baseline
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, last_allocated_sequence, last_uploaded_sequence, last_pushed_sequence, last_acked_sequence, lifecycle_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['device_state', 'dev_test_device', 'snap_stale_v8', 8, 42, 40, 40, 38, 'ACTIVE']
    );
    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id) VALUES (?, ?, ?, ?)',
      ['dev_obsolete_peer', 99, 99, 'snap_stale_v8']
    );
    await db.run(
      'INSERT OR REPLACE INTO sync_staged_events (event_id, package_id, device_id, sequence, status) VALUES (?, ?, ?, ?, ?)',
      ['staged_evt_1', 'pkg_stale', 'dev_obsolete_peer', 1, 'BLOCKED_OLDER_BASE']
    );
    await db.run(
      'INSERT OR REPLACE INTO sync_staged_packages (package_id, device_id, sequence_range, base_snapshot_id, status) VALUES (?, ?, ?, ?, ?)',
      ['pkg_stale', 'dev_obsolete_peer', '1-1', 'snap_stale_v8', 'STAGED']
    );
    await db.run(
      'INSERT OR REPLACE INTO sync_conflicts (conflict_id, package_id, entity_type, entity_id) VALUES (?, ?, ?, ?)',
      ['conflict_old_1', 'pkg_stale', 'transactions', 'txn_conf_1']
    );
    await db.run(
      'INSERT OR REPLACE INTO sync_tombstones (id, entity_type, entity_id, deleted_at) VALUES (?, ?, ?, ?)',
      ['tomb_old_1', 'transactions', 'txn_deleted_old', '2026-10-01T00:00:00Z']
    );

    // 2. Prepare valid fixture with covered_peer_watermarks
    const fixture = createSyntheticV10Fixture();
    const encrypted = await encryptBackupData(fixture, TEST_PIN);
    const mockDrive = new MockDriveTransport();
    mockDrive.files.set(V10_TARGET_REFERENCE.filename, {
      id: 'file_id_v10',
      name: V10_TARGET_REFERENCE.filename,
      version: 10,
      content: encrypted
    });

    // 3. Import snapshot
    await importSnapshotV10ToDevice({
      accessToken: TEST_TOKEN,
      pin: TEST_PIN,
      confirmation: 'CONFIRM_REPLACE_LOCAL_DATA',
      driveClient: mockDrive
    });

    // 4. Verify local sequence state preserves existing device sequences without unsafe regression
    const localStateRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
    const localState = localStateRes.values?.[0];
    assert.ok(localState, 'device_state must exist');
    assert.equal(localState.base_snapshot_id, V10_TARGET_REFERENCE.snapshotId);
    assert.equal(localState.base_cloud_version, 10);
    assert.equal(Number(localState.last_allocated_sequence), 42, 'Existing device sequence counter must be preserved monotonically');
    assert.equal(Number(localState.last_uploaded_sequence), 40);
    assert.equal(Number(localState.last_acked_sequence), 38);
    assert.equal(localState.lifecycle_state, 'ACTIVE');

    // 5. Verify covered peer watermarks are aligned with the snapshot's verified metadata
    const peerStateRows = (await db.query('SELECT * FROM sync_peer_state')).values || [];
    assert.equal(peerStateRows.length, 3, 'Must contain exactly the 3 peers covered by the snapshot');

    const peerMap = Object.fromEntries(peerStateRows.map(p => [p.peer_device_id, p]));
    assert.ok(peerMap['dev_6edc69e37943']);
    assert.equal(Number(peerMap['dev_6edc69e37943'].last_reconciled_sequence), 4);
    assert.equal(peerMap['dev_6edc69e37943'].base_snapshot_id, V10_TARGET_REFERENCE.snapshotId);

    assert.ok(peerMap['dev_b91065cd877f']);
    assert.equal(Number(peerMap['dev_b91065cd877f'].last_reconciled_sequence), 6);

    assert.ok(peerMap['dev_f31f6e6d6628']);
    assert.equal(Number(peerMap['dev_f31f6e6d6628'].last_reconciled_sequence), 12);

    // Stale peer must have been pruned
    assert.equal(peerMap['dev_obsolete_peer'], undefined, 'Obsolete peer from old baseline must be purged');

    // 6. Verify stale staging stores, conflicts, and tombstones are purged
    const stagedEvents = (await db.query('SELECT * FROM sync_staged_events')).values || [];
    assert.equal(stagedEvents.length, 0, 'sync_staged_events must be empty');
    const stagedPkgs = (await db.query('SELECT * FROM sync_staged_packages')).values || [];
    assert.equal(stagedPkgs.length, 0, 'sync_staged_packages must be empty');
    const conflicts = (await db.query('SELECT * FROM sync_conflicts')).values || [];
    assert.equal(conflicts.length, 0, 'sync_conflicts must be empty');
    const tombstones = (await db.query('SELECT * FROM sync_tombstones')).values || [];
    assert.equal(tombstones.length, 0, 'sync_tombstones must be reset');
  });

  await t.test('FIX B.1: Durable pre-backup is verified on disk before any mutations; fails closed if pre-backup verification fails', async () => {
    // 1. Populate valuable local records
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['precious_tx_1', '2026-10-01', 1000, 'Income']);
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['precious_acc_1', 'Savings', 'Bank Accounts']);

    const fixture = createSyntheticV10Fixture();
    const encrypted = await encryptBackupData(fixture, TEST_PIN);
    const mockDrive = new MockDriveTransport();
    mockDrive.files.set(V10_TARGET_REFERENCE.filename, {
      id: 'file_id_v10',
      name: V10_TARGET_REFERENCE.filename,
      version: 10,
      content: encrypted
    });

    // 2. Intercept setSetting to corrupt durable backup storage (simulate storage quota/truncation)
    const origSetSetting = setSetting;
    let corruptedOnce = false;

    // We can simulate failure by temporarily making db.run fail when writing pre_recovery_durable_backup
    const origRun = db.run.bind(db);
    db.run = async (sql, params) => {
      if (typeof sql === 'string' && params && params.includes('pre_recovery_durable_backup')) {
        throw new Error('QUOTA_EXCEEDED: Simulated disk full error during pre-backup creation');
      }
      return origRun(sql, params);
    };

    // 3. Attempt import
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
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.PRE_BACKUP_FAILED);
        assert(err.message.includes('pre-replacement backup'));
        return true;
      }
    );

    // 4. Verify FAIL-CLOSED: Not a single local record was deleted or touched!
    const entities = await readLocalEntities(db);
    assert.equal(entities.transactions.length, 1, 'Local transaction must remain completely intact');
    assert.equal(entities.transactions[0].id, 'precious_tx_1');
    assert.equal(entities.accounts.length, 1, 'Local account must remain completely intact');
  });

  await t.test('FIX B.2: Failure during partial population triggers durable rollback and restores all entities and queues', async () => {
    // 1. Seed device with 5 transactions, 2 accounts, and 1 pending delta
    for (let i = 1; i <= 5; i++) {
      await db.run('INSERT INTO transactions (id, date, inr, amount, type) VALUES (?, ?, ?, ?, ?)', [`local_txn_${i}`, '2026-10-10', 100 * i, String(100 * i), 'Expense']);
    }
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_hdfc', 'HDFC Bank', 'Bank Accounts']);
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_icici', 'ICICI Bank', 'Bank Accounts']);
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_unsynced_1', 'dev_local', 1, '2026-10-10T12:00:00Z', 'transactions', 'local_txn_1', 'UPDATE', JSON.stringify({ inr: 100 }), 'PENDING']
    );
    await setSetting('last_snapshot_id', 'snap_original_v8');
    await setSetting('sync_base_manifest', JSON.stringify({ local_txn_1: { fp: 'orig' } }));

    const fixture = createSyntheticV10Fixture();
    const encrypted = await encryptBackupData(fixture, TEST_PIN);
    const mockDrive = new MockDriveTransport();
    mockDrive.files.set(V10_TARGET_REFERENCE.filename, {
      id: 'file_id_v10',
      name: V10_TARGET_REFERENCE.filename,
      version: 10,
      content: encrypted
    });

    // 2. Simulate failure during population after transactions table deletion
    const origBatchReplace = db.batchReplace?.bind(db);
    let replaceAttempts = 0;
    db.batchReplace = async (store, items) => {
      replaceAttempts++;
      if (replaceAttempts === 1) {
        throw new Error('SIMULATED_OOM_CRASH: Process memory exceeded during batch transaction insertion');
      }
      return origBatchReplace ? origBatchReplace(store, items) : { replaced: items.length };
    };

    // 3. Attempt import
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
        assert(err.message.includes('rolled back cleanly'));
        return true;
      }
    );

    // 4. Assert durable rollback restored all 5 transactions, 2 accounts, and the queued delta
    const restored = await readLocalEntities(db);
    assert.equal(restored.transactions.length, 5, 'All 5 transactions must be restored');
    assert.equal(restored.accounts.length, 2, 'Both accounts must be restored');

    const restoredQueue = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(restoredQueue.length, 1, 'Queued delta must be restored');
    assert.equal(restoredQueue[0].event_id, 'evt_unsynced_1');

    const restoredSnap = await getSetting('last_snapshot_id');
    assert.equal(restoredSnap, 'snap_original_v8');

    // 5. verifyLocalRecoveryState confirms clean recovery
    const verifyState = await verifyLocalRecoveryState(db);
    assert.equal(verifyState.status, 'RECOVERED_MATCHES_BACKUP');
    assert.equal(verifyState.matchesBackup, true);
    assert.equal(verifyState.hasDurableBackup, true);
  });

  await t.test('FIX B.3: Post-import validation failure triggers rollback and restores original baseline', async () => {
    // 1. Seed local data
    await db.run('INSERT INTO transactions (id, date, amount, type) VALUES (?, ?, ?, ?)', ['tx_val_1', '2026-10-05', 200, 'Expense']);
    await setSetting('last_snapshot_id', 'snap_baseline_before_val_test');

    const fixture = createSyntheticV10Fixture();
    const encrypted = await encryptBackupData(fixture, TEST_PIN);
    const mockDrive = new MockDriveTransport();
    mockDrive.files.set(V10_TARGET_REFERENCE.filename, {
      id: 'file_id_v10',
      name: V10_TARGET_REFERENCE.filename,
      version: 10,
      content: encrypted
    });

    // 2. Corrupt one entity during population so post-import manifest assertion fails
    const origBatchReplace = db.batchReplace?.bind(db);
    db.batchReplace = async (store, items) => {
      if (store === 'transactions') {
        const tamperedItems = items.map(t => {
          if (t.id === 'txn_v10_000000') {
            return { ...t, note: 'TAMPERED_NOTE_CAUSING_CANONICAL_MISMATCH' };
          }
          return t;
        });
        return origBatchReplace ? origBatchReplace(store, tamperedItems) : { replaced: tamperedItems.length };
      }
      return origBatchReplace ? origBatchReplace(store, items) : { replaced: items.length };
    };

    // 3. Attempt import -> Should fail canonical manifest verification and roll back
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
        assert(err.message.includes('Canonical integrity mismatch') || err.message.includes('rolled back cleanly'));
        return true;
      }
    );

    // 4. Verify original transaction restored
    const restored = await readLocalEntities(db);
    assert.equal(restored.transactions.length, 1);
    assert.equal(restored.transactions[0].id, 'tx_val_1');
    assert.equal(await getSetting('last_snapshot_id'), 'snap_baseline_before_val_test');
  });

  await t.test('FIX B.4: Simulated browser restart / crash during destructive replacement is fully recoverable via restorePreImportBackup', async () => {
    // 1. Seed device with 10 transactions, 3 accounts, 2 inventory items, and 2 queued deltas
    for (let i = 1; i <= 10; i++) {
      await db.run('INSERT INTO transactions (id, date, inr, amount, type) VALUES (?, ?, ?, ?, ?)', [`crash_tx_${i}`, '2026-10-11', 50 * i, String(50 * i), 'Expense']);
    }
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_c1', 'Cash', 'Cash']);
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_c2', 'SBI', 'Bank Accounts']);
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_c3', 'HDFC', 'Bank Accounts']);
    await db.run('INSERT INTO inventory (id, name, qty, price) VALUES (?, ?, ?, ?)', ['inv_c1', 'Sugar', 5, 40]);
    await db.run('INSERT INTO inventory (id, name, qty, price) VALUES (?, ?, ?, ?)', ['inv_c2', 'Rice', 10, 60]);
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_crash_1', 'dev_local', 1, '2026-10-11T12:00:00Z', 'transactions', 'crash_tx_1', 'UPDATE', JSON.stringify({ inr: 50 }), 'PENDING']
    );
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_crash_2', 'dev_local', 2, '2026-10-11T12:05:00Z', 'inventory', 'inv_c1', 'UPDATE', JSON.stringify({ qty: 5 }), 'PENDING']
    );
    await setSetting('last_snapshot_id', 'snap_pre_crash_baseline_v9');
    await setSetting('sync_base_manifest', JSON.stringify({ crash_tx_1: { fp: 'crash' } }));

    // 2. Capture durable backup (simulating Gate 3 completion)
    const backupResult = await createDurablePreImportBackup(db);
    assert.ok(backupResult.backupId);
    assert.ok(backupResult.backupSha256);

    // 3. Now simulate process crash halfway through destructive replacement:
    // Operational tables wiped, memory discarded, DB connection closed
    await db.run('DELETE FROM transactions');
    await db.run('DELETE FROM accounts');
    await db.run('DELETE FROM inventory');
    await db.run('DELETE FROM sync_delta_queue');

    // Simulate process termination and cold restart:
    // Close DB connection, reset module references, open fresh connection
    closeDB();
    const freshDb = await initDB();

    // Verify operational stores are completely empty (corrupted state post-crash)
    const emptyCheck = await readLocalEntities(freshDb);
    assert.equal(emptyCheck.transactions.length, 0, 'Transactions were wiped by crash');
    assert.equal(emptyCheck.accounts.length, 0, 'Accounts were wiped by crash');

    // 4. Verify verifyLocalRecoveryState identifies durable backup is available on persistent disk
    const checkState = await verifyLocalRecoveryState(freshDb);
    assert.equal(checkState.hasDurableBackup, true);
    assert.equal(checkState.durableBackupId, backupResult.backupId);
    assert.equal(checkState.durableSha256, backupResult.backupSha256);
    assert.equal(checkState.status, 'COUNTS_DIFFER_FROM_BACKUP');

    // 5. Invoke standalone durable recovery
    const restoreResult = await restorePreImportBackup({ dbInstance: freshDb });
    assert.equal(restoreResult.success, true);
    assert.equal(restoreResult.restoredCounts.transactions, 10);
    assert.equal(restoreResult.restoredCounts.accounts, 3);
    assert.equal(restoreResult.restoredCounts.inventory, 2);

    // 6. Assert all 10 transactions, 3 accounts, 2 inventory, and 2 delta queue events are 100% recovered
    const recoveredEntities = await readLocalEntities(freshDb);
    assert.equal(recoveredEntities.transactions.length, 10);
    assert.equal(recoveredEntities.accounts.length, 3);
    assert.equal(recoveredEntities.inventory.length, 2);

    const recoveredQueue = (await freshDb.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(recoveredQueue.length, 2);
    assert.equal(recoveredQueue[0].event_id, 'evt_crash_1');
    assert.equal(recoveredQueue[1].event_id, 'evt_crash_2');

    const recoveredSnap = await getSetting('last_snapshot_id');
    assert.equal(recoveredSnap, 'snap_pre_crash_baseline_v9');

    // Post-recovery verification now confirms complete match
    const finalRecoveryState = await verifyLocalRecoveryState(freshDb);
    assert.equal(finalRecoveryState.status, 'RECOVERED_MATCHES_BACKUP');
    assert.equal(finalRecoveryState.matchesBackup, true);
  });
});
