/**
 * FinMan Phase 13.5 — Authoritative Master Snapshot v13 Transition & Populated Device Handling
 *
 * Tests:
 * 1. publishAuthoritativeDeviceSnapshot fails closed if database is empty
 * 2. publishAuthoritativeDeviceSnapshot produces valid Snapshot v13 conforming to schema 13
 * 3. Chained lineage properly links parent snapshot to existing cloud baseline (v12)
 * 4. Covered peer watermarks preserve Device C (16), Device D (10), and local sequence
 * 5. Device lifecycle transitions from UNINITIALIZED to ACTIVE
 * 6. Pending delta queue events are marked ACKNOWLEDGED
 * 7. Device manifest is published with base_snapshot_id matching Snapshot v13 and ACTIVE state
 * 8. executeFullSyncPass returns POPULATED_LOCAL_REQUIRES_CHOICE on uninitialized populated device
 */

import test from 'node:test';
import assert from 'node:assert';
import { IDBFactory } from 'fake-indexeddb';
import { getDB, initDB, closeDB } from '../database/db.js';
import { addTransaction, getTransactions } from '../database/transactions.js';
import {
  configureDeltaSyncEngine,
  publishAuthoritativeDeviceSnapshot,
  executeFullSyncPass,
  getDeviceLifecycleState,
  setDeviceLifecycleState,
  DEVICE_LIFECYCLE,
  SYNC_STATUS
} from '../services/deltaSyncCoordinator.js';
import {
  SNAPSHOT_FILENAME,
  createCanonicalSnapshotPayload
} from '../services/cloudSyncEngine.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';
import { readOwnDeviceManifest } from '../services/deviceManifest.js';

const TEST_SESSION_KEY = 'test-secret-authoritative-v13-key';

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

  async findAppDataFile(name) {
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        return { id: f.id, name: f.name };
      }
    }
    return null;
  }

  async readFile(fileId) {
    const f = this.files.get(fileId);
    if (!f || f.trashed) throw new Error(`File ${fileId} not found`);
    return f.content;
  }

  async readAppDataFile(fileId) {
    return await this.readFile(fileId);
  }

  async uploadFile(arg1, arg2, arg3) {
    let name, content, appProperties;
    if (arg1 && typeof arg1 === 'object') {
      name = arg1.name;
      content = arg1.content;
      appProperties = arg1.appProperties || {};
    } else {
      name = arg1;
      content = arg2;
      appProperties = arg3 || {};
    }
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        f.content = content;
        f.appProperties = { ...f.appProperties, ...appProperties };
        return { id, name };
      }
    }
    const id = `mock_drive_file_${this.nextId++}`;
    this.files.set(id, { id, name, content, appProperties, trashed: false });
    return { id, name };
  }

  async uploadAppDataFile(name, content) {
    return await this.uploadFile(name, content);
  }
}

