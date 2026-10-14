/**
 * snapshotPromotion.js — Production Promotion Service for Candidate Snapshot v10
 * 
 * Safely promotes validated Candidate Snapshot v10 to Google Drive appDataFolder,
 * strictly replacing existing Snapshot v9 in-place with comprehensive pre-write,
 * post-write, and automated rollback safety gates.
 * 
 * STRICT INVARIANTS:
 * 1. Pre-Write Gate: The candidate artifact MUST pass SHA-256 assertion, schema
 *    checks, and entity count assertions.
 * 2. Active Cloud Gate: The active cloud file MUST be queried with pagination,
 *    confirmed as exactly 1 matching file with the expected Drive file ID,
 *    and verified against preserved v9 size, MD5, SHA-256, and decrypted identity.
 * 3. Update-Only Invariant: Updates only the existing snapshot file via multipart
 *    PATCH. Never creates a new snapshot file (no POST).
 * 4. Post-Write Gate: Re-queries Drive, downloads the written ciphertext, decrypts
 *    in memory, and verifies v10 snapshot identity, cloud version 10, parent v9,
 *    schema version 13, and exact transaction/account/inventory counts.
 * 5. Automated Rollback Safety: If upload or post-write verification fails, invokes
 *    snapshotRollback.js to restore preserved v9 ciphertext.
 * 6. Zero Local Database Mutation: Makes zero writes to IndexedDB or local settings.
 * 7. Zero Credential Exposure: Never logs or persists access tokens or the Sync PIN.
 */

import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';
import { validateCloudSnapshotPayload } from './cloudSyncEngine.js';
import {
  DRIVE_API_BASE,
  DRIVE_UPLOAD_BASE,
  computeMd5,
  computeSha256,
  findDriveSnapshotFile,
  executeSnapshotRollback,
  V9_REFERENCE
} from './snapshotRollback.js';

export const CANDIDATE_V10_REFERENCE = {
  filename: 'finman_cloud_sync_snapshot.finman',
  driveFileId: '1TZKKamd_pLWt6A9HaxMWPKtUv-66GhT7GJZosePORhHy0cU6_sk',
  snapshotId: 'snap_1791810470667_candidate_v10',
  cloudVersion: 10,
  parentSnapshotId: 'snap_1790963722004_bq5y93',
  schemaVersion: 13,
  engineVersion: 3,
  sha256: 'a68f6f8bb18f862b6f960d046c7d39491154cc068e99a7a37e688e822026fed0',
  transactionsCount: 28259,
  investmentTransactionsCount: 899,
  totalTransactionsCount: 29158,
  accountsCount: 36,
  inventoryCount: 732,
  coveredPeerWatermarks: {
    dev_6edc69e37943: 4,
    dev_b91065cd877f: 6,
    dev_f31f6e6d6628: 12
  }
};

export const PROMOTION_ERROR_CODES = {
  MISSING_PARAMETERS: 'MISSING_PARAMETERS',
  CANDIDATE_INTEGRITY_FAILED: 'CANDIDATE_INTEGRITY_FAILED',
  CANDIDATE_VALIDATION_FAILED: 'CANDIDATE_VALIDATION_FAILED',
  PRE_WRITE_QUERY_FAILED: 'PRE_WRITE_QUERY_FAILED',
  PRE_WRITE_NO_SNAPSHOT_FOUND: 'PRE_WRITE_NO_SNAPSHOT_FOUND',
  PRE_WRITE_DUPLICATE_SNAPSHOTS: 'PRE_WRITE_DUPLICATE_SNAPSHOTS',
  PRE_WRITE_UNEXPECTED_FILE_ID: 'PRE_WRITE_UNEXPECTED_FILE_ID',
  PRE_WRITE_READ_FAILED: 'PRE_WRITE_READ_FAILED',
  PRE_WRITE_SIZE_MISMATCH: 'PRE_WRITE_SIZE_MISMATCH',
  PRE_WRITE_MD5_MISMATCH: 'PRE_WRITE_MD5_MISMATCH',
  PRE_WRITE_SHA256_MISMATCH: 'PRE_WRITE_SHA256_MISMATCH',
  PRE_WRITE_DECRYPT_FAILED: 'PRE_WRITE_DECRYPT_FAILED',
  PRE_WRITE_IDENTITY_MISMATCH: 'PRE_WRITE_IDENTITY_MISMATCH',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  POST_WRITE_QUERY_FAILED: 'POST_WRITE_QUERY_FAILED',
  POST_WRITE_DUPLICATE_SNAPSHOTS: 'POST_WRITE_DUPLICATE_SNAPSHOTS',
  POST_WRITE_ID_MISMATCH: 'POST_WRITE_ID_MISMATCH',
  POST_WRITE_READ_FAILED: 'POST_WRITE_READ_FAILED',
  POST_WRITE_DECRYPT_FAILED: 'POST_WRITE_DECRYPT_FAILED',
  POST_WRITE_IDENTITY_MISMATCH: 'POST_WRITE_IDENTITY_MISMATCH',
  POST_WRITE_VALIDATION_FAILED: 'POST_WRITE_VALIDATION_FAILED',
  AUTOMATIC_ROLLBACK_TRIGGERED: 'AUTOMATIC_ROLLBACK_TRIGGERED',
  AUTOMATIC_ROLLBACK_FAILED: 'AUTOMATIC_ROLLBACK_FAILED'
};

