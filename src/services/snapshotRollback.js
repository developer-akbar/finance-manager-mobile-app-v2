/**
 * snapshotRollback.js — Production Rollback Safety Tooling for Snapshot v10 Promotion
 * 
 * Safely restores preserved Snapshot v9 ciphertext back to Google Drive ONLY IF
 * a Snapshot v10 promotion has been executed and failed verification.
 * 
 * STRICT INVARIANTS:
 * 1. Zero Writes without Positive Identification: The active cloud file MUST be
 *    positively identified as the failed candidate v10 upload.
 * 2. Duplicate Detection: Queries Drive with pageSize >= 10 and fails closed if
 *    files.length !== 1.
 * 3. File ID Match: Fails closed if active file ID !== expectedDriveFileId.
 * 4. Preserved Ciphertext Fidelity: Restores exact raw v9 bytes without re-encryption.
 * 5. Full Post-Verification: Re-downloads the written file and verifies byteSize,
 *    MD5, SHA-256, and decrypted snapshot identity (v9, snap_1790963722004_bq5y93).
 */

import { decryptBackupData } from '../utils/cryptoBackup.js';

export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export const V9_REFERENCE = {
  filename: 'finman_cloud_sync_snapshot.finman',
  driveFileId: '1TZKKamd_pLWt6A9HaxMWPKtUv-66GhT7GJZosePORhHy0cU6_sk',
  byteSize: 35732401,
  md5: 'ce04d4a60c8be295a9afa63e7aec0f60',
  sha256: '1c952406124a9b208248932e372f1cde0f19baba994f637b7667ecf9799d7e6d',
  snapshotId: 'snap_1790963722004_bq5y93',
  cloudVersion: 9,
  parentSnapshotId: 'snap_1790493064581_jbhnf8'
};

export const FAILED_CANDIDATE_V10_REFERENCE = {
  snapshotId: 'snap_1791810470667_candidate_v10',
  cloudVersion: 10,
  parentSnapshotId: 'snap_1790963722004_bq5y93'
};

export const ROLLBACK_ERROR_CODES = {
  MISSING_PARAMETERS: 'MISSING_PARAMETERS',
  INVALID_LOCAL_REFERENCE: 'INVALID_LOCAL_REFERENCE',
  DRIVE_QUERY_FAILED: 'DRIVE_QUERY_FAILED',
  NO_SNAPSHOT_FOUND: 'NO_SNAPSHOT_FOUND',
  DUPLICATE_SNAPSHOTS_FOUND: 'DUPLICATE_SNAPSHOTS_FOUND',
  UNEXPECTED_FILE_ID: 'UNEXPECTED_FILE_ID',
  ACTIVE_READ_FAILED: 'ACTIVE_READ_FAILED',
  ACTIVE_NOT_FAILED_CANDIDATE: 'ACTIVE_NOT_FAILED_CANDIDATE',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  POST_VERIFICATION_QUERY_FAILED: 'POST_VERIFICATION_QUERY_FAILED',
  POST_VERIFICATION_DUPLICATES: 'POST_VERIFICATION_DUPLICATES',
  POST_VERIFICATION_ID_MISMATCH: 'POST_VERIFICATION_ID_MISMATCH',
  POST_VERIFICATION_SIZE_MISMATCH: 'POST_VERIFICATION_SIZE_MISMATCH',
  POST_VERIFICATION_MD5_MISMATCH: 'POST_VERIFICATION_MD5_MISMATCH',
  POST_VERIFICATION_SHA256_MISMATCH: 'POST_VERIFICATION_SHA256_MISMATCH',
  POST_VERIFICATION_DECRYPT_FAILED: 'POST_VERIFICATION_DECRYPT_FAILED',
  POST_VERIFICATION_IDENTITY_MISMATCH: 'POST_VERIFICATION_IDENTITY_MISMATCH'
};

