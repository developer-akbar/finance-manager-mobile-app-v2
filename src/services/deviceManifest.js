/**
 * deviceManifest.js — Per-Device Manifest Protocol & Local Writer Serialization
 * 
 * Implements Phase 7.3 per-device manifest operations:
 * 1. Sole-writer manifest ownership per device_id (manifest_dev_<deviceId>.json)
 * 2. Same-device multi-tab serialization via W3C Web Locks API (with safe fallback)
 * 3. Peer manifest discovery and schema validation
 */

import { v4 as uuid } from 'uuid';
import { getDB, getRawIDB } from '../database/db.js';
import { findAppDataFile, readAppDataFile, uploadAppDataFile, fetchWithTimeout } from './googleDriveSync.js';

export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Returns the standard Google Drive manifest filename for a device.
 */
export function getDeviceManifestFilename(deviceId) {
  if (!deviceId) throw new Error('Device ID is required to get manifest filename.');
  return `manifest_dev_${deviceId}.json`;
}

/**
 * Creates a valid, empty DeviceManifest data structure.
 */
export function createEmptyDeviceManifest(arg1, arg2, arg3, arg4) {
  let deviceId, deviceName, baseSnapshotId, baseCloudVersion, manifestRevision, lifecycleState, parentSnapshotId;
  if (arg1 && typeof arg1 === 'object') {
    deviceId = arg1.deviceId || arg1.device_id;
    deviceName = arg1.deviceName || arg1.device_name || 'FinMan Device';
    baseSnapshotId = arg1.baseSnapshotId || arg1.base_snapshot_id || 'snap_1790493064581_jbhnf8';
    baseCloudVersion = arg1.baseCloudVersion || arg1.base_cloud_version || 8;
    manifestRevision = arg1.manifestRevision || arg1.manifest_revision || 0;
    lifecycleState = arg1.device_lifecycle_state || arg1.lifecycleState || 'ACTIVE';
    parentSnapshotId = arg1.parentSnapshotId || arg1.parent_snapshot_id || null;
  } else {
    deviceId = arg1;
    baseSnapshotId = arg2 || 'snap_1790493064581_jbhnf8';
    baseCloudVersion = arg3 || 8;
    manifestRevision = arg4 || 0;
    deviceName = 'FinMan Device';
    lifecycleState = 'ACTIVE';
    parentSnapshotId = null;
  }

  if (!deviceId) throw new Error('Device ID is required to create a device manifest.');
  if (!baseSnapshotId) throw new Error('Base snapshot ID is required to create a device manifest.');

  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    manifest_type: 'DEVICE_MANIFEST',
    device_id: String(deviceId),
    device_name: String(deviceName),
    manifest_revision: Number(manifestRevision) || 0,
    revision: Number(manifestRevision) || 0,
    updated_at: new Date().toISOString(),
    base_snapshot_id: String(baseSnapshotId),
    base_cloud_version: Number(baseCloudVersion) || 8,
    parent_snapshot_id: parentSnapshotId ? String(parentSnapshotId) : null,
    last_sequence: 0,
    device_lifecycle_state: lifecycleState,
    watermarks: {
      last_allocated_sequence: 0,
      last_uploaded_sequence: 0,
      acknowledged_peer_sequences: {}
    },
    packages: []
  };
}

/**
 * Serializes same-device concurrent executions using Web Locks API or safe IDB fallback.
 * Guarantees that only ONE execution context on this device modifies manifest_dev_<deviceId>.json at a time.
 */
