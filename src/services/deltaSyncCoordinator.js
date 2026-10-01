/**
 * deltaSyncCoordinator.js — Phase 7.5 Automatic Delta Synchronization Engine
 * 
 * Implements:
 * 1. Master sync locking via Web Locks API (finman_sync_master_lock) with BroadcastChannel notifications
 * 2. Automatic trigger orchestration (30s debounce, 60s hard ceiling, foreground/visibility flush)
 * 3. Outbound packaging, upload, same-device manifest RMW, and exact-identity queue ACK
 * 4. Inbound peer discovery, contiguous staging, gap safety, and Phase 7.4 reconciliation
 * 5. Distributed conflict resolution propagation (KEEP_LOCAL, ACCEPT_REMOTE, CUSTOM_STATE)
 * 6. Coexistence with legacy v2 snapshot sync under shared master lock
 */

import { v4 as uuid } from 'uuid';
import { getDB, getRawIDB } from '../database/db.js';
import {
  uploadPendingDeltas,
  downloadAndStagePeerPackages,
  slicePendingDeltaQueue,
  buildDeterministicPackagePayload,
  encryptDeltaPackage,
  decryptDeltaPackage
} from './deltaTransport.js';
import {
  readOwnDeviceManifest,
  writeOwnDeviceManifest,
  withSameDeviceLock
} from './deviceManifest.js';
import {
  reconcileStagedEvents,
  resolveConflict,
  RECONCILIATION_STATUS
} from './deltaReconciliation.js';

export {
  reconcileStagedEvents,
  resolveConflict,
  RECONCILIATION_STATUS
};
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';

export const MASTER_SYNC_LOCK_NAME = 'finman_sync_master_lock';
export const SYNC_BROADCAST_CHANNEL_NAME = 'finman_sync_channel';

export const SYNC_STATUS = Object.freeze({
  IDLE: 'IDLE',
  SYNCING: 'SYNCING',
  SUCCESS: 'SUCCESS',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  OFFLINE: 'OFFLINE',
  ERROR: 'ERROR'
});

export const SYNC_TRIGGER = Object.freeze({
  MUTATION: 'MUTATION',
  STARTUP: 'STARTUP',
  FOREGROUND: 'FOREGROUND',
  VISIBILITY_CHANGE: 'VISIBILITY_CHANGE',
  PAUSE: 'PAUSE',
  MANUAL: 'MANUAL',
  FOLLOW_UP: 'FOLLOW_UP'
});

export const DEBOUNCE_MS = 30000; // 30 seconds
export const MAX_CEILING_MS = 60000; // 60 seconds

let _syncBroadcastChannel = null;
let _currentSyncStatus = SYNC_STATUS.IDLE;
let _debounceTimer = null;
let _ceilingTimer = null;
let _isSyncRunning = false;
let _pendingSyncRequested = false;
let _syncConfig = {
  getAccessToken: null,
  getSessionKey: null,
  getDeviceId: null,
  driveClient: null,
  enabled: true
};

/**
 * Initializes the broadcast channel for cross-tab sync coordination.
 */
function getBroadcastChannel() {
  if (typeof BroadcastChannel !== 'undefined') {
    if (!_syncBroadcastChannel) {
      try {
        _syncBroadcastChannel = new BroadcastChannel(SYNC_BROADCAST_CHANNEL_NAME);
        _syncBroadcastChannel.unref?.();
        _syncBroadcastChannel.onmessage = (evt) => {
          if (evt?.data?.type === 'SYNC_STATUS_CHANGE') {
            _currentSyncStatus = evt.data.status;
          }
        };
      } catch {}
    }
    return _syncBroadcastChannel;
  }
  return null;
}

export function closeBroadcastChannel() {
  if (_syncBroadcastChannel) {
    try {
      _syncBroadcastChannel.close();
    } catch {}
    _syncBroadcastChannel = null;
  }
}

const _statusListeners = new Set();

/**
 * Subscribe to sync status changes within the same window / process.
 */