export class RollbackError extends Error {
  constructor(code, message, details = {}) {
    super(`[ROLLBACK_${code}] ${message}`);
    this.name = 'RollbackError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Pure RFC 1321 JS MD5 implementation for portable browser/node hash computation.
 */
export function computeMd5(data) {
  let bytes;
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw new RollbackError(ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE, 'Unsupported data type for MD5 computation');
  }

  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function bitRol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

  const nwords = ((bytes.length + 8) >> 6) + 1;
  const x = new Array(nwords * 16).fill(0);
  for (let i = 0; i < bytes.length; i++) x[i >> 2] |= bytes[i] << ((i % 4) * 8);
  x[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  x[nwords * 16 - 2] = (bytes.length * 8) >>> 0;
  x[nwords * 16 - 1] = Math.floor(bytes.length / 0x20000000);

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const olda = a, oldb = b, oldc = c, oldd = d;
    a = md5ff(a, b, c, d, x[i], 7, -680876936); d = md5ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = md5ff(c, d, a, b, x[i + 2], 17, 606105819); b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = md5ff(a, b, c, d, x[i + 4], 7, -176418897); d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341); b = md5ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416); d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = md5ff(c, d, a, b, x[i + 10], 17, -42063); b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682); d = md5ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290); b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329);

    a = md5gg(a, b, c, d, x[i + 1], 5, -165796510); d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = md5gg(c, d, a, b, x[i + 11], 14, 643717713); b = md5gg(b, c, d, a, x[i], 20, -373897302);
    a = md5gg(a, b, c, d, x[i + 5], 5, -701558691); d = md5gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = md5gg(c, d, a, b, x[i + 15], 14, -660478335); b = md5gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = md5gg(a, b, c, d, x[i + 9], 5, 568446438); d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = md5gg(c, d, a, b, x[i + 3], 14, -187363961); b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467); d = md5gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473); b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734);

    a = md5hh(a, b, c, d, x[i + 5], 4, -378558); d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562); b = md5hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060); d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = md5hh(c, d, a, b, x[i + 7], 16, -155497632); b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = md5hh(a, b, c, d, x[i + 13], 4, 681279174); d = md5hh(d, a, b, c, x[i], 11, -358537222);
    c = md5hh(c, d, a, b, x[i + 3], 16, -722521979); b = md5hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = md5hh(a, b, c, d, x[i + 9], 4, -640364487); d = md5hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = md5hh(c, d, a, b, x[i + 15], 16, 530742520); b = md5hh(b, c, d, a, x[i + 2], 23, -995338651);

    a = md5ii(a, b, c, d, x[i], 6, -198630844); d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905); b = md5ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571); d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = md5ii(c, d, a, b, x[i + 10], 15, -1051523); b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359); d = md5ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380); b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = md5ii(a, b, c, d, x[i + 4], 6, -145523070); d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = md5ii(c, d, a, b, x[i + 2], 15, 718787259); b = md5ii(b, c, d, a, x[i + 9], 21, -343485551);

    a = safeAdd(a, olda); b = safeAdd(b, oldb); c = safeAdd(c, oldc); d = safeAdd(d, oldd);
  }

  function rhex(n) {
    let s = '', j = 0;
    for (; j <= 3; j++) s += ((n >> (j * 8 + 4)) & 0x0f).toString(16) + ((n >> (j * 8)) & 0x0f).toString(16);
    return s;
  }
  return (rhex(a) + rhex(b) + rhex(c) + rhex(d)).toLowerCase();
}

/**
 * Standard SHA-256 calculation via Web Crypto API.
 */
export async function computeSha256(data) {
  let bytes;
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw new RollbackError(ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE, 'Unsupported data type for SHA-256 computation');
  }

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  throw new RollbackError(ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE, 'Web Crypto API crypto.subtle is required for SHA-256');
}

/**
 * Convert input payload to standard string and Uint8Array bytes.
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
  throw new RollbackError(ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE, 'Ciphertext must be a string, Uint8Array, or Buffer');
}

/**
 * Default HTTP fetch implementation for finding Drive files.
 */
async function defaultFindFiles(filename, accessToken, pageSize = 10) {
  if (!accessToken) throw new RollbackError(ROLLBACK_ERROR_CODES.MISSING_PARAMETERS, 'Access token is required for Drive queries');
  const query = encodeURIComponent(`name = '${filename}' and trashed = false`);
  const url = `${DRIVE_API_BASE}/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime,size,version,md5Checksum)&pageSize=${pageSize}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const errText = await res.text();
    throw new RollbackError(ROLLBACK_ERROR_CODES.DRIVE_QUERY_FAILED, `Drive API error (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return data.files || [];
}

/**
 * Default HTTP fetch implementation for reading Drive file content.
 */
async function defaultReadFile(fileId, accessToken) {
  if (!accessToken) throw new RollbackError(ROLLBACK_ERROR_CODES.MISSING_PARAMETERS, 'Access token is required to read Drive file');
  const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const errText = await res.text();
    throw new RollbackError(ROLLBACK_ERROR_CODES.ACTIVE_READ_FAILED, `Drive download failed (${res.status}): ${errText}`);
  }
  return await res.text();
}

