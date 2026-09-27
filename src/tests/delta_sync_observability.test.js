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
  SYNC_STATUS
} from '../services/deltaSyncCoordinator.js';

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
});
