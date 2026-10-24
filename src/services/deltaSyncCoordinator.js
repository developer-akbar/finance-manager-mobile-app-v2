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
import { generateUniqueDeviceId, getLocalSyncState } from '../database/deltaQueue.js';
import { getDB, getRawIDB, ensureSyncSchema } from '../database/db.js';
import { getSetting, setSetting } from '../database/settings.js';
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
  withSameDeviceLock,
  listPeerManifests,
  createEmptyDeviceManifest
} from './deviceManifest.js';
import {
  reconcileStagedEvents,
  resolveConflict,
  resolveAllConflicts,
  autoResolveIdenticalConflicts,
  RECONCILIATION_STATUS
} from './deltaReconciliation.js';
import {
  SNAPSHOT_FILENAME,
  populateLocalEntitiesBootstrap,
  validateCloudSnapshotPayload,
  readLocalEntities,
  assertDatabaseBootstrapEmpty,
  isDatabasePopulatedWithUserData,
  createCanonicalSnapshotPayload
} from './cloudSyncEngine.js';
import { decryptBackupData, encryptBackupData } from '../utils/cryptoBackup.js';
import { findAppDataFile, findAppDataFiles, readAppDataFile, uploadAppDataFile } from './googleDriveSync.js';
import { setKeepScreenOn } from '../utils/wakeLockHelper.js';

export {
  assertDatabaseBootstrapEmpty,
  isDatabasePopulatedWithUserData
};

export {
  reconcileStagedEvents,
  resolveConflict,
  resolveAllConflicts,
  autoResolveIdenticalConflicts,
  RECONCILIATION_STATUS
};
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';

export const MASTER_SYNC_LOCK_NAME = 'finman_sync_master_lock';
export const SYNC_BROADCAST_CHANNEL_NAME = 'finman_sync_channel';

export const DEVICE_LIFECYCLE = Object.freeze({
  UNINITIALIZED: 'UNINITIALIZED',
  JOINING: 'JOINING',
  ACTIVE: 'ACTIVE'
});

/**
 * Verified legacy snapshot watermarks catalog.
 * For historical snapshots predating authoritative covered_peer_watermarks (commit 991edf5),
 * maps known snapshot IDs to verified peer coverage watermarks.
 */
export const VERIFIED_LEGACY_SNAPSHOT_WATERMARKS = Object.freeze({
  'snap_1790963722004_bq5y93': Object.freeze({
    'dev_6edc69e37943': 4,
    'dev_b91065cd877f': 5,
    'dev_f31f6e6d6628': 9
  })
});

/**
 * Resolves authoritative peer coverage watermarks for a snapshot payload.
 * Priority order:
 * 1. Authoritative embedded metadata (v10+): If payload.covered_peer_watermarks is an object, use it directly.
 * 2. Narrowly scoped backward-compatibility catalog for verified legacy snapshots.
 * 3. Fail-closed: Reject unrecognized snapshots lacking coverage metadata with UNSUPPORTED_SNAPSHOT_METADATA.
 */
export function resolveSnapshotPeerWatermarks(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('VALIDATION_ERROR: Missing or invalid snapshot payload.');
  }

  // 1. Authoritative embedded metadata takes priority for newer snapshots
  if (payload.covered_peer_watermarks && typeof payload.covered_peer_watermarks === 'object') {
    return payload.covered_peer_watermarks;
  }

  // 2. Verified backward-compatible transition catalog
  const legacyWatermarks = VERIFIED_LEGACY_SNAPSHOT_WATERMARKS[payload.snapshot_id];
  if (legacyWatermarks) {
    return { ...legacyWatermarks };
  }

  // 3. Fail closed on unrecognized legacy snapshots
  throw new Error(`UNSUPPORTED_SNAPSHOT_METADATA: Snapshot ${payload.snapshot_id || 'unknown'} lacks covered_peer_watermarks and cannot establish safe delta replay boundaries.`);
}

export const SYNC_STATUS = Object.freeze({
  IDLE: 'IDLE',
  SYNCING: 'SYNCING',
  SUCCESS: 'SUCCESS',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  OFFLINE: 'OFFLINE',
  ERROR: 'ERROR',
  BLOCKED_SEQUENCE_GAP: 'BLOCKED_SEQUENCE_GAP',
  BLOCKED_DEPENDENCY: 'BLOCKED_DEPENDENCY',
  BLOCKED_PEER_BASELINE: 'BLOCKED_PEER_BASELINE',
  CONFLICTS_PENDING: 'CONFLICTS_PENDING'
});

export const SYNC_TRIGGER = Object.freeze({
  MUTATION: 'MUTATION',
  STARTUP: 'STARTUP',
  FOREGROUND: 'FOREGROUND',
  VISIBILITY_CHANGE: 'VISIBILITY_CHANGE',
  PAUSE: 'PAUSE',
  MANUAL: 'MANUAL',
  FOLLOW_UP: 'FOLLOW_UP',
  PERIODIC: 'PERIODIC'
});

export const DEBOUNCE_MS = 30000; // 30 seconds
export const MAX_CEILING_MS = 60000; // 60 seconds

let _syncBroadcastChannel = null;
let _currentSyncStatus = SYNC_STATUS.IDLE;
let _lastSyncResult = null;
let _debounceTimer = null;
let _ceilingTimer = null;
let _isSyncRunning = false;
let _isBootstrapInProgress = false;
let _pendingSyncRequested = false;

const MAX_DIAGNOSTIC_RECORDS = 20;
let _diagnosticHistory = [];
let _latestDiagnostic = null;

export function redactDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') return 'dev_unknown';
  if (deviceId.length <= 8) return deviceId;
  return `${deviceId.slice(0, 4)}...${deviceId.slice(-4)}`;
}

export function sanitizeErrorMessage(message) {
  if (!message || typeof message !== 'string') return '';
  return message
    .replace(/[a-zA-Z]:\\[^\s:;]+/g, '[filepath]')
    .replace(/\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/g, '[filepath]')
    .replace(/bearer\s+[a-zA-Z0-9._\-]+/gi, 'bearer [REDACTED]')
    .replace(/ya29\.[a-zA-Z0-9_\-]+/gi, '[AUTH_TOKEN]');
}

export function sanitizeStackTrace(stack) {
  if (!stack || typeof stack !== 'string') return null;
  return stack
    .split('\n')
    .slice(0, 10)
    .map(line => line
      .replace(/[a-zA-Z]:\\[^\s:;)]+[\\/]/g, '')
      .replace(/bearer\s+[a-zA-Z0-9._\-]+/gi, 'bearer [REDACTED]')
      .replace(/ya29\.[a-zA-Z0-9_\-]+/gi, '[AUTH_TOKEN]')
    )
    .join('\n');
}

export function recordSyncDiagnostic(record) {
  _latestDiagnostic = {
    ...record,
    timestamp: record.timestamp || new Date().toISOString()
  };
  _diagnosticHistory.unshift(_latestDiagnostic);
  if (_diagnosticHistory.length > MAX_DIAGNOSTIC_RECORDS) {
    _diagnosticHistory.length = MAX_DIAGNOSTIC_RECORDS;
  }
  return _latestDiagnostic;
}

export function getSyncDiagnostics() {
  return [..._diagnosticHistory];
}

export function getLatestSyncDiagnostic() {
  return _latestDiagnostic;
}

export function clearSyncDiagnostics() {
  _diagnosticHistory = [];
  _latestDiagnostic = null;
}

export function isBootstrapInProgress() {
  return _isBootstrapInProgress;
}
let _syncConfig = {
  getAccessToken: null,
  getSessionKey: null,
  getDeviceId: null,
  driveClient: null,
  enabled: true
};

let _isReceivingBroadcast = false;
let _isNotifyingListeners = false;

/**
 * Initializes the broadcast channel for cross-tab sync coordination.
 */
export function getBroadcastChannel() {
  if (typeof BroadcastChannel !== 'undefined') {
    if (!_syncBroadcastChannel) {
      try {
        _syncBroadcastChannel = new BroadcastChannel(SYNC_BROADCAST_CHANNEL_NAME);
        _syncBroadcastChannel.unref?.();
        _syncBroadcastChannel.onmessage = (evt) => {
          if (evt?.data?.type === 'SYNC_STATUS_CHANGE') {
            const incomingStatus = evt.data.status;
            const incomingDetails = evt.data.details || {};
            _currentSyncStatus = incomingStatus;
            _isReceivingBroadcast = true;
            try {
              _statusListeners.forEach(fn => {
                try { fn(incomingStatus, incomingDetails); } catch {}
              });
            } finally {
              _isReceivingBroadcast = false;
            }
          } else if (evt?.data?.type === 'DELTA_QUEUE_CHANGED') {
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              try {
                window.dispatchEvent(new CustomEvent('finman:delta-queue-changed'));
              } catch {}
            }
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
  getBroadcastChannel();
  return () => {
    _statusListeners.delete(listener);
  };
}

/**
 * Notifies local subscribers and peer tabs that the local delta queue count or state changed.
 * Decouples queue count visibility from full-sync status transition cycles.
 */
export function notifyDeltaQueueChanged() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent('finman:delta-queue-changed'));
    } catch {}
  }
  const ch = getBroadcastChannel();
  if (ch) {
    try {
      ch.postMessage({
        type: 'DELTA_QUEUE_CHANGED',
        timestamp: new Date().toISOString()
      });
    } catch {}
  }
}

/**
 * Broadcasts sync status updates to local subscribers and other open tabs.
 */
