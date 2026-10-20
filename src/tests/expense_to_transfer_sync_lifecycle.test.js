/**
 * expense_to_transfer_sync_lifecycle.test.js
 * 
 * Offline regression test suite for the Expense-to-Transfer synchronization lifecycle.
 * Exercises isolated Device A and Device D databases with a mocked Drive transport.
 * 
 * Verifies:
 * 1. Happy path: Expense transaction updated to Transfer-Out on Device D is pushed,
 *    discovered, staged, and reconciled cleanly on Device A. All transfer fields
 *    survive, exactly 1 update is reconciled, 0 duplicates, 0 conflicts.
 * 2. Negative test: Locked session on Device A rejects sync (AUTH_REQUIRED) without staging.
 * 3. Negative test: Mismatched snapshot baseline causes peer delta package to be skipped.
 * 4. Negative test: Divergent local checksum creates CONCURRENT_EDIT conflict and preserves local DB.
 * 5. UI refresh notification: In-window subscribeSyncStatus receives SYNC_STATUS.SUCCESS with reconciledCount.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { v4 as uuid } from 'uuid';

import { initDB, closeDB, getDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import { initLocalSyncState, DELTA_STATUS, DELTA_OPERATION } from '../database/deltaQueue.js';
import { executeAtomicMutation } from '../database/atomicMutation.js';
import { getTransactions, updateTransaction, rowToTxn } from '../database/transactions.js';
import { replaceAccounts } from '../database/accounts.js';
import { replaceCategories } from '../database/categories.js';
import { txnType } from '../utils/format.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import {
  executeFullSyncPass,
  configureDeltaSyncEngine,
  subscribeSyncStatus,
  SYNC_STATUS
} from '../services/deltaSyncCoordinator.js';
import { getPendingConflicts, CONFLICT_TYPE, CONFLICT_STATUS } from '../database/conflicts.js';
import { getDeviceManifestFilename } from '../services/deviceManifest.js';

const TEST_SESSION_KEY = 'test-secret-encryption-key-exp-to-trans';
const TEST_BASE_SNAPSHOT_ID = 'snap_baseline_exp_to_trans_test';

/**
 * In-memory Mock Google Drive Client
 */
class MockDriveStorage {
  constructor() {
    this.files = new Map();
    this.nextId = 1;
  }

  reset() {
    this.files.clear();
    this.nextId = 1;
  }

  async findFiles({ name, trashed = false } = {}) {
    const results = [];
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && (!name || f.name === name)) {
        results.push({ id: f.id, name: f.name, appProperties: f.appProperties });
      }
    }
    return results;
  }

  async findAppDataFile(name, token) {
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        return { id: f.id, name: f.name };
      }
    }
    return null;
  }

  async readFile(fileId) {
    const f = this.files.get(fileId);
    if (!f || f.trashed) throw new Error(`Drive file not found: ${fileId}`);
    return f.content;
  }

  async readAppDataFile(fileId, token) {
    return this.readFile(fileId);
  }

  async uploadFile({ name, content, appProperties = {} }) {
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        f.content = content;
        f.appProperties = { ...f.appProperties, ...appProperties };
        return { id: f.id, name: f.name };
      }
    }
    const id = `mock_drive_${this.nextId++}`;
    this.files.set(id, {
      id,
      name,
      content,
      appProperties: { ...appProperties },
      trashed: false
    });
    return { id, name };
  }

  async uploadAppDataFile(name, content, mimeType, token) {
    return this.uploadFile({ name, content });
  }

  async updateFile(fileId, content) {
    const f = this.files.get(fileId);
    if (!f || f.trashed) throw new Error(`Drive file not found: ${fileId}`);
    f.content = content;
    return { id: f.id, name: f.name };
  }
}

/**
 * Creates an isolated in-memory device harness with its own IndexedDB and localStorage
 */
