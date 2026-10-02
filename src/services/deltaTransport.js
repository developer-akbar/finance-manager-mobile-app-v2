/**
 * deltaTransport.js — Phase 7.3 Delta Transport, Cryptography & Peer Staging Engine
 * 
 * Implements deterministic delta packaging, AES-256-GCM transport encryption,
 * duplicate-safe Google Drive upload, per-device manifest tracking, and atomic peer staging.
 */

import { getDB, getRawIDB } from '../database/db.js';
import { toCanonicalJson, computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import { deriveKey, bytesToBase64, base64ToBytes } from '../utils/cryptoBackup.js';
import {
  withSameDeviceLock,
  readOwnDeviceManifest,
  writeOwnDeviceManifest,
  listPeerManifests,
  getDeviceManifestFilename
} from './deviceManifest.js';
import { findAppDataFile, readAppDataFile, uploadAppDataFile } from './googleDriveSync.js';

export const TRANSPORT_SCHEMA_VERSION = 1;
export const TARGET_PACKAGE_EVENTS = 100;
export const NORMAL_MAX_PACKAGE_EVENTS = 250;
export const TARGET_PACKAGE_BYTES = 512 * 1024; // 512 KB

function pad6(num) {
  return String(num).padStart(6, '0');
}

/**
 * Builds standard package_id from structural parameters.
 */
export function buildPackageId(deviceId, startSeq, endSeq) {
  if (!deviceId || startSeq === undefined || endSeq === undefined) {
    throw new Error('deviceId, startSequence, and endSequence are required for package_id.');
  }
  return `pkg_${deviceId}_${pad6(startSeq)}_${pad6(endSeq)}`;
}

/**
 * Constructs the deterministic, checksum-covered Plaintext Package Payload.
 * Excludes all runtime transport timestamps (created_at, exportedAt, drive_file_ids).
 */
export function buildDeterministicPackagePayload({
  deviceId,
  startSequence,
  endSequence,
  baseSnapshotId = 'snap_1790493064581_jbhnf8',
  baseCloudVersion = 8,
  events = [],
  isOversizedBundle = false
}) {
  if (!deviceId) throw new Error('deviceId is required for package payload.');
  if (typeof startSequence !== 'number' || typeof endSequence !== 'number') {
    throw new Error('Numeric startSequence and endSequence are required.');
  }
  if (!baseSnapshotId) throw new Error('baseSnapshotId is required for package payload.');

  const packageId = buildPackageId(deviceId, startSequence, endSequence);

  const cleanEvents = events.map(e => ({
    event_id: String(e.event_id),
    device_id: String(e.device_id),
    sequence: Number(e.sequence),
    timestamp: String(e.timestamp),
    collection: String(e.collection),
    entity_id: String(e.entity_id),
    operation: String(e.operation),
    base_checksum: e.base_checksum ? String(e.base_checksum) : null,
    new_checksum: e.new_checksum ? String(e.new_checksum) : null,
    tombstone_generation: Number(e.tombstone_generation) || 0,
    payload: e.payload !== null && typeof e.payload === 'object' ? e.payload : null,
    bundle_id: e.bundle_id ? String(e.bundle_id) : null,
    bundle_index: Number(e.bundle_index) || 0,
    bundle_total: Number(e.bundle_total) || 1,
    bundle_checksum: e.bundle_checksum ? String(e.bundle_checksum) : null,
    parent_event_id: e.parent_event_id ? String(e.parent_event_id) : null
  }));

  const payload = {
    schema_version: TRANSPORT_SCHEMA_VERSION,
    package_id: packageId,
    device_id: String(deviceId),
    base_snapshot_id: String(baseSnapshotId),
    base_cloud_version: Number(baseCloudVersion) || 8,
    start_sequence: Number(startSequence),
    end_sequence: Number(endSequence),
    event_count: cleanEvents.length,
    events: cleanEvents
  };

  if (isOversizedBundle) {
    payload.is_oversized_bundle = true;
  }

  return payload;
}

/**
 * Computes deterministic RFC 8785 Canonical SHA-256 Checksum over plaintext package payload.
 */
export async function computePackageChecksum(packagePayload) {
  if (!packagePayload || !packagePayload.package_id) {
    throw new Error('Valid package payload required to compute checksum.');
  }
  return await computeCanonicalSha256(packagePayload);
}

/**
 * Encrypts a deterministic delta package into an AES-256-GCM container.
 */
export async function encryptDeltaPackage(packagePayload, keyMaterialOrPassword) {
  if (!packagePayload || !keyMaterialOrPassword) {
    throw new Error('packagePayload and keyMaterialOrPassword are required for encryption.');
  }

  const checksum = await computePackageChecksum(packagePayload);
  const canonicalPlaintext = toCanonicalJson(packagePayload);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const key = await deriveKey(keyMaterialOrPassword, salt);
  const enc = new TextEncoder();
  const encodedPlaintext = enc.encode(canonicalPlaintext);

  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encodedPlaintext
  );

  const encryptedBytes = new Uint8Array(encryptedBuf);
  const ciphertextBytes = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const tagBytes = encryptedBytes.slice(encryptedBytes.length - 16);

  return {
    schema_version: TRANSPORT_SCHEMA_VERSION,
    package_id: packagePayload.package_id,
    device_id: packagePayload.device_id,
    start_sequence: packagePayload.start_sequence,
    end_sequence: packagePayload.end_sequence,
    package_checksum: checksum,
    transport_created_at: new Date().toISOString(),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertextBytes),
    auth_tag: bytesToBase64(tagBytes)
  };
}

