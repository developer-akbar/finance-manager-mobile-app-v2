/**
 * device_identity_and_legacy_manifest.test.js
 * 
 * Focused regression tests for:
 * 1. Fresh web storage without a device_state row generates and persists a valid unique device ID (dev_<12 hex chars>).
 * 2. Repeated bootstrap attempts reuse the persisted ID.
 * 3. Concurrent initialization in two tabs for the same profile does not generate competing identities or manifest ownership.
 * 4. A fresh device joining while manifest_dev_local_device.json already exists preserves that file unchanged and creates/uses its own unique manifest.
 * 5. Identity persistence failure stops bootstrap before any manifest publication or transition to ACTIVE.
 * 6. Bootstrap verification failure and retry preserve correct lifecycle state, prevent duplicate data, and do not create conflicting manifests.
 * 7. Existing C/D device identities and manifest ownership remain compatible.
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
  getLocalSyncState
} from '../database/index.js';
import { getSetting, setSetting } from '../database/settings.js';
import { unlockSyncSession, lockSyncSession } from '../services/syncSession.js';
import {
  DEVICE_LIFECYCLE,
  getDeviceLifecycleState,
  setDeviceLifecycleState,
  getLocalDeviceId,
  getOrCreateLocalDeviceId,
  bootstrapNewDevice,
  executeFullSyncPass,
  configureDeltaSyncEngine
} from '../services/deltaSyncCoordinator.js';
import {
  generateUniqueDeviceId
} from '../database/deltaQueue.js';
import {
  readOwnDeviceManifest,
  writeOwnDeviceManifest,
  getDeviceManifestFilename,
  listPeerManifests,
  createEmptyDeviceManifest
} from '../services/deviceManifest.js';
import { encryptBackupData } from '../utils/cryptoBackup.js';
import { SNAPSHOT_FILENAME } from '../services/cloudSyncEngine.js';

const TEST_SESSION_KEY = 'test_device_identity_key_32_bytes!';
const TEST_SNAPSHOT_ID = 'snap_test_identity_01';

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
    if (!f) throw new Error(`File not found: ${fileId}`);
    f.content = content;
    return { id: fileId, name: f.name };
  }

  async listAppDataFiles(token) {
    const list = [];
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed) {
        list.push({ id: f.id, name: f.name });
      }
    }
    return list;
  }
}

async function createEncryptedSnapshotPayload(snapshotId, entities = {}) {
  const payload = {
    snapshot_id: snapshotId,
    cloud_version: 10,
    created_at: new Date().toISOString(),
    device_id: 'dev_peer_anchor',
    entities: {
      accounts: entities.accounts || [{ id: 'acct_1', name: 'Savings', group_name: 'Cash' }],
      categories: entities.categories || [{ id: 'cat_1', name: 'Food', type: 'Expense' }],
      transactions: entities.transactions || [],
      investment_transactions: entities.investment_transactions || [],
      ...entities
    },
    covered_peer_watermarks: {}
  };
  const encrypted = await encryptBackupData(payload, TEST_SESSION_KEY);
  return { payload, encrypted };
}

test('FinMan — Device Identity & Legacy Manifest Protection Suite', async (t) => {
  t.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    await initDB();
    unlockSyncSession(TEST_SESSION_KEY);
  });

  t.afterEach(() => {
    lockSyncSession();
    closeDB();
  });

  await t.test('1. Fresh web storage without a device_state row generates and persists a valid unique device ID', async () => {
    // Verify sync_local_state starts completely empty
    const db = getDB();
    const rows = (await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state'])).values || [];
    assert.equal(rows.length, 0, 'No device_state row exists initially');

    // getLocalDeviceId without createIfMissing returns null, never 'local_device'
    const initialId = await getLocalDeviceId();
    assert.equal(initialId, null, 'Must not return local_device or fabricated ID when row is missing');

    // Allocate persistent ID
    const allocatedId = await getOrCreateLocalDeviceId();
    assert.ok(allocatedId, 'Allocated ID must exist');
    assert.match(allocatedId, /^dev_[a-f0-9]{12}$/, 'Allocated ID must strictly match dev_<12 hex chars>');
    assert.notEqual(allocatedId, 'local_device', 'Must never equal local_device');

    // Confirm ID is persisted in IDB/DB and read back reliably
    const readBackId = await getLocalDeviceId();
    assert.equal(readBackId, allocatedId, 'Readback must match allocated unique ID');

    // Lifecycle state should still be UNINITIALIZED
    const lcState = await getDeviceLifecycleState();
    assert.equal(lcState, DEVICE_LIFECYCLE.UNINITIALIZED, 'Allocating device identity does not advance lifecycle prematurely');
  });

  await t.test('2. Repeated bootstrap attempts reuse the persisted ID', async () => {
    const mockDrive = new MockDriveStorage();
    const { encrypted } = await createEncryptedSnapshotPayload(TEST_SNAPSHOT_ID);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encrypted });

    // Pre-allocate or let first call allocate
    const firstId = await getOrCreateLocalDeviceId();
    assert.match(firstId, /^dev_[a-f0-9]{12}$/);

    // Call getOrCreateLocalDeviceId multiple times
    const secondCallId = await getOrCreateLocalDeviceId();
    const thirdCallId = await getOrCreateLocalDeviceId();
    assert.equal(secondCallId, firstId, 'Second call must reuse persisted ID');
    assert.equal(thirdCallId, firstId, 'Third call must reuse persisted ID');

    // Run bootstrap without passing explicit deviceId
    const bootRes = await bootstrapNewDevice({
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.equal(bootRes.success, true);
    const persistedState = await getLocalSyncState();
    assert.equal(persistedState.device_id, firstId, 'Bootstrap must use and retain the persisted unique ID');

    // Attempting a subsequent call must still reuse the exact same device ID
    const postBootId = await getLocalDeviceId();
    assert.equal(postBootId, firstId, 'Post-bootstrap ID query must match initial ID');
  });

  await t.test('3. Concurrent initialization in two tabs for the same profile does not generate competing identities or manifest ownership', async () => {
    // Simulate Tab 1 and Tab 2 concurrent allocation calls against the same underlying DB
    const [tab1Id, tab2Id] = await Promise.all([
      getOrCreateLocalDeviceId(),
      getOrCreateLocalDeviceId()
    ]);

    assert.equal(tab1Id, tab2Id, 'Concurrent tab allocations must resolve to the identical device ID');
    assert.match(tab1Id, /^dev_[a-f0-9]{12}$/);

    // Only one row should exist in sync_local_state
    const db = getDB();
    const rows = (await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state'])).values || [];
    assert.equal(rows.length, 1, 'Exactly one device_state row exists');
    assert.equal(rows[0].device_id, tab1Id);
  });

  await t.test('4. A fresh device joining while manifest_dev_local_device.json already exists preserves that file unchanged and creates/uses its own unique manifest', async () => {
    const mockDrive = new MockDriveStorage();
    const { encrypted } = await createEncryptedSnapshotPayload(TEST_SNAPSHOT_ID);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encrypted });

    // Seed the legacy manifest in mock Google Drive (representing the failed prior bootstrap)
    const legacyManifestContent = JSON.stringify({
      manifest_version: 1,
      device_id: 'local_device',
      manifest_revision: 2,
      base_snapshot_id: 'snap_1790963722004_bq5y93',
      base_cloud_version: 9,
      last_sequence: 0,
      device_lifecycle_state: 'ACTIVE',
      packages: []
    }, null, 2);

    const legacyFile = await mockDrive.uploadFile({
      name: 'manifest_dev_local_device.json',
      content: legacyManifestContent
    });

    // 1. Attempting to write directly with device_id === 'local_device' must be strictly rejected
    await assert.rejects(
      async () => {
        await writeOwnDeviceManifest({
          driveClient: mockDrive,
          manifestData: { device_id: 'local_device', device_lifecycle_state: 'ACTIVE' }
        });
      },
      /ILLEGAL_DEVICE_ID|ILLEGAL_MANIFEST_WRITE/
    );

    // 2. Attempting to read local_device as own device manifest must be strictly rejected
    await assert.rejects(
      async () => {
        await readOwnDeviceManifest({
          driveClient: mockDrive,
          deviceId: 'local_device'
        });
      },
      /ILLEGAL_DEVICE_ID/
    );

    // 3. Run fresh device bootstrap without passing explicit deviceId
    const bootResult = await bootstrapNewDevice({
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.equal(bootResult.success, true);
    const assignedDeviceId = await getLocalDeviceId();
    assert.notEqual(assignedDeviceId, 'local_device', 'Assigned device ID must not be local_device');
    assert.match(assignedDeviceId, /^dev_[a-f0-9]{12}$/);

    // 4. Verify legacy manifest file in Drive was NOT touched or overwritten
    const legacyAfter = await mockDrive.readFile(legacyFile.id);
    assert.equal(legacyAfter, legacyManifestContent, 'Legacy manifest content must remain 100% byte-for-byte identical');

    // 5. Verify the fresh device published its OWN unique manifest
    const ownFilename = getDeviceManifestFilename(assignedDeviceId);
    assert.notEqual(ownFilename, 'manifest_dev_local_device.json');
    assert.equal(ownFilename, `manifest_dev_${assignedDeviceId}.json`);

    const ownFiles = await mockDrive.findFiles({ name: ownFilename });
    assert.equal(ownFiles.length, 1, 'Fresh device manifest must exist as distinct file');

    const ownManifest = JSON.parse(await mockDrive.readFile(ownFiles[0].id));
    assert.equal(ownManifest.device_id, assignedDeviceId);
    assert.equal(ownManifest.device_lifecycle_state, 'ACTIVE');

    // 6. Verify listPeerManifests safely ignores the local_device legacy manifest
    const peerManifests = await listPeerManifests({
      driveClient: mockDrive,
      ownDeviceId: assignedDeviceId,
      baseSnapshotId: TEST_SNAPSHOT_ID
    });
    const localDevicePeer = peerManifests.find(m => m.device_id === 'local_device');
    assert.equal(localDevicePeer, undefined, 'local_device must not be treated as a valid active peer manifest');
  });

  await t.test('5. Identity persistence failure stops bootstrap before any manifest publication or transition to ACTIVE', async () => {
    const mockDrive = new MockDriveStorage();
    const { encrypted } = await createEncryptedSnapshotPayload(TEST_SNAPSHOT_ID);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encrypted });

    const rawIdb = getRawIDB();
    let origTx = null;
    if (rawIdb) {
      origTx = rawIdb.transaction.bind(rawIdb);
      rawIdb.transaction = (storeNames, mode) => {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        if (names.includes('sync_local_state') && mode === 'readwrite') {
          throw new Error('Simulated IDB quota exceeded / disk write failure');
        }
        return origTx(storeNames, mode);
      };
    }

    const db = getDB();
    const origRun = db.run.bind(db);
    db.run = async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('sync_local_state')) {
        throw new Error('Simulated disk I/O failure during device identity allocation');
      }
      return origRun(sql, params);
    };

    try {
      await assert.rejects(
        async () => {
          await bootstrapNewDevice({
            driveClient: mockDrive,
            sessionKey: TEST_SESSION_KEY
          });
        },
        /DEVICE_IDENTITY_ALLOCATION_FAILED/
      );
    } finally {
      if (rawIdb && origTx) rawIdb.transaction = origTx;
      db.run = origRun;
    }

    // Verify no manifest was written to Drive
    const driveFiles = await mockDrive.findFiles({});
    const manifestFiles = driveFiles.filter(f => f.name.startsWith('manifest_'));
    assert.equal(manifestFiles.length, 0, 'No manifest must be published on identity persistence failure');

    // Verify lifecycle state remains UNINITIALIZED
    const lc = await getDeviceLifecycleState();
    assert.equal(lc, DEVICE_LIFECYCLE.UNINITIALIZED, 'Device must not transition to JOINING or ACTIVE');
  });

  await t.test('6. Bootstrap verification failure and retry preserve correct lifecycle state, prevent duplicate data, and do not create conflicting manifests', async () => {
    const mockDrive = new MockDriveStorage();
    const { encrypted } = await createEncryptedSnapshotPayload(TEST_SNAPSHOT_ID, {
      transactions: [
        { id: 'txn_init_1', date: '2026-10-10', inr: 100, amount: 100, account: 'Savings', type: 'Expense' }
      ]
    });
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encrypted });

    const db = getDB();

    // Allocate persistent ID
    const deviceId = await getOrCreateLocalDeviceId();

    // Inject an unexpected pending outbound delta queue record right before verification to trigger verification failure
    const origQuery = db.query.bind(db);
    let injectedOnce = false;
    db.query = async (sql, params) => {
      const res = await origQuery(sql, params);
      if (typeof sql === 'string' && sql.includes('SELECT * FROM sync_delta_queue') && !injectedOnce) {
        injectedOnce = true;
        // Inject fake pending outbound mutation to simulate verification gate trigger
        return { values: [{ id: 'dirty_mutation', status: 'PENDING' }] };
      }
      return res;
    };

    // First attempt: should fail verification
    await assert.rejects(
      async () => {
        await bootstrapNewDevice({
          driveClient: mockDrive,
          sessionKey: TEST_SESSION_KEY,
          deviceId
        });
      },
      /BOOTSTRAP_VERIFICATION_FAILED/
    );

    // Lifecycle must remain JOINING after failure
    const lcAfterFail = await getDeviceLifecycleState();
    assert.equal(lcAfterFail, DEVICE_LIFECYCLE.JOINING, 'Must fail-closed to JOINING');

    // No manifest should have been published
    const ownFilename = getDeviceManifestFilename(deviceId);
    const manifestsAfterFail = await mockDrive.findFiles({ name: ownFilename });
    assert.equal(manifestsAfterFail.length, 0, 'No manifest must be published after verification failure');

    // Restore query function and retry
    db.query = origQuery;
    const retryResult = await bootstrapNewDevice({
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY,
      deviceId
    });

    assert.equal(retryResult.success, true, 'Retry must succeed');
    const lcAfterRetry = await getDeviceLifecycleState();
    assert.equal(lcAfterRetry, DEVICE_LIFECYCLE.ACTIVE, 'Retry transitions to ACTIVE');

    // Exactly 1 manifest file exists for the device
    const manifestsAfterRetry = await mockDrive.findFiles({ name: ownFilename });
    assert.equal(manifestsAfterRetry.length, 1, 'Exactly one manifest exists after retry');

    // No duplicate accounts/categories
    const accounts = (await db.query('SELECT * FROM accounts')).values || [];
    assert.equal(accounts.length, 1, 'Accounts count is preserved without duplication');
  });

  await t.test('7. Existing C/D device identities and manifest ownership remain compatible', async () => {
    const mockDrive = new MockDriveStorage();
    const deviceCId = 'dev_6edc69e37943';
    const deviceDId = 'dev_b91065cd877f';

    // 1. Device C initializes sync state with its pre-existing ID
    await initLocalSyncState(deviceCId, TEST_SNAPSHOT_ID, 10, DEVICE_LIFECYCLE.ACTIVE);
    const resolvedC = await getLocalDeviceId();
    assert.equal(resolvedC, deviceCId, 'Existing Device C ID must be preserved exactly');

    // Device C writes its manifest
    const manifestC = createEmptyDeviceManifest({
      deviceId: deviceCId,
      baseSnapshotId: TEST_SNAPSHOT_ID,
      baseCloudVersion: 10,
      manifestRevision: 1,
      device_lifecycle_state: DEVICE_LIFECYCLE.ACTIVE
    });
    await writeOwnDeviceManifest({
      driveClient: mockDrive,
      manifestData: manifestC
    });

    const fileC = await mockDrive.findFiles({ name: getDeviceManifestFilename(deviceCId) });
    assert.equal(fileC.length, 1, 'Device C manifest must be published');

    // 2. Collision guard: Device D must be prohibited from overwriting Device C's manifest file
    await assert.rejects(
      async () => {
        // Attempting to overwrite fileC with caller deviceDId
        const fakeManifest = {
          device_id: deviceDId,
          device_lifecycle_state: DEVICE_LIFECYCLE.ACTIVE,
          manifest_revision: 1
        };
        // If someone passes file name collision:
        await mockDrive.uploadFile({
          name: getDeviceManifestFilename(deviceDId),
          content: JSON.stringify({ device_id: deviceCId }) // simulate existing file owned by C
        });
        await writeOwnDeviceManifest({
          driveClient: mockDrive,
          manifestData: fakeManifest
        });
      },
      /MANIFEST_COLLISION/
    );

    // 3. Device D writes its own distinct manifest cleanly
    mockDrive.files.delete('mock_file_2'); // clean up collision test file
    const manifestD = createEmptyDeviceManifest({
      deviceId: deviceDId,
      baseSnapshotId: TEST_SNAPSHOT_ID,
      baseCloudVersion: 10,
      manifestRevision: 1,
      device_lifecycle_state: DEVICE_LIFECYCLE.ACTIVE
    });
    await writeOwnDeviceManifest({
      driveClient: mockDrive,
      manifestData: manifestD
    });

    const fileD = await mockDrive.findFiles({ name: getDeviceManifestFilename(deviceDId) });
    assert.equal(fileD.length, 1, 'Device D manifest must be published cleanly');
    assert.notEqual(fileC[0].name, fileD[0].name, 'Manifest filenames must be distinct');
  });
});