export async function withSameDeviceLock(deviceId, taskFn, lockOptions = {}) {
  if (!deviceId) throw new Error('Device ID is required for same-device locking.');

  const lockName = `finman_sync_lock_${deviceId}`;
  const timeoutMs = lockOptions.timeoutMs || 30000;

  const externalSignal = lockOptions.signal;
  let externalAbortHandler = null;

  const runWithTimeout = async (context = {}) => {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const timeoutErr = new Error(`DEVICE_LOCK_TIMEOUT: Same-device lock for ${deviceId} timed out after ${timeoutMs}ms`);
        timeoutErr.name = 'TimeoutError';
        timeoutErr.isTimeout = true;
        reject(timeoutErr);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      if (externalSignal) {
        if (externalSignal.aborted) {
          reject(externalSignal.reason || new Error('SYNC_PASS_ABORTED'));
        } else {
          externalAbortHandler = () => reject(externalSignal.reason || new Error('SYNC_PASS_ABORTED'));
          externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
        }
      }
    });

    try {
      return await Promise.race([
        taskFn(context),
        timeoutPromise
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (externalAbortHandler && externalSignal) {
        externalSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  };

  // 1. Primary path: W3C Web Locks API (authoritative browser concurrency mechanism)
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function' && !lockOptions.forceFallback) {
    return await navigator.locks.request(lockName, { mode: 'exclusive' }, async () => {
      return await runWithTimeout();
    });
  }

  // 2. Fallback path for environments without Web Locks
  const ownerToken = uuid();
  const acquired = await _acquireFallbackLock(lockName, ownerToken);
  if (!acquired) {
    throw new Error(`[Lock] Failed to acquire fallback sync lock for ${deviceId}. Another sync operation is active.`);
  }

  try {
    const result = await runWithTimeout({
      assertStillOwner: async () => {
        const stillOwner = await _checkFallbackLockOwner(lockName, ownerToken);
        if (!stillOwner) {
          throw new Error(`[Lock] Fencing token mismatch: Lock ownership for ${deviceId} was lost.`);
        }
      }
    });

    // Validate ownership immediately before completing / committing local state
    const stillOwner = await _checkFallbackLockOwner(lockName, ownerToken);
    if (!stillOwner) {
      throw new Error(`[Lock] Lost lock ownership during sync execution for ${deviceId}. Aborting commit.`);
    }

    return result;
  } finally {
    await _releaseFallbackLock(lockName, ownerToken);
  }
}

async function _acquireFallbackLock(lockName, ownerToken) {
  const db = getDB();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAtIso = new Date(now.getTime() + 30000).toISOString();

  try {
    const res = await db.query('SELECT * FROM sync_process_locks WHERE lock_name = ?', [lockName]);
    const existing = res.values?.[0];

    if (!existing || new Date(existing.expires_at || existing.heartbeat_at || 0).getTime() < now.getTime()) {
      await db.run(
        'INSERT OR REPLACE INTO sync_process_locks (lock_name, owner_token, expires_at, updated_at) VALUES (?, ?, ?, ?)',
        [lockName, ownerToken, expiresAtIso, nowIso]
      );
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function _checkFallbackLockOwner(lockName, ownerToken) {
  const db = getDB();
  try {
    const res = await db.query('SELECT * FROM sync_process_locks WHERE lock_name = ?', [lockName]);
    const row = res.values?.[0];
    return row && (row.owner_token === ownerToken || row.owner_id === ownerToken);
  } catch {
    return true;
  }
}

async function _releaseFallbackLock(lockName, ownerToken) {
  const db = getDB();
  try {
    const res = await db.query('SELECT * FROM sync_process_locks WHERE lock_name = ?', [lockName]);
    const row = res.values?.[0];
    if (row && (row.owner_token === ownerToken || row.owner_id === ownerToken)) {
      await db.run('DELETE FROM sync_process_locks WHERE lock_name = ?', [lockName]);
    }
  } catch {}
}

/**
 * Reads own device manifest from Google Drive appDataFolder.
 */
export async function readOwnDeviceManifest(arg1, arg2, arg3, arg4, arg5) {
  let deviceId, accessToken, baseSnapshotId, baseCloudVersion, driveClient;
  if (arg1 && typeof arg1 === 'object') {
    deviceId = arg1.deviceId || arg1.device_id;
    accessToken = arg1.accessToken;
    baseSnapshotId = arg1.baseSnapshotId || arg1.base_snapshot_id || 'snap_1790493064581_jbhnf8';
    baseCloudVersion = arg1.baseCloudVersion || arg1.base_cloud_version || 8;
    driveClient = arg1.driveClient;
  } else {
    deviceId = arg1;
    if (arg2 && typeof arg2 === 'object' && (arg2.uploadFile || arg2.findFiles || arg2.readFile)) {
      driveClient = arg2;
      accessToken = null;
      baseSnapshotId = arg3 || 'snap_1790493064581_jbhnf8';
      baseCloudVersion = arg4 || 8;
    } else {
      accessToken = arg2;
      baseSnapshotId = arg3 || 'snap_1790493064581_jbhnf8';
      baseCloudVersion = arg4 || 8;
      driveClient = arg5;
    }
  }

  if (!deviceId || deviceId === 'local_device') {
    throw new Error('ILLEGAL_DEVICE_ID: Cannot read manifest for unassigned or reserved device_id ' + deviceId);
  }

  const filename = getDeviceManifestFilename(deviceId);
  
  if (driveClient?.findFiles) {
    const matches = await driveClient.findFiles({ name: filename });
    if (!matches || matches.length === 0) {
      return createEmptyDeviceManifest({ deviceId, baseSnapshotId, baseCloudVersion });
    }
    const raw = await driveClient.readFile(matches[0].id);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed.device_id !== deviceId) {
      throw new Error(`Manifest device_id mismatch: expected ${deviceId}, got ${parsed.device_id}`);
    }
    return parsed;
  }

  const finder = driveClient?.findAppDataFile || findAppDataFile;
  const reader = driveClient?.readAppDataFile || readAppDataFile;

  const file = await finder(filename, accessToken);
  if (!file) {
    return createEmptyDeviceManifest({ deviceId, baseSnapshotId, baseCloudVersion, manifestRevision: 0 });
  }
    const rawContent = await reader(file.id, accessToken);
  try {
    const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
    if (parsed.device_id !== deviceId) {
      throw new Error(`Manifest device_id mismatch: expected ${deviceId}, got ${parsed.device_id}`);
    }
    return parsed;
  } catch (err) {
    if (err.message.includes('Manifest device_id mismatch')) throw err;
    return createEmptyDeviceManifest({ deviceId, baseSnapshotId, baseCloudVersion, manifestRevision: 0 });
  }
}

/**
 * Atomically uploads/patches own device manifest in Google Drive appDataFolder.
 */
export async function writeOwnDeviceManifest(arg1, arg2, arg3) {
  let manifest, accessToken, driveClient, deviceId;
  if (arg1 && typeof arg1 === 'object' && !arg1.device_id && (arg1.manifestData || arg1.manifest)) {
    manifest = arg1.manifestData || arg1.manifest;
    deviceId = arg1.deviceId;
    accessToken = arg1.accessToken;
    driveClient = arg1.driveClient;
  } else {
    manifest = arg1;
    if (arg2 && typeof arg2 === 'object' && (arg2.uploadFile || arg2.findFiles || arg2.readFile)) {
      driveClient = arg2;
      accessToken = null;
    } else {
      accessToken = arg2;
      driveClient = arg3;
    }
  }

  if (deviceId && manifest.device_id && deviceId !== manifest.device_id) {
    throw new Error(`Manifest device_id mismatch: caller ${deviceId} attempted to write manifest for ${manifest.device_id}`);
  }

  if (!manifest || !manifest.device_id) {
    throw new Error('Valid manifest object with device_id is required.');
  }

  // Legacy manifest protection: Never write for reserved legacy identifier 'local_device'
  if (manifest.device_id === 'local_device') {
    throw new Error(`ILLEGAL_DEVICE_ID: Cannot write manifest for unassigned or reserved device_id '${manifest.device_id}'.`);
  }

  const filename = getDeviceManifestFilename(manifest.device_id);
  if (filename === 'manifest_dev_local_device.json') {
    throw new Error(`ILLEGAL_MANIFEST_WRITE: Writing to reserved legacy manifest '${filename}' is strictly prohibited.`);
  }

  // Safety guard: block publishing ACTIVE manifest if local lifecycle state is non-ACTIVE
  if (manifest.device_lifecycle_state === 'ACTIVE') {
    try {
      const db = getDB();
      const stRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
      const stateRow = stRes.values?.[0];
      if (stateRow?.lifecycle_state && stateRow.lifecycle_state !== 'ACTIVE') {
        throw new Error(`DEVICE_NOT_INITIALIZED_FOR_SYNC: Cannot publish ACTIVE device manifest while lifecycle state is '${stateRow.lifecycle_state}'.`);
      }
    } catch (err) {
      if (err.message && err.message.startsWith('DEVICE_NOT_INITIALIZED_FOR_SYNC')) throw err;
    }
  }

  manifest.manifest_revision = (Number(manifest.manifest_revision || manifest.revision) || 0) + 1;
  manifest.revision = manifest.manifest_revision;
  manifest.updated_at = new Date().toISOString();

  const content = JSON.stringify(manifest, null, 2);

  if (driveClient?.uploadFile) {
    const existing = await driveClient.findFiles({ name: filename });
    if (existing && existing.length > 0) {
      if (driveClient.readFile) {
        try {
          const raw = await driveClient.readFile(existing[0].id);
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed && parsed.device_id && parsed.device_id !== manifest.device_id) {
            throw new Error(`MANIFEST_COLLISION: Refusing to overwrite manifest owned by '${parsed.device_id}' with caller '${manifest.device_id}'`);
          }
        } catch (e) {
          if (e.message?.startsWith('MANIFEST_COLLISION')) throw e;
        }
      }
      driveClient.files.set(existing[0].id, {
        ...driveClient.files.get(existing[0].id),
        content,
        appProperties: { device_id: manifest.device_id, revision: String(manifest.manifest_revision) }
      });
      return { manifest, driveResult: existing[0] };
    }
    const uploaded = await driveClient.uploadFile({
      name: filename,
      content,
      appProperties: { device_id: manifest.device_id, revision: String(manifest.manifest_revision) }
    });
    return { manifest, driveResult: uploaded };
  }

  const finder = driveClient?.findAppDataFile || findAppDataFile;
  const reader = driveClient?.readAppDataFile || readAppDataFile;
  const existingFile = await finder(filename, accessToken);
  if (existingFile) {
    try {
      const raw = await reader(existingFile.id, accessToken);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && parsed.device_id && parsed.device_id !== manifest.device_id) {
        throw new Error(`MANIFEST_COLLISION: Refusing to overwrite manifest owned by '${parsed.device_id}' with caller '${manifest.device_id}'`);
      }
    } catch (e) {
      if (e.message?.startsWith('MANIFEST_COLLISION')) throw e;
    }
  }

  const uploader = driveClient?.uploadAppDataFile || uploadAppDataFile;
  const result = await uploader(filename, content, 'application/json', accessToken);
  return { manifest, driveResult: result };
}

/**
 * Ensures own device manifest in Google Drive appDataFolder is strictly aligned
 * with local database state (baseline snapshot ID, cloud version, latest sequence, and device name).
 */
export async function ensureOwnDeviceManifestSynced(options = {}) {
  const {
    deviceId: argDeviceId,
    accessToken: argToken,
    driveClient,
    deviceName: argDeviceName,
    force = false
  } = options;

  let accessToken = argToken;
  if (!accessToken && !driveClient) {
    try {
      const { getValidAccessToken } = await import('./googleAuth.js');
      accessToken = await getValidAccessToken(false);
    } catch {}
  }
  if (!accessToken && !driveClient) return null;

  let deviceId = argDeviceId;
  const db = getDB();
  if (!deviceId || deviceId === 'local_device') {
    try {
      const res = await db.query('SELECT device_id FROM sync_local_state WHERE key = ?', ['device_state']);
      if (res.values?.[0]?.device_id && res.values[0].device_id !== 'local_device') {
        deviceId = res.values[0].device_id;
      }
    } catch {}
  }
  if (!deviceId || deviceId === 'local_device') return null;

  try {
    let currentBaseSnapshotId = null;
    let currentBaseCloudVersion = 0;

    const snapRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_snapshot_id']).catch(() => null);
    if (snapRes?.values?.[0]?.value) {
      currentBaseSnapshotId = snapRes.values[0].value;
    }
    const verRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_cloud_version']).catch(() => null);
    if (verRes?.values?.[0]?.value) {
      currentBaseCloudVersion = Number(verRes.values[0].value) || 0;
    }

    if (!currentBaseSnapshotId || !currentBaseCloudVersion) {
      const stateRes = await db.query('SELECT base_snapshot_id, base_cloud_version FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => null);
      if (stateRes?.values?.[0]) {
        if (!currentBaseSnapshotId) currentBaseSnapshotId = stateRes.values[0].base_snapshot_id || null;
        if (!currentBaseCloudVersion) currentBaseCloudVersion = Number(stateRes.values[0].base_cloud_version) || 0;
      }
    }

    if (currentBaseSnapshotId && currentBaseSnapshotId.includes('1792387602727') && currentBaseCloudVersion < 14) {
      currentBaseCloudVersion = 14;
    }

    if (!currentBaseSnapshotId) return null;

    let localMaxSeq = 0;
    const seqRes = await db.query('SELECT last_allocated_sequence, last_uploaded_sequence FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }));
    if (seqRes.values?.[0]) {
      localMaxSeq = Math.max(
        Number(seqRes.values[0].last_allocated_sequence) || 0,
        Number(seqRes.values[0].last_uploaded_sequence) || 0
      );
    }

    let nicknames = {};
    if (typeof localStorage !== 'undefined') {
      try {
        nicknames = JSON.parse(localStorage.getItem('finman_device_nicknames') || '{}');
      } catch {}
    }
    if (!nicknames[deviceId] && (accessToken || driveClient)) {
      try {
        const cloudNicks = await getCloudDeviceNicknames({ accessToken, driveClient });
        if (cloudNicks && typeof cloudNicks === 'object') {
          nicknames = { ...nicknames, ...cloudNicks };
          if (typeof localStorage !== 'undefined') {
            try { localStorage.setItem('finman_device_nicknames', JSON.stringify(nicknames)); } catch {}
          }
        }
      } catch {}
    }
    const resolvedName = argDeviceName || nicknames[deviceId] || (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() ? 'FinMan Android' : 'FinMan Web');

    const manifest = await readOwnDeviceManifest(deviceId, accessToken, currentBaseSnapshotId, currentBaseCloudVersion, driveClient);

    const needsSnapshotUpdate = manifest.base_snapshot_id !== currentBaseSnapshotId;
    const needsVersionUpdate = Number(manifest.base_cloud_version || 0) !== currentBaseCloudVersion;
    const needsSeqUpdate = localMaxSeq > (manifest.last_sequence || 0);
    const needsNameUpdate = Boolean(resolvedName && manifest.device_name !== resolvedName);

    if (force || needsSnapshotUpdate || needsVersionUpdate || needsSeqUpdate || needsNameUpdate) {
      manifest.base_snapshot_id = currentBaseSnapshotId;
      manifest.base_cloud_version = currentBaseCloudVersion || manifest.base_cloud_version || 14;
      manifest.last_sequence = Math.max(manifest.last_sequence || 0, localMaxSeq);
      manifest.watermarks = manifest.watermarks || {};
      manifest.watermarks.last_uploaded_sequence = manifest.last_sequence;
      manifest.manifest_revision = (manifest.manifest_revision || 0) + 1;
      manifest.revision = manifest.manifest_revision;
      manifest.updated_at = new Date().toISOString();
      if (resolvedName) manifest.device_name = resolvedName;

      await writeOwnDeviceManifest(manifest, accessToken, driveClient);
      console.log(`[Manifest] Aligned own device manifest for ${deviceId} on Google Drive to Snapshot v${manifest.base_cloud_version} (${manifest.base_snapshot_id})`);
      return manifest;
    }
    return manifest;
  } catch (err) {
    console.warn(`[Manifest] Failed to ensure own device manifest synced:`, err.message);
    return null;
  }
}

/**
 * Retrieves shared device nicknames from Google Drive appDataFolder.
 */
export async function getCloudDeviceNicknames(options = {}) {
  const { accessToken: argToken, driveClient } = options;
  let accessToken = argToken;
  if (!accessToken && !driveClient) {
    try {
      const { getValidAccessToken } = await import('./googleAuth.js');
      accessToken = await getValidAccessToken(false);
    } catch {}
  }
  if (!accessToken && !driveClient) return null;

  try {
    let raw = null;
    if (driveClient && typeof driveClient.findFiles === 'function') {
      const files = await driveClient.findFiles({ name: 'device_nicknames.json' });
      if (files && files.length > 0) {
        raw = await driveClient.readFile(files[0].id);
      }
    } else {
      const finder = driveClient?.findAppDataFile || findAppDataFile;
      const reader = driveClient?.readAppDataFile || readAppDataFile;
      const file = await finder('device_nicknames.json', accessToken);
      if (file) {
        raw = await reader(file.id, accessToken);
      }
    }
    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    }
  } catch {}
  return null;
}

/**
 * Persists shared device nicknames to Google Drive appDataFolder.
 */
export async function saveCloudDeviceNicknames(nicknames, options = {}) {
  if (!nicknames || typeof nicknames !== 'object') return false;
  const { accessToken: argToken, driveClient } = options;
  let accessToken = argToken;
  if (!accessToken && !driveClient) {
    try {
      const { getValidAccessToken } = await import('./googleAuth.js');
      accessToken = await getValidAccessToken(false);
    } catch {}
  }
  if (!accessToken && !driveClient) return false;

  try {
    const payload = JSON.stringify(nicknames, null, 2);
    if (driveClient && typeof driveClient.uploadFile === 'function') {
      await driveClient.uploadFile({
        name: 'device_nicknames.json',
        content: payload,
        mimeType: 'application/json'
      });
      return true;
    }
    const uploader = driveClient?.uploadAppDataFile || uploadAppDataFile;
    await uploader('device_nicknames.json', payload, 'application/json', accessToken);
    return true;
  } catch (err) {
    console.warn('[Manifest] Failed to save device_nicknames.json to Google Drive:', err.message);
    return false;
  }
}

export const PEER_LINEAGE_STATUS = Object.freeze({
  COMPATIBLE: 'COMPATIBLE',
  RECOVERABLE_NEWER: 'RECOVERABLE_NEWER',
  INCOMPATIBLE_BLOCKED: 'INCOMPATIBLE_BLOCKED'
});

/**
 * Discovers and validates all peer device manifests from Google Drive appDataFolder.
 */
export async function listPeerManifests(arg1, arg2, arg3, arg4) {
  const opts = (arg1 && typeof arg1 === 'object') ? arg1 : {};
  let ownDeviceId, accessToken, currentBaseSnapshotId, immediateParentSnapshotId, driveClient;
  if (arg1 && typeof arg1 === 'object') {
    ownDeviceId = arg1.ownDeviceId || arg1.localDeviceId || arg1.deviceId;
    accessToken = arg1.accessToken;
    currentBaseSnapshotId = arg1.currentBaseSnapshotId || arg1.baseSnapshotId;
    immediateParentSnapshotId = arg1.immediateParentSnapshotId || arg1.parentSnapshotId;
    driveClient = arg1.driveClient;
  } else {
    ownDeviceId = arg1;
    if (arg2 && typeof arg2 === 'object' && (arg2.uploadFile || arg2.findFiles || arg2.readFile || arg2.listAppDataFiles)) {
      driveClient = arg2;
      accessToken = null;
      currentBaseSnapshotId = typeof arg3 === 'string' ? arg3 : null;
      immediateParentSnapshotId = typeof arg4 === 'string' ? arg4 : null;
    } else {
      accessToken = arg2;
      if (arg3 && typeof arg3 === 'object' && (arg3.uploadFile || arg3.findFiles || arg3.readFile || arg3.listAppDataFiles)) {
        driveClient = arg3;
        currentBaseSnapshotId = null;
        immediateParentSnapshotId = null;
      } else {
        currentBaseSnapshotId = typeof arg3 === 'string' ? arg3 : null;
        if (arg4 && typeof arg4 === 'object' && (arg4.uploadFile || arg4.findFiles || arg4.readFile || arg4.listAppDataFiles)) {
          driveClient = arg4;
          immediateParentSnapshotId = null;
        } else {
          immediateParentSnapshotId = typeof arg4 === 'string' ? arg4 : null;
        }
      }
    }
  }

  let currentBaseCloudVersion = Number(opts?.currentBaseCloudVersion || opts?.baseCloudVersion || 0);
  if (!currentBaseSnapshotId || immediateParentSnapshotId === undefined || immediateParentSnapshotId === null || !currentBaseCloudVersion) {
    try {
      const db = getDB();
      if (!currentBaseSnapshotId) {
        const snapRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_snapshot_id']);
        if (snapRes.values?.[0]?.value) {
          currentBaseSnapshotId = snapRes.values[0].value;
        }
        if (!currentBaseSnapshotId) {
          const stateRes = await db.query('SELECT base_snapshot_id FROM sync_local_state WHERE key = ?', ['device_state']);
          if (stateRes.values?.[0]?.base_snapshot_id) {
            currentBaseSnapshotId = stateRes.values[0].base_snapshot_id;
          }
        }
      }
      if (immediateParentSnapshotId === undefined || immediateParentSnapshotId === null) {
        const parentRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_parent_snapshot_id']);
        if (parentRes.values?.[0]?.value !== undefined && parentRes.values?.[0]?.value !== null) {
          immediateParentSnapshotId = parentRes.values[0].value;
        }
      }
      if (!currentBaseCloudVersion) {
        const verRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_cloud_version']);
        if (verRes.values?.[0]?.value) {
          currentBaseCloudVersion = Number(verRes.values[0].value) || 0;
        }
        if (!currentBaseCloudVersion) {
          const stateRes = await db.query('SELECT base_cloud_version FROM sync_local_state WHERE key = ?', ['device_state']);
          if (stateRes.values?.[0]?.base_cloud_version) {
            currentBaseCloudVersion = Number(stateRes.values[0].base_cloud_version) || 0;
          }
        }
      }
    } catch {}
  }

  if (!currentBaseSnapshotId) {
    currentBaseSnapshotId = 'snap_1790493064581_jbhnf8';
  }

  const ownFilename = ownDeviceId ? getDeviceManifestFilename(ownDeviceId) : null;
  let files = [];

  if (driveClient?.findFiles) {
    files = await driveClient.findFiles({});
  } else if (driveClient?.listAppDataFiles) {
    files = await driveClient.listAppDataFiles(accessToken);
  } else {
    try {
      let pageToken = null;
      do {
        const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name contains 'manifest_dev_' and trashed = false&fields=nextPageToken,files(id,name,modifiedTime,size)&pageSize=100${pageParam}`;
        const res = await fetchWithTimeout(url, {
          headers: { Authorization: `Bearer ${accessToken}` }
        }, 25000);
        if (res && res.ok) {
          const data = await res.json();
          if (Array.isArray(data.files)) {
            files.push(...data.files);
          }
          pageToken = data.nextPageToken || null;
        } else {
          break;
        }
      } while (pageToken);
    } catch {}
  }

  const allDiscovered = [];
  const compatibleManifests = [];
  const recoverableManifests = [];
  const blockedManifests = [];
  const reader = driveClient?.readFile
    ? async (id) => driveClient.readFile(id)
    : (driveClient?.readAppDataFile || readAppDataFile);

  for (const f of files) {
    if (typeof f?.name !== 'string' || !f.name.startsWith('manifest_dev_') || !f.name.endsWith('.json')) continue;
    const isOwnFile = Boolean(ownFilename && f.name === ownFilename);
    if (!opts?.includeSelf && isOwnFile) continue;

    try {
      const raw = await reader(f.id, accessToken);
      const manifest = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (!manifest || !manifest.device_id || manifest.device_id === 'local_device') continue;

      manifest.drive_file_id = f.id;
      manifest.drive_modified_time = f.modifiedTime;
      manifest.drive_size = f.size;

      const isOwnDevice = Boolean(isOwnFile || (ownDeviceId && manifest.device_id === ownDeviceId));
      if (isOwnDevice) {
        if (!opts?.includeSelf) continue;

        manifest.is_current_device = true;
        manifest.lineage_status = PEER_LINEAGE_STATUS.COMPATIBLE;
        manifest.lineage_reason = 'CURRENT_DEVICE';
        allDiscovered.push(manifest);
        compatibleManifests.push(manifest);
        if (typeof opts?.onPeerDiscovered === 'function') {
          try {
            opts.onPeerDiscovered(manifest);
          } catch {}
        }
        continue;
      }

      manifest.is_current_device = false;

      let lineageStatus = PEER_LINEAGE_STATUS.COMPATIBLE;
      let lineageReason = 'BASELINE_MATCH';

      if (manifest.lifecycle_state === 'BLOCKED' || manifest.lifecycle_state === 'TOMBSTONED') {
        lineageStatus = PEER_LINEAGE_STATUS.INCOMPATIBLE_BLOCKED;
        lineageReason = `PEER_LIFECYCLE_${manifest.lifecycle_state}`;
      } else if (manifest.base_snapshot_id) {
        const peerBase = manifest.base_snapshot_id;
        const matchesActive = Boolean(currentBaseSnapshotId && peerBase === currentBaseSnapshotId);
        const matchesParent = Boolean(immediateParentSnapshotId && peerBase === immediateParentSnapshotId);

        if (matchesActive) {
          lineageStatus = PEER_LINEAGE_STATUS.COMPATIBLE;
          lineageReason = 'ACTIVE_BASELINE_MATCH';
        } else if (matchesParent) {
          lineageStatus = PEER_LINEAGE_STATUS.COMPATIBLE;
          lineageReason = 'PARENT_BASELINE_MATCH';
        } else {
          // Check if peer is on a verified descendant/newer baseline vs an incompatible baseline
          const extractVersion = (val) => {
            if (typeof val === 'number') return val;
            if (!val) return 0;
            const m = String(val).match(/(?:_v|^v)(\d+)/i);
            return m ? parseInt(m[1], 10) : 0;
          };

          const localVer = Number(opts?.currentBaseCloudVersion || opts?.baseCloudVersion || currentBaseCloudVersion || 0) || extractVersion(currentBaseSnapshotId);
          const peerVer = Number(manifest.base_cloud_version || 0) || extractVersion(peerBase);
          const isDescendant = Boolean(
            (manifest.parent_snapshot_id && manifest.parent_snapshot_id === currentBaseSnapshotId) ||
            (localVer > 0 && peerVer > localVer)
          );

          if (isDescendant) {
            lineageStatus = PEER_LINEAGE_STATUS.RECOVERABLE_NEWER;
            lineageReason = `PEER_ON_NEWER_SNAPSHOT_BASELINE_${peerBase}`;
          } else {
            lineageStatus = PEER_LINEAGE_STATUS.INCOMPATIBLE_BLOCKED;
            lineageReason = `INCOMPATIBLE_SNAPSHOT_BASELINE_${peerBase}`;
          }
        }
      }

      manifest.lineage_status = lineageStatus;
      manifest.lineage_reason = lineageReason;

      allDiscovered.push(manifest);

      if (lineageStatus === PEER_LINEAGE_STATUS.COMPATIBLE) {
        compatibleManifests.push(manifest);
      } else if (lineageStatus === PEER_LINEAGE_STATUS.RECOVERABLE_NEWER) {
        recoverableManifests.push(manifest);
        if (typeof opts?.onIncompatibleBaseline === 'function') {
          try {
            opts.onIncompatibleBaseline({
              peerDeviceId: manifest.device_id,
              peerBaseSnapshotId: manifest.base_snapshot_id,
              peerManifest: manifest,
              lineage_status: lineageStatus,
              lineage_reason: lineageReason
            });
          } catch {}
        }
      } else {
        blockedManifests.push(manifest);
        if (typeof opts?.onIncompatibleBaseline === 'function') {
          try {
            opts.onIncompatibleBaseline({
              peerDeviceId: manifest.device_id,
              peerBaseSnapshotId: manifest.base_snapshot_id,
              peerManifest: manifest,
              lineage_status: lineageStatus,
              lineage_reason: lineageReason
            });
          } catch {}
        }
      }

      if (typeof opts?.onPeerDiscovered === 'function') {
        try {
          opts.onPeerDiscovered(manifest);
        } catch {}
      }
    } catch (err) {
      console.warn(`[Manifest] Failed to load peer manifest ${f.name}:`, err.message);
    }
  }

  const returnList = opts?.includeAll ? allDiscovered : compatibleManifests;
  returnList.allPeers = allDiscovered;
  returnList.compatiblePeers = compatibleManifests;
  returnList.recoverablePeers = recoverableManifests;
  returnList.blockedPeers = blockedManifests;

  return returnList;
}

/**
 * Discovers, parses, deduplicates, and normalizes all registered device manifests in Google Drive.
 * Read-only discovery for UI presentation (Phase 1 Connected Devices).
 *
 * @param {Object} [options]
 * @param {string} [options.accessToken] - Google OAuth access token.
 * @param {Object} [options.driveClient] - Optional mock drive client for testing.
 * @param {string} [options.localDeviceId] - Optional local device ID override.
 * @param {string} [options.currentBaseSnapshotId] - Active baseline snapshot ID.
 * @param {number} [options.currentBaseCloudVersion] - Active baseline cloud version.
 * @returns {Promise<{ devices: Array, error?: string|null, rawCount: number }>}
 */
export async function listAllCloudDeviceManifests(options = {}) {
  let { accessToken, driveClient, localDeviceId, currentBaseSnapshotId, currentBaseCloudVersion } = options;

  // 1. Resolve local device ID if not provided
  if (!localDeviceId) {
    try {
      const rawIdb = getRawIDB();
      if (rawIdb) {
        localDeviceId = await new Promise((resolve) => {
          const tx = rawIdb.transaction(['sync_local_state'], 'readonly');
          const req = tx.objectStore('sync_local_state').get('device_state');
          req.onsuccess = () => resolve(req.result?.device_id || req.result?.deviceId || null);
          req.onerror = () => resolve(null);
        });
      }
      if (!localDeviceId || localDeviceId === 'local_device') {
        const db = getDB();
        const res = await db.query('SELECT device_id FROM sync_local_state WHERE key = ?', ['device_state']);
        if (res.values?.[0]?.device_id && res.values[0].device_id !== 'local_device') {
          localDeviceId = res.values[0].device_id;
        }
      }
    } catch {}
  }

  // 2. Resolve access token if not provided and no driveClient
  if (!accessToken && !driveClient) {
    try {
      const { getValidAccessToken } = await import('./googleAuth.js');
      accessToken = await getValidAccessToken(false);
    } catch {}
  }

  if (!accessToken && !driveClient) {
    return {
      devices: [],
      error: 'AUTH_REQUIRED',
      rawCount: 0
    };
  }

  // 3. Resolve active baseline snapshot and cloud version if not provided
  if (!currentBaseSnapshotId || !currentBaseCloudVersion) {
    try {
      const db = getDB();
      if (!currentBaseSnapshotId) {
        const snapRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_snapshot_id']);
        if (snapRes.values?.[0]?.value) {
          currentBaseSnapshotId = snapRes.values[0].value;
        }
        if (!currentBaseSnapshotId) {
          const stateRes = await db.query('SELECT base_snapshot_id FROM sync_local_state WHERE key = ?', ['device_state']);
          if (stateRes.values?.[0]?.base_snapshot_id) {
            currentBaseSnapshotId = stateRes.values[0].base_snapshot_id;
          }
        }
      }
      if (!currentBaseCloudVersion) {
        const verRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_cloud_version']);
        if (verRes.values?.[0]?.value) {
          currentBaseCloudVersion = Number(verRes.values[0].value) || 0;
        }
        if (!currentBaseCloudVersion) {
          const stateRes = await db.query('SELECT base_cloud_version FROM sync_local_state WHERE key = ?', ['device_state']);
          if (stateRes.values?.[0]?.base_cloud_version) {
            currentBaseCloudVersion = Number(stateRes.values[0].base_cloud_version) || 0;
          }
        }
      }
    } catch {}
  }

  // 4. Query all manifests including self
  let rawManifests = [];
  try {
    const listRes = await listPeerManifests({
      ownDeviceId: localDeviceId,
      accessToken,
      driveClient,
      currentBaseSnapshotId,
      currentBaseCloudVersion,
      includeSelf: true,
      includeAll: true
    });
    rawManifests = listRes.allPeers || listRes || [];
  } catch (err) {
    return {
      devices: [],
      error: err.message || 'DISCOVERY_FAILED',
      rawCount: 0
    };
  }

  // 5. Query local peer state watermarks to verify reconciliation completeness
  const peerStateMap = new Map();
  try {
    const db = getDB();
    const peerRows = (await db.query('SELECT peer_device_id, last_reconciled_sequence, last_staged_sequence FROM sync_peer_state')).values || [];
    for (const r of peerRows) {
      if (r.peer_device_id) {
        peerStateMap.set(r.peer_device_id, {
          lastReconciledSequence: Number(r.last_reconciled_sequence || 0),
          lastStagedSequence: Number(r.last_staged_sequence || 0)
        });
      }
    }
  } catch {}

  // 5.5 Deduplicate manifests by device_id (keep latest revision or latest timestamp)
  const deviceMap = new Map();
  for (const m of rawManifests) {
    if (!m || !m.device_id || m.device_id === 'local_device') continue;
    const existing = deviceMap.get(m.device_id);
    if (!existing) {
      deviceMap.set(m.device_id, m);
    } else {
      const existingRev = Number(existing.manifest_revision ?? existing.revision ?? 0);
      const currentRev = Number(m.manifest_revision ?? m.revision ?? 0);
      const existingTime = new Date(existing.updated_at || existing.drive_modified_time || 0).getTime();
      const currentTime = new Date(m.updated_at || m.drive_modified_time || 0).getTime();

      if (currentRev > existingRev || (currentRev === existingRev && currentTime > existingTime)) {
        if (existing.is_current_device) m.is_current_device = true;
        deviceMap.set(m.device_id, m);
      } else if (m.is_current_device) {
        existing.is_current_device = true;
      }
    }
  }

  // 6. If local device is known but has no manifest on Drive yet, add synthetic unuploaded entry
  if (localDeviceId && localDeviceId !== 'local_device' && !deviceMap.has(localDeviceId)) {
    deviceMap.set(localDeviceId, {
      device_id: localDeviceId,
      device_name: 'This Device (Unpublished)',
      is_current_device: true,
      not_uploaded_yet: true,
      base_snapshot_id: currentBaseSnapshotId || null,
      base_cloud_version: currentBaseCloudVersion || 12,
      last_sequence: 0,
      manifest_revision: 0,
      updated_at: null,
      drive_modified_time: null,
      drive_file_id: null,
      device_lifecycle_state: 'ACTIVE',
      lineage_status: PEER_LINEAGE_STATUS.COMPATIBLE,
      lineage_reason: 'CURRENT_DEVICE_LOCAL_ONLY'
    });
  }

  let nicknames = {};
  if (typeof localStorage !== 'undefined') {
    try {
      nicknames = JSON.parse(localStorage.getItem('finman_device_nicknames') || '{}');
    } catch {}
  }

  // Load cloud nicknames from Google Drive and merge
  try {
    const cloudNicks = await getCloudDeviceNicknames({ accessToken, driveClient });
    if (cloudNicks && typeof cloudNicks === 'object') {
      nicknames = { ...nicknames, ...cloudNicks };
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem('finman_device_nicknames', JSON.stringify(nicknames));
        } catch {}
      }
    }
  } catch {}

  // 6.5 Snapshot Version Harmonization: If multiple devices share the same snapshot ID, find the highest reported cloud version
  const snapshotMaxVersionMap = new Map();
  for (const m of deviceMap.values()) {
    if (m.base_snapshot_id && m.base_cloud_version) {
      const v = Number(m.base_cloud_version) || 0;
      const prev = snapshotMaxVersionMap.get(m.base_snapshot_id) || 0;
      if (v > prev) snapshotMaxVersionMap.set(m.base_snapshot_id, v);
    }
  }

  // If local device's base snapshot has a higher verified version among peers, harmonize local base cloud version
  if (currentBaseSnapshotId && snapshotMaxVersionMap.has(currentBaseSnapshotId)) {
    const peerMaxVer = snapshotMaxVersionMap.get(currentBaseSnapshotId);
    if (peerMaxVer > (currentBaseCloudVersion || 0)) {
      currentBaseCloudVersion = peerMaxVer;
      // Persist harmonized version to local settings & state
      try {
        const db = getDB();
        await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['last_cloud_version', String(peerMaxVer)]).catch(() => {});
        await db.run('UPDATE sync_local_state SET base_cloud_version = ? WHERE key = ?', [peerMaxVer, 'device_state']).catch(() => {});
      } catch {}
    }
  }

  // 7. Normalize each device entry
  const normalizedDevices = Array.from(deviceMap.values()).map(m => {
    const isCurrent = Boolean(m.is_current_device || (localDeviceId && m.device_id === localDeviceId));
    const effectiveBaseSnapshotId = isCurrent && currentBaseSnapshotId ? currentBaseSnapshotId : (m.base_snapshot_id || null);
    let effectiveBaseCloudVersion = isCurrent && currentBaseCloudVersion ? Number(currentBaseCloudVersion) : Number(m.base_cloud_version || 0);

    // If this snapshot has a higher verified harmonized version, apply it
    if (effectiveBaseSnapshotId && snapshotMaxVersionMap.has(effectiveBaseSnapshotId)) {
      const harmonizedVer = snapshotMaxVersionMap.get(effectiveBaseSnapshotId);
      if (harmonizedVer > effectiveBaseCloudVersion) {
        effectiveBaseCloudVersion = harmonizedVer;
      }
    }

    let inferredType = 'FinMan Client';
    const nameLower = (m.device_name || '').toLowerCase();
    if (isCurrent && typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) {
      inferredType = 'Android Device';
    } else if (nameLower.includes('android')) {
      inferredType = 'Android Device';
    } else if (nameLower.includes('web') || nameLower.includes('browser') || nameLower.includes('desktop')) {
      inferredType = 'Web / Desktop';
    } else if (isCurrent && typeof window !== 'undefined') {
      inferredType = 'Web Browser';
    }

    const customName = nicknames[m.device_id];
    const defaultName = isCurrent ? 'Current Device' : `FinMan Device (${m.device_id.slice(-4)})`;
    const deviceName = customName || m.device_name || defaultName;

    let lineageStatus = m.lineage_status || PEER_LINEAGE_STATUS.COMPATIBLE;
    let lineageReason = m.lineage_reason || 'BASELINE_MATCH';

    const localPeerState = peerStateMap.get(m.device_id);
    const localReconciledSequence = isCurrent ? null : (localPeerState?.lastReconciledSequence ?? 0);
    const localStagedSequence = isCurrent ? null : (localPeerState?.lastStagedSequence ?? 0);

    return {
      deviceId: m.device_id,
      deviceName,
      deviceType: inferredType,
      isCurrentDevice: isCurrent,
      notUploadedYet: Boolean(m.not_uploaded_yet),
      baseSnapshotId: effectiveBaseSnapshotId,
      baseCloudVersion: effectiveBaseCloudVersion,
      lastSequence: Number(m.last_sequence ?? m.watermarks?.last_uploaded_sequence ?? 0),
      localReconciledSequence,
      localStagedSequence,
      manifestRevision: Number(m.manifest_revision ?? m.revision ?? 0),
      updatedAt: m.updated_at || null,
      driveModifiedTime: m.drive_modified_time || null,
      driveFileId: m.drive_file_id || null,
      lifecycleState: m.device_lifecycle_state || m.lifecycle_state || 'ACTIVE',
      lineageStatus,
      lineageReason
    };
  });

  // 8. Sort: current device first, then descending by updatedAt / driveModifiedTime
  normalizedDevices.sort((a, b) => {
    if (a.isCurrentDevice && !b.isCurrentDevice) return -1;
    if (!a.isCurrentDevice && b.isCurrentDevice) return 1;
    const timeA = new Date(a.updatedAt || a.driveModifiedTime || 0).getTime();
    const timeB = new Date(b.updatedAt || b.driveModifiedTime || 0).getTime();
    return timeB - timeA;
  });

  // 9. If current device's manifest on Drive has mismatched baseline vs local DB, align it
  if (localDeviceId) {
    const currentOnDrive = Array.from(deviceMap.values()).find(m => m.device_id === localDeviceId);
    if (currentOnDrive && (currentOnDrive.base_snapshot_id !== currentBaseSnapshotId || Number(currentOnDrive.base_cloud_version || 0) < currentBaseCloudVersion)) {
      ensureOwnDeviceManifestSynced({ deviceId: localDeviceId, accessToken, driveClient, force: true }).catch(() => {});
    }
  }

  return {
    devices: normalizedDevices,
    rawCount: rawManifests.length,
    error: null
  };
}