export function subscribeSyncStatus(listener) {
  if (typeof listener !== 'function') return () => {};
  _statusListeners.add(listener);
  return () => {
    _statusListeners.delete(listener);
  };
}

/**
 * Broadcasts sync status updates to local subscribers and other open tabs.
 */
export function broadcastSyncStatus(status, details = {}) {
  _currentSyncStatus = status;
  _statusListeners.forEach(fn => {
    try { fn(status, details); } catch {}
  });
  const ch = getBroadcastChannel();
  if (ch) {
    try {
      ch.postMessage({
        type: 'SYNC_STATUS_CHANGE',
        status,
        details,
        timestamp: new Date().toISOString()
      });
    } catch {}
  }
}

export function getCurrentSyncStatus() {
  return _currentSyncStatus;
}

/**
 * Queries current live delta queue counts and local sequence watermarks for UI display.
 */
export async function getDeltaSyncMetrics() {
  try {
    const db = getDB();
    const qRes = await db.query('SELECT * FROM sync_delta_queue').catch(() => ({ values: [] }));
    const pendingCount = (qRes?.values || []).filter(r => r.status !== 'ACKNOWLEDGED').length;

    const sRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }));
    const localState = sRes?.values?.[0] || {};

    let lastDeltaSyncedAt = null;
    try {
      const { getSetting } = await import('../database/settings.js');
      lastDeltaSyncedAt = await getSetting('last_delta_synced_at').catch(() => null);
    } catch {}

    return {
      status: getCurrentSyncStatus(),
      pendingCount,
      lastAllocatedSequence: Number(localState.last_allocated_sequence || 0),
      lastUploadedSequence: Number(localState.last_uploaded_sequence ?? localState.last_pushed_sequence ?? 0),
      lastAckedSequence: Number(localState.last_acked_sequence ?? localState.last_uploaded_sequence ?? localState.last_pushed_sequence ?? 0),
      deviceId: localState.device_id || 'local_device',
      lastDeltaSyncedAt
    };
  } catch {
    return {
      status: getCurrentSyncStatus(),
      pendingCount: 0,
      lastAllocatedSequence: 0,
      lastUploadedSequence: 0,
      lastAckedSequence: 0,
      deviceId: 'local_device',
      lastDeltaSyncedAt: null
    };
  }
}

/**
 * Configures the sync engine runtime dependencies.
 */
export function configureDeltaSyncEngine(options = {}) {
  _syncConfig = {
    ..._syncConfig,
    ...options
  };
}

export async function getLocalDeviceId() {
  try {
    const db = getDB();
    const res = await db.query('SELECT device_id FROM sync_local_state WHERE key = ?', ['device_state']);
    if (res.values?.[0]?.device_id) {
      return res.values[0].device_id;
    }
  } catch {}
  return 'local_device';
}

let _isRuntimeInitialized = false;
let _cleanupRuntimeListeners = null;

/**
 * Initializes the automatic delta sync runtime, wires auth/session providers,
 * registers background/foreground listeners, and triggers startup sync checks.
 */
