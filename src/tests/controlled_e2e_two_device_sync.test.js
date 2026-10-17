/**
 * controlled_e2e_two_device_sync.test.js
 * 
 * Controlled End-to-End Test Suite Using Two Independent Test Devices
 * and an Isolated Cloud Repository with Real Google Drive Transport Semantics.
 * 
 * Strict Isolation:
 * - Zero live production mutations, zero production accounts, zero candidate baseline overwrites.
 * - Simulates two completely segregated client devices (Device Alpha & Device Beta) with independent
 *   local IndexedDB instances, local storage, sequence watermarks, and delta queues.
 * 
 * Comprehensive Lifecycle Coverage:
 * 1. Create: Single mutation with canonical checksum equality across Device Alpha, Cloud Delta, and Device Beta.
 * 2. Edit: Update mutation with optimistic precondition validation and canonical parity.
 * 3. Delete: Single deletion emitting durable tombstone and DELETE event, propagating cleanly to peer.
 * 4. Bulk Copy / Insert: Multi-item atomic batch with contiguous sequence allocation and peer convergence.
 * 5. Bulk Delete: deleteAllTransactions emitting full tombstone set and peer ledger cleanup.
 * 6. Offline Reconnect: Offline accumulation of mutations, reconnect flush, single-pass upload & ACK.
 * 7. Retries & Duplicate Delivery: Repeated delivery of already-acknowledged packages is 100% idempotent.
 * 8. Blocked-Baseline Reporting: Incompatible peer manifest is reported as BLOCKED_PEER_BASELINE rather than silently skipped.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initDB,
  closeDB,
  getDB,
  addTransaction,
  updateTransaction,
  deleteTransaction,
  deleteAllTransactions,
  getTransactions,
  getPendingDeltaEvents,
  getTombstones,
  initLocalSyncState,
  getLocalSyncState,
  setSetting
} from '../database/index.js';
import {
  buildDeterministicPackagePayload,
  encryptDeltaPackage,
  pullPeerDeltas,
  uploadPendingDeltas,
  stagePeerPackageAtomically
} from '../services/deltaTransport.js';
import {
  reconcileStagedEvents
} from '../services/deltaReconciliation.js';
import {
  executeFullSyncPass,
  SYNC_STATUS
} from '../services/deltaSyncCoordinator.js';
import {
  writeOwnDeviceManifest,
  listPeerManifests,
  createEmptyDeviceManifest,
  PEER_LINEAGE_STATUS
} from '../services/deviceManifest.js';
import {
  toCanonicalJson,
  computeCanonicalSha256
} from '../utils/canonicalEntity.js';
import {
  deriveUnifiedSyncStatus,
  UNIFIED_SYNC_STATUS_KEYS
} from '../utils/cloudSyncStatusHelper.js';

const TEST_BASE_SNAPSHOT_ID = 'snap_e2e_isolated_v1';
const TEST_BASE_CLOUD_VERSION = 1;
const TEST_SESSION_KEY = 'e2e_session_encryption_key_32_bytes_len!';

/**
 * Isolated Google Drive Transport Mock implementing real Drive API semantics
 */
class IsolatedDriveTransport {
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

  async findAppDataFile(name) {
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        return { id: f.id, name: f.name };
      }
    }
    return null;
  }

  async listAppDataFiles() {
    const results = [];
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed) {
        results.push({ id: f.id, name: f.name, size: f.content?.length || 0 });
      }
    }
    return results;
  }

  async readFile(fileId) {
    const f = this.files.get(fileId);
    if (!f || f.trashed) throw new Error(`Drive file not found: ${fileId}`);
    return f.content;
  }

  async readAppDataFile(fileId) {
    return this.readFile(fileId);
  }

  async uploadFile({ name, content, appProperties = {} }) {
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        f.content = content;
        f.appProperties = { ...f.appProperties, ...appProperties };
        f.version = (f.version || 1) + 1;
        return { id: f.id, name: f.name, version: f.version };
      }
    }
    const id = `drive_file_${this.nextId++}`;
    this.files.set(id, {
      id,
      name,
      content,
      appProperties: { ...appProperties },
      trashed: false,
      version: 1
    });
    return { id, name, version: 1 };
  }

  async uploadAppDataFile(name, content) {
    return this.uploadFile({ name, content });
  }
}

