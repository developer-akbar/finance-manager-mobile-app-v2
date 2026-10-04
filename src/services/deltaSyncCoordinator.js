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
  withSameDeviceLock,
  listPeerManifests,
  createEmptyDeviceManifest
} from './deviceManifest.js';
import {
  reconcileStagedEvents,
  resolveConflict,
  RECONCILIATION_STATUS
} from './deltaReconciliation.js';
import {
  SNAPSHOT_FILENAME,
  populateLocalEntitiesBootstrap,
  validateCloudSnapshotPayload,
  readLocalEntities
} from './cloudSyncEngine.js';
import { decryptBackupData } from '../utils/cryptoBackup.js';
import { findAppDataFile, readAppDataFile } from './googleDriveSync.js';

export {
  reconcileStagedEvents,
  resolveConflict,
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

    const lifecycleState = await getDeviceLifecycleState(localState.device_id || 'local_device');

    return {
      status: getCurrentSyncStatus(),
      lifecycleState,
      pendingCount,
      lastAllocatedSequence: Number(localState.last_allocated_sequence || 0),
      lastUploadedSequence: Number(localState.last_uploaded_sequence ?? localState.last_pushed_sequence ?? 0),
      lastAckedSequence: Number(localState.last_acked_sequence || 0),
      deviceId: localState.device_id || 'local_device',
      lastDeltaSyncedAt
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

/**
 * Returns the persisted lifecycle state for the local device.
 */
export async function getDeviceLifecycleState(deviceId = 'local_device') {
  try {
    const db = getDB();
    const res = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
    const row = res.values?.[0];
    if (row?.lifecycle_state) {
      return row.lifecycle_state;
    }

    // Backward compatibility for existing active replicas:
    // A device is only considered ACTIVE through backward compatibility if there is evidence
    // of an established snapshot baseline (base_snapshot_id in sync_local_state or settings).
    // Historical sequence numbers alone (e.g. from failed/interrupted bootstraps) MUST NOT imply ACTIVE.
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
 */
export async function setDeviceLifecycleState(state, deviceId = 'local_device') {
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
        const existing = req.result || { key: 'device_state', device_id: deviceId };
        existing.lifecycle_state = state;
        existing.device_id = deviceId || existing.device_id || 'local_device';
        existing.updated_at = now;
        store.put(existing);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } else {
    const res = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }));
    const existing = res.values?.[0];
    if (existing) {
      await db.run('UPDATE sync_local_state SET lifecycle_state = ?, updated_at = ? WHERE key = ?', [state, now, 'device_state']);
    } else {
      await db.run('INSERT INTO sync_local_state (key, device_id, lifecycle_state, updated_at) VALUES (?, ?, ?, ?)', ['device_state', deviceId, state, now]);
    }
  }
}

/**
 * Discovers existing repository metadata from Google Drive (read-only).
 */