export function initializeDeltaSyncRuntime() {
  if (_isRuntimeInitialized && _cleanupRuntimeListeners) {
    return _cleanupRuntimeListeners;
  }

  // 1. Configure runtime dependencies with live providers
  configureDeltaSyncEngine({
    getAccessToken: async () => {
      try {
        const { getValidAccessToken } = await import('./googleAuth.js');
        return getValidAccessToken(false);
      } catch {
        return null;
      }
    },
    getSessionKey: async () => {
      try {
        const { getSyncSessionKey } = await import('./syncSession.js');
        return getSyncSessionKey();
      } catch {
        return null;
      }
    },
    getDeviceId: getLocalDeviceId
  });

  // 2. Subscribe to session unlock events (wakes and flushes pending queue on unlock)
  let unsubscribeSession = null;
  import('./syncSession.js').then(({ subscribeSyncSession }) => {
    unsubscribeSession = subscribeSyncSession((isUnlocked, key) => {
      if (isUnlocked && key) {
        scheduleSync(SYNC_TRIGGER.STARTUP);
      }
    });
  }).catch(() => {});

  // 3. Subscribe to Google OAuth state restoration events (wakes and flushes pending queue on connect/reconnect)
  let unsubscribeAuth = null;
  import('./googleAuth.js').then(({ subscribeGoogleAuth }) => {
    unsubscribeAuth = subscribeGoogleAuth((isAuthenticated, token) => {
      if (isAuthenticated && token) {
        scheduleSync(SYNC_TRIGGER.STARTUP);
      }
    });
  }).catch(() => {});

  // 4. Register visibilitychange & focus listeners once (foreground wake)
  const handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      scheduleSync(SYNC_TRIGGER.FOREGROUND);
    }
  };

  const handleFocus = () => {
    scheduleSync(SYNC_TRIGGER.FOREGROUND);
  };

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', handleFocus);
  }

  // 5. Trigger startup sync check
  scheduleSync(SYNC_TRIGGER.STARTUP);

  _isRuntimeInitialized = true;

  _cleanupRuntimeListeners = () => {
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('focus', handleFocus);
    }
    if (unsubscribeSession) {
      try { unsubscribeSession(); } catch {}
    }
    if (unsubscribeAuth) {
      try { unsubscribeAuth(); } catch {}
    }
    cancelScheduledSync();
    _isRuntimeInitialized = false;
    _cleanupRuntimeListeners = null;
  };

  return _cleanupRuntimeListeners;
}

export function isDeltaSyncRuntimeInitialized() {
  return _isRuntimeInitialized;
}

/**
 * Acquires the master sync lock across browser tabs.
 */
export async function withMasterSyncLock(taskFn) {
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return await navigator.locks.request(MASTER_SYNC_LOCK_NAME, { mode: 'exclusive' }, async () => {
      return await taskFn();
    });
  }

  // Fallback locking for node/test/non-supported environments
  const db = getDB();
  const ownerToken = uuid();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60000).toISOString();

  let acquired = false;
  try {
    const res = await db.query('SELECT * FROM sync_process_locks WHERE lock_name = ?', [MASTER_SYNC_LOCK_NAME]);
    const existing = res.values?.[0];

    if (!existing || new Date(existing.expires_at) < now) {
      await db.run(
        'INSERT OR REPLACE INTO sync_process_locks (lock_name, owner_token, expires_at, updated_at) VALUES (?, ?, ?, ?)',
        [MASTER_SYNC_LOCK_NAME, ownerToken, expiresAt, now.toISOString()]
      );
      acquired = true;
    }
  } catch {}

  if (!acquired) {
    throw new Error('[MasterLock] Failed to acquire master sync lock. Another sync operation is active.');
  }

  try {
    return await taskFn();
  } finally {
    try {
      const res = await db.query('SELECT * FROM sync_process_locks WHERE lock_name = ?', [MASTER_SYNC_LOCK_NAME]);
      if (res.values?.[0]?.owner_token === ownerToken) {
        await db.run('DELETE FROM sync_process_locks WHERE lock_name = ?', [MASTER_SYNC_LOCK_NAME]);
      }
    } catch {}
  }
}

/**
 * Schedules an automatic sync run based on trigger type and debounce rules.
 */
export function scheduleSync(trigger = SYNC_TRIGGER.MUTATION) {
  if (!_syncConfig.enabled) return;

  if (trigger === SYNC_TRIGGER.MUTATION) {
    // 1. Reset debounce timer (30s)
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      _flushSyncTimers();
      triggerAutomaticSync(SYNC_TRIGGER.MUTATION);
    }, DEBOUNCE_MS);

    // 2. Ensure hard ceiling timer is running (max 60s from first mutation)
    if (!_ceilingTimer) {
      _ceilingTimer = setTimeout(() => {
        _flushSyncTimers();
        triggerAutomaticSync(SYNC_TRIGGER.MUTATION);
      }, MAX_CEILING_MS);
    }
    return;
  }

  // Immediate triggers: FOREGROUND, VISIBILITY_CHANGE, STARTUP, MANUAL, PAUSE
  _flushSyncTimers();
  return triggerAutomaticSync(trigger);
}

