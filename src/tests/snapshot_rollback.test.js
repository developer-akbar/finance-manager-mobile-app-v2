/**
 * snapshot_rollback.test.js
 * 
 * Automated Test Suite for Snapshot Rollback Safety Tooling (Phase 11D)
 * 
 * STRICT INVARIANTS TESTED:
 * 1. Happy Path: Successful rollback of failed v10 upload back to preserved v9 ciphertext.
 * 2. Duplicate detection: Multiple files on Drive aborts before write (DUPLICATE_SNAPSHOTS_FOUND).
 * 3. File ID verification: Wrong file ID aborts before write (UNEXPECTED_FILE_ID).
 * 4. Active content verification: Unrelated snapshot aborts before write (ACTIVE_NOT_FAILED_CANDIDATE).
 * 5. Active content corruption: Undecryptable active content aborts before write.
 * 6. Missing snapshot: Empty Drive aborts before write (NO_SNAPSHOT_FOUND).
 * 7. Local reference verification: Corrupt local v9 size/md5/sha256/decryption aborts before write.
 * 8. Upload failure handling: Transport error during PATCH fails closed.
 * 9. Post-upload verification failures: Size/MD5/SHA-256/Identity mismatch throws error.
 * 10. Missing Drive MD5 metadata: Handled gracefully by direct downloaded-byte MD5 calculation.
 * 11. Dry-run mode: Verifies all invariants without executing writes.
 * 12. Missing parameters: Fails closed with descriptive code.
 * 
 * Uses DISPOSABLE IN-MEMORY FIXTURES ONLY. Zero interaction with real Google Drive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackupData } from '../utils/cryptoBackup.js';
import {
  executeSnapshotRollback,
  computeMd5,
  computeSha256,
  verifyPreservedV9Reference,
  RollbackError,
  ROLLBACK_ERROR_CODES
} from '../services/snapshotRollback.js';

class MockDriveClient {
  constructor(initialFiles = {}) {
    this.files = new Map();
    this.writeHistory = [];
    this.findCallCount = 0;
    this.readCallCount = 0;
    this.updateCallCount = 0;
    this.failOnUpdate = false;
    this.postUpdateCorruptBytes = false;
    this.postUpdateCorruptMetadata = false;

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
    if (this.postUpdateCorruptBytes && this.writeHistory.length > 0) {
      return f.content + ' [TAMPERED_BYTES]';
    }
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
    if (this.postUpdateCorruptMetadata) {
      f.metadata.size = content.length + 999;
      f.metadata.md5Checksum = '00000000000000000000000000000000';
    }
    return { ...f.metadata };
  }
}

test('FinMan Phase 11D — Rollback Safety Tooling Test Suite', async (t) => {
  const TEST_PIN = 'test-sync-pin-9988';
  const EXPECTED_DRIVE_ID = 'test_drive_v9_file_id_alpha';
  const SNAPSHOT_FILENAME = 'finman_cloud_sync_snapshot.finman';

  // Create disposable synthetic v9 payload
  const v9Payload = {
    snapshot_id: 'snap_1790963722004_disposable_v9',
    cloud_version: 9,
    parent_snapshot_id: 'snap_1790493064581_disposable_v8',
    entities: { transactions: [{ id: 'txn_v9_001', amount: 100 }] }
  };
  const v9Ciphertext = await encryptBackupData(v9Payload, TEST_PIN);
  const v9Bytes = new TextEncoder().encode(v9Ciphertext);
  const v9Ref = {
    filename: SNAPSHOT_FILENAME,
    driveFileId: EXPECTED_DRIVE_ID,
    byteSize: v9Bytes.byteLength,
    md5: computeMd5(v9Bytes),
    sha256: await computeSha256(v9Bytes),
    snapshotId: v9Payload.snapshot_id,
    cloudVersion: v9Payload.cloud_version,
    parentSnapshotId: v9Payload.parent_snapshot_id
  };

  // Create disposable synthetic failed v10 candidate payload
  const v10CandidatePayload = {
    snapshot_id: 'snap_1791810470667_disposable_v10',
    cloud_version: 10,
    parent_snapshot_id: v9Payload.snapshot_id,
    entities: { transactions: [{ id: 'txn_v10_001', amount: 200 }] }
  };
  const v10Ciphertext = await encryptBackupData(v10CandidatePayload, TEST_PIN);
  const v10Ref = {
    snapshotId: v10CandidatePayload.snapshot_id,
    cloudVersion: v10CandidatePayload.cloud_version,
    parentSnapshotId: v10CandidatePayload.parent_snapshot_id
  };

  await t.test('1. Happy Path — Successful rollback of failed v10 upload to preserved v9', async () => {
    const mockDrive = new MockDriveClient({
      [EXPECTED_DRIVE_ID]: {
        name: SNAPSHOT_FILENAME,
        content: v10Ciphertext
      }
    });

    const result = await executeSnapshotRollback({
      driveClient: mockDrive,
      syncPin: TEST_PIN,
      v9Ciphertext,
      filename: SNAPSHOT_FILENAME,
      expectedDriveFileId: EXPECTED_DRIVE_ID,
      v9Reference: v9Ref,
      failedCandidateReference: v10Ref
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'ROLLBACK_SUCCESSFUL');
    assert.equal(result.restoredDriveFileId, EXPECTED_DRIVE_ID);
    assert.equal(result.restoredSnapshotId, v9Payload.snapshot_id);
    assert.equal(result.restoredCloudVersion, 9);
    assert.equal(result.restoredParentSnapshotId, v9Payload.parent_snapshot_id);
    assert.equal(result.verifiedByteSize, v9Ref.byteSize);
    assert.equal(result.verifiedMd5, v9Ref.md5);
    assert.equal(result.verifiedSha256, v9Ref.sha256);

    // Assert exact 1 write occurred
    assert.equal(mockDrive.writeHistory.length, 1);
    assert.equal(mockDrive.writeHistory[0].fileId, EXPECTED_DRIVE_ID);
    assert.equal(mockDrive.writeHistory[0].content, v9Ciphertext);
  });

  await t.test('2. Duplicate Files Guard — Aborts immediately if multiple matching snapshot files exist', async () => {
    const mockDrive = new MockDriveClient({
      [EXPECTED_DRIVE_ID]: {
        name: SNAPSHOT_FILENAME,
        content: v10Ciphertext
      },
      'duplicate_file_id_002': {
        name: SNAPSHOT_FILENAME,
        content: v10Ciphertext
      }
    });

    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDrive,
          syncPin: TEST_PIN,
          v9Ciphertext,
          filename: SNAPSHOT_FILENAME,
          expectedDriveFileId: EXPECTED_DRIVE_ID,
          v9Reference: v9Ref,
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.DUPLICATE_SNAPSHOTS_FOUND);
        assert(err.message.includes('Multiple matching snapshot files found'));
        return true;
      }
    );

    // STRICT INVARIANT: Zero writes performed
    assert.equal(mockDrive.writeHistory.length, 0);
  });

  await t.test('3. Unexpected File ID Guard — Aborts immediately if active file ID does not match expected ID', async () => {
    const WRONG_ID = 'unrelated_foreign_file_id_999';
    const mockDrive = new MockDriveClient({
      [WRONG_ID]: {
        name: SNAPSHOT_FILENAME,
        content: v10Ciphertext
      }
    });

    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDrive,
          syncPin: TEST_PIN,
          v9Ciphertext,
          filename: SNAPSHOT_FILENAME,
          expectedDriveFileId: EXPECTED_DRIVE_ID,
          v9Reference: v9Ref,
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.UNEXPECTED_FILE_ID);
        assert(err.message.includes('does not match expected ID'));
        return true;
      }
    );

    // STRICT INVARIANT: Zero writes performed
    assert.equal(mockDrive.writeHistory.length, 0);
  });

  await t.test('4. Active Content Verification — Aborts if active snapshot is an unrelated valid version', async () => {
    // Unrelated snapshot (e.g. v11)
    const unrelatedPayload = {
      snapshot_id: 'snap_v11_unrelated_promotion',
      cloud_version: 11,
      parent_snapshot_id: 'snap_v10'
    };
    const unrelatedCiphertext = await encryptBackupData(unrelatedPayload, TEST_PIN);

    const mockDrive = new MockDriveClient({
      [EXPECTED_DRIVE_ID]: {
        name: SNAPSHOT_FILENAME,
        content: unrelatedCiphertext
      }
    });

    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDrive,
          syncPin: TEST_PIN,
          v9Ciphertext,
          filename: SNAPSHOT_FILENAME,
          expectedDriveFileId: EXPECTED_DRIVE_ID,
          v9Reference: v9Ref,
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.ACTIVE_NOT_FAILED_CANDIDATE);
        assert(err.message.includes('is NOT the failed candidate v10 upload'));
        return true;
      }
    );

    // STRICT INVARIANT: Zero writes performed
    assert.equal(mockDrive.writeHistory.length, 0);
  });

  await t.test('5. Active Content Verification — Aborts if active snapshot is undecryptable or corrupted', async () => {
    const mockDrive = new MockDriveClient({
      [EXPECTED_DRIVE_ID]: {
        name: SNAPSHOT_FILENAME,
        content: '{"finman_encrypted_backup": true, "corrupted": true}'
      }
    });

    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDrive,
          syncPin: TEST_PIN,
          v9Ciphertext,
          filename: SNAPSHOT_FILENAME,
          expectedDriveFileId: EXPECTED_DRIVE_ID,
          v9Reference: v9Ref,
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.ACTIVE_NOT_FAILED_CANDIDATE);
        assert(err.message.includes('could not be decrypted with sync PIN'));
        return true;
      }
    );

    // STRICT INVARIANT: Zero writes performed
    assert.equal(mockDrive.writeHistory.length, 0);
  });

  await t.test('6. No Snapshot Found Guard — Aborts if Drive contains no snapshot file', async () => {
    const mockDrive = new MockDriveClient({});

    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDrive,
          syncPin: TEST_PIN,
          v9Ciphertext,
          filename: SNAPSHOT_FILENAME,
          expectedDriveFileId: EXPECTED_DRIVE_ID,
          v9Reference: v9Ref,
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.NO_SNAPSHOT_FOUND);
        return true;
      }
    );

    assert.equal(mockDrive.writeHistory.length, 0);
  });

  await t.test('7. Local Reference Verification — Aborts if local v9 reference has mismatched size/MD5/SHA-256', async () => {
    const mockDrive = new MockDriveClient({
      [EXPECTED_DRIVE_ID]: {
        name: SNAPSHOT_FILENAME,
        content: v10Ciphertext
      }
    });

    // Subtest 7a: Byte size mismatch
    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDrive,
          syncPin: TEST_PIN,
          v9Ciphertext,
          v9Reference: { ...v9Ref, byteSize: v9Ref.byteSize + 10 },
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE);
        assert(err.message.includes('byte size'));
        return true;
      }
    );

    // Subtest 7b: MD5 mismatch
    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDrive,
          syncPin: TEST_PIN,
          v9Ciphertext,
          v9Reference: { ...v9Ref, md5: '00000000000000000000000000000000' },
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE);
        assert(err.message.includes('MD5'));
        return true;
      }
    );

    // Subtest 7c: SHA-256 mismatch
    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDrive,
          syncPin: TEST_PIN,
          v9Ciphertext,
          v9Reference: { ...v9Ref, sha256: '0000000000000000000000000000000000000000000000000000000000000000' },
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE);
        assert(err.message.includes('SHA-256'));
        return true;
      }
    );

    // Subtest 7d: Wrong PIN for local reference
    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDrive,
          syncPin: 'wrong-pin-0000',
          v9Ciphertext,
          v9Reference: v9Ref,
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.INVALID_LOCAL_REFERENCE);
        assert(err.message.includes('failed decryption with provided PIN'));
        return true;
      }
    );

    // Zero writes performed across all local reference failure cases
    assert.equal(mockDrive.writeHistory.length, 0);
  });

  await t.test('8. Upload Failure Handling — Fails closed if Drive PATCH request errors', async () => {
    const mockDrive = new MockDriveClient({
      [EXPECTED_DRIVE_ID]: {
        name: SNAPSHOT_FILENAME,
        content: v10Ciphertext
      }
    });
    mockDrive.failOnUpdate = true;

    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDrive,
          syncPin: TEST_PIN,
          v9Ciphertext,
          filename: SNAPSHOT_FILENAME,
          expectedDriveFileId: EXPECTED_DRIVE_ID,
          v9Reference: v9Ref,
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err.message.includes('MockDrive: 500 Internal Server Error'));
        return true;
      }
    );
  });

  await t.test('9. Post-Upload Verification Failures — Fails closed if written file is corrupted', async () => {
    // Subtest 9a: Post-upload re-download byte corruption
    const mockDriveCorrupt = new MockDriveClient({
      [EXPECTED_DRIVE_ID]: {
        name: SNAPSHOT_FILENAME,
        content: v10Ciphertext
      }
    });
    mockDriveCorrupt.postUpdateCorruptBytes = true;

    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDriveCorrupt,
          syncPin: TEST_PIN,
          v9Ciphertext,
          filename: SNAPSHOT_FILENAME,
          expectedDriveFileId: EXPECTED_DRIVE_ID,
          v9Reference: v9Ref,
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.POST_VERIFICATION_SIZE_MISMATCH);
        return true;
      }
    );

    // Subtest 9b: Post-upload metadata mismatch
    const mockDriveMeta = new MockDriveClient({
      [EXPECTED_DRIVE_ID]: {
        name: SNAPSHOT_FILENAME,
        content: v10Ciphertext
      }
    });
    mockDriveMeta.postUpdateCorruptMetadata = true;

    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          driveClient: mockDriveMeta,
          syncPin: TEST_PIN,
          v9Ciphertext,
          filename: SNAPSHOT_FILENAME,
          expectedDriveFileId: EXPECTED_DRIVE_ID,
          v9Reference: v9Ref,
          failedCandidateReference: v10Ref
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.POST_VERIFICATION_SIZE_MISMATCH);
        return true;
      }
    );
  });

  await t.test('10. Missing Drive MD5 Metadata Handling — Directly calculates MD5 over downloaded bytes', async () => {
    // When Drive omits md5Checksum in metadata, the tool must verify MD5 over downloaded bytes without error
    const mockDrive = new MockDriveClient({
      [EXPECTED_DRIVE_ID]: {
        name: SNAPSHOT_FILENAME,
        content: v10Ciphertext,
        md5Checksum: null // Drive metadata lacks MD5
      }
    });

    const result = await executeSnapshotRollback({
      driveClient: mockDrive,
      syncPin: TEST_PIN,
      v9Ciphertext,
      filename: SNAPSHOT_FILENAME,
      expectedDriveFileId: EXPECTED_DRIVE_ID,
      v9Reference: v9Ref,
      failedCandidateReference: v10Ref
    });

    assert.equal(result.success, true);
    assert.equal(result.verifiedMd5, v9Ref.md5);
  });

  await t.test('11. Dry-Run Mode — Positively identifies failed v10 and validates v9 without writing', async () => {
    const mockDrive = new MockDriveClient({
      [EXPECTED_DRIVE_ID]: {
        name: SNAPSHOT_FILENAME,
        content: v10Ciphertext
      }
    });

    const result = await executeSnapshotRollback({
      driveClient: mockDrive,
      syncPin: TEST_PIN,
      v9Ciphertext,
      filename: SNAPSHOT_FILENAME,
      expectedDriveFileId: EXPECTED_DRIVE_ID,
      v9Reference: v9Ref,
      failedCandidateReference: v10Ref,
      dryRun: true
    });

    assert.equal(result.success, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.status, 'READY_FOR_ROLLBACK');
    assert.equal(result.activeDriveFileId, EXPECTED_DRIVE_ID);
    assert.equal(result.verifiedActiveSnapshotId, v10CandidatePayload.snapshot_id);
    assert.equal(result.verifiedActiveCloudVersion, 10);

    // STRICT INVARIANT: Zero writes performed in dry-run
    assert.equal(mockDrive.writeHistory.length, 0);
  });

  await t.test('12. Missing Parameters Guard — Fails closed if required parameters are missing', async () => {
    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          syncPin: null,
          v9Ciphertext
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.MISSING_PARAMETERS);
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await executeSnapshotRollback({
          syncPin: TEST_PIN,
          v9Ciphertext: null
        });
      },
      (err) => {
        assert(err instanceof RollbackError);
        assert.equal(err.code, ROLLBACK_ERROR_CODES.MISSING_PARAMETERS);
        return true;
      }
    );
  });
});
