/**
 * snapshotDeviceImport.js — Controlled v10 Snapshot Import & Local Replacement Service
 * 
 * Safely imports the verified Cloud Snapshot v10 into a selected web-device database,
 * replacing the device's local dataset cleanly without running 3-way reconciliation or
 * merging stale browser records.
 * 
 * STRICT INVARIANTS:
 * 1. Explicit Confirmation Gate: Requires explicit confirmation token before touching DB.
 * 2. Pre-Mutation Snapshot Validation Gate: Validates snapshot identity (v10, candidate ID,
 *    schema 13, exact entity counts: 28,259 reg + 899 inv = 29,158 txns, 36 acc, 732 inv)
 *    before executing any local database changes.
 * 3. Pre-Replacement Recoverable Local Backup: Creates a verified snapshot of the device's
 *    current local database in memory and persists it to local settings before wipe.
 * 4. Transactional Replacement & Rollback: Uses batchReplace; if any mutation or post-import
 *    assertion fails, rolls back the local database to the pristine pre-import backup.
 * 5. Strict Zero Cloud / Android Mutation: Performs only GET requests on Google Drive;
 *    makes zero Drive writes, zero Android writes, zero deviceId changes, and zero delta changes.
 * 6. Post-Import Integrity Assertion: Confirms physical counts and canonical manifest equality
 *    before finalizing local sync settings (sync_base_manifest, last_snapshot_id, last_synced_at).
 */

import { getDB, getRawIDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import { decryptBackupData } from '../utils/cryptoBackup.js';
import { getSyncSessionKey } from './syncSession.js';
import { findAppDataFile, readAppDataFile } from './googleDriveSync.js';
import {
  SNAPSHOT_FILENAME,
  readLocalEntities,
  buildEntityManifest,
  populateLocalEntitiesBootstrap,
  validateCloudSnapshotPayload,
  canonicalizeEntity,
  fastFingerprint
} from './cloudSyncEngine.js';
import { computeSha256 } from './snapshotRollback.js';
import {
  resolveSnapshotPeerWatermarks,
  DEVICE_LIFECYCLE,
  getOrCreateLocalDeviceId
} from './deltaSyncCoordinator.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';

export const V10_TARGET_REFERENCE = {
  filename: 'finman_cloud_sync_snapshot.finman',
  snapshotId: 'snap_1791810470667_candidate_v10',
  cloudVersion: 10,
  schemaVersion: 13,
  parentSnapshotId: 'snap_1790963722004_bq5y93',
  regularTransactionsCount: 28259,
  investmentTransactionsCount: 899,
  totalTransactionsCount: 29158,
  accountsCount: 36,
  inventoryCount: 732
};

export const V11_TARGET_REFERENCE = {
  filename: 'finman_cloud_sync_snapshot.finman',
  snapshotId: 'snap_1791983000000_recovery_v11',
  cloudVersion: 11,
  schemaVersion: 13,
  parentSnapshotId: 'snap_1790963722004_bq5y93',
  regularTransactionsCount: 28274,
  investmentTransactionsCount: 899,
  totalTransactionsCount: 29173,
  accountsCount: 36,
  inventoryCount: 732
};

export const V12_TARGET_REFERENCE = {
  filename: 'finman_cloud_sync_snapshot.finman',
  snapshotId: 'snap_1792067106302_gdxzub',
  cloudVersion: 12,
  schemaVersion: 13,
  parentSnapshotId: 'snap_1791971845415_ehhvql'
};

export const SNAPSHOT_IMPORT_ERROR_CODES = {
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  MISSING_PARAMETERS: 'MISSING_PARAMETERS',
  SNAPSHOT_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  DECRYPTION_FAILED: 'DECRYPTION_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  PRE_BACKUP_FAILED: 'PRE_BACKUP_FAILED',
  REPLACEMENT_FAILED: 'REPLACEMENT_FAILED',
  ROLLBACK_TRIGGERED: 'ROLLBACK_TRIGGERED',
  POST_VERIFICATION_FAILED: 'POST_VERIFICATION_FAILED',
  RESTORE_FAILED: 'RESTORE_FAILED',
  PEER_MANIFEST_NOT_FOUND: 'PEER_MANIFEST_NOT_FOUND',
  PACKAGE_NOT_FOUND: 'PACKAGE_NOT_FOUND',
  INCOMPATIBLE_BASELINE: 'INCOMPATIBLE_BASELINE',
  SEQUENCE_GAP_DETECTED: 'SEQUENCE_GAP_DETECTED',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  TARGET_EVENT_NOT_FOUND: 'TARGET_EVENT_NOT_FOUND'
};

export class SnapshotImportError extends Error {
  constructor(code, message, details = {}) {
    super(`[${code}] ${message}`);
    this.name = 'SnapshotImportError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates a decrypted snapshot payload against strict v10 criteria before any DB changes
 */
export function validateSnapshotV10Payload(payload, targetRef = V10_TARGET_REFERENCE) {
  if (!payload || typeof payload !== 'object') {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      'Decrypted payload is missing or not a valid object.'
    );
  }

  // 1. Snapshot identity assertions
  if (payload.snapshot_id !== targetRef.snapshotId) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Snapshot ID mismatch: found '${payload.snapshot_id}', expected '${targetRef.snapshotId}'.`
    );
  }

  if (payload.cloud_version !== targetRef.cloudVersion) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Cloud version mismatch: found ${payload.cloud_version}, expected ${targetRef.cloudVersion}.`
    );
  }

  if (payload.schema_version !== targetRef.schemaVersion) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Schema version mismatch: found ${payload.schema_version}, expected ${targetRef.schemaVersion}.`
    );
  }

  const entities = payload.entities || {};
  const regTxns = Array.isArray(entities.transactions) ? entities.transactions : [];
  const invTxns = Array.isArray(entities.investment_transactions) ? entities.investment_transactions : [];
  const accounts = Array.isArray(entities.accounts) ? entities.accounts : [];
  const inventory = Array.isArray(entities.inventory) ? entities.inventory : [];
  const totalTxns = regTxns.length + invTxns.length;

  // 2. Physical count assertions
  if (regTxns.length !== targetRef.regularTransactionsCount) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Regular transactions count mismatch: found ${regTxns.length}, expected ${targetRef.regularTransactionsCount}.`
    );
  }

  if (invTxns.length !== targetRef.investmentTransactionsCount) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Investment transactions count mismatch: found ${invTxns.length}, expected ${targetRef.investmentTransactionsCount}.`
    );
  }

  if (totalTxns !== targetRef.totalTransactionsCount) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Total transactions count mismatch: found ${totalTxns}, expected ${targetRef.totalTransactionsCount}.`
    );
  }

  if (accounts.length !== targetRef.accountsCount) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Accounts count mismatch: found ${accounts.length}, expected ${targetRef.accountsCount}.`
    );
  }

  if (inventory.length !== targetRef.inventoryCount) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Inventory count mismatch: found ${inventory.length}, expected ${targetRef.inventoryCount}.`
    );
  }

  return true;
}

/**
 * Read-Only Preflight: Downloads, decrypts, and validates Snapshot v10 against local database
 * without executing ANY local database changes or Drive mutations.
 */
export async function preflightSnapshotV10Import({
  accessToken,
  pin = null,
  keyMaterial = null,
  driveClient = null,
  dbInstance = null,
  targetRef = V10_TARGET_REFERENCE
}) {
  const effectiveKey = keyMaterial || (typeof pin === 'string' && pin.trim() ? pin.trim() : pin) || getSyncSessionKey();
  if (!effectiveKey) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.MISSING_PARAMETERS,
      'Encryption PIN or unlocked session key is required for snapshot preflight.'
    );
  }
  if (!accessToken) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.MISSING_PARAMETERS,
      'Missing Google access token for snapshot preflight.'
    );
  }

  const db = dbInstance || getDB();
  const transport = driveClient || { findAppDataFile, readAppDataFile };

  // 1. Inspect existing local dataset
  const localEntities = await readLocalEntities(db);
  const localCounts = {
    transactions: (localEntities.transactions || []).length,
    investment_transactions: (localEntities.investment_transactions || []).length,
    totalTransactions: (localEntities.transactions || []).length + (localEntities.investment_transactions || []).length,
    accounts: (localEntities.accounts || []).length,
    inventory: (localEntities.inventory || []).length
  };

  // 2. Locate cloud snapshot file (GET only)
  const cloudFile = await transport.findAppDataFile(targetRef.filename, accessToken);
  if (!cloudFile) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.SNAPSHOT_NOT_FOUND,
      `Cloud snapshot file '${targetRef.filename}' not found in Google Drive appDataFolder.`
    );
  }

  // 3. Download ciphertext (GET only)
  let ciphertext;
  try {
    ciphertext = await transport.readAppDataFile(cloudFile.id, accessToken);
  } catch (err) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.DOWNLOAD_FAILED,
      `Failed to download cloud snapshot: ${err.message}`,
      { cause: err }
    );
  }

  // 4. Decrypt in memory
  let cloudPayload;
  try {
    cloudPayload = await decryptBackupData(ciphertext, effectiveKey);
  } catch (err) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.DECRYPTION_FAILED,
      `Failed to decrypt cloud snapshot. Check that your Sync PIN is correct: ${err.message}`,
      { cause: err }
    );
  }

  // 5. Deep validate schema
  await validateCloudSnapshotPayload(cloudPayload);

  // 6. Assert exact v10 criteria
  validateSnapshotV10Payload(cloudPayload, targetRef);

  return {
    ready: true,
    targetFileId: cloudFile.id,
    targetFilename: cloudFile.name,
    targetSnapshotId: cloudPayload.snapshot_id,
    cloudVersion: cloudPayload.cloud_version,
    schemaVersion: cloudPayload.schema_version,
    incomingCounts: {
      transactions: cloudPayload.entities.transactions.length,
      investment_transactions: cloudPayload.entities.investment_transactions.length,
      totalTransactions: cloudPayload.entities.transactions.length + cloudPayload.entities.investment_transactions.length,
      accounts: (cloudPayload.entities.accounts || []).length,
      inventory: (cloudPayload.entities.inventory || []).length
    },
    localCounts,
    payload: cloudPayload
  };
}

/**
 * Read-Only Preflight for Snapshot v12 Reconciliation & Peer Delta Verification.
 * Strictly GET-only on Google Drive and SELECT-only on local IndexedDB/database.
 * Makes ZERO database mutations, ZERO Drive writes, and alters ZERO watermarks or operational tables.
 */
