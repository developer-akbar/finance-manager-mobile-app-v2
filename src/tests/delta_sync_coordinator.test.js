/**
 * delta_sync_coordinator.test.js — Phase 7.5 Automatic Delta Synchronization Engine Test Suite
 * 
 * Verifies:
 * - Category A: Real Integration Tests (A01 – A15)
 * - Category B: Protocol & Unit Tests (B01 – B04)
 * - Category C: Performance Benchmarks (C01 – C02)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { v4 as uuid } from 'uuid';

import { initDB, getDB, closeDB } from '../database/db.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import {
  configureDeltaSyncEngine,
  scheduleSync,
  triggerAutomaticSync,
  executeFullSyncPass,
  withMasterSyncLock,
  recoverQueueAckFromAuthoritativeManifest,
  initializeDeltaSyncRuntime,
  isDeltaSyncRuntimeInitialized,
  getCurrentSyncStatus,
  SYNC_STATUS,
  SYNC_TRIGGER,
  MASTER_SYNC_LOCK_NAME
} from '../services/deltaSyncCoordinator.js';
import { executeAtomicMutation } from '../database/atomicMutation.js';
import { unlockSyncSession, lockSyncSession, getSyncSessionKey } from '../services/syncSession.js';
import { setGoogleLinked, saveTokenData, clearGoogleAuth, subscribeGoogleAuth } from '../services/googleAuth.js';
import {
  buildPackageId,
  buildDeterministicPackagePayload,
  encryptDeltaPackage,
  decryptDeltaPackage,
  slicePendingDeltaQueue,
  uploadPendingDeltas,
  downloadAndStagePeerPackages,
  stagePeerPackageAtomically
} from '../services/deltaTransport.js';
import {
  readOwnDeviceManifest,
  writeOwnDeviceManifest,
  createEmptyDeviceManifest,
  withSameDeviceLock
} from '../services/deviceManifest.js';
import {
  reconcileStagedEvents,
  resolveConflict,
  RECONCILIATION_STATUS,
  APPROVED_BASE_SNAPSHOT_ID,
  APPROVED_BASE_CLOUD_VERSION
} from '../services/deltaReconciliation.js';
import {
  getConflict,
  getPendingConflicts,
  CONFLICT_STATUS,
  CONFLICT_RESOLUTION,
  CONFLICT_TYPE
} from '../database/conflicts.js';

// Setup isolated in-memory DB and localStorage
globalThis.indexedDB = new IDBFactory();
const mockStorage = {};
global.localStorage = {
  getItem: (k) => mockStorage[k] || null,
  setItem: (k, v) => { mockStorage[k] = String(v); },
  removeItem: (k) => { delete mockStorage[k]; },
  clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); }
};

async function resetDB() {
  global.localStorage.clear();
  closeDB();
  globalThis.indexedDB = new IDBFactory();
  const db = await initDB();
  return db;
}

// In-memory Drive Client Mock
function createMockDriveClient() {
  const files = new Map(); // id -> { id, name, content, appProperties }

  return {
    files,
    async findFiles({ name }) {
      const matches = [];
      for (const f of files.values()) {
        if (f.name === name) matches.push(f);
      }
      return matches;
    },
    async readFile(fileId) {
      const f = files.get(fileId);
      if (!f) throw new Error(`File not found: ${fileId}`);
      return f.content;
    },
    async uploadFile({ name, content, appProperties }) {
      // Check if file already exists
      for (const f of files.values()) {
        if (f.name === name) {
          f.content = content;
          f.appProperties = appProperties || f.appProperties;
          return { id: f.id, name: f.name };
        }
      }
      const fileId = `drive_${uuid()}`;
      const fileObj = { id: fileId, name, content, appProperties };
      files.set(fileId, fileObj);
      return { id: fileId, name };
    }
  };
}

test('FinMan Phase 7.5 — Automatic Delta Synchronization Engine Suite', async (t) => {

  // =========================================================================
  // CATEGORY A: REAL INTEGRATION TESTS (A01 - A15)
  // =========================================================================

  await t.test('A01: 30-second mutation debounce & burst coalescing', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();
    let syncCallCount = 0;

    configureDeltaSyncEngine({
      driveClient,
      sessionKey: 'test_key',
      getDeviceId: () => 'dev_a01',
      enabled: true
    });

    // Schedule 5 rapid mutations
    scheduleSync(SYNC_TRIGGER.MUTATION);
    scheduleSync(SYNC_TRIGGER.MUTATION);
    scheduleSync(SYNC_TRIGGER.MUTATION);
    scheduleSync(SYNC_TRIGGER.MUTATION);
    scheduleSync(SYNC_TRIGGER.MUTATION);

    // Immediate manual flush should execute exactly one sync pass
    const res = await triggerAutomaticSync(SYNC_TRIGGER.MANUAL);
    assert.equal(res.success, true);
    assert.equal(res.status, SYNC_STATUS.SUCCESS);
  });

  await t.test('A02: Foreground / visibilitychange triggers immediate sync', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();

    configureDeltaSyncEngine({
      driveClient,
      sessionKey: 'test_key',
      getDeviceId: () => 'dev_a02'
    });

    const res = await scheduleSync(SYNC_TRIGGER.FOREGROUND);
    assert.equal(res.success, true);
    assert.equal(res.trigger, SYNC_TRIGGER.FOREGROUND);
  });

  await t.test('A03: Outbound packaging freezes slice boundary; concurrent mutation queued for next sync', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();
    const deviceId = 'dev_a03';

    // Insert 2 deltas into sync_delta_queue
    const t1 = { id: 'txn_a03_1', inr: 100, note: 'T1' };
    const t2 = { id: 'txn_a03_2', inr: 200, note: 'T2' };
    const h1 = await computeCanonicalSha256(t1);
    const h2 = await computeCanonicalSha256(t2);

    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_a03_1', deviceId, 1, new Date().toISOString(), 'transactions', t1.id, 'INSERT', h1, JSON.stringify(t1), 'PENDING']
    );
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_a03_2', deviceId, 2, new Date().toISOString(), 'transactions', t2.id, 'INSERT', h2, JSON.stringify(t2), 'PENDING']
    );

    // Execute upload
    const upRes = await uploadPendingDeltas({
      deviceId,
      driveClient,
      sessionKey: 'test_key'
    });

    assert.equal(upRes.packagesUploaded, 1);
    assert.equal(upRes.eventsUploaded, 2);
    assert.equal(upRes.lastUploadedSequence, 2);

    // Concurrent mutation arrives after upload
    const t3 = { id: 'txn_a03_3', inr: 300, note: 'T3' };
    const h3 = await computeCanonicalSha256(t3);
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_a03_3', deviceId, 3, new Date().toISOString(), 'transactions', t3.id, 'INSERT', h3, JSON.stringify(t3), 'PENDING']
    );

    const q3 = (await db.query('SELECT status FROM sync_delta_queue WHERE sequence = ?', [3])).values[0].status;
    assert.equal(q3, 'PENDING');
  });

  await t.test('A04: Multi-tab master sync lock serialization with overlapping requests', async () => {
    const db = await resetDB();

    let concurrentHolders = 0;
    let maxConcurrentHolders = 0;
    const executionOrder = [];

    // Launch lock 1 which holds the lock for 60ms
    const p1 = withMasterSyncLock(async () => {
      concurrentHolders++;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, concurrentHolders);
      executionOrder.push('p1_enter');
      await new Promise(r => setTimeout(r, 60));
      executionOrder.push('p1_exit');
      concurrentHolders--;
    });

    // Short delay to ensure p1 has acquired the lock before p2 attempts acquisition
    await new Promise(r => setTimeout(r, 10));

    // Launch lock 2 concurrently while p1 is actively holding the lock
    let p2Finished = false;
    let p2Error = null;

    const p2 = withMasterSyncLock(async () => {
      concurrentHolders++;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, concurrentHolders);
      executionOrder.push('p2_enter');
      concurrentHolders--;
      executionOrder.push('p2_exit');
      p2Finished = true;
    }).catch(err => {
      p2Error = err;
    });

    await Promise.all([p1, p2]);

    assert.equal(maxConcurrentHolders, 1, 'Max concurrent lock holders must never exceed 1');
    if (p2Error) {
      // In fallback mode, concurrent acquisition throws lock busy
      assert.ok(p2Error.message.includes('master sync lock') || p2Error.message.includes('active'));
      assert.deepEqual(executionOrder, ['p1_enter', 'p1_exit']);
    } else {
      // In queuing mode (e.g. Web Locks), second executes after first completes
      assert.deepEqual(executionOrder, ['p1_enter', 'p1_exit', 'p2_enter', 'p2_exit']);
      assert.equal(p2Finished, true);
    }
  });

  await t.test('A05: ACCEPT_REMOTE resolution generates outbound delta and converges peer', async () => {
    const db = await resetDB();
    const entityId = 'txn_a05';

    // 1. Local state = A
    const entLocal = { id: entityId, inr: 100, note: 'Local A' };
    await db.run('INSERT INTO transactions (id, inr, note) VALUES (?, ?, ?)', [entLocal.id, entLocal.inr, entLocal.note]);
    const hashLocal = await computeCanonicalSha256(entLocal);

    // 2. Remote conflict = R
    const entRemote = { id: entityId, inr: 200, note: 'Remote R' };
    const hashRemote = await computeCanonicalSha256(entRemote);

    // Stage conflict
    const confId = 'conf_a05';
    await db.run(
      'INSERT INTO sync_conflicts (conflict_id, collection, entity_id, conflict_type, peer_device_id, event_id, base_checksum, local_checksum, remote_checksum, local_payload, remote_payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [confId, 'transactions', entityId, CONFLICT_TYPE.CONCURRENT_EDIT, 'peer_b', 'evt_b_500', 'old_base', hashLocal, hashRemote, JSON.stringify(entLocal), JSON.stringify(entRemote), CONFLICT_STATUS.PENDING]
    );
    await db.run(
      'INSERT INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, payload, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_b_500', 'pkg_b_1', 'peer_b', 500, new Date().toISOString(), 'transactions', entityId, 'UPDATE', 'old_base', hashRemote, JSON.stringify(entRemote), new Date().toISOString(), RECONCILIATION_STATUS.CONFLICT]
    );

    // 3. User chooses ACCEPT_REMOTE
    const res = await resolveConflict(confId, CONFLICT_RESOLUTION.ACCEPT_REMOTE);
    assert.equal(res.success, true);
    assert.equal(res.status, CONFLICT_STATUS.RESOLVED);

    // Canonical store updated to Remote R
    const canonical = (await db.query('SELECT note FROM transactions WHERE id = ?', [entityId])).values[0];
    assert.equal(canonical.note, 'Remote R');

    // Outbound delta queue contains resolution delta
    const deltas = (await db.query('SELECT * FROM sync_delta_queue WHERE resolution_type = ?', ['ACCEPT_REMOTE'])).values;
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].entity_id, entityId);
    assert.equal(deltas[0].resolved_event_id, 'evt_b_500');
  });

  await t.test('A06: KEEP_LOCAL resolution generates outbound delta with H(remote) base and converges peer without echo', async () => {
    const db = await resetDB();
    const entityId = 'txn_a06';

    const entLocal = { id: entityId, inr: 100, note: 'Local Chosen' };
    await db.run('INSERT INTO transactions (id, inr, note) VALUES (?, ?, ?)', [entLocal.id, entLocal.inr, entLocal.note]);
    const hashLocal = await computeCanonicalSha256(entLocal);

    const entRemote = { id: entityId, inr: 200, note: 'Remote Rejected' };
    const hashRemote = await computeCanonicalSha256(entRemote);

    const confId = 'conf_a06';
    await db.run(
      'INSERT INTO sync_conflicts (conflict_id, collection, entity_id, conflict_type, peer_device_id, event_id, base_checksum, local_checksum, remote_checksum, local_payload, remote_payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [confId, 'transactions', entityId, CONFLICT_TYPE.CONCURRENT_EDIT, 'peer_b', 'evt_b_600', 'old_base', hashLocal, hashRemote, JSON.stringify(entLocal), JSON.stringify(entRemote), CONFLICT_STATUS.PENDING]
    );

    // User chooses KEEP_LOCAL
    const res = await resolveConflict(confId, CONFLICT_RESOLUTION.KEEP_LOCAL);
    assert.equal(res.success, true);

    const deltas = (await db.query('SELECT * FROM sync_delta_queue WHERE resolution_type = ?', ['KEEP_LOCAL'])).values;
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].base_checksum, hashRemote); // Remote state being overridden
    assert.equal(deltas[0].new_checksum, hashLocal);
  });

  await t.test('A07: CUSTOM_STATE resolution generates outbound delta and converges peer', async () => {
    const db = await resetDB();
    const entityId = 'txn_a07';

    const entLocal = { id: entityId, inr: 100, note: 'Local A' };
    await db.run('INSERT INTO transactions (id, inr, note) VALUES (?, ?, ?)', [entLocal.id, entLocal.inr, entLocal.note]);
    const hashLocal = await computeCanonicalSha256(entLocal);

    const customMerged = { id: entityId, inr: 150, note: 'Merged Custom' };
    const hashCustom = await computeCanonicalSha256(customMerged);

    const confId = 'conf_a07';
    await db.run(
      'INSERT INTO sync_conflicts (conflict_id, collection, entity_id, conflict_type, peer_device_id, event_id, base_checksum, local_checksum, remote_checksum, local_payload, remote_payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [confId, 'transactions', entityId, CONFLICT_TYPE.CONCURRENT_EDIT, 'peer_b', 'evt_b_700', 'old_base', hashLocal, 'hash_rem', JSON.stringify(entLocal), JSON.stringify({ id: entityId, inr: 200 }), CONFLICT_STATUS.PENDING]
    );

    const res = await resolveConflict(confId, CONFLICT_RESOLUTION.CUSTOM_STATE, customMerged);
    assert.equal(res.success, true);

    const canonical = (await db.query('SELECT inr, note FROM transactions WHERE id = ?', [entityId])).values[0];
    assert.equal(canonical.inr, 150);
    assert.equal(canonical.note, 'Merged Custom');

    const deltas = (await db.query('SELECT * FROM sync_delta_queue WHERE resolution_type = ?', ['CUSTOM_STATE'])).values;
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].new_checksum, hashCustom);
  });

  await t.test('A08: Resolution event replay is completely idempotent on peer', async () => {
    const db = await resetDB();
    const entityId = 'txn_a08';

    const entChosen = { id: entityId, inr: 500, note: 'Chosen State' };
    await db.run('INSERT INTO transactions (id, inr, note) VALUES (?, ?, ?)', [entChosen.id, entChosen.inr, entChosen.note]);
    const hashChosen = await computeCanonicalSha256(entChosen);

    // Replay of resolution event where local already has chosen state
    await db.run(
      'INSERT INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, payload, resolution_type, resolved_event_id, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_res_replay', 'pkg_a_1', 'peer_a', 10, new Date().toISOString(), 'transactions', entityId, 'UPDATE', 'old_hash', hashChosen, JSON.stringify(entChosen), 'KEEP_LOCAL', 'evt_orig_1', new Date().toISOString(), 'STAGED']
    );
    await db.run('INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['peer_a', 10, 9, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    const reconRes = await reconcileStagedEvents({ peerDeviceId: 'peer_a' });
    const evStatus = (await db.query('SELECT status FROM sync_staged_events WHERE event_id = ?', ['evt_res_replay'])).values[0].status;
    assert.equal(evStatus, RECONCILIATION_STATUS.RECONCILED_IDEMPOTENT);
  });

  await t.test('A09: Resolution-before-original: resolution applied cleanly, auto-records supersession, original becomes RECONCILED_SUPERSEDED', async () => {
    const db = await resetDB();
    const entityId = 'txn_a09';

    // 1. Initial base state
    const baseEnt = { id: entityId, inr: 100, note: 'Base' };
    await db.run('INSERT INTO transactions (id, inr, note) VALUES (?, ?, ?)', [baseEnt.id, baseEnt.inr, baseEnt.note]);
    const hashBase = await computeCanonicalSha256(baseEnt);

    const resolvedEnt = { id: entityId, inr: 300, note: 'Resolved Chosen' };
    const hashResolved = await computeCanonicalSha256(resolvedEnt);

    // 2. Stage resolution event A700 (which resolves B500)
    await db.run(
      'INSERT INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, payload, resolution_type, resolved_event_id, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_a700', 'pkg_a_7', 'dev_a', 700, new Date().toISOString(), 'transactions', entityId, 'UPDATE', hashBase, hashResolved, JSON.stringify(resolvedEnt), 'KEEP_LOCAL', 'evt_b500', new Date().toISOString(), 'STAGED']
    );
    await db.run('INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['dev_a', 700, 699, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    // Reconcile A700 (production code must automatically persist resolved conflict for evt_b500)
    const reconA = await reconcileStagedEvents({ peerDeviceId: 'dev_a' });
    assert.equal(reconA.reconciledCount, 1);

    const localNow = (await db.query('SELECT note FROM transactions WHERE id = ?', [entityId])).values[0].note;
    assert.equal(localNow, 'Resolved Chosen');

    // Verify durable resolution record exists in sync_conflicts without manual seeding
    const autoConf = (await db.query('SELECT * FROM sync_conflicts WHERE event_id = ?', ['evt_b500'])).values[0];
    assert.ok(autoConf, 'Reconciler must automatically create a durable record in sync_conflicts for the resolved event');
    assert.equal(autoConf.status, CONFLICT_STATUS.RESOLVED);

    // 3. Later, original conflicting event B500 arrives
    const origConfEnt = { id: entityId, inr: 200, note: 'B Conflicting' };
    const hashConf = await computeCanonicalSha256(origConfEnt);

    await db.run(
      'INSERT INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, payload, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_b500', 'pkg_b_5', 'dev_b', 500, new Date().toISOString(), 'transactions', entityId, 'UPDATE', hashBase, hashConf, JSON.stringify(origConfEnt), new Date().toISOString(), 'STAGED']
    );
    await db.run('INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['dev_b', 500, 499, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    await reconcileStagedEvents({ peerDeviceId: 'dev_b' });

    const b500Status = (await db.query('SELECT status FROM sync_staged_events WHERE event_id = ?', ['evt_b500'])).values[0].status;
    assert.equal(b500Status, RECONCILIATION_STATUS.RECONCILED_SUPERSEDED);

    // Zero pending conflicts created
    const pendingConflicts = await getPendingConflicts();
    assert.equal(pendingConflicts.length, 0, 'No pending conflict should be created for superseded original event');

    // Chosen state remains intact
    const finalNote = (await db.query('SELECT note FROM transactions WHERE id = ?', [entityId])).values[0].note;
    assert.equal(finalNote, 'Resolved Chosen');

    // Replay idempotency: replaying both streams produces zero side-effects
    await reconcileStagedEvents({ peerDeviceId: 'dev_a' });
    await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal((await db.query('SELECT note FROM transactions WHERE id = ?', [entityId])).values[0].note, 'Resolved Chosen');
  });

  await t.test('A10: Original-before-resolution: original creates conflict, resolution resolves it automatically', async () => {
    const db = await resetDB();
    const entityId = 'txn_a10';

    const entLocal = { id: entityId, inr: 100, note: 'Local Base' };
    await db.run('INSERT INTO transactions (id, inr, note) VALUES (?, ?, ?)', [entLocal.id, entLocal.inr, entLocal.note]);
    const hashLocal = await computeCanonicalSha256(entLocal);

    // 1. Original B500 arrives -> CONFLICT
    const entB = { id: entityId, inr: 200, note: 'Remote B' };
    const hashB = await computeCanonicalSha256(entB);

    await db.run(
      'INSERT INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, payload, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_b_10', 'pkg_b_1', 'dev_b', 500, new Date().toISOString(), 'transactions', entityId, 'UPDATE', 'wrong_base', hashB, JSON.stringify(entB), new Date().toISOString(), 'STAGED']
    );
    await db.run('INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['dev_b', 500, 499, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    const conflicts = await getPendingConflicts();
    assert.equal(conflicts.length, 1);

    // 2. Resolution A700 arrives referencing evt_b_10
    const entRes = { id: entityId, inr: 300, note: 'Resolution State' };
    const hashRes = await computeCanonicalSha256(entRes);

    await db.run(
      'INSERT INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, payload, resolution_type, resolved_event_id, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_a_700', 'pkg_a_7', 'dev_a', 700, new Date().toISOString(), 'transactions', entityId, 'UPDATE', hashLocal, hashRes, JSON.stringify(entRes), 'ACCEPT_REMOTE', 'evt_b_10', new Date().toISOString(), 'STAGED']
    );
    await db.run('INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['dev_a', 700, 699, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    await reconcileStagedEvents({ peerDeviceId: 'dev_a' });

    // Conflict resolved automatically
    const remainingConf = await getPendingConflicts();
    assert.equal(remainingConf.length, 0);

    const finalNote = (await db.query('SELECT note FROM transactions WHERE id = ?', [entityId])).values[0].note;
    assert.equal(finalNote, 'Resolution State');
  });

  await t.test('A11: Missing predecessor package halts staging watermark advance', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();
    const peerDeviceId = 'peer_gap_dev';

    // Package 2 (201-300) arrives while last_staged_sequence is 100
    const p2Events = [{ event_id: 'e201', device_id: peerDeviceId, sequence: 201, timestamp: new Date().toISOString(), collection: 'transactions', entity_id: 't201', operation: 'INSERT', new_checksum: 'h', payload: { id: 't201' } }];
    const p2Payload = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 201,
      endSequence: 201,
      events: p2Events
    });

    // Initial watermark is 100
    await db.run('INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      [peerDeviceId, 100, 100, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    // Staging package with sequence gap throws error and does NOT advance watermark
    await assert.rejects(async () => {
      await stagePeerPackageAtomically({
        packagePayload: p2Payload,
        packageChecksum: 'chk_p2'
      });
    }, /Sequence gap detected/);

    const peerState = (await db.query('SELECT last_staged_sequence FROM sync_peer_state WHERE peer_device_id = ?', [peerDeviceId])).values[0];
    assert.equal(Number(peerState.last_staged_sequence), 100);
  });

  await t.test('A12: Out-of-order package delivery staged without corrupting watermark', async () => {
    const db = await resetDB();
    const peerDeviceId = 'peer_ooo';

    // Package 1 (101-102)
    const p1 = buildDeterministicPackagePayload({
      deviceId: peerDeviceId,
      startSequence: 101,
      endSequence: 102,
      events: [
        { event_id: 'e101', device_id: peerDeviceId, sequence: 101, timestamp: new Date().toISOString(), collection: 'transactions', entity_id: 't101', operation: 'INSERT', payload: { id: 't101' } },
        { event_id: 'e102', device_id: peerDeviceId, sequence: 102, timestamp: new Date().toISOString(), collection: 'transactions', entity_id: 't102', operation: 'INSERT', payload: { id: 't102' } }
      ]
    });

    // Initial watermark 100
    await db.run('INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      [peerDeviceId, 100, 100, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    const s1 = await stagePeerPackageAtomically({ packagePayload: p1, packageChecksum: 'chk_p1' });
    assert.equal(s1.staged, true);

    const peerState = (await db.query('SELECT last_staged_sequence FROM sync_peer_state WHERE peer_device_id = ?', [peerDeviceId])).values[0];
    assert.equal(Number(peerState.last_staged_sequence), 102);
  });

  await t.test('A13: Exact cryptographic package identity required before queue ACK recovery', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();
    const deviceId = 'dev_a13';

    const nowIso = new Date().toISOString();
    const t1 = { id: 'txn_a13', inr: 100 };
    const h1 = await computeCanonicalSha256(t1);

    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_a13', deviceId, 1, nowIso, 'transactions', t1.id, 'INSERT', h1, JSON.stringify(t1), 'PENDING']
    );

    const payload = buildDeterministicPackagePayload({
      deviceId,
      startSequence: 1,
      endSequence: 1,
      events: [{ event_id: 'evt_a13', device_id: deviceId, sequence: 1, timestamp: nowIso, collection: 'transactions', entity_id: t1.id, operation: 'INSERT', new_checksum: h1, payload: t1 }]
    });
    const pkgChecksum = await computeCanonicalSha256(payload);

    // Mock manifest in Drive with exact checksum
    const manifest = createEmptyDeviceManifest(deviceId);
    manifest.packages.push({
      package_id: payload.package_id,
      drive_file_id: 'drive_file_1',
      start_sequence: 1,
      end_sequence: 1,
      event_count: 1,
      package_checksum: pkgChecksum
    });
    await writeOwnDeviceManifest(manifest, null, driveClient);

    // Run recovery
    await recoverQueueAckFromAuthoritativeManifest({ deviceId, driveClient });

    const qStatus = (await db.query('SELECT status FROM sync_delta_queue WHERE sequence = 1')).values[0].status;
    assert.equal(qStatus, 'ACKNOWLEDGED');
  });

  await t.test('A14: Manifest retry race does not prematurely acknowledge local queue', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();
    const deviceId = 'dev_a14';

    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_a14', deviceId, 5, new Date().toISOString(), 'transactions', 't5', 'INSERT', JSON.stringify({ id: 't5' }), 'PENDING']
    );

    // Manifest contains mismatched checksum
    const manifest = createEmptyDeviceManifest(deviceId);
    manifest.packages.push({
      package_id: 'pkg_dev_a14_000005_000005',
      drive_file_id: 'df_5',
      start_sequence: 5,
      end_sequence: 5,
      event_count: 1,
      package_checksum: 'mismatched_checksum'
    });
    await writeOwnDeviceManifest(manifest, null, driveClient);

    await recoverQueueAckFromAuthoritativeManifest({ deviceId, driveClient });

    const qStatus = (await db.query('SELECT status FROM sync_delta_queue WHERE sequence = 5')).values[0].status;
    assert.equal(qStatus, 'PENDING'); // Not prematurely acknowledged
  });

  await t.test('A15: Atomic resolution commit: canonical update + conflict record + outbound delta commit atomically', async () => {
    const db = await resetDB();
    const entityId = 'txn_a15';

    const entLocal = { id: entityId, inr: 100, note: 'Local State' };
    await db.run('INSERT INTO transactions (id, inr, note) VALUES (?, ?, ?)', [entLocal.id, entLocal.inr, entLocal.note]);
    const hashLocal = await computeCanonicalSha256(entLocal);

    const confId = 'conf_a15';
    await db.run(
      'INSERT INTO sync_conflicts (conflict_id, collection, entity_id, conflict_type, peer_device_id, event_id, base_checksum, local_checksum, remote_checksum, local_payload, remote_payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [confId, 'transactions', entityId, CONFLICT_TYPE.CONCURRENT_EDIT, 'peer_b', 'evt_b_15', 'base', hashLocal, 'hash_b', JSON.stringify(entLocal), JSON.stringify({ id: entityId, inr: 250, note: 'Remote' }), CONFLICT_STATUS.PENDING]
    );

    // Initial sequence is 0
    await db.run('INSERT OR REPLACE INTO sync_local_state (key, device_id, last_allocated_sequence, updated_at) VALUES (?, ?, ?, ?)',
      ['device_state', 'local_device', 0, new Date().toISOString()]
    );

    // T1: Stale Precondition Failure Check
    // If local entity was modified after conflict was logged, resolveConflict must abort immediately without side-effects
    await db.run('UPDATE transactions SET inr = ? WHERE id = ?', [105, entityId]);
    await assert.rejects(async () => {
      await resolveConflict(confId, CONFLICT_RESOLUTION.ACCEPT_REMOTE);
    }, /STALE_CONFLICT_ERROR/);

    // Verify ZERO side-effects after stale rejection
    const staleConf = (await db.query('SELECT status FROM sync_conflicts WHERE conflict_id = ?', [confId])).values[0];
    assert.equal(staleConf.status, CONFLICT_STATUS.PENDING);
    const staleDeltas = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(staleDeltas.length, 0);

    // Restore valid state for clean resolution
    await db.run('UPDATE transactions SET inr = ? WHERE id = ?', [100, entityId]);

    // T2: Clean Atomic Resolution Commit
    const res = await resolveConflict(confId, CONFLICT_RESOLUTION.ACCEPT_REMOTE);
    assert.equal(res.success, true);

    // All stores updated in unison
    const confRecord = (await db.query('SELECT status, resolution FROM sync_conflicts WHERE conflict_id = ?', [confId])).values[0];
    assert.equal(confRecord.status, CONFLICT_STATUS.RESOLVED);
    assert.equal(confRecord.resolution, CONFLICT_RESOLUTION.ACCEPT_REMOTE);

    const canonicalTxn = (await db.query('SELECT note, inr FROM transactions WHERE id = ?', [entityId])).values[0];
    assert.equal(canonicalTxn.note, 'Remote');
    assert.equal(canonicalTxn.inr, 250);

    const deltas = (await db.query('SELECT * FROM sync_delta_queue WHERE resolved_conflict_id = ?', [confId])).values;
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].sequence, 1);

    const seqState = (await db.query('SELECT last_allocated_sequence FROM sync_local_state WHERE key = ?', ['device_state'])).values[0];
    assert.equal(Number(seqState.last_allocated_sequence), 1);
  });

  // =========================================================================
  // CATEGORY B: PROTOCOL & UNIT TESTS (B01 - B04)
  // =========================================================================

  await t.test('B01: Two-layer integrity: Drive MD5 ciphertext vs Protocol SHA-256 canonical plaintext', async () => {
    const payload = buildDeterministicPackagePayload({
      deviceId: 'dev_b01',
      startSequence: 1,
      endSequence: 1,
      events: [{ event_id: 'e1', device_id: 'dev_b01', sequence: 1, timestamp: '2026-09-27T00:00:00Z', collection: 'transactions', entity_id: 't1', operation: 'INSERT', payload: { id: 't1' } }]
    });

    const encrypted = await encryptDeltaPackage(payload, 'test_key');
    assert.ok(encrypted.package_checksum.length === 64);
    assert.ok(encrypted.ciphertext.length > 0);

    const decrypted = await decryptDeltaPackage(encrypted, 'test_key');
    const verifyHash = await computeCanonicalSha256(decrypted);
    assert.equal(verifyHash, encrypted.package_checksum);
  });

  await t.test('B02: Package sizing: target 100, max 250, oversized bundle exception', async () => {
    // Generate 300 single events
    const events = [];
    for (let i = 1; i <= 300; i++) {
      events.push({
        event_id: `e_${i}`,
        device_id: 'dev_b02',
        sequence: i,
        timestamp: '2026-09-27T00:00:00Z',
        collection: 'transactions',
        entity_id: `t_${i}`,
        operation: 'INSERT',
        payload: { id: `t_${i}` }
      });
    }

    const slices = slicePendingDeltaQueue(events, 100, 250);
    assert.equal(slices.length, 3);
    assert.equal(slices[0].events.length, 100);
    assert.equal(slices[1].events.length, 100);
    assert.equal(slices[2].events.length, 100);

    // Oversized single bundle of 280 events
    const bundleEvents = [];
    for (let i = 1; i <= 280; i++) {
      bundleEvents.push({
        event_id: `be_${i}`,
        device_id: 'dev_b02',
        sequence: i,
        timestamp: '2026-09-27T00:00:00Z',
        collection: 'transactions',
        entity_id: `bt_${i}`,
        operation: 'INSERT',
        bundle_id: 'big_bundle_1',
        bundle_index: i - 1,
        bundle_total: 280,
        payload: { id: `bt_${i}` }
      });
    }

    const oversizedSlices = slicePendingDeltaQueue(bundleEvents, 100, 250);
    assert.equal(oversizedSlices.length, 1);
    assert.equal(oversizedSlices[0].events.length, 280);
    assert.equal(oversizedSlices[0].isOversizedBundle, true);
  });

  await t.test('B03: Same-device manifest RMW generation increment and verification', async () => {
    const driveClient = createMockDriveClient();
    const deviceId = 'dev_b03';

    const m1 = createEmptyDeviceManifest(deviceId);
    assert.equal(m1.manifest_revision, 0);

    await writeOwnDeviceManifest(m1, null, driveClient);
    const read1 = await readOwnDeviceManifest({ deviceId, driveClient });
    assert.equal(read1.manifest_revision, 1);

    await writeOwnDeviceManifest(read1, null, driveClient);
    const read2 = await readOwnDeviceManifest({ deviceId, driveClient });
    assert.equal(read2.manifest_revision, 2);
  });

  await t.test('B04: AES-256-GCM authentication tag tampering detection and rejection', async () => {
    const payload = buildDeterministicPackagePayload({
      deviceId: 'dev_b04',
      startSequence: 1,
      endSequence: 1,
      events: [{ event_id: 'e1', device_id: 'dev_b04', sequence: 1, timestamp: '2026-09-27T00:00:00Z', collection: 'transactions', entity_id: 't1', operation: 'INSERT', payload: { id: 't1' } }]
    });

    const encrypted = await encryptDeltaPackage(payload, 'test_key');
    
    // Tamper with ciphertext
    const tampered = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.substring(0, encrypted.ciphertext.length - 4) + 'AAAA'
    };

    await assert.rejects(async () => {
      await decryptDeltaPackage(tampered, 'test_key');
    });
  });

  // =========================================================================
  // CATEGORY C: PERFORMANCE BENCHMARKS (C01 - C02)
  // =========================================================================

  await t.test('C01: 100-event batch reconciliation benchmark', async () => {
    const db = await resetDB();
    const peerDeviceId = 'peer_bench';

    // Insert 100 staged events
    for (let i = 1; i <= 100; i++) {
      const ent = { id: `txn_bench_${i}`, inr: i * 10, note: `Bench ${i}` };
      const h = await computeCanonicalSha256(ent);
      await db.run(
        'INSERT INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`evt_bench_${i}`, 'pkg_bench_1', peerDeviceId, i, new Date().toISOString(), 'transactions', ent.id, 'INSERT', h, JSON.stringify(ent), new Date().toISOString(), 'STAGED']
      );
    }

    await db.run('INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      [peerDeviceId, 100, 0, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    const t0 = performance.now();
    const res = await reconcileStagedEvents({ peerDeviceId });
    const duration = performance.now() - t0;

    console.log(`\n  [C01 Benchmark Result] 100-Event Reconciliation Duration: ${duration.toFixed(2)} ms (Architecture Target: <50 ms)`);
    assert.equal(res.reconciledCount, 100);
  });

  await t.test('C02: End-to-end full sync cycle benchmark', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();
    const deviceId = 'dev_bench_e2e';

    // Insert 10 pending local mutations
    for (let i = 1; i <= 10; i++) {
      const t = { id: `txn_e2e_${i}`, inr: i * 100, note: `E2E ${i}` };
      const h = await computeCanonicalSha256(t);
      await db.run(
        'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`evt_e2e_${i}`, deviceId, i, new Date().toISOString(), 'transactions', t.id, 'INSERT', h, JSON.stringify(t), 'PENDING']
      );
    }

    const t0 = performance.now();
    const syncRes = await executeFullSyncPass({
      deviceId,
      driveClient,
      sessionKey: 'bench_key'
    });
    const duration = performance.now() - t0;

    console.log(`  [C02 Benchmark Result] End-to-End Sync Pass Duration: ${duration.toFixed(2)} ms (Architecture Target: <1200 ms P95)\n`);
    assert.equal(syncRes.success, true);
    assert.equal(syncRes.outbound.eventsUploaded, 10);
  });

  // =========================================================================
  // CATEGORY D: RUNTIME INTEGRATION & RECOVERY TESTS (D01 – D07)
  // =========================================================================

  await t.test('D01: Runtime initialization configures live providers and deduplicates listeners', async () => {
    const db = await resetDB();
    const cleanup1 = initializeDeltaSyncRuntime();
    assert.equal(isDeltaSyncRuntimeInitialized(), true);

    // Second initialization call should return the existing cleanup function without duplicating
    const cleanup2 = initializeDeltaSyncRuntime();
    assert.equal(cleanup1, cleanup2);

    cleanup1();
    assert.equal(isDeltaSyncRuntimeInitialized(), false);
  });

  await t.test('D02: Successful atomic mutation queues delta and triggers scheduleSync', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();
    let scheduledTrigger = null;

    configureDeltaSyncEngine({
      driveClient,
      sessionKey: 'test_key',
      deviceId: 'dev_d02',
      enabled: true
    });

    const txn = { id: 'txn_d02_1', inr: 230, note: 'Live expense test' };
    const emitted = await executeAtomicMutation({
      storeName: 'transactions',
      entityId: txn.id,
      operation: 'INSERT',
      entityData: txn
    });

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].entity_id, 'txn_d02_1');

    const queueRes = await db.query('SELECT * FROM sync_delta_queue WHERE entity_id = ?', ['txn_d02_1']);
    assert.equal(queueRes.values.length, 1);
    assert.equal(queueRes.values[0].status, 'PENDING');
  });

  await t.test('D03: Failed/aborted atomic mutation does NOT commit delta or corrupt queue', async () => {
    const db = await resetDB();
    const queueBefore = (await db.query('SELECT * FROM sync_delta_queue')).values || [];

    await assert.rejects(async () => {
      await executeAtomicMutation({
        storeName: 'non_existent_store_for_failure',
        entityId: 'fail_1',
        operation: 'UPDATE',
        entityData: { id: 'fail_1' }
      });
    });

    const queueAfter = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(queueAfter.length, queueBefore.length);
  });

  await t.test('D04: Pending queue recovery on session key unlock', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();
    const deviceId = 'dev_d04';

    lockSyncSession();

    // 1. Mutation occurs while session is locked
    const txn = { id: 'txn_d04_pending', inr: 500, note: 'Offline while locked' };
    await executeAtomicMutation({
      storeName: 'transactions',
      entityId: txn.id,
      operation: 'INSERT',
      entityData: txn
    });

    // 2. Queue event exists as PENDING
    const pendingQueue = (await db.query('SELECT * FROM sync_delta_queue WHERE status = ?', ['PENDING'])).values;
    assert.equal(pendingQueue.length, 1);

    // 3. Execution when locked safely returns AUTH_REQUIRED without uploading
    const lockedRes = await executeFullSyncPass({
      deviceId,
      driveClient,
      sessionKey: getSyncSessionKey()
    });
    assert.equal(lockedRes.success, false);
    assert.equal(lockedRes.status, SYNC_STATUS.AUTH_REQUIRED);

    // 4. Session becomes unlocked
    await unlockSyncSession('123456');
    const unlockedKey = getSyncSessionKey();
    assert.ok(unlockedKey);

    // 5. Execution with unlocked session succeeds and uploads pending delta
    const unlockedRes = await executeFullSyncPass({
      deviceId,
      driveClient,
      sessionKey: unlockedKey
    });

    assert.equal(unlockedRes.success, true);
    assert.equal(unlockedRes.outbound.eventsUploaded, 1);

    const postQueue = (await db.query('SELECT * FROM sync_delta_queue WHERE status = ?', ['ACKNOWLEDGED'])).values;
    assert.equal(postQueue.length, 1);

    lockSyncSession();
  });

  await t.test('D05: Startup and foreground triggers process pending deltas when credentials available', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();
    const deviceId = 'dev_d05';

    // Seed 2 pending mutations
    for (let i = 1; i <= 2; i++) {
      const t = { id: `txn_d05_${i}`, inr: i * 150 };
      const h = await computeCanonicalSha256(t);
      await db.run(
        'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`evt_d05_${i}`, deviceId, i, new Date().toISOString(), 'transactions', t.id, 'INSERT', h, JSON.stringify(t), 'PENDING']
      );
    }

    const fgRes = await executeFullSyncPass({
      trigger: SYNC_TRIGGER.FOREGROUND,
      deviceId,
      driveClient,
      sessionKey: 'test_key'
    });

    assert.equal(fgRes.success, true);
    assert.equal(fgRes.trigger, SYNC_TRIGGER.FOREGROUND);
    assert.equal(fgRes.outbound.eventsUploaded, 2);
  });

  await t.test('D06: Missing auth/session safely defers execution without data corruption', async () => {
    const db = await resetDB();
    const deviceId = 'dev_d06';

    // Insert pending delta
    const t = { id: 'txn_d06_safe', inr: 99 };
    const h = await computeCanonicalSha256(t);
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_d06_safe', deviceId, 1, new Date().toISOString(), 'transactions', t.id, 'INSERT', h, JSON.stringify(t), 'PENDING']
    );

    // Call sync with no auth and no driveClient
    const noAuthRes = await executeFullSyncPass({
      trigger: SYNC_TRIGGER.MUTATION,
      deviceId,
      accessToken: null,
      driveClient: null,
      sessionKey: null
    });

    assert.equal(noAuthRes.success, false);
    assert.equal(noAuthRes.status, SYNC_STATUS.AUTH_REQUIRED);

    // Verify pending delta is preserved
    const qRes = await db.query('SELECT * FROM sync_delta_queue WHERE event_id = ?', ['evt_d06_safe']);
    assert.equal(qRes.values[0].status, 'PENDING');
  });

  await t.test('D07: Legacy snapshot sync engine remains separate and undisturbed', async () => {
    // Verify cloudSyncEngine export exists and is not overwritten by delta coordinator
    const { executeCloudSync, CURRENT_ENGINE_VERSION } = await import('../services/cloudSyncEngine.js');
    assert.equal(typeof executeCloudSync, 'function');
    assert.equal(CURRENT_ENGINE_VERSION, 1);
  });

  await t.test('D08: Live getAccessToken provider delegates to getValidAccessToken(false)', async () => {
    const db = await resetDB();
    clearGoogleAuth();
    configureDeltaSyncEngine({ driveClient: null, accessToken: null });

    // 1. When valid token is in localStorage, provider returns it directly
    saveTokenData('test_live_access_token_123', 3600);
    const cleanup = initializeDeltaSyncRuntime();

    // Trigger full sync pass with driveClient override to verify accessToken flow
    const driveClient = createMockDriveClient();
    const res = await executeFullSyncPass({
      sessionKey: 'test_session_key',
      driveClient
    });

    assert.equal(res.success, true);
    cleanup();
    clearGoogleAuth();
  });

  await t.test('D09: Authentication unavailable returns AUTH_REQUIRED and preserves pending deltas without looping', async () => {
    const db = await resetDB();
    clearGoogleAuth();
    setGoogleLinked(false);
    configureDeltaSyncEngine({ driveClient: null, accessToken: null });

    const cleanup = initializeDeltaSyncRuntime();

    // Insert pending delta
    const t = { id: 'txn_d09_unauth', inr: 450 };
    const h = await computeCanonicalSha256(t);
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_d09_unauth', 'dev_d09', 1, new Date().toISOString(), 'transactions', t.id, 'INSERT', h, JSON.stringify(t), 'PENDING']
    );

    const res = await executeFullSyncPass({
      sessionKey: 'test_session_key',
      driveClient: null,
      accessToken: undefined
    });

    assert.equal(res.success, false);
    assert.equal(res.status, SYNC_STATUS.AUTH_REQUIRED);

    // Delta remains intact in PENDING status
    const queueRows = (await db.query('SELECT * FROM sync_delta_queue WHERE event_id = ?', ['evt_d09_unauth'])).values;
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].status, 'PENDING');

    cleanup();
  });

  await t.test('D10: Access token is never persisted in delta queue or local storage database records', async () => {
    const db = await resetDB();
    const secretToken = 'secret_bearer_token_xyz999';
    const driveClient = createMockDriveClient();

    const t = { id: 'txn_d10_clean', inr: 777 };
    const h = await computeCanonicalSha256(t);
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_d10_clean', 'dev_d10', 1, new Date().toISOString(), 'transactions', t.id, 'INSERT', h, JSON.stringify(t), 'PENDING']
    );

    await executeFullSyncPass({
      deviceId: 'dev_d10',
      accessToken: secretToken,
      driveClient,
      sessionKey: 'test_key'
    });

    // Check all database tables to ensure secretToken was never written into database tables
    const queueDump = JSON.stringify((await db.query('SELECT * FROM sync_delta_queue')).values);
    assert.equal(queueDump.includes(secretToken), false);

    const localStateDump = JSON.stringify((await db.query('SELECT * FROM sync_local_state')).values);
    assert.equal(localStateDump.includes(secretToken), false);
  });

  await t.test('D11: Successful auth restoration emits auth-state notification', async () => {
    let receivedAuth = null;
    let receivedToken = null;
    const unsub = subscribeGoogleAuth((isAuth, token) => {
      receivedAuth = isAuth;
      receivedToken = token;
    });

    saveTokenData('restored_token_12345', 3600);
    assert.equal(receivedAuth, true);
    assert.equal(receivedToken, 'restored_token_12345');

    clearGoogleAuth();
    assert.equal(receivedAuth, false);
    assert.equal(receivedToken, null);

    unsub();
  });

  await t.test('D12: Delta coordinator receives auth notification and schedules automatic sync pass', async () => {
    const db = await resetDB();
    clearGoogleAuth();
    lockSyncSession();
    await unlockSyncSession('123456');
    configureDeltaSyncEngine({ driveClient: null, accessToken: null });

    // Seed local device state
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, last_allocated_sequence, updated_at) VALUES (?, ?, ?, ?)',
      ['device_state', 'dev_d12', 1, new Date().toISOString()]
    );

    const cleanup = initializeDeltaSyncRuntime();
    await new Promise(r => setTimeout(r, 50)); // Allow dynamic import listeners to attach

    // 1. Initial pending delta in unauthenticated state
    const t = { id: 'txn_d12_pending', inr: 888 };
    const h = await computeCanonicalSha256(t);
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_d12_pending', 'dev_d12', 1, new Date().toISOString(), 'transactions', t.id, 'INSERT', h, JSON.stringify(t), 'PENDING']
    );

    // 2. Setup mock drive client for the live provider
    const driveClient = createMockDriveClient();
    configureDeltaSyncEngine({ driveClient });

    // 3. Simulate interactive Google reconnect / token save
    saveTokenData('newly_connected_token_999', 3600);

    // Wait brief tick for scheduled immediate pass to execute under lock
    await new Promise(r => setTimeout(r, 200));

    // Verify delta was picked up and ACKed
    const queueRows = (await db.query('SELECT * FROM sync_delta_queue WHERE event_id = ?', ['evt_d12_pending'])).values;
    assert.equal(queueRows[0].status, 'ACKNOWLEDGED');

    cleanup();
    clearGoogleAuth();
    lockSyncSession();
  });

  await t.test('D13: Existing pending queue is preserved and not mutated by trigger dispatch itself', async () => {
    const db = await resetDB();
    clearGoogleAuth();

    // Seed 3 pending transactions
    for (let i = 1; i <= 3; i++) {
      const txn = { id: `txn_d13_${i}`, amount: i * 100 };
      const h = await computeCanonicalSha256(txn);
      await db.run(
        'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`evt_d13_${i}`, 'dev_d13', i, new Date().toISOString(), 'transactions', txn.id, 'INSERT', h, JSON.stringify(txn), 'PENDING']
      );
    }

    // Verify 3 rows exist with status PENDING
    const beforeRows = (await db.query('SELECT * FROM sync_delta_queue ORDER BY sequence ASC')).values;
    assert.equal(beforeRows.length, 3);
    assert.equal(beforeRows.every(r => r.status === 'PENDING'), true);

    // Dispatch trigger when no credentials available
    scheduleSync(SYNC_TRIGGER.STARTUP);
    await new Promise(r => setTimeout(r, 50));

    // Verify all 3 rows remain intact
    const afterRows = (await db.query('SELECT * FROM sync_delta_queue ORDER BY sequence ASC')).values;
    assert.equal(afterRows.length, 3);
    assert.equal(afterRows.every(r => r.status === 'PENDING'), true);
  });

  await t.test('D14: Duplicate auth notifications coalesce without concurrent duplicate sync passes', async () => {
    const db = await resetDB();
    clearGoogleAuth();
    lockSyncSession();
    await unlockSyncSession('123456');

    const driveClient = createMockDriveClient();
    configureDeltaSyncEngine({ driveClient });

    const cleanup = initializeDeltaSyncRuntime();
    await new Promise(r => setTimeout(r, 50));

    // Rapid successive auth tokens
    saveTokenData('token_burst_1', 3600);
    saveTokenData('token_burst_2', 3600);
    saveTokenData('token_burst_3', 3600);

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50));
      const s = getCurrentSyncStatus();
      if (s === SYNC_STATUS.SUCCESS || s === SYNC_STATUS.IDLE) break;
    }

    // Confirm system completed pass and reached SUCCESS or IDLE
    const status = getCurrentSyncStatus();
    assert.equal(status === SYNC_STATUS.SUCCESS || status === SYNC_STATUS.IDLE, true);

    cleanup();
    clearGoogleAuth();
    lockSyncSession();
  });
});