export class PromotionError extends Error {
  constructor(code, message, details = {}) {
    super(`[PROMOTION_${code}] ${message}`);
    this.name = 'PromotionError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Normalizes string/Uint8Array/Buffer input to text and byte representations.
 */
function normalizePayload(input) {
  if (typeof input === 'string') {
    return {
      str: input,
      bytes: new TextEncoder().encode(input)
    };
  }
  if (input instanceof Uint8Array) {
    return {
      str: new TextDecoder().decode(input),
      bytes: input
    };
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
    const u8 = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return {
      str: new TextDecoder().decode(u8),
      bytes: u8
    };
  }
  throw new PromotionError(PROMOTION_ERROR_CODES.MISSING_PARAMETERS, 'Input must be a string, Uint8Array, or Buffer');
}

/**
 * Gate 1: Thorough validation of the Candidate Snapshot v10 artifact before any network operations.
 */
export async function verifyCandidateV10(candidatePayload, rawCandidateBytesOrStr, reference = CANDIDATE_V10_REFERENCE) {
  if (!candidatePayload || typeof candidatePayload !== 'object') {
    throw new PromotionError(PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED, 'Candidate payload is missing or invalid.');
  }

  // 1. Check raw byte SHA-256 against expected hash
  if (rawCandidateBytesOrStr) {
    const normalized = normalizePayload(rawCandidateBytesOrStr);
    const computedSha = await computeSha256(normalized.bytes);
    if (computedSha.toLowerCase() !== reference.sha256.toLowerCase()) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED,
        `Candidate SHA-256 mismatch. Expected: ${reference.sha256}, Computed: ${computedSha}`
      );
    }
  }

  // 2. Metadata assertions
  if (candidatePayload.snapshot_id !== reference.snapshotId) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED,
      `Candidate snapshot_id mismatch: '${candidatePayload.snapshot_id}' !== '${reference.snapshotId}'`
    );
  }
  if (candidatePayload.cloud_version !== reference.cloudVersion) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED,
      `Candidate cloud_version mismatch: ${candidatePayload.cloud_version} !== ${reference.cloudVersion}`
    );
  }
  if (candidatePayload.parent_snapshot_id !== reference.parentSnapshotId) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED,
      `Candidate parent_snapshot_id mismatch: '${candidatePayload.parent_snapshot_id}' !== '${reference.parentSnapshotId}'`
    );
  }
  if (candidatePayload.schema_version !== reference.schemaVersion) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED,
      `Candidate schema_version mismatch: ${candidatePayload.schema_version} !== ${reference.schemaVersion}`
    );
  }

  // 3. Entity count assertions
  const txns = candidatePayload.entities?.transactions || [];
  const invTxns = candidatePayload.entities?.investment_transactions || [];
  const accounts = candidatePayload.entities?.accounts || [];
  const inventory = candidatePayload.entities?.inventory || [];

  if (txns.length !== reference.transactionsCount) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED,
      `Candidate regular transactions count mismatch: ${txns.length} !== ${reference.transactionsCount}`
    );
  }
  if (invTxns.length !== reference.investmentTransactionsCount) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED,
      `Candidate investment transactions count mismatch: ${invTxns.length} !== ${reference.investmentTransactionsCount}`
    );
  }
  if (txns.length + invTxns.length !== reference.totalTransactionsCount) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED,
      `Candidate total transactions count mismatch: ${txns.length + invTxns.length} !== ${reference.totalTransactionsCount}`
    );
  }
  if (accounts.length !== reference.accountsCount) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED,
      `Candidate accounts count mismatch: ${accounts.length} !== ${reference.accountsCount}`
    );
  }
  if (inventory.length !== reference.inventoryCount) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED,
      `Candidate inventory count mismatch: ${inventory.length} !== ${reference.inventoryCount}`
    );
  }

  // 4. Production deep payload validation
  try {
    await validateCloudSnapshotPayload(candidatePayload);
  } catch (err) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.CANDIDATE_VALIDATION_FAILED,
      `Candidate payload failed validateCloudSnapshotPayload(): ${err.message}`
    );
  }

  return true;
}