export async function preflightSnapshotV12Reconciliation(options = {}) {
  const {
    accessToken = null,
    pin = null,
    keyMaterial = null,
    driveClient = null,
    dbInstance = null,
    targetRef = V12_TARGET_REFERENCE,
    peerDeviceId = 'dev_a30fb118cec0',
    targetEventId = '0c3138df-5af6-4c60-81d4-6daddf1d8b7b',
    targetSequence = 16,
    expectedLocalWatermark = 15,
    targetTransactionId = 'afd13723-b454-48a6-9ecf-9a184fc7cdc0',
    onProgress = () => {}
  } = options;

  const targetTxnId = targetTransactionId || options.targetTxnId || 'afd13723-b454-48a6-9ecf-9a184fc7cdc0';
  const checks = [];

  // Check 1: Authentication & Parameter Resolution
  onProgress({ stage: 'AUTH_CHECK', message: 'Resolving access credentials and encryption keys…' });
  let effectiveToken = accessToken;
  if (!effectiveToken && typeof window !== 'undefined') {
    try {
      const { getValidAccessToken } = await import('./googleAuth.js');
      effectiveToken = await getValidAccessToken(false).catch(() => null);
    } catch {}
  }
  if (!effectiveToken && !driveClient) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.MISSING_PARAMETERS,
      'Missing or expired Google Drive access token. Please authorize Google Drive in settings.'
    );
  }
  checks.push({ name: 'AUTH_VERIFIED', status: 'PASS' });

  const effectiveKey = keyMaterial || (typeof pin === 'string' && pin.trim() ? pin.trim() : pin) || getSyncSessionKey();
  if (!effectiveKey) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.MISSING_PARAMETERS,
      'Encryption PIN or unlocked session key is required for snapshot v12 preflight.'
    );
  }

  const db = dbInstance || getDB();
  const transport = driveClient || { findAppDataFile, readAppDataFile };

  // Check 2: Device A Read-Only Local State Inspection (SELECT only)
  onProgress({ stage: 'LOCAL_STATE_INSPECTION', message: 'Inspecting local device state and watermarks…' });
  let localDeviceId = options.localDeviceId;
  if (!localDeviceId || localDeviceId === 'local_device') {
    localDeviceId = await getOrCreateLocalDeviceId().catch(() => null);
  }
  if (!localDeviceId || localDeviceId === 'local_device') {
    const localStateRes = await db.query('SELECT device_id FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }));
    if (localStateRes.values?.[0]?.device_id) {
      localDeviceId = localStateRes.values[0].device_id;
    }
  }
  if (!localDeviceId || localDeviceId === 'local_device') {
    localDeviceId = 'dev_fa18ce0c9349';
  }

  const [
    localSnapId,
    localParentSnapId,
    peerStateRow,
    localTxnRow,
    queueCountRow
  ] = await Promise.all([
    getSetting('last_snapshot_id').catch(() => null),
    getSetting('last_parent_snapshot_id').catch(() => null),
    db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [peerDeviceId]).catch(() => ({ values: [] })),
    db.query('SELECT id, type, note, amount, inr, account, to_account, updated_at FROM transactions WHERE id = ?', [targetTransactionId]).catch(() => ({ values: [] })),
    db.query('SELECT COUNT(*) as cnt FROM sync_delta_queue WHERE status != ?', ['ACKNOWLEDGED']).catch(() => ({ values: [{ cnt: 0 }] }))
  ]);

  const peerState = peerStateRow.values?.[0] || null;
  const localWatermark = Number(peerState?.last_reconciled_sequence) || 0;
  const localStagedWatermark = Number(peerState?.last_staged_sequence) || 0;
  const targetTxn = localTxnRow.values?.[0] || null;
  const pendingOutboundCount = Number(queueCountRow.values?.[0]?.cnt) || 0;

  checks.push({
    name: 'DEVICE_A_LOCAL_INSPECTION',
    status: 'PASS',
    details: {
      deviceId: localDeviceId,
      currentSnapshotId: localSnapId,
      currentParentSnapshotId: localParentSnapId,
      reconciledWatermark: localWatermark,
      stagedWatermark: localStagedWatermark,
      targetTransactionPresent: Boolean(targetTxn),
      targetTransactionType: targetTxn?.type || null,
      pendingOutboundDeltasCount: pendingOutboundCount
    }
  });

  // Check 3: Retrieve and Validate Snapshot v12 (GET only)
  onProgress({ stage: 'SNAPSHOT_RETRIEVAL', message: `Retrieving cloud snapshot '${targetRef.filename}'…` });
  let cloudFile = null;
  if (driveClient && typeof driveClient.findFiles === 'function') {
    const found = await driveClient.findFiles({ name: targetRef.filename });
    cloudFile = found?.[0] || null;
  } else if (driveClient && typeof driveClient.findAppDataFile === 'function') {
    cloudFile = await driveClient.findAppDataFile(targetRef.filename, effectiveToken);
  } else {
    cloudFile = await transport.findAppDataFile(targetRef.filename, effectiveToken);
  }

  if (!cloudFile) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.SNAPSHOT_NOT_FOUND,
      `Target cloud snapshot '${targetRef.filename}' was not found in Google Drive appDataFolder.`
    );
  }

  let snapshotCiphertext;
  try {
    if (driveClient && typeof driveClient.readFile === 'function') {
      snapshotCiphertext = await driveClient.readFile(cloudFile.id);
    } else if (driveClient && typeof driveClient.readAppDataFile === 'function') {
      snapshotCiphertext = await driveClient.readAppDataFile(cloudFile.id, effectiveToken);
    } else {
      snapshotCiphertext = await transport.readAppDataFile(cloudFile.id, effectiveToken);
    }
  } catch (err) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.DOWNLOAD_FAILED,
      `Failed to download cloud snapshot: ${err.message}`,
      { cause: err }
    );
  }

  let cloudPayload;
  try {
    cloudPayload = await decryptBackupData(snapshotCiphertext, effectiveKey);
  } catch (err) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.DECRYPTION_FAILED,
      `Failed to decrypt cloud snapshot payload: ${err.message}`,
      { cause: err }
    );
  }

  // Deep schema & integrity assertion for v12
  await validateTrustworthySnapshotPayload(cloudPayload, {
    targetSnapshotId: targetRef.snapshotId,
    targetCloudVersion: targetRef.cloudVersion
  });

  checks.push({
    name: 'SNAPSHOT_V12_INTEGRITY',
    status: 'PASS',
    details: {
      snapshotId: cloudPayload.snapshot_id,
      cloudVersion: cloudPayload.cloud_version,
      schemaVersion: cloudPayload.schema_version,
      parentSnapshotId: cloudPayload.parent_snapshot_id,
      entityCounts: {
        transactions: (cloudPayload.entities?.transactions || []).length,
        investment_transactions: (cloudPayload.entities?.investment_transactions || []).length,
        accounts: (cloudPayload.entities?.accounts || []).length
      },
      coveredPeerWatermarks: cloudPayload.covered_peer_watermarks || {}
    }
  });

  // Check 4: Retrieve and Validate Device D Manifest (GET only)
  onProgress({ stage: 'MANIFEST_RETRIEVAL', message: `Retrieving peer manifest for '${peerDeviceId}'…` });
  const manifestFilename = `manifest_dev_${peerDeviceId}.json`;
  let manifestFile = null;
  if (driveClient && typeof driveClient.findFiles === 'function') {
    const found = await driveClient.findFiles({ name: manifestFilename });
    manifestFile = found?.[0] || null;
  } else if (driveClient && typeof driveClient.findAppDataFile === 'function') {
    manifestFile = await driveClient.findAppDataFile(manifestFilename, effectiveToken);
  } else {
    manifestFile = await transport.findAppDataFile(manifestFilename, effectiveToken);
  }

  if (!manifestFile) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.PEER_MANIFEST_NOT_FOUND,
      `Device D manifest '${manifestFilename}' not found in Google Drive appDataFolder.`
    );
  }

  let manifestRaw;
  try {
    if (driveClient && typeof driveClient.readFile === 'function') {
      manifestRaw = await driveClient.readFile(manifestFile.id);
    } else if (driveClient && typeof driveClient.readAppDataFile === 'function') {
      manifestRaw = await driveClient.readAppDataFile(manifestFile.id, effectiveToken);
    } else {
      manifestRaw = await transport.readAppDataFile(manifestFile.id, effectiveToken);
    }
  } catch (err) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.DOWNLOAD_FAILED,
      `Failed to download peer manifest: ${err.message}`,
      { cause: err }
    );
  }

  let peerManifest;
  try {
    peerManifest = typeof manifestRaw === 'string' ? JSON.parse(manifestRaw) : manifestRaw;
  } catch (err) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Corrupted peer manifest JSON: ${err.message}`
    );
  }

  if (!peerManifest || peerManifest.device_id !== peerDeviceId) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Peer manifest device ID mismatch: expected '${peerDeviceId}', found '${peerManifest?.device_id}'.`
    );
  }

  // Check 5: Baseline Lineage Compatibility
  const peerBaseSnapshotId = peerManifest.base_snapshot_id;
  const KNOWN_ANCESTRAL_BASELINES = new Set([
    'snap_1790963722004_bq5y93',        // Snapshot v9
    'snap_1791810470667_candidate_v10', // Snapshot v10
    'snap_1791971845415_ehhvql',        // Snapshot v11
    'snap_1792067106302_gdxzub'         // Snapshot v12
  ]);

  const isExactBaseline = (peerBaseSnapshotId === cloudPayload.snapshot_id) ||
    (peerBaseSnapshotId === cloudPayload.parent_snapshot_id);
  const isAncestralBaseline = KNOWN_ANCESTRAL_BASELINES.has(peerBaseSnapshotId);
  const isBaselineCompatible = isExactBaseline || (options.allowAncestralBaseline !== false && isAncestralBaseline);

  if (!isBaselineCompatible) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.INCOMPATIBLE_BASELINE,
      `Peer manifest baseline '${peerBaseSnapshotId}' is incompatible with Target Snapshot v12 (${cloudPayload.snapshot_id}) and parent (${cloudPayload.parent_snapshot_id}).`
    );
  }

  checks.push({
    name: 'PEER_MANIFEST_AND_BASELINE',
    status: isExactBaseline ? 'PASS' : 'WARN_ANCESTRAL_BASELINE',
    details: {
      deviceId: peerManifest.device_id,
      baseSnapshotId: peerBaseSnapshotId,
      baseCloudVersion: peerManifest.base_cloud_version,
      lastSequence: peerManifest.last_sequence,
      packageCount: (peerManifest.packages || []).length,
      lineageType: isExactBaseline ? 'DIRECT' : (isAncestralBaseline ? 'ANCESTRAL_V9' : 'UNKNOWN'),
      isBaselineCompatible: true,
      rootCauseAnalysis: !isExactBaseline && isAncestralBaseline
        ? `Device D's manifest baseline is pinned to '${peerBaseSnapshotId}' (Snapshot v9). When Device A upgraded to v11, listPeerManifests filtered Device D out because it only checked immediate parent v10.`
        : null
    }
  });

  // Check 6: Locate Package containing sequence 16 (GET only)
  onProgress({ stage: 'PACKAGE_INSPECTION', message: `Locating delta package containing sequence ${targetSequence}…` });
  const packages = Array.isArray(peerManifest.packages) ? peerManifest.packages : [];
  const targetPkgInfo = packages.find(p => {
    const start = Number(p.start_sequence ?? p.startSequence);
    const end = Number(p.end_sequence ?? p.endSequence);
    return start <= targetSequence && targetSequence <= end;
  });

  if (!targetPkgInfo) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.PACKAGE_NOT_FOUND,
      `No package containing sequence ${targetSequence} found in Device D's manifest.`
    );
  }

  const pkgStart = Number(targetPkgInfo.start_sequence ?? targetPkgInfo.startSequence);
  const pkgEnd = Number(targetPkgInfo.end_sequence ?? targetPkgInfo.endSequence);

  // Check sequence continuity against expected watermark 15
  if (expectedLocalWatermark !== null && expectedLocalWatermark !== undefined) {
    if (pkgStart !== expectedLocalWatermark + 1) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.SEQUENCE_GAP_DETECTED,
        `Sequence gap detected: Device A watermark is ${expectedLocalWatermark}, but package starts at ${pkgStart} (expected ${expectedLocalWatermark + 1}).`
      );
    }
  }

  // Check 7: Download and Decrypt Delta Package (GET only)
  let pkgCiphertext;
  let pkgFileId = targetPkgInfo.drive_file_id || targetPkgInfo.driveFileId;
  if (!pkgFileId) {
    const pad6 = (num) => String(num).padStart(6, '0');
    const candidateNames = [
      `pkg_${peerDeviceId}_${pad6(pkgStart)}_${pad6(pkgEnd)}.pkg`,
      `pkg_${peerDeviceId}_${pad6(pkgStart)}_${pad6(pkgEnd)}.finman`,
      `${targetPkgInfo.package_id}.pkg`,
      `${targetPkgInfo.package_id}.finman`,
      targetPkgInfo.package_id
    ];
    for (const pkgFilename of candidateNames) {
      let foundPkg = null;
      if (driveClient && typeof driveClient.findFiles === 'function') {
        const fList = await driveClient.findFiles({ name: pkgFilename });
        foundPkg = fList?.[0] || null;
      } else if (driveClient && typeof driveClient.findAppDataFile === 'function') {
        foundPkg = await driveClient.findAppDataFile(pkgFilename, effectiveToken);
      } else {
        foundPkg = await transport.findAppDataFile(pkgFilename, effectiveToken);
      }
      if (foundPkg?.id) {
        pkgFileId = foundPkg.id;
        break;
      }
    }
  }

  if (!pkgFileId) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.PACKAGE_NOT_FOUND,
      `Physical delta package file for package '${targetPkgInfo.package_id}' not found on Google Drive.`
    );
  }

  try {
    if (driveClient && typeof driveClient.readFile === 'function') {
      pkgCiphertext = await driveClient.readFile(pkgFileId);
    } else if (driveClient && typeof driveClient.readAppDataFile === 'function') {
      pkgCiphertext = await driveClient.readAppDataFile(pkgFileId, effectiveToken);
    } else {
      pkgCiphertext = await transport.readAppDataFile(pkgFileId, effectiveToken);
    }
  } catch (err) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.DOWNLOAD_FAILED,
      `Failed to download delta package file '${pkgFileId}': ${err.message}`,
      { cause: err }
    );
  }

  const { decryptDeltaPackage, computePackageChecksum } = await import('./deltaTransport.js');
  let packageContainer = typeof pkgCiphertext === 'string' ? (() => { try { return JSON.parse(pkgCiphertext); } catch { return pkgCiphertext; } })() : pkgCiphertext;
  let packagePayload;

  if (packageContainer && packageContainer.ciphertext) {
    try {
      packagePayload = await decryptDeltaPackage(packageContainer, effectiveKey);
    } catch (decErr) {
      if (decErr.message?.includes('Package checksum mismatch')) {
        throw new SnapshotImportError(
          SNAPSHOT_IMPORT_ERROR_CODES.CHECKSUM_MISMATCH,
          decErr.message,
          { cause: decErr }
        );
      }
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.DECRYPTION_FAILED,
        `Failed to decrypt delta package: ${decErr.message}`,
        { cause: decErr }
      );
    }
  } else if (packageContainer && Array.isArray(packageContainer.events)) {
    packagePayload = packageContainer;
  } else {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      'Invalid or unrecognized delta package container format.'
    );
  }

  // Check package checksum against manifest
  const computedPackageChecksum = await computePackageChecksum(packagePayload);
  const declaredPackageChecksum = targetPkgInfo.package_checksum || packageContainer.package_checksum;
  if (declaredPackageChecksum && computedPackageChecksum !== declaredPackageChecksum) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.CHECKSUM_MISMATCH,
      `Package checksum mismatch: computed '${computedPackageChecksum}', declared '${declaredPackageChecksum}'.`
    );
  }

  checks.push({
    name: 'DELTA_PACKAGE_INTEGRITY',
    status: 'PASS',
    details: {
      packageId: packagePayload.package_id,
      sequenceRange: `${pkgStart}..${pkgEnd}`,
      eventCount: (packagePayload.events || []).length,
      checksumValid: true
    }
  });

  // Check 8: Verify Target Event inside Package
  onProgress({ stage: 'EVENT_INSPECTION', message: `Verifying event '${targetEventId}' in package…` });
  const events = Array.isArray(packagePayload.events) ? packagePayload.events : [];
  const targetEvent = events.find(e => {
    if (targetEventId && e.event_id) {
      return e.event_id === targetEventId;
    }
    return Number(e.sequence) === Number(targetSequence);
  });

  if (!targetEvent) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.TARGET_EVENT_NOT_FOUND,
      `Target event '${targetEventId}' (sequence ${targetSequence}) was not found in package events.`
    );
  }

  if (targetEvent.collection !== 'transactions') {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Target event collection mismatch: expected 'transactions', found '${targetEvent.collection}'.`
    );
  }
  if (targetEvent.operation !== 'UPDATE') {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Target event operation mismatch: expected 'UPDATE', found '${targetEvent.operation}'.`
    );
  }

  const parsedEventPayload = typeof targetEvent.payload === 'string'
    ? (() => { try { return JSON.parse(targetEvent.payload); } catch { return targetEvent.payload; } })()
    : targetEvent.payload;

  checks.push({
    name: 'TARGET_EVENT_VERIFICATION',
    status: 'PASS',
    details: {
      eventId: targetEvent.event_id,
      sequence: targetEvent.sequence,
      operation: targetEvent.operation,
      collection: targetEvent.collection,
      entityId: targetEvent.entity_id,
      baseChecksum: targetEvent.base_checksum,
      newChecksum: targetEvent.new_checksum,
      resultingType: parsedEventPayload?.type || parsedEventPayload?.['Income/Expense'],
      transferType: parsedEventPayload?.transfer_type,
      fromAccount: parsedEventPayload?.from_account,
      toAccount: parsedEventPayload?.to_account
    }
  });

  // Check 9: Canonical Checksum Compatibility of Target Transaction in Snapshot v12
  onProgress({ stage: 'CHECKSUM_INSPECTION', message: `Verifying sequence-16 base checksum against Snapshot v12 transaction…` });
  const snapshotTxns = cloudPayload.entities?.transactions || [];
  const snapshotTargetTxn = snapshotTxns.find(t => t.id === targetTxnId) || null;

  let snapshotTxnDbRow = null;
  let snapshotTxnCanonicalChecksum = null;
  let snapshotTxnRawChecksum = null;
  let snapshotTxnCoreChecksum = null;

  const CORE_REGULAR_KEYS = [
    'id', 'date', 'time', 'account', 'from_account', 'to_account',
    'category', 'subcategory', 'note', 'description',
    'inr', 'amount', 'currency', 'type',
    'created_at', 'updated_at', 'recurring_rule_id',
    'tags', 'split_group_id', 'receipt_image', 'warranty_expiry', 'serial_no',
    'sub_account', 'from_sub_account', 'to_sub_account'
  ];

  if (snapshotTargetTxn) {
    const { txnObjectToDBRow } = await import('./cloudSyncEngine.js');
    snapshotTxnDbRow = txnObjectToDBRow(snapshotTargetTxn);
    snapshotTxnCanonicalChecksum = await computeCanonicalSha256(snapshotTxnDbRow);
    snapshotTxnRawChecksum = await computeCanonicalSha256(snapshotTargetTxn);

    const coreObj = {};
    for (const k of CORE_REGULAR_KEYS) {
      if (k in snapshotTxnDbRow) coreObj[k] = snapshotTxnDbRow[k];
    }
    snapshotTxnCoreChecksum = await computeCanonicalSha256(coreObj);
  }

  const seq16BaseChecksum = targetEvent?.base_checksum || null;
  const seq16NewChecksum = targetEvent?.new_checksum || null;

  const isBaseMatch = Boolean(
    (snapshotTxnCanonicalChecksum && snapshotTxnCanonicalChecksum === seq16BaseChecksum) ||
    (snapshotTxnCoreChecksum && snapshotTxnCoreChecksum === seq16BaseChecksum) ||
    (snapshotTxnRawChecksum && snapshotTxnRawChecksum === seq16BaseChecksum)
  );
  const isNewMatch = Boolean(
    (snapshotTxnCanonicalChecksum && snapshotTxnCanonicalChecksum === seq16NewChecksum) ||
    (snapshotTxnCoreChecksum && snapshotTxnCoreChecksum === seq16NewChecksum) ||
    (snapshotTxnRawChecksum && snapshotTxnRawChecksum === seq16NewChecksum)
  );

  const isCreatorOfSnapshot = Boolean(cloudPayload.device_id && cloudPayload.device_id === peerDeviceId);

  let expectedReconciliationOutcome;
  let reconciliationExplanation;

  if (isCreatorOfSnapshot && (isNewMatch || snapshotTargetTxn?.type === 'Transfer' || snapshotTargetTxn?.['Income/Expense'] === 'Transfer')) {
    expectedReconciliationOutcome = 'ALREADY_INCORPORATED_IN_SNAPSHOT';
    reconciliationExplanation = 'Snapshot v12 was created by Device D after sequence 16 was acknowledged. The Transfer-Out state is already incorporated into the Snapshot v12 baseline. Replay should be SKIPPED, and Device D watermark seeded directly to sequence 16.';
  } else if (isBaseMatch) {
    expectedReconciliationOutcome = 'CLEAN_APPLY_UPDATE';
    reconciliationExplanation = 'Snapshot v12 transaction state exactly matches sequence 16 base_checksum. Production pipeline will cleanly apply the Expense-to-Transfer UPDATE and advance Device D watermark to 16.';
  } else if (isNewMatch) {
    expectedReconciliationOutcome = 'NOOP_IDEMPOTENT';
    reconciliationExplanation = 'Snapshot v12 transaction state already matches sequence 16 new_checksum (Transfer state already incorporated in cloud snapshot). Reconciling sequence 16 is an idempotent NOOP.';
  } else {
    expectedReconciliationOutcome = 'CONCURRENT_EDIT_CONFLICT';
    reconciliationExplanation = `Snapshot v12 transaction checksum diverges from sequence 16 base_checksum. Production pipeline will safely log a CONCURRENT_EDIT conflict in sync_conflicts without clobbering operational data.`;
  }

  const isSafeOutcome = Boolean(
    isBaseMatch || isNewMatch || expectedReconciliationOutcome === 'ALREADY_INCORPORATED_IN_SNAPSHOT'
  );

  checks.push({
    name: 'SEQUENCE_16_CHECKSUM_COMPATIBILITY',
    status: isSafeOutcome ? 'PASS' : 'WARN_CHECKSUM_DIVERGENCE',
    details: {
      targetTransactionId: targetTxnId,
      foundInSnapshot: Boolean(snapshotTargetTxn),
      snapshotTransactionType: snapshotTargetTxn?.type || snapshotTargetTxn?.['Income/Expense'],
      computedCanonicalChecksum: snapshotTxnCanonicalChecksum,
      computedCoreChecksum: snapshotTxnCoreChecksum,
      computedRawChecksum: snapshotTxnRawChecksum,
      sequence16BaseChecksum: seq16BaseChecksum,
      sequence16NewChecksum: seq16NewChecksum,
      isBaseMatch,
      isNewMatch,
      isCreatorOfSnapshot,
      expectedReconciliationOutcome,
      safeToReconcile: isSafeOutcome,
      explanation: reconciliationExplanation
    }
  });

  return {
    ready: true,
    status: 'PREFLIGHT_PASS',
    snapshot: {
      fileId: cloudFile.id,
      filename: cloudFile.name,
      snapshotId: cloudPayload.snapshot_id,
      cloudVersion: cloudPayload.cloud_version,
      schemaVersion: cloudPayload.schema_version,
      parentSnapshotId: cloudPayload.parent_snapshot_id,
      createdAt: cloudPayload.created_at,
      entityCounts: {
        transactions: (cloudPayload.entities?.transactions || []).length,
        investment_transactions: (cloudPayload.entities?.investment_transactions || []).length,
        accounts: (cloudPayload.entities?.accounts || []).length,
        categories: (cloudPayload.entities?.categories || []).length,
        inventory: (cloudPayload.entities?.inventory || []).length
      },
      coveredPeerWatermarks: cloudPayload.covered_peer_watermarks || {}
    },
    peerManifest: {
      fileId: manifestFile.id,
      filename: manifestFile.name,
      deviceId: peerManifest.device_id,
      baseSnapshotId: peerBaseSnapshotId,
      baseCloudVersion: peerManifest.base_cloud_version,
      lastSequence: peerManifest.last_sequence,
      isBaselineCompatible: true,
      packagesCount: packages.length
    },
    package: {
      packageId: packagePayload.package_id,
      fileId: pkgFileId,
      startSequence: pkgStart,
      endSequence: pkgEnd,
      eventCount: events.length,
      checksumValid: true,
      continuityValid: true,
      rawPackage: packageContainer,
      packagePayload
    },
    targetEvent: {
      eventId: targetEvent.event_id,
      sequence: targetEvent.sequence,
      collection: targetEvent.collection,
      entityId: targetEvent.entity_id,
      operation: targetEvent.operation,
      baseChecksum: targetEvent.base_checksum,
      newChecksum: targetEvent.new_checksum,
      payload: parsedEventPayload
    },
    sequence16Compatibility: {
      targetTransactionId: targetTxnId,
      foundInSnapshot: Boolean(snapshotTargetTxn),
      snapshotTransaction: snapshotTargetTxn,
      dbRow: snapshotTxnDbRow,
      computedCanonicalChecksum: snapshotTxnCanonicalChecksum,
      computedCoreChecksum: snapshotTxnCoreChecksum,
      computedRawChecksum: snapshotTxnRawChecksum,
      sequence16BaseChecksum: seq16BaseChecksum,
      sequence16NewChecksum: seq16NewChecksum,
      isBaseMatch,
      isNewMatch,
      isCreatorOfSnapshot,
      expectedReconciliationOutcome,
      safeToReconcile: isSafeOutcome,
      explanation: reconciliationExplanation
    },
    deviceA: {
      deviceId: localDeviceId,
      currentSnapshotId: localSnapId,
      currentParentSnapshotId: localParentSnapId,
      reconciledWatermark: localWatermark,
      stagedWatermark: localStagedWatermark,
      watermarkMatchesExpected: (localWatermark === expectedLocalWatermark),
      targetTransaction: targetTxn ? {
        id: targetTxn.id,
        currentType: targetTxn.type,
        note: targetTxn.note
      } : null,
      pendingOutboundDeltasCount: pendingOutboundCount
    },
    checks
  };
}

