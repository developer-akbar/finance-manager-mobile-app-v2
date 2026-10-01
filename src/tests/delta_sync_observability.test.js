/**
 * delta_sync_observability.test.js — Phase 7.5 Delta Sync UI Observability & Metrics Test Suite
 * 
 * Verifies:
 * 1. Pending queue count is accurately computed and exposed
 * 2. Successful delta sync displays Synced status with 0 pending
 * 3. Last delta sync timestamp updates independently without overwriting legacy last_synced_at
 * 4. Uploaded and acknowledged sequences are correctly reported from sync_local_state
 * 5. subscribeSyncStatus broadcasts live transitions (SYNCING -> SUCCESS / AUTH_REQUIRED / ERROR)
 * 6. Legacy snapshot metadata (last_synced_at, last_snapshot_id) remains undisturbed
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, getDB, closeDB } from '../database/db.js';
import { getSetting, setSetting } from '../database/settings.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import {
  getDeltaSyncMetrics,
  subscribeSyncStatus,
  broadcastSyncStatus,
  executeFullSyncPass,
  SYNC_STATUS,
  resolveConflict
} from '../services/deltaSyncCoordinator.js';
import {
  saveConflictRecord,
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
  return await initDB();
}

function createMockDriveClient() {
  const store = new Map();
  return {
    uploadAppDataFile: async (name, content) => {
      const fileId = `drive_file_${name}`;
      store.set(name, { id: fileId, name, content });
      return { id: fileId, name };
    },
    readAppDataFile: async (fileId) => {
      for (const f of store.values()) {
        if (f.id === fileId) return f.content;
      }
      throw new Error(`File not found: ${fileId}`);
    },
    findAppDataFile: async (name) => {
      return store.get(name) || null;
    }
  };
}

test('FinMan Phase 7.5 — Delta Sync Observability & Metrics Suite', async (t) => {
  await t.test('O01: Pending queue count accurately queries sync_delta_queue', async () => {
    const db = await resetDB();

    // 1. Initial state has 0 pending
    let metrics = await getDeltaSyncMetrics();
    assert.equal(metrics.pendingCount, 0);

    // 2. Insert 3 pending deltas
    for (let i = 1; i <= 3; i++) {
      const t = { id: `txn_o01_${i}`, inr: i * 100 };
      const h = await computeCanonicalSha256(t);
      await db.run(
        'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`evt_o01_${i}`, 'dev_o01', i, new Date().toISOString(), 'transactions', t.id, 'INSERT', h, JSON.stringify(t), 'PENDING']
      );
    }

    metrics = await getDeltaSyncMetrics();
    assert.equal(metrics.pendingCount, 3);

    // 3. Mark 2 deltas as ACKNOWLEDGED
    await db.run('UPDATE sync_delta_queue SET status = ? WHERE sequence <= ?', ['ACKNOWLEDGED', 2]);
    metrics = await getDeltaSyncMetrics();
    assert.equal(metrics.pendingCount, 1);
  });

  await t.test('O02: Successful delta sync records last_delta_synced_at without altering legacy last_synced_at', async () => {
    const db = await resetDB();
    const driveClient = createMockDriveClient();
    const deviceId = 'dev_o02';

    // Set legacy snapshot metadata
    const legacyTime = '2026-09-27T13:12:43.000Z';
    const legacySnapId = 'snap_1790493064581_jbhnf8';
    await setSetting('last_synced_at', legacyTime);
    await setSetting('last_snapshot_id', legacySnapId);

    // Seed 1 pending delta
    const txn = { id: 'txn_o02_delta', inr: 450 };
    const h = await computeCanonicalSha256(txn);
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, new_checksum, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_o02_1', deviceId, 1, new Date().toISOString(), 'transactions', txn.id, 'INSERT', h, JSON.stringify(txn), 'PENDING']
    );

    // Execute full sync pass
    const res = await executeFullSyncPass({
      deviceId,
      driveClient,
      sessionKey: 'test_session_key',
      accessToken: 'valid_token'
    });

    assert.equal(res.success, true);

    // Verify delta metrics updated
    const metrics = await getDeltaSyncMetrics();
    assert.equal(metrics.pendingCount, 0);
    assert.ok(metrics.lastDeltaSyncedAt);
    assert.notEqual(metrics.lastDeltaSyncedAt, legacyTime);

    // Verify legacy settings remain strictly preserved
    const currentLegacyAt = await getSetting('last_synced_at');
    const currentLegacySnap = await getSetting('last_snapshot_id');
    assert.equal(currentLegacyAt, legacyTime);
    assert.equal(currentLegacySnap, legacySnapId);
  });

  await t.test('O03: Uploaded and acknowledged sequence watermarks are correctly reflected from sync_local_state', async () => {
    const db = await resetDB();

    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, last_allocated_sequence, last_uploaded_sequence, last_acked_sequence, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['device_state', 'dev_o03_watermarks', 10, 8, 8, new Date().toISOString()]
    );

    const metrics = await getDeltaSyncMetrics();
    assert.equal(metrics.deviceId, 'dev_o03_watermarks');
    assert.equal(metrics.lastAllocatedSequence, 10);
    assert.equal(metrics.lastUploadedSequence, 8);
    assert.equal(metrics.lastAckedSequence, 8);
  });

  await t.test('O04: subscribeSyncStatus receives live broadcast updates for status transitions', async () => {
    let lastReceivedStatus = null;
    let lastReceivedDetails = null;

    const unsubscribe = subscribeSyncStatus((status, details) => {
      lastReceivedStatus = status;
      lastReceivedDetails = details;
    });

    // 1. Broadcast SYNCING
    broadcastSyncStatus(SYNC_STATUS.SYNCING, { trigger: 'FOREGROUND' });
    assert.equal(lastReceivedStatus, SYNC_STATUS.SYNCING);
    assert.equal(lastReceivedDetails.trigger, 'FOREGROUND');

    // 2. Broadcast AUTH_REQUIRED
    broadcastSyncStatus(SYNC_STATUS.AUTH_REQUIRED, { reason: 'No Google Drive credentials' });
    assert.equal(lastReceivedStatus, SYNC_STATUS.AUTH_REQUIRED);
    assert.equal(lastReceivedDetails.reason, 'No Google Drive credentials');

    // 3. Broadcast SUCCESS
    broadcastSyncStatus(SYNC_STATUS.SUCCESS, { eventsUploaded: 3 });
    assert.equal(lastReceivedStatus, SYNC_STATUS.SUCCESS);
    assert.equal(lastReceivedDetails.eventsUploaded, 3);

    unsubscribe();
  });

  await t.test('O05: Pending conflicts query accurately retrieves unresolved CONCURRENT_EDIT records', async () => {
    const db = await resetDB();

    // 1. Initial state has 0 conflicts
    let conflicts = await getPendingConflicts();
    assert.equal(conflicts.length, 0);

    // 2. Insert 1 PENDING conflict
    await saveConflictRecord({
      conflict_id: 'conf_o05_1',
      collection: 'transactions',
      entity_id: 'txn_o05_1',
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_d',
      event_id: 'evt_d_1',
      base_checksum: 'base_h',
      local_checksum: 'local_h',
      remote_checksum: 'remote_h',
      local_payload: { id: 'txn_o05_1', note: 'Conflict Test — Device C Version' },
      remote_payload: { id: 'txn_o05_1', note: 'Conflict Test — Device D Version' },
      status: CONFLICT_STATUS.PENDING
    });

    conflicts = await getPendingConflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].conflict_id, 'conf_o05_1');
    assert.equal(conflicts[0].conflict_type, 'CONCURRENT_EDIT');
    assert.equal(conflicts[0].local_payload.note, 'Conflict Test — Device C Version');
    assert.equal(conflicts[0].remote_payload.note, 'Conflict Test — Device D Version');
  });

  await t.test('O06: resolveConflict KEEP_LOCAL resolves conflict, preserves local entity, queues outbound delta', async () => {
    const db = await resetDB();

    const localTxn = { id: 'txn_o06_1', note: 'Conflict Test — Device C Version', inr: 100 };
    const localChecksum = await computeCanonicalSha256(localTxn);
    await db.run(
      'INSERT INTO transactions (id, note, inr) VALUES (?, ?, ?)',
      [localTxn.id, localTxn.note, localTxn.inr]
    );

    const confId = 'conf_o06_1';
    await saveConflictRecord({
      conflict_id: confId,
      collection: 'transactions',
      entity_id: localTxn.id,
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_d',
      event_id: 'evt_d_o06',
      base_checksum: 'base_h_o06',
      local_checksum: localChecksum,
      remote_checksum: 'remote_h_o06',
      local_payload: localTxn,
      remote_payload: { id: localTxn.id, note: 'Conflict Test — Device D Version', inr: 100 },
      status: CONFLICT_STATUS.PENDING
    });

    // Resolve as KEEP_LOCAL
    await resolveConflict(confId, CONFLICT_RESOLUTION.KEEP_LOCAL);

    // 1. Conflict status is now RESOLVED
    const remaining = await getPendingConflicts();
    assert.equal(remaining.length, 0);

    // 2. Local transaction unchanged
    const currentTxn = (await db.query('SELECT * FROM transactions WHERE id = ?', [localTxn.id])).values[0];
    assert.equal(currentTxn.note, 'Conflict Test — Device C Version');

    // 3. Outbound delta queue contains resolution delta
    const queueRows = (await db.query('SELECT * FROM sync_delta_queue WHERE resolved_conflict_id = ?', [confId])).values;
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].resolution_type, 'KEEP_LOCAL');
    assert.equal(queueRows[0].status, 'PENDING');
  });

  await t.test('O07: resolveConflict ACCEPT_REMOTE resolves conflict, updates local entity, queues outbound delta', async () => {
    const db = await resetDB();

    const localTxn = { id: 'txn_o07_1', note: 'Conflict Test — Device C Version', inr: 100 };
    const remoteTxn = { id: 'txn_o07_1', note: 'Conflict Test — Device D Version', inr: 100 };
    const localChecksum = await computeCanonicalSha256(localTxn);
    const remoteChecksum = await computeCanonicalSha256(remoteTxn);

    await db.run(
      'INSERT INTO transactions (id, note, inr) VALUES (?, ?, ?)',
      [localTxn.id, localTxn.note, localTxn.inr]
    );

    const confId = 'conf_o07_1';
    await saveConflictRecord({
      conflict_id: confId,
      collection: 'transactions',
      entity_id: localTxn.id,
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_d',
      event_id: 'evt_d_o07',
      base_checksum: 'base_h_o07',
      local_checksum: localChecksum,
      remote_checksum: remoteChecksum,
      local_payload: localTxn,
      remote_payload: remoteTxn,
      status: CONFLICT_STATUS.PENDING
    });

    // Resolve as ACCEPT_REMOTE
    await resolveConflict(confId, CONFLICT_RESOLUTION.ACCEPT_REMOTE);

    // 1. Conflict status is now RESOLVED
    const remaining = await getPendingConflicts();
    assert.equal(remaining.length, 0);

    // 2. Local transaction updated to remote version
    const currentTxn = (await db.query('SELECT * FROM transactions WHERE id = ?', [localTxn.id])).values[0];
    assert.equal(currentTxn.note, 'Conflict Test — Device D Version');

    // 3. Outbound delta queue contains resolution delta
    const queueRows = (await db.query('SELECT * FROM sync_delta_queue WHERE resolved_conflict_id = ?', [confId])).values;
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].resolution_type, 'ACCEPT_REMOTE');
  });

  await t.test('O08: Stale precondition check rejects resolution if entity was modified after conflict logged', async () => {
    const db = await resetDB();

    const initialTxn = { id: 'txn_o08_1', note: 'Original Local Note', inr: 100 };
    const initialChecksum = await computeCanonicalSha256(initialTxn);

    await db.run(
      'INSERT INTO transactions (id, note, inr) VALUES (?, ?, ?)',
      [initialTxn.id, initialTxn.note, initialTxn.inr]
    );

    const confId = 'conf_o08_1';
    await saveConflictRecord({
      conflict_id: confId,
      collection: 'transactions',
      entity_id: initialTxn.id,
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_d',
      event_id: 'evt_d_o08',
      base_checksum: 'base_h_o08',
      local_checksum: initialChecksum,
      remote_checksum: 'remote_h_o08',
      local_payload: initialTxn,
      remote_payload: { id: initialTxn.id, note: 'Remote Note', inr: 100 },
      status: CONFLICT_STATUS.PENDING
    });

    // Local entity is modified unexpectedly before user resolves conflict
    await db.run('UPDATE transactions SET note = ? WHERE id = ?', ['Intervening Edit', initialTxn.id]);

    // Attempting resolution must fail closed with STALE_CONFLICT_ERROR
    await assert.rejects(
      async () => await resolveConflict(confId, CONFLICT_RESOLUTION.KEEP_LOCAL),
      /STALE_CONFLICT_ERROR/
    );

    // Conflict remains PENDING without side effects
    const pending = await getPendingConflicts();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'PENDING');
  });
});