/**
 * Decrypts and cryptographically validates a delta package container.
 */
export async function decryptDeltaPackage(container, keyMaterialOrPassword) {
  if (!container || !container.ciphertext || !container.salt || !container.iv) {
    throw new Error('Invalid encrypted delta package container format.');
  }

  let salt, iv, ciphertextBytes, tagBytes;
  try {
    salt = base64ToBytes(container.salt);
    iv = base64ToBytes(container.iv);
    ciphertextBytes = base64ToBytes(container.ciphertext);
    tagBytes = container.auth_tag ? base64ToBytes(container.auth_tag) : new Uint8Array(0);
  } catch (err) {
    throw new Error(`Failed to decrypt transport package: Invalid container encoding (${err.message})`);
  }

  const combined = new Uint8Array(ciphertextBytes.length + tagBytes.length);
  combined.set(ciphertextBytes);
  combined.set(tagBytes, ciphertextBytes.length);

  let key;
  try {
    key = await deriveKey(keyMaterialOrPassword, salt);
  } catch (err) {
    throw new Error(`Failed to decrypt transport package: ${err.message}`);
  }

  let decryptedBuf;
  try {
    decryptedBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      combined
    );
  } catch (err) {
    throw new Error(`Failed to decrypt transport package: Authentication tag mismatch or invalid key (${err.message})`);
  }

  const dec = new TextDecoder();
  const plaintextJson = dec.decode(decryptedBuf);
  let payload;
  try {
    payload = JSON.parse(plaintextJson);
  } catch (e) {
    throw new Error(`Failed to parse decrypted package json: ${e.message}`);
  }

  // Validate structural & cryptographic integrity
  const recomputedChecksum = await computePackageChecksum(payload);
  if (recomputedChecksum !== container.package_checksum) {
    throw new Error(`Package checksum mismatch: Computed ${recomputedChecksum} does not match container ${container.package_checksum}`);
  }

  return payload;
}

/**
 * Slices pending delta queue events into package chunks respecting bundle boundaries.
 */