function createDeviceHarness(deviceId, baseSnapshotId = TEST_BASE_SNAPSHOT_ID) {
  return {
    deviceId,
    baseSnapshotId,
    idb: new IDBFactory(),
    storage: {}
  };
}

/**
 * Activates a device harness by binding its IndexedDB and localStorage mocks
 */
async function activateDevice(harness) {
  await closeDB();
  globalThis.indexedDB = harness.idb;
  global.localStorage = {
    getItem: (k) => harness.storage[k] || null,
    setItem: (k, v) => { harness.storage[k] = String(v); },
    removeItem: (k) => { delete harness.storage[k]; },
    clear: () => { Object.keys(harness.storage).forEach(k => delete harness.storage[k]); }
  };
  const db = await initDB();
  return db;
}

/**
 * Seeds a device with standard accounts, categories, sync state, and an initial Expense transaction
 */
async function seedInitialDeviceState(harness, initialTxn) {
  const db = await activateDevice(harness);

  // Initialize sync state as ACTIVE with the given baseline snapshot ID
  await initLocalSyncState(harness.deviceId, harness.baseSnapshotId, 1, 'ACTIVE');
  await setSetting('last_snapshot_id', harness.baseSnapshotId, { suppressDeltaQueue: true });
  await setSetting('last_parent_snapshot_id', '', { suppressDeltaQueue: true });

  // Seed baseline accounts without delta queue emission
  await replaceAccounts([
    { id: 'acc_bank', name: 'Bank Account', group: 'Bank Accounts' },
    { id: 'acc_wallet', name: 'Wallet', group: 'Cash' }
  ], { suppressDeltaQueue: true });

  // Seed baseline categories without delta queue emission
  await replaceCategories([
    { id: 'cat_dining', name: 'Food & Dining', type: 'Expense' },
    { id: 'cat_transfer', name: 'Transfer', type: 'Transfer' }
  ], { suppressDeltaQueue: true });

  // Seed baseline initial transaction without delta queue emission
  await executeAtomicMutation({
    storeName: 'transactions',
    operation: 'INSERT',
    entity: initialTxn,
    suppressDeltaQueue: true
  });

  return db;
}

/**
 * Helper to fetch a transaction by ID from the current active database
 */
async function getTxnById(id) {
  const txns = await getTransactions();
  return txns.find(t => t.id === id || t._id === id || t.ID === id) || null;
}

const SEED_TXN = {
  id: 'tx_exp_to_trans_01',
  date: '2026-03-01',
  time: '14:30',
  account: 'Bank Account',
  from_account: '',
  to_account: '',
  category: 'Food & Dining',
  subcategory: 'Groceries',
  note: 'Grocery store expense',
  description: 'Weekly grocery run',
  inr: 750,
  amount: '750',
  currency: 'INR',
  type: 'Expense',
  sub_account: 'Checking',
  from_sub_account: '',
  to_sub_account: '',
  created_at: '2026-03-01T14:30:00.000Z',
  updated_at: '2026-03-01T14:30:00.000Z'
};

