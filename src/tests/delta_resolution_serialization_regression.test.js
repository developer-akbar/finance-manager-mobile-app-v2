import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuid } from 'uuid';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, getDB, closeDB } from '../database/db.js';
import { computeCanonicalSha256, toCanonicalJson } from '../utils/canonicalEntity.js';
import { executeAtomicMutation } from '../database/atomicMutation.js';
import {
  buildDeterministicPackagePayload,
  encryptDeltaPackage,
  decryptDeltaPackage,
  stagePeerPackageAtomically,
  computePackageChecksum
} from '../services/deltaTransport.js';
import {
  reconcileStagedEvents,
  resolveConflict,
  RECONCILIATION_STATUS,
  APPROVED_BASE_SNAPSHOT_ID,
  APPROVED_BASE_CLOUD_VERSION
} from '../services/deltaReconciliation.js';
import { saveConflictRecord, getConflict, getPendingConflicts, CONFLICT_STATUS, CONFLICT_TYPE, CONFLICT_RESOLUTION } from '../database/conflicts.js';

test('FinMan — Conflict Resolution Serialization & Propagation Regression Suite', async (t) => {
  globalThis.indexedDB = new IDBFactory();
  const testPin = '99998888';

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

  // --- Test A: KEEP_LOCAL serialization round-trip ---
  await t.test('Test A: KEEP_LOCAL resolution metadata survives transport serialization', async () => {
    const resolutionEvent = {
      event_id: 'evt_res_kl_1',
      device_id: 'dev_c',
      sequence: 11,
      timestamp: new Date().toISOString(),
      collection: 'transactions',
      entity_id: 'txn_res_001',
      operation: 'UPDATE',
      base_checksum: 'h_remote_d',
      new_checksum: 'h_local_c',
      tombstone_generation: 0,
      payload: { id: 'txn_res_001', note: 'TEST_CONCURRENT_EDIT_C_BRANCH', amount: 10 },
      resolution_type: 'KEEP_LOCAL',
      resolved_event_id: 'evt_dev_d_4',
      resolved_conflict_id: 'conf_c_001'
    };

    const pkgPayload = buildDeterministicPackagePayload({
      deviceId: 'dev_c',
      startSequence: 11,
      endSequence: 11,
      baseSnapshotId: APPROVED_BASE_SNAPSHOT_ID,
      baseCloudVersion: APPROVED_BASE_CLOUD_VERSION,
      events: [resolutionEvent]
    });

    assert.equal(pkgPayload.events[0].resolution_type, 'KEEP_LOCAL');
    assert.equal(pkgPayload.events[0].resolved_event_id, 'evt_dev_d_4');
    assert.equal(pkgPayload.events[0].resolved_conflict_id, 'conf_c_001');

    const encrypted = await encryptDeltaPackage(pkgPayload, testPin);
    const decrypted = await decryptDeltaPackage(encrypted, testPin);

    assert.equal(decrypted.events[0].resolution_type, 'KEEP_LOCAL');
    assert.equal(decrypted.events[0].resolved_event_id, 'evt_dev_d_4');
    assert.equal(decrypted.events[0].resolved_conflict_id, 'conf_c_001');
  });

  // --- Test B: ACCEPT_REMOTE serialization round-trip ---
  await t.test('Test B: ACCEPT_REMOTE resolution metadata survives transport serialization', async () => {
    const resolutionEvent = {
      event_id: 'evt_res_ar_1',
      device_id: 'dev_d',
      sequence: 5,
      timestamp: new Date().toISOString(),
      collection: 'transactions',
      entity_id: 'txn_res_002',
      operation: 'UPDATE',
      base_checksum: 'h_local_d',
      new_checksum: 'h_remote_c',
      tombstone_generation: 0,
      payload: { id: 'txn_res_002', note: 'ACCEPTED_REMOTE_BRANCH', amount: 25 },
      resolution_type: 'ACCEPT_REMOTE',
      resolved_event_id: 'evt_dev_c_10',
      resolved_conflict_id: 'conf_d_002'
    };

    const pkgPayload = buildDeterministicPackagePayload({
      deviceId: 'dev_d',
      startSequence: 5,
      endSequence: 5,
      baseSnapshotId: APPROVED_BASE_SNAPSHOT_ID,
      baseCloudVersion: APPROVED_BASE_CLOUD_VERSION,
      events: [resolutionEvent]
    });

    const encrypted = await encryptDeltaPackage(pkgPayload, testPin);
    const decrypted = await decryptDeltaPackage(encrypted, testPin);

    assert.equal(decrypted.events[0].resolution_type, 'ACCEPT_REMOTE');
    assert.equal(decrypted.events[0].resolved_event_id, 'evt_dev_c_10');
    assert.equal(decrypted.events[0].resolved_conflict_id, 'conf_d_002');
  });

  // --- Test C: CUSTOM_STATE serialization round-trip ---
  await t.test('Test C: CUSTOM_STATE resolution metadata survives transport serialization', async () => {
    const resolutionEvent = {
      event_id: 'evt_res_cs_1',
      device_id: 'dev_c',
      sequence: 12,
      timestamp: new Date().toISOString(),
      collection: 'transactions',
      entity_id: 'txn_res_003',
      operation: 'UPDATE',
      base_checksum: 'h_local_c',
      new_checksum: 'h_custom_merged',
      tombstone_generation: 0,
      payload: { id: 'txn_res_003', note: 'MERGED_MANUAL_CUSTOM', amount: 50 },
      resolution_type: 'CUSTOM_STATE',
      resolved_event_id: 'evt_dev_d_5',
      resolved_conflict_id: 'conf_c_003'
    };

    const pkgPayload = buildDeterministicPackagePayload({
      deviceId: 'dev_c',
      startSequence: 12,
      endSequence: 12,
      baseSnapshotId: APPROVED_BASE_SNAPSHOT_ID,
      baseCloudVersion: APPROVED_BASE_CLOUD_VERSION,
      events: [resolutionEvent]
    });

    const encrypted = await encryptDeltaPackage(pkgPayload, testPin);
    const decrypted = await decryptDeltaPackage(encrypted, testPin);

    assert.equal(decrypted.events[0].resolution_type, 'CUSTOM_STATE');
    assert.equal(decrypted.events[0].resolved_event_id, 'evt_dev_d_5');
    assert.equal(decrypted.events[0].resolved_conflict_id, 'conf_c_003');
  });

  // --- Test D: Normal INSERT/UPDATE/DELETE events do not have resolution fields ---
  await t.test('Test D: Normal events serialize cleanly without optional resolution fields', async () => {
    const normalEvent = {
      event_id: 'evt_norm_1',
      device_id: 'dev_c',
      sequence: 1,
      timestamp: new Date().toISOString(),
      collection: 'transactions',
      entity_id: 'txn_norm_001',
      operation: 'INSERT',
      base_checksum: null,
      new_checksum: 'h_norm_1',
      tombstone_generation: 0,
      payload: { id: 'txn_norm_001', note: 'Normal Insert', amount: 100 }
    };

    const pkgPayload = buildDeterministicPackagePayload({
      deviceId: 'dev_c',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: APPROVED_BASE_SNAPSHOT_ID,
      baseCloudVersion: APPROVED_BASE_CLOUD_VERSION,
      events: [normalEvent]
    });

    assert.equal('resolution_type' in pkgPayload.events[0], false);
    assert.equal('resolved_event_id' in pkgPayload.events[0], false);
    assert.equal('resolved_conflict_id' in pkgPayload.events[0], false);

    const encrypted = await encryptDeltaPackage(pkgPayload, testPin);
    const decrypted = await decryptDeltaPackage(encrypted, testPin);

    assert.equal('resolution_type' in decrypted.events[0], false);
    assert.equal('resolved_event_id' in decrypted.events[0], false);
    assert.equal('resolved_conflict_id' in decrypted.events[0], false);
  });

  // --- Test E: Deterministic package checksum ---
  await t.test('Test E: Same resolution event produces identical deterministic canonical checksum', async () => {
    const eventA = {
      event_id: 'evt_det_1',
      device_id: 'dev_c',
      sequence: 11,
      timestamp: '2026-10-02T21:00:00.000Z',
      collection: 'transactions',
      entity_id: 'txn_det_001',
      operation: 'UPDATE',
      base_checksum: 'h_d_branch',
      new_checksum: 'h_c_branch',
      tombstone_generation: 0,
      payload: { id: 'txn_det_001', note: 'C_BRANCH', amount: 10 },
      resolution_type: 'KEEP_LOCAL',
      resolved_event_id: 'evt_d_4',
      resolved_conflict_id: 'conf_1'
    };

    const payload1 = buildDeterministicPackagePayload({
      deviceId: 'dev_c',
      startSequence: 11,
      endSequence: 11,
      baseSnapshotId: APPROVED_BASE_SNAPSHOT_ID,
      baseCloudVersion: APPROVED_BASE_CLOUD_VERSION,
      events: [eventA]
    });

    const payload2 = buildDeterministicPackagePayload({
      deviceId: 'dev_c',
      startSequence: 11,
      endSequence: 11,
      baseSnapshotId: APPROVED_BASE_SNAPSHOT_ID,
      baseCloudVersion: APPROVED_BASE_CLOUD_VERSION,
      events: [{ ...eventA }]
    });

    const chk1 = await computePackageChecksum(payload1);
    const chk2 = await computePackageChecksum(payload2);
    assert.equal(chk1, chk2);
  });

  // --- Test F & G: Realistic Peer Resolution Reconciliation & Watermark Progression ---
  await t.test('Test F & G: Device D receives KEEP_LOCAL resolution package, applies APPLY_UPDATE, auto-resolves conflict, and advances watermark', async () => {
    const db = await resetDB();

    // 1. Initial State: Shared base entity
    const baseTxn = { id: 'txn_concurrent_001', note: 'TEST_CONCURRENT_BASE_001', amount: 10 };
    const hBase = await computeCanonicalSha256(baseTxn);

    // Seed on Device D (simulate D has base entity and applied local edit D_BRANCH)
    const dBranchTxn = { id: 'txn_concurrent_001', note: 'TEST_CONCURRENT_EDIT_D_BRANCH', amount: 10 };
    const hD = await computeCanonicalSha256(dBranchTxn);
    await db.run('INSERT INTO transactions (id, note, amount) VALUES (?, ?, ?)', [dBranchTxn.id, dBranchTxn.note, dBranchTxn.amount]);

    const cBranchTxn = { id: 'txn_concurrent_001', note: 'TEST_CONCURRENT_EDIT_C_BRANCH', amount: 10 };
    const hC = await computeCanonicalSha256(cBranchTxn);

    // Initialize peer state for dev_c at sequence 9
    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['dev_c', 9, 9, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    // 2. Stage Peer C Sequence 10 (which created the conflict on D)
    const seq10Event = {
      event_id: 'evt_c_10',
      device_id: 'dev_c',
      sequence: 10,
      timestamp: '2026-10-02T21:10:00.000Z',
      collection: 'transactions',
      entity_id: 'txn_concurrent_001',
      operation: 'UPDATE',
      base_checksum: hBase,
      new_checksum: hC,
      tombstone_generation: 0,
      payload: cBranchTxn
    };

    const pkg10Payload = buildDeterministicPackagePayload({
      deviceId: 'dev_c',
      startSequence: 10,
      endSequence: 10,
      baseSnapshotId: APPROVED_BASE_SNAPSHOT_ID,
      baseCloudVersion: APPROVED_BASE_CLOUD_VERSION,
      events: [seq10Event]
    });

    const pkg10Enc = await encryptDeltaPackage(pkg10Payload, testPin);
    await stagePeerPackageAtomically(pkg10Enc, testPin);

    // Run reconciliation on D for seq 10 -> Produces CONFLICT
    const rec10 = await reconcileStagedEvents({ peerDeviceId: 'dev_c' });
    assert.equal(rec10.conflictCount, 1);

    const pendingConfsBefore = await getPendingConflicts();
    assert.equal(pendingConfsBefore.length, 1);
    assert.equal(pendingConfsBefore[0].entity_id, 'txn_concurrent_001');
    assert.equal(pendingConfsBefore[0].status, CONFLICT_STATUS.PENDING);

    // D's local transaction is still D_BRANCH
    const currentTxnD = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_concurrent_001'])).values[0];
    assert.equal(currentTxnD.note, 'TEST_CONCURRENT_EDIT_D_BRANCH');

    // 3. Now Device C creates KEEP_LOCAL resolution at Sequence 11 and uploads package
    const seq11Event = {
      event_id: 'evt_c_11_res',
      device_id: 'dev_c',
      sequence: 11,
      timestamp: '2026-10-02T21:20:00.000Z',
      collection: 'transactions',
      entity_id: 'txn_concurrent_001',
      operation: 'UPDATE',
      base_checksum: hD, // Target base on D being overridden
      new_checksum: hC,
      tombstone_generation: 0,
      payload: cBranchTxn,
      resolution_type: 'KEEP_LOCAL',
      resolved_event_id: 'evt_c_10',
      resolved_conflict_id: pendingConfsBefore[0].conflict_id
    };

    const pkg11Payload = buildDeterministicPackagePayload({
      deviceId: 'dev_c',
      startSequence: 11,
      endSequence: 11,
      baseSnapshotId: APPROVED_BASE_SNAPSHOT_ID,
      baseCloudVersion: APPROVED_BASE_CLOUD_VERSION,
      events: [seq11Event]
    });

    const pkg11Enc = await encryptDeltaPackage(pkg11Payload, testPin);
    await stagePeerPackageAtomically(pkg11Enc, testPin);

    // 4. Device D reconciles staged packages
    const rec11 = await reconcileStagedEvents({ peerDeviceId: 'dev_c' });
    assert.equal(rec11.reconciledCount, 1, 'Resolution event must reconcile cleanly');

    const s11 = (await db.query('SELECT status FROM sync_staged_events WHERE event_id = ?', ['evt_c_11_res'])).values[0];
    assert.equal(s11.status, RECONCILIATION_STATUS.RECONCILED_CLEAN, 'Resolution event must be RECONCILED_CLEAN');

    const s10 = (await db.query('SELECT status FROM sync_staged_events WHERE event_id = ?', ['evt_c_10'])).values[0];
    assert.equal(s10.status, RECONCILIATION_STATUS.RECONCILED_SUPERSEDED, 'Preceding conflict event must be RECONCILED_SUPERSEDED');

    // 5. Verify D adopted C branch
    const updatedTxnD = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_concurrent_001'])).values[0];
    assert.equal(updatedTxnD.note, 'TEST_CONCURRENT_EDIT_C_BRANCH');

    // 6. Verify D's mirrored conflict automatically transitioned to RESOLVED
    const pendingConfsAfter = await getPendingConflicts();
    assert.equal(pendingConfsAfter.length, 0, 'No pending conflicts should remain for this entity');

    const resolvedConf = await getConflict(pendingConfsBefore[0].conflict_id);
    assert.equal(resolvedConf.status, CONFLICT_STATUS.RESOLVED);
    assert.equal(resolvedConf.resolution, 'KEEP_LOCAL');

    // 7. Verify D's peer watermark advanced to 11
    const peerState = (await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', ['dev_c'])).values[0];
    assert.equal(peerState.last_reconciled_sequence, 11, 'Watermark must advance through seq 11');
  });

  // --- Test H: Idempotency upon replay ---
  await t.test('Test H: Replay of already-reconciled resolution package is idempotent NOOP', async () => {
    const db = await resetDB();

    const cBranchTxn = { id: 'txn_concurrent_002', note: 'TEST_CONCURRENT_EDIT_C_BRANCH', amount: 10 };
    const hC = await computeCanonicalSha256(cBranchTxn);

    // Entity already at C branch locally
    await db.run('INSERT INTO transactions (id, note, amount) VALUES (?, ?, ?)', [cBranchTxn.id, cBranchTxn.note, cBranchTxn.amount]);

    const seq1Event = {
      event_id: 'evt_c_replay_1',
      device_id: 'dev_c',
      sequence: 1,
      timestamp: '2026-10-02T21:20:00.000Z',
      collection: 'transactions',
      entity_id: 'txn_concurrent_002',
      operation: 'UPDATE',
      base_checksum: 'h_prior_d',
      new_checksum: hC,
      tombstone_generation: 0,
      payload: cBranchTxn,
      resolution_type: 'KEEP_LOCAL',
      resolved_event_id: 'evt_old_1'
    };

    const pkgPayload = buildDeterministicPackagePayload({
      deviceId: 'dev_c',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: APPROVED_BASE_SNAPSHOT_ID,
      baseCloudVersion: APPROVED_BASE_CLOUD_VERSION,
      events: [seq1Event]
    });

    const enc = await encryptDeltaPackage(pkgPayload, testPin);
    await stagePeerPackageAtomically(enc, testPin);

    const rec = await reconcileStagedEvents({ peerDeviceId: 'dev_c' });
    assert.equal(rec.idempotentCount, 1, 'Replay of resolution event when local matches remote must be IDEMPOTENT NOOP');

    const tx = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_concurrent_002'])).values[0];
    assert.equal(tx.note, 'TEST_CONCURRENT_EDIT_C_BRANCH');
  });

  // --- Test I & J: Existing Conflict Isolation ---
  await t.test('Test I & J: Resolving one conflict leaves unrelated fixture conflicts untouched', async () => {
    const db = await resetDB();

    // Seed 2 fixture conflicts
    await saveConflictRecord({
      conflict_id: 'conf_fixture_001',
      collection: 'transactions',
      entity_id: 'txn_fixture_001',
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_peer_x',
      event_id: 'evt_fix_1',
      status: CONFLICT_STATUS.PENDING
    });

    await saveConflictRecord({
      conflict_id: 'conf_fixture_002',
      collection: 'transactions',
      entity_id: 'txn_fixture_002',
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_peer_y',
      event_id: 'evt_fix_2',
      status: CONFLICT_STATUS.PENDING
    });

    // Seed test conflict to be resolved
    const testEntity = { id: 'txn_test_isolate', note: 'Local Test', amount: 50 };
    const hTest = await computeCanonicalSha256(testEntity);
    await db.run('INSERT INTO transactions (id, note, amount) VALUES (?, ?, ?)', [testEntity.id, testEntity.note, testEntity.amount]);

    await saveConflictRecord({
      conflict_id: 'conf_test_isolate',
      collection: 'transactions',
      entity_id: 'txn_test_isolate',
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_c',
      event_id: 'evt_test_1',
      local_checksum: hTest,
      remote_checksum: 'h_remote_test',
      status: CONFLICT_STATUS.PENDING
    });

    const pendingInitial = await getPendingConflicts();
    assert.equal(pendingInitial.length, 3);

    // Resolve only the test conflict
    await resolveConflict('conf_test_isolate', CONFLICT_RESOLUTION.KEEP_LOCAL);

    const pendingAfter = await getPendingConflicts();
    assert.equal(pendingAfter.length, 2, 'Exactly the 2 fixture conflicts must remain PENDING');

    const f1 = await getConflict('conf_fixture_001');
    const f2 = await getConflict('conf_fixture_002');
    assert.equal(f1.status, CONFLICT_STATUS.PENDING);
    assert.equal(f2.status, CONFLICT_STATUS.PENDING);
  });
});