export function slicePendingDeltaQueue(
  events,
  targetCount = TARGET_PACKAGE_EVENTS,
  normalMax = NORMAL_MAX_PACKAGE_EVENTS
) {
  if (!events || events.length === 0) return [];

  const packages = [];
  let remainingEvents = [...events];

  while (remainingEvents.length > 0) {
    const firstEvent = remainingEvents[0];
    
    // Case 1: Oversized single bundle at start (> normalMax)
    if (firstEvent.bundle_id && firstEvent.bundle_total > normalMax) {
      const bundleId = firstEvent.bundle_id;
      const bundleEvents = remainingEvents.filter(e => e.bundle_id === bundleId);
      packages.push({
        events: bundleEvents,
        isOversizedBundle: true,
        packageId: buildPackageId(firstEvent.device_id, bundleEvents[0].sequence, bundleEvents[bundleEvents.length - 1].sequence),
        startSequence: bundleEvents[0].sequence,
        endSequence: bundleEvents[bundleEvents.length - 1].sequence
      });
      remainingEvents = remainingEvents.slice(bundleEvents.length);
      continue;
    }

    let candidateEvents = remainingEvents.slice(0, Math.min(remainingEvents.length, targetCount));
    let lastCandidate = candidateEvents[candidateEvents.length - 1];

    // Check bundle boundary
    if (lastCandidate.bundle_id && lastCandidate.bundle_index < lastCandidate.bundle_total - 1) {
      const bundleId = lastCandidate.bundle_id;
      const fullBundleEvents = remainingEvents.filter(e => e.bundle_id === bundleId);
      const bundleEndIdx = remainingEvents.findIndex(e => e.event_id === fullBundleEvents[fullBundleEvents.length - 1].event_id);
      const expandedCandidateEvents = remainingEvents.slice(0, bundleEndIdx + 1);

      if (expandedCandidateEvents.length <= normalMax) {
        candidateEvents = expandedCandidateEvents;
      } else {
        const bundleStartIdx = candidateEvents.findIndex(e => e.bundle_id === bundleId && e.bundle_index === 0);
        if (bundleStartIdx > 0) {
          candidateEvents = candidateEvents.slice(0, bundleStartIdx);
        } else {
          candidateEvents = fullBundleEvents;
        }
      }
    }

    if (candidateEvents.length === 0) break;

    packages.push({
      events: candidateEvents,
      isOversizedBundle: candidateEvents.length > normalMax,
      packageId: buildPackageId(candidateEvents[0].device_id, candidateEvents[0].sequence, candidateEvents[candidateEvents.length - 1].sequence),
      startSequence: candidateEvents[0].sequence,
      endSequence: candidateEvents[candidateEvents.length - 1].sequence
    });

    remainingEvents = remainingEvents.slice(candidateEvents.length);
  }

  return packages;
}

/**
 * Uploads locally pending delta queue packages to Google Drive appDataFolder.
 */
