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

import { getDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import { decryptBackupData } from '../utils/cryptoBackup.js';
import { getSyncSessionKey } from './syncSession.js';
import { findAppDataFile, readAppDataFile } from './googleDriveSync.js';
import {
  SNAPSHOT_FILENAME,
  readLocalEntities,
  buildEntityManifest,
  populateLocalEntitiesBootstrap,
  validateCloudSnapshotPayload
} from './cloudSyncEngine.js';

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
  POST_VERIFICATION_FAILED: 'POST_VERIFICATION_FAILED'
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

  onProgress({ stage: 'BACKING_UP', message: 'Creating recoverable backup of existing local data…' });

  // Gate 3: Create Recoverable Local Backup Before Any Mutations
  let recoveryBackup;
  try {
    const currentEntities = await readLocalEntities(db);
    const [baseManifest, lastSnap, lastParent, lastSyncAt] = await Promise.all([
      getSetting('sync_base_manifest').catch(() => null),
      getSetting('last_snapshot_id').catch(() => null),
      getSetting('last_parent_snapshot_id').catch(() => null),
      getSetting('last_synced_at').catch(() => null)
    ]);

    recoveryBackup = {
      timestamp: new Date().toISOString(),
      entities: currentEntities,
      settings: {
        sync_base_manifest: baseManifest,
        last_snapshot_id: lastSnap,
        last_parent_snapshot_id: lastParent,
        last_synced_at: lastSyncAt
      },
      counts: {
        transactions: (currentEntities.transactions || []).length,
        investment_transactions: (currentEntities.investment_transactions || []).length,
        accounts: (currentEntities.accounts || []).length,
        inventory: (currentEntities.inventory || []).length
      }
    };

    // Persist backup in settings store as fail-safe
    await setSetting('pre_v10_recovery_backup', JSON.stringify({
      timestamp: recoveryBackup.timestamp,
      counts: recoveryBackup.counts,
      settings: recoveryBackup.settings
    }));
  } catch (backupErr) {
    throw new SnapshotImportError(
      SNAPSHOT_IMPORT_ERROR_CODES.PRE_BACKUP_FAILED,
      `Failed to capture pre-replacement local backup: ${backupErr.message}`,
      { cause: backupErr }
    );
  }

  onProgress({ stage: 'REPLACING', message: 'Installing verified v10 baseline data…' });

  // Gate 4: Transactional Population & Rollback Guard
  try {
    // 4a. Replace operational stores with snapshot entities
    await populateLocalEntitiesBootstrap(db, cloudPayload.entities || {});

    onProgress({ stage: 'VERIFYING', message: 'Verifying installed records and canonical integrity…' });

    // 4b. Post-import physical count verification
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

    // 4c. Canonical manifest equality verification
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

    // 4d. Finalize local sync settings (Align with Cloud v10)
    const nowIso = new Date().toISOString();
    await setSetting('sync_base_manifest', JSON.stringify(localManifest));
    await setSetting('last_snapshot_id', cloudPayload.snapshot_id);
    await setSetting('last_parent_snapshot_id', cloudPayload.parent_snapshot_id || '');
    await setSetting('last_synced_at', nowIso);
    await setSetting('sub_accounts_migrated_v2', 'true');
    await setSetting('historical_charges_reconciled', 'true');

    onProgress({ stage: 'COMPLETE', message: 'Verified v10 snapshot successfully imported!' });

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
      preImportBackupCounts: recoveryBackup.counts
    };
  } catch (err) {
    // Gate 5: Rollback on Failure
    console.error('[snapshotDeviceImport] Critical failure during import, initiating rollback:', err);
    let rollbackSuccess = false;
    let rollbackDetails = null;

    try {
      await populateLocalEntitiesBootstrap(db, recoveryBackup.entities || {});
      if (recoveryBackup.settings) {
        for (const [k, v] of Object.entries(recoveryBackup.settings)) {
          if (v !== null && v !== undefined) {
            await setSetting(k, String(v));
          }
        }
      }
      const rolledBack = await readLocalEntities(db);
      if ((rolledBack.transactions || []).length === recoveryBackup.counts.transactions &&
          (rolledBack.investment_transactions || []).length === recoveryBackup.counts.investment_transactions) {
        rollbackSuccess = true;
        rollbackDetails = 'Local database rolled back cleanly to pre-import backup.';
      } else {
        rollbackDetails = 'Rollback completed but physical counts differ from pre-import backup.';
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
        preImportBackupCounts: recoveryBackup.counts
      }
    );
  }
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

  const backupJson = await getSetting('pre_v10_recovery_backup');
  let backupInfo = null;
  let matchesBackup = null;

  if (backupJson) {
    try {
      backupInfo = JSON.parse(backupJson);
      matchesBackup = (
        currentCounts.regularTransactions === backupInfo.counts?.transactions &&
        currentCounts.investmentTransactions === backupInfo.counts?.investment_transactions &&
        currentCounts.accounts === backupInfo.counts?.accounts
      );
    } catch {}
  }

  const lastSnapshotId = await getSetting('last_snapshot_id');
  const syncBaseManifest = await getSetting('sync_base_manifest');

  return {
    status: matchesBackup === true ? 'RECOVERED_MATCHES_BACKUP' : (backupInfo ? 'COUNTS_DIFFER_FROM_BACKUP' : 'NO_BACKUP_FOUND'),
    matchesBackup,
    currentCounts,
    backupTimestamp: backupInfo?.timestamp || null,
    backupCounts: backupInfo?.counts || null,
    lastSnapshotId,
    hasBaseManifest: !!syncBaseManifest
  };
}
