/**
 * Phase 6D.1: No-Op Sync & Concurrency Hardening Test Suite
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'node:test';
import assert from 'node:assert';
import { initDB, closeDB, getDB } from '../database/db.js';
import { bulkImport, getTransactions } from '../database/transactions.js';
import { recordTombstone } from '../database/tombstones.js';
import { getSetting, setSetting } from '../database/settings.js';
import {
  executeCloudSync,
  previewCloudSync,
  reconcile3Way,
  createCanonicalSnapshotPayload,
  buildEntityManifest,
  readLocalEntities,
  canonicalizeEntity,
  SYNC_STATUS,
  SNAPSHOT_FILENAME
} from '../services/cloudSyncEngine.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';

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

// Mock Drive Transport with Call Tracking
function createMockDrive(initialFile = null) {
  let file = initialFile ? { ...initialFile } : null;
  let uploadCount = 0;
  let readCount = 0;
  let findCount = 0;

  return {
    getFile: () => file,
    getUploadCount: () => uploadCount,
    getReadCount: () => readCount,
    getFindCount: () => findCount,
    setFile: (f) => { file = f; },

    async findAppDataFile(filename, token) {
      findCount++;
      return file ? { id: file.id, name: file.name, version: file.version, modifiedTime: file.modifiedTime } : null;
    },
    async readAppDataFile(fileId, token) {
      readCount++;
      if (!file || file.id !== fileId) throw new Error('File not found in mock drive');
      return file.content;
    },
    async uploadAppDataFile(filename, content, mimeType, token) {
      uploadCount++;
      const newVersion = file ? (file.version || 1) + 1 : 1;
      file = {
        id: file ? file.id : `mock_file_${Date.now()}`,
        name: filename,
        content,
        version: newVersion,
        modifiedTime: new Date().toISOString()
      };
      return { id: file.id, version: newVersion };
    }
  };
}

test('Phase 6D.1 — True No-Op Sync and Concurrency Hardening', async (t) => {
  const testPin = '9876';
  const testToken = 'mock_auth_token';

  const resetDB = async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    const db = await initDB();
    return db;
  };

  const baseTxns = [
    { id: 'txn_1', Date: '01/01/2026', INR: 100, 'Income/Expense': 'Expense', Account: 'Cash', Category: 'Food', Note: 'breakfast' },
    { id: 'txn_2', Date: '02/01/2026', INR: 200, 'Income/Expense': 'Income', Account: 'Bank', Category: 'Salary', Note: 'bonus' }
  ];

  await t.test('TEST 1 & 2: Identical local/cloud state produces NO_CHANGES and zero cloud uploads', async () => {
    const db = await resetDB();
    await bulkImport(baseTxns, { firstImport: false });

    const initialEntities = await readLocalEntities(db);
    const initialSnapshotId = 'snap_clean_bootstrap_001';
    const { payload } = await createCanonicalSnapshotPayload({
      entities: initialEntities,
      snapshotId: initialSnapshotId,
      cloudVersion: 1,
      deviceId: 'device_C'
    });
    const encryptedCloud = await encryptBackupData(payload, testPin);

    // Device D bootstrapped this snapshot: set base manifest and last snapshot id
    const baseManifest = await buildEntityManifest(initialEntities);
    await setSetting('sync_base_manifest', JSON.stringify(baseManifest));
    await setSetting('sync_last_snapshot_id', initialSnapshotId);

    const mockDrive = createMockDrive({
      id: 'drive_file_001',
      name: SNAPSHOT_FILENAME,
      content: encryptedCloud,
      version: 1,
      modifiedTime: '2026-09-25T10:00:00.000Z'
    });

    // Execute Sync Now on identical state
    const syncRes = await executeCloudSync({
      pin: testPin,
      accessToken: testToken,
      deviceId: 'device_D',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(syncRes.status, SYNC_STATUS.NO_CHANGES, 'Status must be NO_CHANGES');
    assert.strictEqual(syncRes.cloudWritePerformed, false, 'cloudWritePerformed must be false');
    assert.strictEqual(syncRes.snapshotId, initialSnapshotId, 'Snapshot ID must be preserved');
    assert.strictEqual(syncRes.cloudVersion, 1, 'Cloud version must remain 1');
    assert.strictEqual(syncRes.localChangesApplied, 0, 'Zero local changes applied');
    assert.strictEqual(syncRes.cloudChangesUploaded, 0, 'Zero cloud changes uploaded');
    assert.strictEqual(mockDrive.getUploadCount(), 0, 'UploadAppDataFile must NOT be called on No-Op');
  });

  await t.test('TEST 3: Repeated Sync Now maintains No-Op and preserves snapshot ID', async () => {
    const db = await resetDB();
    await bulkImport(baseTxns, { firstImport: false });

    const initialEntities = await readLocalEntities(db);
    const initialSnapshotId = 'snap_clean_bootstrap_001';
    const { payload } = await createCanonicalSnapshotPayload({
      entities: initialEntities,
      snapshotId: initialSnapshotId,
      cloudVersion: 1,
      deviceId: 'device_C'
    });
    const encryptedCloud = await encryptBackupData(payload, testPin);

    const baseManifest = await buildEntityManifest(initialEntities);
    await setSetting('sync_base_manifest', JSON.stringify(baseManifest));
    await setSetting('sync_last_snapshot_id', initialSnapshotId);

    const mockDrive = createMockDrive({
      id: 'drive_file_001',
      name: SNAPSHOT_FILENAME,
      content: encryptedCloud,
      version: 1,
      modifiedTime: '2026-09-25T10:00:00.000Z'
    });

    // Sync 1
    const syncRes1 = await executeCloudSync({
      pin: testPin,
      accessToken: testToken,
      deviceId: 'device_D',
      dbInstance: db,
      driveClient: mockDrive
    });
    assert.strictEqual(syncRes1.status, SYNC_STATUS.NO_CHANGES);
    assert.strictEqual(syncRes1.cloudWritePerformed, false);
    assert.strictEqual(mockDrive.getUploadCount(), 0);

    // Sync 2 (immediate re-sync)
    const syncRes2 = await executeCloudSync({
      pin: testPin,
      accessToken: testToken,
      deviceId: 'device_D',
      dbInstance: db,
      driveClient: mockDrive
    });
    assert.strictEqual(syncRes2.status, SYNC_STATUS.NO_CHANGES);
    assert.strictEqual(syncRes2.cloudWritePerformed, false);
    assert.strictEqual(syncRes2.snapshotId, initialSnapshotId);
    assert.strictEqual(mockDrive.getUploadCount(), 0);
  });

  await t.test('TEST 4: One local change => exactly one cloud write & incremented version', async () => {
    const db = await resetDB();
    await bulkImport(baseTxns, { firstImport: false });

    const baseEntities = await readLocalEntities(db);
    const initialSnapshotId = 'snap_base_001';
    const { payload } = await createCanonicalSnapshotPayload({
      entities: baseEntities,
      snapshotId: initialSnapshotId,
      cloudVersion: 1,
      deviceId: 'device_C'
    });
    const encryptedCloud = await encryptBackupData(payload, testPin);

    const baseManifest = await buildEntityManifest(baseEntities);
    await setSetting('sync_base_manifest', JSON.stringify(baseManifest));
    await setSetting('sync_last_snapshot_id', initialSnapshotId);

    // Add 1 local transaction
    await bulkImport([
      { id: 'txn_new_local', Date: '04/01/2026', INR: 50, 'Income/Expense': 'Expense', Account: 'Cash', Category: 'Food', Note: 'chai' }
    ], { firstImport: false });

    const mockDrive = createMockDrive({
      id: 'drive_file_001',
      name: SNAPSHOT_FILENAME,
      content: encryptedCloud,
      version: 1,
      modifiedTime: '2026-09-25T10:00:00.000Z'
    });

    const syncRes = await executeCloudSync({
      pin: testPin,
      accessToken: testToken,
      deviceId: 'device_D',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(syncRes.status, SYNC_STATUS.SUCCESS);
    assert.strictEqual(syncRes.cloudWritePerformed, true, 'cloudWritePerformed must be true');
    assert.notStrictEqual(syncRes.snapshotId, initialSnapshotId, 'New snapshot ID must be generated');
    assert.strictEqual(syncRes.cloudVersion, 2, 'Cloud version must increment to 2');
    assert.strictEqual(syncRes.cloudChangesUploaded, 1, 'Exactly 1 change uploaded to cloud');
    assert.strictEqual(mockDrive.getUploadCount(), 1, 'Exactly 1 upload performed');
  });

  await t.test('TEST 5: One cloud change => pulled to local, ZERO cloud upload performed', async () => {
    const db = await resetDB();
    // Device D initially only has txn_1
    await bulkImport([baseTxns[0]], { firstImport: false });
    const initialLocalEntities = await readLocalEntities(db);

    const initialSnapshotId = 'snap_base_001';
    const baseManifest = await buildEntityManifest(initialLocalEntities);
    await setSetting('sync_base_manifest', JSON.stringify(baseManifest));
    await setSetting('last_snapshot_id', initialSnapshotId);

    // Cloud has txn_1 and txn_2
    const cloudEntities = {
      ...initialLocalEntities,
      transactions: [...initialLocalEntities.transactions, { id: 'txn_2', Date: '02/01/2026', INR: 200, 'Income/Expense': 'Income', Account: 'Cash', Category: 'Food', Note: 'bonus' }]
    };

    const { payload } = await createCanonicalSnapshotPayload({
      entities: cloudEntities,
      snapshotId: initialSnapshotId,
      cloudVersion: 1,
      deviceId: 'device_C'
    });
    const encryptedCloud = await encryptBackupData(payload, testPin);

    const mockDrive = createMockDrive({
      id: 'drive_file_001',
      name: SNAPSHOT_FILENAME,
      content: encryptedCloud,
      version: 1,
      modifiedTime: '2026-09-25T10:00:00.000Z'
    });

    const syncRes = await executeCloudSync({
      pin: testPin,
      accessToken: testToken,
      deviceId: 'device_D',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(syncRes.status, SYNC_STATUS.SUCCESS);
    assert.strictEqual(syncRes.cloudWritePerformed, false, 'Pull-only sync must NOT upload to cloud');
    assert.strictEqual(syncRes.snapshotId, initialSnapshotId, 'Snapshot ID must remain unchanged');
    assert.strictEqual(syncRes.cloudVersion, 1, 'Cloud version must remain unchanged');
    assert.strictEqual(syncRes.localChangesApplied, 1, '1 transaction applied locally');
    assert.strictEqual(syncRes.cloudChangesUploaded, 0, '0 changes uploaded');
    assert.strictEqual(mockDrive.getUploadCount(), 0, 'Drive upload count must be 0');

    // Verify local DB now has both transactions
    const localTxns = await getTransactions();
    assert.strictEqual(localTxns.length, 2, 'Local database must contain both transactions');
  });

  await t.test('TEST 6: Stale cloud head detected before upload triggers clean retry', async () => {
    const db = await resetDB();
    await bulkImport(baseTxns, { firstImport: false });

    const baseEntities = await readLocalEntities(db);
    const initialSnapshotId = 'snap_base_001';
    const { payload } = await createCanonicalSnapshotPayload({
      entities: baseEntities,
      snapshotId: initialSnapshotId,
      cloudVersion: 1,
      deviceId: 'device_C'
    });
    const encryptedCloud = await encryptBackupData(payload, testPin);

    const baseManifest = await buildEntityManifest(baseEntities);
    await setSetting('sync_base_manifest', JSON.stringify(baseManifest));
    await setSetting('sync_last_snapshot_id', initialSnapshotId);

    // Add local transaction
    await bulkImport([
      { id: 'txn_local_new', Date: '05/01/2026', INR: 300, 'Income/Expense': 'Expense', Account: 'Cash', Category: 'Food', Note: 'chips' }
    ], { firstImport: false });

    let findCalls = 0;
    const raceDrive = {
      file: {
        id: 'drive_file_001',
        name: SNAPSHOT_FILENAME,
        content: encryptedCloud,
        version: 1,
        modifiedTime: '2026-09-25T10:00:00.000Z'
      },
      uploads: 0,
      async findAppDataFile(filename, token) {
        findCalls++;
        if (findCalls === 2) {
          // Simulate another device modified cloud version in interim
          this.file.version = 2;
          this.file.modifiedTime = '2026-09-25T10:05:00.000Z';
        }
        return { id: this.file.id, name: this.file.name, version: this.file.version, modifiedTime: this.file.modifiedTime };
      },
      async readAppDataFile(fileId, token) {
        return this.file.content;
      },
      async uploadAppDataFile(filename, content, mimeType, token) {
        this.uploads++;
        this.file.content = content;
        this.file.version = (this.file.version || 1) + 1;
        return { id: this.file.id, version: this.file.version };
      }
    };

    const syncRes = await executeCloudSync({
      pin: testPin,
      accessToken: testToken,
      deviceId: 'device_D',
      dbInstance: db,
      driveClient: raceDrive
    });

    assert.strictEqual(syncRes.status, SYNC_STATUS.SUCCESS);
    assert.strictEqual(syncRes.cloudWritePerformed, true);
    assert.ok(findCalls >= 3, 'Pre-upload stale head check triggered retry');
  });

  await t.test('TEST 7: Historical 3-way identity matching preserves 0 duplicates', async () => {
    const localItem = { id: '652866ae-d1bd-435a-88e0-1e8813f65c10', Date: '04/10/2016', INR: 100, 'Income/Expense': 'Expense', Account: 'Cash', Category: 'Food', Note: 'lunch' };
    const cloudItem = { id: 'txn_1704067200000_000000', Date: '04/10/2016', INR: 100, 'Income/Expense': 'Expense', Account: 'Cash', Category: 'Food', Note: 'lunch' };

    const plan = await reconcile3Way({
      baseManifest: {},
      localEntities: { transactions: [localItem], investment_transactions: [] },
      cloudEntities: { transactions: [cloudItem], investment_transactions: [] }
    });

    assert.strictEqual(plan.plannedLocalInserts.length, 0, 'Zero duplicate local inserts');
    assert.strictEqual(plan.plannedCloudInserts.length, 0, 'Zero duplicate cloud inserts');
    assert.strictEqual(plan.identityMatchedTransactions, 1, '1 transaction paired on identity');
  });

  await t.test('TEST 8: Tombstone precedence prevents resurrection of deleted records', async () => {
    const deletedId = 'txn_del_001';
    const cloudItem = { id: deletedId, Date: '01/01/2026', INR: 50, 'Income/Expense': 'Expense', Account: 'Cash', Category: 'Food', Note: '' };
    const canonical = canonicalizeEntity(cloudItem, 'transactions');

    const plan = await reconcile3Way({
      baseManifest: { [deletedId]: { type: 'transactions', canonical } },
      localEntities: {
        transactions: [],
        sync_tombstones: [{ id: deletedId, entity_type: 'transaction', deleted_at: '2026-09-25T08:00:00.000Z' }]
      },
      cloudEntities: {
        transactions: [cloudItem]
      }
    });

    assert.strictEqual(plan.plannedLocalInserts.length, 0, 'Deleted record not resurrected locally');
    assert.strictEqual(plan.plannedCloudDeletes.length, 1, 'Deletion propagated to cloud');
  });

  await t.test('TEST 9: Double Sync Now does not duplicate transactions or create phantom snapshots', async () => {
    const db = await resetDB();
    await bulkImport(baseTxns, { firstImport: false });

    const baseEntities = await readLocalEntities(db);
    const initialSnapshotId = 'snap_base_001';
    const { payload } = await createCanonicalSnapshotPayload({
      entities: baseEntities,
      snapshotId: initialSnapshotId,
      cloudVersion: 1,
      deviceId: 'device_C'
    });
    const encryptedCloud = await encryptBackupData(payload, testPin);

    const baseManifest = await buildEntityManifest(baseEntities);
    await setSetting('sync_base_manifest', JSON.stringify(baseManifest));
    await setSetting('sync_last_snapshot_id', initialSnapshotId);

    // Add 1 local transaction
    await bulkImport([
      { id: 'txn_3', Date: '03/01/2026', INR: 150, 'Income/Expense': 'Expense', Account: 'Cash', Category: 'Food', Note: 'dinner' }
    ], { firstImport: false });

    const mockDrive = createMockDrive({
      id: 'drive_file_001',
      name: SNAPSHOT_FILENAME,
      content: encryptedCloud,
      version: 1,
      modifiedTime: '2026-09-25T10:00:00.000Z'
    });

    // First Sync (Uploads txn_3)
    const res1 = await executeCloudSync({
      pin: testPin,
      accessToken: testToken,
      deviceId: 'device_D',
      dbInstance: db,
      driveClient: mockDrive
    });
    assert.strictEqual(res1.status, SYNC_STATUS.SUCCESS);
    assert.strictEqual(res1.cloudWritePerformed, true);
    assert.strictEqual(mockDrive.getUploadCount(), 1);

    // Immediate Second Sync (Must be No-Op!)
    const res2 = await executeCloudSync({
      pin: testPin,
      accessToken: testToken,
      deviceId: 'device_D',
      dbInstance: db,
      driveClient: mockDrive
    });
    assert.strictEqual(res2.status, SYNC_STATUS.NO_CHANGES);
    assert.strictEqual(res2.cloudWritePerformed, false);
    assert.strictEqual(res2.snapshotId, res1.snapshotId);
    assert.strictEqual(res2.cloudVersion, res1.cloudVersion);
    assert.strictEqual(mockDrive.getUploadCount(), 1, 'Second sync must NOT perform an upload');

    // Verify local record count
    const txns = await getTransactions();
    assert.strictEqual(txns.length, 3, 'Local DB has exactly 3 records, 0 duplicates');
  });

  await t.test('TEST 10: Lost response recovery does not duplicate data on retry', async () => {
    const db = await resetDB();
    await bulkImport(baseTxns, { firstImport: false });

    const baseEntities = await readLocalEntities(db);
    const initialSnapshotId = 'snap_base_001';
    const baseManifest = await buildEntityManifest(baseEntities);
    await setSetting('sync_base_manifest', JSON.stringify(baseManifest));
    await setSetting('last_snapshot_id', initialSnapshotId);

    // Add 1 local transaction
    await bulkImport([
      { id: 'txn_retry', Date: '06/01/2026', INR: 75, 'Income/Expense': 'Expense', Account: 'Cash', Category: 'Food', Note: 'snack' }
    ], { firstImport: false });

    const updatedLocalEntities = await readLocalEntities(db);

    // Simulate scenario: Upload succeeded on Drive (cloud version 2 with txn_retry), but client network dropped before writing local base manifest
    const { payload: payloadV2 } = await createCanonicalSnapshotPayload({
      entities: updatedLocalEntities,
      snapshotId: 'snap_v2_uploaded',
      parentSnapshotId: initialSnapshotId,
      cloudVersion: 2,
      deviceId: 'device_D'
    });
    const encryptedV2 = await encryptBackupData(payloadV2, testPin);

    const mockDrive = createMockDrive({
      id: 'drive_file_001',
      name: SNAPSHOT_FILENAME,
      content: encryptedV2,
      version: 2,
      modifiedTime: '2026-09-25T11:00:00.000Z'
    });

    // Retry Sync
    const retryRes = await executeCloudSync({
      pin: testPin,
      accessToken: testToken,
      deviceId: 'device_D',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(retryRes.status, SYNC_STATUS.NO_CHANGES);
    assert.strictEqual(retryRes.cloudWritePerformed, false, 'No redundant upload created');
    assert.strictEqual(retryRes.snapshotId, 'snap_v2_uploaded');
    assert.strictEqual(retryRes.cloudVersion, 2);
    assert.strictEqual(mockDrive.getUploadCount(), 0, 'No additional upload performed');

    const txns = await getTransactions();
    assert.strictEqual(txns.length, 3, 'Zero duplicates created on retry');
  });
});
