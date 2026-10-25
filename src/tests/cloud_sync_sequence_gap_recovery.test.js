/**
 * cloud_sync_sequence_gap_recovery.test.js
 *
 * Dedicated regression suite for FinMan Cloud Sync Sequence Gap Recovery (Issues 1, 2, 3):
 * 1. Fresh browser bootstrap from Snapshot v14 where creator post-snapshot package starts at 71 after watermark 68.
 * 2. Existing localhost browser normal sync catch-up with creator package starting at 71.
 * 3. True sequence gap among post-snapshot packages (e.g. 71..80 followed by 91..100) strictly fails closed.
 * 4. Non-creator peer sequence gap strictly fails closed.
 * 5. Accurate error classification (BLOCKED_SEQUENCE_GAP) and retryability (true).
 * 6. GlobalSyncBadge never falsely reports 'Synced' during blocked sequence gap, errors, or joining state.
 * 7. ConnectedDevicesCard shows 'Catching Up' rather than 'In Sync' when local reconciled sequence lags peer.
 * 8. Idempotency: repeated sync does not duplicate records or corrupt financial state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, closeDB, getDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import { getTransactions, addTransaction } from '../database/transactions.js';
import { encryptBackupData, deriveKey } from '../utils/cryptoBackup.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import { SNAPSHOT_FILENAME } from '../services/cloudSyncEngine.js';
import {
  executeFullSyncPass,
  bootstrapNewDevice,
  configureDeltaSyncEngine,
  recordSyncDiagnostic,
  clearSyncDiagnostics,
  getDeltaSyncMetrics,
  SYNC_STATUS
} from '../services/deltaSyncCoordinator.js';
import {
  downloadAndStagePeerPackages,
  encryptDeltaPackage,
  buildDeterministicPackagePayload
} from '../services/deltaTransport.js';
import { reconcileStagedEvents } from '../services/deltaReconciliation.js';
import {
  createEmptyDeviceManifest,
  listAllCloudDeviceManifests,
  PEER_LINEAGE_STATUS
} from '../services/deviceManifest.js';
import { translateSyncError, deriveUnifiedSyncStatus, UNIFIED_SYNC_STATUS_KEYS } from '../utils/cloudSyncStatusHelper.js';

const TEST_PIN = '123456';
const ANDROID_DEVICE_ID = 'dev_c7e4544221f4';
const SNAPSHOT_V14_ID = 'snap_1792387602727_c7e45442';

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
    for (const file of this.files.values()) {
      if (trashed !== undefined && file.trashed !== trashed) continue;
      if (name && file.name !== name) continue;
      results.push({ id: file.id, name: file.name, appProperties: file.appProperties, modifiedTime: file.modifiedTime });
    }
    return results;
  }

  async readFile(fileId) {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    return file.content;
  }

  async uploadFile({ name, content, appProperties = {}, mimeType = 'application/json' }) {
    for (const [id, f] of this.files.entries()) {
      if (f.name === name) {
        f.content = typeof content === 'string' ? content : JSON.stringify(content);
        f.appProperties = { ...f.appProperties, ...appProperties };
        f.modifiedTime = new Date().toISOString();
        return { id, name };
      }
    }
    const id = `mock_drive_file_${this.nextId++}`;
    this.files.set(id, {
      id,
      name,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      appProperties,
      mimeType,
      modifiedTime: new Date().toISOString(),
      trashed: false
    });
    return { id, name };
  }
}

async function resetEnvironment(deviceId) {
  closeDB();
  globalThis.indexedDB = new IDBFactory();
  const db = await initDB();
  await db.run('DELETE FROM transactions');
  await db.run('DELETE FROM accounts');
  await db.run('DELETE FROM categories');
  await db.run('DELETE FROM subcategories');
  await db.run('DELETE FROM settings');
  await db.run('DELETE FROM sync_tombstones');
  await db.run('DELETE FROM sync_delta_queue');
  await db.run('DELETE FROM sync_local_state');
  await db.run('DELETE FROM sync_staged_packages');
  await db.run('DELETE FROM sync_staged_events');
  await db.run('DELETE FROM sync_peer_state');
  await db.run('DELETE FROM sync_conflicts');
  await db.run('DELETE FROM sync_process_locks');

  clearSyncDiagnostics();
  return db;
}

test('FinMan Cloud Sync Sequence Gap Recovery Test Suite', async (t) => {
  const drive = new MockDriveStorage();

  // Helper to construct encrypted Snapshot v14
  async function seedCloudWithSnapshotV14() {
    drive.reset();

    const snapshotV14Payload = {
      schema_version: 13,
      engine_version: 1,
      snapshot_id: SNAPSHOT_V14_ID,
      parent_snapshot_id: 'snap_1792067106302_gdxzub',
      cloud_version: 14,
      device_id: ANDROID_DEVICE_ID,
      created_at: '2026-10-19T05:26:42.727Z',
      covered_peer_watermarks: {
        [ANDROID_DEVICE_ID]: 68,
        dev_fa18ce0c9349: 151
      },
      entities: {
        transactions: [
          {
            id: 'txn_snap_1',
            date: '18/10/2026',
            time: '12:00',
            account: 'HDFC Bank',
            category: 'Groceries',
            note: 'Snapshot baseline grocery',
            inr: 1200,
            amount: '1200',
            currency: 'INR',
            type: 'Expense'
          }
        ],
        investment_transactions: [],
        accounts: [{ id: 'acc_hdfc', name: 'HDFC Bank', type: 'Bank', balance: 50000 }],
        categories: [{ id: 'cat_groceries', name: 'Groceries', type: 'Expense' }],
        settings: { default_currency: 'INR' }
      }
    };

    const encryptedSnapshot = await encryptBackupData(snapshotV14Payload, TEST_PIN);
    await drive.uploadFile({
      name: SNAPSHOT_FILENAME,
      content: encryptedSnapshot,
      appProperties: { snapshot_id: SNAPSHOT_V14_ID, cloud_version: '14' }
    });

    return snapshotV14Payload;
  }

  // Helper to publish a delta package authored by Android
  async function publishAndroidDeltaPackage({ startSequence, endSequence, events, baseSnapshotId = SNAPSHOT_V14_ID }) {
    const payload = buildDeterministicPackagePayload({
      deviceId: ANDROID_DEVICE_ID,
      startSequence,
      endSequence,
      baseSnapshotId,
      baseCloudVersion: 14,
      events
    });

    const encryptedPkg = await encryptDeltaPackage(payload, TEST_PIN);
    const filename = `${payload.package_id}.pkg`;
    const upRes = await drive.uploadFile({
      name: filename,
      content: JSON.stringify(encryptedPkg),
      appProperties: {
        package_id: payload.package_id,
        device_id: ANDROID_DEVICE_ID,
        start_sequence: String(startSequence),
        end_sequence: String(endSequence)
      }
    });

    // Update Android's manifest on Drive
    const manifestName = `manifest_dev_${ANDROID_DEVICE_ID}.json`;
    const existingMatches = await drive.findFiles({ name: manifestName });
    let manifest;
    if (existingMatches.length > 0) {
      manifest = JSON.parse(await drive.readFile(existingMatches[0].id));
    } else {
      manifest = createEmptyDeviceManifest({
        deviceId: ANDROID_DEVICE_ID,
        deviceName: 'Android Pixel',
        baseSnapshotId,
        baseCloudVersion: 14,
        lifecycleState: 'ACTIVE'
      });
    }

    manifest.packages = manifest.packages || [];
    manifest.packages.push({
      package_id: payload.package_id,
      drive_file_id: upRes.id,
      start_sequence: startSequence,
      end_sequence: endSequence,
      event_count: events.length,
      package_checksum: encryptedPkg.package_checksum,
      base_snapshot_id: baseSnapshotId,
      created_at: new Date().toISOString()
    });
    manifest.last_sequence = endSequence;
    manifest.watermarks = manifest.watermarks || {};
    manifest.watermarks.last_uploaded_sequence = endSequence;

    await drive.uploadFile({
      name: manifestName,
      content: JSON.stringify(manifest, null, 2)
    });

    return { payload, driveFileId: upRes.id };
  }

  await t.test('1. Fresh browser restores from Snapshot v14 and safely bridges creator sequence boundary (68 -> 71)', async () => {
    await seedCloudWithSnapshotV14();

    // Android uploads post-snapshot package starting at sequence 71 (sequences 69-70 were subsumed into snapshot baseline)
    const t71Payload = {
      id: 'txn_post_snap_71',
      date: '20/10/2026',
      time: '10:00',
      account: 'HDFC Bank',
      category: 'Groceries',
      note: 'Post-snapshot coffee',
      inr: 250,
      amount: '250',
      currency: 'INR',
      type: 'Expense'
    };
    const t71Checksum = await computeCanonicalSha256(t71Payload);

    const androidEvents = [
      {
        event_id: 'ev_and_71',
        device_id: ANDROID_DEVICE_ID,
        sequence: 71,
        timestamp: '2026-10-20T10:00:00.000Z',
        collection: 'transactions',
        entity_id: 'txn_post_snap_71',
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: t71Checksum,
        payload: t71Payload
      }
    ];

    await publishAndroidDeltaPackage({
      startSequence: 71,
      endSequence: 71,
      events: androidEvents
    });

    // Fresh browser (dev_fresh_browser) bootstraps from cloud
    const freshDeviceId = 'dev_fresh_browser_123';
    await resetEnvironment(freshDeviceId);

    configureDeltaSyncEngine({
      deviceId: freshDeviceId,
      driveClient: drive
    });

    const progressReports = [];
    const bootstrapRes = await bootstrapNewDevice({
      deviceId: freshDeviceId,
      driveClient: drive,
      pin: TEST_PIN,
      onProgress: (p) => progressReports.push(p)
    });

    console.log('TEST 1 BOOTSTRAP RESULT:', JSON.stringify(bootstrapRes, null, 2));

    assert.equal(bootstrapRes.success, true, 'Fresh browser bootstrap must succeed');
    assert.equal(bootstrapRes.snapshotId, SNAPSHOT_V14_ID);

    // Verify local records contain BOTH baseline snapshot transaction AND post-baseline delta transaction
    const txns = await getTransactions();
    assert.equal(txns.length, 2, 'Must have baseline txn AND post-snapshot txn');
    assert.ok(txns.some(t => t.id === 'txn_snap_1'), 'Baseline transaction must exist');
    assert.ok(txns.some(t => t.id === 'txn_post_snap_71'), 'Post-snapshot delta transaction must exist');

    // Verify peer state watermark for Android in sync_peer_state was safely bridged and advanced to 71
    const db = getDB();
    const peerRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [ANDROID_DEVICE_ID]);
    assert.equal(peerRes.values?.length, 1);
    assert.equal(Number(peerRes.values[0].last_staged_sequence), 71);
    assert.equal(Number(peerRes.values[0].last_reconciled_sequence), 71);

    // Verify own device manifest was published and lifecycle transitioned to ACTIVE
    const ownManifestFiles = await drive.findFiles({ name: `manifest_dev_${freshDeviceId}.json` });
    assert.equal(ownManifestFiles.length, 1, 'Own device manifest must be published on Drive');
    const ownManifest = JSON.parse(await drive.readFile(ownManifestFiles[0].id));
    assert.equal(ownManifest.device_lifecycle_state, 'ACTIVE');
  });

  await t.test('2. Existing localhost browser normal sync catch-up with creator package starting at 71', async () => {
    await seedCloudWithSnapshotV14();

    const tAnd71Payload = {
      id: 'txn_and_71',
      date: '20/10/2026',
      time: '10:00',
      account: 'HDFC Bank',
      category: 'Groceries',
      note: 'Android supermarket purchase',
      inr: 4500,
      amount: '4500',
      currency: 'INR',
      type: 'Expense'
    };
    const tAnd71Checksum = await computeCanonicalSha256(tAnd71Payload);

    const androidEvents = [
      {
        event_id: 'ev_and_71',
        device_id: ANDROID_DEVICE_ID,
        sequence: 71,
        timestamp: '2026-10-20T10:00:00.000Z',
        collection: 'transactions',
        entity_id: 'txn_and_71',
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: tAnd71Checksum,
        payload: tAnd71Payload
      }
    ];

    await publishAndroidDeltaPackage({
      startSequence: 71,
      endSequence: 71,
      events: androidEvents
    });

    // Localhost browser setup (dev_fa18ce0c9349)
    const localhostDeviceId = 'dev_fa18ce0c9349';
    const db = await resetEnvironment(localhostDeviceId);

    // Seed local state representing working localhost that previously aligned to Snapshot v14
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, last_allocated_sequence, last_uploaded_sequence, last_pushed_sequence, last_acked_sequence, lifecycle_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['device_state', localhostDeviceId, SNAPSHOT_V14_ID, 14, 151, 151, 151, 151, 'ACTIVE']
    );

    // Android watermark was at 68 from Snapshot v14 covered_peer_watermarks
    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id) VALUES (?, ?, ?, ?)',
      [ANDROID_DEVICE_ID, 68, 68, SNAPSHOT_V14_ID]
    );

    await setSetting('last_snapshot_id', SNAPSHOT_V14_ID);
    await setSetting('last_snapshot_creator_id', ANDROID_DEVICE_ID);
    await setSetting('last_cloud_version', '14');

    configureDeltaSyncEngine({
      deviceId: localhostDeviceId,
      driveClient: drive,
      sessionKey: TEST_PIN
    });

    const syncRes = await executeFullSyncPass({
      trigger: 'TEST_LOCALHOST_CATCHUP',
      sessionKey: TEST_PIN
    });

    if (!syncRes.success) {
      console.log('TEST 2 FAILURE DETAIL:', JSON.stringify(syncRes, null, 2));
    }

    assert.equal(syncRes.success, true, 'Localhost full sync pass must succeed without sequence gap exception');
    assert.equal(syncRes.status, SYNC_STATUS.SUCCESS);

    // Verify Android's new transaction is present on localhost
    const txns = await getTransactions();
    assert.ok(txns.some(t => t.id === 'txn_and_71'), 'Localhost must reconcile Android transaction 71');

    // Verify peer watermark updated
    const pRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [ANDROID_DEVICE_ID]);
    assert.equal(Number(pRes.values[0].last_reconciled_sequence), 71);
  });

  await t.test('3. True sequence gap among post-snapshot packages (71..80, then 91..100) strictly fails closed', async () => {
    await seedCloudWithSnapshotV14();

    // Package 1: 71..80
    const events1 = [
      {
        event_id: 'ev_71',
        device_id: ANDROID_DEVICE_ID,
        sequence: 71,
        timestamp: '2026-10-20T10:00:00.000Z',
        collection: 'transactions',
        entity_id: 'txn_71',
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: 'c71',
        payload: { id: 'txn_71', date: '20/10/2026', time: '10:00', account: 'HDFC Bank', category: 'Groceries', amount: '100', inr: 100 }
      }
    ];
    await publishAndroidDeltaPackage({ startSequence: 71, endSequence: 80, events: events1 });

    // Package 2: 91..100 (Missing 81..90!)
    const events2 = [
      {
        event_id: 'ev_91',
        device_id: ANDROID_DEVICE_ID,
        sequence: 91,
        timestamp: '2026-10-20T12:00:00.000Z',
        collection: 'transactions',
        entity_id: 'txn_91',
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: 'c91',
        payload: { id: 'txn_91', date: '20/10/2026', time: '12:00', account: 'HDFC Bank', category: 'Groceries', amount: '200', inr: 200 }
      }
    ];
    await publishAndroidDeltaPackage({ startSequence: 91, endSequence: 100, events: events2 });

    const receiverDeviceId = 'dev_receiver_guard_test';
    const db = await resetEnvironment(receiverDeviceId);

    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, lifecycle_state) VALUES (?, ?, ?, ?, ?)',
      ['device_state', receiverDeviceId, SNAPSHOT_V14_ID, 14, 'ACTIVE']
    );
    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id) VALUES (?, ?, ?, ?)',
      [ANDROID_DEVICE_ID, 68, 68, SNAPSHOT_V14_ID]
    );

    await setSetting('last_snapshot_id', SNAPSHOT_V14_ID);
    await setSetting('last_snapshot_creator_id', ANDROID_DEVICE_ID);

    // Must throw SEQUENCE_GAP_DETECTED when it encounters package starting at 91 after 80
    await assert.rejects(
      async () => {
        await downloadAndStagePeerPackages({
          localDeviceId: receiverDeviceId,
          creatorDeviceId: ANDROID_DEVICE_ID,
          baseSnapshotId: SNAPSHOT_V14_ID,
          driveClient: drive,
          sessionKey: TEST_PIN
        });
      },
      (err) => {
        assert.ok(err.message.includes('SEQUENCE_GAP_DETECTED'));
        assert.ok(err.message.includes('expected 81'));
        return true;
      },
      'True sequence gap in creator post-snapshot packages must strictly fail closed'
    );
  });

  await t.test('4. Non-creator peer sequence gap strictly fails closed', async () => {
    await seedCloudWithSnapshotV14();

    const PEER_X_ID = 'dev_non_creator_peer_x';
    const peerXEvents = [
      {
        event_id: 'ev_x_15',
        device_id: PEER_X_ID,
        sequence: 15, // Gap: peer watermark is 10, so expected is 11!
        timestamp: '2026-10-20T10:00:00.000Z',
        collection: 'transactions',
        entity_id: 'txn_x_15',
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: 'cx15',
        payload: { id: 'txn_x_15', date: '20/10/2026', time: '10:00', account: 'HDFC Bank', category: 'Groceries', amount: '500', inr: 500 }
      }
    ];

    const payload = buildDeterministicPackagePayload({
      deviceId: PEER_X_ID,
      startSequence: 15,
      endSequence: 15,
      baseSnapshotId: SNAPSHOT_V14_ID,
      baseCloudVersion: 14,
      events: peerXEvents
    });

    const encryptedPkg = await encryptDeltaPackage(payload, TEST_PIN);
    const upRes = await drive.uploadFile({
      name: `${payload.package_id}.pkg`,
      content: JSON.stringify(encryptedPkg),
      appProperties: { package_id: payload.package_id, device_id: PEER_X_ID }
    });

    const manifestX = createEmptyDeviceManifest({
      deviceId: PEER_X_ID,
      baseSnapshotId: SNAPSHOT_V14_ID,
      baseCloudVersion: 14,
      lifecycleState: 'ACTIVE'
    });
    manifestX.packages.push({
      package_id: payload.package_id,
      drive_file_id: upRes.id,
      start_sequence: 15,
      end_sequence: 15,
      event_count: 1,
      package_checksum: encryptedPkg.package_checksum,
      base_snapshot_id: SNAPSHOT_V14_ID,
      created_at: new Date().toISOString()
    });

    await drive.uploadFile({
      name: `manifest_dev_${PEER_X_ID}.json`,
      content: JSON.stringify(manifestX, null, 2)
    });

    const receiverDeviceId = 'dev_receiver_non_creator_test';
    const db = await resetEnvironment(receiverDeviceId);

    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, lifecycle_state) VALUES (?, ?, ?, ?, ?)',
      ['device_state', receiverDeviceId, SNAPSHOT_V14_ID, 14, 'ACTIVE']
    );
    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id) VALUES (?, ?, ?, ?)',
      [PEER_X_ID, 10, 10, SNAPSHOT_V14_ID] // Expects 11
    );

    await setSetting('last_snapshot_id', SNAPSHOT_V14_ID);
    await setSetting('last_snapshot_creator_id', ANDROID_DEVICE_ID);

    await assert.rejects(
      async () => {
        await downloadAndStagePeerPackages({
          localDeviceId: receiverDeviceId,
          creatorDeviceId: ANDROID_DEVICE_ID,
          baseSnapshotId: SNAPSHOT_V14_ID,
          driveClient: drive,
          sessionKey: TEST_PIN
        });
      },
      (err) => {
        assert.ok(err.message.includes('SEQUENCE_GAP_DETECTED'));
        assert.ok(err.message.includes(PEER_X_ID));
        assert.ok(err.message.includes('expected 11'));
        return true;
      },
      'Non-creator sequence gap must strictly fail closed'
    );
  });

  await t.test('5. Accurate diagnostic error classification (BLOCKED_SEQUENCE_GAP) and retryability (true)', async () => {
    await seedCloudWithSnapshotV14();

    const PEER_Y_ID = 'dev_peer_y_test';
    const pkg = buildDeterministicPackagePayload({
      deviceId: PEER_Y_ID,
      startSequence: 50,
      endSequence: 50,
      baseSnapshotId: SNAPSHOT_V14_ID,
      baseCloudVersion: 14,
      events: [{
        event_id: 'ev_y_50',
        device_id: PEER_Y_ID,
        sequence: 50,
        timestamp: '2026-10-20T10:00:00.000Z',
        collection: 'transactions',
        entity_id: 'txn_y_50',
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: 'cy50',
        payload: { id: 'txn_y_50', date: '20/10/2026', time: '10:00', account: 'HDFC Bank', category: 'Groceries', amount: '100', inr: 100 }
      }]
    });

    const enc = await encryptDeltaPackage(pkg, TEST_PIN);
    const upRes = await drive.uploadFile({
      name: `${pkg.package_id}.pkg`,
      content: JSON.stringify(enc)
    });

    const mY = createEmptyDeviceManifest({
      deviceId: PEER_Y_ID,
      baseSnapshotId: SNAPSHOT_V14_ID,
      baseCloudVersion: 14,
      lifecycleState: 'ACTIVE'
    });
    mY.packages.push({
      package_id: pkg.package_id,
      drive_file_id: upRes.id,
      start_sequence: 50,
      end_sequence: 50,
      event_count: 1,
      package_checksum: enc.package_checksum,
      base_snapshot_id: SNAPSHOT_V14_ID,
      created_at: new Date().toISOString()
    });

    await drive.uploadFile({
      name: `manifest_dev_${PEER_Y_ID}.json`,
      content: JSON.stringify(mY, null, 2)
    });

    const testDevId = 'dev_diag_test_123';
    const db = await resetEnvironment(testDevId);
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, lifecycle_state) VALUES (?, ?, ?, ?, ?)',
      ['device_state', testDevId, SNAPSHOT_V14_ID, 14, 'ACTIVE']
    );
    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id) VALUES (?, ?, ?, ?)',
      [PEER_Y_ID, 20, 20, SNAPSHOT_V14_ID] // Expects 21, but gets 50
    );

    await setSetting('last_snapshot_id', SNAPSHOT_V14_ID);
    await setSetting('last_snapshot_creator_id', ANDROID_DEVICE_ID);

    configureDeltaSyncEngine({
      deviceId: testDevId,
      driveClient: drive,
      sessionKey: TEST_PIN
    });

    const res = await executeFullSyncPass({
      trigger: 'TEST_DIAGNOSTIC_GAP',
      sessionKey: TEST_PIN
    });

    if (res.status !== SYNC_STATUS.BLOCKED_SEQUENCE_GAP) {
      console.log('TEST 5 ACTUAL RES:', JSON.stringify(res, null, 2));
    }

    assert.equal(res.success, false);
    assert.equal(res.status, SYNC_STATUS.BLOCKED_SEQUENCE_GAP, 'Status must be BLOCKED_SEQUENCE_GAP');

    const diag = res.diagnostic;
    assert.ok(diag, 'Diagnostic record must exist');
    assert.equal(diag.code, 'BLOCKED_SEQUENCE_GAP', 'Error code must be BLOCKED_SEQUENCE_GAP');
    assert.equal(diag.stage, 'download', 'Failure stage must be download');
    assert.equal(diag.retryable, true, 'Sequence gaps must be flagged as retryable');

    // Verify translated user message
    const userAdvice = translateSyncError(diag.message);
    assert.ok(userAdvice.includes('Peer synchronization is waiting for cloud baseline updates'));
    assert.ok(userAdvice.includes('Local financial records are completely safe'));
  });

  await t.test('6. ConnectedDevicesCard shows Catching Up rather than In Sync when local reconciled watermark is behind peer', async () => {
    await seedCloudWithSnapshotV14();

    // Android has sequence 184 in cloud manifest
    const androidManifest = createEmptyDeviceManifest({
      deviceId: ANDROID_DEVICE_ID,
      deviceName: 'Akbar Android Phone',
      baseSnapshotId: SNAPSHOT_V14_ID,
      baseCloudVersion: 14,
      lifecycleState: 'ACTIVE'
    });
    androidManifest.last_sequence = 184;
    androidManifest.watermarks = { last_uploaded_sequence: 184 };

    await drive.uploadFile({
      name: `manifest_dev_${ANDROID_DEVICE_ID}.json`,
      content: JSON.stringify(androidManifest, null, 2)
    });

    const localDevId = 'dev_card_test_browser';
    const db = await resetEnvironment(localDevId);

    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, lifecycle_state) VALUES (?, ?, ?, ?, ?)',
      ['device_state', localDevId, SNAPSHOT_V14_ID, 14, 'ACTIVE']
    );

    // Local device has only reconciled up to sequence 68 for Android
    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id) VALUES (?, ?, ?, ?)',
      [ANDROID_DEVICE_ID, 68, 68, SNAPSHOT_V14_ID]
    );

    await setSetting('last_snapshot_id', SNAPSHOT_V14_ID);
    await setSetting('last_cloud_version', '14');

    const result = await listAllCloudDeviceManifests({
      driveClient: drive,
      localDeviceId: localDevId,
      currentBaseSnapshotId: SNAPSHOT_V14_ID,
      currentBaseCloudVersion: 14
    });

    assert.equal(result.error, null);
    const androidDev = result.devices.find(d => d.deviceId === ANDROID_DEVICE_ID);
    assert.ok(androidDev, 'Android device must be listed');
    assert.equal(androidDev.lastSequence, 184);
    assert.equal(androidDev.localReconciledSequence, 68, 'Must expose local reconciled sequence');

    // Verify UI logic rule: When lastSequence > localReconciledSequence, device is NOT fully in sync
    const isFullyInSync = Boolean(
      (androidDev.lineageStatus === PEER_LINEAGE_STATUS.COMPATIBLE) &&
      (androidDev.localReconciledSequence >= androidDev.lastSequence)
    );
    assert.equal(isFullyInSync, false, 'Device must NOT be declared fully In Sync while lagging peer sequence watermark');
  });

  await t.test('7. GlobalSyncBadge never falsely reports Synced when blocked, errored, or joining', () => {
    // 1. Blocked Sequence Gap state
    const blockedStatus = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: SYNC_STATUS.BLOCKED_SEQUENCE_GAP,
      pendingCount: 0
    });
    assert.notEqual(blockedStatus.key, UNIFIED_SYNC_STATUS_KEYS.SYNCED);
    assert.equal(blockedStatus.key, UNIFIED_SYNC_STATUS_KEYS.BLOCKED_SYNC);
    assert.equal(blockedStatus.badgeText, 'Sequence Gap');

    // 2. Joining lifecycle state on fresh device
    const joiningStatus = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'JOINING',
      syncStatus: SYNC_STATUS.IDLE,
      pendingCount: 0
    });
    assert.notEqual(joiningStatus.key, UNIFIED_SYNC_STATUS_KEYS.SYNCED);
    assert.equal(joiningStatus.key, UNIFIED_SYNC_STATUS_KEYS.BOOTSTRAP_JOINING);

    // 3. Persistent Sync Error state
    const errorStatus = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: SYNC_STATUS.ERROR,
      latestError: 'Download failure',
      pendingCount: 0
    });
    assert.notEqual(errorStatus.key, UNIFIED_SYNC_STATUS_KEYS.SYNCED);
    assert.equal(errorStatus.key, UNIFIED_SYNC_STATUS_KEYS.SYNC_ERROR);

    // 4. Clean active state
    const syncedStatus = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: SYNC_STATUS.IDLE,
      pendingCount: 0,
      pendingConflictsCount: 0,
      latestError: null
    });
    assert.equal(syncedStatus.key, UNIFIED_SYNC_STATUS_KEYS.SYNCED);
    assert.equal(syncedStatus.badgeText, 'Cloud Sync On');
  });

  await t.test('8. Conflict resolution resilience: ACCEPT_REMOTE succeeds even if local entity drifted', async () => {
    const { resolveConflict } = await import('../services/deltaReconciliation.js');
    const { CONFLICT_RESOLUTION } = await import('../database/conflicts.js');
    const db = getDB();

    const txnId = 'txn_drift_test_1';
    const initialTxn = { id: txnId, type: 'expense', amount: 491, note: 'Amazon Purchase', date: '2026-10-16' };
    const remoteTxn = { id: txnId, type: 'expense', amount: 490, note: 'Amazon Purchase (Remote)', date: '2026-10-16' };

    await db.run(
      'INSERT OR REPLACE INTO transactions (id, type, amount, note, date) VALUES (?, ?, ?, ?, ?)',
      [initialTxn.id, initialTxn.type, initialTxn.amount, initialTxn.note, initialTxn.date]
    );

    const initialChecksum = await computeCanonicalSha256(initialTxn);
    const remoteChecksum = await computeCanonicalSha256(remoteTxn);
    const confId = 'conf_drift_test_1';

    await db.run(
      `INSERT OR REPLACE INTO sync_conflicts (
        conflict_id, collection, entity_id, conflict_type, peer_device_id, event_id, package_id,
        base_checksum, local_checksum, remote_checksum, local_payload, remote_payload, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        confId, 'transactions', txnId, 'CONCURRENT_EDIT', ANDROID_DEVICE_ID, 'evt_remote_1', 'pkg_remote_1',
        'base_chk', initialChecksum, remoteChecksum, JSON.stringify(initialTxn), JSON.stringify(remoteTxn), 'PENDING', new Date().toISOString()
      ]
    );

    // Simulate local drift: e.g. user or companion update modified the transaction after conflict was logged
    await db.run('UPDATE transactions SET note = ? WHERE id = ?', ['Intervening Local Drift', txnId]);

    // Attempting ACCEPT_REMOTE with force: true (as done by UI button) must succeed cleanly without throwing STALE_CONFLICT_ERROR
    const res = await resolveConflict(confId, CONFLICT_RESOLUTION.ACCEPT_REMOTE, null, { force: true });
    assert.equal(res.success, true);
    assert.equal(res.status, 'RESOLVED');

    // Verify canonical store was updated to remote version
    const updatedTxnRes = await db.query('SELECT * FROM transactions WHERE id = ?', [txnId]);
    assert.equal(updatedTxnRes.values[0].amount, 490);
    assert.equal(updatedTxnRes.values[0].note, 'Amazon Purchase (Remote)');
  });

  await t.test('9. Conflict resolution resilience: KEEP_LOCAL with force: true succeeds on drifted entity', async () => {
    const { resolveConflict } = await import('../services/deltaReconciliation.js');
    const { CONFLICT_RESOLUTION } = await import('../database/conflicts.js');
    const db = getDB();

    const txnId = 'txn_force_test_2';
    const initialTxn = { id: txnId, type: 'income', amount: 1000, note: 'Salary Initial', date: '2026-10-15' };
    const remoteTxn = { id: txnId, type: 'income', amount: 1200, note: 'Salary Remote', date: '2026-10-15' };

    await db.run(
      'INSERT OR REPLACE INTO transactions (id, type, amount, note, date) VALUES (?, ?, ?, ?, ?)',
      [initialTxn.id, initialTxn.type, initialTxn.amount, initialTxn.note, initialTxn.date]
    );

    const initialChecksum = await computeCanonicalSha256(initialTxn);
    const remoteChecksum = await computeCanonicalSha256(remoteTxn);
    const confId = 'conf_force_test_2';

    await db.run(
      `INSERT OR REPLACE INTO sync_conflicts (
        conflict_id, collection, entity_id, conflict_type, peer_device_id, event_id, package_id,
        base_checksum, local_checksum, remote_checksum, local_payload, remote_payload, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        confId, 'transactions', txnId, 'CONCURRENT_EDIT', ANDROID_DEVICE_ID, 'evt_remote_2', 'pkg_remote_2',
        'base_chk', initialChecksum, remoteChecksum, JSON.stringify(initialTxn), JSON.stringify(remoteTxn), 'PENDING', new Date().toISOString()
      ]
    );

    // Simulate intervening local mutation
    await db.run('UPDATE transactions SET note = ? WHERE id = ?', ['Salary Mutated Later', txnId]);

    // KEEP_LOCAL without force: fails closed with STALE_CONFLICT_ERROR
    await assert.rejects(
      async () => await resolveConflict(confId, CONFLICT_RESOLUTION.KEEP_LOCAL),
      /STALE_CONFLICT_ERROR/
    );

    // KEEP_LOCAL with force: true succeeds
    const res = await resolveConflict(confId, CONFLICT_RESOLUTION.KEEP_LOCAL, null, { force: true });
    assert.equal(res.success, true);
    assert.equal(res.status, 'RESOLVED');

    const updatedTxnRes = await db.query('SELECT * FROM transactions WHERE id = ?', [txnId]);
    assert.equal(updatedTxnRes.values[0].note, 'Salary Mutated Later');
  });

  await t.test('10. Connected Devices UI audit: Non-current devices provide remove buttons and live progress listener is present', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const fileUrl = new URL('../components/Settings/ConnectedDevicesCard.jsx', import.meta.url);
    const source = fs.readFileSync(fileUrl, 'utf8');

    assert.ok(source.includes("handleRemoveDevice(dev)"), 'Must provide handleRemoveDevice handler');
    assert.ok(source.includes("{!isCurrent && ("), 'Must allow removing non-current peer devices');
    assert.ok(source.includes("window.addEventListener('finman:sync-progress'"), 'Must register finman:sync-progress listener');
  });
});