test('FinMan — Expense-to-Transfer Synchronization Lifecycle Regression Suite', async (t) => {
  const mockDrive = new MockDriveStorage();

  t.beforeEach(() => {
    mockDrive.reset();
    // Disable automatic scheduler timer loops during tests
    configureDeltaSyncEngine({ enabled: false });
  });

  t.after(async () => {
    await closeDB();
  });

  await t.test('1. Happy path: D updates Expense to Transfer-Out, pushes delta, A pulls and reconciles with full field fidelity', async () => {
    const devD = createDeviceHarness('dev_d');
    const devA = createDeviceHarness('dev_a');

    // 1. Seed identical initial Expense on both Device D and Device A
    await seedInitialDeviceState(devD, { ...SEED_TXN });
    await seedInitialDeviceState(devA, { ...SEED_TXN });

    // Verify initial state on Device D
    await activateDevice(devD);
    const dTxnBefore = await getTxnById(SEED_TXN.id);
    assert.ok(dTxnBefore, 'Device D has initial transaction');
    assert.strictEqual(dTxnBefore['Income/Expense'], 'Expense');
    assert.strictEqual(txnType(dTxnBefore), 'expense');

    // 2. Change transaction on D to Transfer-Out with all transfer fields
    const updatedTransferData = {
      'Income/Expense': 'Transfer-Out',
      Category: 'Transfer',
      Subcategory: '',
      Account: 'Bank Account',
      FromAccount: 'Bank Account',
      ToAccount: 'Wallet',
      SubAccount: 'Checking',
      FromSubAccount: 'Checking',
      ToSubAccount: 'Cash Pocket',
      Note: 'ATM withdrawal to cash pocket',
      Description: 'Bank to Wallet transfer',
      INR: 750,
      Amount: '750',
      Currency: 'INR'
    };

    await updateTransaction(SEED_TXN.id, updatedTransferData);

    // Verify D's local store immediately reflects Transfer-Out
    const dTxnAfter = await getTxnById(SEED_TXN.id);
    assert.ok(dTxnAfter, 'Device D has updated transaction');
    assert.strictEqual(dTxnAfter['Income/Expense'], 'Transfer-Out');
    assert.strictEqual(txnType(dTxnAfter), 'transfer');
    assert.strictEqual(dTxnAfter.Category, 'Transfer');
    assert.strictEqual(dTxnAfter.FromAccount, 'Bank Account');
    assert.strictEqual(dTxnAfter.ToAccount, 'Wallet');
    assert.strictEqual(dTxnAfter.FromSubAccount, 'Checking');
    assert.strictEqual(dTxnAfter.ToSubAccount, 'Cash Pocket');

    // Verify D's delta queue recorded exactly 1 UPDATE event
    const devDDb = getDB();
    const queueRows = (await devDDb.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.strictEqual(queueRows.length, 1, 'Exactly 1 delta event queued on D');
    assert.strictEqual(queueRows[0].operation, 'UPDATE');
    assert.strictEqual(queueRows[0].collection, 'transactions');
    assert.strictEqual(queueRows[0].entity_id, SEED_TXN.id);

    const queuedPayload = typeof queueRows[0].payload === 'string'
      ? JSON.parse(queueRows[0].payload)
      : queueRows[0].payload;
    assert.strictEqual(queuedPayload.type, 'Transfer-Out');
    assert.strictEqual(queuedPayload.from_account, 'Bank Account');
    assert.strictEqual(queuedPayload.to_account, 'Wallet');
    assert.strictEqual(queuedPayload.from_sub_account, 'Checking');
    assert.strictEqual(queuedPayload.to_sub_account, 'Cash Pocket');

    // 3. Upload D's delta through mocked Drive transport
    const pushResult = await executeFullSyncPass({
      deviceId: 'dev_d',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.strictEqual(pushResult.success, true, 'Device D push succeeded');
    assert.strictEqual(pushResult.outbound.packagesUploaded, 1, '1 package uploaded by D');
    assert.strictEqual(pushResult.outbound.eventsUploaded, 1, '1 event uploaded by D');

    // Verify mocked Drive contains D's manifest and encrypted package
    const expectedManifestName = getDeviceManifestFilename('dev_d');
    const manifestFile = await mockDrive.findFiles({ name: expectedManifestName });
    assert.strictEqual(manifestFile.length, 1, 'Manifest uploaded to Drive');

    // 4. On Device A: Verify before-sync state is Expense
    await activateDevice(devA);
    const devADb = getDB();
    const aTxnBefore = await getTxnById(SEED_TXN.id);
    assert.ok(aTxnBefore, 'Device A has initial transaction');
    assert.strictEqual(aTxnBefore['Income/Expense'], 'Expense', 'A is Expense before sync');
    assert.strictEqual(txnType(aTxnBefore), 'expense');

    // Subscribe to sync status to verify UI refresh notification
    let uiNotificationReceived = false;
    let uiNotificationDetails = null;
    const unsubscribeSync = subscribeSyncStatus((status, details) => {
      if (status === SYNC_STATUS.SUCCESS) {
        uiNotificationReceived = true;
        uiNotificationDetails = details;
      }
    });

    // 5. Device A discovers, stages, and reconciles D's delta package
    const pullResult = await executeFullSyncPass({
      deviceId: 'dev_a',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    unsubscribeSync();

    // 6. Assert sync pass results
    assert.strictEqual(pullResult.success, true, 'Device A sync pass succeeded');
    assert.strictEqual(pullResult.inbound.stagedPackagesCount, 1, '1 package staged on A');
    assert.strictEqual(pullResult.inbound.stagedEventsCount, 1, '1 event staged on A');
    assert.strictEqual(pullResult.reconciliation.reconciledCount, 1, 'Exactly 1 update reconciled');
    assert.strictEqual(pullResult.reconciliation.conflictCount, 0, 'Zero conflicts');
    assert.strictEqual(pullResult.reconciliation.idempotentCount, 0, 'Zero idempotent skips');

    // 7. Assert Device A database has Transfer-Out and all fields survived
    const allTxnsOnA = (await devADb.query('SELECT * FROM transactions')).values || [];
    assert.strictEqual(allTxnsOnA.length, 1, 'Zero duplicates: exactly 1 transaction in DB');

    const aTxnAfter = await getTxnById(SEED_TXN.id);
    assert.ok(aTxnAfter, 'Device A has updated transaction');
    assert.strictEqual(aTxnAfter['Income/Expense'], 'Transfer-Out', 'Type updated to Transfer-Out');
    assert.strictEqual(txnType(aTxnAfter), 'transfer', 'txnType helper classifies as transfer');
    assert.strictEqual(aTxnAfter.Category, 'Transfer', 'Category is Transfer');
    assert.strictEqual(aTxnAfter.FromAccount, 'Bank Account', 'FromAccount preserved');
    assert.strictEqual(aTxnAfter.ToAccount, 'Wallet', 'ToAccount preserved');
    assert.strictEqual(aTxnAfter.FromSubAccount, 'Checking', 'FromSubAccount preserved');
    assert.strictEqual(aTxnAfter.ToSubAccount, 'Cash Pocket', 'ToSubAccount preserved');
    assert.strictEqual(aTxnAfter.Note, 'ATM withdrawal to cash pocket', 'Note preserved');
    assert.strictEqual(aTxnAfter.Description, 'Bank to Wallet transfer', 'Description preserved');
    assert.strictEqual(aTxnAfter.INR, 750, 'INR amount preserved');

    // 8. Assert zero conflicts in conflicts store
    const conflictsOnA = await getPendingConflicts();
    assert.strictEqual(conflictsOnA.length, 0, 'Zero pending conflicts on Device A');

    // 9. Assert active UI received refresh notification
    assert.strictEqual(uiNotificationReceived, true, 'Active UI received SUCCESS notification');
    assert.strictEqual(uiNotificationDetails?.reconciliation?.reconciledCount, 1, 'Notification reports 1 reconciled change');
  });

  await t.test('2. Negative test: Locked session on Device A rejects sync without downloading or staging', async () => {
    const devD = createDeviceHarness('dev_d');
    const devA = createDeviceHarness('dev_a');

    await seedInitialDeviceState(devD, { ...SEED_TXN });
    await seedInitialDeviceState(devA, { ...SEED_TXN });

    // Device D changes to Transfer-Out and uploads delta
    await activateDevice(devD);
    await updateTransaction(SEED_TXN.id, {
      'Income/Expense': 'Transfer-Out',
      Category: 'Transfer',
      FromAccount: 'Bank Account',
      ToAccount: 'Wallet',
      FromSubAccount: 'Checking',
      ToSubAccount: 'Cash Pocket'
    });
    await executeFullSyncPass({
      deviceId: 'dev_d',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    // Device A attempts sync pass with sessionKey: null (locked session)
    await activateDevice(devA);
    const syncResult = await executeFullSyncPass({
      deviceId: 'dev_a',
      driveClient: mockDrive,
      sessionKey: null
    });

    // Assert expected auth error
    assert.strictEqual(syncResult.success, false, 'Sync failed as expected');
    assert.strictEqual(syncResult.status, SYNC_STATUS.AUTH_REQUIRED, 'Status is AUTH_REQUIRED');
    assert.strictEqual(syncResult.reason, 'Sync session is locked', 'Expected reason message');

    // Assert Device A remains on Expense and no packages are staged
    const devADb = getDB();
    const aTxn = await getTxnById(SEED_TXN.id);
    assert.ok(aTxn, 'Device A has transaction');
    assert.strictEqual(aTxn['Income/Expense'], 'Expense', 'A remains Expense');

    const stagedPkgs = (await devADb.query('SELECT * FROM sync_staged_packages')).values || [];
    assert.strictEqual(stagedPkgs.length, 0, 'Zero packages staged on locked device');
  });

  await t.test('3. Negative test: Mismatched snapshot baseline causes peer delta package to be skipped', async () => {
    const devD = createDeviceHarness('dev_d', 'snap_baseline_different_repo');
    const devA = createDeviceHarness('dev_a', 'snap_baseline_standard_repo');

    await seedInitialDeviceState(devD, { ...SEED_TXN });
    await seedInitialDeviceState(devA, { ...SEED_TXN });

    // Device D changes to Transfer-Out and uploads on its baseline
    await activateDevice(devD);
    await updateTransaction(SEED_TXN.id, {
      'Income/Expense': 'Transfer-Out',
      Category: 'Transfer',
      FromAccount: 'Bank Account',
      ToAccount: 'Wallet'
    });
    await executeFullSyncPass({
      deviceId: 'dev_d',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    // Device A syncs on its own baseline
    await activateDevice(devA);
    const syncResult = await executeFullSyncPass({
      deviceId: 'dev_a',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    // Device A reports BLOCKED_PEER_BASELINE rather than falsely succeeding
    assert.strictEqual(syncResult.success, false, 'Sync must NOT report success when peer baseline is incompatible');
    assert.strictEqual(syncResult.status, 'BLOCKED_PEER_BASELINE');
    assert.ok(syncResult.blockedPeers && syncResult.blockedPeers.length > 0, 'Incompatible peer must be recorded in blockedPeers');
    assert.strictEqual(syncResult.inbound.stagedPackagesCount, 0, 'Zero packages staged due to baseline mismatch');
    assert.strictEqual(syncResult.reconciliation.reconciledCount, 0, 'Zero events reconciled');

    // Device A transaction remains unchanged as Expense
    const aTxn = await getTxnById(SEED_TXN.id);
    assert.ok(aTxn, 'Device A has transaction');
    assert.strictEqual(aTxn['Income/Expense'], 'Expense', 'Transaction on A remains Expense');

    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 0, 'Zero conflicts logged for clean skip');
  });

  await t.test('4. Negative test: Divergent local checksum generates CONCURRENT_EDIT conflict and preserves local DB', async () => {
    const devD = createDeviceHarness('dev_d');
    const devA = createDeviceHarness('dev_a');

    await seedInitialDeviceState(devD, { ...SEED_TXN });
    await seedInitialDeviceState(devA, { ...SEED_TXN });

    // Device D changes to Transfer-Out and uploads
    await activateDevice(devD);
    await updateTransaction(SEED_TXN.id, {
      'Income/Expense': 'Transfer-Out',
      Category: 'Transfer',
      FromAccount: 'Bank Account',
      ToAccount: 'Wallet',
      FromSubAccount: 'Checking',
      ToSubAccount: 'Cash Pocket'
    });
    await executeFullSyncPass({
      deviceId: 'dev_d',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    // Meanwhile, Device A makes a concurrent local modification to the same transaction
    await activateDevice(devA);
    await updateTransaction(SEED_TXN.id, {
      'Income/Expense': 'Expense',
      Category: 'Food & Dining',
      Note: 'Edited concurrently on Device A',
      INR: 999,
      Amount: '999'
    });

    // Device A syncs and downloads Device D's delta
    const syncResult = await executeFullSyncPass({
      deviceId: 'dev_a',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    // Device A stages the package, but reconciliation flags a checksum divergence
    assert.strictEqual(syncResult.success, true);
    assert.strictEqual(syncResult.inbound.stagedPackagesCount, 1, 'Package was staged');
    assert.strictEqual(syncResult.reconciliation.reconciledCount, 0, 'Zero updates reconciled due to conflict');
    assert.strictEqual(syncResult.reconciliation.conflictCount, 1, 'Exactly 1 conflict flagged');

    // Assert CONCURRENT_EDIT conflict is logged in sync_conflicts
    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 1, 'Exactly 1 pending conflict');
    assert.strictEqual(conflicts[0].conflict_type, CONFLICT_TYPE.CONCURRENT_EDIT);
    assert.strictEqual(conflicts[0].collection, 'transactions');
    assert.strictEqual(conflicts[0].entity_id, SEED_TXN.id);
    assert.strictEqual(conflicts[0].status, CONFLICT_STATUS.PENDING);

    // Assert Device A's local database was NOT overwritten by Device D's payload
    const aTxn = await getTxnById(SEED_TXN.id);
    assert.ok(aTxn, 'Device A has transaction');
    assert.strictEqual(aTxn['Income/Expense'], 'Expense', 'Local type preserved');
    assert.strictEqual(aTxn.Note, 'Edited concurrently on Device A', 'Local note preserved');
    assert.strictEqual(aTxn.INR, 999, 'Local amount preserved');
  });

  await t.test('5. UI refresh notification: Active in-window subscriber receives notification upon peer reconciliation', async () => {
    const devD = createDeviceHarness('dev_d');
    const devA = createDeviceHarness('dev_a');

    await seedInitialDeviceState(devD, { ...SEED_TXN });
    await seedInitialDeviceState(devA, { ...SEED_TXN });

    // D edits and uploads
    await activateDevice(devD);
    await updateTransaction(SEED_TXN.id, {
      'Income/Expense': 'Transfer-Out',
      Category: 'Transfer',
      FromAccount: 'Bank Account',
      ToAccount: 'Wallet'
    });
    await executeFullSyncPass({
      deviceId: 'dev_d',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    // Activate A and attach listener
    await activateDevice(devA);
    const notifications = [];
    const unsubscribe = subscribeSyncStatus((status, details) => {
      notifications.push({ status, details });
    });

    await executeFullSyncPass({
      deviceId: 'dev_a',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    // Verify notifications order and content
    assert.ok(notifications.length >= 2, 'Received SYNCING and SUCCESS notifications');
    assert.strictEqual(notifications[0].status, SYNC_STATUS.SYNCING);

    const successNotif = notifications.find(n => n.status === SYNC_STATUS.SUCCESS);
    assert.ok(successNotif, 'Received SYNC_STATUS.SUCCESS');
    assert.strictEqual(successNotif.details.reconciliation.reconciledCount, 1);
    assert.strictEqual(successNotif.details.inbound.stagedPackagesCount, 1);

    // Verify unsubscribe works
    unsubscribe();
    notifications.length = 0;
    await executeFullSyncPass({
      deviceId: 'dev_a',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.strictEqual(notifications.length, 0, 'No notifications received after unsubscribe');
  });
});