test('FinMan Phase 13.5 — Authoritative Snapshot v13 Transition Test Suite', async (t) => {
  let db;
  let mockDrive;

  t.beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    db = await initDB(':memory:');
    mockDrive = new MockDriveStorage();
    configureDeltaSyncEngine({
      driveClient: mockDrive,
      accessToken: 'mock_token',
      sessionKey: TEST_SESSION_KEY
    });
  });

  t.afterEach(async () => {
    mockDrive.reset();
    try {
      await closeDB();
    } catch {}
  });

  await t.test('T1: publishAuthoritativeDeviceSnapshot fails closed if local database has 0 transactions', async () => {
    const devId = 'dev_empty_test_01';
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.UNINITIALIZED, devId);

    await assert.rejects(
      async () => {
        await publishAuthoritativeDeviceSnapshot({
          db,
          driveClient: mockDrive,
          accessToken: 'mock_token',
          sessionKey: TEST_SESSION_KEY,
          deviceId: devId
        });
      },
      /Cannot publish empty local database/
    );
  });

  await t.test('T2: executeFullSyncPass returns POPULATED_LOCAL_REQUIRES_CHOICE on uninitialized populated device', async () => {
    const devId = 'dev_android_real_01';
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.UNINITIALIZED, devId);

    // Seed existing cloud Snapshot v12
    const v12Snapshot = await createCanonicalSnapshotPayload({
      entities: { transactions: [{ id: 'txn_v12_1', amount: 500, type: 'expense' }] },
      snapshotId: 'snap_1792067106302_gdxzub',
      cloudVersion: 12,
      deviceId: 'dev_a30fb118cec0'
    });
    const encryptedV12 = await encryptBackupData(v12Snapshot.payload, TEST_SESSION_KEY);
    await mockDrive.uploadFile(SNAPSHOT_FILENAME, encryptedV12);

    // Seed local database with real user transactions
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_hdfc', 'HDFC Bank', 'Bank Accounts']);
    await addTransaction({
      amount: 1500,
      type: 'expense',
      category: 'Food',
      description: 'Dinner with family',
      date: '2026-10-18'
    });

    // Execute full sync pass
    const res = await executeFullSyncPass({
      deviceId: devId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'POPULATED_LOCAL_REQUIRES_CHOICE');
    assert.strictEqual(res.needsChoice, true);
    assert.strictEqual(res.cloudSnapshotId, 'snap_1792067106302_gdxzub');
    assert.strictEqual(res.cloudVersion, 12);

    // Verify local transaction remains 100% untouched
    const txns = await getTransactions();
    assert.strictEqual(txns.length, 1);
    assert.strictEqual(txns[0].Description || txns[0].description, 'Dinner with family');
  });

  await t.test('T3: publishAuthoritativeDeviceSnapshot creates valid Snapshot v13, updates state, and sets ACTIVE', async () => {
    const devId = 'dev_c7e4544221f4';
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.UNINITIALIZED, devId);

    // Seed existing cloud Snapshot v12
    const v12Snapshot = await createCanonicalSnapshotPayload({
      entities: { transactions: [{ id: 'txn_v12_1', amount: 100, type: 'expense' }] },
      snapshotId: 'snap_1792067106302_gdxzub',
      cloudVersion: 12,
      deviceId: 'dev_a30fb118cec0'
    });
    const encryptedV12 = await encryptBackupData(v12Snapshot.payload, TEST_SESSION_KEY);
    await mockDrive.uploadFile(SNAPSHOT_FILENAME, encryptedV12);

    // Add local account and transaction (which generates a queue entry)
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_icici', 'ICICI Current', 'Bank Accounts']);
    await addTransaction({
      amount: 2500,
      type: 'expense',
      category: 'Groceries',
      description: 'Weekly grocery run',
      date: '2026-10-18'
    });

    // Verify queue entry was created
    const queueBefore = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.ok(queueBefore.length > 0, 'Queue has entries waiting');
    assert.strictEqual(queueBefore[0].status, 'PENDING');

    // Execute authoritative transition to Snapshot v13
    const pubRes = await publishAuthoritativeDeviceSnapshot({
      db,
      driveClient: mockDrive,
      accessToken: 'mock_token',
      sessionKey: TEST_SESSION_KEY,
      deviceId: devId
    });

    assert.strictEqual(pubRes.success, true);
    assert.strictEqual(pubRes.status, SYNC_STATUS.SUCCESS);
    assert.strictEqual(pubRes.cloudVersion, 13);
    assert.strictEqual(pubRes.parentSnapshotId, 'snap_1792067106302_gdxzub');
    assert.ok(pubRes.snapshotId.startsWith('snap_'));

    // Verify device transitioned to ACTIVE
    const lifecycleState = await getDeviceLifecycleState(devId);
    assert.strictEqual(lifecycleState, DEVICE_LIFECYCLE.ACTIVE);

    // Verify queue entries are marked ACKNOWLEDGED
    const queueAfter = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.ok(queueAfter.every(q => q.status === 'ACKNOWLEDGED'), 'All queue entries acknowledged');

    // Verify snapshot file on Google Drive
    const cloudFile = await mockDrive.findAppDataFile(SNAPSHOT_FILENAME);
    assert.ok(cloudFile, 'Snapshot file exists on drive');
    const cloudCipher = await mockDrive.readFile(cloudFile.id);
    const decryptedPayload = await decryptBackupData(cloudCipher, TEST_SESSION_KEY);

    assert.strictEqual(decryptedPayload.schema_version, 13);
    assert.strictEqual(decryptedPayload.cloud_version, 13);
    assert.strictEqual(decryptedPayload.parent_snapshot_id, 'snap_1792067106302_gdxzub');
    assert.strictEqual(decryptedPayload.device_id, devId);
    assert.strictEqual(decryptedPayload.covered_peer_watermarks['dev_a30fb118cec0'], 16);
    assert.strictEqual(decryptedPayload.covered_peer_watermarks['dev_fa18ce0c9349'], 10);
    assert.ok(decryptedPayload.covered_peer_watermarks[devId] >= 1);

    // Verify device manifest on Google Drive
    const manifest = await readOwnDeviceManifest({
      deviceId: devId,
      driveClient: mockDrive
    });
    assert.strictEqual(manifest.device_lifecycle_state, 'ACTIVE');
    assert.strictEqual(manifest.base_snapshot_id, pubRes.snapshotId);
    assert.strictEqual(manifest.base_cloud_version, 13);
  });
});