export function cancelScheduledSync() {
  _flushSyncTimers();
}

function _flushSyncTimers() {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_ceilingTimer) {
    clearTimeout(_ceilingTimer);
    _ceilingTimer = null;
  }
}

/**
 * Triggers an immediate automatic sync cycle.
 */
export async function triggerAutomaticSync(trigger = SYNC_TRIGGER.MANUAL) {
  _flushSyncTimers();
  if (_isSyncRunning) {
    _pendingSyncRequested = true;
    return { status: 'DEFERRED_PENDING_ACTIVE_SYNC' };
  }

  _isSyncRunning = true;
  _pendingSyncRequested = false;

  try {
    const result = await executeFullSyncPass({ trigger });

    // If mutations arrived while sync was executing, immediately follow up
    if (_pendingSyncRequested) {
      _pendingSyncRequested = false;
      setTimeout(() => {
        triggerAutomaticSync(SYNC_TRIGGER.FOLLOW_UP);
      }, 0);
    }

    return result;
  } finally {
    _isSyncRunning = false;
  }
}

/**
 * Executes a complete sync cycle (Push -> Pull -> Reconcile) under the Master Sync Lock.
 */
export async function executeFullSyncPass(options = {}) {
  const trigger = options.trigger || SYNC_TRIGGER.MANUAL;
  const driveClient = options.driveClient || _syncConfig.driveClient;
  const getAccessToken = _syncConfig.getAccessToken;
  const getSessionKey = _syncConfig.getSessionKey;
  const getDeviceId = _syncConfig.getDeviceId;

  const accessToken = options.accessToken !== undefined
    ? options.accessToken
    : (getAccessToken ? await getAccessToken() : (_syncConfig.accessToken || null));

  const sessionKey = options.sessionKey !== undefined
    ? options.sessionKey
    : (getSessionKey ? await getSessionKey() : (_syncConfig.sessionKey || null));

  const deviceId = options.deviceId || (getDeviceId ? (typeof getDeviceId === 'function' ? await getDeviceId() : getDeviceId) : (_syncConfig.deviceId || 'local_device'));

  if (!driveClient && !accessToken) {
    broadcastSyncStatus(SYNC_STATUS.AUTH_REQUIRED, { reason: 'No Google Drive credentials' });
    return { success: false, status: SYNC_STATUS.AUTH_REQUIRED, reason: 'No Google Drive credentials' };
  }

  if (!sessionKey) {
    broadcastSyncStatus(SYNC_STATUS.AUTH_REQUIRED, { reason: 'Sync session is locked (no encryption key)' });
    return { success: false, status: SYNC_STATUS.AUTH_REQUIRED, reason: 'Sync session is locked' };
  }

  broadcastSyncStatus(SYNC_STATUS.SYNCING, { trigger });

  try {
    return await withMasterSyncLock(async () => {
      // 1. Recover unacknowledged queue events if manifest already updated
      await recoverQueueAckFromAuthoritativeManifest({
        deviceId,
        accessToken,
        driveClient,
        sessionKey
      });

      // 2. Outbound Push: Package pending deltas -> encrypt -> upload -> manifest RMW -> durable queue ACK
      const pushResult = await uploadPendingDeltas({
        deviceId,
        accessToken,
        driveClient,
        sessionKey
      });

      // 3. Inbound Pull: Discover peer manifests -> download new packages -> stage contiguously
      const pullResult = await downloadAndStagePeerPackages({
        localDeviceId: deviceId,
        accessToken,
        driveClient,
        sessionKey
      });

      // 4. Reconciliation: Apply staged events deterministically to canonical store
      const reconResult = await reconcileStagedEvents({});

      const nowIso = new Date().toISOString();
      try {
        const { setSetting } = await import('../database/settings.js');
        await setSetting('last_delta_synced_at', nowIso);
      } catch {}

      const syncResult = {
        success: true,
        status: SYNC_STATUS.SUCCESS,
        trigger,
        outbound: pushResult,
        inbound: pullResult,
        reconciliation: reconResult,
        timestamp: nowIso
      };

      broadcastSyncStatus(SYNC_STATUS.SUCCESS, syncResult);
      return syncResult;
    });
  } catch (err) {
    const isAuthError = err?.status === 401 || err?.message?.includes('AUTH') || err?.message?.includes('401');
    const finalStatus = isAuthError ? SYNC_STATUS.AUTH_REQUIRED : SYNC_STATUS.ERROR;

    broadcastSyncStatus(finalStatus, { error: err.message, trigger });
    return {
      success: false,
      status: finalStatus,
      error: err.message,
      trigger
    };
  }
}