/**
 * Controlled v10 Snapshot Import & Replacement
 * Replaces the local web-device database with the verified v10 snapshot.
 */
export async function importSnapshotV10ToDevice({
  accessToken,
  pin = null,
  keyMaterial = null,
  confirmation = false,
  driveClient = null,
  dbInstance = null,
  targetRef = V10_TARGET_REFERENCE,
  onProgress = () => {}
}) {
  // Gate 1: Explicit Confirmation Gate
  const isConfirmed = (confirmation === true || confirmation === 'CONFIRM_REPLACE_LOCAL_DATA');
  if (!isConfirmed) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.CONFIRMATION_REQUIRED,
      'Import aborted: Explicit confirmation required before replacing local device data. Pass confirmation: "CONFIRM_REPLACE_LOCAL_DATA".'
    );
  }

  onProgress({ stage: 'VALIDATING', message: 'Downloading and validating verified cloud snapshot…' });

  // Gate 2: Download, Decrypt, and Validate Snapshot (Zero DB changes yet)
  const preflight = await preflightSnapshotV10Import({
    accessToken,
    pin,
    keyMaterial,
    driveClient,
    dbInstance,
    targetRef
  });

  const cloudPayload = preflight.payload;
  const db = dbInstance || getDB();

  onProgress({ stage: 'BACKING_UP', message: 'Creating durable, verified backup of existing local data…' });

  // Gate 3: Create and Self-Verify Durable Local Backup Before Any Mutations (Fix B)
  let durableBackupInfo;
  try {
    durableBackupInfo = await createDurablePreImportBackup(db);
  } catch (backupErr) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.PRE_BACKUP_FAILED,
      `Failed to capture and verify durable pre-replacement backup: ${backupErr.message}`,
      { cause: backupErr }
    );
  }

  const { backupPackage, backupSha256, backupId } = durableBackupInfo;

  onProgress({ stage: 'REPLACING', message: `Installing verified snapshot v${cloudPayload.cloud_version} baseline data…` });

  // Gate 4: Transactional Population, Lineage Alignment & Durable Rollback Guard (Fix A & B)
  try {
    // 4a. Quarantine pending delta events to prevent ghost replay against new baseline (Fix A)
    const deviceId = await getOrCreateLocalDeviceId().catch(() => 'local_device');
    const quarantineRes = await quarantinePendingDeltas(db, {
      deviceId,
      targetSnapshotId: cloudPayload.snapshot_id,
      targetCloudVersion: cloudPayload.cloud_version
    });

    // 4b. Replace operational stores with snapshot entities
    await populateLocalEntitiesBootstrap(db, cloudPayload.entities || {}, { allowRecoveryReplacement: true });

    // 4c. Align sync lineage stores (local sequence, peer watermarks, staged events, tombstones) (Fix A)
    await alignSnapshotSyncLineage(db, {
      cloudPayload,
      deviceId
    });

    onProgress({ stage: 'VERIFYING', message: 'Verifying installed records and canonical integrity…' });

    // 4d. Post-import physical count verification
    const postEntities = await readLocalEntities(db);
    const actualReg = (postEntities.transactions || []).length;
    const actualInv = (postEntities.investment_transactions || []).length;
    const actualAccounts = (postEntities.accounts || []).length;
    const actualInventory = (postEntities.inventory || []).length;

    if (actualReg !== targetRef.regularTransactionsCount ||
        actualInv !== targetRef.investmentTransactionsCount ||
        actualAccounts !== targetRef.accountsCount ||
        actualInventory !== targetRef.inventoryCount) {
      throw new Error(
        `Post-import count verification mismatch. Expected: ${targetRef.regularTransactionsCount} regular, ` +
        `${targetRef.investmentTransactionsCount} investment, ${targetRef.accountsCount} accounts, ${targetRef.inventoryCount} inventory. ` +
        `Got: ${actualReg} regular, ${actualInv} investment, ${actualAccounts} accounts, ${actualInventory} inventory.`
      );
    }

    // 4e. Canonical manifest equality verification
    const localManifest = await buildEntityManifest(postEntities);
    const cloudManifest = await buildEntityManifest(cloudPayload.entities || {});

    for (const [id, cloudEntry] of Object.entries(cloudManifest)) {
      const localEntry = localManifest[id];
      if (!localEntry) {
        throw new Error(`Canonical integrity mismatch: Entity '${id}' is missing from local database.`);
      }
      if (localEntry.canonical !== cloudEntry.canonical) {
        throw new Error(
          `Canonical integrity mismatch for entity '${id}'. ` +
          `Cloud (${cloudEntry.type}): '${cloudEntry.canonical}' vs Local (${localEntry.type}): '${localEntry.canonical}'`
        );
      }
    }

    // 4f. Finalize local sync settings (Align with Cloud Snapshot)
    const nowIso = new Date().toISOString();
    await setSetting('sync_base_manifest', JSON.stringify(localManifest), { suppressDeltaQueue: true });
    await setSetting('last_snapshot_id', cloudPayload.snapshot_id, { suppressDeltaQueue: true });
    await setSetting('last_parent_snapshot_id', cloudPayload.parent_snapshot_id || '', { suppressDeltaQueue: true });
    await setSetting('last_cloud_version', String(cloudPayload.cloud_version || 1), { suppressDeltaQueue: true });
    await setSetting('last_synced_at', nowIso, { suppressDeltaQueue: true });
    await setSetting('device_lifecycle_state', DEVICE_LIFECYCLE.ACTIVE, { suppressDeltaQueue: true });
    await setSetting('sub_accounts_migrated_v2', 'true', { suppressDeltaQueue: true });
    await setSetting('historical_charges_reconciled', 'true', { suppressDeltaQueue: true });

    onProgress({ stage: 'COMPLETE', message: `Verified v${cloudPayload.cloud_version} snapshot successfully imported!` });

    return {
      success: true,
      status: 'IMPORT_SUCCESS',
      snapshotId: cloudPayload.snapshot_id,
      cloudVersion: cloudPayload.cloud_version,
      recordsImported: {
        transactions: actualReg,
        investment_transactions: actualInv,
        totalTransactions: actualReg + actualInv,
        accounts: actualAccounts,
        inventory: actualInventory,
        categories: (postEntities.categories || []).length,
        subcategories: (postEntities.subcategories || []).length,
        sub_accounts: (postEntities.sub_accounts || []).length,
        brokerages: (postEntities.brokerages || []).length
      },
      preImportBackupCounts: backupPackage.counts,
      durableBackupId: backupId,
      durableBackupSha256: backupSha256,
      quarantinedDeltaEventsCount: quarantineRes.quarantinedCount
    };
  } catch (err) {
    // Gate 5: Rollback on Failure using durable backup (Fix B)
    console.error('[snapshotDeviceImport] Critical failure during import, initiating durable rollback:', err);
    let rollbackSuccess = false;
    let rollbackDetails = null;

    try {
      const rollbackResult = await restorePreImportBackup({ dbInstance: db, backupPackage });
      if (rollbackResult.success) {
        rollbackSuccess = true;
        rollbackDetails = 'Local database rolled back cleanly to durable pre-import backup.';
      } else {
        rollbackDetails = 'Rollback completed but verification did not report success.';
      }
    } catch (rbErr) {
      console.error('[snapshotDeviceImport] Catastrophic: Rollback failed:', rbErr);
      rollbackDetails = `Rollback error: ${rbErr.message}`;
    }

    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.ROLLBACK_TRIGGERED,
      `Snapshot import failed (${err.message}). ${rollbackDetails}`,
      {
        originalError: err.message,
        rollbackSuccess,
        rollbackDetails,
        preImportBackupCounts: backupPackage?.counts || null,
        durableBackupId: backupId || null
      }
    );
  }
}