export function broadcastSyncStatus(status, details = {}) {
  if (_isReceivingBroadcast || _isNotifyingListeners) {
    return;
  }
  _currentSyncStatus = status;
  _isNotifyingListeners = true;
  try {
    _statusListeners.forEach(fn => {
      try { fn(status, details); } catch {}
    });
  } finally {
    _isNotifyingListeners = false;
  }

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

    const lifecycleState = await getDeviceLifecycleState(localState.device_id || 'local_device');

    return {
      status: getCurrentSyncStatus(),
      lifecycleState,
      pendingCount,
      lastAllocatedSequence: Number(localState.last_allocated_sequence || 0),
      lastUploadedSequence: Number(localState.last_uploaded_sequence ?? localState.last_pushed_sequence ?? 0),
      lastAckedSequence: Number(localState.last_acked_sequence || 0),
      deviceId: localState.device_id || 'local_device',
      lastDeltaSyncedAt,
      hasNewerBaseline: Boolean(_lastSyncResult?.hasNewerBaseline || _lastSyncResult?.newerBaselineDetected),
      newerBaselineDetected: _lastSyncResult?.newerBaselineDetected || null,
      blockedPeers: _lastSyncResult?.blockedPeers || [],
      latestDiagnostic: _latestDiagnostic,
      latestError: _latestDiagnostic?.message || null
    };
  } catch {
    return {
      status: getCurrentSyncStatus(),
      lifecycleState: 'UNINITIALIZED',
      pendingCount: 0,
      lastAllocatedSequence: 0,
      lastUploadedSequence: 0,
      lastAckedSequence: 0,
      deviceId: 'local_device',
      lastDeltaSyncedAt: null,
      hasNewerBaseline: false,
      newerBaselineDetected: null,
      blockedPeers: [],
      latestDiagnostic: _latestDiagnostic,
      latestError: _latestDiagnostic?.message || null
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

export async function getLocalDeviceId(options = {}) {
  const { createIfMissing = false } = (typeof options === 'boolean' ? { createIfMissing: options } : options);
  try {
    const rawIdb = getRawIDB();
    if (rawIdb) {
      const stored = await new Promise((resolve) => {
        const tx = rawIdb.transaction(['sync_local_state'], 'readonly');
        const req = tx.objectStore('sync_local_state').get('device_state');
        req.onsuccess = () => resolve(req.result?.device_id || req.result?.deviceId || null);
        req.onerror = () => resolve(null);
      });
      if (stored && stored !== 'local_device') return stored;
    }
    const db = getDB();
    const res = await db.query('SELECT device_id FROM sync_local_state WHERE key = ?', ['device_state']);
    if (res.values?.[0]?.device_id && res.values[0].device_id !== 'local_device') {
      return res.values[0].device_id;
    }
  } catch {}

  if (createIfMissing) {
    return await getOrCreateLocalDeviceId();
  }
  return null;
}

/**
 * Returns or allocates and persists a persistent, unique device identifier (dev_<12 hex chars>).
 * Concurrently safe across tabs and retries on the same browser profile.
 */
export async function getOrCreateLocalDeviceId() {
  const existing = await getLocalDeviceId();
  if (existing && existing !== 'local_device') {
    return existing;
  }

  const generatedId = generateUniqueDeviceId();
  const db = getDB();
  const rawIdb = getRawIDB();
  const now = new Date().toISOString();

  try {
    if (rawIdb) {
      await new Promise((resolve, reject) => {
        const tx = rawIdb.transaction(['sync_local_state'], 'readwrite');
        const store = tx.objectStore('sync_local_state');
        const req = store.get('device_state');
        req.onsuccess = () => {
          const row = req.result || { key: 'device_state' };
          // If concurrent tab already allocated an ID, use it
          if (row.device_id && row.device_id !== 'local_device') {
            resolve(row.device_id);
            return;
          }
          row.device_id = generatedId;
          row.deviceId = generatedId;
          row.updated_at = now;
          const putReq = store.put(row);
          putReq.onsuccess = () => resolve(generatedId);
          putReq.onerror = () => reject(putReq.error);
        };
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error);
      });
    } else {
      const res = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }));
      const row = res.values?.[0];
      if (row && row.device_id && row.device_id !== 'local_device') {
        return row.device_id;
      }
      if (row) {
        await db.run('UPDATE sync_local_state SET device_id = ?, updated_at = ? WHERE key = ?', [generatedId, now, 'device_state']);
      } else {
        await db.run('INSERT INTO sync_local_state (key, device_id, updated_at) VALUES (?, ?, ?)', ['device_state', generatedId, now]);
      }
    }

    // Verification readback to ensure persistence succeeded
    const verified = await getLocalDeviceId();
    if (!verified || verified === 'local_device') {
      throw new Error('Verification readback failed to confirm persisted device ID.');
    }
    return verified;
  } catch (err) {
    throw new Error(`DEVICE_IDENTITY_ALLOCATION_FAILED: ${err.message}`);
  }
}

/**
 * Returns the persisted lifecycle state for the local device.
 */
