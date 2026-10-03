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
import { findAppDataFile, readAppDataFile, uploadAppDataFile } from './googleDriveSync.js';

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
  let deviceId, deviceName, baseSnapshotId, baseCloudVersion, manifestRevision, lifecycleState;
  if (arg1 && typeof arg1 === 'object') {
    deviceId = arg1.deviceId || arg1.device_id;
    deviceName = arg1.deviceName || arg1.device_name || 'FinMan Device';
    baseSnapshotId = arg1.baseSnapshotId || arg1.base_snapshot_id || 'snap_1790493064581_jbhnf8';
    baseCloudVersion = arg1.baseCloudVersion || arg1.base_cloud_version || 8;
    manifestRevision = arg1.manifestRevision || arg1.manifest_revision || 0;
    lifecycleState = arg1.device_lifecycle_state || arg1.lifecycleState || 'ACTIVE';
  } else {
    deviceId = arg1;
    baseSnapshotId = arg2 || 'snap_1790493064581_jbhnf8';
    baseCloudVersion = arg3 || 8;
    manifestRevision = arg4 || 0;
    deviceName = 'FinMan Device';
    lifecycleState = 'ACTIVE';
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
export async function withSameDeviceLock(deviceId, taskFn) {
  if (!deviceId) throw new Error('Device ID is required for same-device locking.');

  const lockName = `finman_sync_lock_${deviceId}`;

  // 1. Primary path: W3C Web Locks API (authoritative browser concurrency mechanism)
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return await navigator.locks.request(lockName, { mode: 'exclusive' }, async () => {
      return await taskFn();
    });
  }

  // 2. Fallback path for environments without Web Locks
  const ownerToken = uuid();
  const acquired = await _acquireFallbackLock(lockName, ownerToken);
  if (!acquired) {
    throw new Error(`[Lock] Failed to acquire fallback sync lock for ${deviceId}. Another sync operation is active.`);
  }

  try {
    const result = await taskFn({
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

  const filename = getDeviceManifestFilename(manifest.device_id);
  manifest.manifest_revision = (Number(manifest.manifest_revision || manifest.revision) || 0) + 1;
  manifest.revision = manifest.manifest_revision;
  manifest.updated_at = new Date().toISOString();

  const content = JSON.stringify(manifest, null, 2);

  if (driveClient?.uploadFile) {
    const existing = await driveClient.findFiles({ name: filename });
    if (existing && existing.length > 0) {
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

  const uploader = driveClient?.uploadAppDataFile || uploadAppDataFile;
  const result = await uploader(filename, content, 'application/json', accessToken);
  return { manifest, driveResult: result };
}

/**
 * Discovers and validates all peer device manifests from Google Drive appDataFolder.
 */
export async function listPeerManifests(arg1, arg2, arg3, arg4) {
  let ownDeviceId, accessToken, currentBaseSnapshotId, immediateParentSnapshotId, driveClient;
  if (arg1 && typeof arg1 === 'object') {
    ownDeviceId = arg1.ownDeviceId || arg1.localDeviceId || arg1.deviceId;
    accessToken = arg1.accessToken;
    currentBaseSnapshotId = arg1.currentBaseSnapshotId || arg1.baseSnapshotId;
    immediateParentSnapshotId = arg1.immediateParentSnapshotId || arg1.parentSnapshotId;
    driveClient = arg1.driveClient;
  } else {
    ownDeviceId = arg1;
    if (arg2 && typeof arg2 === 'object' && (arg2.uploadFile || arg2.findFiles || arg2.readFile)) {
      driveClient = arg2;
      accessToken = null;
      currentBaseSnapshotId = arg3;
    } else {
      accessToken = arg2;
      currentBaseSnapshotId = arg3;
      driveClient = arg4;
    }
  }

  if (!currentBaseSnapshotId || !immediateParentSnapshotId) {
    try {
      const db = getDB();
      if (!currentBaseSnapshotId) {
        const snapRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_snapshot_id']);
        if (snapRes.values?.[0]?.value) {
          currentBaseSnapshotId = snapRes.values[0].value;
        }
      }
      if (!immediateParentSnapshotId) {
        const parentRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_parent_snapshot_id']);
        if (parentRes.values?.[0]?.value) {
          immediateParentSnapshotId = parentRes.values[0].value;
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
      const res = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name contains 'manifest_dev_' and trashed = false&fields=files(id,name,modifiedTime,size)&pageSize=50`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        files = data.files || [];
      }
    } catch {}
  }

  const peerManifests = [];
  const reader = driveClient?.readFile
    ? async (id) => driveClient.readFile(id)
    : (driveClient?.readAppDataFile || readAppDataFile);

  for (const f of files) {
    if (!f.name || !f.name.startsWith('manifest_dev_') || !f.name.endsWith('.json')) continue;
    if (ownFilename && f.name === ownFilename) continue;

    try {
      const raw = await reader(f.id, accessToken);
      const manifest = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (!manifest || !manifest.device_id) continue;
      if (manifest.base_snapshot_id) {
        const peerBase = manifest.base_snapshot_id;
        const matchesActive = Boolean(currentBaseSnapshotId && peerBase === currentBaseSnapshotId);
        const matchesParent = Boolean(immediateParentSnapshotId && peerBase === immediateParentSnapshotId);
        if (!matchesActive && !matchesParent) {
          continue;
        }
      }

      peerManifests.push(manifest);
    } catch (err) {
      console.warn(`[Manifest] Failed to load peer manifest ${f.name}:`, err.message);
    }
  }

  return peerManifests;
}