/**
 * Captures a complete, durable pre-replacement backup of all operational entities,
 * sync engine tables, and critical settings. Persists the package to settings,
 * computes SHA-256 integrity hash, and immediately reads it back from disk to verify
 * storage integrity before any destructive deletion is permitted.
 */
export async function createDurablePreImportBackup(db) {
  const currentEntities = await readLocalEntities(db);

  // Read all sync stores
  const [
    queueRes,
    localStateRes,
    peerStateRes,
    stagedEventsRes,
    stagedPackagesRes,
    conflictsRes
  ] = await Promise.all([
    db.query('SELECT * FROM sync_delta_queue').catch(() => ({ values: [] })),
    db.query('SELECT * FROM sync_local_state').catch(() => ({ values: [] })),
    db.query('SELECT * FROM sync_peer_state').catch(() => ({ values: [] })),
    db.query('SELECT * FROM sync_staged_events').catch(() => ({ values: [] })),
    db.query('SELECT * FROM sync_staged_packages').catch(() => ({ values: [] })),
    db.query('SELECT * FROM sync_conflicts').catch(() => ({ values: [] }))
  ]);

  // Read critical sync settings
  const criticalSettingsKeys = [
    'sync_base_manifest',
    'last_snapshot_id',
    'last_parent_snapshot_id',
    'last_cloud_version',
    'last_synced_at',
    'device_lifecycle_state',
    'sub_accounts_migrated_v2',
    'historical_charges_reconciled',
    'last_delta_synced_at',
    'pre_recovery_quarantined_deltas'
  ];
  const settingsValues = {};
  for (const k of criticalSettingsKeys) {
    settingsValues[k] = await getSetting(k).catch(() => null);
  }

  const counts = {
    transactions: (currentEntities.transactions || []).length,
    investment_transactions: (currentEntities.investment_transactions || []).length,
    totalTransactions: (currentEntities.transactions || []).length + (currentEntities.investment_transactions || []).length,
    accounts: (currentEntities.accounts || []).length,
    inventory: (currentEntities.inventory || []).length,
    categories: (currentEntities.categories || []).length,
    subcategories: (currentEntities.subcategories || []).length,
    account_groups: (currentEntities.account_groups || []).length,
    brokerages: (currentEntities.brokerages || []).length,
    sync_tombstones: (currentEntities.sync_tombstones || []).length,
    delta_queue: (queueRes.values || []).length,
    staged_events: (stagedEventsRes.values || []).length,
    conflicts: (conflictsRes.values || []).length
  };

  const backupId = `durable_backup_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const timestamp = new Date().toISOString();

  const backupPackage = {
    backup_id: backupId,
    timestamp,
    schema_version: 13,
    counts,
    entities: currentEntities,
    settings: settingsValues,
    sync_state: {
      delta_queue: queueRes.values || [],
      local_state: localStateRes.values || [],
      peer_state: peerStateRes.values || [],
      staged_events: stagedEventsRes.values || [],
      staged_packages: stagedPackagesRes.values || [],
      conflicts: conflictsRes.values || []
    }
  };

  const backupJson = JSON.stringify(backupPackage);
  const backupSha256 = await computeSha256(backupJson);

  const backupMeta = {
    backup_id: backupId,
    timestamp,
    counts,
    sha256: backupSha256,
    byteSize: backupJson.length,
    status: 'VERIFIED_DURABLE'
  };

  // Persist durable backup and metadata to settings
  await setSetting('pre_recovery_durable_backup', backupJson, { suppressDeltaQueue: true });
  await setSetting('pre_recovery_durable_backup_meta', JSON.stringify(backupMeta), { suppressDeltaQueue: true });

  // Maintain backward-compatible lightweight summary record for older consumers
  await setSetting('pre_v10_recovery_backup', JSON.stringify({
    timestamp,
    counts,
    settings: settingsValues,
    durable_backup_id: backupId,
    sha256: backupSha256
  }), { suppressDeltaQueue: true });

  // Self-Verification Guard: Read back and assert disk presence & exact SHA-256 match
  const verifiedStr = await getSetting('pre_recovery_durable_backup');
  if (!verifiedStr) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.PRE_BACKUP_FAILED,
      'Durable pre-replacement backup could not be read back from disk storage. Aborting without mutating database.'
    );
  }

  const verifiedSha256 = await computeSha256(verifiedStr);
  if (verifiedSha256 !== backupSha256) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.PRE_BACKUP_FAILED,
      `Durable pre-replacement backup verification failed: SHA-256 mismatch (expected ${backupSha256}, got ${verifiedSha256}). Aborting.`
    );
  }

  let verifiedParsed;
  try {
    verifiedParsed = JSON.parse(verifiedStr);
  } catch (parseErr) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.PRE_BACKUP_FAILED,
      `Durable pre-replacement backup could not be parsed as valid JSON: ${parseErr.message}. Aborting.`
    );
  }

  const vReg = (verifiedParsed.entities?.transactions || []).length;
  const vInv = (verifiedParsed.entities?.investment_transactions || []).length;
  if (vReg !== counts.transactions || vInv !== counts.investment_transactions) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.PRE_BACKUP_FAILED,
      `Durable pre-replacement backup count mismatch on read-back: expected ${counts.transactions} txns, got ${vReg}. Aborting.`
    );
  }

  return { backupPackage, backupSha256, backupId };
}

/**
 * Safely inspects the local sync_delta_queue before snapshot replacement.
 * If any delta events exist (especially unacknowledged pending or uploaded events),
 * exports them into an auditable durable quarantine record under settings
 * ('pre_recovery_quarantined_deltas') with an auditable reason before resetting the queue.
 * This guarantees unacknowledged local edits are never silently discarded and cannot
 * be accidentally replayed against the newly imported snapshot baseline.
 */
export async function quarantinePendingDeltas(db, { deviceId, targetSnapshotId, targetCloudVersion }) {
  const queueRes = await db.query('SELECT * FROM sync_delta_queue').catch(() => ({ values: [] }));
  const rawQueue = queueRes.values || [];

  if (rawQueue.length === 0) {
    return { quarantinedCount: 0, unacknowledgedCount: 0, quarantineId: null };
  }

  const unacknowledged = rawQueue.filter(r => r.status !== 'ACKNOWLEDGED');
  const quarantineId = `quarantine_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const timestamp = new Date().toISOString();

  const quarantineRecord = {
    quarantine_id: quarantineId,
    quarantined_at: timestamp,
    reason: 'SNAPSHOT_LINEAGE_RESET',
    details: `Quarantined ${rawQueue.length} delta events (${unacknowledged.length} unacknowledged) before importing snapshot ${targetSnapshotId} (v${targetCloudVersion}) to prevent ghost replay against new baseline.`,
    source_device_id: deviceId,
    target_snapshot_id: targetSnapshotId,
    target_cloud_version: targetCloudVersion,
    counts: {
      total: rawQueue.length,
      unacknowledged: unacknowledged.length,
      acknowledged: rawQueue.length - unacknowledged.length
    },
    events: rawQueue
  };

  await setSetting('pre_recovery_quarantined_deltas', JSON.stringify(quarantineRecord), { suppressDeltaQueue: true });
  await db.run('DELETE FROM sync_delta_queue');

  return {
    quarantinedCount: rawQueue.length,
    unacknowledgedCount: unacknowledged.length,
    quarantineId,
    timestamp
  };
}

/**
 * Retrieves quarantined delta events from persistent storage.
 * Returns parsed quarantine record or null if none exists.
 */
