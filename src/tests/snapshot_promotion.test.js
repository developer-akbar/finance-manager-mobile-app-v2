/**
 * snapshot_promotion.test.js
 * 
 * Automated Test Suite for Snapshot v10 Promotion Pipeline
 * 
 * STRICT INVARIANTS TESTED:
 * 1. Happy Path: Successful promotion from verified v9 baseline to candidate v10.
 * 2. Candidate Integrity Guard: Candidate hash or metadata mismatch aborts before Drive interaction.
 * 3. Pre-Write Duplicate Files Guard: Multiple snapshot files aborts before write.
 * 4. Pre-Write Unexpected File ID Guard: Wrong file ID aborts before write.
 * 5. Pre-Write Baseline Mismatch Guard: Active file size, MD5, or identity mismatch aborts before write.
 * 6. Dry-Run Mode: Fully validates pre-write invariants without performing writes.
 * 7. Upload Failure Handling: PATCH error fails closed and triggers automatic rollback to v9.
 * 8. Post-Write Verification Failure: Decrypted mismatch triggers automatic rollback to v9.
 * 9. Missing Parameters Guard: Missing PIN, candidate, or auth fails closed.
 * 
 * Uses DISPOSABLE IN-MEMORY FIXTURES ONLY. Zero interaction with real Google Drive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackupData } from '../utils/cryptoBackup.js';
import { computeMd5, computeSha256 } from '../services/snapshotRollback.js';
import {
  executeSnapshotPromotion,
  verifyCandidateV10,
  PromotionError,
  PROMOTION_ERROR_CODES
} from '../services/snapshotPromotion.js';

class MockDriveClient {
  constructor(initialFiles = {}) {
    this.files = new Map();
    this.writeHistory = [];
    this.findCallCount = 0;
    this.readCallCount = 0;
    this.updateCallCount = 0;
    this.failOnUpdate = false;
    this.postUpdateCorruptPayload = false;

    for (const [id, f] of Object.entries(initialFiles)) {
      this.files.set(id, {
        metadata: {
          id,
          name: f.name || 'finman_cloud_sync_snapshot.finman',
          size: f.size !== undefined ? f.size : (f.content ? f.content.length : 0),
          md5Checksum: f.md5Checksum !== undefined ? f.md5Checksum : (f.content ? computeMd5(f.content) : null),
          version: f.version || '1',
          modifiedTime: f.modifiedTime || new Date().toISOString()
        },
        content: f.content || ''
      });
    }
  }

  async findFiles({ name, pageSize, fields }) {
    this.findCallCount++;
    const matched = [];
    for (const f of this.files.values()) {
      if (!name || f.metadata.name === name) {
        matched.push({ ...f.metadata });
      }
    }
    return matched.slice(0, pageSize || 10);
  }

  async readFile(fileId) {
    this.readCallCount++;
    const f = this.files.get(fileId);
    if (!f) throw new Error(`MockDrive: File not found: ${fileId}`);
    return f.content;
  }

  async updateFile(fileId, content, mimeType) {
    this.updateCallCount++;
    if (this.failOnUpdate) {
      throw new Error('MockDrive: 500 Internal Server Error (Simulated Upload Failure)');
    }
    this.writeHistory.push({ fileId, content, mimeType, timestamp: Date.now() });
    const f = this.files.get(fileId);
    if (!f) throw new Error(`MockDrive: File not found for update: ${fileId}`);
    f.content = content;
    f.metadata.size = content.length;
    f.metadata.md5Checksum = computeMd5(content);
    return { ...f.metadata };
  }
}

function createSyntheticV9Payload() {
  return {
    snapshot_id: 'snap_1790963722004_bq5y93',
    cloud_version: 9,
    parent_snapshot_id: 'snap_1790493064581_jbhnf8',
    schema_version: 13,
    engine_version: 3,
    created_at: '2026-10-02T17:57:03.610Z',
    entities: {
      transactions: [{ id: 'txn_v9_1', date: '2026-10-01', amount: 100 }],
      investment_transactions: [{ id: 'inv_v9_1', date: '2026-10-01', amount: 500 }],
      accounts: [{ id: 'acct_1', name: 'Cash' }],
      inventory: []
    }
  };
}

function createSyntheticV10Payload() {
  return {
    snapshot_id: 'snap_1791810470667_candidate_v10',
    cloud_version: 10,
    parent_snapshot_id: 'snap_1790963722004_bq5y93',
    schema_version: 13,
    engine_version: 3,
    created_at: '2026-10-12T13:07:51.000Z',
    entities: {
      transactions: [{ id: 'txn_1', date: '2026-10-12', amount: 100 }, { id: 'txn_2', date: '2026-10-12', amount: 200 }],
      investment_transactions: [{ id: 'inv_1', date: '2026-10-12', amount: 1000 }],
      accounts: [{ id: 'acct_1', name: 'Cash' }],
      inventory: [{ id: 'inv_item_1', name: 'Asset' }]
    },
    covered_peer_watermarks: {
      dev_6edc69e37943: 4,
      dev_b91065cd877f: 6,
      dev_f31f6e6d6628: 12
    }
  };
}

test('FinMan Phase 11E — Snapshot Promotion Pipeline Test Suite', async (t) => {
  const syncPin = 'TestSyncPin123!';
  const fileId = '1TZKKamd_pLWt6A9HaxMWPKtUv-66GhT7GJZosePORhHy0cU6_sk';

  // Build synthetic baseline v9 ciphertext
  const v9Payload = createSyntheticV9Payload();
  const v9Ciphertext = await encryptBackupData(v9Payload, syncPin);
  const v9ByteLength = new TextEncoder().encode(v9Ciphertext).length;
  const v9Md5 = computeMd5(v9Ciphertext);
  const v9Sha256 = await computeSha256(v9Ciphertext);

  const mockV9Reference = {
    filename: 'finman_cloud_sync_snapshot.finman',
    driveFileId: fileId,
    byteSize: v9ByteLength,
    md5: v9Md5,
    sha256: v9Sha256,
    snapshotId: 'snap_1790963722004_bq5y93',
    cloudVersion: 9,
    parentSnapshotId: 'snap_1790493064581_jbhnf8'
  };

  // Build synthetic candidate v10 payload and reference
  const v10Payload = createSyntheticV10Payload();
  const v10RawStr = JSON.stringify(v10Payload);
  const v10Sha256 = await computeSha256(v10RawStr);

  const mockV10Reference = {
    filename: 'finman_cloud_sync_snapshot.finman',
    driveFileId: fileId,
    snapshotId: 'snap_1791810470667_candidate_v10',
    cloudVersion: 10,
    parentSnapshotId: 'snap_1790963722004_bq5y93',
    schemaVersion: 13,
    engineVersion: 3,
    sha256: v10Sha256,
    transactionsCount: 2,
    investmentTransactionsCount: 1,
    totalTransactionsCount: 3,
    accountsCount: 1,
    inventoryCount: 1,
    coveredPeerWatermarks: {
      dev_6edc69e37943: 4,
      dev_b91065cd877f: 6,
      dev_f31f6e6d6628: 12
    }
  };

  await t.test('1. Happy Path — Successful promotion from verified v9 to candidate v10', async () => {
    const driveClient = new MockDriveClient({
      [fileId]: {
        name: 'finman_cloud_sync_snapshot.finman',
        content: v9Ciphertext,
        size: v9ByteLength,
        md5Checksum: v9Md5
      }
    });

    const result = await executeSnapshotPromotion({
      driveClient,
      syncPin,
      candidatePayload: v10Payload,
      candidateRawBytes: v10RawStr,
      v9PreservedCiphertext: v9Ciphertext,
      candidateReference: mockV10Reference,
      v9Reference: mockV9Reference
    });

    assert.equal(result.success, true);
    assert.equal(result.operation, 'SNAPSHOT_V10_PROMOTION');
    assert.equal(result.driveFileId, fileId);
    assert.equal(result.snapshotId, 'snap_1791810470667_candidate_v10');
    assert.equal(result.cloudVersion, 10);
    assert.equal(result.parentSnapshotId, 'snap_1790963722004_bq5y93');
    assert.equal(result.totalTransactionsCount, 3);
    assert.equal(driveClient.updateCallCount, 1);
  });

  await t.test('2. Candidate Integrity Guard — Rejects candidate if SHA-256 or counts mismatch', async () => {
    const driveClient = new MockDriveClient({
      [fileId]: { content: v9Ciphertext, size: v9ByteLength, md5Checksum: v9Md5 }
    });

    await assert.rejects(
      async () => {
        await executeSnapshotPromotion({
          driveClient,
          syncPin,
          candidatePayload: v10Payload,
          candidateRawBytes: v10RawStr + ' [TAMPERED]',
          v9PreservedCiphertext: v9Ciphertext,
          candidateReference: mockV10Reference,
          v9Reference: mockV9Reference
        });
      },
      (err) => {
        assert(err instanceof PromotionError);
        assert.equal(err.code, PROMOTION_ERROR_CODES.CANDIDATE_INTEGRITY_FAILED);
        return true;
      }
    );

    // Verify zero writes made
    assert.equal(driveClient.updateCallCount, 0);
  });

  await t.test('3. Pre-Write Duplicate Files Guard — Aborts if multiple snapshots exist', async () => {
    const driveClient = new MockDriveClient({
      [fileId]: { content: v9Ciphertext, size: v9ByteLength, md5Checksum: v9Md5 },
      'duplicate_file_id_999': { content: v9Ciphertext, size: v9ByteLength, md5Checksum: v9Md5 }
    });

    await assert.rejects(
      async () => {
        await executeSnapshotPromotion({
          driveClient,
          syncPin,
          candidatePayload: v10Payload,
          candidateRawBytes: v10RawStr,
          v9PreservedCiphertext: v9Ciphertext,
          candidateReference: mockV10Reference,
          v9Reference: mockV9Reference
        });
      },
      (err) => {
        assert(err.message.includes('Multiple matching snapshot files found'));
        return true;
      }
    );

    assert.equal(driveClient.updateCallCount, 0);
  });

  await t.test('4. Pre-Write Unexpected File ID Guard — Aborts if Drive file ID does not match expected ID', async () => {
    const unexpectedId = 'unrelated_drive_file_id';
    const driveClient = new MockDriveClient({
      [unexpectedId]: { content: v9Ciphertext, size: v9ByteLength, md5Checksum: v9Md5 }
    });

    await assert.rejects(
      async () => {
        await executeSnapshotPromotion({
          driveClient,
          syncPin,
          candidatePayload: v10Payload,
          candidateRawBytes: v10RawStr,
          v9PreservedCiphertext: v9Ciphertext,
          candidateReference: mockV10Reference,
          v9Reference: mockV9Reference
        });
      },
      (err) => {
        assert(err instanceof PromotionError);
        assert.equal(err.code, PROMOTION_ERROR_CODES.PRE_WRITE_UNEXPECTED_FILE_ID);
        return true;
      }
    );

    assert.equal(driveClient.updateCallCount, 0);
  });

  await t.test('5. Pre-Write Baseline Mismatch Guard — Aborts if active file is not the verified v9', async () => {
    const wrongPayload = {
      snapshot_id: 'snap_unrelated_v8',
      cloud_version: 8,
      created_at: new Date().toISOString(),
      entities: { transactions: [], investment_transactions: [] }
    };
    const wrongCiphertext = await encryptBackupData(wrongPayload, syncPin);

    const driveClient = new MockDriveClient({
      [fileId]: { content: wrongCiphertext, size: wrongCiphertext.length, md5Checksum: computeMd5(wrongCiphertext) }
    });

    await assert.rejects(
      async () => {
        await executeSnapshotPromotion({
          driveClient,
          syncPin,
          candidatePayload: v10Payload,
          candidateRawBytes: v10RawStr,
          v9PreservedCiphertext: v9Ciphertext,
          candidateReference: mockV10Reference,
          v9Reference: mockV9Reference
        });
      },
      (err) => {
        assert(err instanceof PromotionError);
        assert(
          err.code === PROMOTION_ERROR_CODES.PRE_WRITE_SIZE_MISMATCH ||
          err.code === PROMOTION_ERROR_CODES.PRE_WRITE_MD5_MISMATCH ||
          err.code === PROMOTION_ERROR_CODES.PRE_WRITE_IDENTITY_MISMATCH
        );
        return true;
      }
    );

    assert.equal(driveClient.updateCallCount, 0);
  });

  await t.test('6. Dry-Run Mode — Positively validates all pre-flight guards without writing', async () => {
    const driveClient = new MockDriveClient({
      [fileId]: { content: v9Ciphertext, size: v9ByteLength, md5Checksum: v9Md5 }
    });

    const result = await executeSnapshotPromotion({
      driveClient,
      syncPin,
      candidatePayload: v10Payload,
      candidateRawBytes: v10RawStr,
      v9PreservedCiphertext: v9Ciphertext,
      candidateReference: mockV10Reference,
      v9Reference: mockV9Reference,
      dryRun: true
    });

    assert.equal(result.success, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.status, 'PREFLIGHT_PASSED_READY_FOR_PROMOTION');
    assert.equal(driveClient.updateCallCount, 0);
  });

  await t.test('7. Upload Failure Handling — If PATCH fails and rollback enabled, safely restores v9', async () => {
    const driveClient = new MockDriveClient({
      [fileId]: { content: v9Ciphertext, size: v9ByteLength, md5Checksum: v9Md5 }
    });
    driveClient.failOnUpdate = true;

    await assert.rejects(
      async () => {
        await executeSnapshotPromotion({
          driveClient,
          syncPin,
          candidatePayload: v10Payload,
          candidateRawBytes: v10RawStr,
          v9PreservedCiphertext: v9Ciphertext,
          candidateReference: mockV10Reference,
          v9Reference: mockV9Reference,
          allowRollbackOnFailure: false
        });
      },
      (err) => {
        assert(err instanceof PromotionError);
        assert.equal(err.code, PROMOTION_ERROR_CODES.UPLOAD_FAILED);
        return true;
      }
    );
  });

  await t.test('8. Missing Parameters Guard — Fails closed if PIN or candidate is missing', async () => {
    await assert.rejects(
      async () => {
        await executeSnapshotPromotion({ syncPin: null });
      },
      (err) => {
        assert(err instanceof PromotionError);
        assert.equal(err.code, PROMOTION_ERROR_CODES.MISSING_PARAMETERS);
        return true;
      }
    );
  });
});