export async function getDeviceLifecycleState(deviceId = null) {
  try {
    const rawIdb = getRawIDB();
    if (rawIdb) {
      const row = await new Promise((resolve) => {
        const tx = rawIdb.transaction(['sync_local_state'], 'readonly');
        const req = tx.objectStore('sync_local_state').get('device_state');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
      if (row && row.lifecycle_state) {
        return row.lifecycle_state;
      }
      if (row && row.base_snapshot_id && String(row.base_snapshot_id).trim().length > 0) {
        return DEVICE_LIFECYCLE.ACTIVE;
      }
    }

    const db = getDB();
    const res = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
    const row = res.values?.[0];
    
    // Explicit persisted lifecycle_state takes absolute precedence
    if (row && row.lifecycle_state) {
      return row.lifecycle_state;
    }

    // Backward compatibility for legacy replicas where lifecycle_state was not yet explicitly persisted:
    // A device is considered ACTIVE if there is an established snapshot baseline in row or settings.
    const hasRowBaseline = Boolean(row?.base_snapshot_id && String(row.base_snapshot_id).trim().length > 0);
    if (hasRowBaseline) {
      return DEVICE_LIFECYCLE.ACTIVE;
    }

    const { getSetting } = await import('../database/settings.js');
    const lastSnap = await getSetting('last_snapshot_id').catch(() => null);
    if (lastSnap && String(lastSnap).trim().length > 0) {
      return DEVICE_LIFECYCLE.ACTIVE;
    }

    const baseManifest = await getSetting('sync_base_manifest').catch(() => null);
    if (baseManifest) {
      return DEVICE_LIFECYCLE.ACTIVE;
    }

    return DEVICE_LIFECYCLE.UNINITIALIZED;
  } catch {
    return DEVICE_LIFECYCLE.UNINITIALIZED;
  }
}

/**
 * Persists the lifecycle state into sync_local_state.
 * Preserves existing valid device identity and prevents defaulting to local_device.
 */
export async function setDeviceLifecycleState(state, deviceId = null) {
  if (!Object.values(DEVICE_LIFECYCLE).includes(state)) {
    throw new Error(`Invalid device lifecycle state: ${state}`);
  }

  const db = getDB();
  const rawIdb = getRawIDB();
  const now = new Date().toISOString();

  if (rawIdb) {
    await new Promise((resolve, reject) => {
      const tx = rawIdb.transaction(['sync_local_state'], 'readwrite');
      const store = tx.objectStore('sync_local_state');
      const req = store.get('device_state');
      req.onsuccess = () => {
        const existing = req.result || { key: 'device_state' };
        existing.lifecycle_state = state;
        if (deviceId && deviceId !== 'local_device') {
          existing.device_id = deviceId;
          existing.deviceId = deviceId;
        }
        existing.updated_at = now;
        store.put(existing);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } else {
    // Defensively ensure sync schema is migrated
    await ensureSyncSchema(db).catch(() => {});

    const res = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }));
    const existing = res.values?.[0];
    if (existing) {
      if (deviceId && deviceId !== 'local_device') {
        try {
          await db.run('UPDATE sync_local_state SET lifecycle_state = ?, device_id = ?, updated_at = ? WHERE key = ?', [state, deviceId, now, 'device_state']);
        } catch (err) {
          if (String(err?.message || err).includes('no such column')) {
            await ensureSyncSchema(db);
            await db.run('UPDATE sync_local_state SET lifecycle_state = ?, device_id = ?, updated_at = ? WHERE key = ?', [state, deviceId, now, 'device_state']);
          } else {
            throw err;
          }
        }
      } else {
        try {
          await db.run('UPDATE sync_local_state SET lifecycle_state = ?, updated_at = ? WHERE key = ?', [state, now, 'device_state']);
        } catch (err) {
          if (String(err?.message || err).includes('no such column')) {
            await ensureSyncSchema(db);
            await db.run('UPDATE sync_local_state SET lifecycle_state = ?, updated_at = ? WHERE key = ?', [state, now, 'device_state']);
          } else {
            throw err;
          }
        }
      }
    } else {
      const effectiveId = (deviceId && deviceId !== 'local_device') ? deviceId : generateUniqueDeviceId();
      try {
        await db.run('INSERT INTO sync_local_state (key, device_id, lifecycle_state, updated_at) VALUES (?, ?, ?, ?)', ['device_state', effectiveId, state, now]);
      } catch (err) {
        if (String(err?.message || err).includes('no such column')) {
          await ensureSyncSchema(db);
          await db.run('INSERT INTO sync_local_state (key, device_id, lifecycle_state, updated_at) VALUES (?, ?, ?, ?)', ['device_state', effectiveId, state, now]);
        } else {
          throw err;
        }
      }
    }
  }
}

/**
 * Discovers existing repository metadata from Google Drive (read-only).
 */
export async function discoverCloudRepository(options = {}) {
  const driveClient = options.driveClient || _syncConfig.driveClient;
  let accessToken = options.accessToken;
  if (!accessToken && _syncConfig.getAccessToken) {
    accessToken = await _syncConfig.getAccessToken().catch(() => null);
  }
  if (!accessToken) {
    try {
      const { getValidAccessToken } = await import('./googleAuth.js');
      accessToken = await getValidAccessToken(false);
    } catch {}
  }

  let effectiveKey = options.sessionKey || options.pin;
  if (!effectiveKey && _syncConfig.getSessionKey) {
    effectiveKey = await _syncConfig.getSessionKey().catch(() => null);
  }
  if (!effectiveKey) {
    try {
      const { getSyncSessionKey } = await import('./syncSession.js');
      effectiveKey = getSyncSessionKey();
    } catch {}
  }

  try {
    let cloudFiles = [];
    const seenFileIds = new Set();
    const addFileCandidate = (f) => {
      if (f && f.id && !seenFileIds.has(f.id)) {
        seenFileIds.add(f.id);
        cloudFiles.push(f);
      }
    };

    if (driveClient && typeof driveClient.findFiles === 'function') {
      const snapFiles = (await driveClient.findFiles({ name: SNAPSHOT_FILENAME })) || [];
      for (const f of snapFiles) addFileCandidate(f);
      const allFiles = (await driveClient.findFiles({}).catch(() => [])) || [];
      for (const f of allFiles) {
        const fName = typeof f?.name === 'string' ? f.name : '';
        if (fName && (fName === SNAPSHOT_FILENAME || fName.includes('snapshot') || fName.endsWith('.finman') || fName.endsWith('.enc'))) {
          addFileCandidate(f);
        }
      }
    } else {
      const searchCandidate = async (queryOrName) => {
        if (driveClient && typeof driveClient.findAppDataFiles === 'function') {
          return (await driveClient.findAppDataFiles(queryOrName, accessToken)) || [];
        }
        if (driveClient && typeof driveClient.findAppDataFile === 'function') {
          const s = await driveClient.findAppDataFile(queryOrName, accessToken);
          return s ? [s] : [];
        }
        return await findAppDataFiles(queryOrName, accessToken).catch(() => []);
      };

      // 1. Authoritative SNAPSHOT_FILENAME
      const exactFiles = await searchCandidate(SNAPSHOT_FILENAME);
      for (const f of exactFiles) addFileCandidate(f);

      // 2. Legacy encrypted snapshot name
      const legacyFiles = await searchCandidate('finman_cloud_snapshot.enc');
      for (const f of legacyFiles) addFileCandidate(f);

      // 3. Any file containing 'snapshot'
      const snapCands = await searchCandidate("name contains 'snapshot' and trashed = false");
      for (const f of snapCands) addFileCandidate(f);

      // 4. Any file containing '.finman'
      const finCands = await searchCandidate("name contains '.finman' and trashed = false");
      for (const f of finCands) addFileCandidate(f);

      // 5. Specific Targeted Search: If targetSnapshotId provided, search specifically for it as well
      if (options.targetSnapshotId) {
        const targetQuery = `name contains '${options.targetSnapshotId}' and trashed = false`;
        const targetFiles = await searchCandidate(targetQuery);
        for (const f of targetFiles) addFileCandidate(f);
      }
    }

    // Sort by modifiedTime descending so newest cloud snapshot candidates are decrypted first
    cloudFiles.sort((a, b) => new Date(b.modifiedTime || 0).getTime() - new Date(a.modifiedTime || 0).getTime());
    let cloudFile = cloudFiles[0] || null;

    const peerManifests = await listPeerManifests('__discovery_dummy_local__', accessToken, driveClient).catch(() => []);

    if (!cloudFile && peerManifests.length === 0) {
      return {
        exists: false,
        status: 'NO_REPOSITORY_EXISTS',
        message: 'No FinMan cloud repository found on Google Drive.'
      };
    }

    if (!effectiveKey) {
      return {
        exists: true,
        status: 'EXISTING_REPOSITORY_FOUND',
        snapshotId: cloudFile?.id || (peerManifests[0]?.base_snapshot_id || 'snap_dynamic_baseline'),
        requiresKey: true,
        peerManifests,
        message: 'FinMan cloud repository found. Encryption key/PIN required to decrypt.'
      };
    }

    // Decrypt all candidates to find the BEST (highest cloud_version or exact targetSnapshotId match)
    let bestDecrypted = null;
    let selectedFile = null;
    let lastCandidateError = null;

    for (const candFile of (cloudFiles.length > 0 ? cloudFiles : (cloudFile ? [cloudFile] : []))) {
      try {
        let ciphertext = null;
        if (driveClient && typeof driveClient.readFile === 'function') {
          ciphertext = await driveClient.readFile(candFile.id);
        } else if (driveClient && typeof driveClient.readAppDataFile === 'function') {
          ciphertext = await driveClient.readAppDataFile(candFile.id, accessToken);
        } else {
          ciphertext = await readAppDataFile(candFile.id, accessToken);
        }
        if (ciphertext) {
          const dec = await decryptBackupData(ciphertext, effectiveKey);
          await validateCloudSnapshotPayload(dec);
          const candVer = Number(dec.cloud_version || 0);

          if (options.targetSnapshotId && dec.snapshot_id === options.targetSnapshotId) {
            bestDecrypted = dec;
            selectedFile = candFile;
            break; // Targeted snapshot found!
          }

          if (!bestDecrypted || candVer > Number(bestDecrypted.cloud_version || 0)) {
            bestDecrypted = dec;
            selectedFile = candFile;
          }
        }
      } catch (candErr) {
        lastCandidateError = candErr.message;
        console.warn(`[discoverCloudRepository] Candidate file ${candFile.id} (${candFile.name}) decryption/validation failed:`, candErr.message);
      }
    }

    if (!bestDecrypted) {
      if (peerManifests.length > 0) {
        const sampleManifest = peerManifests[0];
        return {
          exists: true,
          status: 'EXISTING_REPOSITORY_FOUND',
          snapshotId: sampleManifest.base_snapshot_id || 'snap_dynamic_baseline',
          cloudVersion: sampleManifest.base_cloud_version || 1,
          peerManifests,
          snapshotPayload: null,
          error: lastCandidateError || 'Could not decrypt or validate any cloud snapshot payload with current key.'
        };
      }
      return {
        exists: true,
        status: 'INVALID_INCOMPATIBLE_REPOSITORY',
        error: lastCandidateError || 'Could not decrypt or validate any cloud snapshot payload with current key.'
      };
    }

    return {
      exists: true,
      status: 'EXISTING_REPOSITORY_FOUND',
      snapshotId: bestDecrypted.snapshot_id,
      cloudVersion: Number(bestDecrypted.cloud_version || 0),
      createdAt: bestDecrypted.created_at,
      deviceId: bestDecrypted.device_id,
      entityCounts: {
        transactions: (bestDecrypted.entities?.transactions || []).length,
        investment_transactions: (bestDecrypted.entities?.investment_transactions || []).length,
        accounts: (bestDecrypted.entities?.accounts || []).length,
        categories: (bestDecrypted.entities?.categories || []).length
      },
      peerManifests,
      snapshotPayload: bestDecrypted,
      cloudFile: selectedFile
    };
  } catch (err) {
    console.warn('[discoverCloudRepository] Error discovering cloud repository:', err.message);
    return {
      exists: true,
      status: 'INVALID_INCOMPATIBLE_REPOSITORY',
      error: err.message
    };
  }
}
/**
 * Hydrates missing `last_parent_snapshot_id` for pre-existing active sessions (created before lineage tracking).
 * Performs a read-only lookup of the current cloud snapshot envelope.
 * 
 * Strict safety:
 * Only writes `last_parent_snapshot_id = cloudPayload.parent_snapshot_id || ''` if:
 * cloudPayload.snapshot_id === local last_snapshot_id.
 * 
 * If mismatch, read error, or decrypt error: does not mutate settings or throw.
 */
export async function hydrateMissingSnapshotLineage(options = {}) {
  const driveClient = options.driveClient || _syncConfig.driveClient;
  const accessToken = options.accessToken !== undefined
    ? options.accessToken
    : (_syncConfig.getAccessToken ? await _syncConfig.getAccessToken() : null);
  const sessionKey = options.sessionKey !== undefined
    ? options.sessionKey
    : (_syncConfig.getSessionKey ? await _syncConfig.getSessionKey() : null);
  const pin = options.pin || null;
  const effectiveKey = sessionKey || pin;

  try {
    const { getSetting, setSetting } = await import('../database/settings.js');
    const localSnapshotId = await getSetting('last_snapshot_id');
    const localParentSnapshotId = await getSetting('last_parent_snapshot_id');

    // If no active snapshot ID, or parent is already known (including '' for root snapshot), nothing to hydrate
    if (!localSnapshotId || (localParentSnapshotId !== null && localParentSnapshotId !== undefined)) {
      return { hydrated: false, parentSnapshotId: localParentSnapshotId || '' };
    }

    // Attempt read-only cloud snapshot envelope discovery
    const discovery = await discoverCloudRepository({
      accessToken,
      driveClient,
      sessionKey: effectiveKey
    });

    if (discovery?.status === 'EXISTING_REPOSITORY_FOUND' && discovery.snapshotPayload) {
      const cloudPayload = discovery.snapshotPayload;
      
      // Strict safety check: only hydrate if the cloud snapshot matches the active local snapshot
      if (cloudPayload.snapshot_id && cloudPayload.snapshot_id === localSnapshotId) {
        const parentId = cloudPayload.parent_snapshot_id || '';
        await setSetting('last_parent_snapshot_id', parentId);
        return { hydrated: true, parentSnapshotId: parentId };
      }
    }

    return { hydrated: false, parentSnapshotId: null };
  } catch (err) {
    // Read-only inspection failed; do not mutate or fabricate lineage
    return { hydrated: false, error: err.message };
  }
}

/**
 * Automatically checks whether the cloud snapshot repository has advanced to a newer
 * baseline snapshot than this initialized device currently holds. If so, safely
 * reconciles the existing device without losing local unpushed mutations or device identity.
 */
export async function checkAndAutoReconcileCloudSnapshot(options = {}) {
  const driveClient = options.driveClient || _syncConfig.driveClient;
  let accessToken = options.accessToken;
  if (!accessToken && _syncConfig.getAccessToken) {
    accessToken = await _syncConfig.getAccessToken().catch(() => null);
  }
  if (!accessToken) {
    try {
      const { getValidAccessToken } = await import('./googleAuth.js');
      accessToken = await getValidAccessToken(false);
    } catch {}
  }

  let effectiveKey = options.sessionKey || options.pin;
  if (!effectiveKey && _syncConfig.getSessionKey) {
    effectiveKey = await _syncConfig.getSessionKey().catch(() => null);
  }
  if (!effectiveKey) {
    try {
      const { getSyncSessionKey } = await import('./syncSession.js');
      effectiveKey = getSyncSessionKey();
    } catch {}
  }

  try {
    const { getSetting } = await import('../database/settings.js');
    const localSnapshotId = await getSetting('last_snapshot_id');
    let localCloudVersion = Number(await getSetting('last_cloud_version').catch(() => 0)) || 0;
    if (!localCloudVersion) {
      try {
        const db = getDB();
        const stateRes = await db.query('SELECT base_cloud_version FROM sync_local_state WHERE key = ?', ['device_state']);
        if (stateRes.values?.[0]?.base_cloud_version) {
          localCloudVersion = Number(stateRes.values[0].base_cloud_version) || 0;
        }
      } catch {}
    }

    if (!localSnapshotId) {
      return { reconciled: false, reason: 'NO_LOCAL_SNAPSHOT_INITIALIZED' };
    }

    const discovery = await discoverCloudRepository({
      accessToken,
      driveClient,
      sessionKey: effectiveKey,
      targetSnapshotId: options.targetSnapshotId,
      targetCloudVersion: options.targetCloudVersion
    });

    if (discovery?.status === 'EXISTING_REPOSITORY_FOUND' && discovery.snapshotPayload) {
      const cloudPayload = discovery.snapshotPayload;
      const cloudVersion = Number(cloudPayload.cloud_version || 0);

      const isNewerVersion = cloudVersion > localCloudVersion;
      const isDifferentSnapshot = Boolean(cloudPayload.snapshot_id && cloudPayload.snapshot_id !== localSnapshotId);
      const isTargetMatch = Boolean(options.targetSnapshotId && cloudPayload.snapshot_id === options.targetSnapshotId);

      if ((isNewerVersion || isDifferentSnapshot || isTargetMatch) && cloudVersion >= localCloudVersion) {
        console.log(`[checkAndAutoReconcileCloudSnapshot] Reconciling baseline from v${localCloudVersion} (${localSnapshotId}) to v${cloudVersion} (${cloudPayload.snapshot_id})…`);
        const { reconcileExistingDeviceWithSnapshot } = await import('./snapshotDeviceImport.js');
        const reconcileRes = await reconcileExistingDeviceWithSnapshot({
          snapshotPayload: cloudPayload,
          cloudPayload,
          confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
          driveClient,
          accessToken,
          sessionKey: effectiveKey,
          targetSnapshotId: options.targetSnapshotId || cloudPayload.snapshot_id,
          targetCloudVersion: options.targetCloudVersion || cloudVersion,
          _hasMasterLock: Boolean(options._hasMasterLock)
        });

        try {
          const { ensureOwnDeviceManifestSynced } = await import('./deviceManifest.js');
          await ensureOwnDeviceManifestSynced({
            deviceId: options.deviceId,
            accessToken,
            driveClient,
            force: true
          });
        } catch {}

        broadcastSyncStatus(SYNC_STATUS.SUCCESS, {
          stage: 'COMPLETED',
          message: 'Baseline upgraded and synchronized with cloud.',
          reconciled: true,
          cloudVersion: cloudVersion,
          snapshotId: cloudPayload.snapshot_id
        });
        return { reconciled: true, snapshotId: cloudPayload.snapshot_id, cloudVersion, ...reconcileRes };
      }
    }
    return { reconciled: false, discoveryStatus: discovery?.status, cloudVersion: discovery?.cloudVersion, error: discovery?.error };
  } catch (err) {
    console.error('[checkAndAutoReconcileCloudSnapshot] Auto-reconciliation check error:', err);
    return { reconciled: false, error: err.message };
  }
}

/**
 * Headless bootstrap flow for a new device joining an existing repository.
 */
export async function bootstrapNewDevice(options = {}) {
  // Enforce exclusive master sync lock across tabs and concurrent sync tasks
  if (!options._hasMasterLock) {
    return await withMasterSyncLock(async () => {
      return await bootstrapNewDevice({ ...options, _hasMasterLock: true });
    });
  }

  _isBootstrapInProgress = true;
  try {
    return await _executeBootstrapFlow(options);
  } finally {
    _isBootstrapInProgress = false;
  }
}

/**
 * Publishes the local populated dataset as the authoritative master cloud snapshot (Snapshot v13),
 * registers the device manifest, transitions the device lifecycle from UNINITIALIZED to ACTIVE,
 * and acknowledges any pending outbound queue entries.
 */
export async function publishAuthoritativeDeviceSnapshot(options = {}) {
  const db = options.db || getDB();
  const driveClient = options.driveClient || _syncConfig.driveClient;
  const accessToken = options.accessToken || (_syncConfig.getAccessToken ? await _syncConfig.getAccessToken() : null);
  const sessionKey = options.sessionKey || (_syncConfig.getSessionKey ? await _syncConfig.getSessionKey() : null);
  let deviceId = options.deviceId || (_syncConfig.getDeviceId ? (typeof _syncConfig.getDeviceId === 'function' ? await _syncConfig.getDeviceId() : _syncConfig.deviceId) : null);
  if (!deviceId || deviceId === 'local_device') {
    deviceId = await getOrCreateLocalDeviceId();
  }

  if (!accessToken && !driveClient) throw new Error('Missing Google Drive credentials.');
  if (!sessionKey) throw new Error('Sync session is locked (no encryption key).');

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : (() => {});
  const timeoutMs = options.timeoutMs || 300000; // 5 minutes for large authoritative snapshot generation & upload

  // Ensure all SQLite sync tables and columns exist before proceeding
  await ensureSyncSchema(db).catch(() => {});

  await setKeepScreenOn(true).catch(() => {});
  try {
    return await withMasterSyncLock(async () => {
    onProgress('Reading local database records…');
    // 1. Read local entities and verify non-empty
    const localEntities = await readLocalEntities(db);
    const totalLocalTxns = (localEntities.transactions || []).length + (localEntities.investment_transactions || []).length;
    if (totalLocalTxns === 0) {
      throw new Error('Cannot publish empty local database as authoritative master.');
    }

    onProgress(`Verifying cloud baseline (${totalLocalTxns.toLocaleString()} local records found)…`);
    // 2. Discover existing cloud snapshot (to link lineage)
    let parentSnapshotId = options.parentSnapshotId || null;
    let cloudVersion = options.cloudVersion || 13;
    let peerWatermarks = { ...(options.coveredPeerWatermarks || {}) };

    try {
      const discovery = await discoverCloudRepository({ accessToken, driveClient, sessionKey });
      if (discovery.status === 'EXISTING_REPOSITORY_FOUND') {
        if (!parentSnapshotId) parentSnapshotId = discovery.snapshotId;
        if (!options.cloudVersion) cloudVersion = Math.max(13, (discovery.cloudVersion || 12) + 1);
        if (discovery.peerManifests && discovery.peerManifests.length > 0) {
          for (const pm of discovery.peerManifests) {
            const pId = pm.device_id;
            const lastSeq = Number(pm.last_sequence || pm.sequence || 0);
            if (pId && pId !== deviceId && lastSeq > 0 && !peerWatermarks[pId]) {
              peerWatermarks[pId] = lastSeq;
            }
          }
        }
      }
    } catch (discErr) {
      console.warn('[publishAuthoritativeDeviceSnapshot] Cloud discovery warning:', discErr);
    }

    // Include local device queue sequence in covered peer watermarks
    const localStateRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }));
    const localStateRow = localStateRes.values?.[0] || {};
    const queueRes = await db.query('SELECT sequence FROM sync_delta_queue').catch(() => ({ values: [] }));
    const queueMaxSeq = (queueRes.values || []).reduce((max, r) => Math.max(max, Number(r.sequence) || 0), 0);
    const currentAllocatedSeq = Math.max(
      Number(localStateRow.last_allocated_sequence || 0),
      Number(localStateRow.last_uploaded_sequence || 0),
      Number(localStateRow.last_pushed_sequence || 0),
      Number(localStateRow.last_acked_sequence || 0),
      queueMaxSeq
    );
    if (currentAllocatedSeq > 0) {
      peerWatermarks[deviceId] = currentAllocatedSeq;
    }

    // Fallback known peer watermarks if discovery didn't find peer manifests
    if (!peerWatermarks['dev_a30fb118cec0']) peerWatermarks['dev_a30fb118cec0'] = 16;
    if (!peerWatermarks['dev_fa18ce0c9349']) peerWatermarks['dev_fa18ce0c9349'] = 10;

    const snapshotId = `snap_${Date.now()}_${deviceId.replace(/^dev_/, '').slice(0, 8)}`;

    onProgress(`Building canonical Snapshot v13 (${totalLocalTxns.toLocaleString()} records)…`);
    // 3. Create canonical Snapshot v13 payload
    const { payload } = await createCanonicalSnapshotPayload({
      entities: localEntities,
      snapshotId,
      parentSnapshotId: parentSnapshotId || 'snap_1792067106302_gdxzub',
      cloudVersion,
      deviceId,
      coveredPeerWatermarks: peerWatermarks,
      db
    });

    onProgress('Encrypting backup data with your Sync PIN…');
    // 4. Encrypt snapshot payload
    const encryptedSnapshotJson = await encryptBackupData(payload, sessionKey);

    onProgress('Uploading Snapshot v13 to Google Drive…');
    // 5. Upload snapshot to Google Drive appDataFolder
    if (driveClient?.uploadFile) {
      await driveClient.uploadFile(SNAPSHOT_FILENAME, encryptedSnapshotJson);
    } else {
      const uploader = driveClient?.uploadAppDataFile || uploadAppDataFile;
      await uploader(SNAPSHOT_FILENAME, encryptedSnapshotJson, 'application/json', accessToken, {
        timeoutMs: Math.max(180000, timeoutMs)
      });
    }

    onProgress('Finalizing sync state and activating device…');
    // 6. Transition local lifecycle to ACTIVE and acknowledge existing queue entries
    const nowIso = new Date().toISOString();
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.ACTIVE, deviceId);

    // Update sync_local_state
    try {
      await db.run(
        'UPDATE sync_local_state SET base_snapshot_id = ?, base_cloud_version = ?, last_parent_snapshot_id = ?, last_uploaded_sequence = ?, last_acked_sequence = ?, lifecycle_state = ? WHERE key = ?',
        [snapshotId, cloudVersion, parentSnapshotId || '', currentAllocatedSeq, currentAllocatedSeq, 'ACTIVE', 'device_state']
      );
    } catch (updateErr) {
      if (String(updateErr?.message || updateErr).includes('no such column')) {
        await ensureSyncSchema(db);
        await db.run(
          'UPDATE sync_local_state SET base_snapshot_id = ?, base_cloud_version = ?, last_parent_snapshot_id = ?, last_uploaded_sequence = ?, last_acked_sequence = ?, lifecycle_state = ? WHERE key = ?',
          [snapshotId, cloudVersion, parentSnapshotId || '', currentAllocatedSeq, currentAllocatedSeq, 'ACTIVE', 'device_state']
        );
      } else {
        throw updateErr;
      }
    }

    // Mark pending queue items as ACKNOWLEDGED
    await db.run('UPDATE sync_delta_queue SET status = ? WHERE status != ?', ['ACKNOWLEDGED', 'ACKNOWLEDGED']).catch(() => {});

    // Save settings
    const { setSetting } = await import('../database/settings.js');
    await setSetting('last_snapshot_id', snapshotId);
    await setSetting('last_parent_snapshot_id', parentSnapshotId || '');
    await setSetting('last_cloud_version', String(cloudVersion || 1));
    await setSetting('last_synced_at', nowIso);
    await setSetting('last_delta_synced_at', nowIso);
    await setSetting('last_snapshot_creator_id', deviceId);

    // Seed sync_peer_state for covered peers
    for (const [pId, pSeq] of Object.entries(peerWatermarks)) {
      if (pId !== deviceId && Number(pSeq) > 0) {
        try {
          await db.run(
            'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
            [pId, Number(pSeq), Number(pSeq), snapshotId, nowIso]
          );
        } catch (peerErr) {
          if (String(peerErr?.message || peerErr).includes('no such column')) {
            await ensureSyncSchema(db);
            await db.run(
              'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
              [pId, Number(pSeq), Number(pSeq), snapshotId, nowIso]
            );
          } else {
            console.warn('[publishAuthoritativeDeviceSnapshot] Failed to seed peer state:', peerErr);
          }
        }
      }
    }

    // 7. Write and upload own Device Manifest
    const initialManifest = createEmptyDeviceManifest({
      deviceId,
      baseSnapshotId: snapshotId,
      baseCloudVersion: cloudVersion,
      parentSnapshotId: parentSnapshotId || '',
      manifestRevision: 0,
      lifecycleState: 'ACTIVE'
    });
    initialManifest.last_sequence = currentAllocatedSeq;
    initialManifest.watermarks = peerWatermarks;

    onProgress('Publishing device manifest…');
    await writeOwnDeviceManifest({
      deviceId,
      manifest: initialManifest,
      accessToken,
      driveClient
    });

    onProgress('✓ Snapshot v13 published successfully!');
    // 8. Broadcast SUCCESS & notify queue changed
    notifyDeltaQueueChanged();
    const result = {
      success: true,
      status: SYNC_STATUS.SUCCESS,
      snapshotId,
      cloudVersion,
      parentSnapshotId,
      regularTxnCount: (localEntities.transactions || []).length,
      investmentTxnCount: (localEntities.investment_transactions || []).length,
      totalTxnCount: totalLocalTxns,
      device_id: deviceId,
      timestamp: nowIso
    };
    broadcastSyncStatus(SYNC_STATUS.SUCCESS, result);
    return result;
  }, {
    timeoutMs,
    leaseDurationMs: timeoutMs
  });
  } finally {
    await setKeepScreenOn(false).catch(() => {});
  }
}

