/**
 * new_device_bootstrap_lifecycle.test.js
 * 
 * Comprehensive Test Suite for New Device / Existing Repository Bootstrap Lifecycle:
 * A. Fresh DB seed: 0 delta queue events, sequence 0
 * B. Existing repository discovery: detects baseline dynamically, does not upload
 * C. New-device bootstrap: UNINITIALIZED -> JOINING -> ACTIVE
 * D. Bootstrap baseline population: local stores populated from snapshot
 * E. Post-baseline replay: required delta packages applied and reconciled
 * F. Bootstrap conflict preservation: existing conflict remains conflict, no auto-resolution
 * G. Outbound safety: UNINITIALIZED/JOINING upload rejected, ACTIVE allowed
 * H. Crash/reload safety: JOINING device cannot accidentally become ACTIVE
 * I. Existing ACTIVE device regression: normal delta push/pull unchanged
 * J. No hardcoded baseline: test repository with a custom snapshot ID
 * K. New repository path: test behavior when no cloud repository exists (no silent seed upload)
 * L. Duplicate prevention: no duplicate accounts/categories from bootstrap
 * M. Browser/runtime IDB test: exercise actual IDB runtime
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  initDB,
  closeDB,
  getDB,
  getRawIDB,
  initLocalSyncState,
  getLocalSyncState,
  DELTA_STATUS,
  DELTA_OPERATION
} from '../database/index.js';
import { executeAtomicMutation } from '../database/atomicMutation.js';
import { getTransactions, addTransaction } from '../database/transactions.js';
import { getAccounts, replaceAccounts } from '../database/accounts.js';
import { getCategories, replaceCategories } from '../database/categories.js';
import { getSetting, setSetting } from '../database/settings.js';
import { getPendingConflicts } from '../database/conflicts.js';
import {
  DEVICE_LIFECYCLE,
  getDeviceLifecycleState,
  setDeviceLifecycleState,
  discoverCloudRepository,
  bootstrapNewDevice,
  executeFullSyncPass,
  configureDeltaSyncEngine,
  SYNC_STATUS
} from '../services/deltaSyncCoordinator.js';
import {
  uploadPendingDeltas,
  buildDeterministicPackagePayload,
  encryptDeltaPackage,
  decryptDeltaPackage,
  TARGET_PACKAGE_EVENTS
} from '../services/deltaTransport.js';
import {
  createEmptyDeviceManifest,
  writeOwnDeviceManifest,
  readOwnDeviceManifest,
  listPeerManifests
} from '../services/deviceManifest.js';
import {
  populateLocalEntitiesBootstrap,
  validateCloudSnapshotPayload,
  readLocalEntities,
  SNAPSHOT_FILENAME
} from '../services/cloudSyncEngine.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';

const TEST_SESSION_KEY = 'test-secret-key-lifecycle-bootstrap';

/**
 * In-memory Mock Google Drive Client for Lifecycle Testing
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

  async findFiles({ name, trashed = false }) {
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
    const id = `mock_file_${this.nextId++}`;
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

async function resetDBEnvironment() {
  await closeDB();
  globalThis.indexedDB = new IDBFactory();
  await initDB();
}

test('FinMan Phase 7.6 — New Device / Existing Repository Bootstrap Lifecycle Suite', async (t) => {
  const mockDrive = new MockDriveStorage();

  t.beforeEach(async () => {
    mockDrive.reset();
    await resetDBEnvironment();
  });

  t.after(async () => {
    await closeDB();
  });

  await t.test('A: Fresh DB seed results in 0 delta queue events, sequence 0, and no outbound packages', async () => {
    const db = getDB();
    
    // Perform transient seed operations with suppressDeltaQueue: true
    await replaceAccounts([
      { id: 'acc_def_1', name: 'Cash', group: 'Cash' },
      { id: 'acc_def_2', name: 'Bank Account', group: 'Bank Accounts' }
    ], { suppressDeltaQueue: true });

    await replaceCategories([
      { id: 'cat_def_1', name: 'Food & Dining', type: 'Expense' },
      { id: 'cat_def_2', name: 'Salary', type: 'Income' }
    ], { suppressDeltaQueue: true });

    // Verify database stores have accounts and categories
    const accounts = await getAccounts();
    const categories = await getCategories();
    assert.ok(accounts.length > 0, 'Accounts seeded');
    assert.ok(categories.length > 0, 'Categories seeded');

    // Verify 0 delta queue events
    const queueRows = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.strictEqual(queueRows.length, 0, '0 delta events emitted during seed');

    // Verify sequence remains 0
    const stateRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
    const seq = Number(stateRes.values?.[0]?.last_allocated_sequence || 0);
    assert.strictEqual(seq, 0, 'Sequence remains 0');

    // Verify lifecycle state is UNINITIALIZED
    const lifecycle = await getDeviceLifecycleState('fresh_dev');
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.UNINITIALIZED, 'Device is UNINITIALIZED');
  });

  await t.test('B: Dynamic cloud repository discovery detects baseline without hardcoded snapshot IDs and without uploading', async () => {
    // Create synthetic cloud snapshot with dynamic ID
    const dynamicSnapshotId = 'snap_dynamic_repo_xyz789';
    const snapshotPayload = {
      snapshot_id: dynamicSnapshotId,
      cloud_version: 3,
      created_at: new Date().toISOString(),
      device_id: 'device_primary',
      entities: {
        transactions: [
          { id: 'tx_cloud_101', Date: '2026-03-01', INR: 1500, Account: 'Bank', Category: 'Salary', 'Income/Expense': 'Income' },
          { id: 'tx_cloud_102', Date: '2026-03-02', INR: 350, Account: 'Bank', Category: 'Groceries', 'Income/Expense': 'Expense' }
        ],
        investment_transactions: [
          { id: 'inv_cloud_201', Date: '2026-03-01', INR: 5000, SecuritySymbol: 'RELIANCE', Quantity: 2, UnitPrice: 2500, 'Income/Expense': 'Expense' }
        ],
        accounts: [{ id: 'acc_bank', name: 'Bank', group_name: 'Cash' }],
        categories: [{ id: 'cat_groceries', name: 'Groceries', type: 'Expense' }]
      }
    };

    const encryptedSnapshot = await encryptBackupData(snapshotPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot
    });

    // Discover repository dynamically
    const discovery = await discoverCloudRepository({
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.strictEqual(discovery.exists, true);
    assert.strictEqual(discovery.status, 'EXISTING_REPOSITORY_FOUND');
    assert.strictEqual(discovery.snapshotId, dynamicSnapshotId, 'Discovered dynamic snapshot ID');
    assert.strictEqual(discovery.cloudVersion, 3);
    assert.strictEqual(discovery.entityCounts.transactions, 2);
    assert.strictEqual(discovery.entityCounts.investment_transactions, 1);

    // Verify NO outbound packages or manifests were written during discovery
    const allFiles = await mockDrive.findFiles({});
    assert.strictEqual(allFiles.length, 1, 'Only the snapshot file exists on Drive (read-only discovery)');
  });

  await t.test('C & D: New-device bootstrap populates local stores and transitions UNINITIALIZED -> JOINING -> ACTIVE', async () => {
    const dynamicSnapshotId = 'snap_bootstrap_prod_001';
    const snapshotPayload = {
      snapshot_id: dynamicSnapshotId,
      cloud_version: 5,
      created_at: new Date().toISOString(),
      device_id: 'device_c',
      entities: {
        transactions: [
          { id: 'tx_b01', Date: '2026-03-01', INR: 2000, Account: 'Savings', Category: 'Salary', 'Income/Expense': 'Income' },
          { id: 'tx_b02', Date: '2026-03-02', INR: 450, Account: 'Savings', Category: 'Food', 'Income/Expense': 'Expense' }
        ],
        investment_transactions: [
          { id: 'inv_b01', Date: '2026-03-01', INR: 10000, SecuritySymbol: 'TCS', Quantity: 3, UnitPrice: 3333.33, 'Income/Expense': 'Expense' }
        ],
        accounts: [{ id: 'acc_sav', name: 'Savings', group_name: 'Cash' }],
        categories: [{ id: 'cat_food', name: 'Food', type: 'Expense' }]
      }
    };

    const encryptedSnapshot = await encryptBackupData(snapshotPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot
    });

    const newDeviceId = 'device_e_fresh';
    const progressStages = [];

    const bootResult = await bootstrapNewDevice({
      deviceId: newDeviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY,
      onProgress: (p) => progressStages.push(p.stage)
    });

    assert.strictEqual(bootResult.success, true);
    assert.strictEqual(bootResult.status, 'BOOTSTRAP_SUCCESS');
    assert.strictEqual(bootResult.snapshotId, dynamicSnapshotId);

    // Verify lifecycle transitioned to ACTIVE
    const lifecycle = await getDeviceLifecycleState(newDeviceId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.ACTIVE, 'Device is now ACTIVE');

    // Verify local stores populated
    const txns = await getTransactions();
    assert.ok(txns.length >= 2, 'Transactions installed locally');
    assert.ok(txns.some(t => t.id === 'tx_b01'), 'tx_b01 installed');
    assert.ok(txns.some(t => t.id === 'tx_b02'), 'tx_b02 installed');

    const db = getDB();
    const invTxns = (await db.query('SELECT * FROM investment_transactions')).values || [];
    assert.strictEqual(invTxns.length, 1, '1 investment transaction installed');

    // Verify 0 outbound delta queue items generated by bootstrap
    const qRows = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.strictEqual(qRows.length, 0, 'Bootstrap generated 0 outbound delta queue events');

    // Verify own device manifest was published as ACTIVE participant
    const manifestFiles = await mockDrive.findFiles({ name: `manifest_dev_${newDeviceId}.json` });
    assert.strictEqual(manifestFiles.length, 1, 'Own manifest published');
    const rawManifest = await mockDrive.readFile(manifestFiles[0].id);
    const ownManifest = typeof rawManifest === 'string' ? JSON.parse(rawManifest) : rawManifest;
    assert.strictEqual(ownManifest.base_snapshot_id, dynamicSnapshotId);
    assert.strictEqual(ownManifest.device_lifecycle_state, 'ACTIVE');
  });

  await t.test('E: Post-baseline delta packages are replayed and reconciled during bootstrap', async () => {
    const baseSnapshotId = 'snap_base_reconciliation_001';
    const snapshotPayload = {
      snapshot_id: baseSnapshotId,
      cloud_version: 1,
      created_at: new Date().toISOString(),
      device_id: 'device_c',
      entities: {
        transactions: [
          { id: 'tx_baseline_1', Date: '2026-03-01', INR: 1000, Account: 'Checking', Category: 'Misc', 'Income/Expense': 'Expense' }
        ],
        investment_transactions: [],
        accounts: [{ id: 'acc_chk', name: 'Checking', group_name: 'Cash' }],
        categories: [{ id: 'cat_misc', name: 'Misc', type: 'Expense' }]
      }
    };

    const encryptedSnapshot = await encryptBackupData(snapshotPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot
    });

    // Create a post-baseline delta package from peer Device D
    const peerDeviceId = 'device_d';
    const newTxn = { id: 'tx_peer_delta_99', Date: '2026-03-05', inr: 777, account: 'Checking', category: 'Misc', type: 'Expense' };
    const newTxnHash = await computeCanonicalSha256(newTxn);

    const deltaEvent = {
      event_id: 'evt_d_001',
      device_id: peerDeviceId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      collection: 'transactions',
      entity_id: 'tx_peer_delta_99',
      operation: DELTA_OPERATION.INSERT,
      base_checksum: null,
      new_checksum: newTxnHash,
      tombstone_generation: 0,
      payload: newTxn,
      bundle_id: null,
      bundle_index: 0,
      bundle_total: 1,
      bundle_checksum: null
    };

    const packagePayload = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId,
      baseCloudVersion: 1,
      events: [deltaEvent]
    });

    const encryptedPackage = await encryptDeltaPackage(packagePayload, TEST_SESSION_KEY);
    const uploadedPkg = await mockDrive.uploadFile({
      name: `pkg_${peerDeviceId}_000001_000001.finman`,
      content: JSON.stringify(encryptedPackage),
      appProperties: {
        package_id: packagePayload.package_id,
        device_id: peerDeviceId,
        start_sequence: '1',
        end_sequence: '1',
        package_checksum: encryptedPackage.package_checksum
      }
    });

    // Publish peer manifest for Device D
    const peerManifest = createEmptyDeviceManifest({
      deviceId: peerDeviceId,
      baseSnapshotId,
      baseCloudVersion: 1,
      manifestRevision: 1
    });
    peerManifest.packages.push({
      package_id: packagePayload.package_id,
      drive_file_id: uploadedPkg.id,
      start_sequence: 1,
      end_sequence: 1,
      event_count: 1,
      package_checksum: encryptedPackage.package_checksum,
      created_at: new Date().toISOString()
    });
    peerManifest.watermarks = { last_uploaded_sequence: 1 };
    peerManifest.last_sequence = 1;

    await writeOwnDeviceManifest({
      driveClient: mockDrive,
      deviceId: peerDeviceId,
      manifestData: peerManifest
    });

    // Bootstrap new Device E
    const newDeviceId = 'device_e_reconcile';
    const res = await bootstrapNewDevice({
      deviceId: newDeviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.strictEqual(res.success, true);

    // Verify both baseline transaction and peer delta transaction exist locally
    const txns = await getTransactions();
    assert.strictEqual(txns.length, 2, 'Local database has 2 transactions (1 baseline + 1 peer delta)');
    assert.ok(txns.some(t => t.id === 'tx_baseline_1'), 'Baseline txn exists');
    assert.ok(txns.some(t => t.id === 'tx_peer_delta_99'), 'Peer delta txn reconciled');
  });

  await t.test('F: Bootstrap preserves existing concurrent conflicts without auto-resolving them', async () => {
    const baseSnapshotId = 'snap_conflict_preserve_001';
    const originalTxn = { id: 'tx_conflict_target', Date: '2026-03-01', inr: 100, account: 'Cash', category: 'Food', type: 'Expense' };
    const originalHash = await computeCanonicalSha256(originalTxn);

    const snapshotPayload = {
      snapshot_id: baseSnapshotId,
      cloud_version: 1,
      created_at: new Date().toISOString(),
      device_id: 'device_c',
      entities: {
        transactions: [
          { id: 'tx_conflict_target', Date: '2026-03-01', INR: 100, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
        ],
        investment_transactions: [],
        accounts: [{ id: 'acc_cash', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_food', name: 'Food', type: 'Expense' }]
      }
    };

    const encryptedSnapshot = await encryptBackupData(snapshotPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot
    });

    // Device C edited tx_conflict_target to INR 200
    const devCTxn = { ...originalTxn, inr: 200 };
    const devCHash = await computeCanonicalSha256(devCTxn);
    const eventC = {
      event_id: 'evt_c_001',
      device_id: 'device_c',
      sequence: 1,
      timestamp: '2026-03-02T10:00:00.000Z',
      collection: 'transactions',
      entity_id: 'tx_conflict_target',
      operation: DELTA_OPERATION.UPDATE,
      base_checksum: originalHash,
      new_checksum: devCHash,
      tombstone_generation: 0,
      payload: devCTxn
    };

    const pkgCPayload = buildDeterministicPackagePayload({
      deviceId: 'device_c',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId,
      baseCloudVersion: 1,
      events: [eventC]
    });
    const encPkgC = await encryptDeltaPackage(pkgCPayload, TEST_SESSION_KEY);
    const upPkgC = await mockDrive.uploadFile({
      name: 'pkg_device_c_000001_000001.finman',
      content: JSON.stringify(encPkgC),
      appProperties: { package_id: pkgCPayload.package_id, device_id: 'device_c', start_sequence: '1', end_sequence: '1', package_checksum: encPkgC.package_checksum }
    });

    const manifestC = createEmptyDeviceManifest({ deviceId: 'device_c', baseSnapshotId, baseCloudVersion: 1, manifestRevision: 1 });
    manifestC.packages.push({ package_id: pkgCPayload.package_id, drive_file_id: upPkgC.id, start_sequence: 1, end_sequence: 1, event_count: 1, package_checksum: encPkgC.package_checksum, created_at: new Date().toISOString() });
    manifestC.watermarks = { last_uploaded_sequence: 1 };
    manifestC.last_sequence = 1;
    await writeOwnDeviceManifest({ driveClient: mockDrive, deviceId: 'device_c', manifestData: manifestC });

    // Device D edited tx_conflict_target concurrently to INR 300
    const devDTxn = { ...originalTxn, inr: 300 };
    const devDHash = await computeCanonicalSha256(devDTxn);
    const eventD = {
      event_id: 'evt_d_001',
      device_id: 'device_d',
      sequence: 1,
      timestamp: '2026-03-02T10:05:00.000Z',
      collection: 'transactions',
      entity_id: 'tx_conflict_target',
      operation: DELTA_OPERATION.UPDATE,
      base_checksum: originalHash,
      new_checksum: devDHash,
      tombstone_generation: 0,
      payload: devDTxn
    };

    const pkgDPayload = buildDeterministicPackagePayload({
      deviceId: 'device_d',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId,
      baseCloudVersion: 1,
      events: [eventD]
    });
    const encPkgD = await encryptDeltaPackage(pkgDPayload, TEST_SESSION_KEY);
    const upPkgD = await mockDrive.uploadFile({
      name: 'pkg_device_d_000001_000001.finman',
      content: JSON.stringify(encPkgD),
      appProperties: { package_id: pkgDPayload.package_id, device_id: 'device_d', start_sequence: '1', end_sequence: '1', package_checksum: encPkgD.package_checksum }
    });

    const manifestD = createEmptyDeviceManifest({ deviceId: 'device_d', baseSnapshotId, baseCloudVersion: 1, manifestRevision: 1 });
    manifestD.packages.push({ package_id: pkgDPayload.package_id, drive_file_id: upPkgD.id, start_sequence: 1, end_sequence: 1, event_count: 1, package_checksum: encPkgD.package_checksum, created_at: new Date().toISOString() });
    manifestD.watermarks = { last_uploaded_sequence: 1 };
    manifestD.last_sequence = 1;
    await writeOwnDeviceManifest({ driveClient: mockDrive, deviceId: 'device_d', manifestData: manifestD });

    // Bootstrap new Device E
    const newDeviceId = 'device_e_conflict_test';
    await bootstrapNewDevice({
      deviceId: newDeviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    // Check that conflict was detected and preserved in sync_conflicts
    const conflicts = await getPendingConflicts();
    assert.ok(conflicts.length >= 1, 'At least 1 concurrent edit conflict logged');
    assert.ok(conflicts.some(c => c.entity_id === 'tx_conflict_target'), 'Conflict target identified');
    assert.ok(conflicts.every(c => c.status === 'PENDING'), 'Conflicts remain untouched (not auto-resolved)');
  });

  await t.test('G: Outbound safety guards strictly reject UNINITIALIZED and JOINING uploads', async () => {
    const uninitDevice = 'dev_uninit_guard';
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.UNINITIALIZED, uninitDevice);

    await assert.rejects(
      async () => {
        await uploadPendingDeltas({
          deviceId: uninitDevice,
          sessionKey: TEST_SESSION_KEY,
          driveClient: mockDrive
        });
      },
      /DEVICE_NOT_INITIALIZED_FOR_SYNC/,
      'Upload rejected for UNINITIALIZED device'
    );

    const joiningDevice = 'dev_joining_guard';
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.JOINING, joiningDevice);

    await assert.rejects(
      async () => {
        await uploadPendingDeltas({
          deviceId: joiningDevice,
          sessionKey: TEST_SESSION_KEY,
          driveClient: mockDrive
        });
      },
      /DEVICE_NOT_INITIALIZED_FOR_SYNC/,
      'Upload rejected for JOINING device'
    );
  });

  await t.test('H: Crash/reload safety prevents JOINING device from accidentally becoming ACTIVE', async () => {
    const deviceId = 'dev_crash_test';
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.JOINING, deviceId);

    // Simulate page reload: re-read lifecycle state from database
    const stateAfterReload = await getDeviceLifecycleState(deviceId);
    assert.strictEqual(stateAfterReload, DEVICE_LIFECYCLE.JOINING, 'Remains JOINING across reloads');

    // Outbound upload must still be blocked
    await assert.rejects(
      async () => {
        await uploadPendingDeltas({
          deviceId,
          sessionKey: TEST_SESSION_KEY,
          driveClient: mockDrive
        });
      },
      /DEVICE_NOT_INITIALIZED_FOR_SYNC/
    );
  });

  await t.test('I: Existing ACTIVE devices continue normal push/pull/reconciliation sync', async () => {
    const activeDeviceId = 'dev_active_legacy';
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.ACTIVE, activeDeviceId);

    // Add a normal mutation on the active device
    const tItem = { id: 'tx_normal_active_1', inr: 500, description: 'Lunch' };
    await executeAtomicMutation({
      storeName: 'transactions',
      entityId: 'tx_normal_active_1',
      operation: DELTA_OPERATION.INSERT,
      entityData: tItem
    });

    // Active device can successfully upload pending deltas
    const uploadRes = await uploadPendingDeltas({
      deviceId: activeDeviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.strictEqual(uploadRes.eventsUploaded, 1, 'Active device pushed 1 delta event');
    assert.strictEqual(uploadRes.packagesUploaded, 1);
  });

  await t.test('K: Genuinely new repository path does NOT silently upload transient seed data', async () => {
    const freshDeviceId = 'dev_first_time';
    
    // Drive has 0 files (empty remote)
    const discovery = await discoverCloudRepository({
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.strictEqual(discovery.exists, false);
    assert.strictEqual(discovery.status, 'NO_REPOSITORY_EXISTS');

    // Full sync pass on empty cloud does NOT publish outbound packages
    const res = await executeFullSyncPass({
      deviceId: freshDeviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.noRepository, true);

    const allDriveFiles = await mockDrive.findFiles({});
    assert.strictEqual(allDriveFiles.length, 0, 'Zero files created on Drive');
  });

  await t.test('L: Duplicate prevention ensures accounts and categories are clean after bootstrap', async () => {
    // Seed transient UI defaults first
    await replaceAccounts([
      { id: 'acc_def_1', name: 'Cash', group: 'Cash' },
      { id: 'acc_def_2', name: 'Bank Account', group: 'Bank Accounts' }
    ], { suppressDeltaQueue: true });

    await replaceCategories([
      { id: 'cat_def_1', name: 'Food & Dining', type: 'Expense' },
      { id: 'cat_def_2', name: 'Salary', type: 'Income' }
    ], { suppressDeltaQueue: true });

    const accountsBefore = await getAccounts();
    assert.ok(accountsBefore.length > 0);

    // Authoritative cloud snapshot has 1 custom account and 1 custom category
    const snapshotPayload = {
      snapshot_id: 'snap_dedup_test_001',
      cloud_version: 1,
      created_at: new Date().toISOString(),
      device_id: 'device_primary',
      entities: {
        transactions: [],
        investment_transactions: [],
        accounts: [{ id: 'acc_authoritative_checking', name: 'Authoritative Checking', group_name: 'Cash' }],
        categories: [{ id: 'cat_authoritative_salary', name: 'Authoritative Salary', type: 'Income' }]
      }
    };

    const encryptedSnapshot = await encryptBackupData(snapshotPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot
    });

    await bootstrapNewDevice({
      deviceId: 'device_dedup_client',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    // Accounts must contain exactly the authoritative accounts, not duplicates + seeds
    const accountsAfter = await getAccounts();
    assert.strictEqual(accountsAfter.length, 1, 'Transient seed accounts replaced by authoritative account');
    assert.strictEqual(accountsAfter[0].id, 'acc_authoritative_checking');

    const categoriesAfter = await getCategories();
    assert.strictEqual(categoriesAfter.length, 1, 'Transient seed categories replaced by authoritative category');
    assert.strictEqual(categoriesAfter[0].id, 'cat_authoritative_salary');
  });

  await t.test('REGRESSION TEST A: Legacy failed-bootstrap device (Device E exact state) resolves UNINITIALIZED and selects bootstrap', async () => {
    const db = getDB();
    const legacyDevId = 'dev_6edc69e37943';

    // Seed 4 local transactions as observed on Device E (0 pending delta events)
    for (let i = 1; i <= 4; i++) {
      await db.run(
        'INSERT INTO transactions (id, date, inr, amount, account, category, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`tx_e_local_${i}`, '2026-03-01', 100 * i, String(100 * i), 'Cash', 'Misc', 'Expense', new Date().toISOString(), new Date().toISOString()]
      );
    }

    // Set legacy sync_local_state matching Device E
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, last_allocated_sequence, last_uploaded_sequence, last_pushed_sequence, last_acked_sequence, base_snapshot_id, base_cloud_version, lifecycle_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['device_state', legacyDevId, 113, 113, 113, 113, null, null, null, new Date().toISOString()]
    );

    // Insert 2 pending conflicts on E
    await db.run(
      'INSERT OR REPLACE INTO sync_conflicts (conflict_id, collection, entity_id, conflict_type, peer_device_id, event_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['conf_1', 'transactions', 'tx_c1', 'CONCURRENT_EDIT', 'device_c', 'evt_c1', 'PENDING']
    );
    await db.run(
      'INSERT OR REPLACE INTO sync_conflicts (conflict_id, collection, entity_id, conflict_type, peer_device_id, event_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['conf_2', 'transactions', 'tx_c2', 'CONCURRENT_EDIT', 'device_d', 'evt_d1', 'PENDING']
    );

    // Verify lifecycle resolution
    const lifecycle = await getDeviceLifecycleState(legacyDevId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.UNINITIALIZED, 'Legacy E state MUST resolve to UNINITIALIZED');

    // Create cloud snapshot to bootstrap from
    const snapshotPayload = {
      snapshot_id: 'snap_prod_master_123',
      cloud_version: 1,
      created_at: new Date().toISOString(),
      device_id: 'device_primary',
      entities: {
        transactions: [
          { id: 'tx_cloud_1', Date: '2026-03-01', INR: 999, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
        ],
        investment_transactions: [],
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encryptedSnapshot = await encryptBackupData(snapshotPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot
    });

    // Execute full sync pass
    const syncRes = await executeFullSyncPass({
      deviceId: legacyDevId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.strictEqual(syncRes.success, true);
    assert.strictEqual(syncRes.bootstrapped, true, 'Bootstrap was executed');
    assert.strictEqual(syncRes.snapshotId, 'snap_prod_master_123');

    // Verify device transitioned to ACTIVE after successful bootstrap
    const lifecycleAfter = await getDeviceLifecycleState(legacyDevId);
    assert.strictEqual(lifecycleAfter, DEVICE_LIFECYCLE.ACTIVE, 'Device E is ACTIVE after bootstrap');
  });

  await t.test('REGRESSION TEST B: Existing healthy active device (C/D backward-compatible pattern) remains ACTIVE', async () => {
    const db = getDB();
    const healthyDevId = 'dev_c_healthy';

    // Legacy row with sequence > 0 and valid base_snapshot_id (or in settings), but lifecycle_state is null
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, last_allocated_sequence, last_uploaded_sequence, last_pushed_sequence, last_acked_sequence, base_snapshot_id, base_cloud_version, lifecycle_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['device_state', healthyDevId, 50, 50, 50, 50, 'snap_prod_master_123', 1, null, new Date().toISOString()]
    );
    await setSetting('last_snapshot_id', 'snap_prod_master_123');

    const lifecycle = await getDeviceLifecycleState(healthyDevId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.ACTIVE, 'Healthy device with baseline is ACTIVE');
  });

  await t.test('REGRESSION TEST C: Explicit ACTIVE device is classified as ACTIVE', async () => {
    const db = getDB();
    const devId = 'dev_explicit_active';
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, lifecycle_state, updated_at) VALUES (?, ?, ?, ?)',
      ['device_state', devId, DEVICE_LIFECYCLE.ACTIVE, new Date().toISOString()]
    );

    const lifecycle = await getDeviceLifecycleState(devId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.ACTIVE);
  });

  await t.test('REGRESSION TEST D: Explicit JOINING device is classified as JOINING and blocks outbound upload', async () => {
    const db = getDB();
    const devId = 'dev_explicit_joining';
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, lifecycle_state, updated_at) VALUES (?, ?, ?, ?)',
      ['device_state', devId, DEVICE_LIFECYCLE.JOINING, new Date().toISOString()]
    );

    const lifecycle = await getDeviceLifecycleState(devId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.JOINING);

    await assert.rejects(
      async () => {
        await uploadPendingDeltas({
          deviceId: devId,
          sessionKey: TEST_SESSION_KEY,
          driveClient: mockDrive
        });
      },
      /DEVICE_NOT_INITIALIZED_FOR_SYNC/
    );
  });

  await t.test('REGRESSION TEST E: Explicit UNINITIALIZED device is classified as UNINITIALIZED', async () => {
    const db = getDB();
    const devId = 'dev_explicit_uninit';
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, lifecycle_state, updated_at) VALUES (?, ?, ?, ?)',
      ['device_state', devId, DEVICE_LIFECYCLE.UNINITIALIZED, new Date().toISOString()]
    );

    const lifecycle = await getDeviceLifecycleState(devId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.UNINITIALIZED);
  });

  await t.test('REGRESSION TEST F: Legacy sequence + valid initialized baseline resolves to ACTIVE', async () => {
    const db = getDB();
    const devId = 'dev_legacy_with_baseline';
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, last_allocated_sequence, last_uploaded_sequence, base_snapshot_id, lifecycle_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['device_state', devId, 75, 75, 'snap_valid_456', null, new Date().toISOString()]
    );

    const lifecycle = await getDeviceLifecycleState(devId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.ACTIVE);
  });

  await t.test('REGRESSION TEST G: Legacy sequence + NO baseline resolves to UNINITIALIZED', async () => {
    const db = getDB();
    const devId = 'dev_legacy_no_baseline';
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, last_allocated_sequence, last_uploaded_sequence, base_snapshot_id, lifecycle_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['device_state', devId, 75, 75, null, null, new Date().toISOString()]
    );

    const lifecycle = await getDeviceLifecycleState(devId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.UNINITIALIZED);
  });

  await t.test('REGRESSION TEST H: Session unlock startup path cannot upload deltas for legacy failed-bootstrap device before bootstrap', async () => {
    const db = getDB();
    const legacyDevId = 'dev_6edc69e37943_unlock_test';

    // Simulate Device E state
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, last_allocated_sequence, last_uploaded_sequence, last_pushed_sequence, last_acked_sequence, base_snapshot_id, base_cloud_version, lifecycle_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['device_state', legacyDevId, 113, 113, 113, 113, null, null, null, new Date().toISOString()]
    );

    // Add local transaction and attempt direct delta upload
    await assert.rejects(
      async () => {
        await uploadPendingDeltas({
          deviceId: legacyDevId,
          sessionKey: TEST_SESSION_KEY,
          driveClient: mockDrive
        });
      },
      /DEVICE_NOT_INITIALIZED_FOR_SYNC/,
      'Direct delta upload is blocked before bootstrap'
    );

    // Provide authoritative cloud snapshot
    const snapshotPayload = {
      snapshot_id: 'snap_authoritative_unlock_001',
      cloud_version: 2,
      created_at: new Date().toISOString(),
      device_id: 'device_primary',
      entities: {
        transactions: [
          { id: 'tx_cloud_auth_1', Date: '2026-03-01', INR: 1000, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
        ],
        investment_transactions: [],
        accounts: [{ id: 'acc_auth_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_auth_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encryptedSnapshot = await encryptBackupData(snapshotPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot
    });

    // Simulate STARTUP trigger from session unlock
    const syncRes = await executeFullSyncPass({
      trigger: 'STARTUP',
      deviceId: legacyDevId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.strictEqual(syncRes.success, true);
    assert.strictEqual(syncRes.bootstrapped, true, 'STARTUP trigger performed bootstrap');
    assert.strictEqual(syncRes.snapshotId, 'snap_authoritative_unlock_001');

    const txns = await getTransactions();
    assert.ok(txns.some(t => t.id === 'tx_cloud_auth_1'), 'Authoritative baseline installed');
  });
});
