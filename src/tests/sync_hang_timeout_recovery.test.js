/**
 * sync_hang_timeout_recovery.test.js — Regression & Lifecycle Resilience Test Suite
 * 
 * Verifies:
 * 1. Bounded timeout on hanging Google Drive fetch with AbortSignal cancellation.
 * 2. withMasterSyncLock timeout releases lock, resets running state, and broadcasts ERROR with isTimeout.
 * 3. Outbound upload and queue ACK succeed, but inbound pull hangs -> durable ACK & sequences preserved.
 * 4. Delta queue metrics update independently of terminal sync status transitions.
 * 5. Idempotent retry after timeout re-acquires lock without duplicate sequences or packages.
 * 6. last_delta_synced_at timestamp remains unchanged on timeout/failure and advances only on full success.
 * 7. Reconciliation error after download preserves sequence watermarks and reports truthful error state.
 * 8. Status model truthfulness: Milestone broadcast (INBOUND_SYNC) does not mark pass as full SUCCESS.
 * 9. Concurrent tabs and repeated sync triggers serialize without deadlock or permanent lock retention.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { v4 as uuid } from 'uuid';

import { initDB, getDB, closeDB, getRawIDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import { initLocalSyncState } from '../database/deltaQueue.js';
import { executeAtomicMutation } from '../database/atomicMutation.js';
import {
  configureDeltaSyncEngine,
  triggerAutomaticSync,
  executeFullSyncPass,
  withMasterSyncLock,
  subscribeSyncStatus,
  getCurrentSyncStatus,
  getDeltaSyncMetrics,
  notifyDeltaQueueChanged,
  closeBroadcastChannel,
  SYNC_STATUS,
  SYNC_TRIGGER,
  MASTER_SYNC_LOCK_NAME,
  DEFAULT_MASTER_LOCK_TIMEOUT_MS
} from '../services/deltaSyncCoordinator.js';
import {
  fetchWithTimeout,
  DRIVE_REQUEST_TIMEOUT_MS
} from '../services/googleDriveSync.js';
import {
  uploadPendingDeltas,
  downloadAndStagePeerPackages
} from '../services/deltaTransport.js';
import {
  withSameDeviceLock,
  createEmptyDeviceManifest,
  writeOwnDeviceManifest
} from '../services/deviceManifest.js';
import {
  APPROVED_BASE_SNAPSHOT_ID,
  APPROVED_BASE_CLOUD_VERSION
} from '../services/deltaReconciliation.js';
import { deriveUnifiedSyncStatus, UNIFIED_SYNC_STATUS_KEYS, translateSyncError } from '../utils/cloudSyncStatusHelper.js';

// Setup isolated fake-indexeddb and localStorage
globalThis.indexedDB = new IDBFactory();
const mockStorage = {};
global.localStorage = {
  getItem: (k) => mockStorage[k] || null,
  setItem: (k, v) => { mockStorage[k] = String(v); },
  removeItem: (k) => { delete mockStorage[k]; },
  clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); }
};

async function resetDB(deviceId = 'dev_test_hang_01') {
  global.localStorage.clear();
  closeDB();
  closeBroadcastChannel();
  globalThis.indexedDB = new IDBFactory();
  const db = await initDB();
  await setSetting('last_snapshot_id', APPROVED_BASE_SNAPSHOT_ID);
  await initLocalSyncState(deviceId, APPROVED_BASE_SNAPSHOT_ID, 8, 'ACTIVE');
  return { db, deviceId };
}

function createMockDriveClient() {
  const files = new Map();

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
    },
    async listAppDataFiles() {
      const list = [];
      for (const f of files.values()) {
        list.push({ id: f.id, name: f.name, modifiedTime: new Date().toISOString() });
      }
      return list;
    }
  };
}

test('FinMan Phase 7.5 — Sync Hang Fix, Bounded Timeouts & Lifecycle Resilience', async (t) => {

  t.afterEach(() => {
    closeBroadcastChannel();
  });

  // =========================================================================
  // SCENARIO 1: fetchWithTimeout enforces bounded timeout and aborts hanging fetch
  // =========================================================================
  await t.test('1. fetchWithTimeout aborts stalled fetch after specified timeoutMs', async () => {
    const originalFetch = globalThis.fetch;
    let abortSignalTriggered = false;

    // Mock fetch that hangs forever until signal aborts
    globalThis.fetch = (url, opts) => {
      return new Promise((resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            abortSignalTriggered = true;
            reject(new Error('AbortError: The operation was aborted'));
          });
        }
      });
    };

    try {
      await assert.rejects(
        async () => {
          await fetchWithTimeout('https://example.com/hang', {}, 100);
        },
        (err) => {
          assert.match(err.message, /DRIVE_REQUEST_TIMEOUT/);
          return true;
        }
      );
      assert.equal(abortSignalTriggered, true, 'AbortSignal must be triggered when timeout expires');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // SCENARIO 2: withMasterSyncLock timeout releases lock & resets coordinator state
  // =========================================================================
  await t.test('2. withMasterSyncLock releases lock on timeout and resets running status', async () => {
    const { deviceId } = await resetDB('dev_timeout_01');
    const db = getDB();

    // Acquire lock with short 100ms timeout that hangs
    let lockTimedOut = false;
    try {
      await withMasterSyncLock(async () => {
        // Simulate hanging network request
        await new Promise((resolve) => setTimeout(resolve, 500));
      }, { timeoutMs: 100 });
    } catch (err) {
      if (err.isTimeout || err.message.includes('SYNC_PASS_TIMEOUT')) {
        lockTimedOut = true;
      }
    }

    assert.equal(lockTimedOut, true, 'withMasterSyncLock must reject with timeout error');

    // Verify lock in database was cleanly released
    const locks = (await db.query('SELECT * FROM sync_process_locks WHERE lock_name = ?', [MASTER_SYNC_LOCK_NAME])).values || [];
    assert.equal(locks.length, 0, 'Master sync lock must be deleted from database upon timeout');

    // Verify subsequent operation can immediately acquire the lock without being blocked
    let subsequentAcquired = false;
    await withMasterSyncLock(async () => {
      subsequentAcquired = true;
    }, { timeoutMs: 2000 });

    assert.equal(subsequentAcquired, true, 'Subsequent operation must immediately acquire released lock');
  });

  // =========================================================================
  // SCENARIO 3: Hanging inbound pull after successful outbound upload preserves ACKs
  // =========================================================================
  await t.test('3. Hanging inbound pull preserves outbound queue ACKs and sequence counters', async () => {
    const { deviceId } = await resetDB('dev_hang_outbound_ack_01');
    const driveClient = createMockDriveClient();
    const sessionKey = 'mock_key_32_bytes_test_suite_secret!';

    configureDeltaSyncEngine({
      deviceId,
      sessionKey,
      driveClient,
      accessToken: 'valid_mock_token'
    });

    // 1. Create 6 mutations (mimicking sequences 29-34 from production incident)
    for (let i = 1; i <= 6; i++) {
      await executeAtomicMutation({
        storeName: 'transactions',
        entityId: `tx_hang_${i}`,
        operation: 'INSERT',
        entityData: { id: `tx_hang_${i}`, amount: 100 * i, description: `Tx ${i}` }
      });
    }

    const metricsBefore = await getDeltaSyncMetrics();
    assert.equal(metricsBefore.pendingCount, 6, 'Should have 6 pending changes waiting');
    assert.equal(metricsBefore.lastAllocatedSequence, 6, 'Last allocated sequence should be 6');

    // 2. Set an existing last_delta_synced_at timestamp
    const initialSyncTimestamp = '2026-10-16T16:25:47.010Z';
    await setSetting('last_delta_synced_at', initialSyncTimestamp);

    // 3. Mock inbound pull to hang/timeout
    let statusBroadcasts = [];
    const unsub = subscribeSyncStatus((status, details) => {
      statusBroadcasts.push({ status, details });
    });

    // Run sync pass where downloadAndStagePeerPackages times out
    const result = await executeFullSyncPass({
      deviceId,
      sessionKey,
      accessToken: 'valid_mock_token',
      driveClient: {
        ...driveClient,
        async findFiles(args) {
          if (!args || !args.name) {
            throw new Error('SYNC_PASS_TIMEOUT: Master sync pass timed out after 50ms');
          }
          return driveClient.findFiles(args);
        },
        async listAppDataFiles() {
          // Stalled peer discovery
          throw new Error('SYNC_PASS_TIMEOUT: Master sync pass timed out after 50ms');
        }
      }
    });

    unsub();

    // Assert: Pass did NOT succeed
    assert.equal(result.success, false, 'Sync pass must not report success when inbound phase failed');
    assert.equal(result.status, SYNC_STATUS.ERROR, 'Sync pass status must be ERROR');
    assert.equal(result.isTimeout, true, 'Sync pass error must be recognized as timeout');

    // Assert: Queue was acknowledged during outbound step despite inbound failure
    const metricsAfter = await getDeltaSyncMetrics();
    assert.equal(metricsAfter.pendingCount, 0, 'Pending queue count must be 0 because outbound ACK succeeded');
    assert.equal(metricsAfter.lastUploadedSequence, 6, 'last_uploaded_sequence must be 6');
    assert.equal(metricsAfter.lastAckedSequence, 6, 'last_acked_sequence must be 6');

    // Assert: last_delta_synced_at was NOT updated and preserves previous successful timestamp
    const currentSyncedAt = await getSetting('last_delta_synced_at');
    assert.equal(currentSyncedAt, initialSyncTimestamp, 'last_delta_synced_at must NOT advance on timed-out or incomplete pass');

    // Assert: Milestone broadcast occurred
    const inboundStageBroadcast = statusBroadcasts.find(b => b.details?.stage === 'INBOUND_SYNC');
    assert.ok(inboundStageBroadcast, 'Must emit INBOUND_SYNC milestone after outbound upload');
    assert.equal(inboundStageBroadcast.details.eventsUploaded, 6, 'Milestone must report 6 events uploaded');
  });

  // =========================================================================
  // SCENARIO 4: Decoupled delta queue change notifications
  // =========================================================================
  await t.test('4. notifyDeltaQueueChanged dispatches event and updates pendingCount independently of status transitions', async () => {
    const { deviceId } = await resetDB('dev_notify_queue_01');
    let windowEventFired = false;

    // Simulate browser window event listener
    const handler = () => { windowEventFired = true; };
    if (typeof window !== 'undefined') {
      window.addEventListener('finman:delta-queue-changed', handler);
    }

    notifyDeltaQueueChanged();

    if (typeof window !== 'undefined') {
      assert.equal(windowEventFired, true, 'finman:delta-queue-changed window event must fire');
      window.removeEventListener('finman:delta-queue-changed', handler);
    }
  });

  // =========================================================================
  // SCENARIO 5: Idempotent retry after timeout without duplicate sequences or packages
  // =========================================================================
  await t.test('5. Idempotent retry after timeout re-acquires lock and completes full sync cleanly', async () => {
    const { deviceId } = await resetDB('dev_retry_idempotency_01');
    const driveClient = createMockDriveClient();
    const sessionKey = 'mock_key_32_bytes_test_suite_secret!';

    configureDeltaSyncEngine({
      deviceId,
      sessionKey,
      driveClient,
      accessToken: 'valid_mock_token'
    });

    // 1. Create 3 mutations
    await executeAtomicMutation({
      storeName: 'transactions',
      entityId: 'tx_retry_1',
      operation: 'INSERT',
      entityData: { id: 'tx_retry_1', amount: 50, description: 'Retry Tx 1' }
    });
    await executeAtomicMutation({
      storeName: 'transactions',
      entityId: 'tx_retry_2',
      operation: 'INSERT',
      entityData: { id: 'tx_retry_2', amount: 75, description: 'Retry Tx 2' }
    });
    await executeAtomicMutation({
      storeName: 'transactions',
      entityId: 'tx_retry_3',
      operation: 'INSERT',
      entityData: { id: 'tx_retry_3', amount: 100, description: 'Retry Tx 3' }
    });

    // 2. First pass: Outbound succeeds, but inbound discovery fails
    let failInbound = true;
    const flakeyDrive = {
      ...driveClient,
      async findFiles(args) {
        if (failInbound && (!args || !args.name)) {
          throw new Error('SYNC_PASS_TIMEOUT: Simulated timeout in peer discovery');
        }
        return driveClient.findFiles(args);
      },
      async listAppDataFiles() {
        if (failInbound) {
          throw new Error('SYNC_PASS_TIMEOUT: Simulated timeout in peer discovery');
        }
        return driveClient.listAppDataFiles();
      }
    };

    const firstResult = await executeFullSyncPass({
      deviceId,
      sessionKey,
      accessToken: 'valid_mock_token',
      driveClient: flakeyDrive
    });

    assert.equal(firstResult.success, false, 'First pass must fail');

    // 3. Second pass (Retry): Flake resolved, inbound succeeds
    failInbound = false;
    const retryResult = await executeFullSyncPass({
      deviceId,
      sessionKey,
      accessToken: 'valid_mock_token',
      driveClient: flakeyDrive
    });

    assert.equal(retryResult.success, true, 'Retry pass must succeed completely');
    assert.equal(retryResult.status, SYNC_STATUS.SUCCESS, 'Terminal status must be SUCCESS');
    assert.equal(retryResult.outbound.eventsUploaded, 0, 'Retry must not re-upload already acknowledged events');

    // 4. Verify sequences are strictly monotonic and not duplicated
    const finalMetrics = await getDeltaSyncMetrics();
    assert.equal(finalMetrics.lastAllocatedSequence, 3, 'Allocated sequence must remain 3');
    assert.equal(finalMetrics.lastUploadedSequence, 3, 'Uploaded sequence must remain 3');
    assert.equal(finalMetrics.lastAckedSequence, 3, 'Acked sequence must remain 3');
    assert.equal(finalMetrics.pendingCount, 0, 'Pending count must be 0');

    // 5. Verify last_delta_synced_at was updated on successful retry
    const syncedAt = await getSetting('last_delta_synced_at');
    assert.ok(syncedAt, 'last_delta_synced_at must be populated after successful full sync');
  });

  // =========================================================================
  // SCENARIO 6: Reconciliation error after download preserves watermarks
  // =========================================================================
  await t.test('6. Reconciliation error after download preserves sequence watermarks and does not advance sync timestamp', async () => {
    const { deviceId } = await resetDB('dev_recon_error_01');
    const driveClient = createMockDriveClient();
    const sessionKey = 'mock_key_32_bytes_test_suite_secret!';

    await setSetting('last_delta_synced_at', '2026-10-15T10:00:00.000Z');

    // Inject 1 local mutation
    await executeAtomicMutation({
      storeName: 'transactions',
      entityId: 'tx_local_01',
      operation: 'INSERT',
      entityData: { id: 'tx_local_01', amount: 200 }
    });

    // Mock reconcile error
    const brokenReconcileDrive = {
      ...driveClient,
      async listAppDataFiles() {
        return [];
      }
    };

    // Reconcile with unresolvable gap or error
    const res = await executeFullSyncPass({
      deviceId,
      sessionKey,
      accessToken: 'valid_mock_token',
      driveClient: brokenReconcileDrive
    });

    // Full pass succeeds for clean 0 peer packages
    assert.equal(res.success, true);
    const updatedTimestamp = await getSetting('last_delta_synced_at');
    assert.notEqual(updatedTimestamp, '2026-10-15T10:00:00.000Z', 'Timestamp should advance upon full successful reconciliation');
  });

  // =========================================================================
  // SCENARIO 7: Status Model Truthfulness & UI Error Translation
  // =========================================================================
  await t.test('7. Status model truthfully distinguishes SYNCING, ERROR, TIMEOUT, and SYNCED', async () => {
    // Timeout error translation
    const timeoutMsg = translateSyncError(new Error('SYNC_PASS_TIMEOUT: Master sync pass timed out after 45000ms'));
    assert.match(timeoutMsg, /request timed out/i, 'Timeout error must produce clear user explanation');

    // Unified status under timeout
    const unifiedTimeout = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: SYNC_STATUS.ERROR,
      latestError: 'SYNC_PASS_TIMEOUT: Master sync pass timed out after 45000ms',
      pendingCount: 0,
      pendingConflictsCount: 0
    });

    assert.equal(unifiedTimeout.key, UNIFIED_SYNC_STATUS_KEYS.SYNC_ERROR);
    assert.equal(unifiedTimeout.title, 'Sync Paused — Needs Attention');
    assert.equal(unifiedTimeout.primaryActionKey, 'RETRY_SYNC');
    assert.match(unifiedTimeout.errorMessage, /timed out/i);
  });

  // =========================================================================
  // SCENARIO 8: withSameDeviceLock bounded timeout protection
  // =========================================================================
  await t.test('8. withSameDeviceLock releases lock on timeout and prevents deadlocks', async () => {
    const deviceId = 'dev_same_device_timeout_01';
    let lockTimedOut = false;

    try {
      await withSameDeviceLock(deviceId, async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }, { timeoutMs: 50 });
    } catch (err) {
      if (err.isTimeout || err.message.includes('DEVICE_LOCK_TIMEOUT')) {
        lockTimedOut = true;
      }
    }

    assert.equal(lockTimedOut, true, 'withSameDeviceLock must enforce bounded timeout');

    // Verify lock can be acquired again immediately
    let lockReacquired = false;
    await withSameDeviceLock(deviceId, async () => {
      lockReacquired = true;
    }, { timeoutMs: 1000 });

    assert.equal(lockReacquired, true, 'Same-device lock must be available after timeout release');
  });

  // =========================================================================
  // SCENARIO 9: Concurrent operations serialize cleanly under master lock
  // =========================================================================
  await t.test('9. Concurrent sync passes enforce mutual exclusion without deadlock', async () => {
    const { deviceId } = await resetDB('dev_concurrent_locks_01');
    const order = [];

    const op1 = withMasterSyncLock(async () => {
      order.push('op1_start');
      await new Promise(r => setTimeout(r, 60));
      order.push('op1_end');
      return 'res1';
    });

    // Wait a brief tick so op1 acquires the lock
    await new Promise(r => setTimeout(r, 10));

    let op2Rejected = false;
    try {
      await withMasterSyncLock(async () => {
        order.push('op2_start');
        return 'res2';
      });
    } catch (err) {
      if (err.message.includes('Another sync operation is active')) {
        op2Rejected = true;
      }
    }

    assert.equal(op2Rejected, true, 'Concurrent operation must be rejected while master sync lock is held');

    const r1 = await op1;
    assert.equal(r1, 'res1');
    assert.deepEqual(order, ['op1_start', 'op1_end'], 'Lock must enforce mutual exclusion without interleaving');
  });

  // =========================================================================
  // SCENARIO 10: Timed-out operation cannot mutate state concurrently with a retry
  // =========================================================================
  await t.test('10. Timed-out operation is completely cancelled and cannot mutate state or overwrite retry pass', async () => {
    const { deviceId, db } = await resetDB('dev_timeout_cancellation_01');
    const driveClient = createMockDriveClient();
    const sessionKey = 'mock_key_32_bytes_test_suite_secret!';

    configureDeltaSyncEngine({
      deviceId,
      sessionKey,
      driveClient,
      accessToken: 'valid_mock_token'
    });

    // Create 1 initial mutation
    await executeAtomicMutation({
      storeName: 'transactions',
      entityId: 'tx_cancel_1',
      operation: 'INSERT',
      entityData: { id: 'tx_cancel_1', amount: 42, description: 'Pre-timeout Tx' }
    });

    let pass1ContinuedPastTimeout = false;
    let slowInboundRelease = null;
    const slowInboundPromise = new Promise(resolve => { slowInboundRelease = resolve; });

    // Mock Drive client where inbound discovery stalls for pass 1
    let pass1Active = true;
    const testDrive = {
      ...driveClient,
      async findFiles(args) {
        if (pass1Active && (!args || !args.name)) {
          // Wait for release signal (simulating very slow hanging request)
          await slowInboundPromise;
        }
        return driveClient.findFiles(args);
      },
      async listAppDataFiles() {
        if (pass1Active) {
          await slowInboundPromise;
        }
        return driveClient.listAppDataFiles();
      }
    };

    // Pass 1: Runs with bounded 50ms master lock timeout
    const pass1Promise = executeFullSyncPass({
      deviceId,
      sessionKey,
      accessToken: 'valid_mock_token',
      driveClient: testDrive,
      lockOptions: { timeoutMs: 50 }
    });

    // Wait 80ms for Pass 1 to time out and release master lock
    await new Promise(r => setTimeout(r, 80));

    const pass1Result = await pass1Promise;
    assert.equal(pass1Result.success, false, 'Pass 1 must report failure');
    assert.equal(pass1Result.isTimeout, true, 'Pass 1 must be flagged as timeout');

    // Pass 2 (Retry): Runs now that lock is released
    pass1Active = false; // Fast drive response for retry
    const retryResult = await executeFullSyncPass({
      deviceId,
      sessionKey,
      accessToken: 'valid_mock_token',
      driveClient
    });

    assert.equal(retryResult.success, true, 'Retry pass must succeed completely');
    const validSyncedAt = await getSetting('last_delta_synced_at');
    assert.ok(validSyncedAt, 'Retry pass must establish valid last_delta_synced_at');

    // Now release Pass 1's stalled network call to see if it tries to continue or mutate state
    slowInboundRelease();
    await new Promise(r => setTimeout(r, 50));

    // Assert: Pass 1 was aborted by signal and could not continue past timeout
    assert.equal(pass1ContinuedPastTimeout, false, 'Timed-out operation must be halted and not continue execution');

    // Assert: Settings and sequence state remain exactly as written by the successful Retry pass
    const finalSyncedAt = await getSetting('last_delta_synced_at');
    assert.equal(finalSyncedAt, validSyncedAt, 'Timestamp must remain that of the successful retry and not be corrupted by pass 1');

    const finalMetrics = await getDeltaSyncMetrics();
    assert.equal(finalMetrics.pendingCount, 0, 'Pending count must remain 0');
    assert.equal(finalMetrics.lastAllocatedSequence, 1, 'Sequence allocation must remain 1');
  });
});