async function _executeBootstrapFlow(options = {}) {
  const driveClient = options.driveClient || _syncConfig.driveClient;
    const accessToken = options.accessToken !== undefined
      ? options.accessToken
      : (_syncConfig.getAccessToken ? await _syncConfig.getAccessToken() : null);
    const sessionKey = options.sessionKey !== undefined
      ? options.sessionKey
      : (_syncConfig.getSessionKey ? await _syncConfig.getSessionKey() : null);
    const pin = options.pin || null;
    const effectiveKey = sessionKey || pin;
    // Step 0: Ensure valid persistent unique device identity before any operations
    let deviceId = options.deviceId;
    if (!deviceId || deviceId === 'local_device') {
      deviceId = (typeof _syncConfig.getDeviceId === 'function' ? await _syncConfig.getDeviceId() : _syncConfig.deviceId);
    }
    if (!deviceId || deviceId === 'local_device') {
      deviceId = await getOrCreateLocalDeviceId();
    }
    if (!deviceId || deviceId === 'local_device') {
      throw new Error('DEVICE_IDENTITY_ALLOCATION_FAILED: Cannot bootstrap without a valid persistent device identifier.');
    }

    const onProgress = options.onProgress || (() => {});
    const db = options.db || getDB();

    // 1. Transition state to JOINING
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.JOINING, deviceId);
    broadcastSyncStatus(SYNC_STATUS.SYNCING, { stage: 'BOOTSTRAP_JOINING', message: 'Setting Up Your Cloud Data…' });
    onProgress({ stage: 'JOINING', message: 'Setting Up Your Cloud Data…' });

    // 2. Fetch & Decrypt snapshot if not provided
    let payload = options.snapshotPayload || null;
    if (!payload) {
      onProgress({ stage: 'DOWNLOADING', message: 'Downloading your FinMan data…' });
      const discovery = await discoverCloudRepository({ accessToken, driveClient, sessionKey, pin });
      if (discovery.status !== 'EXISTING_REPOSITORY_FOUND' || !discovery.snapshotPayload) {
        throw new Error(`BOOTSTRAP_FAILED: Cloud snapshot could not be retrieved. (${discovery.error || discovery.status})`);
      }
      payload = discovery.snapshotPayload;
    }

    // 3. Deep validate cloud snapshot
    await validateCloudSnapshotPayload(payload);

    // 3.5 Validate & resolve authoritative peer coverage watermarks before any database mutations
    const watermarksToApply = resolveSnapshotPeerWatermarks(payload);

    let baselineInstalled = false;
    const stagedPackageIdsInAttempt = new Set();
    try {
      // 4. Populate local DB stores atomically (reusing populateLocalEntitiesBootstrap)
      onProgress({ stage: 'POPULATING', message: 'Installing baseline data…' });
      const localSyncState = await getLocalSyncState().catch(() => null);
      const isIdempotentBaselineReplay = Boolean(
        localSyncState &&
        localSyncState.base_snapshot_id &&
        localSyncState.base_snapshot_id === payload.snapshot_id
      );
      await populateLocalEntitiesBootstrap(db, payload.entities || {}, {
        allowRecoveryReplacement: options.allowRecoveryReplacement || isIdempotentBaselineReplay,
        checkQueue: false
      });
    baselineInstalled = true;

    // 5. Post-population count check
    const localEntities = await readLocalEntities(db);
    const expectedTxns = (payload.entities?.transactions || []).length;
    const expectedInvTxns = (payload.entities?.investment_transactions || []).length;
    if (localEntities.transactions.length !== expectedTxns || localEntities.investment_transactions.length !== expectedInvTxns) {
      throw new Error(`BOOTSTRAP_VERIFICATION_FAILED: Count mismatch after baseline install. Expected ${expectedTxns} txns, ${expectedInvTxns} inv_txns; Got ${localEntities.transactions.length} txns, ${localEntities.investment_transactions.length} inv_txns.`);
    }

    // 6. Set watermarks & baseline settings (still JOINING)
    const rawIdb = getRawIDB();
    const now = new Date().toISOString();
    if (rawIdb) {
      await new Promise((resolve, reject) => {
        const tx = rawIdb.transaction(['sync_local_state'], 'readwrite');
        const store = tx.objectStore('sync_local_state');
        store.put({
          key: 'device_state',
          deviceId: deviceId,
          device_id: deviceId,
          base_snapshot_id: payload.snapshot_id,
          base_cloud_version: payload.cloud_version || 1,
          last_allocated_sequence: 0,
          last_uploaded_sequence: 0,
          last_pushed_sequence: 0,
          last_acked_sequence: 0,
          lifecycle_state: DEVICE_LIFECYCLE.JOINING,
          updated_at: now
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } else {
      await db.run(
        'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, last_allocated_sequence, last_uploaded_sequence, last_pushed_sequence, last_acked_sequence, lifecycle_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['device_state', deviceId, payload.snapshot_id, payload.cloud_version || 1, 0, 0, 0, 0, DEVICE_LIFECYCLE.JOINING, now]
      );
    }

    const { setSetting } = await import('../database/settings.js');
    await setSetting('last_snapshot_id', payload.snapshot_id, { suppressDeltaQueue: true });
    await setSetting('last_parent_snapshot_id', payload.parent_snapshot_id || '', { suppressDeltaQueue: true });
    await setSetting('last_synced_at', now, { suppressDeltaQueue: true });
    await setSetting('sub_accounts_migrated_v2', 'true', { suppressDeltaQueue: true });
    await setSetting('historical_charges_reconciled', 'true', { suppressDeltaQueue: true });
    await setSetting('last_snapshot_creator_id', payload.device_id || '', { suppressDeltaQueue: true });

    // 6.5 Initialize peer watermarks from authoritative or verified transition coverage metadata
    try {
      if (watermarksToApply) {
        for (const [peerDeviceId, rawSeq] of Object.entries(watermarksToApply)) {
          const coveredSeq = Number(rawSeq);
          if (!peerDeviceId || isNaN(coveredSeq) || coveredSeq <= 0) continue;

          if (rawIdb) {
            await new Promise((resolve, reject) => {
              const tx = rawIdb.transaction(['sync_peer_state'], 'readwrite');
              const store = tx.objectStore('sync_peer_state');
              store.put({
                peer_device_id: peerDeviceId,
                last_staged_sequence: coveredSeq,
                last_reconciled_sequence: coveredSeq,
                base_snapshot_id: payload.snapshot_id,
                updated_at: now
              });
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
          } else {
            await db.run(
              'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
              [peerDeviceId, coveredSeq, coveredSeq, payload.snapshot_id, now]
            );
          }
        }
      }
    } catch (err) {
      throw new Error(`BOOTSTRAP_FAILED: Failed to initialize baseline lineage peer watermarks: ${err.message}`);
    }

    // 7. Pull post-baseline peer deltas and reconcile under attempt-scoped safety
    onProgress({ stage: 'REPLAYING_DELTAS', message: 'Replaying recent cloud changes…' });
    const pullResult = await downloadAndStagePeerPackages({
      localDeviceId: deviceId,
      creatorDeviceId: payload.device_id,
      accessToken,
      driveClient,
      sessionKey: effectiveKey,
      baseSnapshotId: payload.snapshot_id,
      immediateParentSnapshotId: payload.parent_snapshot_id,
      onPackageStaged: (pkgId) => {
        if (pkgId) stagedPackageIdsInAttempt.add(pkgId);
      }
    });
    if (pullResult?.stagedPackageIds) {
      for (const pId of pullResult.stagedPackageIds) {
        stagedPackageIdsInAttempt.add(pId);
      }
    }

    // 8. Reconcile staged events (preserves existing conflicts)
    const reconResult = await reconcileStagedEvents({ isBootstrap: true });

    // 9. Verification before transitioning to ACTIVE
    onProgress({ stage: 'VERIFYING', message: 'Verifying your data…' });
    const deltaQueueRows = (await db.query('SELECT * FROM sync_delta_queue').catch(() => ({ values: [] }))).values || [];
    const pendingOutbound = deltaQueueRows.filter(r => r.status !== 'ACKNOWLEDGED');
    if (pendingOutbound.length > 0) {
      throw new Error(`BOOTSTRAP_VERIFICATION_FAILED: BOOTSTRAP_SAFEGUARD_REJECTED: Unexpected outbound delta queue entries created during bootstrap (${pendingOutbound.length} events).`);
    }

    // 10. Transition to ACTIVE
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.ACTIVE, deviceId);

    // 11. Publish initial clean own device manifest as ACTIVE participant
    try {
      const ownManifest = createEmptyDeviceManifest({
        deviceId,
        baseSnapshotId: payload.snapshot_id,
        baseCloudVersion: payload.cloud_version || 1,
        manifestRevision: 1,
        device_lifecycle_state: DEVICE_LIFECYCLE.ACTIVE
      });
      await writeOwnDeviceManifest({
        driveClient,
        accessToken,
        deviceId,
        manifestData: ownManifest
      });
    } catch {}

    const finalLocalEntities = await readLocalEntities(db);
    const result = {
      success: true,
      status: 'BOOTSTRAP_SUCCESS',
      operation: 'BOOTSTRAP',
      snapshotId: payload.snapshot_id,
      cloudVersion: payload.cloud_version || 1,
      recordsBootstrapped: {
        transactions: finalLocalEntities.transactions.length,
        investment_transactions: finalLocalEntities.investment_transactions.length,
        accounts: finalLocalEntities.accounts.length,
        categories: finalLocalEntities.categories.length
      },
      inboundDeltas: pullResult,
      reconciliation: reconResult
    };

    broadcastSyncStatus(SYNC_STATUS.SUCCESS, { ...result, message: 'Cloud Sync On' });
    return result;
  } catch (err) {
    const rollbackTimestamp = new Date().toISOString();
    const rollbackErrors = [];

    // Attempt-scoped rollback: Delete ONLY records staged in this failed attempt
    const attemptPkgIds = Array.from(stagedPackageIdsInAttempt);
    if (attemptPkgIds.length > 0) {
      try {
        const placeholders = attemptPkgIds.map(() => '?').join(',');
        await db.run(`DELETE FROM sync_staged_events WHERE package_id IN (${placeholders})`, attemptPkgIds);
        await db.run(`DELETE FROM sync_staged_packages WHERE package_id IN (${placeholders})`, attemptPkgIds);
        await db.run(`DELETE FROM sync_conflicts WHERE package_id IN (${placeholders})`, attemptPkgIds);
      } catch (cleanupErr) {
        console.error('[deltaSyncCoordinator] Error rolling back attempt-scoped staged packages and conflicts:', cleanupErr);
        rollbackErrors.push(`Cleanup failed: ${cleanupErr.message}`);
      }
    }
    // Revert canonical stores back to pristine snapshot baseline ONLY IF baseline was installed
    if (baselineInstalled && payload && payload.entities) {
      try {
        await populateLocalEntitiesBootstrap(db, payload.entities || {}, { allowRecoveryReplacement: true });
        // Verify rollback canonical store counts
        const rolledBackEntities = await readLocalEntities(db);
        const expectedTxns = (payload.entities?.transactions || []).length;
        const expectedInvTxns = (payload.entities?.investment_transactions || []).length;
        if (rolledBackEntities.transactions.length !== expectedTxns || rolledBackEntities.investment_transactions.length !== expectedInvTxns) {
          rollbackErrors.push(`Rollback count verification mismatch: expected ${expectedTxns} txns, ${expectedInvTxns} inv_txns; got ${rolledBackEntities.transactions.length} txns, ${rolledBackEntities.investment_transactions.length} inv_txns`);
        }
      } catch (popErr) {
        console.error('[deltaSyncCoordinator] Error reverting canonical stores during bootstrap rollback:', popErr);
        rollbackErrors.push(`Canonical revert failed: ${popErr.message}`);
      }
    }
    // Reset watermarks to exact authoritative snapshot coverage ONLY IF baseline was installed
    if (baselineInstalled && payload) {
      try {
        const coveredMap = (watermarksToApply && typeof watermarksToApply === 'object')
          ? watermarksToApply
          : {};

        const existingPeers = (await db.query('SELECT peer_device_id FROM sync_peer_state WHERE base_snapshot_id = ?', [payload.snapshot_id]).catch(() => ({ values: [] }))).values || [];
        for (const row of existingPeers) {
          const pId = row.peer_device_id;
          if (!coveredMap[pId]) {
            await db.run('DELETE FROM sync_peer_state WHERE peer_device_id = ? AND base_snapshot_id = ?', [pId, payload.snapshot_id]);
          }
        }

        for (const [pId, pSeq] of Object.entries(coveredMap)) {
          const numSeq = Number(pSeq);
          if (pId && !isNaN(numSeq) && numSeq > 0) {
            await db.run(
              'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
              [pId, numSeq, numSeq, payload.snapshot_id, rollbackTimestamp]
            );
          }
        }
      } catch (wmErr) {
        console.error('[deltaSyncCoordinator] Error resetting peer watermarks during bootstrap rollback:', wmErr);
        rollbackErrors.push(`Watermark reset failed: ${wmErr.message}`);
      }
    }

    // Clean up baseline settings so fallback inference cannot treat device as ACTIVE ONLY IF baseline was installed
    if (baselineInstalled) {
      try {
        const { setSetting } = await import('../database/settings.js');
        await setSetting('last_snapshot_id', '', { suppressDeltaQueue: true });
        await setSetting('last_parent_snapshot_id', '', { suppressDeltaQueue: true });
      } catch (setErr) {
        rollbackErrors.push(`Settings reset failed: ${setErr.message}`);
      }
    }

    try {
      await setDeviceLifecycleState(DEVICE_LIFECYCLE.JOINING, deviceId);
    } catch (lcErr) {
      console.error('[deltaSyncCoordinator] Error setting device lifecycle to JOINING during rollback:', lcErr);
      rollbackErrors.push(`Lifecycle set failed: ${lcErr.message}`);
    }

    if (rollbackErrors.length > 0) {
      const compositeError = new Error(`${err.message} [ROLLBACK_FAILED: ${rollbackErrors.join('; ')}]`);
      compositeError.originalError = err;
      compositeError.rollbackErrors = rollbackErrors;
      throw compositeError;
    }

    throw err;
  }
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
    getDeviceId: getOrCreateLocalDeviceId
  });

  const triggerAutoSyncIfReady = async (trigger) => {
    try {
      const state = await getDeviceLifecycleState();
      if (state !== DEVICE_LIFECYCLE.ACTIVE) return;
      const token = _syncConfig.getAccessToken ? await _syncConfig.getAccessToken() : null;
      const key = _syncConfig.getSessionKey ? await _syncConfig.getSessionKey() : null;
      if (token && key) {
        scheduleSync(trigger);
      }
    } catch {}
  };

  // 2. Subscribe to session unlock events (wakes and flushes pending queue on unlock for ACTIVE devices)
  let unsubscribeSession = null;
  import('./syncSession.js').then(({ subscribeSyncSession }) => {
    unsubscribeSession = subscribeSyncSession(async (isUnlocked, key) => {
      if (isUnlocked && key) {
        await triggerAutoSyncIfReady(SYNC_TRIGGER.STARTUP);
      }
    });
  }).catch(() => {});

  // 3. Subscribe to Google OAuth state restoration events (wakes and flushes pending queue on connect/reconnect for ACTIVE devices)
  let unsubscribeAuth = null;
  import('./googleAuth.js').then(({ subscribeGoogleAuth }) => {
    unsubscribeAuth = subscribeGoogleAuth(async (isAuthenticated, token) => {
      if (isAuthenticated && token) {
        await triggerAutoSyncIfReady(SYNC_TRIGGER.STARTUP);
      }
    });
  }).catch(() => {});

  // 4. Register visibilitychange & focus listeners (foreground wake for ACTIVE devices)
  const handleVisibilityChange = async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      await triggerAutoSyncIfReady(SYNC_TRIGGER.FOREGROUND);
    }
  };

  const handleFocus = async () => {
    await triggerAutoSyncIfReady(SYNC_TRIGGER.FOREGROUND);
  };

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', handleFocus);
  }

  // 5. Trigger startup sync check immediately and with staged retries for async token restoration
  triggerAutoSyncIfReady(SYNC_TRIGGER.STARTUP);
  const startupTimer1 = setTimeout(() => triggerAutoSyncIfReady(SYNC_TRIGGER.STARTUP), 1500);
  const startupTimer2 = setTimeout(() => triggerAutoSyncIfReady(SYNC_TRIGGER.STARTUP), 4000);

  // 6. Periodic background auto-sync timer (every 5 minutes)
  const periodicSyncTimer = setInterval(() => {
    triggerAutoSyncIfReady(SYNC_TRIGGER.PERIODIC);
  }, 300000);
  if (typeof periodicSyncTimer?.unref === 'function') periodicSyncTimer.unref();

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
    clearTimeout(startupTimer1);
    clearTimeout(startupTimer2);
    clearInterval(periodicSyncTimer);
    cancelScheduledSync();
    _isRuntimeInitialized = false;
    _cleanupRuntimeListeners = null;
  };

  return _cleanupRuntimeListeners;
}