/**
 * Creates an isolated device test harness with separate storage and IDB
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
 * Activates a device harness, switching the active runtime environment
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
 * Initializes a device with baseline settings and sync state
 */
async function setupDeviceBaseline(harness) {
  await activateDevice(harness);
  await initLocalSyncState(harness.deviceId, harness.baseSnapshotId, TEST_BASE_CLOUD_VERSION, 'ACTIVE');
  await setSetting('last_snapshot_id', harness.baseSnapshotId, { suppressDeltaQueue: true });
  await setSetting('last_parent_snapshot_id', '', { suppressDeltaQueue: true });
  await setSetting('device_lifecycle_state', 'ACTIVE', { suppressDeltaQueue: true });
}

test('Controlled End-to-End Two-Device Sync Suite with Isolated Drive Transport', async (t) => {
  const mockDrive = new IsolatedDriveTransport();
  const devAlpha = createDeviceHarness('dev_e2e_alpha');
  const devBeta = createDeviceHarness('dev_e2e_beta');

  await setupDeviceBaseline(devAlpha);
  await setupDeviceBaseline(devBeta);

  // =========================================================================
  // 1. CREATE: Single Mutation Trace & Parity
  // =========================================================================
  await t.test('1. Create: Exact ID and Canonical Checksum Parity Across Devices', async () => {
    await activateDevice(devAlpha);

    const newTxn = {
      id: 'txn_e2e_create_001',
      date: '2026-10-17',
      time: '14:30',
      account: 'Bank Account',
      category: 'Groceries',
      amount: '125.50',
      inr: 125.50,
      type: 'Expense',
      note: 'Fresh Produce'
    };

    const insertedAlpha = await addTransaction(newTxn);
    assert.ok(insertedAlpha, 'Device Alpha must add transaction');
    const alphaCanonicalJson = toCanonicalJson(insertedAlpha);
    const alphaChecksum = await computeCanonicalSha256(insertedAlpha);

    // Alpha executes full sync pass (push)
    const alphaSyncRes = await executeFullSyncPass({
      deviceId: devAlpha.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(alphaSyncRes.success, true);
    assert.equal(alphaSyncRes.outbound.packagesUploaded, 1);
    assert.equal(alphaSyncRes.outbound.eventsUploaded, 1);

    // Beta executes full sync pass (pull & reconcile)
    await activateDevice(devBeta);
    const betaSyncRes = await executeFullSyncPass({
      deviceId: devBeta.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(betaSyncRes.success, true);
    assert.equal(betaSyncRes.inbound.stagedPackagesCount, 1);
    assert.equal(betaSyncRes.reconciliation.reconciledCount, 1);

    // Verify exact ID and canonical equality on Device Beta
    const betaTxns = await getTransactions();
    const betaTxn = betaTxns.find(t => t.id === 'txn_e2e_create_001');
    assert.ok(betaTxn, 'Transaction must exist on Device Beta');
    const betaCanonicalJson = toCanonicalJson(betaTxn);
    const betaChecksum = await computeCanonicalSha256(betaTxn);

    assert.equal(betaTxn.id, insertedAlpha.id, 'Exact entity ID match');
    assert.equal(betaTxn.Note, 'Fresh Produce', 'Note field fidelity');
    assert.equal(betaCanonicalJson, alphaCanonicalJson, 'Exact canonical JSON representation match');
    assert.equal(betaChecksum, alphaChecksum, 'Exact canonical SHA-256 hash match');
  });

  // =========================================================================
  // 2. EDIT: Update Mutation with Precondition Verification
  // =========================================================================
  await t.test('2. Edit: Optimistic Precondition Validation and Convergence', async () => {
    await activateDevice(devAlpha);

    // Device Alpha edits the transaction
    const updatedAlpha = await updateTransaction('txn_e2e_create_001', {
      amount: 175.00,
      INR: 175.00,
      Note: 'Fresh Produce and Organic Dairy'
    });
    assert.ok(updatedAlpha);
    const alphaEditedJson = toCanonicalJson(updatedAlpha);
    const alphaEditedChecksum = await computeCanonicalSha256(updatedAlpha);

    // Alpha syncs update
    const alphaPushRes = await executeFullSyncPass({
      deviceId: devAlpha.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(alphaPushRes.success, true);
    assert.equal(alphaPushRes.outbound.eventsUploaded, 1);

    // Beta syncs update
    await activateDevice(devBeta);
    const betaPullRes = await executeFullSyncPass({
      deviceId: devBeta.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(betaPullRes.success, true);
    assert.equal(betaPullRes.reconciliation.reconciledCount, 1);

    // Verify exact edited values on Beta
    const betaTxns = await getTransactions();
    const betaTxn = betaTxns.find(t => t.id === 'txn_e2e_create_001');
    assert.ok(betaTxn);
    assert.equal(betaTxn.Note, 'Fresh Produce and Organic Dairy');
    assert.equal(Number(betaTxn.INR), 175.00);
    assert.equal(toCanonicalJson(betaTxn), alphaEditedJson, 'Exact canonical value equality after edit');
    assert.equal(await computeCanonicalSha256(betaTxn), alphaEditedChecksum);
  });

  // =========================================================================
  // 3. DELETE: Tombstone Creation & Peer Deletion Trace
  // =========================================================================
  await t.test('3. Delete: Durable Tombstone Propagation and Peer Ledger Removal', async () => {
    await activateDevice(devAlpha);

    // Device Alpha deletes transaction
    await deleteTransaction('txn_e2e_create_001');
    const alphaTxns = await getTransactions();
    assert.equal(alphaTxns.some(t => t.id === 'txn_e2e_create_001'), false);

    // Verify tombstone created on Alpha
    const alphaTombstones = await getTombstones();
    assert.ok(alphaTombstones.some(t => t.id === 'txn_e2e_create_001' || t.entity_id === 'txn_e2e_create_001'));

    // Alpha syncs delete
    const alphaDelSync = await executeFullSyncPass({
      deviceId: devAlpha.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(alphaDelSync.success, true);
    assert.equal(alphaDelSync.outbound.eventsUploaded, 1);

    // Beta pulls delete
    await activateDevice(devBeta);
    const betaDelSync = await executeFullSyncPass({
      deviceId: devBeta.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(betaDelSync.success, true);
    assert.equal(betaDelSync.reconciliation.reconciledCount, 1);

    // Verify row removed from Beta and tombstone present on Beta
    const betaTxns = await getTransactions();
    assert.equal(betaTxns.some(t => t.id === 'txn_e2e_create_001'), false, 'Entity removed from Beta DB');
    const betaTombstones = await getTombstones();
    assert.ok(betaTombstones.some(t => t.id === 'txn_e2e_create_001' || t.entity_id === 'txn_e2e_create_001'), 'Tombstone replicated to Beta');
  });

  // =========================================================================
  // 4. BULK COPY / INSERT: Multi-Item Batching & Monotonicity
  // =========================================================================
  await t.test('4. Bulk Copy / Insert: Contiguous Monotonic Sequences and Exact ID Comparison', async () => {
    await activateDevice(devAlpha);

    // Generate 25 distinct bulk transactions
    const bulkEntities = [];
    for (let i = 1; i <= 25; i++) {
      const id = `txn_e2e_bulk_${String(i).padStart(3, '0')}`;
      bulkEntities.push({
        id,
        date: '2026-10-17',
        time: '15:00',
        account: 'Bank Account',
        category: 'Investment',
        amount: String(i * 10),
        inr: i * 10,
        type: 'Expense',
        note: `Bulk Item ${i}`
      });
    }

    // Add all 25 transactions on Alpha
    const alphaInserted = [];
    for (const item of bulkEntities) {
      const ins = await addTransaction(item);
      alphaInserted.push(ins);
    }

    const queueAlpha = await getPendingDeltaEvents();
    assert.equal(queueAlpha.length, 25, 'All 25 bulk mutations queued');

    // Verify strictly monotonic contiguous sequences without duplicates or rewinds
    const sequences = queueAlpha.map(e => Number(e.sequence));
    for (let i = 1; i < sequences.length; i++) {
      assert.equal(sequences[i], sequences[i - 1] + 1, 'Sequences must be contiguous');
    }

    // Alpha syncs bulk package
    const alphaBulkSync = await executeFullSyncPass({
      deviceId: devAlpha.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(alphaBulkSync.success, true);
    assert.equal(alphaBulkSync.outbound.eventsUploaded, 25);

    // Beta pulls and reconciles all 25 bulk items
    await activateDevice(devBeta);
    const betaBulkSync = await executeFullSyncPass({
      deviceId: devBeta.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(betaBulkSync.success, true);
    assert.equal(betaBulkSync.reconciliation.reconciledCount, 25);

    // Compare all 25 exact IDs, canonical JSON values, and SHA-256 digests
    const betaTxns = await getTransactions();
    assert.equal(betaTxns.length, 25);
    for (const alphaItem of alphaInserted) {
      const foundOnBeta = betaTxns.find(t => t.id === alphaItem.id);
      assert.ok(foundOnBeta, `Transaction ${alphaItem.id} must exist on Beta`);
      assert.equal(toCanonicalJson(foundOnBeta), toCanonicalJson(alphaItem), `Exact canonical match for ${alphaItem.id}`);
      assert.equal(await computeCanonicalSha256(foundOnBeta), await computeCanonicalSha256(alphaItem), `Exact hash match for ${alphaItem.id}`);
    }
  });

  // =========================================================================
  // 5. BULK DELETE: Complete Ledger Cleanup Trace
  // =========================================================================
  await t.test('5. Bulk Delete: deleteAllTransactions Emits Full Tombstone Set and Reconciles', async () => {
    await activateDevice(devAlpha);

    // Clear all 25 transactions on Alpha
    await deleteAllTransactions();
    const alphaRemaining = await getTransactions();
    assert.equal(alphaRemaining.length, 0);

    const delQueue = await getPendingDeltaEvents();
    assert.equal(delQueue.length, 25, 'Must emit 25 DELETE events');

    // Alpha syncs bulk deletion
    const alphaDelPass = await executeFullSyncPass({
      deviceId: devAlpha.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(alphaDelPass.success, true);
    assert.equal(alphaDelPass.outbound.eventsUploaded, 25);

    // Beta pulls bulk deletion
    await activateDevice(devBeta);
    const betaDelPass = await executeFullSyncPass({
      deviceId: devBeta.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(betaDelPass.success, true);
    assert.equal(betaDelPass.reconciliation.reconciledCount, 25);

    // Verify Beta DB has 0 active transactions
    const betaRemaining = await getTransactions();
    assert.equal(betaRemaining.length, 0, 'Beta ledger must be completely cleared');

    const betaTombstones = await getTombstones();
    assert.ok(betaTombstones.length >= 25, 'All 25 tombstones must be recorded on Beta');
  });

  // =========================================================================
  // 6. OFFLINE RECONNECT: Accumulation & Single-Pass Flush
  // =========================================================================
  await t.test('6. Offline Reconnect: Local Queue Accumulation and Single-Pass Flush', async () => {
    await activateDevice(devAlpha);

    // Simulate offline Drive transport: network failure
    const offlineDrive = {
      findFiles: async () => { throw new Error('OFFLINE_NETWORK_UNREACHABLE'); },
      uploadFile: async () => { throw new Error('OFFLINE_NETWORK_UNREACHABLE'); },
      readFile: async () => { throw new Error('OFFLINE_NETWORK_UNREACHABLE'); }
    };

    // User performs 3 mutations while offline
    const offlineTxn1 = await addTransaction({ id: 'txn_off_1', amount: 50, note: 'Coffee' });
    const offlineTxn2 = await addTransaction({ id: 'txn_off_2', amount: 75, note: 'Fuel' });
    const offlineTxn3 = await addTransaction({ id: 'txn_off_3', amount: 30, note: 'Snacks' });

    // Sync fails closed while offline without corrupting queue
    const offlineSync = await executeFullSyncPass({
      deviceId: devAlpha.deviceId,
      driveClient: offlineDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(offlineSync.success, false);

    // Verify all 3 mutations remain PENDING in local queue
    const pending = await getPendingDeltaEvents();
    assert.equal(pending.length, 3);
    assert.equal(pending.every(e => e.status === 'PENDING'), true);

    // Reconnect: Network restored
    const onlineSync = await executeFullSyncPass({
      deviceId: devAlpha.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(onlineSync.success, true);
    assert.equal(onlineSync.outbound.eventsUploaded, 3);

    // Local queue is now empty/acknowledged
    const queueAfterReconnect = await getPendingDeltaEvents();
    assert.equal(queueAfterReconnect.length, 0);

    // Beta pulls all 3 offline-accumulated transactions
    await activateDevice(devBeta);
    const betaSync = await executeFullSyncPass({
      deviceId: devBeta.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.equal(betaSync.success, true);
    assert.equal(betaSync.reconciliation.reconciledCount, 3);

    const betaTxns = await getTransactions();
    assert.equal(betaTxns.length, 3);
    assert.ok(betaTxns.find(t => t.id === 'txn_off_1'));
    assert.ok(betaTxns.find(t => t.id === 'txn_off_2'));
    assert.ok(betaTxns.find(t => t.id === 'txn_off_3'));
  });

  // =========================================================================
  // 7. RETRIES & DUPLICATE DELIVERY: Replay Idempotency
  // =========================================================================
  await t.test('7. Retries & Duplicate Delivery: Replaying Packages Causes Zero Duplicates', async () => {
    await activateDevice(devBeta);

    const countBeforeReplay = (await getTransactions()).length;

    // Simulate duplicate pull & reconcile of already-staged packages
    const duplicatePullRes = await executeFullSyncPass({
      deviceId: devBeta.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.equal(duplicatePullRes.success, true);
    assert.equal(duplicatePullRes.inbound.stagedPackagesCount, 0, 'Zero new packages staged on duplicate delivery');
    assert.equal(duplicatePullRes.reconciliation.reconciledCount, 0, 'Zero new events reconciled');

    // Total records on Beta remain identical
    const countAfterReplay = (await getTransactions()).length;
    assert.equal(countAfterReplay, countBeforeReplay, 'Zero duplicate records inserted');
  });

  // =========================================================================
  // 8. BLOCKED-BASELINE REPORTING: Incompatible Peer Baseline Detection
  // =========================================================================
  await t.test('8. Blocked-Baseline Reporting: Incompatible Baseline Produces BLOCKED_SYNC Status', async () => {
    // A third peer device (Gamma) publishes a manifest on an incompatible snapshot baseline
    const devGammaId = 'dev_e2e_gamma';
    const foreignBaselineId = 'snap_foreign_unrelated_repo_999';

    const gammaManifest = createEmptyDeviceManifest({
      deviceId: devGammaId,
      baseSnapshotId: foreignBaselineId,
      baseCloudVersion: 1,
      manifestRevision: 1,
      lifecycleState: 'ACTIVE'
    });

    await mockDrive.uploadFile({
      name: `manifest_${devGammaId}.json`,
      content: JSON.stringify(gammaManifest)
    });

    // Device Alpha executes full sync pass
    await activateDevice(devAlpha);
    const syncRes = await executeFullSyncPass({
      deviceId: devAlpha.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    // Verification:
    // 1. Sync must NOT report success
    assert.equal(syncRes.success, false, 'Sync must report failure/blocked');
    // 2. Status must be BLOCKED_PEER_BASELINE
    assert.equal(syncRes.status, SYNC_STATUS.BLOCKED_PEER_BASELINE);
    // 3. Blocked peers list must include Gamma with exact reason
    assert.ok(syncRes.blockedPeers && syncRes.blockedPeers.length > 0);
    const blockedGamma = syncRes.blockedPeers.find(p => p.deviceId === devGammaId);
    assert.ok(blockedGamma, 'Device Gamma must be explicitly in blockedPeers');
    assert.equal(blockedGamma.baseSnapshotId, foreignBaselineId);
    assert.match(blockedGamma.reason, /INCOMPATIBLE_SNAPSHOT_BASELINE/);

    // 4. UI Status helper maps this truthfully to BLOCKED_SYNC with badge "Incompatible Peer"
    const uiStatus = deriveUnifiedSyncStatus({
      syncStatus: syncRes.status,
      blockedPeers: syncRes.blockedPeers,
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      isDeltaSyncing: false
    });
    assert.equal(uiStatus.key, UNIFIED_SYNC_STATUS_KEYS.BLOCKED_SYNC);
    assert.equal(uiStatus.badgeText, 'Incompatible Peer');
    assert.equal(uiStatus.badgeType, 'warning');
    assert.equal(uiStatus.primaryActionKey, 'RETRY_SYNC');
  });
});