/**
 * Default HTTP fetch implementation for multipart PATCH update of Drive file.
 */
async function defaultUpdateFile(fileId, filename, content, mimeType = 'application/octet-stream', accessToken) {
  if (!accessToken) throw new RollbackError(ROLLBACK_ERROR_CODES.MISSING_PARAMETERS, 'Access token is required to update Drive file');
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
    throw new RollbackError(ROLLBACK_ERROR_CODES.UPLOAD_FAILED, `Drive PATCH upload failed (${res.status}): ${errText}`);
  }
  return await res.json();
}

/**
 * Verify local preserved v9 reference integrity before interacting with Drive.
 */
export async function verifyPreservedV9Reference(v9Ciphertext, reference = V9_REFERENCE, syncPin = null) {
  const { str, bytes } = normalizePayload(v9Ciphertext);
  const byteSize = bytes.byteLength;
  const md5 = computeMd5(bytes);
  const sha256 = await computeSha256(bytes);

  if (reference.byteSize != null && byteSize !== reference.byteSize) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE,
      `Local preserved v9 byte size (${byteSize}) does not match expected reference (${reference.byteSize}).`
    );
  }

  if (reference.md5 && md5.toLowerCase() !== reference.md5.toLowerCase()) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE,
      `Local preserved v9 MD5 (${md5}) does not match expected reference (${reference.md5}).`
    );
  }

  if (reference.sha256 && sha256.toLowerCase() !== reference.sha256.toLowerCase()) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE,
      `Local preserved v9 SHA-256 (${sha256}) does not match expected reference (${reference.sha256}).`
    );
  }

  let decrypted = null;
  if (syncPin) {
    try {
      decrypted = await decryptBackupData(str, syncPin);
    } catch (err) {
      throw new RollbackError(
        ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE,
        `Local preserved v9 ciphertext failed decryption with provided PIN: ${err.message}`
      );
    }

    if (reference.snapshotId && decrypted.snapshot_id !== reference.snapshotId) {
      throw new RollbackError(
        ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE,
        `Local preserved v9 decrypted snapshot_id ('${decrypted.snapshot_id}') does not match expected '${reference.snapshotId}'.`
      );
    }

    if (reference.cloudVersion != null && decrypted.cloud_version !== reference.cloudVersion) {
      throw new RollbackError(
        ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE,
        `Local preserved v9 decrypted cloud_version (${decrypted.cloud_version}) does not match expected ${reference.cloudVersion}.`
      );
    }
  }

  return { byteSize, md5, sha256, decrypted };
}

/**
 * Query Drive snapshot files and enforce exact single-file invariant with duplicate detection.
 */
export async function findDriveSnapshotFile(driveClient, filename, accessToken, pageSize = 10) {
  let files;
  if (driveClient && typeof driveClient.findFiles === 'function') {
    files = await driveClient.findFiles({ name: filename, pageSize, fields: 'files(id,name,modifiedTime,size,version,md5Checksum)' });
  } else {
    files = await defaultFindFiles(filename, accessToken, pageSize);
  }

  if (!Array.isArray(files) || files.length === 0) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.NO_SNAPSHOT_FOUND,
      `No snapshot file named '${filename}' found in Google Drive appDataFolder.`
    );
  }

  if (files.length > 1) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.DUPLICATE_SNAPSHOTS_FOUND,
      `Multiple matching snapshot files found (${files.length}) in Google Drive. Refusing write to prevent ambiguous state.`,
      { files }
    );
  }

  return files[0];
}

/**
 * Execute Snapshot Rollback: Restores preserved v9 ciphertext back to Google Drive.
 * 
 * Fails closed on any ambiguity or validation failure.
 */
