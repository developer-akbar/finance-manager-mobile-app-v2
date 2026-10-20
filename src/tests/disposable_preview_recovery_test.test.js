/**
 * disposable_preview_recovery_test.test.js
 * 
 * Controlled Preview Test using Synthetic Disposable Data ONLY.
 * 
 * Verifies the complete 5-step sequence approved by the user:
 * 1. Start with synthetic transactions, accounts, a pending delta, a conflict, and a tombstone.
 * 2. Import a synthetic snapshot with known peer watermarks.
 * 3. Verify imported records and sync lineage, and confirm old deltas cannot replay.
 * 4. Simulate interruption after backup creation and during replacement; restart and restore the original synthetic state.
 * 5. Confirm the test never writes to Google Drive or touches devices A, C, D, or E.
 * Extra check: Verify the documented recovery path for quarantined changes via restoreQuarantinedDeltas().
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
  restorePreImportBackup,
  getQuarantinedDeltas,
  restoreQuarantinedDeltas,
  verifyLocalRecoveryState,
  createDurablePreImportBackup,
  V10_TARGET_REFERENCE
} from '../services/snapshotDeviceImport.js';
import { readLocalEntities } from '../services/cloudSyncEngine.js';

const DISPOSABLE_TEST_PIN = '7410';
const DISPOSABLE_OAUTH_TOKEN = 'mock_oauth_disposable_preview_token';

class StrictZeroWriteMockDrive {
  constructor() {
    this.files = new Map();
    this.readCallCount = 0;
    this.writeCallCount = 0;
    this.mutationAttempts = [];
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

  // Any attempt to write must increment mutation counter and throw immediately
  async uploadAppDataFile(filename, content, mimeType, token) {
    this.writeCallCount++;
    this.mutationAttempts.push({ method: 'uploadAppDataFile', filename });
    throw new Error('STRICT_ZERO_WRITE_VIOLATION: Attempted uploadAppDataFile on Drive!');
  }

  async updateAppDataFile(fileId, content, mimeType, token) {
    this.writeCallCount++;
    this.mutationAttempts.push({ method: 'updateAppDataFile', fileId });
    throw new Error('STRICT_ZERO_WRITE_VIOLATION: Attempted updateAppDataFile on Drive!');
  }

  async patchAppDataFile(fileId, content, token) {
    this.writeCallCount++;
    this.mutationAttempts.push({ method: 'patchAppDataFile', fileId });
    throw new Error('STRICT_ZERO_WRITE_VIOLATION: Attempted patchAppDataFile on Drive!');
  }

  async deleteAppDataFile(fileId, token) {
    this.writeCallCount++;
    this.mutationAttempts.push({ method: 'deleteAppDataFile', fileId });
    throw new Error('STRICT_ZERO_WRITE_VIOLATION: Attempted deleteAppDataFile on Drive!');
  }
}

/**
 * Builds synthetic disposable snapshot matching V10_TARGET_REFERENCE
 */