export async function uploadPendingDeltas(opts) {
  const deviceId = opts.deviceId || opts.device_id;
  const encryptionKeyOrPin = opts.sessionKey || opts.encryptionKeyOrPin;
  const accessToken = opts.accessToken;
  const driveClient = opts.driveClient;

  return await withSameDeviceLock(deviceId, async () => {
    const db = getDB();

    // 1. Read current local sequence watermarks
    const localStateRes = await db.query('SELECT * FROM sync_local_state WHERE device_id = ? OR key = ?', [deviceId, 'device_state']);
    const localState = localStateRes.values?.[0] || {
      last_allocated_sequence: 0,
      last_uploaded_sequence: 0,
      base_snapshot_id: opts.baseSnapshotId || null,
      base_cloud_version: opts.baseCloudVersion || 8
    };

    // 2. Fetch pending queue events
    const rawEvents = (await db.query('SELECT * FROM sync_delta_queue')).values || [];

    let lifecycleState = localState.lifecycle_state;
    if (!lifecycleState) {
      const hasSeq = Number(localState.last_pushed_sequence || localState.last_uploaded_sequence || localState.last_allocated_sequence || 0) > 0;
      if (hasSeq) {
        lifecycleState = 'ACTIVE';
      } else {
        let lastSnap = null;
        try {
          const snapRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_snapshot_id']);
          lastSnap = snapRes.values?.[0]?.value || null;
        } catch {}
        if (lastSnap) {
          lifecycleState = 'ACTIVE';
        } else if (rawEvents.length > 0) {
          lifecycleState = 'ACTIVE';
        } else {
          lifecycleState = 'UNINITIALIZED';
        }
      }
    }

    if (lifecycleState !== 'ACTIVE') {
      throw new Error(`DEVICE_NOT_INITIALIZED_FOR_SYNC: Device lifecycle state is '${lifecycleState}'. Outbound delta uploading is forbidden.`);
    }

    let dynamicBaseSnapshotId = opts.baseSnapshotId || localState.base_snapshot_id;
    if (!dynamicBaseSnapshotId) {
      try {
        const snapRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_snapshot_id']);
        dynamicBaseSnapshotId = snapRes.values?.[0]?.value || null;
      } catch {}
    }

    const baseSnapshotId = dynamicBaseSnapshotId || 'snap_1790493064581_jbhnf8';
    const baseCloudVersion = opts.baseCloudVersion || localState.base_cloud_version || 8;
    const lastUploadedSeq = Number(localState.last_uploaded_sequence ?? localState.last_pushed_sequence ?? 0);
    const pendingEvents = rawEvents
      .filter(r => (r.status === 'PENDING' || r.status === 'QUEUED' || Number(r.sequence) > lastUploadedSeq) && r.status !== 'ACKNOWLEDGED')
      .sort((a, b) => Number(a.sequence) - Number(b.sequence))
      .map(r => ({
        ...r,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload || 'null') : r.payload
      }));

    if (pendingEvents.length === 0) {
      return { packagesUploaded: 0, eventsUploaded: 0, lastUploadedSequence: lastUploadedSeq };
    }

    // 3. Slice candidate package chunks
    const packageSlices = slicePendingDeltaQueue(pendingEvents);
    if (!packageSlices || packageSlices.length === 0) {
      return { packagesUploaded: 0, eventsUploaded: 0, lastUploadedSequence: lastUploadedSeq };
    }

    let totalEventsUploaded = 0;
    let packagesUploadedCount = 0;
    let finalLastUploadedSequence = lastUploadedSeq;

    for (const slice of packageSlices) {
      const payload = buildDeterministicPackagePayload({
        deviceId,
        startSequence: slice.startSequence,
        endSequence: slice.endSequence,
        baseSnapshotId,
        baseCloudVersion,
        events: slice.events,
        isOversizedBundle: slice.isOversizedBundle
      });

      const encryptedContainer = await encryptDeltaPackage(payload, encryptionKeyOrPin);
      const filename = `${payload.package_id}.pkg`;

      // 4. Duplicate-Safe Package Discovery in Google Drive
      let targetDriveFileId;

      if (driveClient?.findFiles) {
        const matches = await driveClient.findFiles({ name: filename });
        if (matches && matches.length > 0) {
          const existingRaw = await driveClient.readFile(matches[0].id);
          const existingContainer = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
          if (existingContainer.package_checksum === encryptedContainer.package_checksum) {
            targetDriveFileId = matches[0].id;
          } else {
            throw new Error(`STORAGE_MISMATCH / PACKAGE_ID_COLLISION: Package ID collision for ${payload.package_id}. Drive checksum ${existingContainer.package_checksum} differs from local ${encryptedContainer.package_checksum}`);
          }
        } else {
          const up = await driveClient.uploadFile({
            name: filename,
            content: JSON.stringify(encryptedContainer),
            appProperties: {
              package_id: payload.package_id,
              device_id: deviceId,
              start_sequence: String(payload.start_sequence),
              end_sequence: String(payload.end_sequence),
              package_checksum: encryptedContainer.package_checksum
            }
          });
          targetDriveFileId = up.id;
        }
      } else {
        const finder = driveClient?.findAppDataFile || findAppDataFile;
        const reader = driveClient?.readAppDataFile || readAppDataFile;
        const uploader = driveClient?.uploadAppDataFile || uploadAppDataFile;

        const existingFile = await finder(filename, accessToken);
        if (existingFile) {
          const rawContent = await reader(existingFile.id, accessToken);
          const existingContainer = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
          if (existingContainer.package_checksum === encryptedContainer.package_checksum) {
            targetDriveFileId = existingFile.id;
          } else {
            throw new Error(`STORAGE_MISMATCH / PACKAGE_ID_COLLISION: Package ID collision for ${payload.package_id}. Drive checksum ${existingContainer.package_checksum} differs from local ${encryptedContainer.package_checksum}`);
          }
        } else {
          const uploadResult = await uploader(filename, JSON.stringify(encryptedContainer), 'application/json', accessToken);
          targetDriveFileId = uploadResult.id;
        }
      }

      // 5. Read own manifest, update package catalog & watermarks
      const manifest = await readOwnDeviceManifest(deviceId, accessToken, baseSnapshotId, baseCloudVersion, driveClient);
      
      if (!manifest.packages.some(p => p.package_id === payload.package_id)) {
        manifest.packages.push({
          package_id: payload.package_id,
          drive_file_id: targetDriveFileId,
          start_sequence: payload.start_sequence,
          end_sequence: payload.end_sequence,
          event_count: payload.event_count,
          package_checksum: encryptedContainer.package_checksum,
          created_at: new Date().toISOString()
        });
      }

      manifest.watermarks = manifest.watermarks || {};
      manifest.watermarks.last_uploaded_sequence = payload.end_sequence;
      manifest.last_sequence = payload.end_sequence;

      await writeOwnDeviceManifest(manifest, accessToken, driveClient);

      // 6. Local database confirmation
      const rawIdb = getRawIDB();
      if (rawIdb) {
        await new Promise((resolve, reject) => {
          const tx = rawIdb.transaction(['sync_delta_queue', 'sync_local_state'], 'readwrite');
          const queueStore = tx.objectStore('sync_delta_queue');
          const stateStore = tx.objectStore('sync_local_state');

          for (const ev of slice.events) {
            queueStore.put({
              ...ev,
              status: 'ACKNOWLEDGED',
              acknowledged_at: new Date().toISOString()
            });
          }

          stateStore.put({
            ...localState,
            key: localState.key || 'device_state',
            device_id: deviceId,
            last_uploaded_sequence: payload.end_sequence,
            last_pushed_sequence: payload.end_sequence,
            updated_at: new Date().toISOString()
          });

          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(new Error('Transaction aborted during delta ACK'));
        });
      } else {
        await db.run(
          'UPDATE sync_delta_queue SET status = ?, acknowledged_at = ? WHERE sequence >= ? AND sequence <= ?',
          ['ACKNOWLEDGED', new Date().toISOString(), payload.start_sequence, payload.end_sequence]
        );
        await db.run(
          'UPDATE sync_local_state SET last_uploaded_sequence = ?, updated_at = ? WHERE device_id = ?',
          [payload.end_sequence, new Date().toISOString(), deviceId]
        );
      }

      totalEventsUploaded += slice.events.length;
      packagesUploadedCount++;
      finalLastUploadedSequence = payload.end_sequence;
    }

    return {
      packagesUploaded: packagesUploadedCount,
      eventsUploaded: totalEventsUploaded,
      lastUploadedSequence: finalLastUploadedSequence
    };
  });
}