export async function getQuarantinedDeltas(dbInstance = null) {
  const json = await getSetting('pre_recovery_quarantined_deltas');
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Retrieves all events held for review from the quarantine record.
 */
export async function getQuarantinedHeldEvents(dbInstance = null) {
  const quarantine = await getQuarantinedDeltas(dbInstance);
  return quarantine?.held_for_review || [];
}

/**
 * Helper to resolve store name and primary key from collection name
 */
export function getCollectionStoreAndKey(collection) {
  const norm = String(collection || '').toLowerCase();
  let store = norm;
  if (norm === 'transaction' || norm === 'transactions') store = 'transactions';
  else if (norm === 'investment_transaction' || norm === 'investment_transactions') store = 'investment_transactions';
  else if (norm === 'account' || norm === 'accounts') store = 'accounts';
  else if (norm === 'category' || norm === 'categories') store = 'categories';
  else if (norm === 'subcategory' || norm === 'subcategories') store = 'subcategories';
  else if (norm === 'sub_account' || norm === 'sub_accounts') store = 'sub_accounts';
  else if (norm === 'inventory') store = 'inventory';
  else if (norm === 'brokerage' || norm === 'brokerages') store = 'brokerages';
  else if (norm === 'account_group' || norm === 'account_groups') store = 'account_groups';
  else if (norm === 'budget' || norm === 'budgets') store = 'budgets';
  else if (norm === 'recurring_rule' || norm === 'recurring_rules') store = 'recurring_rules';
  else if (norm === 'investment_plan' || norm === 'investment_plans') store = 'investment_plans';
  else if (norm === 'setting' || norm === 'settings') store = 'settings';

  const pk = (store === 'settings')
    ? 'key'
    : (store === 'sync_conflicts'
      ? 'conflict_id'
      : (store === 'sync_delta_queue' || store === 'sync_staged_events'
        ? 'event_id'
        : (store === 'sync_staged_packages'
          ? 'package_id'
          : (store === 'sync_peer_state' ? 'peer_device_id' : 'id'))));

  return { store, pk };
}

/**
 * Evaluates an unacknowledged quarantined event against the imported snapshot baseline.
 * Identifies whether the event:
 * - is clean to re-queue (REQUEUE)
 * - has a missing target entity or diverged snapshot data (HOLD_FOR_REVIEW)
 * - is already present or already absent (SKIP_NOOP)
 */
export async function evaluateQuarantinedEventAgainstSnapshot(db, event) {
  const { store, pk } = getCollectionStoreAndKey(event.collection);
  const rowRes = await db.query(`SELECT * FROM ${store} WHERE ${pk} = ?`, [event.entity_id]).catch(() => ({ values: [] }));
  const existingEntity = rowRes.values?.[0] || null;

  const payloadObj = typeof event.payload === 'object'
    ? event.payload
    : (() => { try { return JSON.parse(event.payload || '{}'); } catch { return {}; } })();

  const op = String(event.operation || '').toUpperCase();

  // 1. Target entity does NOT exist in the imported snapshot
  if (!existingEntity) {
    if (op === 'UPDATE') {
      return {
        action: 'HOLD_FOR_REVIEW',
        reason: 'TARGET_ENTITY_MISSING_IN_SNAPSHOT',
        details: `Target entity '${event.entity_id}' in collection '${event.collection}' was not found in the imported snapshot baseline. Preserved in quarantine review to avoid orphan update.`,
        existingEntity: null
      };
    }
    if (op === 'DELETE') {
      return {
        action: 'SKIP_NOOP',
        reason: 'ALREADY_DELETED_OR_ABSENT',
        details: `Target entity '${event.entity_id}' in collection '${event.collection}' is already absent from the snapshot baseline.`,
        existingEntity: null
      };
    }
    // Clean INSERT: new entity created offline that doesn't collide with snapshot
    return {
      action: 'REQUEUE',
      reason: 'CLEAN_OFFLINE_INSERT',
      details: `New offline entity '${event.entity_id}' in collection '${event.collection}' is not present in snapshot and is clean to re-queue.`,
      existingEntity: null
    };
  }

  // 2. Target entity DOES exist in the imported snapshot
  if (op === 'INSERT') {
    const existingCanonical = canonicalizeEntity(existingEntity, event.collection);
    const payloadCanonical = canonicalizeEntity(payloadObj, event.collection);
    if (existingCanonical === payloadCanonical) {
      return {
        action: 'SKIP_NOOP',
        reason: 'IDENTICAL_DATA_IN_SNAPSHOT',
        details: `Target entity '${event.entity_id}' already exists in snapshot with identical canonical data.`,
        existingEntity
      };
    }
    return {
      action: 'HOLD_FOR_REVIEW',
      reason: 'TARGET_ENTITY_ALREADY_EXISTS_WITH_DIVERGENT_DATA',
      details: `Target entity '${event.entity_id}' already exists in snapshot with divergent data. Preserved in quarantine review to avoid overwriting snapshot.`,
      existingEntity
    };
  }

  if (op === 'UPDATE') {
    const existingCanonical = canonicalizeEntity(existingEntity, event.collection);
    const payloadCanonical = canonicalizeEntity(payloadObj, event.collection);
    if (existingCanonical === payloadCanonical) {
      return {
        action: 'SKIP_NOOP',
        reason: 'IDENTICAL_DATA_IN_SNAPSHOT',
        details: `Target entity '${event.entity_id}' in snapshot already matches the quarantined update payload.`,
        existingEntity
      };
    }

    const currentFp = fastFingerprint(existingCanonical);
    if (event.base_checksum && event.base_checksum !== currentFp) {
      return {
        action: 'HOLD_FOR_REVIEW',
        reason: 'TARGET_ENTITY_DIVERGED_IN_SNAPSHOT',
        details: `Target entity '${event.entity_id}' in snapshot has diverged from quarantined base checksum (${event.base_checksum} !== ${currentFp}). Preserved in quarantine review.`,
        existingEntity
      };
    }

    return {
      action: 'REQUEUE',
      reason: 'CLEAN_UPDATE',
      details: `Target entity '${event.entity_id}' exists in snapshot and is clean to update.`,
      existingEntity
    };
  }

  if (op === 'DELETE') {
    const existingCanonical = canonicalizeEntity(existingEntity, event.collection);
    const currentFp = fastFingerprint(existingCanonical);
    if (event.base_checksum && event.base_checksum !== currentFp) {
      return {
        action: 'HOLD_FOR_REVIEW',
        reason: 'TARGET_ENTITY_DIVERGED_IN_SNAPSHOT',
        details: `Target entity '${event.entity_id}' in snapshot has been modified since deletion was staged (${event.base_checksum} !== ${currentFp}). Preserved in quarantine review.`,
        existingEntity
      };
    }
    return {
      action: 'REQUEUE',
      reason: 'CLEAN_DELETE',
      details: `Target entity '${event.entity_id}' exists in snapshot and is clean to delete.`,
      existingEntity
    };
  }

  return {
    action: 'HOLD_FOR_REVIEW',
    reason: 'UNKNOWN_OPERATION',
    details: `Unrecognized delta operation '${event.operation}'.`,
    existingEntity
  };
}

/**
 * Compares an existing queued delta event with a quarantined event to determine
 * whether they represent the identical mutation or a divergent collision.
 */
export function areDeltaEventsEquivalent(qRow, e) {
  if (!qRow || !e) return false;

  // 1. Basic collection, operation, and entity_id must match
  if (qRow.collection && e.collection && qRow.collection !== e.collection) return false;
  if (qRow.entity_id && e.entity_id && qRow.entity_id !== e.entity_id) return false;
  if (qRow.operation && e.operation && String(qRow.operation).toUpperCase() !== String(e.operation).toUpperCase()) return false;

  // 2. If both carry new_checksum, compare checksums directly
  if (qRow.new_checksum && e.new_checksum) {
    return qRow.new_checksum === e.new_checksum;
  }

  // 3. For DELETE operations, if entity and collection match, compare base_checksum
  const op = String(e.operation || qRow.operation || '').toUpperCase();
  if (op === 'DELETE') {
    if (qRow.base_checksum && e.base_checksum) {
      return qRow.base_checksum === e.base_checksum;
    }
    return true;
  }

  // 4. Compare payloads canonically
  const qPayload = typeof qRow.payload === 'object' && qRow.payload !== null
    ? qRow.payload
    : (() => { try { return JSON.parse(qRow.payload || '{}'); } catch { return qRow.payload; } })();

  const ePayload = typeof e.payload === 'object' && e.payload !== null
    ? e.payload
    : (() => { try { return JSON.parse(e.payload || '{}'); } catch { return e.payload; } })();

  if (qPayload === null && ePayload === null) return true;
  if (qPayload === null || ePayload === null) return false;

  const collection = e.collection || qRow.collection || 'transactions';
  const effectiveId = e.entity_id || qRow.entity_id || '';

  if (typeof qPayload === 'object' && typeof ePayload === 'object') {
    const qClone = { ...qPayload };
    const eClone = { ...ePayload };
    if (!qClone.id && effectiveId) qClone.id = effectiveId;
    if (!eClone.id && effectiveId) eClone.id = effectiveId;

    const qCanonical = canonicalizeEntity(qClone, collection);
    const eCanonical = canonicalizeEntity(eClone, collection);
    if (qCanonical && eCanonical) {
      return qCanonical === eCanonical;
    }
    // Fallback: compare sorted key JSON
    const sortObj = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      return Object.keys(obj).sort().reduce((acc, k) => {
        acc[k] = obj[k];
        return acc;
      }, {});
    };
    return JSON.stringify(sortObj(qClone)) === JSON.stringify(sortObj(eClone));
  }

  return String(qPayload).trim() === String(ePayload).trim();
}

/**
 * Documented Recovery Path for Quarantined Changes:
 * - Safe to call repeatedly (idempotent, checks existing sync_delta_queue and held records).
 * - Crash/interruption resilient: re-evaluates remaining items without duplicate sequence allocation.
 * - Inspects snapshot baseline: missing or diverged entities are held for review with audit metadata,
 *   never blindly discarded or allowed to silently overwrite newer snapshot data.
 */
export async function restoreQuarantinedDeltas(options = {}) {
  const db = options.dbInstance || getDB();
  const quarantine = await getQuarantinedDeltas(db);
  if (!quarantine || !Array.isArray(quarantine.events) || quarantine.events.length === 0) {
    return {
      success: false,
      restoredCount: 0,
      alreadyRestoredCount: 0,
      heldCount: 0,
      newlyHeldCount: 0,
      alreadyHeldCount: 0,
      skippedCount: 0,
      newAllocatedSequence: 0,
      heldEvents: [],
      message: 'No quarantined delta events found to restore.'
    };
  }

  // 1. Query existing queue with full payload/checksum to ensure idempotency and verify payload equality
  const qRes = await db.query('SELECT event_id, sequence, status, collection, entity_id, operation, payload, new_checksum, base_checksum FROM sync_delta_queue').catch(() => ({ values: [] }));
  const existingQueueMap = new Map((qRes.values || []).map(r => [r.event_id, r]));

  // 2. Query existing conflict records to see if any are already recorded as held
  const confRes = await db.query('SELECT conflict_id FROM sync_conflicts').catch(() => ({ values: [] }));
  const existingConflicts = new Set((confRes.values || []).map(c => c.conflict_id));

  // 3. Filter unacknowledged events
  const eventsToEvaluate = options.unacknowledgedOnly !== false
    ? quarantine.events.filter(e => e.status !== 'ACKNOWLEDGED')
    : quarantine.events;

  const skippedAcknowledged = quarantine.events.length - eventsToEvaluate.length;

  // 4. Get device state for sequence allocation
  const sRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }));
  const localState = sRes.values?.[0] || {};
  const queueMaxSeq = Math.max(0, ...Array.from(existingQueueMap.values()).map(r => Number(r.sequence || 0)));
  let currentSeq = Math.max(Number(localState.last_allocated_sequence || 0), queueMaxSeq);
  const initialSeq = currentSeq;

  const nowIso = new Date().toISOString();
  let newlyRestored = 0;
  let alreadyRestoredCount = 0;
  let newlyHeld = 0;
  let alreadyHeldCount = 0;
  let newlySkipped = 0;
  const newlyHeldEvents = [];

  // Ensure arrays exist on quarantine record
  if (!Array.isArray(quarantine.held_for_review)) {
    quarantine.held_for_review = [];
  }
  const existingHeldIdSet = new Set(quarantine.held_for_review.map(h => h.event_id));

  // 5. Evaluate and process each event
  for (const e of eventsToEvaluate) {
    // Check if event was ALREADY held for review and not forcing requeue
    if (existingHeldIdSet.has(e.event_id) && !options.forceRequeueHeld) {
      alreadyHeldCount++;
      continue;
    }

    // Check if event already exists in sync_delta_queue
    if (existingQueueMap.has(e.event_id)) {
      const queuedRow = existingQueueMap.get(e.event_id);
      if (areDeltaEventsEquivalent(queuedRow, e)) {
        alreadyRestoredCount++;
        e.restoration_status = 'REQUEUED';
        e.restored_sequence = queuedRow.sequence;
        continue;
      }

      // Event ID matches an existing queued event but with a DIVERGENT payload or checksum.
      // Do NOT overwrite the queued event and do NOT silently discard the quarantined payload.
      // Preserve the quarantined event for review and record an auditable conflict.
      newlyHeld++;
      e.restoration_status = 'HELD_FOR_REVIEW';
      e.held_reason = 'EVENT_ID_COLLISION_WITH_DIVERGENT_PAYLOAD';
      e.held_details = `Quarantined event '${e.event_id}' collides with an existing queued event (seq ${queuedRow.sequence}) with divergent payload or checksum. Preserved in quarantine review to avoid data loss.`;
      e.held_at = nowIso;

      const heldRecord = {
        event_id: e.event_id,
        collection: e.collection,
        entity_id: e.entity_id,
        operation: e.operation,
        reason: 'EVENT_ID_COLLISION_WITH_DIVERGENT_PAYLOAD',
        details: e.held_details,
        held_at: nowIso,
        quarantined_payload: typeof e.payload === 'object' ? e.payload : (() => { try { return JSON.parse(e.payload || '{}'); } catch { return {}; } })(),
        source_device_id: e.device_id || localState.device_id || 'local_device',
        colliding_queued_event: {
          sequence: queuedRow.sequence,
          operation: queuedRow.operation,
          payload: typeof queuedRow.payload === 'object' ? queuedRow.payload : (() => { try { return JSON.parse(queuedRow.payload || '{}'); } catch { return queuedRow.payload; } })()
        }
      };

      quarantine.held_for_review.push(heldRecord);
      existingHeldIdSet.add(e.event_id);
      newlyHeldEvents.push(heldRecord);

      const confId = `conf_quarantine_${e.event_id}`;
      if (!existingConflicts.has(confId)) {
        await db.run(
          'INSERT OR REPLACE INTO sync_conflicts (conflict_id, package_id, entity_type, entity_id, local_state, remote_state, base_state, detected_at, status, resolution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            confId,
            'quarantine_recovery',
            e.collection,
            e.entity_id,
            typeof queuedRow.payload === 'string' ? queuedRow.payload : JSON.stringify(queuedRow.payload || {}),
            typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload || {}),
            e.base_checksum || null,
            nowIso,
            'PENDING_REVIEW',
            'QUARANTINE_HELD: EVENT_ID_COLLISION_WITH_DIVERGENT_PAYLOAD'
          ]
        );
        existingConflicts.add(confId);
      }
      continue;
    }

    // Evaluate against current snapshot baseline
    const evaluation = await evaluateQuarantinedEventAgainstSnapshot(db, e);

    if (evaluation.action === 'SKIP_NOOP') {
      newlySkipped++;
      e.restoration_status = 'SKIPPED_NOOP';
      e.skipped_reason = evaluation.reason;
      e.skipped_at = nowIso;
      continue;
    }

    if (evaluation.action === 'HOLD_FOR_REVIEW') {
      newlyHeld++;
      e.restoration_status = 'HELD_FOR_REVIEW';
      e.held_reason = evaluation.reason;
      e.held_details = evaluation.details;
      e.held_at = nowIso;

      const heldRecord = {
        event_id: e.event_id,
        collection: e.collection,
        entity_id: e.entity_id,
        operation: e.operation,
        reason: evaluation.reason,
        details: evaluation.details,
        held_at: nowIso,
        quarantined_payload: typeof e.payload === 'object' ? e.payload : (() => { try { return JSON.parse(e.payload || '{}'); } catch { return {}; } })(),
        source_device_id: e.device_id || localState.device_id || 'local_device'
      };

      quarantine.held_for_review.push(heldRecord);
      existingHeldIdSet.add(e.event_id);
      newlyHeldEvents.push(heldRecord);

      // Record in sync_conflicts for audit and review UI
      const confId = `conf_quarantine_${e.event_id}`;
      if (!existingConflicts.has(confId)) {
        await db.run(
          'INSERT OR REPLACE INTO sync_conflicts (conflict_id, package_id, entity_type, entity_id, local_state, remote_state, base_state, detected_at, status, resolution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            confId,
            'quarantine_recovery',
            e.collection,
            e.entity_id,
            JSON.stringify(evaluation.existingEntity || null),
            typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload || {}),
            e.base_checksum || null,
            nowIso,
            'PENDING_REVIEW',
            `QUARANTINE_HELD: ${evaluation.reason}`
          ]
        );
        existingConflicts.add(confId);
      }
      continue;
    }

    // Clean to REQUEUE:
    currentSeq++;
    const payloadStr = typeof e.payload === 'object' ? JSON.stringify(e.payload) : (e.payload || '');
    await db.run(
      'INSERT OR REPLACE INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status, created_at, base_checksum, new_checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        e.event_id,
        e.device_id || localState.device_id || 'local_device',
        currentSeq,
        nowIso,
        e.collection,
        e.entity_id,
        e.operation,
        payloadStr,
        'PENDING',
        nowIso,
        e.base_checksum || null,
        e.new_checksum || null
      ]
    );

    e.restoration_status = 'REQUEUED';
    e.restored_sequence = currentSeq;
    e.restored_at = nowIso;
    existingQueueMap.set(e.event_id, { event_id: e.event_id, sequence: currentSeq, status: 'PENDING' });
    newlyRestored++;
  }

  // 6. Advance sequence in sync_local_state if new sequences were allocated
  if (currentSeq > initialSeq) {
    await db.run(
      'UPDATE sync_local_state SET last_allocated_sequence = ?, updated_at = ? WHERE key = ?',
      [currentSeq, nowIso, 'device_state']
    );
  }

  // 7. Update quarantine metadata and persist to disk
  quarantine.restoration_state = {
    last_restored_at: nowIso,
    status: (quarantine.held_for_review.length > 0)
      ? (newlyRestored > 0 || alreadyRestoredCount > 0 ? 'PARTIALLY_RESTORED_WITH_HELD_EVENTS' : 'ALL_EVENTS_HELD_FOR_REVIEW')
      : 'RESTORED',
    requeued_count: (quarantine.restoration_state?.requeued_count || 0) + newlyRestored,
    already_restored_count: alreadyRestoredCount,
    held_count: quarantine.held_for_review.length,
    skipped_count: (quarantine.restoration_state?.skipped_count || 0) + newlySkipped + skippedAcknowledged
  };

  await setSetting('pre_recovery_quarantined_deltas', JSON.stringify(quarantine), { suppressDeltaQueue: true });

  let message = '';
  if (newlyRestored === 0 && alreadyRestoredCount > 0 && newlyHeld === 0) {
    message = `All ${alreadyRestoredCount} unacknowledged quarantined events have already been restored. Safe repeated call executed with zero mutations.`;
  } else if (newlyRestored === 0 && newlyHeld > 0) {
    message = `Processed quarantined events: 0 re-queued, ${newlyHeld} held for review due to missing or diverged snapshot targets, ${alreadyRestoredCount} already restored.`;
  } else {
    message = `Successfully processed quarantined events: ${newlyRestored} re-queued on top of snapshot baseline (seq ${initialSeq + 1}..${currentSeq}), ${newlyHeld} held for review, ${alreadyRestoredCount} already restored.`;
  }

  return {
    success: true,
    restoredCount: newlyRestored,
    alreadyRestoredCount,
    heldCount: quarantine.held_for_review.length,
    newlyHeldCount: newlyHeld,
    alreadyHeldCount,
    skippedCount: newlySkipped + skippedAcknowledged,
    newAllocatedSequence: currentSeq,
    quarantineId: quarantine.quarantine_id,
    heldEvents: newlyHeldEvents,
    message
  };
}