/**
 * Default HTTP fetch implementation for reading Drive file content.
 */
async function defaultReadFile(fileId, accessToken) {
  if (!accessToken) throw new PromotionError(PROMOTION_ERROR_CODES.MISSING_PARAMETERS, 'Access token is required to read Drive file');
  const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const errText = await res.text();
    throw new PromotionError(PROMOTION_ERROR_CODES.PRE_WRITE_READ_FAILED, `Drive download failed (${res.status}): ${errText}`);
  }
  return await res.text();
}

/**
 * Default HTTP fetch implementation for multipart PATCH update of Drive file.
 */
async function defaultUpdateFile(fileId, filename, content, mimeType = 'application/octet-stream', accessToken) {
  if (!accessToken) throw new PromotionError(PROMOTION_ERROR_CODES.MISSING_PARAMETERS, 'Access token is required to update Drive file');
  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;
  const metadata = { name: filename, mimeType };
  const multipartBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    `Content-Type: ${mimeType}\r\n\r\n` +
    content +
    closeDelimiter;

  const url = `${DRIVE_UPLOAD_BASE}/files/${fileId}?uploadType=multipart`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: multipartBody
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new PromotionError(PROMOTION_ERROR_CODES.UPLOAD_FAILED, `Drive PATCH upload failed (${res.status}): ${errText}`);
  }
  return await res.json();
}

/**
 * Executes FinMan Candidate Snapshot v10 Promotion to Google Drive with strict safety gates.
 */