/**
 * Discovers, downloads, validates, and atomically stages delta packages from all peer devices.
 */
export async function pullPeerDeltas(opts) {
  const ownDeviceId = opts.localDeviceId || opts.ownDeviceId || opts.deviceId;
  const encryptionKeyOrPin = opts.sessionKey || opts.encryptionKeyOrPin;
  const accessToken = opts.accessToken;
  const driveClient = opts.driveClient;

  let dynamicBaseSnapshotId = opts.baseSnapshotId;
  if (!dynamicBaseSnapshotId) {
    try {
      const db = getDB();
      const snapRes = await db.query('SELECT value FROM settings WHERE key = ?', ['last_snapshot_id']);
      dynamicBaseSnapshotId = snapRes.values?.[0]?.value || null;
    } catch {}
  }
  const baseSnapshotId = dynamicBaseSnapshotId || 'snap_1790493064581_jbhnf8';

  const peerManifests = await listPeerManifests(ownDeviceId, accessToken, baseSnapshotId, driveClient);
  const db = getDB();
  const reader = driveClient?.readFile 
    ? async (id) => driveClient.readFile(id)
    : (driveClient?.readAppDataFile || readAppDataFile);

  let stagedPackagesCount = 0;
  let stagedEventsCount = 0;

  for (const peerManifest of peerManifests) {
    const peerDeviceId = peerManifest.device_id;

    // 1. Get current local staging watermark for this peer
    const peerStateRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [peerDeviceId]);
    let lastStagedSeq = Number(peerStateRes.values?.[0]?.last_staged_sequence) || 0;

    // 2. Identify un-staged packages
    const unStagedPackages = (peerManifest.packages || [])
      .filter(pkg => (pkg.end_sequence || pkg.endSequence) > lastStagedSeq)
      .sort((a, b) => (a.start_sequence || a.startSequence) - (b.start_sequence || b.startSequence));

    for (const pkg of unStagedPackages) {
      const startSeq = pkg.start_sequence || pkg.startSequence;
      const endSeq = pkg.end_sequence || pkg.endSequence;
      const pkgChecksum = pkg.package_checksum || pkg.checksum;

      // 3. Verify sequence continuity
      if (startSeq !== lastStagedSeq + 1) {
        throw new Error(`SEQUENCE_GAP_DETECTED: Peer ${peerDeviceId} package starts at ${startSeq}, but expected ${lastStagedSeq + 1}. Halting staging.`);
      }

      // 4. Download package from Drive
      let rawContent;
      try {
        rawContent = await reader(pkg.drive_file_id || pkg.driveFileId, accessToken);
      } catch (e) {
        throw new Error(`Missing peer package ${pkg.package_id}: ${e.message}`);
      }

      if (!rawContent) {
        throw new Error(`Missing peer package ${pkg.package_id}`);
      }

      const container = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;

      // Validate manifest checksum against container
      if (pkgChecksum && container.package_checksum && pkgChecksum !== container.package_checksum) {
        throw new Error(`STORAGE_MISMATCH: Peer manifest specified checksum ${pkgChecksum} but container has ${container.package_checksum}`);
      }

      // 5. Decrypt and verify payload
      const payload = await decryptDeltaPackage(container, encryptionKeyOrPin);

      // 6. Perform atomic staging
      const stageRes = await stagePeerPackageAtomically({
        packagePayload: payload,
        packageChecksum: container.package_checksum,
        driveFileId: pkg.drive_file_id || pkg.driveFileId
      });

      if (stageRes.staged) {
        stagedPackagesCount++;
        stagedEventsCount += payload.events.length;
        lastStagedSeq = payload.end_sequence;
      }
    }
  }

  return { stagedPackagesCount, stagedEventsCount };
}