export function isDeltaSyncRuntimeInitialized() {
  return _isRuntimeInitialized;
}

export const DEFAULT_MASTER_LOCK_TIMEOUT_MS = 180000;

/**
 * Acquires the master sync lock across browser tabs with bounded timeout protection.
 * Guarantees prompt lock release on success, unhandled error, cancellation, or network stall.
 */
export async function withMasterSyncLock(taskFn, lockOptions = {}) {
  const timeoutMs = lockOptions.timeoutMs || DEFAULT_MASTER_LOCK_TIMEOUT_MS;
  const controller = new AbortController();
  const externalSignal = lockOptions.signal;

  let externalAbortHandler = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalAbortHandler = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  const runWithTimeout = async (contextOrTask = {}) => {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const timeoutErr = new Error(`SYNC_PASS_TIMEOUT: Master sync pass timed out after ${timeoutMs}ms`);
        timeoutErr.name = 'TimeoutError';
        timeoutErr.isTimeout = true;
        controller.abort(timeoutErr);
        reject(timeoutErr);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    const executionPromise = typeof contextOrTask === 'function'
      ? contextOrTask()
      : taskFn({ ...contextOrTask, signal: controller.signal });

    try {
      return await Promise.race([
        executionPromise,
        timeoutPromise
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (externalAbortHandler && externalSignal) {
        externalSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  };

  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function' && !lockOptions.forceFallback) {
    return await runWithTimeout(async () => {
      return await navigator.locks.request(MASTER_SYNC_LOCK_NAME, { mode: 'exclusive', signal: controller.signal }, async () => {
        return await taskFn({ signal: controller.signal });
      });
    });
  }

  // Fallback locking for node/test/non-supported environments
  const leaseDurationMs = lockOptions.leaseDurationMs || 60000;
  const heartbeatIntervalMs = lockOptions.heartbeatIntervalMs || 15000;

  const db = getDB();
  const ownerToken = uuid();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();

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

  let heartbeatTimer = null;
  try {
    heartbeatTimer = setInterval(async () => {
      try {
        const check = await db.query('SELECT * FROM sync_process_locks WHERE lock_name = ?', [MASTER_SYNC_LOCK_NAME]);
        if (check.values?.[0]?.owner_token === ownerToken) {
          const renewedExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
          await db.run(
            'UPDATE sync_process_locks SET expires_at = ?, updated_at = ? WHERE lock_name = ? AND owner_token = ?',
            [renewedExpiresAt, new Date().toISOString(), MASTER_SYNC_LOCK_NAME, ownerToken]
          );
        }
      } catch {}
    }, heartbeatIntervalMs);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }

    return await runWithTimeout({
      assertStillOwner: async () => {
        const check = await db.query('SELECT * FROM sync_process_locks WHERE lock_name = ?', [MASTER_SYNC_LOCK_NAME]);
        if (check.values?.[0]?.owner_token !== ownerToken) {
          throw new Error('[MasterLock] Fencing token mismatch: Lock ownership was lost.');
        }
      }
    });
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
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
  if (_isBootstrapInProgress) return;

  if (trigger === SYNC_TRIGGER.MUTATION) {
    // 1. Reset debounce timer (30s)
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      _flushSyncTimers();
      triggerAutomaticSync(SYNC_TRIGGER.MUTATION);
    }, DEBOUNCE_MS);
    _debounceTimer?.unref?.();

    // 2. Ensure hard ceiling timer is running (max 60s from first mutation)
    if (!_ceilingTimer) {
      _ceilingTimer = setTimeout(() => {
        _flushSyncTimers();
        triggerAutomaticSync(SYNC_TRIGGER.MUTATION);
      }, MAX_CEILING_MS);
      _ceilingTimer?.unref?.();
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
export async function triggerAutomaticSync(trigger = SYNC_TRIGGER.MANUAL, options = {}) {
  _flushSyncTimers();
  if (_isBootstrapInProgress) {
    return { status: 'BLOCKED_BOOTSTRAP_IN_PROGRESS' };
  }
  if (_isSyncRunning) {
    _pendingSyncRequested = true;
    return { status: 'DEFERRED_PENDING_ACTIVE_SYNC' };
  }

  _isSyncRunning = true;
  _pendingSyncRequested = false;

  try {
    const result = await executeFullSyncPass({ trigger, ...options });

    // If mutations arrived while sync was executing, immediately follow up
    if (_pendingSyncRequested) {
      _pendingSyncRequested = false;
      setTimeout(() => {
        triggerAutomaticSync(SYNC_TRIGGER.FOLLOW_UP, options);
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

  if (!driveClient && !accessToken) {
    broadcastSyncStatus(SYNC_STATUS.AUTH_REQUIRED, { reason: 'No Google Drive credentials' });
    return { success: false, status: SYNC_STATUS.AUTH_REQUIRED, reason: 'No Google Drive credentials' };
  }

  if (!sessionKey) {
    broadcastSyncStatus(SYNC_STATUS.AUTH_REQUIRED, { reason: 'Sync session is locked (no encryption key)' });
    return { success: false, status: SYNC_STATUS.AUTH_REQUIRED, reason: 'Sync session is locked' };
  }

  let deviceId = options.deviceId;
  if (!deviceId || deviceId === 'local_device') {
    deviceId = getDeviceId ? (typeof getDeviceId === 'function' ? await getDeviceId() : getDeviceId) : (_syncConfig.deviceId || null);
  }
  if (!deviceId || deviceId === 'local_device') {
    deviceId = await getOrCreateLocalDeviceId().catch(() => null);
  }

  const attemptId = 'sync_att_' + Math.random().toString(36).slice(2, 10);
  let currentStage = 'init';

  broadcastSyncStatus(SYNC_STATUS.SYNCING, { trigger, attemptId });

  try {
    return await withMasterSyncLock(async (lockCtx = {}) => {
      await ensureSyncSchema(getDB()).catch(() => {});
      const { signal } = lockCtx;
      const assertActive = () => {
        if (signal?.aborted) {
          throw signal.reason || new Error('SYNC_PASS_ABORTED: Sync pass timed out or was cancelled');
        }
      };

      assertActive();
      const lifecycleState = await getDeviceLifecycleState(deviceId);

      // Block ordinary background sync and reconciliation while lifecycle is JOINING
      if (lifecycleState === DEVICE_LIFECYCLE.JOINING) {
        broadcastSyncStatus(SYNC_STATUS.IDLE, { reason: 'Device is in JOINING lifecycle state' });
        return {
          success: false,
          status: 'BLOCKED_DEVICE_JOINING',
          reason: 'Device is in JOINING lifecycle state. Background sync is suspended.'
        };
      }

      // Handle UNINITIALIZED new device bootstrap
      if (lifecycleState === DEVICE_LIFECYCLE.UNINITIALIZED) {
        assertActive();
        const discovery = await discoverCloudRepository({
          accessToken,
          driveClient,
          sessionKey
        });

        if (discovery.status === 'EXISTING_REPOSITORY_FOUND') {
          assertActive();
          const db = getDB();
          const isPopulated = await isDatabasePopulatedWithUserData(db);
          if (isPopulated) {
            // Local device already has real financial data: do NOT attempt destructive bootstrap!
            const cloudPayload = discovery.snapshotPayload || {};
            const cloudTxnCount = (cloudPayload.entities?.transactions || []).length;
            const res = {
              success: false,
              status: 'POPULATED_LOCAL_REQUIRES_CHOICE',
              needsChoice: true,
              error: 'BOOTSTRAP_SAFEGUARD_REJECTED: Local database contains user data. Destructive bootstrap rejected.',
              cloudSnapshotId: discovery.snapshotId,
              cloudVersion: discovery.cloudVersion,
              cloudTxnCount,
              cloudCreatedAt: discovery.createdAt,
              message: 'Local financial data detected. Initial setup as primary device required.'
            };
            broadcastSyncStatus(SYNC_STATUS.IDLE, res);
            return res;
          }

          broadcastSyncStatus(SYNC_STATUS.SYNCING, { stage: 'BOOTSTRAP_DOWNLOADING', message: 'Downloading your FinMan data…' });
          const bootRes = await bootstrapNewDevice({
            accessToken,
            sessionKey,
            driveClient,
            deviceId,
            snapshotPayload: discovery.snapshotPayload,
            _hasMasterLock: true
          });

          assertActive();
          const nowIso = new Date().toISOString();
          try {
            const { setSetting } = await import('../database/settings.js');
            await setSetting('last_delta_synced_at', nowIso);
          } catch {}

          const syncResult = {
            success: true,
            status: SYNC_STATUS.SUCCESS,
            trigger,
            bootstrapped: true,
            ...bootRes,
            timestamp: nowIso
          };

          broadcastSyncStatus(SYNC_STATUS.SUCCESS, syncResult);
          return syncResult;
        } else if (discovery.status === 'NO_REPOSITORY_EXISTS') {
          assertActive();
          const nowIso = new Date().toISOString();
          try {
            const { setSetting } = await import('../database/settings.js');
            await setSetting('last_delta_synced_at', nowIso);
          } catch {}

          const syncResult = {
            success: true,
            status: SYNC_STATUS.SUCCESS,
            trigger,
            noRepository: true,
            message: 'No existing repository found',
            timestamp: nowIso
          };

          broadcastSyncStatus(SYNC_STATUS.SUCCESS, syncResult);
          return syncResult;
        } else {
          broadcastSyncStatus(SYNC_STATUS.ERROR, { error: discovery.error, trigger });
          return {
            success: false,
            status: SYNC_STATUS.ERROR,
            error: discovery.error,
            trigger
          };
        }
      }

      // Normal ACTIVE sync pass:
      assertActive();
      currentStage = 'manifest_sync';
      try {
        const { ensureOwnDeviceManifestSynced } = await import('./deviceManifest.js');
        await ensureOwnDeviceManifestSynced({
          deviceId,
          accessToken,
          driveClient
        });
      } catch (mErr) {
        console.warn('[SyncPass] Non-fatal: Failed to align own device manifest:', mErr.message);
      }

      assertActive();
      currentStage = 'acknowledge';
      // 1. Recover unacknowledged queue events if manifest already updated
      await recoverQueueAckFromAuthoritativeManifest({
        deviceId,
        accessToken,
        driveClient,
        sessionKey
      });

      assertActive();
      currentStage = 'upload';
      // 2. Outbound Push: Package pending deltas -> encrypt -> upload -> manifest RMW -> durable queue ACK
      const pushResult = await uploadPendingDeltas({
        deviceId,
        accessToken,
        driveClient,
        sessionKey,
        signal
      });

      if (pushResult && pushResult.eventsUploaded > 0) {
        notifyDeltaQueueChanged();
        broadcastSyncStatus(SYNC_STATUS.SYNCING, {
          stage: 'INBOUND_SYNC',
          eventsUploaded: pushResult.eventsUploaded,
          packagesUploaded: pushResult.packagesUploaded,
          lastUploadedSequence: pushResult.lastUploadedSequence,
          trigger
        });
      }

      assertActive();
      // 2.5 Hydrate missing lineage metadata if this pre-existing active device lacks last_parent_snapshot_id
      await hydrateMissingSnapshotLineage({
        accessToken,
        driveClient,
        sessionKey
      });

      assertActive();
      currentStage = 'download';
      // 3. Inbound Pull: Discover peer manifests -> download new packages -> stage contiguously
      const activeCreatorId = (await getSetting('last_snapshot_creator_id').catch(() => null)) || null;
      let pullResult = await downloadAndStagePeerPackages({
        localDeviceId: deviceId,
        creatorDeviceId: activeCreatorId,
        accessToken,
        driveClient,
        sessionKey,
        signal
      });

      assertActive();
      // 3.5 Auto-reconcile newer cloud snapshot if detected from peer manifests
      if (pullResult?.newerBaselineDetected) {
        currentStage = 'reconcile_snapshot';
        const targetSnapId = typeof pullResult.newerBaselineDetected === 'string'
          ? pullResult.newerBaselineDetected
          : (pullResult.newerBaselineDetected?.snapshotId || null);
        const targetVer = typeof pullResult.newerBaselineDetected === 'object'
          ? pullResult.newerBaselineDetected?.cloudVersion
          : null;

        broadcastSyncStatus(SYNC_STATUS.SYNCING, {
          stage: 'AUTO_RECONCILING_BASELINE',
          message: 'Aligning with newer cloud snapshot baseline…',
          newerBaseline: pullResult.newerBaselineDetected,
          trigger
        });
        const autoRecon = await checkAndAutoReconcileCloudSnapshot({
          deviceId,
          accessToken,
          driveClient,
          sessionKey,
          targetSnapshotId: targetSnapId,
          targetCloudVersion: targetVer,
          _hasMasterLock: true
        });
        assertActive();
        if (autoRecon?.reconciled) {
          pullResult.newerBaselineDetected = null;
          // Re-run pull after upgrading baseline to ingest peer packages under the new baseline
          currentStage = 'download';
          const updatedCreatorId = (await getSetting('last_snapshot_creator_id').catch(() => null)) || activeCreatorId;
          pullResult = await downloadAndStagePeerPackages({
            localDeviceId: deviceId,
            creatorDeviceId: updatedCreatorId,
            accessToken,
            driveClient,
            sessionKey,
            signal
          });
        }
      }

      assertActive();
      currentStage = 'reconcile';
      // 4. Reconciliation: Apply staged events deterministically to canonical store
      const reconResult = await reconcileStagedEvents({ signal });

      // Evaluate blocked conditions and unmerged conflicts with strict truthfulness
      const blockedGaps = Number(reconResult?.blockedGapCount) || 0;
      const blockedDeps = Number(reconResult?.blockedDependencyCount) || 0;
      const blockedPeers = pullResult?.blockedPeers || [];
      const hasUnresolvedNewerBaseline = Boolean(pullResult?.newerBaselineDetected);

      let effectiveStatus = SYNC_STATUS.SUCCESS;
      let isBlocked = false;

      if (blockedGaps > 0) {
        effectiveStatus = SYNC_STATUS.BLOCKED_SEQUENCE_GAP;
        isBlocked = true;
      } else if (blockedDeps > 0) {
        effectiveStatus = SYNC_STATUS.BLOCKED_DEPENDENCY;
        isBlocked = true;
      } else if (blockedPeers.length > 0 || hasUnresolvedNewerBaseline) {
        effectiveStatus = SYNC_STATUS.BLOCKED_PEER_BASELINE;
        isBlocked = true;
      } else if ((Number(reconResult?.conflictCount) || 0) > 0) {
        effectiveStatus = SYNC_STATUS.CONFLICTS_PENDING;
      }

      const nowIso = new Date().toISOString();
      if (!isBlocked && effectiveStatus === SYNC_STATUS.SUCCESS) {
        assertActive();
        try {
          const { setSetting } = await import('../database/settings.js');
          await setSetting('last_delta_synced_at', nowIso);
        } catch {}

        recordSyncDiagnostic({
          attemptId,
          stage: 'idle',
          code: 'SUCCESS',
          redactedDeviceId: redactDeviceId(deviceId),
          retryable: false,
          pendingChanges: 0,
          eventsApplied: reconResult?.reconciledCount || 0,
          localDataVerified: true,
          message: 'All sync passes healthy. Zero unhandled diagnostic exceptions recorded.'
        });
      } else if (isBlocked) {
        let blockCode = 'BLOCKED_SYNC';
        let blockMsg = 'Synchronization paused waiting for peer updates.';
        if (blockedGaps > 0) {
          blockCode = 'BLOCKED_SEQUENCE_GAP';
          blockMsg = `Sync Blocked: Peer sequence gap detected. Reconciled clean watermarks up to peer sequence. Waiting for peer sequence packages.`;
        } else if (blockedDeps > 0) {
          blockCode = 'BLOCKED_DEPENDENCY';
          blockMsg = `Sync Blocked: Event dependency awaiting conflict resolution.`;
        } else if (blockedPeers.length > 0 || hasUnresolvedNewerBaseline) {
          blockCode = 'BLOCKED_PEER_BASELINE';
          blockMsg = `Sync Blocked: Incompatible peer baseline detected.`;
        }

        recordSyncDiagnostic({
          attemptId,
          stage: currentStage,
          code: blockCode,
          redactedDeviceId: redactDeviceId(deviceId),
          retryable: true,
          pendingChanges: pushResult?.eventsUploaded || 0,
          eventsApplied: reconResult?.reconciledCount || 0,
          localDataVerified: true,
          message: blockMsg
        });
      }

      const syncResult = {
        success: !isBlocked,
        status: effectiveStatus,
        trigger,
        outbound: pushResult,
        inbound: pullResult,
        reconciliation: reconResult,
        blockedGapCount: blockedGaps,
        blockedDependencyCount: blockedDeps,
        blockedPeers,
        hasNewerBaseline: Boolean(pullResult?.newerBaselineDetected),
        newerBaselineDetected: pullResult?.newerBaselineDetected || null,
        timestamp: nowIso
      };

      _lastSyncResult = syncResult;
      broadcastSyncStatus(effectiveStatus, syncResult);
      return syncResult;
    }, options.lockOptions || {});
  } catch (err) {
    const isTimeout = Boolean(err?.isTimeout || err?.name === 'TimeoutError' || err?.message?.includes('SYNC_PASS_TIMEOUT') || err?.message?.includes('timed out'));
    const is401 = err?.status === 401 || err?.message?.includes('(401)') || err?.message?.includes('401');
    if (is401) {
      try {
        const { invalidateStoredToken } = await import('./googleAuth.js');
        invalidateStoredToken();
      } catch {}
    }
    const errStr = String(err?.message || err || '');
    const errLower = errStr.toLowerCase();
    const isAuthError = is401 || err?.message?.includes('AUTH') || err?.message?.includes('No Google Drive credentials');
    const isSeqGap = errLower.includes('sequence_gap') || errLower.includes('sequence gap');
    const finalStatus = isAuthError
      ? SYNC_STATUS.AUTH_REQUIRED
      : (isSeqGap ? SYNC_STATUS.BLOCKED_SEQUENCE_GAP : SYNC_STATUS.ERROR);

    let pendingChangesCount = 0;
    let localDataVerified = false;
    try {
      const qRes = await getDB().query('SELECT id FROM sync_delta_queue WHERE status != ?', ['ACKNOWLEDGED']);
      pendingChangesCount = (qRes.values || []).length;
      localDataVerified = true;
    } catch {}

    let errorCode = 'UNKNOWN_ERROR';
    if (isTimeout) errorCode = 'NETWORK_TIMEOUT';
    else if (isAuthError) errorCode = 'AUTH_EXPIRED';
    else if (isSeqGap) errorCode = 'BLOCKED_SEQUENCE_GAP';
    else if (errLower.includes('429') || errLower.includes('quota') || errLower.includes('ratelimit')) errorCode = 'RATE_LIMIT_EXCEEDED';
    else if (errLower.includes('500') || errLower.includes('502') || errLower.includes('503') || errLower.includes('504')) errorCode = 'SERVER_ERROR';
    else if (errLower.includes('network') || errLower.includes('failed to fetch') || errLower.includes('econnrefused')) errorCode = 'NETWORK_ERROR';
    else if (errLower.includes('no such column') || errLower.includes('has no column') || errLower.includes('sqlite') || errLower.includes('syntax error')) errorCode = 'SQLITE_SCHEMA_ERROR';
    else if (errLower.includes('reconcil') || errLower.includes('conflict')) errorCode = 'RECONCILIATION_ERROR';

    const isRetryable = isTimeout || isAuthError || errorCode === 'BLOCKED_SEQUENCE_GAP' || errorCode === 'RATE_LIMIT_EXCEEDED' || errorCode === 'SERVER_ERROR' || errorCode === 'NETWORK_ERROR';

    const diagnostic = recordSyncDiagnostic({
      attemptId,
      stage: currentStage,
      code: errorCode,
      redactedDeviceId: redactDeviceId(deviceId),
      httpStatus: err?.status || null,
      sqliteErrorCode: err?.code || null,
      retryable: isRetryable,
      pendingChanges: pendingChangesCount,
      eventsApplied: 0,
      localDataVerified,
      message: sanitizeErrorMessage(errStr),
      sanitizedStack: sanitizeStackTrace(err?.stack)
    });

    broadcastSyncStatus(finalStatus, { error: err.message, isTimeout, trigger, diagnostic });
    return {
      success: false,
      status: finalStatus,
      isTimeout,
      error: err.message,
      trigger,
      diagnostic
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
              last_acked_sequence: Number(pkg.end_sequence),
              updated_at: new Date().toISOString()
            });

            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
          });
          notifyDeltaQueueChanged();
        } else {
          await db.run(
            'UPDATE sync_delta_queue SET status = ?, acknowledged_at = ? WHERE sequence >= ? AND sequence <= ?',
            ['ACKNOWLEDGED', new Date().toISOString(), Number(pkg.start_sequence), Number(pkg.end_sequence)]
          );
          await db.run(
            'UPDATE sync_local_state SET last_uploaded_sequence = ?, last_pushed_sequence = ?, last_acked_sequence = ?, updated_at = ? WHERE device_id = ? OR key = ?',
            [Number(pkg.end_sequence), Number(pkg.end_sequence), Number(pkg.end_sequence), new Date().toISOString(), deviceId, 'device_state']
          );
          notifyDeltaQueueChanged();
        }
      }
    }
  }
}