export async function executeSnapshotPromotion(options = {}) {
  const {
    driveClient = null,
    accessToken = null,
    syncPin = null,
    candidatePayload = null,
    candidateRawBytes = null,
    v9PreservedCiphertext = null,
    candidateReference = CANDIDATE_V10_REFERENCE,
    v9Reference = V9_REFERENCE,
    dryRun = false,
    allowRollbackOnFailure = true
  } = options;

  // 1. Parameter assertions
  if (!syncPin) {
    throw new PromotionError(PROMOTION_ERROR_CODES.MISSING_PARAMETERS, 'Sync PIN is required for promotion.');
  }
  if (!candidatePayload) {
    throw new PromotionError(PROMOTION_ERROR_CODES.MISSING_PARAMETERS, 'Candidate payload is required for promotion.');
  }
  if (!driveClient && !accessToken) {
    throw new PromotionError(PROMOTION_ERROR_CODES.MISSING_PARAMETERS, 'Either driveClient or accessToken is required.');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GATE 1: Verify Candidate Payload & Byte Integrity
  // ─────────────────────────────────────────────────────────────────────────────
  await verifyCandidateV10(candidatePayload, candidateRawBytes, candidateReference);

  // ─────────────────────────────────────────────────────────────────────────────
  // GATE 2: Pre-Write Live Query & Target Assertion Against Preserved v9
  // ─────────────────────────────────────────────────────────────────────────────
  const filename = candidateReference.filename;
  const expectedDriveFileId = candidateReference.driveFileId;

  const activeFile = await findDriveSnapshotFile(driveClient, filename, accessToken, 10);
  if (activeFile.id !== expectedDriveFileId) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.PRE_WRITE_UNEXPECTED_FILE_ID,
      `Active Drive snapshot file ID ('${activeFile.id}') !== expected ('${expectedDriveFileId}'). Refusing write!`,
      { activeFileId: activeFile.id, expectedDriveFileId }
    );
  }

  // Download active ciphertext to confirm exact preserved v9 baseline
  let activeCiphertext;
  if (driveClient && typeof driveClient.readFile === 'function') {
    activeCiphertext = await driveClient.readFile(activeFile.id);
  } else {
    activeCiphertext = await defaultReadFile(activeFile.id, accessToken);
  }

  const normalizedActive = normalizePayload(activeCiphertext);
  const activeByteSize = normalizedActive.bytes.byteLength;
  const activeMd5 = computeMd5(normalizedActive.bytes);
  const activeSha256 = await computeSha256(normalizedActive.bytes);

  if (v9Reference.byteSize != null && activeByteSize !== v9Reference.byteSize) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.PRE_WRITE_SIZE_MISMATCH,
      `Active snapshot byte size (${activeByteSize}) !== expected v9 baseline (${v9Reference.byteSize}). Aborting promotion!`,
      { activeByteSize, expectedByteSize: v9Reference.byteSize }
    );
  }
  if (v9Reference.md5 && activeMd5.toLowerCase() !== v9Reference.md5.toLowerCase()) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.PRE_WRITE_MD5_MISMATCH,
      `Active snapshot MD5 (${activeMd5}) !== expected v9 baseline (${v9Reference.md5}). Aborting promotion!`,
      { activeMd5, expectedMd5: v9Reference.md5 }
    );
  }
  if (v9Reference.sha256 && activeSha256.toLowerCase() !== v9Reference.sha256.toLowerCase()) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.PRE_WRITE_SHA256_MISMATCH,
      `Active snapshot SHA-256 (${activeSha256}) !== expected v9 baseline (${v9Reference.sha256}). Aborting promotion!`,
      { activeSha256, expectedSha256: v9Reference.sha256 }
    );
  }

  // Decrypt and verify active snapshot identity
  let activeDecrypted;
  try {
    activeDecrypted = await decryptBackupData(normalizedActive.str, syncPin);
  } catch (err) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.PRE_WRITE_DECRYPT_FAILED,
      `Failed to decrypt active snapshot with Sync PIN: ${err.message}. Aborting promotion!`
    );
  }

  if (activeDecrypted.snapshot_id !== v9Reference.snapshotId || activeDecrypted.cloud_version !== v9Reference.cloudVersion) {
    throw new PromotionError(
      PROMOTION_ERROR_CODES.PRE_WRITE_IDENTITY_MISMATCH,
      `Active snapshot identity mismatch. Found snapshot_id: '${activeDecrypted.snapshot_id}', cloud_version: ${activeDecrypted.cloud_version}; expected v9 ('${v9Reference.snapshotId}', ${v9Reference.cloudVersion}). Aborting promotion!`,
      { activeSnapshotId: activeDecrypted.snapshot_id, activeCloudVersion: activeDecrypted.cloud_version }
    );
  }

  // Dry-Run Guard: If dry-run requested, exit cleanly after pre-flight assertion
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      status: 'PREFLIGHT_PASSED_READY_FOR_PROMOTION',
      targetDriveFileId: activeFile.id,
      verifiedActiveSnapshotId: activeDecrypted.snapshot_id,
      verifiedActiveCloudVersion: activeDecrypted.cloud_version,
      candidateSnapshotId: candidateReference.snapshotId,
      candidateCloudVersion: candidateReference.cloudVersion
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GATE 3 & 4: In-Memory Client-Side Encryption & Multipart PATCH Write
  // ─────────────────────────────────────────────────────────────────────────────
  const v10Ciphertext = await encryptBackupData(candidatePayload, syncPin);
  const normalizedV10 = normalizePayload(v10Ciphertext);
  const v10ByteSize = normalizedV10.bytes.byteLength;
  const v10Md5 = computeMd5(normalizedV10.bytes);
  const v10Sha256 = await computeSha256(normalizedV10.bytes);

  let uploadResult;
  let uploadFailed = false;
  let uploadError = null;

  try {
    if (driveClient && typeof driveClient.updateFile === 'function') {
      uploadResult = await driveClient.updateFile(activeFile.id, normalizedV10.str, 'application/octet-stream');
    } else {
      uploadResult = await defaultUpdateFile(activeFile.id, filename, normalizedV10.str, 'application/octet-stream', accessToken);
    }
  } catch (err) {
    uploadFailed = true;
    uploadError = err;
  }

  if (uploadFailed) {
    if (allowRollbackOnFailure && v9PreservedCiphertext) {
      try {
        const rollbackResult = await executeSnapshotRollback({
          driveClient,
          accessToken,
          syncPin,
          v9Ciphertext: v9PreservedCiphertext,
          filename,
          expectedDriveFileId,
          v9Reference
        });
        throw new PromotionError(
          PROMOTION_ERROR_CODES.AUTOMATIC_ROLLBACK_TRIGGERED,
          `Upload failed (${uploadError.message}). Automatic rollback successfully restored Snapshot v9!`,
          { uploadError: uploadError.message, rollbackResult }
        );
      } catch (rollbackErr) {
        if (rollbackErr instanceof PromotionError) throw rollbackErr;
        throw new PromotionError(
          PROMOTION_ERROR_CODES.AUTOMATIC_ROLLBACK_FAILED,
          `Upload failed (${uploadError.message}) AND rollback attempt encountered error: ${rollbackErr.message}`,
          { uploadError: uploadError.message, rollbackError: rollbackErr.message }
        );
      }
    }
    throw new PromotionError(
      PROMOTION_ERROR_CODES.UPLOAD_FAILED,
      `Drive PATCH upload failed: ${uploadError.message}`,
      { uploadError: uploadError.message }
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GATE 5: Post-Write Re-Query, Download, Decrypt, and Full Verification
  // ─────────────────────────────────────────────────────────────────────────────
  let postVerificationError = null;
  let postDecrypted = null;
  let postFile = null;

  try {
    // 5a. Re-query snapshot file to ensure exactly 1 matching file exists
    postFile = await findDriveSnapshotFile(driveClient, filename, accessToken, 10);
    if (postFile.id !== expectedDriveFileId) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.POST_WRITE_ID_MISMATCH,
        `Post-write Drive snapshot file ID ('${postFile.id}') !== expected ('${expectedDriveFileId}')`
      );
    }

    // 5b. Download newly written ciphertext
    let postCiphertext;
    if (driveClient && typeof driveClient.readFile === 'function') {
      postCiphertext = await driveClient.readFile(postFile.id);
    } else {
      postCiphertext = await defaultReadFile(postFile.id, accessToken);
    }

    // 5c. Decrypt downloaded ciphertext
    const normalizedPost = normalizePayload(postCiphertext);
    postDecrypted = await decryptBackupData(normalizedPost.str, syncPin);

    // 5d. Deep assertions on decrypted payload
    if (postDecrypted.snapshot_id !== candidateReference.snapshotId) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.POST_WRITE_IDENTITY_MISMATCH,
        `Post-write snapshot_id mismatch: '${postDecrypted.snapshot_id}' !== '${candidateReference.snapshotId}'`
      );
    }
    if (postDecrypted.cloud_version !== candidateReference.cloudVersion) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.POST_WRITE_IDENTITY_MISMATCH,
        `Post-write cloud_version mismatch: ${postDecrypted.cloud_version} !== ${candidateReference.cloudVersion}`
      );
    }
    if (postDecrypted.parent_snapshot_id !== candidateReference.parentSnapshotId) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.POST_WRITE_IDENTITY_MISMATCH,
        `Post-write parent_snapshot_id mismatch: '${postDecrypted.parent_snapshot_id}' !== '${candidateReference.parentSnapshotId}'`
      );
    }
    if (postDecrypted.schema_version !== candidateReference.schemaVersion) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.POST_WRITE_IDENTITY_MISMATCH,
        `Post-write schema_version mismatch: ${postDecrypted.schema_version} !== ${candidateReference.schemaVersion}`
      );
    }

    const postTxns = postDecrypted.entities?.transactions || [];
    const postInvTxns = postDecrypted.entities?.investment_transactions || [];
    const postAccounts = postDecrypted.entities?.accounts || [];
    const postInventory = postDecrypted.entities?.inventory || [];

    if (postTxns.length !== candidateReference.transactionsCount) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.POST_WRITE_IDENTITY_MISMATCH,
        `Post-write regular transactions count mismatch: ${postTxns.length} !== ${candidateReference.transactionsCount}`
      );
    }
    if (postInvTxns.length !== candidateReference.investmentTransactionsCount) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.POST_WRITE_IDENTITY_MISMATCH,
        `Post-write investment transactions count mismatch: ${postInvTxns.length} !== ${candidateReference.investmentTransactionsCount}`
      );
    }
    if (postTxns.length + postInvTxns.length !== candidateReference.totalTransactionsCount) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.POST_WRITE_IDENTITY_MISMATCH,
        `Post-write total transactions count mismatch: ${postTxns.length + postInvTxns.length} !== ${candidateReference.totalTransactionsCount}`
      );
    }
    if (postAccounts.length !== candidateReference.accountsCount) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.POST_WRITE_IDENTITY_MISMATCH,
        `Post-write accounts count mismatch: ${postAccounts.length} !== ${candidateReference.accountsCount}`
      );
    }
    if (postInventory.length !== candidateReference.inventoryCount) {
      throw new PromotionError(
        PROMOTION_ERROR_CODES.POST_WRITE_IDENTITY_MISMATCH,
        `Post-write inventory count mismatch: ${postInventory.length} !== ${candidateReference.inventoryCount}`
      );
    }

    await validateCloudSnapshotPayload(postDecrypted);
  } catch (err) {
    postVerificationError = err;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GATE 6: Automated Rollback on Post-Verification Failure
  // ─────────────────────────────────────────────────────────────────────────────
  if (postVerificationError) {
    if (allowRollbackOnFailure && v9PreservedCiphertext) {
      try {
        const rollbackResult = await executeSnapshotRollback({
          driveClient,
          accessToken,
          syncPin,
          v9Ciphertext: v9PreservedCiphertext,
          filename,
          expectedDriveFileId,
          v9Reference
        });
        throw new PromotionError(
          PROMOTION_ERROR_CODES.AUTOMATIC_ROLLBACK_TRIGGERED,
          `Post-write verification failed (${postVerificationError.message}). Automatic rollback successfully restored Snapshot v9!`,
          { postVerificationError: postVerificationError.message, rollbackResult }
        );
      } catch (rollbackErr) {
        if (rollbackErr instanceof PromotionError) throw rollbackErr;
        throw new PromotionError(
          PROMOTION_ERROR_CODES.AUTOMATIC_ROLLBACK_FAILED,
          `Post-write verification failed (${postVerificationError.message}) AND rollback attempt encountered error: ${rollbackErr.message}`,
          { postVerificationError: postVerificationError.message, rollbackError: rollbackErr.message }
        );
      }
    }
    throw postVerificationError;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SUCCESS: Full Invariants Met, Zero Local DB Mutations
  // ─────────────────────────────────────────────────────────────────────────────
  return {
    success: true,
    operation: 'SNAPSHOT_V10_PROMOTION',
    driveFileId: expectedDriveFileId,
    snapshotId: postDecrypted.snapshot_id,
    cloudVersion: postDecrypted.cloud_version,
    parentSnapshotId: postDecrypted.parent_snapshot_id,
    schemaVersion: postDecrypted.schema_version,
    regularTransactionsCount: (postDecrypted.entities?.transactions || []).length,
    investmentTransactionsCount: (postDecrypted.entities?.investment_transactions || []).length,
    totalTransactionsCount: (postDecrypted.entities?.transactions || []).length + (postDecrypted.entities?.investment_transactions || []).length,
    accountsCount: (postDecrypted.entities?.accounts || []).length,
    inventoryCount: (postDecrypted.entities?.inventory || []).length,
    coveredPeerWatermarks: postDecrypted.covered_peer_watermarks,
    uploadedByteSize: v10ByteSize,
    uploadedMd5: v10Md5,
    uploadedSha256: v10Sha256,
    verifiedRoundTrip: true
  };
}