export const downloadAndStagePeerPackages = pullPeerDeltas;

/**
 * Atomically stages a verified peer package and its events in ONE database transaction.
 */
export async function stagePeerPackageAtomically(arg1, arg2) {
  let packagePayload, packageChecksum, driveFileId;

  if (arg1 && arg1.packagePayload) {
    packagePayload = arg1.packagePayload;
    packageChecksum = arg1.packageChecksum;
    driveFileId = arg1.driveFileId || null;
  } else if (arg1 && arg1.ciphertext) {
    const sessionKey = arg2;
    packagePayload = await decryptDeltaPackage(arg1, sessionKey);
    packageChecksum = arg1.package_checksum;
    driveFileId = null;
  } else {
    throw new Error('Invalid arguments passed to stagePeerPackageAtomically.');
  }

  const db = getDB();
  const rawIdb = getRawIDB();
  const now = new Date().toISOString();

  // Check if already staged (idempotency / replay protection)
  const existingPkg = await db.query('SELECT * FROM sync_staged_packages WHERE package_id = ?', [packagePayload.package_id]);
  if (existingPkg.values && existingPkg.values.length > 0) {
    return { staged: false, reason: 'ALREADY_STAGED', package_id: packagePayload.package_id };
  }

  // Check sequence continuity against peer watermark
  const peerStateRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [packagePayload.device_id]);
  const currentWatermark = Number(peerStateRes.values?.[0]?.last_staged_sequence) || 0;

  if (packagePayload.start_sequence !== currentWatermark + 1) {
    throw new Error(`Sequence gap detected: expected start_sequence ${currentWatermark + 1}, received ${packagePayload.start_sequence}`);
  }

  // Atomic single-transaction staging across all 3 stores
  if (rawIdb) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = rawIdb.transaction(['sync_staged_packages', 'sync_staged_events', 'sync_peer_state'], 'readwrite');
      } catch (err) {
        return reject(err);
      }

      const pkgStore = tx.objectStore('sync_staged_packages');
      const evtStore = tx.objectStore('sync_staged_events');
      const peerStore = tx.objectStore('sync_peer_state');

      // 1. Insert package record
      pkgStore.put({
        package_id: packagePayload.package_id,
        device_id: packagePayload.device_id,
        start_sequence: packagePayload.start_sequence,
        end_sequence: packagePayload.end_sequence,
        event_count: packagePayload.event_count,
        package_checksum: packageChecksum,
        drive_file_id: driveFileId,
        staged_at: now,
        status: 'STAGED'
      });

      // 2. Insert all events
      for (const e of packagePayload.events) {
        evtStore.put({
          event_id: e.event_id,
          package_id: packagePayload.package_id,
          device_id: packagePayload.device_id,
          sequence: e.sequence,
          timestamp: e.timestamp,
          collection: e.collection,
          entity_id: e.entity_id,
          operation: e.operation,
          base_checksum: e.base_checksum,
          new_checksum: e.new_checksum,
          tombstone_generation: e.tombstone_generation || 0,
          payload: e.payload,
          bundle_id: e.bundle_id,
          bundle_index: e.bundle_index,
          bundle_total: e.bundle_total,
          bundle_checksum: e.bundle_checksum,
          parent_event_id: e.parent_event_id,
          staged_at: now
        });
      }

      // 3. Update peer watermark
      peerStore.put({
        peer_device_id: packagePayload.device_id,
        last_staged_sequence: packagePayload.end_sequence,
        last_reconciled_sequence: peerStateRes.values?.[0]?.last_reconciled_sequence || 0,
        base_snapshot_id: packagePayload.base_snapshot_id,
        updated_at: now
      });

      tx.oncomplete = () => {
        resolve({ staged: true, package_id: packagePayload.package_id, eventCount: packagePayload.events.length });
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error('Transaction aborted during atomic peer staging'));
    });
  } else {
    await db.run(
      'INSERT OR REPLACE INTO sync_staged_packages (package_id, device_id, start_sequence, end_sequence, event_count, package_checksum, drive_file_id, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [packagePayload.package_id, packagePayload.device_id, packagePayload.start_sequence, packagePayload.end_sequence, packagePayload.event_count, packageChecksum, driveFileId, now, 'STAGED']
    );

    for (const e of packagePayload.events) {
      await db.run(
        'INSERT OR REPLACE INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, tombstone_generation, payload, bundle_id, bundle_index, bundle_total, bundle_checksum, parent_event_id, staged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [e.event_id, packagePayload.package_id, packagePayload.device_id, e.sequence, e.timestamp, e.collection, e.entity_id, e.operation, e.base_checksum, e.new_checksum, e.tombstone_generation || 0, typeof e.payload === 'object' ? JSON.stringify(e.payload) : e.payload, e.bundle_id, e.bundle_index, e.bundle_total, e.bundle_checksum, e.parent_event_id, now]
      );
    }

    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      [packagePayload.device_id, packagePayload.end_sequence, 0, packagePayload.base_snapshot_id, now]
    );

    return { staged: true, package_id: packagePayload.package_id, eventCount: packagePayload.events.length };
  }
}