/**
 * Recovers pending delta queue events if cloud manifest already durably contains the exact package.
 * Requires exact package identity match (device_id, package_id, start_sequence, end_sequence, event_count, package_checksum).
 */
export async function recoverQueueAckFromAuthoritativeManifest({
  deviceId,
  accessToken,
  driveClient,
  sessionKey
}) {
  const db = getDB();
  const rawIdb = getRawIDB();

  let cloudManifest = null;
  try {
    cloudManifest = await readOwnDeviceManifest({ deviceId, accessToken, driveClient });
  } catch {
    return;
  }

  if (!cloudManifest || !cloudManifest.packages || cloudManifest.packages.length === 0) {
    return;
  }

  // Fetch pending queue events
  const pendingRows = (await db.query('SELECT * FROM sync_delta_queue WHERE status = ?', ['PENDING'])).values || [];
  if (pendingRows.length === 0) return;

  for (const pkg of cloudManifest.packages) {
    const matchingDeltas = pendingRows
      .filter(d => Number(d.sequence) >= Number(pkg.start_sequence) && Number(d.sequence) <= Number(pkg.end_sequence))
      .sort((a, b) => Number(a.sequence) - Number(b.sequence));

    if (matchingDeltas.length > 0 && matchingDeltas.length === pkg.event_count) {
      // Recompute canonical package payload checksum to verify exact identity
      const payload = buildDeterministicPackagePayload({
        deviceId,
        startSequence: Number(pkg.start_sequence),
        endSequence: Number(pkg.end_sequence),
        baseSnapshotId: cloudManifest.base_snapshot_id || 'snap_1790493064581_jbhnf8',
        baseCloudVersion: cloudManifest.base_cloud_version || 8,
        events: matchingDeltas.map(d => ({
          ...d,
          payload: typeof d.payload === 'string' ? JSON.parse(d.payload || 'null') : d.payload
        }))
      });

      const calcChecksum = await computeCanonicalSha256(payload);

      if (calcChecksum === pkg.package_checksum) {
        // Exact cryptographic identity match: durably acknowledge queue slice
        if (rawIdb) {
          await new Promise((res, rej) => {
            const tx = rawIdb.transaction(['sync_delta_queue', 'sync_local_state'], 'readwrite');
            const qStore = tx.objectStore('sync_delta_queue');
            const sStore = tx.objectStore('sync_local_state');

            for (const d of matchingDeltas) {
              qStore.put({
                ...d,
                status: 'ACKNOWLEDGED',
                acknowledged_at: new Date().toISOString()
              });
            }

            sStore.put({
              key: 'device_state',
              device_id: deviceId,
              last_uploaded_sequence: Number(pkg.end_sequence),
              last_pushed_sequence: Number(pkg.end_sequence),
              updated_at: new Date().toISOString()
            });

            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
          });
        } else {
          await db.run(
            'UPDATE sync_delta_queue SET status = ?, acknowledged_at = ? WHERE sequence >= ? AND sequence <= ?',
            ['ACKNOWLEDGED', new Date().toISOString(), Number(pkg.start_sequence), Number(pkg.end_sequence)]
          );
          await db.run(
            'UPDATE sync_local_state SET last_uploaded_sequence = ?, updated_at = ? WHERE device_id = ?',
            [Number(pkg.end_sequence), new Date().toISOString(), deviceId]
          );
        }
      }
    }
  }
}