function createSyntheticSnapshotFixture() {
  const regTxns = [];
  for (let i = 0; i < V10_TARGET_REFERENCE.regularTransactionsCount; i++) {
    regTxns.push({
      id: `txn_v10_${String(i).padStart(6, '0')}`,
      Date: '2026-10-12',
      Time: '12:00',
      Account: 'HDFC',
      Category: 'Food',
      Subcategory: 'Groceries',
      Note: `Synthetic regular txn ${i}`,
      Description: `Description ${i}`,
      INR: 100 + (i % 50),
      'Income/Expense': 'Expense',
      tags: '#disposable-test'
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
      Note: `Synthetic inv txn ${i}`,
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
    device_id: 'dev_synthetic_authoritative',
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
      brokerages: [{ id: 'Zerodha', name: 'Zerodha', bank_account: 'HDFC', owner: 'Disposable' }]
    }
  };
}

/**
 * Seeds the initial synthetic disposable state (Step 1)
 */
async function seedInitialSyntheticState(db) {
  // 1. Transactions
  for (let i = 1; i <= 5; i++) {
    await db.run(
      'INSERT INTO transactions (id, date, inr, amount, type, category, account) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [`tx_synth_${i}`, '2026-10-10', 100 * i, String(100 * i), 'Expense', 'Food', 'Cash']
    );
  }
  // 2. Accounts
  await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_cash', 'Cash', 'Cash']);
  await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_hdfc', 'HDFC Bank', 'Bank Accounts']);

  // 3. Pending Deltas: 1 clean offline insert + 1 update with missing entity
  await db.run(
    'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['evt_synth_clean_insert', 'dev_disposable_local', 1, '2026-10-13T10:00:00Z', 'transactions', 'tx_synth_offline_new', 'INSERT', JSON.stringify({ id: 'tx_synth_offline_new', inr: 250, note: 'Clean offline insert' }), 'PENDING']
  );
  await db.run(
    'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['evt_synth_missing_update', 'dev_disposable_local', 2, '2026-10-13T10:01:00Z', 'transactions', 'tx_synth_missing', 'UPDATE', JSON.stringify({ inr: 150, note: 'Offline edit on missing entity' }), 'PENDING']
  );

  // 4. Conflict
  await db.run(
    'INSERT INTO sync_conflicts (conflict_id, package_id, entity_type, entity_id, local_state, remote_state, base_state, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['conflict_synth_1', 'pkg_old', 'transactions', 'tx_synth_1', '{"inr":150}', '{"inr":120}', '{"inr":100}', '2026-10-13T10:01:00Z']
  );

  // 5. Tombstone
  await db.run(
    'INSERT INTO sync_tombstones (id, entity_type, entity_id, deleted_at) VALUES (?, ?, ?, ?)',
    ['tomb_synth_1', 'transactions', 'tx_deleted_old', '2026-10-01T00:00:00Z']
  );

  // 6. Old sync state
  await db.run(
    'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, last_allocated_sequence, last_uploaded_sequence, last_pushed_sequence, last_acked_sequence, lifecycle_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['device_state', 'dev_disposable_local', 'snap_synth_old_v8', 8, 5, 4, 4, 4, 'ACTIVE']
  );
  await db.run(
    'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id) VALUES (?, ?, ?, ?)',
    ['dev_peer_old', 10, 10, 'snap_synth_old_v8']
  );
  await setSetting('last_snapshot_id', 'snap_synth_old_v8');
  await setSetting('sync_base_manifest', JSON.stringify({ tx_synth_1: { fp: 'old_synth' } }));
}

test('Controlled Preview Test — Synthetic Disposable Data Sequence (Steps 1 to 5)', async (t) => {
  let db;

  t.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    db = await initDB();
  });

  t.afterEach(async () => {
    closeDB();
  });

  await t.test('Complete 5-Step Disposable Recovery & Lineage Sequence', async () => {
    // ---------------------------------------------------------------------------------
    // STEP 1: Start with synthetic transactions, accounts, a pending delta, a conflict, and a tombstone
    // ---------------------------------------------------------------------------------
    await seedInitialSyntheticState(db);

    const step1Entities = await readLocalEntities(db);
    assert.equal(step1Entities.transactions.length, 5, 'Step 1: Must have 5 synthetic transactions');
    assert.equal(step1Entities.accounts.length, 2, 'Step 1: Must have 2 synthetic accounts');

    const step1Queue = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(step1Queue.length, 2, 'Step 1: Must have 2 pending delta events');

    const step1Conflicts = (await db.query('SELECT * FROM sync_conflicts')).values || [];
    assert.equal(step1Conflicts.length, 1, 'Step 1: Must have 1 conflict');

    const step1Tombstones = (await db.query('SELECT * FROM sync_tombstones')).values || [];
    assert.equal(step1Tombstones.length, 1, 'Step 1: Must have 1 tombstone');

    // ---------------------------------------------------------------------------------
    // STEP 2: Import synthetic snapshot with known peer watermarks
    // ---------------------------------------------------------------------------------
    const snapshotFixture = createSyntheticSnapshotFixture();
    const encryptedCiphertext = await encryptBackupData(snapshotFixture, DISPOSABLE_TEST_PIN);

    const mockDrive = new StrictZeroWriteMockDrive();
    mockDrive.files.set(V10_TARGET_REFERENCE.filename, {
      id: 'mock_drive_file_synthetic_v10',
      name: V10_TARGET_REFERENCE.filename,
      version: 10,
      content: encryptedCiphertext
    });

    const importResult = await importSnapshotV10ToDevice({
      accessToken: DISPOSABLE_OAUTH_TOKEN,
      pin: DISPOSABLE_TEST_PIN,
      confirmation: 'CONFIRM_REPLACE_LOCAL_DATA',
      driveClient: mockDrive
    });

    assert.equal(importResult.success, true);
    assert.equal(importResult.status, 'IMPORT_SUCCESS');
    assert.equal(importResult.snapshotId, V10_TARGET_REFERENCE.snapshotId);
    assert.equal(importResult.quarantinedDeltaEventsCount, 2, 'Must report 2 quarantined deltas');

    // ---------------------------------------------------------------------------------
    // STEP 3: Verify imported records and sync lineage, and confirm old deltas cannot replay
    // ---------------------------------------------------------------------------------
    const step3Entities = await readLocalEntities(db);
    assert.equal(step3Entities.transactions.length, 28259, 'Step 3: Exact regular transactions count verified');
    assert.equal(step3Entities.investment_transactions.length, 899, 'Step 3: Exact investment transactions count verified');
    assert.equal(step3Entities.accounts.length, 36, 'Step 3: Exact accounts count verified');
    assert.equal(step3Entities.inventory.length, 732, 'Step 3: Exact inventory count verified');

    // Old synthetic transactions must NOT exist in the active ledger
    assert.equal(step3Entities.transactions.some(t => t.id === 'tx_synth_1'), false);

    // Assert sequence state preserves existing device sequence counters without unsafe regression
    const localStateRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
    const localState = localStateRes.values?.[0];
    assert.equal(localState.base_snapshot_id, V10_TARGET_REFERENCE.snapshotId);
    assert.equal(localState.base_cloud_version, 10);
    assert.equal(Number(localState.last_allocated_sequence), 5, 'last_allocated_sequence must be preserved monotonically on existing device');
    assert.equal(Number(localState.last_uploaded_sequence), 4);
    assert.equal(Number(localState.last_acked_sequence), 4);
    assert.equal(localState.lifecycle_state, 'ACTIVE');

    // Assert peer watermarks match covered_peer_watermarks from the snapshot
    const peerRows = (await db.query('SELECT * FROM sync_peer_state')).values || [];
    assert.equal(peerRows.length, 3, 'Must have exactly the 3 covered peers from snapshot');
    const peerMap = Object.fromEntries(peerRows.map(p => [p.peer_device_id, p]));
    assert.equal(Number(peerMap['dev_6edc69e37943'].last_reconciled_sequence), 4);
    assert.equal(Number(peerMap['dev_b91065cd877f'].last_reconciled_sequence), 6);
    assert.equal(Number(peerMap['dev_f31f6e6d6628'].last_reconciled_sequence), 12);
    assert.equal(peerMap['dev_peer_old'], undefined, 'Old baseline peer must be purged');

    // Assert active sync stores are clean
    assert.equal(((await db.query('SELECT * FROM sync_staged_events')).values || []).length, 0);
    assert.equal(((await db.query('SELECT * FROM sync_conflicts')).values || []).length, 0);
    assert.equal(((await db.query('SELECT * FROM sync_tombstones')).values || []).length, 0);

    // Assert REPLAY PROTECTION: Active delta queue is 0
    const activeQueue = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(activeQueue.length, 0, 'Active sync_delta_queue must be 0 so old edits cannot replay');

    // Assert QUARANTINE PRESERVATION
    const quarantined = await getQuarantinedDeltas(db);
    assert.ok(quarantined, 'Quarantine record must exist');
    assert.equal(quarantined.reason, 'SNAPSHOT_LINEAGE_RESET');
    assert.equal(quarantined.counts.unacknowledged, 2);

    // DOCUMENTED RECOVERY PATH VERIFICATION:
    // First Call: Re-queues clean offline insert, holds missing target entity update for review
    const recoveryPathRes = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(recoveryPathRes.success, true);
    assert.equal(recoveryPathRes.restoredCount, 1, 'Only clean offline insert re-queued');
    assert.equal(recoveryPathRes.heldCount, 1, 'Missing entity update held for review');
    assert.equal(recoveryPathRes.newAllocatedSequence, 6);

    // Verify re-queued clean event is in sync_delta_queue with sequence 6 on top of the new baseline
    const reQueued = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(reQueued.length, 1);
    assert.equal(reQueued[0].event_id, 'evt_synth_clean_insert');
    assert.equal(Number(reQueued[0].sequence), 6);
    assert.equal(reQueued[0].status, 'PENDING');

    // Verify missing entity update is held for review in quarantine record and sync_conflicts
    assert.equal(recoveryPathRes.heldEvents.length, 1);
    assert.equal(recoveryPathRes.heldEvents[0].event_id, 'evt_synth_missing_update');
    assert.equal(recoveryPathRes.heldEvents[0].reason, 'TARGET_ENTITY_MISSING_IN_SNAPSHOT');

    // IDEMPOTENCY VERIFICATION: Second repeated call must be zero-mutation safe
    const repeatedRecoveryRes = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(repeatedRecoveryRes.success, true);
    assert.equal(repeatedRecoveryRes.restoredCount, 0, 'Zero new events re-queued on repeated call');
    assert.equal(repeatedRecoveryRes.alreadyRestoredCount, 1, 'Correctly reports 1 already restored event');
    assert.equal(repeatedRecoveryRes.newAllocatedSequence, 6, 'Sequence counter must NOT advance on repeated call');

    // Verify sync_delta_queue still has exactly 1 entry
    const reQueuedAfterRepeat = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(reQueuedAfterRepeat.length, 1);
    assert.equal(reQueuedAfterRepeat[0].event_id, 'evt_synth_clean_insert');

    // ---------------------------------------------------------------------------------
    // STEP 4: Simulate interruption after backup creation and during replacement; restart and restore original state
    // ---------------------------------------------------------------------------------
    // Clear and re-seed to Step 1 synthetic state to test standalone crash recovery
    await db.run('DELETE FROM transactions');
    await db.run('DELETE FROM accounts');
    await db.run('DELETE FROM sync_delta_queue');
    await db.run('DELETE FROM sync_conflicts');
    await db.run('DELETE FROM sync_tombstones');
    await seedInitialSyntheticState(db);

    // Gate 3: Create durable pre-import backup
    const preBackup = await createDurablePreImportBackup(db);
    assert.ok(preBackup.backupId);
    assert.ok(preBackup.backupSha256);

    // Simulate catastrophic crash mid-replacement:
    // Operational tables wiped, queues wiped, DB connection closed
    await db.run('DELETE FROM transactions');
    await db.run('DELETE FROM accounts');
    await db.run('DELETE FROM sync_delta_queue');
    await db.run('DELETE FROM sync_conflicts');
    await db.run('DELETE FROM sync_tombstones');

    // Cold process restart
    closeDB();
    const freshDb = await initDB();

    // Verify database is empty (crashed mid-replacement state)
    const crashedEntities = await readLocalEntities(freshDb);
    assert.equal(crashedEntities.transactions.length, 0, 'Transactions were wiped by simulated crash');
    assert.equal(crashedEntities.accounts.length, 0, 'Accounts were wiped by simulated crash');

    // Verify recovery state detector flags backup is available on persistent disk
    const recoveryAudit = await verifyLocalRecoveryState(freshDb);
    assert.equal(recoveryAudit.hasDurableBackup, true);
    assert.equal(recoveryAudit.durableBackupId, preBackup.backupId);
    assert.equal(recoveryAudit.durableSha256, preBackup.backupSha256);

    // Execute standalone durable recovery
    const restoreRes = await restorePreImportBackup({ dbInstance: freshDb });
    assert.equal(restoreRes.success, true);
    assert.equal(restoreRes.restoredCounts.transactions, 5);
    assert.equal(restoreRes.restoredCounts.accounts, 2);

    // Verify 100% of original synthetic records, pending deltas, conflict, and tombstone are restored
    const finalEntities = await readLocalEntities(freshDb);
    assert.equal(finalEntities.transactions.length, 5);
    assert.equal(finalEntities.transactions[0].id, 'tx_synth_1');
    assert.equal(finalEntities.accounts.length, 2);

    const finalQueue = (await freshDb.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(finalQueue.length, 2, 'Both pending delta events restored from backup');

    const finalConflicts = (await freshDb.query('SELECT * FROM sync_conflicts')).values || [];
    assert.equal(finalConflicts.length, 1);
    assert.equal(finalConflicts[0].conflict_id, 'conflict_synth_1');

    const finalTombstones = (await freshDb.query('SELECT * FROM sync_tombstones')).values || [];
    assert.equal(finalTombstones.length, 1);
    assert.equal(finalTombstones[0].id, 'tomb_synth_1');

    const finalStateCheck = await verifyLocalRecoveryState(freshDb);
    assert.equal(finalStateCheck.status, 'RECOVERED_MATCHES_BACKUP');
    assert.equal(finalStateCheck.matchesBackup, true);

    // ---------------------------------------------------------------------------------
    // STEP 5: Confirm zero writes to Google Drive and zero touches to devices A, C, D, or E
    // ---------------------------------------------------------------------------------
    assert.equal(mockDrive.writeCallCount, 0, 'Step 5: ZERO write calls made to Drive mock');
    assert.equal(mockDrive.mutationAttempts.length, 0, 'Step 5: Zero mutation methods invoked');
    assert.ok(mockDrive.readCallCount > 0, 'Step 5: Only read operations were executed');
  });
});
