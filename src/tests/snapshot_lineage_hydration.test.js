import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuid } from 'uuid';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, getDB, closeDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import { encryptBackupData } from '../utils/cryptoBackup.js';
import {
  SNAPSHOT_FILENAME
} from '../services/cloudSyncEngine.js';
import {
  hydrateMissingSnapshotLineage,
  executeFullSyncPass,
  configureDeltaSyncEngine
} from '../services/deltaSyncCoordinator.js';
import {
  downloadAndStagePeerPackages,
  encryptDeltaPackage,
  buildDeterministicPackagePayload
} from '../services/deltaTransport.js';
import {
  reconcileStagedEvents,
  RECONCILIATION_STATUS
} from '../services/deltaReconciliation.js';
import { initLocalSyncState } from '../database/deltaQueue.js';

test('Snapshot Lineage Hydration Test Suite (Backward Compatibility)', async (t) => {
  globalThis.indexedDB = new IDBFactory();
  const testPin = '123456';

  async function resetDB() {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    const db = await initDB();
    await db.run('DELETE FROM transactions');
    await db.run('DELETE FROM accounts');
    await db.run('DELETE FROM inventory');
    await db.run('DELETE FROM investment_transactions');
    await db.run('DELETE FROM settings');
    await db.run('DELETE FROM sync_tombstones');
    await db.run('DELETE FROM sync_delta_queue');
    await db.run('DELETE FROM sync_local_state');
    await db.run('DELETE FROM sync_staged_packages');
    await db.run('DELETE FROM sync_staged_events');
    await db.run('DELETE FROM sync_peer_state');
    await db.run('DELETE FROM sync_process_locks');
    await db.run('DELETE FROM sync_conflicts');
    return db;
  }

  function createMockDrive(filesMap = new Map()) {
    let readCount = 0;
    return {
      files: filesMap,
      get readCount() { return readCount; },
      async findFiles({ name }) {
        const matches = [];
        for (const f of filesMap.values()) {
          if (!name || f.name === name) matches.push(f);
        }
        return matches;
      },
      async readFile(id) {
        readCount++;
        const file = filesMap.get(id);
        if (!file) throw new Error(`File not found: ${id}`);
        return file.content;
      },
      async uploadFile(name, content) {
        const id = `drive_id_${uuid()}`;
        const file = { id, name, content };
        filesMap.set(id, file);
        return file;
      }
    };
  }

  // --- A. Existing device missing parent ---
  await t.test('A. Existing device missing parent hydrates from cloud snapshot', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';

    await setSetting('last_snapshot_id', activeSnap);
    // last_parent_snapshot_id is intentionally missing

    const snapshotPayload = {
      version: 2,
      cloud_version: 9,
      snapshot_id: activeSnap,
      parent_snapshot_id: parentSnap,
      device_id: 'dev_c',
      entities: {
        transactions: [],
        investment_transactions: [],
        accounts: [],
        categories: []
      }
    };

    const encryptedSnapshot = await encryptBackupData(snapshotPayload, testPin);
    const mockDrive = createMockDrive();
    mockDrive.files.set('snap_file_id', {
      id: 'snap_file_id',
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot
    });

    const res = await hydrateMissingSnapshotLineage({
      driveClient: mockDrive,
      sessionKey: testPin
    });

    assert.equal(res.hydrated, true);
    assert.equal(res.parentSnapshotId, parentSnap);

    const persistedParent = await getSetting('last_parent_snapshot_id');
    assert.equal(persistedParent, parentSnap, 'last_parent_snapshot_id should be persisted in local DB settings');
  });

  // --- B. Already hydrated device ---
  await t.test('B. Already hydrated device skips cloud snapshot read', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';

    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', parentSnap);

    const mockDrive = createMockDrive();
    mockDrive.files.set('snap_file_id', {
      id: 'snap_file_id',
      name: SNAPSHOT_FILENAME,
      content: 'dummy_encrypted_content'
    });

    const res = await hydrateMissingSnapshotLineage({
      driveClient: mockDrive,
      sessionKey: testPin
    });

    assert.equal(res.hydrated, false);
    assert.equal(res.parentSnapshotId, parentSnap);
    assert.equal(mockDrive.readCount, 0, 'No cloud read should occur for already hydrated device');
  });

  // --- C. Parentless / root snapshot ---
  await t.test('C. Parentless / root snapshot sets empty parent and caches it', async () => {
    const db = await resetDB();
    const rootSnap = 'snap_root_1000';

    await setSetting('last_snapshot_id', rootSnap);
    // last_parent_snapshot_id is missing

    const snapshotPayload = {
      version: 2,
      cloud_version: 1,
      snapshot_id: rootSnap,
      parent_snapshot_id: null,
      device_id: 'dev_root',
      entities: { transactions: [], investment_transactions: [], accounts: [] }
    };

    const encryptedSnapshot = await encryptBackupData(snapshotPayload, testPin);
    const mockDrive = createMockDrive();
    mockDrive.files.set('snap_root_id', {
      id: 'snap_root_id',
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot
    });

    const res = await hydrateMissingSnapshotLineage({
      driveClient: mockDrive,
      sessionKey: testPin
    });

    assert.equal(res.hydrated, true);
    assert.equal(res.parentSnapshotId, '');

    const persistedParent = await getSetting('last_parent_snapshot_id');
    assert.equal(persistedParent, '', 'Root snapshot should persist empty string');

    // Second call should skip Drive read
    const initialReadCount = mockDrive.readCount;
    const res2 = await hydrateMissingSnapshotLineage({
      driveClient: mockDrive,
      sessionKey: testPin
    });
    assert.equal(res2.hydrated, false);
    assert.equal(mockDrive.readCount, initialReadCount, 'Subsequent hydration calls must skip Drive read');
  });

  // --- D. Cloud snapshot ID mismatch ---
  await t.test('D. Cloud snapshot ID mismatch does not overwrite local parent', async () => {
    const db = await resetDB();
    const localSnap = 'snap_1790500000000_v9';
    const newerCloudSnap = 'snap_1790600000000_v10';

    await setSetting('last_snapshot_id', localSnap);
    // last_parent_snapshot_id is missing

    const snapshotPayload = {
      version: 2,
      cloud_version: 10,
      snapshot_id: newerCloudSnap,
      parent_snapshot_id: localSnap,
      device_id: 'dev_other',
      entities: { transactions: [], investment_transactions: [], accounts: [] }
    };

    const encryptedSnapshot = await encryptBackupData(snapshotPayload, testPin);
    const mockDrive = createMockDrive();
    mockDrive.files.set('snap_newer_id', {
      id: 'snap_newer_id',
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot
    });

    const res = await hydrateMissingSnapshotLineage({
      driveClient: mockDrive,
      sessionKey: testPin
    });

    assert.equal(res.hydrated, false);
    const persistedParent = await getSetting('last_parent_snapshot_id');
    assert.equal(persistedParent, null, 'Must NOT write parent on snapshot mismatch');
  });

  // --- E. Cloud metadata read/decrypt failure ---
  await t.test('E. Cloud metadata read/decrypt failure is handled gracefully without mutation', async () => {
    const db = await resetDB();
    const localSnap = 'snap_1790500000000_v9';
    await setSetting('last_snapshot_id', localSnap);

    const mockDrive = createMockDrive();
    mockDrive.files.set('snap_corrupt_id', {
      id: 'snap_corrupt_id',
      name: SNAPSHOT_FILENAME,
      content: 'corrupted_ciphertext_not_valid_json'
    });

    const res = await hydrateMissingSnapshotLineage({
      driveClient: mockDrive,
      sessionKey: 'wrong_pin'
    });

    assert.equal(res.hydrated, false);
    const persistedParent = await getSetting('last_parent_snapshot_id');
    assert.equal(persistedParent, null, 'No lineage fabricated on decrypt failure');
  });

  // --- F. Live Scenario Simulation (End-to-End JIT hydration during sync pass) ---
  await t.test('F. Live scenario simulation: Pre-existing v9 session with missing parent discovers and reconciles v8 peer delta package', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';
    const localDeviceId = 'dev_c';
    const peerDeviceId = 'dev_d';

    // 1. Initial State: C has active v9 snapshot, but missing last_parent_snapshot_id
    await setSetting('last_snapshot_id', activeSnap);
    await initLocalSyncState(localDeviceId, activeSnap, 9, 'ACTIVE');

    // C has 2 existing transactions
    await db.run(
      'INSERT INTO transactions (id, description, inr, date, type, account, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['txn_c1', 'Baseline Txn 1', 100, '2026-10-01', 'EXPENSE', 'Cash', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z']
    );
    await db.run(
      'INSERT INTO transactions (id, description, inr, date, type, account, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['txn_c2', 'Baseline Txn 2', 200, '2026-10-01', 'EXPENSE', 'Cash', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z']
    );

    // Initial peer state for D: last_reconciled_sequence = 5
    await db.run(
      'INSERT INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      [peerDeviceId, 5, 5, parentSnap, new Date().toISOString()]
    );

    // 2. Cloud Snapshot in Drive (v9 with parent v8)
    const snapshotPayload = {
      version: 2,
      cloud_version: 9,
      snapshot_id: activeSnap,
      parent_snapshot_id: parentSnap,
      device_id: localDeviceId,
      entities: {
        transactions: [],
        investment_transactions: [],
        accounts: [],
        categories: []
      }
    };
    const encryptedCloudSnapshot = await encryptBackupData(snapshotPayload, testPin);

    // 3. Peer D Package seq 6 (based on parent v8)
    const dEvent = {
      event_id: 'evt_d_seq6',
      device_id: peerDeviceId,
      sequence: 6,
      timestamp: '2026-10-02T10:00:00Z',
      collection: 'transactions',
      entity_id: 'txn_d_new',
      operation: 'INSERT',
      payload: {
        id: 'txn_d_new',
        description: 'Peer D New Txn',
        inr: 500,
        date: '2026-10-02',
        type: 'EXPENSE',
        account: 'Cash',
        created_at: '2026-10-02T10:00:00Z',
        updated_at: '2026-10-02T10:00:00Z'
      }
    };
    const dPackagePayload = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      baseSnapshotId: parentSnap,
      baseCloudVersion: 8,
      startSequence: 6,
      endSequence: 6,
      events: [dEvent]
    });
    const encryptedDPackage = await encryptDeltaPackage(dPackagePayload, testPin);

    // 4. Peer D Manifest (base_snapshot_id = parentSnap v8)
    const dManifest = {
      schema_version: 1,
      device_id: peerDeviceId,
      base_snapshot_id: parentSnap,
      base_cloud_version: 8,
      device_lifecycle_state: 'ACTIVE',
      manifest_revision: 6,
      last_uploaded_sequence: 6,
      last_pushed_sequence: 6,
      packages: [{
        package_id: `pkg_${peerDeviceId}_000006_000006`,
        start_sequence: 6,
        end_sequence: 6,
        event_count: 1,
        package_checksum: encryptedDPackage.package_checksum,
        drive_file_id: 'drive_file_d_pkg6',
        created_at: '2026-10-02T10:00:00Z'
      }],
      updated_at: '2026-10-02T10:00:00Z'
    };

    // Populate Mock Drive
    const mockDrive = createMockDrive();
    mockDrive.files.set('cloud_snap_file', {
      id: 'cloud_snap_file',
      name: SNAPSHOT_FILENAME,
      content: encryptedCloudSnapshot
    });
    mockDrive.files.set('manifest_dev_d.json', {
      id: 'manifest_dev_d.json',
      name: `manifest_${peerDeviceId}.json`,
      content: JSON.stringify(dManifest)
    });
    mockDrive.files.set('drive_file_d_pkg6', {
      id: 'drive_file_d_pkg6',
      name: `pkg_${peerDeviceId}_000006_000006.finmanpkg`,
      content: JSON.stringify(encryptedDPackage)
    });

    // Configure sync engine
    configureDeltaSyncEngine({
      deviceId: localDeviceId,
      driveClient: mockDrive,
      getAccessToken: async () => 'mock_token',
      getSessionKey: async () => testPin
    });

    // 5. Run full sync pass on device C
    const syncRes = await executeFullSyncPass('AUTOMATIC_TEST', {
      accessToken: 'mock_token',
      sessionKey: testPin,
      driveClient: mockDrive,
      deviceId: localDeviceId
    });

    assert.equal(syncRes.success, true);

    // 6. Verify lineage hydration occurred
    const hydratedParent = await getSetting('last_parent_snapshot_id');
    assert.equal(hydratedParent, parentSnap, 'last_parent_snapshot_id must be hydrated to v8');

    // 7. Verify peer D package 6 was discovered, staged, and reconciled
    assert.equal(syncRes.inbound.stagedPackagesCount, 1, 'D seq6 package should be staged');
    assert.equal(syncRes.reconciliation.reconciledCount, 1, 'D seq6 event should be reconciled');

    // 8. Verify peer watermark advanced 5 -> 6
    const peerState = (await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [peerDeviceId])).values[0];
    assert.equal(peerState.last_reconciled_sequence, 6, 'Watermark for peer D must advance to 6');

    // 9. Verify transaction count changed from 2 -> 3 (29044 -> 29045 equivalent)
    const txns = (await db.query('SELECT * FROM transactions ORDER BY id')).values;
    assert.equal(txns.length, 3, 'New transaction from D seq6 must be present');
    assert.equal(txns.some(t => t.id === 'txn_d_new'), true, 'txn_d_new must be inserted into canonical DB');
  });
});