export async function executeSnapshotRollback(options = {}) {
  const {
    driveClient = null,
    accessToken = null,
    syncPin = null,
    v9Ciphertext = null,
    filename = V9_REFERENCE.filename,
    expectedDriveFileId = V9_REFERENCE.driveFileId,
    v9Reference = V9_REFERENCE,
    failedCandidateReference = FAILED_CANDIDATE_V10_REFERENCE,
    dryRun = false
  } = options;

  // 1. Validate Required Parameters
  if (!syncPin) {
    throw new RollbackError(ROLLBACK_ERROR_CODES.MISSING_PARAMETERS, 'Sync PIN is required for snapshot identification.');
  }
  if (!v9Ciphertext) {
    throw new RollbackError(ROLLBACK_ERROR_CODES.MISSING_PARAMETERS, 'Preserved v9 ciphertext payload is required.');
  }
  if (!driveClient && !accessToken) {
    throw new RollbackError(ROLLBACK_ERROR_CODES.MISSING_PARAMETERS, 'Either driveClient or accessToken is required.');
  }

  // 2. Pre-Flight Verification of Local Preserved v9 Reference
  const normalizedV9 = normalizePayload(v9Ciphertext);
  await verifyPreservedV9Reference(normalizedV9.bytes, v9Reference, syncPin);

  // 3. Pre-Flight Drive Query with Duplicate Detection (pageSize >= 10)
  const activeFile = await findDriveSnapshotFile(driveClient, filename, accessToken, 10);

  // 4. File ID Verification
  if (activeFile.id !== expectedDriveFileId) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.UNEXPECTED_FILE_ID,
      `Active Drive snapshot file ID ('${activeFile.id}') does not match expected ID ('${expectedDriveFileId}').`,
      { activeFileId: activeFile.id, expectedDriveFileId }
    );
  }

  // 5. Positive Identification of Active Content as the Failed Candidate v10
  let activeCiphertext;
  if (driveClient && typeof driveClient.readFile === 'function') {
    activeCiphertext = await driveClient.readFile(activeFile.id);
  } else {
    activeCiphertext = await defaultReadFile(activeFile.id, accessToken);
  }

  const normalizedActive = normalizePayload(activeCiphertext);
  let activeDecrypted;
  try {
    activeDecrypted = await decryptBackupData(normalizedActive.str, syncPin);
  } catch (err) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.ACTIVE_NOT_FAILED_CANDIDATE,
      `Active Drive snapshot ciphertext could not be decrypted with sync PIN; cannot positively verify as failed v10 upload: ${err.message}`
    );
  }

  if (
    activeDecrypted.snapshot_id !== failedCandidateReference.snapshotId ||
    activeDecrypted.cloud_version !== failedCandidateReference.cloudVersion
  ) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.ACTIVE_NOT_FAILED_CANDIDATE,
      `Active Drive snapshot is NOT the failed candidate v10 upload. Found snapshot_id: '${activeDecrypted.snapshot_id}', cloud_version: ${activeDecrypted.cloud_version}; expected snapshot_id: '${failedCandidateReference.snapshotId}', cloud_version: ${failedCandidateReference.cloudVersion}. Rollback aborted to prevent overwriting unrelated state!`,
      { activeSnapshotId: activeDecrypted.snapshot_id, activeCloudVersion: activeDecrypted.cloud_version }
    );
  }

  // If dry-run requested, exit cleanly after all pre-flight guards have passed
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      status: 'READY_FOR_ROLLBACK',
      activeDriveFileId: activeFile.id,
      verifiedActiveSnapshotId: activeDecrypted.snapshot_id,
      verifiedActiveCloudVersion: activeDecrypted.cloud_version,
      targetV9SnapshotId: v9Reference.snapshotId,
      targetV9CloudVersion: v9Reference.cloudVersion
    };
  }

  // 6. Upload the Exact Preserved v9 Ciphertext Without Re-Encryption (Multipart PATCH)
  let uploadResult;
  if (driveClient && typeof driveClient.updateFile === 'function') {
    uploadResult = await driveClient.updateFile(activeFile.id, normalizedV9.str, 'application/octet-stream');
  } else {
    uploadResult = await defaultUpdateFile(activeFile.id, filename, normalizedV9.str, 'application/octet-stream', accessToken);
  }

  // 7. Post-Upload Verification (Read-Back & Complete Cryptographic Assertion)
  // 7a. Re-query files to ensure still exactly 1 file
  let postFiles;
  if (driveClient && typeof driveClient.findFiles === 'function') {
    postFiles = await driveClient.findFiles({ name: filename, pageSize: 10, fields: 'files(id,name,modifiedTime,size,version,md5Checksum)' });
  } else {
    postFiles = await defaultFindFiles(filename, accessToken, 10);
  }

  if (!Array.isArray(postFiles) || postFiles.length === 0) {
    throw new RollbackError(ROLLBACK_ERROR_CODES.NO_SNAPSHOT_FOUND, 'Post-rollback query: snapshot disappeared from Drive.');
  }
  if (postFiles.length > 1) {
    throw new RollbackError(ROLLBACK_ERROR_CODES.POST_VERIFICATION_DUPLICATES, 'Post-rollback query: multiple snapshot files detected.');
  }

  const postFile = postFiles[0];
  if (postFile.id !== expectedDriveFileId) {
    throw new RollbackError(ROLLBACK_ERROR_CODES.POST_VERIFICATION_ID_MISMATCH, `Post-rollback file ID '${postFile.id}' !== expected '${expectedDriveFileId}'.`);
  }

  // Check Drive metadata if available
  if (postFile.size != null && v9Reference.byteSize != null && Number(postFile.size) !== v9Reference.byteSize) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.POST_VERIFICATION_SIZE_MISMATCH,
      `Post-rollback Drive metadata size (${postFile.size}) does not match expected (${v9Reference.byteSize}).`
    );
  }
  if (postFile.md5Checksum && v9Reference.md5 && postFile.md5Checksum.toLowerCase() !== v9Reference.md5.toLowerCase()) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.POST_VERIFICATION_MD5_MISMATCH,
      `Post-rollback Drive metadata MD5 (${postFile.md5Checksum}) does not match expected (${v9Reference.md5}).`
    );
  }

  // 7b. Re-download actual bytes from Drive
  let downloadedCiphertext;
  if (driveClient && typeof driveClient.readFile === 'function') {
    downloadedCiphertext = await driveClient.readFile(activeFile.id);
  } else {
    downloadedCiphertext = await defaultReadFile(activeFile.id, accessToken);
  }

  const normalizedDownloaded = normalizePayload(downloadedCiphertext);
  const downloadedByteSize = normalizedDownloaded.bytes.byteLength;
  const downloadedMd5 = computeMd5(normalizedDownloaded.bytes);
  const downloadedSha256 = await computeSha256(normalizedDownloaded.bytes);

  if (v9Reference.byteSize != null && downloadedByteSize !== v9Reference.byteSize) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.POST_VERIFICATION_SIZE_MISMATCH,
      `Post-rollback re-downloaded byte size (${downloadedByteSize}) does not match expected reference (${v9Reference.byteSize}).`
    );
  }

  if (v9Reference.md5 && downloadedMd5.toLowerCase() !== v9Reference.md5.toLowerCase()) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.POST_VERIFICATION_MD5_MISMATCH,
      `Post-rollback re-downloaded MD5 (${downloadedMd5}) does not match expected reference (${v9Reference.md5}).`
    );
  }

  if (v9Reference.sha256 && downloadedSha256.toLowerCase() !== v9Reference.sha256.toLowerCase()) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.POST_VERIFICATION_SHA256_MISMATCH,
      `Post-rollback re-downloaded SHA-256 (${downloadedSha256}) does not match expected reference (${v9Reference.sha256}).`
    );
  }

  // 7c. Decrypt and verify snapshot identity
  let downloadedDecrypted;
  try {
    downloadedDecrypted = await decryptBackupData(normalizedDownloaded.str, syncPin);
  } catch (err) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.POST_VERIFICATION_DECRYPT_FAILED,
      `Post-rollback re-downloaded snapshot failed decryption: ${err.message}`
    );
  }

  if (v9Reference.snapshotId && downloadedDecrypted.snapshot_id !== v9Reference.snapshotId) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.POST_VERIFICATION_IDENTITY_MISMATCH,
      `Post-rollback decrypted snapshot_id ('${downloadedDecrypted.snapshot_id}') does not match expected '${v9Reference.snapshotId}'.`
    );
  }

  if (v9Reference.cloudVersion != null && downloadedDecrypted.cloud_version !== v9Reference.cloudVersion) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.POST_VERIFICATION_IDENTITY_MISMATCH,
      `Post-rollback decrypted cloud_version (${downloadedDecrypted.cloud_version}) does not match expected ${v9Reference.cloudVersion}.`
    );
  }

  if (v9Reference.parentSnapshotId && downloadedDecrypted.parent_snapshot_id !== v9Reference.parentSnapshotId) {
    throw new RollbackError(
      ROLLBACK_ERROR_CODES.POST_VERIFICATION_IDENTITY_MISMATCH,
      `Post-rollback decrypted parent_snapshot_id ('${downloadedDecrypted.parent_snapshot_id}') does not match expected '${v9Reference.parentSnapshotId}'.`
    );
  }

  // 8. Success Output
  return {
    success: true,
    status: 'ROLLBACK_SUCCESSFUL',
    restoredDriveFileId: activeFile.id,
    restoredSnapshotId: downloadedDecrypted.snapshot_id,
    restoredCloudVersion: downloadedDecrypted.cloud_version,
    restoredParentSnapshotId: downloadedDecrypted.parent_snapshot_id,
    verifiedByteSize: downloadedByteSize,
    verifiedMd5: downloadedMd5,
    verifiedSha256: downloadedSha256
  };
}