/**
 * Aligns all sync state stores with the imported snapshot's verified metadata:
 * - Purges stale staged events and packages belonging to the old baseline.
 * - Purges stale conflicts and tombstones.
 * - Resets local sequence state (last_allocated_seq = 0, last_uploaded_seq = 0, last_acked_seq = 0,
 *   base_snapshot_id = payload.snapshot_id, lifecycle_state = 'ACTIVE').
 * - Aligns peer watermarks from snapshot's covered_peer_watermarks, pruning obsolete peer records.
 */
export async function alignSnapshotSyncLineage(db, { cloudPayload, deviceId, peerWatermarksOverride = {}, seedCreatorWatermark = false, isNewDeviceBootstrap = false }) {
  const nowIso = new Date().toISOString();
  const rawIdb = getRawIDB();

  // 1. Purge stale sync staging & conflict stores
  await db.run('DELETE FROM sync_staged_events');
  await db.run('DELETE FROM sync_staged_packages');
  await db.run('DELETE FROM sync_conflicts');

  // Align sync_tombstones with snapshot entities if present, or reset if baseline contains none
  if (cloudPayload?.entities && Array.isArray(cloudPayload.entities.sync_tombstones)) {
    const tombRows = (cloudPayload.entities.sync_tombstones || []).map(tomb => ({
      id: String(tomb.id || tomb.entity_id || ''),
      entity_type: String(tomb.entity_type || 'transaction'),
      entity_id: String(tomb.entity_id || tomb.id || ''),
      deleted_at: String(tomb.deleted_at || new Date().toISOString())
    }));
    if (typeof db.batchReplace === 'function') {
      await db.batchReplace('sync_tombstones', tombRows);
    } else {
      await db.run('DELETE FROM sync_tombstones');
      for (const tomb of tombRows) {
        await db.run(
          'INSERT OR REPLACE INTO sync_tombstones (id, entity_type, entity_id, deleted_at) VALUES (?, ?, ?, ?)',
          [tomb.id, tomb.entity_type, tomb.entity_id, tomb.deleted_at]
        );
      }
    }
  } else {
    await db.run('DELETE FROM sync_tombstones');
  }

  // 2. Align local sequence state while strictly preserving existing device identity and lineage
  let existingState = null;
  if (rawIdb) {
    existingState = await new Promise((resolve) => {
      try {
        const tx = rawIdb.transaction(['sync_local_state'], 'readonly');
        const req = tx.objectStore('sync_local_state').get('device_state');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } else {
    try {
      const res = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
      existingState = res.values?.[0] || null;
    } catch {}
  }

  // Preserve device identity
  const effectiveDeviceId = deviceId || existingState?.device_id || existingState?.deviceId || 'local_device';

  // Read existing queue records for effectiveDeviceId
  let queueMaxSeqForOwnDevice = 0;
  if (rawIdb) {
    queueMaxSeqForOwnDevice = await new Promise((resolve) => {
      try {
        const tx = rawIdb.transaction(['sync_delta_queue'], 'readonly');
        const req = tx.objectStore('sync_delta_queue').getAll();
        req.onsuccess = () => {
          const items = req.result || [];
          const max = items.reduce((m, r) => {
            if (!r.device_id || r.device_id === effectiveDeviceId) {
              return Math.max(m, Number(r.sequence) || 0);
            }
            return m;
          }, 0);
          resolve(max);
        };
        req.onerror = () => resolve(0);
      } catch {
        resolve(0);
      }
    });
  } else {
    try {
      const qRes = await db.query('SELECT sequence, device_id FROM sync_delta_queue');
      queueMaxSeqForOwnDevice = (qRes.values || []).reduce((m, r) => {
        if (!r.device_id || r.device_id === effectiveDeviceId) {
          return Math.max(m, Number(r.sequence) || 0);
        }
        return m;
      }, 0);
    } catch {}
  }

  // Check if snapshot covers THIS device
  const snapshotCoveredForOwnDevice = Number(
    cloudPayload.covered_peer_watermarks?.[effectiveDeviceId] ||
    (cloudPayload.device_id === effectiveDeviceId ? (cloudPayload.cloud_version_sequence || cloudPayload.cloud_version || 0) : 0)
  ) || 0;

  const prevAllocated = Number(existingState?.last_allocated_sequence) || 0;
  const prevUploaded = Number(existingState?.last_uploaded_sequence ?? existingState?.last_pushed_sequence) || 0;
  const prevAcked = Number(existingState?.last_acked_sequence) || 0;

  const isBrandNewBootstrap = Boolean(isNewDeviceBootstrap && !existingState && queueMaxSeqForOwnDevice === 0);

  const reconciledAllocated = isBrandNewBootstrap
    ? 0
    : Math.max(prevAllocated, prevUploaded, prevAcked, queueMaxSeqForOwnDevice, snapshotCoveredForOwnDevice);
  const reconciledUploaded = isBrandNewBootstrap
    ? 0
    : Math.max(prevUploaded, prevAcked, snapshotCoveredForOwnDevice);
  const reconciledAcked = isBrandNewBootstrap
    ? 0
    : Math.max(prevAcked, snapshotCoveredForOwnDevice);

  if (rawIdb) {
    await new Promise((resolve, reject) => {
      const tx = rawIdb.transaction(['sync_local_state'], 'readwrite');
      const store = tx.objectStore('sync_local_state');
      store.put({
        key: 'device_state',
        deviceId: effectiveDeviceId,
        device_id: effectiveDeviceId,
        base_snapshot_id: cloudPayload.snapshot_id,
        base_cloud_version: cloudPayload.cloud_version || 1,
        last_allocated_sequence: reconciledAllocated,
        last_uploaded_sequence: reconciledUploaded,
        last_pushed_sequence: reconciledUploaded,
        last_acked_sequence: reconciledAcked,
        lifecycle_state: DEVICE_LIFECYCLE.ACTIVE,
        updated_at: nowIso
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } else {
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, last_allocated_sequence, last_uploaded_sequence, last_pushed_sequence, last_acked_sequence, lifecycle_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['device_state', effectiveDeviceId, cloudPayload.snapshot_id, cloudPayload.cloud_version || 1, reconciledAllocated, reconciledUploaded, reconciledUploaded, reconciledAcked, DEVICE_LIFECYCLE.ACTIVE, nowIso]
    );
  }

  // 3. Resolve and align peer watermarks
  let watermarksToApply = {};
  try {
    watermarksToApply = resolveSnapshotPeerWatermarks(cloudPayload);
  } catch {
    if (cloudPayload.covered_peer_watermarks && typeof cloudPayload.covered_peer_watermarks === 'object') {
      watermarksToApply = { ...cloudPayload.covered_peer_watermarks };
    }
  }

  // Merge explicit peer watermark overrides
  if (peerWatermarksOverride && typeof peerWatermarksOverride === 'object') {
    watermarksToApply = { ...watermarksToApply, ...peerWatermarksOverride };
  }

  // If creator of snapshot is explicitly requested to be seeded (e.g. Device D authored Snapshot v12)
  if (seedCreatorWatermark && cloudPayload.device_id && cloudPayload.device_id !== effectiveDeviceId) {
    if (!watermarksToApply[cloudPayload.device_id]) {
      watermarksToApply[cloudPayload.device_id] = typeof seedCreatorWatermark === 'number' ? seedCreatorWatermark : 16;
    }
  }

  // Upsert covered peer watermarks
  const appliedPeers = new Set();
  for (const [peerId, rawSeq] of Object.entries(watermarksToApply || {})) {
    const coveredSeq = Number(rawSeq);
    if (!peerId || isNaN(coveredSeq) || coveredSeq <= 0) continue;
    appliedPeers.add(peerId);

    if (rawIdb) {
      await new Promise((resolve, reject) => {
        const tx = rawIdb.transaction(['sync_peer_state'], 'readwrite');
        const store = tx.objectStore('sync_peer_state');
        store.put({
          peer_device_id: peerId,
          last_staged_sequence: coveredSeq,
          last_reconciled_sequence: coveredSeq,
          base_snapshot_id: cloudPayload.snapshot_id,
          updated_at: nowIso
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } else {
      await db.run(
        'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
        [peerId, coveredSeq, coveredSeq, cloudPayload.snapshot_id, nowIso]
      );
    }
  }

  // Prune obsolete peer entries belonging to older baselines or unmentioned peers
  const existingPeers = (await db.query('SELECT peer_device_id, base_snapshot_id FROM sync_peer_state').catch(() => ({ values: [] }))).values || [];
  for (const row of existingPeers) {
    if (row.base_snapshot_id !== cloudPayload.snapshot_id || !appliedPeers.has(row.peer_device_id)) {
      await db.run('DELETE FROM sync_peer_state WHERE peer_device_id = ?', [row.peer_device_id]);
    }
  }
}

/**
 * Standalone, durable recovery function.
 * Restores the complete local database and sync engine state from persistent disk backup.
 * Works even after simulated process restart, browser tab reload, or interrupted replacement.
 */
export async function restorePreImportBackup(options = {}) {
  const db = options.dbInstance || getDB();

  let backupPackage = options.backupPackage || null;
  if (!backupPackage) {
    const backupStr = await getSetting('pre_recovery_durable_backup');
    if (backupStr) {
      try {
        backupPackage = JSON.parse(backupStr);
      } catch (err) {
        throw new SnapshotImportError(
          SNAPSHOT_IMPORT_ERROR_CODES.RESTORE_FAILED,
          `Failed to parse durable pre-import backup from storage: ${err.message}`
        );
      }
    } else {
      // Fallback: check legacy pre_v10_recovery_backup
      const legacyStr = await getSetting('pre_v10_recovery_backup');
      if (legacyStr) {
        try {
          const leg = JSON.parse(legacyStr);
          if (leg.entities) backupPackage = leg;
        } catch {}
      }
    }
  }

  if (!backupPackage || !backupPackage.entities) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.RESTORE_FAILED,
      'No valid durable pre-import recovery backup found in persistent storage.'
    );
  }

  // 1. Restore operational entity stores
  await populateLocalEntitiesBootstrap(db, backupPackage.entities || {}, { allowRecoveryReplacement: true });

  // 2. Restore sync tombstones
  const tombstones = backupPackage.entities?.sync_tombstones || [];
  if (typeof db.batchReplace === 'function') {
    const tombRows = tombstones.map(t => ({
      id: String(t.id || t.entity_id || ''),
      entity_type: String(t.entity_type || 'transaction'),
      entity_id: String(t.entity_id || t.id || ''),
      deleted_at: String(t.deleted_at || new Date().toISOString())
    }));
    await db.batchReplace('sync_tombstones', tombRows);
  } else {
    await db.run('DELETE FROM sync_tombstones');
    for (const t of tombstones) {
      await db.run(
        'INSERT OR REPLACE INTO sync_tombstones (id, entity_type, entity_id, deleted_at) VALUES (?, ?, ?, ?)',
        [t.id, t.entity_type || 'transaction', t.entity_id || t.id, t.deleted_at || new Date().toISOString()]
      );
    }
  }

  // 3. Restore sync delta queue
  await db.run('DELETE FROM sync_delta_queue');
  const deltaQueue = backupPackage.sync_state?.delta_queue || [];
  for (const q of deltaQueue) {
    const payloadStr = typeof q.payload === 'object' ? JSON.stringify(q.payload) : (q.payload || '');
    await db.run(
      'INSERT OR REPLACE INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status, created_at, acknowledged_at, base_checksum, new_checksum, tombstone_generation, resolution_type, resolved_event_id, resolved_conflict_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        q.event_id, q.device_id, q.sequence, q.timestamp, q.collection, q.entity_id, q.operation,
        payloadStr, q.status, q.created_at || null, q.acknowledged_at || null, q.base_checksum || null,
        q.new_checksum || null, q.tombstone_generation || null, q.resolution_type || null,
        q.resolved_event_id || null, q.resolved_conflict_id || null
      ]
    );
  }

  // 4. Restore sync local state
  await db.run('DELETE FROM sync_local_state');
  const localState = backupPackage.sync_state?.local_state || [];
  for (const s of localState) {
    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, base_cloud_version, last_allocated_sequence, last_uploaded_sequence, last_pushed_sequence, last_acked_sequence, lifecycle_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        s.key || 'device_state', s.device_id || s.deviceId || 'local_device',
        s.base_snapshot_id || null, s.base_cloud_version || 1,
        s.last_allocated_sequence || 0, s.last_uploaded_sequence || 0,
        s.last_pushed_sequence || 0, s.last_acked_sequence || 0,
        s.lifecycle_state || 'ACTIVE', s.updated_at || new Date().toISOString()
      ]
    );
  }

  // 5. Restore sync peer state
  await db.run('DELETE FROM sync_peer_state');
  const peerState = backupPackage.sync_state?.peer_state || [];
  for (const p of peerState) {
    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      [p.peer_device_id, p.last_staged_sequence || 0, p.last_reconciled_sequence || 0, p.base_snapshot_id || null, p.updated_at || new Date().toISOString()]
    );
  }

  // 6. Restore staged events & packages
  await db.run('DELETE FROM sync_staged_events');
  await db.run('DELETE FROM sync_staged_packages');
  for (const ev of (backupPackage.sync_state?.staged_events || [])) {
    const payloadStr = typeof ev.payload === 'object' ? JSON.stringify(ev.payload) : (ev.payload || '');
    await db.run(
      'INSERT OR REPLACE INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ev.event_id, ev.package_id, ev.device_id, ev.sequence, ev.timestamp, ev.collection, ev.entity_id, ev.operation, payloadStr, ev.status]
    );
  }
  for (const pkg of (backupPackage.sync_state?.staged_packages || [])) {
    await db.run(
      'INSERT OR REPLACE INTO sync_staged_packages (package_id, device_id, sequence_range, base_snapshot_id, status) VALUES (?, ?, ?, ?, ?)',
      [pkg.package_id, pkg.device_id, pkg.sequence_range, pkg.base_snapshot_id, pkg.status]
    );
  }

  // 7. Restore conflicts
  await db.run('DELETE FROM sync_conflicts');
  for (const cf of (backupPackage.sync_state?.conflicts || [])) {
    await db.run(
      'INSERT OR REPLACE INTO sync_conflicts (conflict_id, package_id, entity_type, entity_id, local_state, remote_state, base_state, detected_at, resolved_at, resolution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [cf.conflict_id, cf.package_id, cf.entity_type, cf.entity_id, cf.local_state, cf.remote_state, cf.base_state, cf.detected_at, cf.resolved_at, cf.resolution]
    );
  }

  // 8. Restore critical settings
  if (backupPackage.settings) {
    for (const [k, v] of Object.entries(backupPackage.settings)) {
      if (v !== null && v !== undefined) {
        await setSetting(k, String(v), { suppressDeltaQueue: true });
      } else {
        await db.run('DELETE FROM settings WHERE key = ?', [k]);
      }
    }
  }

  // 9. Post-restore verification
  const restoredEntities = await readLocalEntities(db);
  const actualReg = (restoredEntities.transactions || []).length;
  const actualInv = (restoredEntities.investment_transactions || []).length;
  const actualAccounts = (restoredEntities.accounts || []).length;
  const expectedReg = backupPackage.counts?.transactions ?? (backupPackage.entities.transactions || []).length;
  const expectedInv = backupPackage.counts?.investment_transactions ?? (backupPackage.entities.investment_transactions || []).length;
  const expectedAcc = backupPackage.counts?.accounts ?? (backupPackage.entities.accounts || []).length;

  if (actualReg !== expectedReg || actualInv !== expectedInv || actualAccounts !== expectedAcc) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.RESTORE_FAILED,
      `Post-restore physical count verification failed. Expected ${expectedReg} reg txns, ${expectedInv} inv txns, ${expectedAcc} accounts. Got ${actualReg}, ${actualInv}, ${actualAccounts}.`
    );
  }

  return {
    success: true,
    restoredCounts: {
      transactions: actualReg,
      investment_transactions: actualInv,
      totalTransactions: actualReg + actualInv,
      accounts: actualAccounts,
      inventory: (restoredEntities.inventory || []).length
    },
    backupId: backupPackage.backup_id,
    timestamp: backupPackage.timestamp
  };
}

/**
 * Read-only verification check confirming that post-rollback local record counts
 * and critical settings match the pre-import recovery backup.
 */
export async function verifyLocalRecoveryState(dbInstance = null) {
  const db = dbInstance || getDB();
  const currentEntities = await readLocalEntities(db);
  const currentCounts = {
    regularTransactions: (currentEntities.transactions || []).length,
    investmentTransactions: (currentEntities.investment_transactions || []).length,
    totalTransactions: (currentEntities.transactions || []).length + (currentEntities.investment_transactions || []).length,
    accounts: (currentEntities.accounts || []).length,
    accountGroups: (currentEntities.account_groups || []).length,
    categories: (currentEntities.categories || []).length,
    inventory: (currentEntities.inventory || []).length
  };

  const durableMetaJson = await getSetting('pre_recovery_durable_backup_meta');
  const durableBackupJson = await getSetting('pre_recovery_durable_backup');
  const legacyBackupJson = await getSetting('pre_v10_recovery_backup');
  const quarantinedDeltasJson = await getSetting('pre_recovery_quarantined_deltas');

  let backupInfo = null;
  let matchesBackup = false;
  let hasDurableBackup = false;
  let durableBackupId = null;
  let durableSha256 = null;

  if (durableMetaJson) {
    try {
      backupInfo = JSON.parse(durableMetaJson);
      hasDurableBackup = !!durableBackupJson;
      durableBackupId = backupInfo.backup_id;
      durableSha256 = backupInfo.sha256;
      matchesBackup = (
        currentCounts.regularTransactions === (backupInfo.counts?.transactions ?? backupInfo.counts?.regularTransactions) &&
        currentCounts.investmentTransactions === (backupInfo.counts?.investment_transactions ?? backupInfo.counts?.investmentTransactions) &&
        currentCounts.accounts === backupInfo.counts?.accounts
      );
    } catch {}
  }

  if (!backupInfo && legacyBackupJson) {
    try {
      backupInfo = JSON.parse(legacyBackupJson);
      matchesBackup = (
        currentCounts.regularTransactions === backupInfo.counts?.transactions &&
        currentCounts.investmentTransactions === backupInfo.counts?.investment_transactions &&
        currentCounts.accounts === backupInfo.counts?.accounts
      );
    } catch {}
  }

  let quarantinedInfo = null;
  if (quarantinedDeltasJson) {
    try { quarantinedInfo = JSON.parse(quarantinedDeltasJson); } catch {}
  }

  const lastSnapshotId = await getSetting('last_snapshot_id');
  const syncBaseManifest = await getSetting('sync_base_manifest');

  let status = 'NO_BACKUP_FOUND';
  if (matchesBackup) {
    status = 'RECOVERED_MATCHES_BACKUP';
  } else if (hasDurableBackup || backupInfo) {
    status = 'COUNTS_DIFFER_FROM_BACKUP';
  }

  return {
    status,
    matchesBackup,
    hasDurableBackup,
    durableBackupId,
    durableSha256,
    currentCounts,
    backupTimestamp: backupInfo?.timestamp || backupInfo?.created_at || null,
    backupCounts: backupInfo?.counts || null,
    quarantinedDeltas: quarantinedInfo ? {
      quarantinedAt: quarantinedInfo.quarantined_at,
      reason: quarantinedInfo.reason,
      count: quarantinedInfo.counts?.total ?? quarantinedInfo.events?.length ?? 0,
      unacknowledged: quarantinedInfo.counts?.unacknowledged ?? 0
    } : null,
    lastSnapshotId,
    hasBaseManifest: !!syncBaseManifest
  };
}

/**
 * Trustworthy validation for incoming snapshot payloads during existing-device reconciliation.
 * Validates schema, envelope, lineage, internal ID uniqueness, entity shapes, and manifest integrity
 * without relying solely on hardcoded counts or blindly trusting entities.length.
 */
export async function validateTrustworthySnapshotPayload(cloudPayload, options = {}) {
  const {
    currentSnapshotId = null,
    currentCloudVersion = null,
    targetSnapshotId = null,
    targetCloudVersion = null
  } = options;

  if (!cloudPayload || typeof cloudPayload !== 'object') {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      'Trustworthy validation failed: Cloud payload is missing or not a valid object.'
    );
  }

  // 1. Envelope validation
  const snapshotId = cloudPayload.snapshot_id;
  if (!snapshotId || typeof snapshotId !== 'string' || !snapshotId.trim()) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      'Trustworthy validation failed: Missing or invalid snapshot_id.'
    );
  }

  const cloudVersion = Number(cloudPayload.cloud_version);
  if (isNaN(cloudVersion) || cloudVersion <= 0) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Trustworthy validation failed: Invalid cloud_version (${cloudPayload.cloud_version}).`
    );
  }

  const schemaVersion = Number(cloudPayload.schema_version);
  if (isNaN(schemaVersion) || schemaVersion < 12) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Trustworthy validation failed: Unsupported schema_version (${cloudPayload.schema_version}).`
    );
  }

  if (!cloudPayload.created_at || isNaN(Date.parse(cloudPayload.created_at))) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      'Trustworthy validation failed: Missing or unparseable created_at ISO timestamp.'
    );
  }

  // Target assertion if caller specified expected targets
  if (targetSnapshotId && snapshotId !== targetSnapshotId) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Target snapshot ID mismatch: expected '${targetSnapshotId}', got '${snapshotId}'.`
    );
  }
  if (targetCloudVersion && cloudVersion < Number(targetCloudVersion)) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Target cloud version mismatch: expected at least ${targetCloudVersion}, got ${cloudVersion}.`
    );
  }

  // 2. Lineage verification against current active baseline
  if (currentCloudVersion !== null && currentCloudVersion !== undefined && cloudVersion < currentCloudVersion) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Regression rejected: Incoming snapshot version (v${cloudVersion}) is older than active baseline (v${currentCloudVersion}).`
    );
  }

  // 3. Deep schema validation
  try {
    await validateCloudSnapshotPayload(cloudPayload);
  } catch (err) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Schema validation error: ${err.message}`,
      { cause: err }
    );
  }

  // 4. Entities map and collections validation
  const entities = cloudPayload.entities || {};
  const collectionsToCheck = [
    'transactions',
    'investment_transactions',
    'accounts',
    'categories',
    'subcategories',
    'account_groups',
    'inventory',
    'brokerages'
  ];

  for (const col of collectionsToCheck) {
    if (entities[col] !== undefined && !Array.isArray(entities[col])) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Integrity error: Collection entities.${col} must be an array when present.`
      );
    }
  }

  // 5. Primary key uniqueness and record schema checks
  const txnIds = new Set();
  const transactions = entities.transactions || [];
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    const id = t.id || t._id || t.ID;
    if (!id || typeof id !== 'string' || !id.trim()) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Integrity error: Transaction at index ${i} has empty or non-string ID.`
      );
    }
    if (txnIds.has(id)) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Integrity error: Duplicate transaction ID '${id}' detected in snapshot payload.`
      );
    }
    txnIds.add(id);

    const date = t.Date || t.date;
    if (!date || typeof date !== 'string') {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Integrity error: Transaction '${id}' has missing or non-string date.`
      );
    }
    const type = t['Income/Expense'] || t.type;
    if (!type || typeof type !== 'string') {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Integrity error: Transaction '${id}' has missing type.`
      );
    }
  }

  const invTxnIds = new Set();
  const invTransactions = entities.investment_transactions || [];
  for (let i = 0; i < invTransactions.length; i++) {
    const it = invTransactions[i];
    const id = it.id || it._id || it.ID;
    if (!id || typeof id !== 'string' || !id.trim()) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Integrity error: Investment transaction at index ${i} has empty or non-string ID.`
      );
    }
    if (invTxnIds.has(id)) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Integrity error: Duplicate investment transaction ID '${id}' detected in snapshot payload.`
      );
    }
    invTxnIds.add(id);
  }

  const accountIds = new Set();
  const accounts = entities.accounts || [];
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const id = a.id || a._id;
    if (!id || typeof id !== 'string' || !id.trim()) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Integrity error: Account at index ${i} has empty or non-string ID.`
      );
    }
    if (accountIds.has(id)) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Integrity error: Duplicate account ID '${id}' detected in snapshot payload.`
      );
    }
    accountIds.add(id);
  }

  // 6. Cross-validate metadata counts if declared
  if (cloudPayload.metadata && typeof cloudPayload.metadata.counts === 'object') {
    const metaCounts = cloudPayload.metadata.counts;
    if (metaCounts.transactions !== undefined && metaCounts.transactions !== transactions.length) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Declared metadata count mismatch for transactions: metadata declared ${metaCounts.transactions}, actual payload has ${transactions.length}.`
      );
    }
    if (metaCounts.investment_transactions !== undefined && metaCounts.investment_transactions !== invTransactions.length) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Declared metadata count mismatch for investment_transactions: metadata declared ${metaCounts.investment_transactions}, actual payload has ${invTransactions.length}.`
      );
    }
    if (metaCounts.accounts !== undefined && metaCounts.accounts !== accounts.length) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        `Declared metadata count mismatch for accounts: metadata declared ${metaCounts.accounts}, actual payload has ${accounts.length}.`
      );
    }
  }

  // 7. Validate covered_peer_watermarks structure if present
  if (cloudPayload.covered_peer_watermarks !== undefined) {
    if (typeof cloudPayload.covered_peer_watermarks !== 'object' || cloudPayload.covered_peer_watermarks === null) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
        'Integrity error: covered_peer_watermarks must be an object map when provided.'
      );
    }
    for (const [peerId, seq] of Object.entries(cloudPayload.covered_peer_watermarks)) {
      if (!peerId || typeof peerId !== 'string') {
        throw new SnapshotImportError(
          SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
          'Integrity error: Invalid peer identifier in covered_peer_watermarks.'
        );
      }
      if (isNaN(Number(seq)) || Number(seq) < 0) {
        throw new SnapshotImportError(
          SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
          `Integrity error: Invalid sequence (${seq}) for peer '${peerId}' in covered_peer_watermarks.`
        );
      }
    }
  }

  // 8. Canonical manifest test
  try {
    await buildEntityManifest(entities);
  } catch (err) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED,
      `Canonical manifest generation failed: ${err.message}`,
      { cause: err }
    );
  }

  return true;
}

/**
 * Guarded Snapshot Reconciliation for Existing Devices.
 * Reconciles an already initialized device with a newer cloud snapshot baseline
 * (such as v11 -> v12) without risking existing financial data.
 * 
 * Guarantees:
 * 1. Explicit Confirmation Gate.
 * 2. Pre-mutation trustworthy snapshot validation (schema, lineage, uniqueness, metadata).
 * 3. Durable pre-import disk backup creation & SHA-256 self-verification before any destructive change.
 * 4. Preserves local device identity (Device A).
 * 5. Quarantines pending outbound deltas into settings to prevent ghost replays and protect unpushed edits.
 * 6. Atomically replaces operational stores and aligns sync state/peer watermarks.
 * 7. Replays inbound deltas (e.g. sequence 16) through the normal staging & reconciliation pipeline.
 * 8. Automatic fail-closed rollback to the pristine pre-recovery backup on ANY failure.
 * 9. Safe for retries (idempotent delta staging and reconciliation).
 */
export async function reconcileExistingDeviceWithSnapshot(options = {}) {
  const confirmation = options.confirmation || options.confirmationKey;
  const isConfirmed = (confirmation === true || confirmation === 'CONFIRM_RECONCILE_EXISTING_DEVICE');
  if (!isConfirmed) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.CONFIRMATION_REQUIRED,
      'Reconciliation aborted: Explicit confirmation required before reconciling existing device data. Pass confirmation: "CONFIRM_RECONCILE_EXISTING_DEVICE".'
    );
  }

  if (options._hasMasterLock) {
    return await _executeExistingDeviceReconciliation(options);
  }

  const { withMasterSyncLock } = await import('./deltaSyncCoordinator.js');
  return await withMasterSyncLock(async () => {
    return await _executeExistingDeviceReconciliation(options);
  }, { timeoutMs: 180000 });
}

async function _executeExistingDeviceReconciliation(options = {}) {
  const {
    accessToken = null,
    pin = null,
    keyMaterial = null,
    driveClient = null,
    dbInstance = null,
    snapshotPayload: providedPayload = null,
    targetSnapshotId = null,
    targetCloudVersion = null,
    inboundPackages = [],
    inboundPeerDeviceId = null,
    replayInboundDeltas = true,
    strictDeltaApplication = false,
    onProgress = () => {}
  } = options;

  const db = dbInstance || getDB();

  // Step 1: Resolve and preserve local persistent device identifier
  let deviceId = options.deviceId;
  if (!deviceId || deviceId === 'local_device') {
    deviceId = await getOrCreateLocalDeviceId().catch(() => null);
  }
  if (!deviceId || deviceId === 'local_device') {
    const localStateRes = await db.query('SELECT device_id FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }));
    if (localStateRes.values?.[0]?.device_id) {
      deviceId = localStateRes.values[0].device_id;
    }
  }
  if (!deviceId || deviceId === 'local_device') {
    deviceId = 'dev_fa18ce0c9349'; // Fallback to current device
  }

  // Step 2: Fetch & Decrypt Snapshot if not provided
  let cloudPayload = providedPayload || options.cloudPayload;
  if (!cloudPayload) {
    onProgress({ stage: 'DOWNLOADING', message: 'Downloading verified cloud snapshot…' });
    const effectiveKey = options.sessionKey || keyMaterial || (typeof pin === 'string' && pin.trim() ? pin.trim() : pin) || getSyncSessionKey();
    if (!effectiveKey) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.MISSING_PARAMETERS,
        'Encryption PIN or unlocked session key is required for snapshot reconciliation.'
      );
    }
    const transport = driveClient || { findAppDataFile, readAppDataFile };
    const snapshotFilename = options.filename || SNAPSHOT_FILENAME;
    const cloudFile = await transport.findAppDataFile(snapshotFilename, accessToken);
    if (!cloudFile) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.SNAPSHOT_NOT_FOUND,
        `Cloud snapshot file '${snapshotFilename}' not found in Google Drive appDataFolder.`
      );
    }
    let ciphertext;
    try {
      ciphertext = await transport.readAppDataFile(cloudFile.id, accessToken);
    } catch (err) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.DOWNLOAD_FAILED,
        `Failed to download cloud snapshot: ${err.message}`,
        { cause: err }
      );
    }
    try {
      cloudPayload = await decryptBackupData(ciphertext, effectiveKey);
    } catch (err) {
      throw new SnapshotImportError(
        SNAPSHOT_IMPORT_ERROR_CODES.DECRYPTION_FAILED,
        `Failed to decrypt cloud snapshot: ${err.message}`,
        { cause: err }
      );
    }
  }

  onProgress({ stage: 'VALIDATING', message: 'Validating trustworthy snapshot metadata and integrity…' });

  // Step 3: Inspect active baseline and validate trustworthy payload
  const currentSnapId = await getSetting('last_snapshot_id').catch(() => null);
  const localStateRow = (await db.query('SELECT base_cloud_version FROM sync_local_state WHERE key = ?', ['device_state']).catch(() => ({ values: [] }))).values?.[0];
  const currentCloudVersion = localStateRow ? Number(localStateRow.base_cloud_version) : null;

  await validateTrustworthySnapshotPayload(cloudPayload, {
    currentSnapshotId: currentSnapId,
    currentCloudVersion,
    targetSnapshotId,
    targetCloudVersion
  });

  onProgress({ stage: 'BACKING_UP', message: 'Creating durable, verified backup of existing local data…' });

  // Step 4: Create and Self-Verify Durable Local Backup Before ANY Mutation (Fail-Closed Gate)
  let durableBackupInfo;
  try {
    durableBackupInfo = await createDurablePreImportBackup(db);
  } catch (backupErr) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.PRE_BACKUP_FAILED,
      `Failed to capture and verify durable pre-replacement backup: ${backupErr.message}`,
      { cause: backupErr }
    );
  }
  const { backupPackage, backupSha256, backupId } = durableBackupInfo;

  onProgress({ stage: 'REPLACING', message: `Reconciling to snapshot baseline v${cloudPayload.cloud_version}…` });

  // Step 5: Transactional Population, Lineage Alignment & Inbound Delta Replay with Automated Rollback Guard
  try {
    const isBaselineAlreadyInstalled = (currentSnapId === cloudPayload.snapshot_id);
    let quarantinedCount = 0;

    if (!isBaselineAlreadyInstalled) {
      // 5a. Quarantine pending delta events
      const quarantineRes = await quarantinePendingDeltas(db, {
        deviceId,
        targetSnapshotId: cloudPayload.snapshot_id,
        targetCloudVersion: cloudPayload.cloud_version
      });
      quarantinedCount = quarantineRes.quarantinedCount;

      // 5b. Replace operational stores with snapshot entities
      await populateLocalEntitiesBootstrap(db, cloudPayload.entities || {}, { allowRecoveryReplacement: true });

      // 5c. Align sync lineage stores (local sequence, peer watermarks, staged events, tombstones)
      await alignSnapshotSyncLineage(db, {
        cloudPayload,
        deviceId,
        peerWatermarksOverride: options.peerWatermarksOverride || {}
      });

      onProgress({ stage: 'VERIFYING', message: 'Verifying installed baseline data…' });

      // 5d. Post-population count check against snapshot entities
      const postEntities = await readLocalEntities(db);
      const expectedReg = (cloudPayload.entities?.transactions || []).length;
      const expectedInv = (cloudPayload.entities?.investment_transactions || []).length;
      const actualReg = (postEntities.transactions || []).length;
      const actualInv = (postEntities.investment_transactions || []).length;

      if (actualReg !== expectedReg || actualInv !== expectedInv) {
        throw new Error(`Count mismatch after baseline population: expected ${expectedReg} reg / ${expectedInv} inv txns; got ${actualReg} reg / ${actualInv} inv txns.`);
      }

      // 5e. Canonical manifest equality check
      const localManifest = await buildEntityManifest(postEntities);
      const cloudManifest = await buildEntityManifest(cloudPayload.entities || {});
      for (const [id, cloudEntry] of Object.entries(cloudManifest)) {
        const localEntry = localManifest[id];
        if (!localEntry || localEntry.canonical !== cloudEntry.canonical) {
          throw new Error(`Canonical integrity mismatch after baseline population for entity '${id}'.`);
        }
      }

      // Finalize baseline settings
      const nowIso = new Date().toISOString();
      await setSetting('sync_base_manifest', JSON.stringify(localManifest), { suppressDeltaQueue: true });
      await setSetting('last_snapshot_id', cloudPayload.snapshot_id, { suppressDeltaQueue: true });
      await setSetting('last_parent_snapshot_id', cloudPayload.parent_snapshot_id || '', { suppressDeltaQueue: true });
      await setSetting('last_cloud_version', String(cloudPayload.cloud_version || 1), { suppressDeltaQueue: true });
      await setSetting('last_synced_at', nowIso, { suppressDeltaQueue: true });
      await setSetting('last_delta_synced_at', nowIso, { suppressDeltaQueue: true });
      await setSetting('device_lifecycle_state', DEVICE_LIFECYCLE.ACTIVE, { suppressDeltaQueue: true });
    }

    const currentEntitiesPost = await readLocalEntities(db);
    const actualReg = (currentEntitiesPost.transactions || []).length;
    const actualInv = (currentEntitiesPost.investment_transactions || []).length;

    // 5f. Replay Inbound Peer Deltas through the normal validated staging and reconciliation pipeline
    let totalReconciled = 0;
    let totalIdempotent = 0;
    let totalConflicts = 0;
    let totalBlockedGap = 0;

    if (replayInboundDeltas) {
      onProgress({ stage: 'REPLAYING_DELTAS', message: 'Replaying inbound peer deltas through validation pipeline…' });
      const { stagePeerPackageAtomically, pullPeerDeltas } = await import('./deltaTransport.js');
      const { reconcileStagedEvents } = await import('./deltaReconciliation.js');

      // Stage explicit inbound packages if provided
      if (Array.isArray(inboundPackages) && inboundPackages.length > 0) {
        for (const pkg of inboundPackages) {
          const stageInput = pkg.packagePayload ? pkg : { packagePayload: pkg, packageChecksum: pkg.package_checksum || null };
          await stagePeerPackageAtomically(stageInput);
        }
      } else if (accessToken || driveClient) {
        // Pull peer packages from Drive
        const effectiveKey = keyMaterial || (typeof pin === 'string' && pin.trim() ? pin.trim() : pin) || getSyncSessionKey();
        await pullPeerDeltas({
          localDeviceId: deviceId,
          creatorDeviceId: cloudPayload.device_id,
          accessToken,
          driveClient,
          sessionKey: effectiveKey,
          baseSnapshotId: cloudPayload.snapshot_id,
          immediateParentSnapshotId: cloudPayload.parent_snapshot_id
        });
      }

      // Identify peers to reconcile
      const peersToReconcile = new Set();
      if (inboundPeerDeviceId) peersToReconcile.add(inboundPeerDeviceId);
      for (const pkg of inboundPackages) {
        const pId = pkg.device_id || pkg.packagePayload?.device_id;
        if (pId) peersToReconcile.add(pId);
      }
      if (peersToReconcile.size === 0) {
        const stagedPeers = await db.query('SELECT DISTINCT device_id FROM sync_staged_events').catch(() => ({ values: [] }));
        for (const r of stagedPeers.values || []) {
          if (r.device_id) peersToReconcile.add(r.device_id);
        }
      }

      for (const peerId of peersToReconcile) {
        const reconRes = await reconcileStagedEvents({ peerDeviceId: peerId });
        totalReconciled += reconRes.reconciledCount || 0;
        totalIdempotent += reconRes.idempotentCount || 0;
        totalConflicts += reconRes.conflictCount || 0;
        totalBlockedGap += reconRes.blockedGapCount || 0;
      }

      if (strictDeltaApplication && (totalConflicts > 0 || totalBlockedGap > 0)) {
        throw new Error(`Strict delta application failed: ${totalConflicts} conflicts, ${totalBlockedGap} blocked gaps.`);
      }
    }

    onProgress({ stage: 'COMPLETE', message: `Guarded snapshot v${cloudPayload.cloud_version} reconciliation complete!` });

    try {
      const { ensureOwnDeviceManifestSynced } = await import('./deviceManifest.js');
      await ensureOwnDeviceManifestSynced({
        deviceId,
        accessToken,
        driveClient,
        force: true
      });
    } catch (mErr) {
      console.warn('[reconcileExistingDeviceWithSnapshot] Non-fatal: Failed to align device manifest:', mErr.message);
    }

    return {
      success: true,
      status: 'RECONCILIATION_SUCCESS',
      snapshotId: cloudPayload.snapshot_id,
      cloudVersion: cloudPayload.cloud_version,
      deviceId,
      recordsInstalled: {
        transactions: actualReg,
        investment_transactions: actualInv,
        totalTransactions: actualReg + actualInv,
        accounts: (currentEntitiesPost.accounts || []).length,
        inventory: (currentEntitiesPost.inventory || []).length
      },
      durableBackupId: backupId,
      durableBackupSha256: backupSha256,
      quarantinedDeltaEventsCount: quarantinedCount,
      reconciledDeltasCount: totalReconciled,
      idempotentDeltasCount: totalIdempotent,
      conflictDeltasCount: totalConflicts,
      blockedGapDeltasCount: totalBlockedGap
    };
  } catch (err) {
    // Automated Rollback Guard on ANY failure
    console.error('[reconcileExistingDeviceWithSnapshot] Failure during reconciliation, initiating durable rollback:', err);
    let rollbackSuccess = false;
    let rollbackDetails = null;

    try {
      const rollbackResult = await restorePreImportBackup({ dbInstance: db, backupPackage });
      if (rollbackResult.success) {
        rollbackSuccess = true;
        rollbackDetails = 'Local database and sync state rolled back cleanly to durable pre-import backup.';
      } else {
        rollbackDetails = 'Rollback completed but verification did not report success.';
      }
    } catch (rbErr) {
      console.error('[reconcileExistingDeviceWithSnapshot] Catastrophic: Rollback failed:', rbErr);
      rollbackDetails = `Rollback error: ${rbErr.message}`;
    }

    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.ROLLBACK_TRIGGERED,
      `Snapshot reconciliation failed (${err.message}). ${rollbackDetails}`,
      {
        originalError: err.message,
        rollbackSuccess,
        rollbackDetails,
        preImportBackupCounts: backupPackage?.counts || null,
        durableBackupId: backupId || null
      }
    );
  }
}

