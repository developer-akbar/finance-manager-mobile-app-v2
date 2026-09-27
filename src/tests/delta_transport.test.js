/**
 * delta_transport.test.js — Phase 7.3 Delta Transport, Cryptography, Concurrency & Staging Test Suite
 * 
 * Implements and verifies protocol test cases T01 to T40 with strict safety invariants:
 * - Deterministic RFC 8785 package payloads and non-circular checksums
 * - AES-256-GCM authenticated transport encryption / decryption
 * - Duplicate-safe Google Drive package discovery (reuse on match, fail-closed on collision)
 * - Multi-tab same-device Web Lock concurrency & fallback lock safety
 * - Atomic local staging (sync_staged_packages, sync_staged_events, sync_peer_state) with rollback
 * - Zero modification of canonical financial records (transactions, accounts, categories, investments)
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
  getPendingDeltaEvents,
  DELTA_STATUS,
  DELTA_OPERATION
} from '../database/index.js';
import {
  buildPackageId,
  buildDeterministicPackagePayload,
  computePackageChecksum,
  encryptDeltaPackage,
  decryptDeltaPackage,
  slicePendingDeltaQueue,
  uploadPendingDeltas,
  pullPeerDeltas,
  stagePeerPackageAtomically,
  TRANSPORT_SCHEMA_VERSION,
  TARGET_PACKAGE_EVENTS,
  NORMAL_MAX_PACKAGE_EVENTS
} from '../services/deltaTransport.js';
import {
  createEmptyDeviceManifest,
  getDeviceManifestFilename,
  withSameDeviceLock,
  readOwnDeviceManifest,
  writeOwnDeviceManifest,
  listPeerManifests
} from '../services/deviceManifest.js';
import { bytesToBase64, base64ToBytes } from '../utils/cryptoBackup.js';

const TEST_SESSION_KEY = 'test-secret-passphrase-finman-v3-delta-transport';
const BASE_SNAPSHOT_ID = 'snap_1790493064581_jbhnf8';
const BASE_CLOUD_VERSION = 8;

/**
 * In-memory Mock Google Drive Storage for Transport Testing
 */
class MockGoogleDriveTransportStorage {
  constructor() {
    this.files = new Map(); // fileId -> { id, name, content, appProperties, trashed }
    this.nextId = 1;
  }

  reset() {
    this.files.clear();
    this.nextId = 1;
  }

  async findFiles({ name, trashed = false }) {
    const results = [];
    for (const [id, f] of this.files.entries()) {
      if (f.trashed === trashed && (!name || f.name === name)) {
        results.push({
          id: f.id,
          name: f.name,
          appProperties: { ...f.appProperties }
        });
      }
    }
    return results;
  }

  async uploadFile({ name, content, appProperties = {} }) {
    const id = `drive_file_${this.nextId++}`;
    this.files.set(id, {
      id,
      name,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      appProperties: { ...appProperties },
      trashed: false
    });
    return { id, name, appProperties };
  }

  async readFile(fileId) {
    const file = this.files.get(fileId);
    if (!file || file.trashed) {
      throw new Error(`File not found: ${fileId}`);
    }
    try {
      return JSON.parse(file.content);
    } catch {
      return file.content;
    }
  }

  duplicateFile(sourceId) {
    const source = this.files.get(sourceId);
    if (!source) throw new Error('Source file not found');
    const id = `drive_file_${this.nextId++}`;
    this.files.set(id, {
      id,
      name: source.name,
      content: source.content,
      appProperties: { ...source.appProperties },
      trashed: false
    });
    return id;
  }
}

function createSampleEvents(deviceId, startSeq, count, bundleSize = 1) {
  const events = [];
  let bundleId = null;
  let bundleIndex = 0;

  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    if (bundleSize > 1) {
      if (i % bundleSize === 0) {
        bundleId = `bnd_${deviceId}_${seq}`;
        bundleIndex = 0;
      } else {
        bundleIndex++;
      }
    }

    events.push({
      event_id: `evt_${deviceId}_${seq}`,
      device_id: deviceId,
      sequence: seq,
      timestamp: new Date(1700000000000 + seq * 1000).toISOString(),
      collection: 'transactions',
      entity_id: `tx_${seq}`,
      operation: DELTA_OPERATION.INSERT,
      base_checksum: null,
      new_checksum: `chk_${seq}`,
      tombstone_generation: 0,
      payload: { id: `tx_${seq}`, amount: 100 + seq, description: `Test Transaction ${seq}` },
      bundle_id: bundleSize > 1 ? bundleId : null,
      bundle_index: bundleSize > 1 ? bundleIndex : 0,
      bundle_total: bundleSize > 1 ? bundleSize : 1,
      bundle_checksum: bundleSize > 1 ? `bchk_${bundleId}` : null,
      parent_event_id: null,
      status: DELTA_STATUS.PENDING,
      created_at: new Date(1700000000000 + seq * 1000).toISOString()
    });
  }
  return events;
}

