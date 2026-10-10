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
  createCanonicalSnapshotPayload,
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

  await t.test('WATERMARK TEST A: Snapshot creation captures authoritative sync_peer_state watermarks and preserves determinism', async () => {
    const db = getDB();
    const now = new Date().toISOString();

    // 1. Seed sync_peer_state with peer C=5, peer D=5, and peer E with unreconciled 0
    await db.run(
      'INSERT INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['peer_dev_d', 5, 5, 'snap_1790400000000_v8', now]
    );
    await db.run(
      'INSERT INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['peer_dev_c', 5, 5, 'snap_1790400000000_v8', now]
    );
    await db.run(
      'INSERT INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['peer_dev_e', 10, 0, 'snap_1790400000000_v8', now]
    );

    // 2. Create canonical snapshot payload
    const { payload } = await createCanonicalSnapshotPayload({
      snapshotId: 'snap_1790500000000_v9',
      parentSnapshotId: 'snap_1790400000000_v8',
      cloudVersion: 9,
      deviceId: 'device_primary',
      db
    });

    // 3. Verify covered_peer_watermarks contains C=5, D=5 (and excludes E because reconciled=0)
    assert.ok(payload.covered_peer_watermarks, 'covered_peer_watermarks exists');
    assert.strictEqual(payload.covered_peer_watermarks.peer_dev_c, 5);
    assert.strictEqual(payload.covered_peer_watermarks.peer_dev_d, 5);
    assert.strictEqual(payload.covered_peer_watermarks.peer_dev_e, undefined, 'Unreconciled peer sequence excluded');

    // 4. Verify canonical checksum determinism with explicit key ordering
    const snap1 = await createCanonicalSnapshotPayload({
      snapshotId: 'snap_1790500000000_v9',
      parentSnapshotId: 'snap_1790400000000_v8',
      cloudVersion: 9,
      deviceId: 'device_primary',
      coveredPeerWatermarks: {
        peer_dev_d: 5,
        peer_dev_c: 5
      }
    });
    const snap2 = await createCanonicalSnapshotPayload({
      snapshotId: 'snap_1790500000000_v9',
      parentSnapshotId: 'snap_1790400000000_v8',
      cloudVersion: 9,
      deviceId: 'device_primary',
      coveredPeerWatermarks: {
        peer_dev_c: 5,
        peer_dev_d: 5
      }
    });
    assert.strictEqual(
      JSON.stringify(snap1.payload.covered_peer_watermarks),
      JSON.stringify(snap2.payload.covered_peer_watermarks),
      'Deterministic key ordering in covered_peer_watermarks'
    );
    assert.deepStrictEqual(Object.keys(snap1.payload.covered_peer_watermarks), ['peer_dev_c', 'peer_dev_d']);
  });

  await t.test('WATERMARK TEST B: Historical replay prevention — Fresh device skips packages covered by snapshot metadata (0 false conflicts)', async () => {
    const db = getDB();
    const freshDevId = 'dev_fresh_watermark_test_b';

    // 1. Prepare child snapshot v9 with covered_peer_watermarks C=5, D=5
    const v9Txn = { id: 'txn_v9_canonical_1', Date: '2026-03-01', INR: 1000, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' };
    const snapshotPayload = {
      snapshot_id: 'snap_1790500000000_v9',
      parent_snapshot_id: 'snap_1790400000000_v8',
      cloudVersion: 9,
      created_at: new Date().toISOString(),
      device_id: 'device_primary',
      covered_peer_watermarks: {
        peer_dev_c: 5,
        peer_dev_d: 5
      },
      entities: {
        transactions: [v9Txn],
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

    // 2. Peer C and Peer D uploaded packages 1..5 against parent baseline v8 (which would conflict if replayed)
    const pkgPayloadC = buildDeterministicPackagePayload({
      deviceId: 'peer_dev_c',
      startSequence: 1,
      endSequence: 5,
      baseSnapshotId: 'snap_1790400000000_v8',
      events: [{
        event_id: 'evt_c_1',
        device_id: 'peer_dev_c',
        sequence: 1,
        timestamp: new Date().toISOString(),
        collection: 'transactions',
        entity_id: 'txn_v9_canonical_1',
        operation: 'UPDATE',
        base_checksum: 'old_v8_base_checksum',
        new_checksum: 'peer_c_checksum',
        payload: { id: 'txn_v9_canonical_1', Date: '2026-03-01', INR: 500, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
      }]
    });
    const encPkgC = await encryptDeltaPackage(pkgPayloadC, TEST_SESSION_KEY);
    const drivePkgC = await mockDrive.uploadFile({ name: 'pkg_dev_c_000001_000005.finmanpkg', content: JSON.stringify(encPkgC) });

    const manifestC = createEmptyDeviceManifest({
      deviceId: 'peer_dev_c',
      baseSnapshotId: 'snap_1790400000000_v8',
      baseCloudVersion: 8,
      manifestRevision: 1,
      lifecycleState: 'ACTIVE'
    });
    manifestC.packages = [{
      package_id: 'pkg_peer_dev_c_000001_000005',
      start_sequence: 1,
      end_sequence: 5,
      event_count: 1,
      package_checksum: encPkgC.package_checksum,
      drive_file_id: drivePkgC.id
    }];
    await mockDrive.uploadFile({
      name: 'manifest_dev_peer_dev_c.json',
      content: JSON.stringify(manifestC)
    });

    // 3. Run bootstrapNewDevice on fresh device
    const bootRes = await bootstrapNewDevice({
      deviceId: freshDevId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.strictEqual(bootRes.success, true);
    assert.strictEqual(bootRes.snapshotId, 'snap_1790500000000_v9');

    // 4. Verify sync_peer_state was initialized to 5 for peer_dev_c and peer_dev_d
    const peerStateCRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', ['peer_dev_c']);
    const peerStateC = peerStateCRes.values?.[0];
    assert.ok(peerStateC, 'Peer state exists for peer_dev_c');
    assert.strictEqual(Number(peerStateC.last_staged_sequence), 5);
    assert.strictEqual(Number(peerStateC.last_reconciled_sequence), 5);
    assert.strictEqual(peerStateC.base_snapshot_id, 'snap_1790500000000_v9');

    const peerStateDRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', ['peer_dev_d']);
    const peerStateD = peerStateDRes.values?.[0];
    assert.ok(peerStateD, 'Peer state exists for peer_dev_d');
    assert.strictEqual(Number(peerStateD.last_staged_sequence), 5);
    assert.strictEqual(Number(peerStateD.last_reconciled_sequence), 5);

    // 5. Verify 0 packages were staged and 0 false conflicts were created
    assert.strictEqual(bootRes.inboundDeltas.stagedPackagesCount, 0, 'Parent packages skipped');
    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 0, 'Zero false conflicts generated');

    // 6. Verify local transactions and lifecycle state
    const localTxns = await getTransactions();
    assert.strictEqual(localTxns.length, 1);
    assert.strictEqual(localTxns[0].id, 'txn_v9_canonical_1');
    assert.strictEqual(localTxns[0].INR, 1000, 'Original v9 canonical value preserved');

    const lifecycle = await getDeviceLifecycleState(freshDevId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.ACTIVE);
  });

  await t.test('WATERMARK TEST C: Unmerged package — Post-boundary package D6 is pulled & reconciled, preserving genuine conflict', async () => {
    const db = getDB();
    const freshDevId = 'dev_fresh_watermark_test_c';

    // 1. Snapshot v9 covers C=5, D=5 with 2 initial transactions (e.g. 29,044 in production)
    const txnBase1 = { id: 'txn_base_1', Date: '2026-03-01', INR: 100, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' };
    const txnConflictedBase = { id: 'txn_conflicted_fixture', Date: '2026-03-01', INR: 500, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' };

    const snapshotPayload = {
      snapshot_id: 'snap_1790500000000_v9',
      parent_snapshot_id: 'snap_1790400000000_v8',
      cloud_version: 9,
      created_at: new Date().toISOString(),
      device_id: 'device_primary',
      covered_peer_watermarks: {
        peer_dev_c: 5,
        peer_dev_d: 5
      },
      entities: {
        transactions: [txnBase1, txnConflictedBase],
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

    // 2. Peer D has parent packages 1..5 (covered), plus unmerged package 6 (seq 6..6) containing the post-v9 transaction and genuine conflict
    const postV9Txn = { id: 'txn_post_v9_genuine', Date: '2026-03-02', INR: 350, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' };
    const postV9Checksum = await computeCanonicalSha256(postV9Txn);

    const mutatedTxn = { id: 'txn_conflicted_fixture', Date: '2026-03-01', INR: 9999, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' };
    const newTxnChecksum = await computeCanonicalSha256(mutatedTxn);

    const pkgPayloadD6 = buildDeterministicPackagePayload({
      deviceId: 'peer_dev_d',
      startSequence: 6,
      endSequence: 6,
      baseSnapshotId: 'snap_1790400000000_v8',
      baseCloudVersion: 8,
      events: [
        {
          event_id: 'evt_d_seq6_insert',
          device_id: 'peer_dev_d',
          sequence: 6,
          timestamp: new Date().toISOString(),
          collection: 'transactions',
          entity_id: postV9Txn.id,
          operation: 'INSERT',
          base_checksum: null,
          new_checksum: postV9Checksum,
          payload: postV9Txn
        },
        {
          event_id: 'evt_d_seq6_conflict',
          device_id: 'peer_dev_d',
          sequence: 6,
          timestamp: new Date().toISOString(),
          collection: 'transactions',
          entity_id: mutatedTxn.id,
          operation: 'UPDATE',
          base_checksum: 'divergent_base_checksum_from_v8',
          new_checksum: newTxnChecksum,
          payload: mutatedTxn
        }
      ]
    });
    const encPkgD6 = await encryptDeltaPackage(pkgPayloadD6, TEST_SESSION_KEY);
    const drivePkgD6 = await mockDrive.uploadFile({ name: 'pkg_peer_dev_d_000006_000006.finmanpkg', content: JSON.stringify(encPkgD6) });

    const manifestD = createEmptyDeviceManifest({
      deviceId: 'peer_dev_d',
      baseSnapshotId: 'snap_1790400000000_v8',
      baseCloudVersion: 8,
      manifestRevision: 2,
      lifecycleState: 'ACTIVE'
    });
    manifestD.packages = [
      {
        package_id: 'pkg_peer_dev_d_000001_000005',
        start_sequence: 1,
        end_sequence: 5,
        event_count: 5,
        base_snapshot_id: 'snap_1790400000000_v8',
        package_checksum: 'checksum_old_v8_pkg',
        drive_file_id: 'drive_dummy_v8'
      },
      {
        package_id: 'pkg_peer_dev_d_000006_000006',
        start_sequence: 6,
        end_sequence: 6,
        event_count: 2,
        base_snapshot_id: 'snap_1790400000000_v8',
        package_checksum: encPkgD6.package_checksum,
        drive_file_id: drivePkgD6.id
      }
    ];
    await mockDrive.uploadFile({
      name: 'manifest_dev_peer_dev_d.json',
      content: JSON.stringify(manifestD)
    });

    // 3. Run bootstrapNewDevice
    const bootRes = await bootstrapNewDevice({
      deviceId: freshDevId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.strictEqual(bootRes.success, true);
    // 4. Verify ONLY package 6 was staged and reconciled
    assert.strictEqual(bootRes.inboundDeltas.stagedPackagesCount, 1, 'Only unmerged package 6 was staged');

    // 5. Verify peer staging watermark updated to 6 for D
    const peerStateRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', ['peer_dev_d']);
    const peerState = peerStateRes.values?.[0];
    assert.strictEqual(Number(peerState.last_staged_sequence), 6);

    // 6. Verify total transactions count reached 3 (2 initial + 1 post-v9)
    const localTxns = await getTransactions();
    assert.strictEqual(localTxns.length, 3, 'Transaction count includes post-v9 transaction (29,045 fixture equivalent)');
    assert.ok(localTxns.some(t => t.id === 'txn_post_v9_genuine'), 'Post-v9 transaction present');

    // 7. Verify genuine conflict fixture was detected and preserved in sync_conflicts
    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 1, 'Genuine unresolved conflict preserved');
    assert.strictEqual(conflicts[0].entity_id, 'txn_conflicted_fixture');
  });

  await t.test('WATERMARK TEST D: Legacy snapshot compatibility — Starts with zero peer coverage, ignores live creator manifest, reconciles historical packages', async () => {
    const db = getDB();
    const freshDevId = 'dev_fresh_watermark_test_d';

    // 1. Legacy Snapshot without covered_peer_watermarks
    const snapshotPayload = {
      snapshot_id: 'snap_legacy_v9',
      parent_snapshot_id: 'snap_legacy_v8',
      cloud_version: 9,
      created_at: new Date().toISOString(),
      device_id: 'dev_creator_primary',
      entities: {
        transactions: [{ id: 'txn_legacy_1', Date: '2026-03-01', INR: 100, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }],
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

    // 2. Snapshot creator manifest exists on Drive with high post-snapshot watermarks (which must NOT be consulted)
    const creatorManifest = createEmptyDeviceManifest({
      deviceId: 'dev_creator_primary',
      baseSnapshotId: 'snap_legacy_v9',
      baseCloudVersion: 9,
      manifestRevision: 15,
      lifecycleState: 'ACTIVE'
    });
    creatorManifest.watermarks = {
      acknowledged_peer_sequences: {
        peer_dev_d: 99
      }
    };
    await mockDrive.uploadFile({
      name: 'manifest_dev_dev_creator_primary.json',
      content: JSON.stringify(creatorManifest)
    });

    // 3. Peer D has package 1 (seq 1..1) based on legacy v8 containing a historical unmerged transaction
    const txnD = { id: 'txn_d_historical_unmerged', Date: '2026-03-01', INR: 400, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' };
    const txnDChecksum = await computeCanonicalSha256(txnD);

    const pkgPayloadD = buildDeterministicPackagePayload({
      deviceId: 'peer_dev_d',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: 'snap_legacy_v8',
      baseCloudVersion: 8,
      events: [{
        event_id: 'evt_d_hist_1',
        device_id: 'peer_dev_d',
        sequence: 1,
        timestamp: new Date().toISOString(),
        collection: 'transactions',
        entity_id: txnD.id,
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: txnDChecksum,
        payload: txnD
      }]
    });
    const encPkgD = await encryptDeltaPackage(pkgPayloadD, TEST_SESSION_KEY);
    const drivePkgD = await mockDrive.uploadFile({ name: 'pkg_dev_d_000001_000001.finmanpkg', content: JSON.stringify(encPkgD) });

    const manifestD = createEmptyDeviceManifest({
      deviceId: 'peer_dev_d',
      baseSnapshotId: 'snap_legacy_v8',
      baseCloudVersion: 8,
      manifestRevision: 1,
      lifecycleState: 'ACTIVE'
    });
    manifestD.packages = [{
      package_id: 'pkg_dev_d_000001_000001',
      start_sequence: 1,
      end_sequence: 1,
      event_count: 1,
      base_snapshot_id: 'snap_legacy_v8',
      package_checksum: encPkgD.package_checksum,
      drive_file_id: drivePkgD.id
    }];
    await mockDrive.uploadFile({
      name: 'manifest_dev_peer_dev_d.json',
      content: JSON.stringify(manifestD)
    });

    // 4. Run bootstrap on fresh device
    const bootRes = await bootstrapNewDevice({
      deviceId: freshDevId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.strictEqual(bootRes.success, true);
    // Verify package 1 was NOT skipped (it was staged and reconciled!)
    assert.strictEqual(bootRes.inboundDeltas.stagedPackagesCount, 1, 'Historical package 1 was pulled (not skipped)');
    assert.strictEqual(bootRes.reconciliation.reconciledCount, 1, 'Historical transaction reconciled cleanly');

    // Verify peer state watermark advanced legitimately to 1 (not falsely to 99 from creator manifest)
    const peerStateDRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', ['peer_dev_d']);
    assert.strictEqual(Number(peerStateDRes.values?.[0]?.last_reconciled_sequence), 1, 'Reconciled sequence reflects actual package 1, not live creator manifest');

    // Verify transaction is present locally
    const txns = await getTransactions();
    assert.ok(txns.some(t => t.id === 'txn_d_historical_unmerged'), 'Historical unmerged transaction was preserved and inserted');
  });

  await t.test('WATERMARK TEST E: Fail-closed behavior — Watermark initialization failure aborts bootstrap with BOOTSTRAP_FAILED', async () => {
    const db = getDB();
    const failDevId = 'dev_fail_closed_test_e';

    // 1. Snapshot v9 with covered_peer_watermarks
    const snapshotPayload = {
      snapshot_id: 'snap_1790500000000_v9',
      parent_snapshot_id: 'snap_1790400000000_v8',
      cloud_version: 9,
      created_at: new Date().toISOString(),
      device_id: 'device_primary',
      covered_peer_watermarks: {
        peer_dev_c: 5
      },
      entities: {
        transactions: [{ id: 'txn_init', Date: '2026-03-01', INR: 100, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }],
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

    // 2. Mock DB / IDB failure on sync_peer_state insert
    const rawIdb = getRawIDB();
    const origTx = rawIdb?.transaction;
    if (rawIdb && origTx) {
      rawIdb.transaction = function(stores, mode) {
        if (Array.isArray(stores) ? stores.includes('sync_peer_state') : stores === 'sync_peer_state') {
          throw new Error('Disk I/O error writing sync_peer_state');
        }
        return origTx.call(this, stores, mode);
      };
    }
    const originalRun = db.run;
    db.run = async (sql, params) => {
      if (sql && sql.includes('sync_peer_state')) {
        throw new Error('Disk I/O error writing sync_peer_state');
      }
      return originalRun.call(db, sql, params);
    };

    try {
      // 3. bootstrapNewDevice must reject with BOOTSTRAP_FAILED
      await assert.rejects(
        async () => {
          await bootstrapNewDevice({
            deviceId: failDevId,
            sessionKey: TEST_SESSION_KEY,
            driveClient: mockDrive
          });
        },
        (err) => {
          assert.ok(err.message.startsWith('BOOTSTRAP_FAILED: Failed to initialize baseline lineage peer watermarks'), `Error message should be BOOTSTRAP_FAILED, got: ${err.message}`);
          return true;
        }
      );
    } finally {
      if (rawIdb && origTx) rawIdb.transaction = origTx;
      db.run = originalRun;
    }

    // 4. Verify no peer delta packages were staged
    const stagedPkgs = (await db.query('SELECT * FROM sync_staged_packages')).values || [];
    assert.strictEqual(stagedPkgs.length, 0, 'Zero packages staged');

    // 5. Verify no sync_conflicts rows were created
    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 0, 'Zero conflicts created');

    // 6. Verify lifecycle remains JOINING (not ACTIVE)
    const lifecycle = await getDeviceLifecycleState(failDevId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.JOINING, 'Lifecycle must remain JOINING on failure');

    // 7. Verify no ACTIVE manifest published for failDevId
    const ownManifestFiles = await mockDrive.findFiles({ name: `manifest_dev_${failDevId}.json` });
    assert.strictEqual(ownManifestFiles.length, 0, 'No active manifest published on abort');

    // 8. Verify no outbound delta queue entries created
    const queueRows = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    const pendingOutbound = queueRows.filter(r => r.status !== 'ACKNOWLEDGED');
    assert.strictEqual(pendingOutbound.length, 0, 'Zero pending outbound deltas generated');
  });

  await t.test('CREATOR LINEAGE TEST 1: Creator pre-snapshot packages are skipped safely without false gap errors', async () => {
    const db = getDB();
    const freshDevId = 'dev_edge_test_1';
    const creatorDevId = 'dev_creator_c';

    // 1. Snapshot v10 authored by creatorDevId with parent v9
    const snap10Payload = {
      snapshot_id: 'snap_1790600000000_v10',
      parent_snapshot_id: 'snap_1790500000000_v9',
      cloud_version: 10,
      created_at: new Date().toISOString(),
      device_id: creatorDevId,
      covered_peer_watermarks: {
        peer_dev_d: 5
      },
      entities: {
        transactions: [
          { id: 'txn_c_v10_base', Date: '2026-03-01', INR: 1000, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
        ],
        investment_transactions: [],
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encSnap = await encryptBackupData(snap10Payload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({
      name: SNAPSHOT_FILENAME,
      content: encSnap
    });

    // 2. Creator has historical packages on v9 with sequence gaps (seq 1..1, seq 3..3)
    const pkgC1 = buildDeterministicPackagePayload({
      deviceId: creatorDevId,
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: 'snap_1790500000000_v9',
      events: [{
        event_id: 'ev_c_1',
        device_id: creatorDevId,
        sequence: 1,
        timestamp: '2026-03-01T00:00:00Z',
        collection: 'transactions',
        entity_id: 'txn_old_1',
        operation: 'INSERT',
        payload: { id: 'txn_old_1', Date: '2026-03-01', INR: 50, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
      }]
    });
    const encPkgC1 = await encryptDeltaPackage(pkgC1, TEST_SESSION_KEY);
    const driveC1 = await mockDrive.uploadFile({
      name: `${pkgC1.package_id}.pkg`,
      content: JSON.stringify(encPkgC1)
    });

    const pkgC3 = buildDeterministicPackagePayload({
      deviceId: creatorDevId,
      startSequence: 3,
      endSequence: 3,
      baseSnapshotId: 'snap_1790500000000_v9',
      events: [{
        event_id: 'ev_c_3',
        device_id: creatorDevId,
        sequence: 3,
        timestamp: '2026-03-01T00:00:00Z',
        collection: 'transactions',
        entity_id: 'txn_old_3',
        operation: 'INSERT',
        payload: { id: 'txn_old_3', Date: '2026-03-01', INR: 150, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
      }]
    });
    const encPkgC3 = await encryptDeltaPackage(pkgC3, TEST_SESSION_KEY);
    const driveC3 = await mockDrive.uploadFile({
      name: `${pkgC3.package_id}.pkg`,
      content: JSON.stringify(encPkgC3)
    });

    // Creator manifest on v9 containing both packages
    const creatorManifest = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: creatorDevId,
      manifest_revision: 5,
      updated_at: new Date().toISOString(),
      base_snapshot_id: 'snap_1790500000000_v9',
      device_lifecycle_state: 'ACTIVE',
      packages: [
        { package_id: pkgC1.package_id, drive_file_id: driveC1.id, start_sequence: 1, end_sequence: 1, package_checksum: encPkgC1.package_checksum, base_snapshot_id: 'snap_1790500000000_v9' },
        { package_id: pkgC3.package_id, drive_file_id: driveC3.id, start_sequence: 3, end_sequence: 3, package_checksum: encPkgC3.package_checksum, base_snapshot_id: 'snap_1790500000000_v9' }
      ]
    };
    await mockDrive.uploadFile({
      name: `manifest_dev_${creatorDevId}.json`,
      content: JSON.stringify(creatorManifest)
    });

    // 3. Bootstrap fresh device
    const res = await bootstrapNewDevice({
      deviceId: freshDevId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.inboundDeltas.stagedPackagesCount, 0, 'Zero pre-snapshot creator packages staged');
    assert.strictEqual(res.recordsBootstrapped.transactions, 1, '1 baseline transaction installed');
    const txns = await getTransactions();
    assert.strictEqual(txns.length, 1);
    assert.strictEqual(txns[0].id, 'txn_c_v10_base');
    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 0, 'Zero false conflicts created');
  });

  await t.test('CREATOR LINEAGE TEST 2: Creator genuine post-snapshot package is processed and reconciled', async () => {
    const freshDevId = 'dev_edge_test_2';
    const creatorDevId = 'dev_creator_c';

    // 1. Snapshot v10
    const snap10Payload = {
      snapshot_id: 'snap_1790600000000_v10',
      parent_snapshot_id: 'snap_1790500000000_v9',
      cloud_version: 10,
      created_at: new Date().toISOString(),
      device_id: creatorDevId,
      covered_peer_watermarks: {},
      entities: {
        transactions: [
          { id: 'txn_base', Date: '2026-03-01', INR: 100, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
        ],
        investment_transactions: [],
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encSnap = await encryptBackupData(snap10Payload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({
      name: SNAPSHOT_FILENAME,
      content: encSnap
    });

    // 2. Creator pre-snapshot package (seq 1..5 on v9)
    const pkgPre = buildDeterministicPackagePayload({
      deviceId: creatorDevId,
      startSequence: 1,
      endSequence: 5,
      baseSnapshotId: 'snap_1790500000000_v9',
      events: []
    });
    const encPkgPre = await encryptDeltaPackage(pkgPre, TEST_SESSION_KEY);
    const drivePre = await mockDrive.uploadFile({
      name: `${pkgPre.package_id}.pkg`,
      content: JSON.stringify(encPkgPre)
    });

    // 3. Creator post-snapshot package (seq 6..6 on v10)
    const pkgPost = buildDeterministicPackagePayload({
      deviceId: creatorDevId,
      startSequence: 6,
      endSequence: 6,
      baseSnapshotId: 'snap_1790600000000_v10',
      events: [{
        event_id: 'ev_post_6',
        device_id: creatorDevId,
        sequence: 6,
        timestamp: '2026-03-02T00:00:00Z',
        collection: 'transactions',
        entity_id: 'txn_post_6',
        operation: 'INSERT',
        payload: { id: 'txn_post_6', Date: '2026-03-02', INR: 250, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
      }]
    });
    const encPkgPost = await encryptDeltaPackage(pkgPost, TEST_SESSION_KEY);
    const drivePost = await mockDrive.uploadFile({
      name: `${pkgPost.package_id}.pkg`,
      content: JSON.stringify(encPkgPost)
    });

    // Creator manifest on v10
    const creatorManifest = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: creatorDevId,
      manifest_revision: 6,
      updated_at: new Date().toISOString(),
      base_snapshot_id: 'snap_1790600000000_v10',
      device_lifecycle_state: 'ACTIVE',
      packages: [
        { package_id: pkgPre.package_id, drive_file_id: drivePre.id, start_sequence: 1, end_sequence: 5, package_checksum: encPkgPre.package_checksum, base_snapshot_id: 'snap_1790500000000_v9' },
        { package_id: pkgPost.package_id, drive_file_id: drivePost.id, start_sequence: 6, end_sequence: 6, package_checksum: encPkgPost.package_checksum, base_snapshot_id: 'snap_1790600000000_v10' }
      ]
    };
    await mockDrive.uploadFile({
      name: `manifest_dev_${creatorDevId}.json`,
      content: JSON.stringify(creatorManifest)
    });

    // 4. Bootstrap
    const res = await bootstrapNewDevice({
      deviceId: freshDevId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.inboundDeltas.stagedPackagesCount, 1, 'Post-snapshot package 6 staged');
    assert.strictEqual(res.reconciliation.reconciledCount, 1, 'Post-snapshot transaction reconciled');
    const txns = await getTransactions();
    assert.strictEqual(txns.length, 2);
    assert.ok(txns.some(t => t.id === 'txn_post_6'));
  });

  await t.test('CREATOR LINEAGE TEST 3: Ambiguous or unknown creator package lineage fails closed', async () => {
    const freshDevId = 'dev_edge_test_3';
    const creatorDevId = 'dev_creator_c';

    const snapPayload = {
      snapshot_id: 'snap_1790600000000_v10',
      parent_snapshot_id: 'snap_1790500000000_v9',
      cloud_version: 10,
      created_at: new Date().toISOString(),
      device_id: creatorDevId,
      entities: { transactions: [], investment_transactions: [], accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }], categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }] }
    };
    const encSnap = await encryptBackupData(snapPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    // Creator package with unknown unparseable base
    const badPkg = buildDeterministicPackagePayload({
      deviceId: creatorDevId,
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: 'snap_corrupt_unknown_alien_base',
      events: []
    });
    const encBad = await encryptDeltaPackage(badPkg, TEST_SESSION_KEY);
    const driveBad = await mockDrive.uploadFile({ name: `${badPkg.package_id}.pkg`, content: JSON.stringify(encBad) });

    const creatorManifest = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: creatorDevId,
      base_snapshot_id: 'snap_1790500000000_v9',
      packages: [{ package_id: badPkg.package_id, drive_file_id: driveBad.id, start_sequence: 1, end_sequence: 1, package_checksum: encBad.package_checksum, base_snapshot_id: 'snap_corrupt_unknown_alien_base' }]
    };
    await mockDrive.uploadFile({ name: `manifest_dev_${creatorDevId}.json`, content: JSON.stringify(creatorManifest) });

    await assert.rejects(
      async () => {
        await bootstrapNewDevice({ deviceId: freshDevId, sessionKey: TEST_SESSION_KEY, driveClient: mockDrive });
      },
      (err) => {
        assert.ok(err.message.includes('UNKNOWN_CREATOR_PACKAGE_LINEAGE'), `Expected UNKNOWN_CREATOR_PACKAGE_LINEAGE, got: ${err.message}`);
        return true;
      }
    );
  });

  await t.test('CREATOR LINEAGE TEST 4: External peer D6 processed and genuine conflict preserved under authoritative watermark 5', async () => {
    const freshDevId = 'dev_edge_test_4';
    const creatorDevId = 'dev_creator_c';
    const peerDevD = 'peer_dev_d';

    // Snapshot v10 with covered_peer_watermarks = {"peer_dev_d": 5}
    const snapPayload = {
      snapshot_id: 'snap_1790600000000_v10',
      parent_snapshot_id: 'snap_1790500000000_v9',
      cloud_version: 10,
      created_at: new Date().toISOString(),
      device_id: creatorDevId,
      covered_peer_watermarks: { [peerDevD]: 5 },
      entities: {
        transactions: [
          { id: 'txn_shared_conflict', Date: '2026-03-01', INR: 500, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
        ],
        investment_transactions: [],
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encSnap = await encryptBackupData(snapPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    // D's Package 6 on base v9 modifying txn_shared_conflict concurrently
    const initialCanonical = await computeCanonicalSha256({ id: 'txn_shared_conflict', Date: '2026-03-01', INR: 100, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' });
    const pkgD6 = buildDeterministicPackagePayload({
      deviceId: peerDevD,
      startSequence: 6,
      endSequence: 6,
      baseSnapshotId: 'snap_1790500000000_v9',
      events: [{
        event_id: 'ev_d_6',
        device_id: peerDevD,
        sequence: 6,
        timestamp: '2026-03-01T12:00:00Z',
        collection: 'transactions',
        entity_id: 'txn_shared_conflict',
        operation: 'UPDATE',
        base_checksum: initialCanonical,
        payload: { id: 'txn_shared_conflict', Date: '2026-03-01', INR: 999, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
      }]
    });
    const encPkgD6 = await encryptDeltaPackage(pkgD6, TEST_SESSION_KEY);
    const driveD6 = await mockDrive.uploadFile({ name: `${pkgD6.package_id}.pkg`, content: JSON.stringify(encPkgD6) });

    const manifestD = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: peerDevD,
      base_snapshot_id: 'snap_1790500000000_v9',
      packages: [
        { package_id: pkgD6.package_id, drive_file_id: driveD6.id, start_sequence: 6, end_sequence: 6, package_checksum: encPkgD6.package_checksum, base_snapshot_id: 'snap_1790500000000_v9' }
      ]
    };
    await mockDrive.uploadFile({ name: `manifest_dev_${peerDevD}.json`, content: JSON.stringify(manifestD) });

    const res = await bootstrapNewDevice({ deviceId: freshDevId, sessionKey: TEST_SESSION_KEY, driveClient: mockDrive });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.inboundDeltas.stagedPackagesCount, 1, 'D6 package staged');
    assert.strictEqual(res.reconciliation.conflictCount, 1, 'Genuine conflict preserved');
    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 1, 'Exactly 1 genuine conflict recorded');
  });

  await t.test('CREATOR LINEAGE TEST 5: Failed bootstrap followed by reload produces no false conflicts', async () => {
    const db = getDB();
    const freshDevId = 'dev_edge_test_5';

    const snapPayload = {
      snapshot_id: 'snap_1790600000000_v10',
      parent_snapshot_id: 'snap_1790500000000_v9',
      cloud_version: 10,
      created_at: new Date().toISOString(),
      device_id: 'dev_creator_c',
      entities: {
        transactions: [{ id: 'txn_safe_1', Date: '2026-03-01', INR: 100, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }],
        investment_transactions: [],
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encSnap = await encryptBackupData(snapPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    // Mock drive reading failure mid-stage
    const originalRead = mockDrive.readFile;
    mockDrive.readFile = async () => { throw new Error('Simulated network failure mid-download'); };

    const peerPkg = buildDeterministicPackagePayload({
      deviceId: 'peer_dev_x',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: 'snap_1790600000000_v10',
      events: []
    });
    const encPeer = await encryptDeltaPackage(peerPkg, TEST_SESSION_KEY);
    const drivePeer = await mockDrive.uploadFile({ name: `${peerPkg.package_id}.pkg`, content: JSON.stringify(encPeer) });
    await mockDrive.uploadFile({
      name: `manifest_dev_peer_dev_x.json`,
      content: JSON.stringify({
        schema_version: 1,
        manifest_type: 'DEVICE_MANIFEST',
        device_id: 'peer_dev_x',
        base_snapshot_id: 'snap_1790600000000_v10',
        packages: [{ package_id: peerPkg.package_id, drive_file_id: drivePeer.id, start_sequence: 1, end_sequence: 1, package_checksum: encPeer.package_checksum, base_snapshot_id: 'snap_1790600000000_v10' }]
      })
    });

    try {
      await assert.rejects(async () => {
        await bootstrapNewDevice({ deviceId: freshDevId, sessionKey: TEST_SESSION_KEY, driveClient: mockDrive });
      });
    } finally {
      mockDrive.readFile = originalRead;
    }

    // Verify lifecycle remains JOINING
    const lifecycle = await getDeviceLifecycleState(freshDevId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.JOINING);

    // Simulate page reload: reconcileStagedEvents must refuse execution and produce 0 conflicts
    const recon = await (await import('../services/deltaReconciliation.js')).reconcileStagedEvents({});
    assert.strictEqual(recon.reconciledCount, 0);
    assert.strictEqual(recon.conflictCount, 0);
    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 0, 'Zero conflicts on reload after failed bootstrap');
  });

  await t.test('CREATOR LINEAGE TEST 6: Attempt-scoped cleanup preserves unrelated staged records', async () => {
    const db = getDB();
    const freshDevId = 'dev_edge_test_6';

    // Insert an unrelated staged event
    await db.run(
      'INSERT OR REPLACE INTO sync_staged_packages (package_id, device_id, start_sequence, end_sequence, event_count, package_checksum, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['pkg_unrelated_existing', 'peer_unrelated', 1, 1, 1, 'chk_123', new Date().toISOString(), 'STAGED']
    );
    await db.run(
      'INSERT OR REPLACE INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, tombstone_generation, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['ev_unrelated', 'pkg_unrelated_existing', 'peer_unrelated', 1, new Date().toISOString(), 'transactions', 'txn_u', 'INSERT', null, 'chk_u', 0, new Date().toISOString(), 'STAGED']
    );

    // Bootstrap fails
    const originalRead = mockDrive.readFile;
    mockDrive.readFile = async () => { throw new Error('Simulated failure'); };
    try {
      await assert.rejects(async () => {
        await bootstrapNewDevice({ deviceId: freshDevId, sessionKey: TEST_SESSION_KEY, driveClient: mockDrive });
      });
    } finally {
      mockDrive.readFile = originalRead;
    }

    // Unrelated staged record must still exist
    const stagedPkgs = (await db.query('SELECT * FROM sync_staged_packages WHERE package_id = ?', ['pkg_unrelated_existing'])).values || [];
    assert.strictEqual(stagedPkgs.length, 1, 'Unrelated staged package preserved');
  });

  await t.test('CREATOR LINEAGE TEST 7: JOINING lifecycle strictly blocks manifest publication and outbound delta uploads', async () => {
    const testDevId = 'dev_joining_test_7';
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.JOINING, testDevId);

    // Attempting to publish active manifest must throw
    await assert.rejects(
      async () => {
        await writeOwnDeviceManifest({
          deviceId: testDevId,
          driveClient: mockDrive,
          manifestData: createEmptyDeviceManifest({ deviceId: testDevId, device_lifecycle_state: 'ACTIVE' })
        });
      },
      (err) => {
        assert.ok(err.message.includes('DEVICE_NOT_INITIALIZED_FOR_SYNC'), `Expected DEVICE_NOT_INITIALIZED_FOR_SYNC, got: ${err.message}`);
        return true;
      }
    );

    // Attempting outbound upload must throw
    await assert.rejects(
      async () => {
        await uploadPendingDeltas({ deviceId: testDevId, driveClient: mockDrive, sessionKey: TEST_SESSION_KEY });
      },
      (err) => {
        assert.ok(err.message.includes('DEVICE_NOT_INITIALIZED_FOR_SYNC'), `Expected DEVICE_NOT_INITIALIZED_FOR_SYNC, got: ${err.message}`);
        return true;
      }
    );
  });

  await t.test('CREATOR LINEAGE TEST 8: Legacy snapshot without covered_peer_watermarks remains safe and functional', async () => {
    const freshDevId = 'dev_legacy_test_8';
    const legacySnapPayload = {
      snapshot_id: 'snap_legacy_v7',
      parent_snapshot_id: '',
      cloud_version: 7,
      created_at: new Date().toISOString(),
      device_id: 'device_legacy_author',
      covered_peer_watermarks: null,
      entities: {
        transactions: [{ id: 'txn_leg_1', Date: '2026-01-01', INR: 50, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }],
        investment_transactions: [],
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encSnap = await encryptBackupData(legacySnapPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    const res = await bootstrapNewDevice({ deviceId: freshDevId, sessionKey: TEST_SESSION_KEY, driveClient: mockDrive });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.recordsBootstrapped.transactions, 1);
    const lifecycle = await getDeviceLifecycleState(freshDevId);
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.ACTIVE);
  });
});