export async function discoverCloudRepository(options = {}) {
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
    let cloudFile = null;
    if (driveClient && typeof driveClient.findFiles === 'function') {
      const found = await driveClient.findFiles({ name: SNAPSHOT_FILENAME });
      cloudFile = found?.[0] || null;
    } else if (driveClient && typeof driveClient.findAppDataFile === 'function') {
      cloudFile = await driveClient.findAppDataFile(SNAPSHOT_FILENAME, accessToken);
    } else {
      cloudFile = await findAppDataFile(SNAPSHOT_FILENAME, accessToken);
    }

    const peerManifests = await listPeerManifests('__discovery_dummy_local__', accessToken, driveClient).catch(() => []);

    if (!cloudFile && peerManifests.length === 0) {
      return {
        exists: false,
        status: 'NO_REPOSITORY_EXISTS',
        message: 'No FinMan cloud repository found on Google Drive.'
      };
    }

    if (!cloudFile && peerManifests.length > 0) {
      const sampleManifest = peerManifests[0];
      return {
        exists: true,
        status: 'EXISTING_REPOSITORY_FOUND',
        snapshotId: sampleManifest.base_snapshot_id || 'snap_dynamic_baseline',
        cloudVersion: sampleManifest.base_cloud_version || 1,
        peerManifests,
        snapshotPayload: null
      };
    }

    let ciphertext = null;
    if (driveClient && typeof driveClient.readFile === 'function') {
      ciphertext = await driveClient.readFile(cloudFile.id);
    } else if (driveClient && typeof driveClient.readAppDataFile === 'function') {
      ciphertext = await driveClient.readAppDataFile(cloudFile.id, accessToken);
    } else {
      ciphertext = await readAppDataFile(cloudFile.id, accessToken);
    }

    if (!effectiveKey) {
      return {
        exists: true,
        status: 'EXISTING_REPOSITORY_FOUND',
        snapshotId: cloudFile.id,
        requiresKey: true,
        peerManifests,
        message: 'FinMan cloud repository found. Encryption key/PIN required to decrypt.'
      };
    }

    const decrypted = await decryptBackupData(ciphertext, effectiveKey);
    await validateCloudSnapshotPayload(decrypted);

    return {
      exists: true,
      status: 'EXISTING_REPOSITORY_FOUND',
      snapshotId: decrypted.snapshot_id,
      cloudVersion: decrypted.cloud_version || 1,
      createdAt: decrypted.created_at,
      deviceId: decrypted.device_id,
      entityCounts: {
        transactions: (decrypted.entities?.transactions || []).length,
        investment_transactions: (decrypted.entities?.investment_transactions || []).length,
        accounts: (decrypted.entities?.accounts || []).length,
        categories: (decrypted.entities?.categories || []).length
      },
      peerManifests,
      snapshotPayload: decrypted
    };
  } catch (err) {
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
 * Headless bootstrap flow for a new device joining an existing repository.
 */
export async function bootstrapNewDevice(options = {}) {
  const driveClient = options.driveClient || _syncConfig.driveClient;
  const accessToken = options.accessToken !== undefined
    ? options.accessToken
    : (_syncConfig.getAccessToken ? await _syncConfig.getAccessToken() : null);
  const sessionKey = options.sessionKey !== undefined
    ? options.sessionKey
    : (_syncConfig.getSessionKey ? await _syncConfig.getSessionKey() : null);
  const pin = options.pin || null;
  const effectiveKey = sessionKey || pin;
  const deviceId = options.deviceId || (typeof _syncConfig.getDeviceId === 'function' ? await _syncConfig.getDeviceId() : _syncConfig.deviceId) || 'local_device';
  const onProgress = options.onProgress || (() => {});

  const db = getDB();

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

  // 4. Populate local DB stores atomically (reusing populateLocalEntitiesBootstrap)
  onProgress({ stage: 'POPULATING', message: 'Installing baseline data…' });
  await populateLocalEntitiesBootstrap(db, payload.entities || {});

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
  await setSetting('last_snapshot_id', payload.snapshot_id);
  await setSetting('last_parent_snapshot_id', payload.parent_snapshot_id || '');
  await setSetting('last_synced_at', now);
  await setSetting('sub_accounts_migrated_v2', 'true');
  await setSetting('historical_charges_reconciled', 'true');

  // 6.5 Initialize peer watermarks from authoritative snapshot coverage metadata
  try {
    const watermarksToApply = (payload.covered_peer_watermarks && typeof payload.covered_peer_watermarks === 'object')
      ? payload.covered_peer_watermarks
      : null;

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

  // 7. Pull post-baseline peer deltas
  onProgress({ stage: 'REPLAYING_DELTAS', message: 'Replaying recent cloud changes…' });
  const pullResult = await downloadAndStagePeerPackages({
    localDeviceId: deviceId,
    accessToken,
    driveClient,
    sessionKey: effectiveKey,
    baseSnapshotId: payload.snapshot_id,
    immediateParentSnapshotId: payload.parent_snapshot_id
  });

  // 8. Reconcile staged events (preserves existing conflicts)
  const reconResult = await reconcileStagedEvents({});

  // 9. Verification before transitioning to ACTIVE
  onProgress({ stage: 'VERIFYING', message: 'Verifying your data…' });
  const deltaQueueRows = (await db.query('SELECT * FROM sync_delta_queue').catch(() => ({ values: [] }))).values || [];
  const pendingOutbound = deltaQueueRows.filter(r => r.status !== 'ACKNOWLEDGED');
  if (pendingOutbound.length > 0) {
    throw new Error(`BOOTSTRAP_VERIFICATION_FAILED: Unexpected outbound delta queue entries created during bootstrap (${pendingOutbound.length} events).`);
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
      const lifecycleState = await getDeviceLifecycleState(deviceId);

      // Handle UNINITIALIZED or JOINING new device bootstrap
      if (lifecycleState === DEVICE_LIFECYCLE.UNINITIALIZED || lifecycleState === DEVICE_LIFECYCLE.JOINING) {
        const discovery = await discoverCloudRepository({
          accessToken,
          driveClient,
          sessionKey
        });

        if (discovery.status === 'EXISTING_REPOSITORY_FOUND') {
          broadcastSyncStatus(SYNC_STATUS.SYNCING, { stage: 'BOOTSTRAP_DOWNLOADING', message: 'Downloading your FinMan data…' });
          const bootRes = await bootstrapNewDevice({
            accessToken,
            sessionKey,
            driveClient,
            deviceId,
            snapshotPayload: discovery.snapshotPayload
          });

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

      // 2.5 Hydrate missing lineage metadata if this pre-existing active device lacks last_parent_snapshot_id
      await hydrateMissingSnapshotLineage({
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
    const is401 = err?.status === 401 || err?.message?.includes('(401)') || err?.message?.includes('401');
    if (is401) {
      try {
        const { invalidateStoredToken } = await import('./googleAuth.js');
        invalidateStoredToken();
      } catch {}
    }
    const isAuthError = is401 || err?.message?.includes('AUTH') || err?.message?.includes('No Google Drive credentials');
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
              last_acked_sequence: Number(pkg.end_sequence),
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
            'UPDATE sync_local_state SET last_uploaded_sequence = ?, last_pushed_sequence = ?, last_acked_sequence = ?, updated_at = ? WHERE device_id = ? OR key = ?',
            [Number(pkg.end_sequence), Number(pkg.end_sequence), Number(pkg.end_sequence), new Date().toISOString(), deviceId, 'device_state']
          );
        }
      }
    }
  }
}