test('FinMan Phase 7.3 — Delta Transport & Peer Staging Comprehensive Suite (T01 - T40)', async (t) => {
  let mockDrive;

  t.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    mockDrive = new MockGoogleDriveTransportStorage();
  });

  t.afterEach(() => {
    closeDB();
  });

  // =========================================================================
  // T01 - T10: Package Assembly, Checksums, Cryptography & Upload Idempotency
  // =========================================================================

  await t.test('T01 — Package payload creation & RFC 8785 canonical JSON checksum determinism', async () => {
    const deviceId = 'dev_alpha';
    const events = createSampleEvents(deviceId, 1, 5);
    const payload = buildDeterministicPackagePayload({
      deviceId,
      startSequence: 1,
      endSequence: 5,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      baseCloudVersion: BASE_CLOUD_VERSION,
      events
    });

    assert.equal(payload.schema_version, 1);
    assert.equal(payload.package_id, 'pkg_dev_alpha_000001_000005');
    assert.equal(payload.event_count, 5);
    assert.equal(payload.events.length, 5);

    const checksum1 = await computePackageChecksum(payload);
    const checksum2 = await computePackageChecksum(payload);
    assert.ok(typeof checksum1 === 'string' && checksum1.length === 64, 'Valid SHA-256 hex');
    assert.equal(checksum1, checksum2, 'Checksum is strictly deterministic');
  });

  await t.test('T02 — AES-256-GCM transport encryption & decryption roundtrip', async () => {
    const deviceId = 'dev_alpha';
    const events = createSampleEvents(deviceId, 1, 10);
    const payload = buildDeterministicPackagePayload({
      deviceId,
      startSequence: 1,
      endSequence: 10,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });

    const encryptedContainer = await encryptDeltaPackage(payload, TEST_SESSION_KEY);
    assert.equal(encryptedContainer.package_id, 'pkg_dev_alpha_000001_000010');
    assert.equal(encryptedContainer.package_checksum, await computePackageChecksum(payload));
    assert.ok(encryptedContainer.ciphertext, 'Ciphertext exists');
    assert.ok(encryptedContainer.iv, 'IV exists');
    assert.ok(encryptedContainer.auth_tag, 'Auth tag exists');
    assert.ok(encryptedContainer.transport_created_at, 'Transport metadata timestamp exists');

    const decrypted = await decryptDeltaPackage(encryptedContainer, TEST_SESSION_KEY);
    assert.deepEqual(decrypted, payload, 'Decrypted payload matches original deterministic payload');
  });

  await t.test('T03 — Corrupted ciphertext or auth tag fails decryption closed', async () => {
    const deviceId = 'dev_alpha';
    const events = createSampleEvents(deviceId, 1, 5);
    const payload = buildDeterministicPackagePayload({
      deviceId,
      startSequence: 1,
      endSequence: 5,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });

    const encryptedContainer = await encryptDeltaPackage(payload, TEST_SESSION_KEY);
    
    // Corrupt ciphertext
    const corruptedCiphertext = {
      ...encryptedContainer,
      ciphertext: encryptedContainer.ciphertext.substring(0, 10) + 'X' + encryptedContainer.ciphertext.substring(11)
    };
    await assert.rejects(
      async () => await decryptDeltaPackage(corruptedCiphertext, TEST_SESSION_KEY),
      /Failed to decrypt transport package/
    );

    // Corrupt checksum in container
    const corruptedChecksum = {
      ...encryptedContainer,
      package_checksum: '0000000000000000000000000000000000000000000000000000000000000000'
    };
    await assert.rejects(
      async () => await decryptDeltaPackage(corruptedChecksum, TEST_SESSION_KEY),
      /Package checksum mismatch/
    );
  });

  await t.test('T04 — Package slice boundaries within target limits (100 events)', async () => {
    const events = createSampleEvents('dev_alpha', 1, 100);
    const slices = slicePendingDeltaQueue(events);
    assert.equal(slices.length, 1);
    assert.equal(slices[0].events.length, 100);
    assert.equal(slices[0].startSequence, 1);
    assert.equal(slices[0].endSequence, 100);
    assert.equal(slices[0].isOversizedBundle, false);
  });

  await t.test('T05 — Package slice boundaries with multi-event bundle integrity', async () => {
    const eventsPart1 = createSampleEvents('dev_alpha', 1, 95, 1);
    const eventsPart2 = createSampleEvents('dev_alpha', 96, 10, 10);
    const allEvents = [...eventsPart1, ...eventsPart2];

    const slices = slicePendingDeltaQueue(allEvents);
    assert.equal(slices.length, 1);
    assert.equal(slices[0].events.length, 105);
    assert.equal(slices[0].endSequence, 105);
  });

  await t.test('T06 — Oversized single bundle (>250 events) emitted as standalone package', async () => {
    const oversizedEvents = createSampleEvents('dev_alpha', 1, 300, 300);
    const slices = slicePendingDeltaQueue(oversizedEvents);
    assert.equal(slices.length, 1);
    assert.equal(slices[0].events.length, 300);
    assert.equal(slices[0].isOversizedBundle, true);
    assert.equal(slices[0].packageId, 'pkg_dev_alpha_000001_000300');
  });

  await t.test('T07 — Clean upload when no matching package exists in Drive', async () => {
    await initDB();
    const rawIdb = getRawIDB();
    const deviceId = 'dev_clean';
    await initLocalSyncState(deviceId, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    // Queue 50 events in local queue
    const events = createSampleEvents(deviceId, 1, 50);
    const tx = rawIdb.transaction('sync_delta_queue', 'readwrite');
    const qStore = tx.objectStore('sync_delta_queue');
    for (const e of events) {
      qStore.add(e);
    }
    await new Promise(r => tx.oncomplete = r);

    const result = await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.equal(result.packagesUploaded, 1);
    assert.equal(result.eventsUploaded, 50);
    assert.equal(result.lastUploadedSequence, 50);

    const pending = await getPendingDeltaEvents();
    assert.equal(pending.length, 0);

    const manifests = await mockDrive.findFiles({ name: `manifest_dev_${deviceId}.json` });
    assert.equal(manifests.length, 1);
    const manifestContent = await mockDrive.readFile(manifests[0].id);
    assert.equal(manifestContent.packages.length, 1);
    assert.equal(manifestContent.last_sequence, 50);
  });

  await t.test('T08 — Duplicate upload idempotency: matching package_id and checksum reuses file', async () => {
    await initDB();
    const rawIdb = getRawIDB();
    const deviceId = 'dev_dup';
    await initLocalSyncState(deviceId, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    const events = createSampleEvents(deviceId, 1, 20);
    const tx = rawIdb.transaction('sync_delta_queue', 'readwrite');
    const qStore = tx.objectStore('sync_delta_queue');
    for (const e of events) {
      qStore.add(e);
    }
    await new Promise(r => tx.oncomplete = r);

    // First upload
    await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    const initialFilesCount = mockDrive.files.size;

    // Reset local state to simulate retry of same events
    const stateTx = rawIdb.transaction(['sync_local_state', 'sync_delta_queue'], 'readwrite');
    stateTx.objectStore('sync_local_state').put({
      key: 'device_state',
      device_id: deviceId,
      last_allocated_sequence: 20,
      last_uploaded_sequence: 0,
      base_snapshot_id: BASE_SNAPSHOT_ID,
      base_cloud_version: BASE_CLOUD_VERSION,
      updated_at: new Date().toISOString()
    });
    for (const e of events) {
      stateTx.objectStore('sync_delta_queue').put({ ...e, status: DELTA_STATUS.PENDING });
    }
    await new Promise(r => stateTx.oncomplete = r);

    // Second upload attempt (retry)
    const retryResult = await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.equal(retryResult.packagesUploaded, 1);
    assert.equal(retryResult.lastUploadedSequence, 20);
    assert.equal(mockDrive.files.size, initialFilesCount, 'No extra Drive package was uploaded');
  });

  await t.test('T09 — Multiple Drive files with identical package_id + checksum treated as one logical package', async () => {
    await initDB();
    const rawIdb = getRawIDB();
    const deviceId = 'dev_multi_match';
    await initLocalSyncState(deviceId, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    const events = createSampleEvents(deviceId, 1, 10);
    const tx = rawIdb.transaction('sync_delta_queue', 'readwrite');
    const qStore = tx.objectStore('sync_delta_queue');
    for (const e of events) {
      qStore.add(e);
    }
    await new Promise(r => tx.oncomplete = r);

    await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    const packageFiles = await mockDrive.findFiles({ name: 'pkg_dev_multi_match_000001_000010.pkg' });
    assert.equal(packageFiles.length, 1);
    mockDrive.duplicateFile(packageFiles[0].id);

    const allMatches = await mockDrive.findFiles({ name: 'pkg_dev_multi_match_000001_000010.pkg' });
    assert.equal(allMatches.length, 2, 'Two physical Drive files exist');

    const stateTx = rawIdb.transaction(['sync_local_state', 'sync_delta_queue'], 'readwrite');
    stateTx.objectStore('sync_local_state').put({
      key: 'device_state',
      device_id: deviceId,
      last_allocated_sequence: 10,
      last_uploaded_sequence: 0,
      base_snapshot_id: BASE_SNAPSHOT_ID,
      base_cloud_version: BASE_CLOUD_VERSION,
      updated_at: new Date().toISOString()
    });
    for (const e of events) {
      stateTx.objectStore('sync_delta_queue').put({ ...e, status: DELTA_STATUS.PENDING });
    }
    await new Promise(r => stateTx.oncomplete = r);

    const retryResult = await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.equal(retryResult.packagesUploaded, 1);
    assert.equal(retryResult.lastUploadedSequence, 10);
  });

  await t.test('T10 — Collision: Same package_id with different checksum fails closed', async () => {
    await initDB();
    const rawIdb = getRawIDB();
    const deviceId = 'dev_collision';
    await initLocalSyncState(deviceId, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    const events1 = createSampleEvents(deviceId, 1, 10);
    const tx1 = rawIdb.transaction('sync_delta_queue', 'readwrite');
    for (const e of events1) {
      tx1.objectStore('sync_delta_queue').add(e);
    }
    await new Promise(r => tx1.oncomplete = r);

    await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    const events2 = createSampleEvents(deviceId, 1, 10);
    events2[0].payload.amount = 999999;
    const conflictingPayload = buildDeterministicPackagePayload({
      deviceId,
      startSequence: 1,
      endSequence: 10,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events: events2
    });
    const conflictingContainer = await encryptDeltaPackage(conflictingPayload, TEST_SESSION_KEY);

    const pkgFiles = await mockDrive.findFiles({ name: 'pkg_dev_collision_000001_000010.pkg' });
    mockDrive.files.set(pkgFiles[0].id, {
      ...mockDrive.files.get(pkgFiles[0].id),
      content: JSON.stringify(conflictingContainer),
      appProperties: {
        package_id: 'pkg_dev_collision_000001_000010',
        package_checksum: conflictingContainer.package_checksum
      }
    });

    const stateTx = rawIdb.transaction(['sync_local_state', 'sync_delta_queue'], 'readwrite');
    stateTx.objectStore('sync_local_state').put({
      key: 'device_state',
      device_id: deviceId,
      last_allocated_sequence: 10,
      last_uploaded_sequence: 0,
      base_snapshot_id: BASE_SNAPSHOT_ID,
      base_cloud_version: BASE_CLOUD_VERSION,
      updated_at: new Date().toISOString()
    });
    for (const e of events1) {
      stateTx.objectStore('sync_delta_queue').put({ ...e, status: DELTA_STATUS.PENDING });
    }
    await new Promise(r => stateTx.oncomplete = r);

    await assert.rejects(
      async () => await uploadPendingDeltas({
        deviceId,
        sessionKey: TEST_SESSION_KEY,
        driveClient: mockDrive
      }),
      /PACKAGE_ID_COLLISION|STORAGE_MISMATCH/
    );

    const pending = await getPendingDeltaEvents();
    assert.equal(pending.length, 10, 'Pending events remain queued');
  });

  // =========================================================================
  // T11 - T20: Crash/Retry, Manifest Handling, Peer Discovery & Deduplication
  // =========================================================================

  await t.test('T11 — Lost upload response recovery: package uploaded + manifest updated, local queue ACKed on retry', async () => {
    await initDB();
    const rawIdb = getRawIDB();
    const deviceId = 'dev_lost_resp';
    await initLocalSyncState(deviceId, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    const events = createSampleEvents(deviceId, 1, 15);
    const tx = rawIdb.transaction('sync_delta_queue', 'readwrite');
    for (const e of events) {
      tx.objectStore('sync_delta_queue').add(e);
    }
    await new Promise(r => tx.oncomplete = r);

    await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    const stateTx = rawIdb.transaction(['sync_local_state', 'sync_delta_queue'], 'readwrite');
    stateTx.objectStore('sync_local_state').put({
      key: 'device_state',
      device_id: deviceId,
      last_allocated_sequence: 15,
      last_uploaded_sequence: 0,
      base_snapshot_id: BASE_SNAPSHOT_ID,
      base_cloud_version: BASE_CLOUD_VERSION,
      updated_at: new Date().toISOString()
    });
    for (const e of events) {
      stateTx.objectStore('sync_delta_queue').put({ ...e, status: DELTA_STATUS.PENDING });
    }
    await new Promise(r => stateTx.oncomplete = r);

    const result = await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.equal(result.packagesUploaded, 1);
    assert.equal(result.lastUploadedSequence, 15);
    const pending = await getPendingDeltaEvents();
    assert.equal(pending.length, 0, 'Local queue is properly ACKed after recovery');
  });

  await t.test('T12 — Package uploaded but manifest update failed: retry discovers package and completes manifest update', async () => {
    await initDB();
    const rawIdb = getRawIDB();
    const deviceId = 'dev_manifest_fail';
    await initLocalSyncState(deviceId, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    const events = createSampleEvents(deviceId, 1, 12);
    const payload = buildDeterministicPackagePayload({
      deviceId,
      startSequence: 1,
      endSequence: 12,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });
    const encrypted = await encryptDeltaPackage(payload, TEST_SESSION_KEY);

    await mockDrive.uploadFile({
      name: `${payload.package_id}.pkg`,
      content: JSON.stringify(encrypted),
      appProperties: {
        package_id: payload.package_id,
        device_id: deviceId,
        start_sequence: '1',
        end_sequence: '12',
        package_checksum: encrypted.package_checksum
      }
    });

    const tx = rawIdb.transaction('sync_delta_queue', 'readwrite');
    for (const e of events) {
      tx.objectStore('sync_delta_queue').add(e);
    }
    await new Promise(r => tx.oncomplete = r);

    const result = await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.equal(result.packagesUploaded, 1);
    assert.equal(result.lastUploadedSequence, 12);

    const manifestFiles = await mockDrive.findFiles({ name: `manifest_dev_${deviceId}.json` });
    assert.equal(manifestFiles.length, 1);
    const manifest = await mockDrive.readFile(manifestFiles[0].id);
    assert.equal(manifest.packages.length, 1);
    assert.equal(manifest.last_sequence, 12);
  });

  await t.test('T13 — Own device manifest creation and package list appending', async () => {
    const manifest = createEmptyDeviceManifest('dev_beta', BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);
    assert.equal(manifest.device_id, 'dev_beta');
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.manifest_revision, 0);
    assert.equal(manifest.packages.length, 0);

    await writeOwnDeviceManifest({
      driveClient: mockDrive,
      deviceId: 'dev_beta',
      manifestData: {
        ...manifest,
        manifest_revision: 1,
        last_sequence: 50,
        packages: [{
          package_id: 'pkg_dev_beta_000001_000050',
          drive_file_id: 'drive_file_1',
          package_checksum: 'fake_checksum',
          start_sequence: 1,
          end_sequence: 50,
          event_count: 50
        }]
      }
    });

    const readBack = await readOwnDeviceManifest({ driveClient: mockDrive, deviceId: 'dev_beta' });
    assert.equal(readBack.manifest_revision, 2);
    assert.equal(readBack.packages.length, 1);
    assert.equal(readBack.packages[0].package_id, 'pkg_dev_beta_000001_000050');
  });

  await t.test('T14 — Missing package referenced in peer manifest fails staging closed', async () => {
    await initDB();
    const peerDeviceId = 'dev_peer_ghost';

    const peerManifest = {
      schema_version: 1,
      device_id: peerDeviceId,
      base_snapshot_id: BASE_SNAPSHOT_ID,
      base_cloud_version: BASE_CLOUD_VERSION,
      last_sequence: 20,
      manifest_revision: 1,
      packages: [{
        package_id: 'pkg_dev_peer_ghost_000001_000020',
        drive_file_id: 'ghost_file_id',
        package_checksum: 'ghost_chk',
        start_sequence: 1,
        end_sequence: 20,
        event_count: 20
      }]
    };

    await mockDrive.uploadFile({
      name: `manifest_dev_${peerDeviceId}.json`,
      content: JSON.stringify(peerManifest)
    });

    await assert.rejects(
      async () => await pullPeerDeltas({
        localDeviceId: 'dev_my_phone',
        sessionKey: TEST_SESSION_KEY,
        driveClient: mockDrive
      }),
      /Missing peer package/
    );
  });

  await t.test('T15 — Per-device manifest structure and naming validation', async () => {
    assert.equal(getDeviceManifestFilename('4a9f821b0e33'), 'manifest_dev_4a9f821b0e33.json');
    let threw = false;
    try {
      getDeviceManifestFilename('');
    } catch (e) {
      threw = true;
      assert.match(e.message, /Device ID is required/);
    }
    assert.equal(threw, true);
  });

  await t.test('T16 — Per-device manifest ownership: cross-device context never rewrites another device manifest', async () => {
    await writeOwnDeviceManifest({
      driveClient: mockDrive,
      deviceId: 'dev_owner',
      manifestData: createEmptyDeviceManifest('dev_owner', BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION)
    });

    await assert.rejects(
      async () => await writeOwnDeviceManifest({
        driveClient: mockDrive,
        deviceId: 'dev_owner',
        manifestData: createEmptyDeviceManifest('dev_impostor', BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION)
      }),
      /Manifest device_id mismatch/
    );
  });

  await t.test('T17 — Per-device manifest revision increment and package appending', async () => {
    const manifest = createEmptyDeviceManifest('dev_rev', BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);
    await writeOwnDeviceManifest({ driveClient: mockDrive, deviceId: 'dev_rev', manifestData: manifest });

    const m1 = await readOwnDeviceManifest({ driveClient: mockDrive, deviceId: 'dev_rev' });
    m1.last_sequence = 10;
    m1.packages.push({
      package_id: 'pkg_dev_rev_000001_000010',
      drive_file_id: 'df_1',
      package_checksum: 'chk_1',
      start_sequence: 1,
      end_sequence: 10,
      event_count: 10
    });
    await writeOwnDeviceManifest({ driveClient: mockDrive, deviceId: 'dev_rev', manifestData: m1 });

    const m2 = await readOwnDeviceManifest({ driveClient: mockDrive, deviceId: 'dev_rev' });
    assert.equal(m2.manifest_revision, 2);
    assert.equal(m2.packages.length, 1);
  });

  await t.test('T18 — Peer manifest discovery: lists active peer manifests excluding local device', async () => {
    await writeOwnDeviceManifest({
      driveClient: mockDrive,
      deviceId: 'dev_me',
      manifestData: createEmptyDeviceManifest('dev_me', BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION)
    });
    await writeOwnDeviceManifest({
      driveClient: mockDrive,
      deviceId: 'dev_peer1',
      manifestData: createEmptyDeviceManifest('dev_peer1', BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION)
    });
    await writeOwnDeviceManifest({
      driveClient: mockDrive,
      deviceId: 'dev_peer2',
      manifestData: createEmptyDeviceManifest('dev_peer2', BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION)
    });

    const peers = await listPeerManifests({ driveClient: mockDrive, localDeviceId: 'dev_me' });
    assert.equal(peers.length, 2);
    const peerIds = peers.map(p => p.device_id).sort();
    assert.deepEqual(peerIds, ['dev_peer1', 'dev_peer2']);
  });

  await t.test('T19 — Empty or zero package peer manifest handled gracefully', async () => {
    await initDB();
    await writeOwnDeviceManifest({
      driveClient: mockDrive,
      deviceId: 'dev_empty_peer',
      manifestData: createEmptyDeviceManifest('dev_empty_peer', BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION)
    });

    const result = await pullPeerDeltas({
      localDeviceId: 'dev_local',
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.equal(result.stagedPackagesCount, 0);
    assert.equal(result.stagedEventsCount, 0);
  });

  await t.test('T20 — Replay protection / duplicate package staging idempotency', async () => {
    await initDB();
    const peerDeviceId = 'dev_peer_replay';
    const events = createSampleEvents(peerDeviceId, 1, 10);
    const payload = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 1,
      endSequence: 10,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });
    const encrypted = await encryptDeltaPackage(payload, TEST_SESSION_KEY);

    const stageResult1 = await stagePeerPackageAtomically(encrypted, TEST_SESSION_KEY);
    assert.equal(stageResult1.staged, true);
    assert.equal(stageResult1.eventCount, 10);

    const stageResult2 = await stagePeerPackageAtomically(encrypted, TEST_SESSION_KEY);
    assert.equal(stageResult2.staged, false, 'Duplicate package staging is recognized and skipped');
  });

  // =========================================================================
  // T21 - T30: Concurrency, Atomic Staging, Watermarks & Bundle Isolation
  // =========================================================================

  await t.test('T21 — Package ID / checksum non-circularity: package_id is independent structural prefix', async () => {
    const payload1 = buildDeterministicPackagePayload({
      deviceId: 'dev_nc',
      startSequence: 1,
      endSequence: 10,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events: createSampleEvents('dev_nc', 1, 10)
    });
    assert.equal(payload1.package_id, 'pkg_dev_nc_000001_000010');
    const chk = await computePackageChecksum(payload1);
    assert.ok(chk && chk.length === 64);
  });

  await t.test('T22 — Web Locks concurrency: acquires exclusive lock during manifest write', async () => {
    let lockAcquired = false;
    const origLocks = globalThis.navigator?.locks;
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: {
        request: async (name, options, callback) => {
          lockAcquired = true;
          assert.equal(name, 'finman_sync_lock_dev_lock_test');
          assert.equal(options.mode, 'exclusive');
          return await callback();
        }
      },
      configurable: true,
      writable: true
    });

    try {
      const res = await withSameDeviceLock('dev_lock_test', async () => {
        return 42;
      });

      assert.equal(res, 42);
      assert.equal(lockAcquired, true);
    } finally {
      Object.defineProperty(globalThis.navigator, 'locks', {
        value: origLocks,
        configurable: true,
        writable: true
      });
    }
  });

  await t.test('T23 — Multi-package upload batching advances last_uploaded_sequence monotonically', async () => {
    await initDB();
    const rawIdb = getRawIDB();
    const deviceId = 'dev_multi_pkg';
    await initLocalSyncState(deviceId, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    const events = createSampleEvents(deviceId, 1, 250);
    const tx = rawIdb.transaction('sync_delta_queue', 'readwrite');
    for (const e of events) {
      tx.objectStore('sync_delta_queue').add(e);
    }
    await new Promise(r => tx.oncomplete = r);

    const result = await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.equal(result.packagesUploaded, 3);
    assert.equal(result.eventsUploaded, 250);
    assert.equal(result.lastUploadedSequence, 250);

    const localState = await getLocalSyncState();
    assert.equal(localState.last_pushed_sequence, 250);
  });

  await t.test('T24 — Local queue status transition: PENDING -> ACKNOWLEDGED on upload', async () => {
    const db = await initDB();
    const rawIdb = getRawIDB();
    const deviceId = 'dev_ack_test';
    await initLocalSyncState(deviceId, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    const events = createSampleEvents(deviceId, 1, 5);
    const tx = rawIdb.transaction('sync_delta_queue', 'readwrite');
    for (const e of events) {
      tx.objectStore('sync_delta_queue').add(e);
    }
    await new Promise(r => tx.oncomplete = r);

    await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    const queueItems = (await db.query('SELECT * FROM sync_delta_queue')).values;
    assert.equal(queueItems.length, 5);
    for (const item of queueItems) {
      assert.equal(item.status, DELTA_STATUS.ACKNOWLEDGED);
      assert.ok(item.acknowledged_at, 'acknowledged_at timestamp is populated');
    }
  });

  await t.test('T25 — Peer package staging atomic transaction across packages, events, and peer state', async () => {
    const db = await initDB();
    const peerDeviceId = 'dev_peer_atom';
    const events = createSampleEvents(peerDeviceId, 1, 8);
    const payload = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 1,
      endSequence: 8,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });
    const encrypted = await encryptDeltaPackage(payload, TEST_SESSION_KEY);

    const res = await stagePeerPackageAtomically(encrypted, TEST_SESSION_KEY);
    assert.equal(res.staged, true);
    assert.equal(res.eventCount, 8);

    const stagedPkgs = (await db.query('SELECT * FROM sync_staged_packages')).values;
    assert.equal(stagedPkgs.length, 1);
    assert.equal(stagedPkgs[0].package_id, payload.package_id);

    const stagedEvents = (await db.query('SELECT * FROM sync_staged_events')).values;
    assert.equal(stagedEvents.length, 8);

    const peerState = (await db.query('SELECT * FROM sync_peer_state')).values;
    assert.equal(peerState.length, 1);
    assert.equal(peerState[0].peer_device_id, peerDeviceId);
    assert.equal(peerState[0].last_staged_sequence, 8);
    assert.equal(peerState[0].last_reconciled_sequence, 0);
  });

  await t.test('T26 — Peer staging transaction rollback on failure: no partial inserts', async () => {
    const db = await initDB();
    const peerDeviceId = 'dev_peer_rollback';
    const events = createSampleEvents(peerDeviceId, 1, 5);
    const payload = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 1,
      endSequence: 5,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });
    const encrypted = await encryptDeltaPackage(payload, TEST_SESSION_KEY);

    await assert.rejects(
      async () => await stagePeerPackageAtomically({
        ...encrypted,
        ciphertext: 'bad_ciphertext'
      }, TEST_SESSION_KEY),
      /Failed to decrypt transport package/
    );

    const pkgs = (await db.query('SELECT * FROM sync_staged_packages')).values;
    assert.equal(pkgs.length, 0);
    const evts = (await db.query('SELECT * FROM sync_staged_events')).values;
    assert.equal(evts.length, 0);
    const states = (await db.query('SELECT * FROM sync_peer_state')).values;
    assert.equal(states.length, 0);
  });

  await t.test('T27 — Sequence continuity validation: peer packages must be staged in sequence order', async () => {
    const db = await initDB();
    const peerDeviceId = 'dev_peer_cont';

    // Package 1: seq 1-10
    const p1 = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 1,
      endSequence: 10,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events: createSampleEvents(peerDeviceId, 1, 10)
    });
    const enc1 = await encryptDeltaPackage(p1, TEST_SESSION_KEY);
    await stagePeerPackageAtomically(enc1, TEST_SESSION_KEY);

    // Package 2: seq 11-20
    const p2 = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 11,
      endSequence: 20,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events: createSampleEvents(peerDeviceId, 11, 10)
    });
    const enc2 = await encryptDeltaPackage(p2, TEST_SESSION_KEY);
    const res2 = await stagePeerPackageAtomically(enc2, TEST_SESSION_KEY);

    assert.equal(res2.staged, true);
    const peerState = (await db.query(`SELECT * FROM sync_peer_state WHERE peer_device_id = '${peerDeviceId}'`)).values[0];
    assert.equal(peerState.last_staged_sequence, 20);
  });

  await t.test('T28 — Sequence gap detection: out-of-order package is rejected', async () => {
    await initDB();
    const peerDeviceId = 'dev_peer_gap';

    const p2 = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 11,
      endSequence: 20,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events: createSampleEvents(peerDeviceId, 11, 10)
    });
    const enc2 = await encryptDeltaPackage(p2, TEST_SESSION_KEY);

    await assert.rejects(
      async () => await stagePeerPackageAtomically(enc2, TEST_SESSION_KEY),
      /Sequence gap detected/
    );
  });

  await t.test('T29 — Cross-device manifest segregation: peer pull reads without altering peer manifests', async () => {
    await initDB();
    const peerDeviceId = 'dev_peer_seg';
    const events = createSampleEvents(peerDeviceId, 1, 5);
    const payload = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 1,
      endSequence: 5,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });
    const encrypted = await encryptDeltaPackage(payload, TEST_SESSION_KEY);

    const uploadRes = await mockDrive.uploadFile({
      name: `${payload.package_id}.pkg`,
      content: JSON.stringify(encrypted),
      appProperties: {
        package_id: payload.package_id,
        device_id: peerDeviceId,
        start_sequence: '1',
        end_sequence: '5',
        package_checksum: encrypted.package_checksum
      }
    });

    const peerManifest = {
      schema_version: 1,
      device_id: peerDeviceId,
      base_snapshot_id: BASE_SNAPSHOT_ID,
      base_cloud_version: BASE_CLOUD_VERSION,
      last_sequence: 5,
      manifest_revision: 1,
      packages: [{
        package_id: payload.package_id,
        drive_file_id: uploadRes.id,
        package_checksum: encrypted.package_checksum,
        start_sequence: 1,
        end_sequence: 5,
        event_count: 5
      }]
    };

    await mockDrive.uploadFile({
      name: `manifest_dev_${peerDeviceId}.json`,
      content: JSON.stringify(peerManifest)
    });

    const pullResult = await pullPeerDeltas({
      localDeviceId: 'dev_local_reader',
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.equal(pullResult.stagedPackagesCount, 1);
    assert.equal(pullResult.stagedEventsCount, 5);

    const peerManifestRead = await readOwnDeviceManifest({ driveClient: mockDrive, deviceId: peerDeviceId });
    assert.equal(peerManifestRead.manifest_revision, 1);
    assert.equal(peerManifestRead.device_id, peerDeviceId);
  });

  await t.test('T30 — Safe ignore of unrelated Drive files / peer orphan files without manifest pointer', async () => {
    await initDB();
    await mockDrive.uploadFile({
      name: 'random_backup_file.json',
      content: '{"some":"data"}'
    });

    const result = await pullPeerDeltas({
      localDeviceId: 'dev_local_clean',
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.equal(result.stagedPackagesCount, 0);
    assert.equal(result.stagedEventsCount, 0);
  });

  // =========================================================================
  // T31 - T40: Mandatory Guardrails, Fallback Locks & Financial Preservation
  // =========================================================================

  await t.test('T31 — Duplicate Drive files with identical package_id + checksum treated as one logical package', async () => {
    await initDB();
    const peerDeviceId = 'dev_peer_t31';
    const events = createSampleEvents(peerDeviceId, 1, 10);
    const payload = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 1,
      endSequence: 10,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });
    const encrypted = await encryptDeltaPackage(payload, TEST_SESSION_KEY);

    const f1 = await mockDrive.uploadFile({
      name: `${payload.package_id}.pkg`,
      content: JSON.stringify(encrypted)
    });
    mockDrive.duplicateFile(f1.id);

    const peerManifest = {
      schema_version: 1,
      device_id: peerDeviceId,
      base_snapshot_id: BASE_SNAPSHOT_ID,
      base_cloud_version: BASE_CLOUD_VERSION,
      last_sequence: 10,
      manifest_revision: 1,
      packages: [{
        package_id: payload.package_id,
        drive_file_id: f1.id,
        package_checksum: encrypted.package_checksum,
        start_sequence: 1,
        end_sequence: 10,
        event_count: 10
      }]
    };
    await mockDrive.uploadFile({
      name: `manifest_dev_${peerDeviceId}.json`,
      content: JSON.stringify(peerManifest)
    });

    const pullRes = await pullPeerDeltas({
      localDeviceId: 'dev_local_t31',
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.equal(pullRes.stagedPackagesCount, 1);
    assert.equal(pullRes.stagedEventsCount, 10);
  });

  await t.test('T32 — Same package_id with different checksum fails closed', async () => {
    const db = await initDB();
    const peerDeviceId = 'dev_peer_t32';
    const events = createSampleEvents(peerDeviceId, 1, 10);
    const payload = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 1,
      endSequence: 10,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });
    const encrypted = await encryptDeltaPackage(payload, TEST_SESSION_KEY);

    const f1 = await mockDrive.uploadFile({
      name: `${payload.package_id}.pkg`,
      content: JSON.stringify(encrypted)
    });

    const peerManifest = {
      schema_version: 1,
      device_id: peerDeviceId,
      base_snapshot_id: BASE_SNAPSHOT_ID,
      base_cloud_version: BASE_CLOUD_VERSION,
      last_sequence: 10,
      manifest_revision: 1,
      packages: [{
        package_id: payload.package_id,
        drive_file_id: f1.id,
        package_checksum: 'conflicting_checksum_hash_value',
        start_sequence: 1,
        end_sequence: 10,
        event_count: 10
      }]
    };
    await mockDrive.uploadFile({
      name: `manifest_dev_${peerDeviceId}.json`,
      content: JSON.stringify(peerManifest)
    });

    await assert.rejects(
      async () => await pullPeerDeltas({
        localDeviceId: 'dev_local_t32',
        sessionKey: TEST_SESSION_KEY,
        driveClient: mockDrive
      }),
      /STORAGE_MISMATCH|Package checksum mismatch/
    );

    const stagedPkgs = (await db.query('SELECT * FROM sync_staged_packages')).values;
    assert.equal(stagedPkgs.length, 0, 'No packages staged');
  });

  await t.test('T33 — Lost upload response followed by retry does not create another logical package', async () => {
    await initDB();
    const rawIdb = getRawIDB();
    const deviceId = 'dev_t33';
    await initLocalSyncState(deviceId, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    const events = createSampleEvents(deviceId, 1, 15);
    const tx = rawIdb.transaction('sync_delta_queue', 'readwrite');
    for (const e of events) {
      tx.objectStore('sync_delta_queue').add(e);
    }
    await new Promise(r => tx.oncomplete = r);

    // Initial upload
    await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    // Retry upload
    await uploadPendingDeltas({
      deviceId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    const manifestFiles = await mockDrive.findFiles({ name: `manifest_dev_${deviceId}.json` });
    assert.equal(manifestFiles.length, 1);
    const manifest = await mockDrive.readFile(manifestFiles[0].id);
    assert.equal(manifest.packages.length, 1, 'Only one package entry in manifest');
  });

  await t.test('T34 — Ownership loss in fallback lock prevents local acknowledgment/watermark advancement', async () => {
    await initDB();
    const deviceId = 'dev_fallback_loss';
    await initLocalSyncState(deviceId, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    const origLocks = globalThis.navigator?.locks;
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: undefined,
      configurable: true,
      writable: true
    });

    try {
      await withSameDeviceLock(deviceId, async () => {
        const rawIdb = getRawIDB();
        const tx = rawIdb.transaction('sync_process_locks', 'readwrite');
        tx.objectStore('sync_process_locks').put({
          lock_name: `finman_sync_lock_${deviceId}`,
          owner_token: 'stealer_process_xyz',
          expires_at: new Date(Date.now() + 60000).toISOString(),
          updated_at: new Date().toISOString()
        });
        await new Promise(r => tx.oncomplete = r);
      });
      assert.fail('Should have thrown on lock ownership loss');
    } catch (err) {
      assert.match(err.message, /Lost lock ownership|Fencing token mismatch/);
    } finally {
      Object.defineProperty(globalThis.navigator, 'locks', {
        value: origLocks,
        configurable: true,
        writable: true
      });
    }
  });

  await t.test('T35 — Web Lock serializes two same-device manifest writers', async () => {
    const executionOrder = [];

    const queue = [];
    let isRunning = false;

    async function processQueue() {
      if (isRunning || queue.length === 0) return;
      isRunning = true;
      const { callback, resolve, reject } = queue.shift();
      try {
        const res = await callback();
        resolve(res);
      } catch (e) {
        reject(e);
      } finally {
        isRunning = false;
        processQueue();
      }
    }

    const origLocks = globalThis.navigator?.locks;
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: {
        request: (name, options, callback) => {
          return new Promise((resolve, reject) => {
            queue.push({ callback, resolve, reject });
            processQueue();
          });
        }
      },
      configurable: true,
      writable: true
    });

    try {
      const task1 = withSameDeviceLock('dev_ser', async () => {
        executionOrder.push('start_task1');
        await new Promise(r => setTimeout(r, 20));
        executionOrder.push('end_task1');
        return 'task1_done';
      });

      const task2 = withSameDeviceLock('dev_ser', async () => {
        executionOrder.push('start_task2');
        executionOrder.push('end_task2');
        return 'task2_done';
      });

      const [r1, r2] = await Promise.all([task1, task2]);
      assert.equal(r1, 'task1_done');
      assert.equal(r2, 'task2_done');
      assert.deepEqual(executionOrder, ['start_task1', 'end_task1', 'start_task2', 'end_task2']);
    } finally {
      Object.defineProperty(globalThis.navigator, 'locks', {
        value: origLocks,
        configurable: true,
        writable: true
      });
    }
  });

  await t.test('T36 — Deterministic reconstruction produces identical package_checksum after simulated crash', async () => {
    const deviceId = 'dev_crash_recon';
    const events = createSampleEvents(deviceId, 1, 10);

    const payload1 = buildDeterministicPackagePayload({
      deviceId,
      startSequence: 1,
      endSequence: 10,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });
    const checksum1 = await computePackageChecksum(payload1);

    await new Promise(r => setTimeout(r, 10));

    const payload2 = buildDeterministicPackagePayload({
      deviceId,
      startSequence: 1,
      endSequence: 10,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });
    const checksum2 = await computePackageChecksum(payload2);

    assert.equal(checksum1, checksum2, 'Checksums match identically despite timestamp difference outside payload');
  });

  await t.test('T37 — Runtime transport timestamps do not alter package_checksum', async () => {
    const deviceId = 'dev_ts_invar';
    const events = createSampleEvents(deviceId, 1, 5);
    const payload = buildDeterministicPackagePayload({
      deviceId,
      startSequence: 1,
      endSequence: 5,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });

    const enc1 = await encryptDeltaPackage(payload, TEST_SESSION_KEY);
    await new Promise(r => setTimeout(r, 20));
    const enc2 = await encryptDeltaPackage(payload, TEST_SESSION_KEY);

    assert.notEqual(enc1.transport_created_at, enc2.transport_created_at, 'Transport timestamps differ');
    assert.equal(enc1.package_checksum, enc2.package_checksum, 'Package checksum remains strictly identical');
  });

  await t.test('T38 — Staged package + events + peer watermark rollback together on IDB error', async () => {
    const db = await initDB();
    const peerDeviceId = 'dev_peer_t38';
    const events = createSampleEvents(peerDeviceId, 1, 5);
    const payload = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 1,
      endSequence: 5,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events
    });
    const encrypted = await encryptDeltaPackage(payload, TEST_SESSION_KEY);

    // Stage valid package first
    await stagePeerPackageAtomically(encrypted, TEST_SESSION_KEY);

    const initialPkgs = (await db.query('SELECT * FROM sync_staged_packages')).values;
    const initialEvts = (await db.query('SELECT * FROM sync_staged_events')).values;
    const initialPeer = (await db.query('SELECT * FROM sync_peer_state')).values;

    assert.equal(initialPkgs.length, 1);
    assert.equal(initialEvts.length, 5);
    assert.equal(initialPeer[0].last_staged_sequence, 5);

    // Attempting invalid staging that throws
    try {
      await stagePeerPackageAtomically({
        ...encrypted,
        ciphertext: 'bad_ciphertext'
      }, TEST_SESSION_KEY);
    } catch {
      // Expected
    }

    // Verify state has not drifted or partially updated
    const afterPkgs = (await db.query('SELECT * FROM sync_staged_packages')).values;
    const afterEvts = (await db.query('SELECT * FROM sync_staged_events')).values;
    const afterPeer = (await db.query('SELECT * FROM sync_peer_state')).values;

    assert.equal(afterPkgs.length, 1);
    assert.equal(afterEvts.length, 5);
    assert.equal(afterPeer[0].last_staged_sequence, 5);
  });

  await t.test('T39 — Sequence gap prevents staging beyond the contiguous boundary', async () => {
    const db = await initDB();
    const peerDeviceId = 'dev_peer_t39';

    // Package 1: seq 1-5
    const p1 = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 1,
      endSequence: 5,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events: createSampleEvents(peerDeviceId, 1, 5)
    });
    const enc1 = await encryptDeltaPackage(p1, TEST_SESSION_KEY);
    await stagePeerPackageAtomically(enc1, TEST_SESSION_KEY);

    // Package 3: seq 11-15 (skipping Package 2 seq 6-10)
    const p3 = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 11,
      endSequence: 15,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events: createSampleEvents(peerDeviceId, 11, 5)
    });
    const enc3 = await encryptDeltaPackage(p3, TEST_SESSION_KEY);

    await assert.rejects(
      async () => await stagePeerPackageAtomically(enc3, TEST_SESSION_KEY),
      /Sequence gap detected: expected start_sequence 6, received 11/
    );

    const peerState = (await db.query(`SELECT * FROM sync_peer_state WHERE peer_device_id = '${peerDeviceId}'`)).values[0];
    assert.equal(peerState.last_staged_sequence, 5, 'Watermark remains at 5');
  });

  await t.test('T40 — Phase 7.3 does not modify financial transaction/investment records', async () => {
    const db = await initDB();
    const rawIdb = getRawIDB();

    // Pre-populate canonical financial stores
    const accTx = rawIdb.transaction('accounts', 'readwrite');
    accTx.objectStore('accounts').add({ id: 'acc_1', name: 'Main Checking', balance: 5000 });
    await new Promise(r => accTx.oncomplete = r);

    const txTx = rawIdb.transaction('transactions', 'readwrite');
    txTx.objectStore('transactions').add({ id: 'tx_baseline_1', account_id: 'acc_1', amount: 150, description: 'Groceries' });
    await new Promise(r => txTx.oncomplete = r);

    // Run full upload & staging workflow
    const localDev = 'dev_t40_local';
    const peerDev = 'dev_t40_peer';
    await initLocalSyncState(localDev, BASE_SNAPSHOT_ID, BASE_CLOUD_VERSION);

    // 1. Upload local queue
    const localEvents = createSampleEvents(localDev, 1, 10);
    const queueTx = rawIdb.transaction('sync_delta_queue', 'readwrite');
    for (const e of localEvents) {
      queueTx.objectStore('sync_delta_queue').add(e);
    }
    await new Promise(r => queueTx.oncomplete = r);

    await uploadPendingDeltas({
      deviceId: localDev,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    // 2. Stage peer packages
    const peerEvents = createSampleEvents(peerDev, 1, 10);
    const peerPayload = buildDeterministicPackagePayload({
      deviceId: peerDev,
      startSequence: 1,
      endSequence: 10,
      baseSnapshotId: BASE_SNAPSHOT_ID,
      events: peerEvents
    });
    const peerEncrypted = await encryptDeltaPackage(peerPayload, TEST_SESSION_KEY);

    const peerFile = await mockDrive.uploadFile({
      name: `${peerPayload.package_id}.pkg`,
      content: JSON.stringify(peerEncrypted)
    });

    await mockDrive.uploadFile({
      name: `manifest_dev_${peerDev}.json`,
      content: JSON.stringify({
        schema_version: 1,
        device_id: peerDev,
        base_snapshot_id: BASE_SNAPSHOT_ID,
        base_cloud_version: BASE_CLOUD_VERSION,
        last_sequence: 10,
        manifest_revision: 1,
        packages: [{
          package_id: peerPayload.package_id,
          drive_file_id: peerFile.id,
          package_checksum: peerEncrypted.package_checksum,
          start_sequence: 1,
          end_sequence: 10,
          event_count: 10
        }]
      })
    });

    await pullPeerDeltas({
      localDeviceId: localDev,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    // Verify Financial Records remain 100% UNTOUCHED
    const accounts = (await db.query('SELECT * FROM accounts')).values;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, 'acc_1');
    assert.equal(accounts[0].balance, 5000);

    const transactions = (await db.query('SELECT * FROM transactions')).values;
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].id, 'tx_baseline_1');
    assert.equal(transactions[0].amount, 150);

    // Ensure staging tables received peer data without leaking into financial tables
    const stagedEvents = (await db.query('SELECT * FROM sync_staged_events')).values;
    assert.equal(stagedEvents.length, 10);
  });

  await t.test('T41: bytesToBase64 and base64ToBytes round-trip correctly with zero bytes and large buffers', async () => {
    // 1. Zero bytes and special characters
    const testCases = [
      new Uint8Array([0, 0, 0, 0]),
      new Uint8Array([0, 255, 128, 64, 32, 16, 8, 4, 2, 1]),
      new Uint8Array(new TextEncoder().encode('Hello World! 🚀 Special characters: \0 \n \r \t € 日本語')),
      new Uint8Array(65536).fill(42) // 64 KB large buffer
    ];

    for (const original of testCases) {
      const b64 = bytesToBase64(original);
      assert.equal(typeof b64, 'string');
      const recovered = base64ToBytes(b64);
      assert.deepEqual(recovered, original);
    }
  });

  await t.test('T42: encryptDeltaPackage and decryptDeltaPackage succeed without global Buffer', async () => {
    // Save original Buffer reference and delete from global
    const originalBuffer = globalThis.Buffer;
    delete globalThis.Buffer;

    try {
      const payload = buildDeterministicPackagePayload({
        deviceId: 'dev_no_buffer_test',
        startSequence: 1,
        endSequence: 1,
        baseSnapshotId: BASE_SNAPSHOT_ID,
        baseCloudVersion: BASE_CLOUD_VERSION,
        events: [{
          event_id: 'evt_no_buf_1',
          device_id: 'dev_no_buffer_test',
          sequence: 1,
          timestamp: new Date().toISOString(),
          collection: 'transactions',
          entity_id: 'txn_no_buf_1',
          operation: 'INSERT',
          base_checksum: null,
          new_checksum: 'test_hash',
          payload: { id: 'txn_no_buf_1', inr: 500, note: 'Tested without Buffer' }
        }]
      });

      // 1. Encrypt without Buffer
      const encryptedContainer = await encryptDeltaPackage(payload, TEST_SESSION_KEY);
      assert.equal(encryptedContainer.schema_version, 1);
      assert.equal(encryptedContainer.package_id, 'pkg_dev_no_buffer_test_000001_000001');
      assert.ok(encryptedContainer.ciphertext);
      assert.ok(encryptedContainer.salt);
      assert.ok(encryptedContainer.iv);
      assert.ok(encryptedContainer.auth_tag);

      // 2. Decrypt without Buffer
      const decrypted = await decryptDeltaPackage(encryptedContainer, TEST_SESSION_KEY);
      assert.deepEqual(decrypted, payload);
    } finally {
      // Restore Buffer for subsequent test suite execution
      globalThis.Buffer = originalBuffer;
    }
  });

  await t.test('T43: Encrypt -> Decrypt preserves binary zero bytes in payloads without Buffer', async () => {
    const originalBuffer = globalThis.Buffer;
    delete globalThis.Buffer;

    try {
      const payload = buildDeterministicPackagePayload({
        deviceId: 'dev_zero_bytes',
        startSequence: 1,
        endSequence: 2,
        baseSnapshotId: BASE_SNAPSHOT_ID,
        baseCloudVersion: BASE_CLOUD_VERSION,
        events: [
          {
            event_id: 'evt_zb_1',
            device_id: 'dev_zero_bytes',
            sequence: 1,
            timestamp: new Date().toISOString(),
            collection: 'transactions',
            entity_id: 'tx_zb_1',
            operation: 'INSERT',
            payload: { id: 'tx_zb_1', note: 'Text with zero \u0000 and unicode \u00FF' }
          },
          {
            event_id: 'evt_zb_2',
            device_id: 'dev_zero_bytes',
            sequence: 2,
            timestamp: new Date().toISOString(),
            collection: 'transactions',
            entity_id: 'tx_zb_2',
            operation: 'UPDATE',
            payload: { id: 'tx_zb_2', amount: 0 }
          }
        ]
      });

      const encrypted = await encryptDeltaPackage(payload, TEST_SESSION_KEY);
      const decrypted = await decryptDeltaPackage(encrypted, TEST_SESSION_KEY);
      assert.deepEqual(decrypted, payload);
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });

  await t.test('T44: Package format validation — container properties strictly conform to Transport Schema v1', async () => {
    const payload = buildDeterministicPackagePayload({
      deviceId: 'dev_schema_v1',
      startSequence: 1,
      endSequence: 1,
      events: [{
        event_id: 'evt_s1',
        device_id: 'dev_schema_v1',
        sequence: 1,
        timestamp: new Date().toISOString(),
        collection: 'transactions',
        entity_id: 'tx_s1',
        operation: 'INSERT',
        payload: { id: 'tx_s1' }
      }]
    });

    const encrypted = await encryptDeltaPackage(payload, TEST_SESSION_KEY);
    assert.equal(typeof encrypted.salt, 'string');
    assert.equal(typeof encrypted.iv, 'string');
    assert.equal(typeof encrypted.ciphertext, 'string');
    assert.equal(typeof encrypted.auth_tag, 'string');
    assert.equal(encrypted.schema_version, 1);
  });
});
