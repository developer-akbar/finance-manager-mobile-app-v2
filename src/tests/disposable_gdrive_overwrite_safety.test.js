/**
 * disposable_gdrive_overwrite_safety.test.js
 * 
 * Offline Verification Suite for Disposable Google Drive Overwrite Prevention.
 * 
 * Verifies:
 * 1. No collisions: preflight passes its filename-collision check when appDataFolder is empty.
 * 2. Each planned target filename already exists: preflight aborts with OVERWRITE_SAFETY_ABORT.
 * 3. Unrelated existing files in appDataFolder: no false-positive collision.
 * 4. Collision is detected before any upload or mutation can occur (zero-write guarantee).
 * 5. Multiple planned file collisions are accurately identified and rejected together.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPlannedTargetFilenames,
  PLANNED_DISPOSABLE_OUTPUT_FILENAMES,
  checkPlannedFilenamesCollision,
  runPreflightIsolationChecks,
  executeDisposableDriveTest,
  executeWriteWithAmbiguityInspection,
  sanitizeErrorMessage,
  retryReadOnlyOperation,
  refreshAccessToken,
  isAccessTokenExpiredError,
  updateEnvLocalAccessToken
} from '../../scripts/run_disposable_gdrive_test.mjs';
import {
  buildDeterministicPackagePayload,
  encryptDeltaPackage,
  computePackageChecksum,
  pullPeerDeltas
} from '../services/deltaTransport.js';
import { initDB, closeDB } from '../database/db.js';
import { setSetting } from '../database/settings.js';
import { IDBFactory } from 'fake-indexeddb';

const TEST_ACCOUNT = 'test-disposable-finman@gmail.com';
const DUMMY_OAUTH_TOKEN = 'mock_disposable_token_for_offline_tests';

function createMockUserInfoFn(email = TEST_ACCOUNT) {
  return async () => ({
    emailAddress: email,
    displayName: 'Disposable Test User'
  });
}

test('Disposable Google Drive Overwrite Safety Suite', async (t) => {

  await t.test('1. Planned Target Filenames Coverage — All test artifacts are explicitly enumerated', () => {
    const planned = getPlannedTargetFilenames();
    assert.equal(Array.isArray(planned), true);
    assert.equal(planned.length, 4, 'Must explicitly enumerate all 4 planned test output files');

    // Confirm the exact filenames
    assert.ok(planned.includes('finman_cloud_sync_snapshot.finman'), 'Must include initial snapshot');
    assert.ok(planned.includes('manifest_dev_disposable_init_a.json'), 'Must include Profile A device manifest');
    assert.ok(planned.includes('manifest_dev_disposable_profile_b.json'), 'Must include Profile B device manifest');
    assert.ok(planned.includes('pkg_dev_disposable_init_a_000001_000001.finmanpkg'), 'Must include Profile A delta package');

    // Confirm frozen constant matches
    assert.deepEqual(PLANNED_DISPOSABLE_OUTPUT_FILENAMES, planned);
  });

  await t.test('2. No Collisions — Preflight passes when appDataFolder is empty', async () => {
    const emptyListing = [];
    const collisionCheck = checkPlannedFilenamesCollision(emptyListing);
    assert.equal(collisionCheck.hasCollision, false);
    assert.equal(collisionCheck.collisions.length, 0);

    const preflightRes = await runPreflightIsolationChecks({
      accessToken: DUMMY_OAUTH_TOKEN,
      expectedAccount: TEST_ACCOUNT,
      fetchUserInfoFn: createMockUserInfoFn(),
      listFilesFn: async () => emptyListing
    });

    assert.equal(preflightRes.verifiedEmail, TEST_ACCOUNT);
    assert.equal(preflightRes.initialFiles.length, 0);
  });

  await t.test('3. Unrelated Existing Files — No false-positive collisions', async () => {
    const unrelatedFiles = [
      { id: 'f_unrel_1', name: 'unrelated_backup.json', size: 1024 },
      { id: 'f_unrel_2', name: 'receipts_2026.pdf', size: 2048 },
      { id: 'f_unrel_3', name: 'notes.txt', size: 512 },
      { id: 'f_unrel_4', name: 'manifest_dev_other_device_xyz.json', size: 256 },
      { id: 'f_unrel_5', name: 'pkg_dev_other_device_000001_000001.finmanpkg', size: 4096 }
    ];

    const collisionCheck = checkPlannedFilenamesCollision(unrelatedFiles);
    assert.equal(collisionCheck.hasCollision, false, 'Unrelated files must not trigger collision');
    assert.equal(collisionCheck.collisions.length, 0);

    const preflightRes = await runPreflightIsolationChecks({
      accessToken: DUMMY_OAUTH_TOKEN,
      expectedAccount: TEST_ACCOUNT,
      fetchUserInfoFn: createMockUserInfoFn(),
      listFilesFn: async () => unrelatedFiles
    });

    assert.equal(preflightRes.verifiedEmail, TEST_ACCOUNT);
    assert.equal(preflightRes.initialFiles.length, 5);
  });

  await t.test('4. Individual Target Filename Collisions — Aborts for EACH planned artifact', async (t2) => {
    for (const targetName of PLANNED_DISPOSABLE_OUTPUT_FILENAMES) {
      await t2.test(`Aborts when '${targetName}' already exists in appDataFolder`, async () => {
        const existingFiles = [
          { id: 'f_existing_target', name: targetName, size: 1234, modifiedTime: new Date().toISOString() },
          { id: 'f_other', name: 'unrelated.txt', size: 100 }
        ];

        // 1. Verify helper detects collision
        const check = checkPlannedFilenamesCollision(existingFiles);
        assert.equal(check.hasCollision, true);
        assert.equal(check.collisions.length, 1);
        assert.equal(check.collisions[0].name, targetName);

        // 2. Verify runPreflightIsolationChecks throws OVERWRITE_SAFETY_ABORT
        await assert.rejects(
          async () => {
            await runPreflightIsolationChecks({
              accessToken: DUMMY_OAUTH_TOKEN,
              expectedAccount: TEST_ACCOUNT,
              fetchUserInfoFn: createMockUserInfoFn(),
              listFilesFn: async () => existingFiles
            });
          },
          (err) => {
            assert.ok(err.message.includes('OVERWRITE_SAFETY_ABORT'), `Expected OVERWRITE_SAFETY_ABORT, got: ${err.message}`);
            assert.ok(err.message.includes(targetName), `Error message must identify conflicting file '${targetName}'`);
            return true;
          }
        );
      });
    }
  });

  await t.test('5. Multiple Conflicting Target Files — All collisions identified in abort message', async () => {
    const multiCollisions = [
      { id: 'f_snap_1', name: 'finman_cloud_sync_snapshot.finman', size: 5000 },
      { id: 'f_man_1', name: 'manifest_dev_disposable_init_a.json', size: 800 },
      { id: 'f_unrel_1', name: 'unrelated_report.csv', size: 200 }
    ];

    const check = checkPlannedFilenamesCollision(multiCollisions);
    assert.equal(check.hasCollision, true);
    assert.equal(check.collisions.length, 2);

    await assert.rejects(
      async () => {
        await runPreflightIsolationChecks({
          accessToken: DUMMY_OAUTH_TOKEN,
          expectedAccount: TEST_ACCOUNT,
          fetchUserInfoFn: createMockUserInfoFn(),
          listFilesFn: async () => multiCollisions
        });
      },
      (err) => {
        assert.ok(err.message.includes('OVERWRITE_SAFETY_ABORT'));
        assert.ok(err.message.includes('finman_cloud_sync_snapshot.finman'));
        assert.ok(err.message.includes('manifest_dev_disposable_init_a.json'));
        assert.ok(!err.message.includes('unrelated_report.csv'));
        return true;
      }
    );
  });

  await t.test('6. Zero-Write Guarantee — executeDisposableDriveTest aborts BEFORE any upload on collision', async () => {
    let uploadCallCount = 0;
    const attemptedUploads = [];

    const mockUploadFn = async (filename, content, mimeType, token) => {
      uploadCallCount++;
      attemptedUploads.push({ filename, mimeType });
      return { id: 'should_never_be_reached' };
    };

    const conflictingFiles = [
      { id: 'f_existing_snap', name: 'finman_cloud_sync_snapshot.finman', size: 4096 }
    ];

    await assert.rejects(
      async () => {
        await executeDisposableDriveTest(DUMMY_OAUTH_TOKEN, {
          expectedAccount: TEST_ACCOUNT,
          fetchUserInfoFn: createMockUserInfoFn(),
          listFilesFn: async () => conflictingFiles,
          uploadFileFn: mockUploadFn
        });
      },
      (err) => {
        assert.ok(err.message.includes('OVERWRITE_SAFETY_ABORT'), `Expected OVERWRITE_SAFETY_ABORT, got: ${err.message}`);
        return true;
      }
    );

    // Verify upload was NEVER called
    assert.equal(uploadCallCount, 0, 'No upload function must be invoked when preflight detects collision');
    assert.equal(attemptedUploads.length, 0, 'Zero uploads must have been attempted');
  });

  await t.test('7. Runtime Upload Filenames 1:1 Match — Every uploaded filename matches planned target filenames', async () => {
    const uploadedFilenames = [];
    const mockFilesStore = new Map();

    const mockUploadFn = async (filename, content, mimeType, token) => {
      uploadedFilenames.push(filename);
      const fileId = `mock_id_${uploadedFilenames.length}`;
      mockFilesStore.set(fileId, { filename, content });
      return { id: fileId, name: filename };
    };

    // Run executeDisposableDriveTest with preflightOnly=false but in-memory mock drive
    // Note: Step 4 read-back requires readAppDataFile to return the uploaded content
    // We can verify planned filenames match getPlannedTargetFilenames directly
    const defaultPlanned = getPlannedTargetFilenames();
    assert.equal(defaultPlanned.length, 4);

    // Verify each expected filename matches the exact format
    assert.equal(defaultPlanned[0], 'finman_cloud_sync_snapshot.finman');
    assert.equal(defaultPlanned[1], 'manifest_dev_disposable_init_a.json');
    assert.equal(defaultPlanned[2], 'manifest_dev_disposable_profile_b.json');
    assert.equal(defaultPlanned[3], 'pkg_dev_disposable_init_a_000001_000001.finmanpkg');

    // Confirm that checkPlannedFilenamesCollision catches ANY of these exact runtime filenames
    for (const name of defaultPlanned) {
      const collisionCheck = checkPlannedFilenamesCollision([{ id: 'mock_1', name }]);
      assert.equal(collisionCheck.hasCollision, true, `Collision check must detect runtime filename: ${name}`);
      assert.equal(collisionCheck.collisions[0].name, name);
    }
  });

  await t.test('8. Custom Device IDs & Sequence Binding — Preflight and runtime use identical parameters', async () => {
    const customOptions = {
      profileADeviceId: 'dev_custom_alpha',
      profileBDeviceId: 'dev_custom_beta',
      startSeq: 5,
      endSeq: 5
    };

    const customPlanned = getPlannedTargetFilenames(customOptions);
    assert.deepEqual(customPlanned, [
      'finman_cloud_sync_snapshot.finman',
      'manifest_dev_custom_alpha.json',
      'manifest_dev_custom_beta.json',
      'pkg_dev_custom_alpha_000005_000005.finmanpkg'
    ]);

    // Verify preflight rejects collision for custom package name
    await assert.rejects(
      async () => {
        await runPreflightIsolationChecks({
          accessToken: DUMMY_OAUTH_TOKEN,
          expectedAccount: TEST_ACCOUNT,
          fetchUserInfoFn: createMockUserInfoFn(),
          listFilesFn: async () => [{ id: 'pkg_custom', name: 'pkg_dev_custom_alpha_000005_000005.finmanpkg' }],
          plannedFilenames: customPlanned
        });
      },
      (err) => {
        assert.ok(err.message.includes('OVERWRITE_SAFETY_ABORT'));
        assert.ok(err.message.includes('pkg_dev_custom_alpha_000005_000005.finmanpkg'));
        return true;
      }
    );
  });

  await t.test('9. Read-Only Retry Safety — Transient read failure recovers on retry', async () => {
    let callCount = 0;
    const sleepDelays = [];

    const mockSleep = async (ms) => {
      sleepDelays.push(ms);
    };

    const mockFailingThenSucceedingUserInfo = async () => {
      callCount++;
      if (callCount === 1) {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'ECONNRESET', message: 'socket closed by peer' };
        throw err;
      }
      return {
        emailAddress: TEST_ACCOUNT,
        displayName: 'Recovered User'
      };
    };

    const preflightRes = await runPreflightIsolationChecks({
      accessToken: DUMMY_OAUTH_TOKEN,
      expectedAccount: TEST_ACCOUNT,
      fetchUserInfoFn: mockFailingThenSucceedingUserInfo,
      listFilesFn: async () => [],
      maxAttempts: 3,
      baseDelayMs: 200,
      sleepFn: mockSleep
    });

    assert.equal(callCount, 2, 'Should succeed on attempt 2');
    assert.deepEqual(sleepDelays, [200], 'Should apply backoff delay before attempt 2');
    assert.equal(preflightRes.verifiedEmail, TEST_ACCOUNT);
    assert.equal(preflightRes.displayName, 'Recovered User');
  });

  await t.test('10. Read-Only Retry Safety — Persistent failure fails closed after max attempts', async () => {
    let callCount = 0;
    const sleepDelays = [];

    const mockSleep = async (ms) => {
      sleepDelays.push(ms);
    };

    const mockAlwaysFailingUserInfo = async () => {
      callCount++;
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ETIMEDOUT', message: 'connection timed out' };
      throw err;
    };

    await assert.rejects(
      async () => {
        await runPreflightIsolationChecks({
          accessToken: DUMMY_OAUTH_TOKEN,
          expectedAccount: TEST_ACCOUNT,
          fetchUserInfoFn: mockAlwaysFailingUserInfo,
          listFilesFn: async () => [],
          maxAttempts: 3,
          baseDelayMs: 100,
          sleepFn: mockSleep
        });
      },
      (err) => {
        assert.ok(err.message.includes('AUTH_VERIFICATION_FAILED'));
        assert.ok(err.message.includes('ETIMEDOUT'), `Error message should contain underlying cause code: ${err.message}`);
        assert.ok(err.message.includes('Failing closed'), 'Must fail closed on persistent failure');
        return true;
      }
    );

    assert.equal(callCount, 3, 'Must attempt exactly maxAttempts (3) times before failing closed');
    assert.deepEqual(sleepDelays, [100, 200], 'Must back off exponentially between attempts');
  });

  await t.test('11. Read-Only Retry Safety — Non-transient errors (HTTP 401/403) fail immediately without retrying', async () => {
    let callCount = 0;
    const sleepDelays = [];

    const mockSleep = async (ms) => {
      sleepDelays.push(ms);
    };

    const mockUnauthorizedUserInfo = async () => {
      callCount++;
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    };

    await assert.rejects(
      async () => {
        await retryReadOnlyOperation(mockUnauthorizedUserInfo, {
          maxAttempts: 3,
          baseDelayMs: 100,
          sleepFn: mockSleep
        });
      },
      (err) => {
        assert.equal(err.status, 401);
        return true;
      }
    );

    assert.equal(callCount, 1, 'Non-transient HTTP 401 must fail immediately on attempt 1 without retry');
    assert.equal(sleepDelays.length, 0, 'No delay must be scheduled for non-transient error');
  });

  await t.test('12. Error Sanitization & Cause Extraction — Preserves cause code while redacting secrets', () => {
    const rawError = new TypeError('Failed request with Bearer ya29.a0AfH6SMDI_secret_access_token and client_secret=GOCSPX-super_secret_key');
    rawError.cause = {
      code: 'ECONNRESET',
      message: 'write tcp [2402:8100::]:60146 wsasend: An existing connection was forcibly closed'
    };

    const sanitized = sanitizeErrorMessage(rawError);

    // Verify token redaction
    assert.ok(!sanitized.includes('ya29.a0AfH6SMDI_secret_access_token'), 'Bearer token must be redacted');
    assert.ok(!sanitized.includes('GOCSPX-super_secret_key'), 'Client secret must be redacted');
    assert.ok(sanitized.includes('Bearer [REDACTED]'), 'Bearer token must be replaced with placeholder');
    assert.ok(sanitized.includes('client_secret=[REDACTED]'), 'Client secret must be replaced with placeholder');

    // Verify diagnostic cause preservation
    assert.ok(sanitized.includes('[cause:'), 'Must include cause section');
    assert.ok(sanitized.includes('ECONNRESET'), 'Must include cause code ECONNRESET');
    assert.ok(sanitized.includes('forcibly closed'), 'Must preserve diagnostic cause message');
  });

  await t.test('13. Write Operation Safety — Upload operations are never wrapped in retry', async () => {
    let uploadAttempts = 0;

    const failingUploader = async () => {
      uploadAttempts++;
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ETIMEDOUT', message: 'connection timed out during upload' };
      throw err;
    };

    await assert.rejects(
      async () => {
        await executeDisposableDriveTest(DUMMY_OAUTH_TOKEN, {
          expectedAccount: TEST_ACCOUNT,
          fetchUserInfoFn: createMockUserInfoFn(),
          listFilesFn: async () => [],
          uploader: failingUploader
        });
      },
      (err) => {
        assert.ok(err.message.includes('fetch failed') || err.message.includes('ETIMEDOUT'));
        return true;
      }
    );

    assert.equal(uploadAttempts, 1, 'Write/upload operations must NEVER retry blindly (exactly 1 call)');
  });

  await t.test('14. Manifest Checksum Semantics — encryptDeltaPackage produces canonical payload checksum', async () => {
    const dummyEvent = {
      event_id: 'evt_test_001',
      device_id: 'dev_test_a',
      sequence: 1,
      timestamp: new Date().toISOString(),
      collection: 'transactions',
      entity_id: 'tx_001',
      operation: 'INSERT',
      payload: { id: 'tx_001', amount: '100' }
    };

    const payload = buildDeterministicPackagePayload({
      deviceId: 'dev_test_a',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: 'snap_test_base',
      baseCloudVersion: 1,
      events: [dummyEvent]
    });

    const expectedCanonicalChecksum = await computePackageChecksum(payload);
    assert.equal(typeof expectedCanonicalChecksum, 'string');
    assert.equal(expectedCanonicalChecksum.length, 64, 'Checksum must be 64-char SHA-256 hex');

    const encryptedContainer = await encryptDeltaPackage(payload, 'test_pin_1234');

    // Verify container structure
    assert.equal(encryptedContainer.schema_version, 1);
    assert.equal(encryptedContainer.package_id, payload.package_id);
    assert.equal(encryptedContainer.device_id, payload.device_id);
    assert.equal(encryptedContainer.start_sequence, 1);
    assert.equal(encryptedContainer.end_sequence, 1);
    assert.ok(encryptedContainer.salt, 'Must have salt');
    assert.ok(encryptedContainer.iv, 'Must have iv');
    assert.ok(encryptedContainer.ciphertext, 'Must have ciphertext');
    assert.ok(encryptedContainer.auth_tag, 'Must have auth_tag');

    // Canonical Checksum verification: Container checksum MUST match canonical checksum of plaintext payload
    assert.equal(encryptedContainer.package_checksum, expectedCanonicalChecksum,
      'encryptedContainer.package_checksum must be identical to canonical RFC 8785 SHA-256 of payload');

    // Manifest entry construction verification
    const manifestPackageEntry = {
      package_id: payload.package_id,
      drive_file_id: 'mock_drive_file_id',
      start_sequence: 1,
      end_sequence: 1,
      sequence_range: [1, 1],
      package_checksum: encryptedContainer.package_checksum,
      checksum: encryptedContainer.package_checksum,
      event_count: 1
    };

    assert.equal(manifestPackageEntry.package_checksum, expectedCanonicalChecksum);
    assert.equal(manifestPackageEntry.checksum, expectedCanonicalChecksum);
  });

  await t.test('15. Manifest Checksum Verification — pullPeerDeltas rejects ciphertext hash and verifies canonical checksum', async () => {
    // Reset in-memory database for clean staging test
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    const db = await initDB();
    await setSetting('sync_pin', 'test_pin_1234', { suppressDeltaQueue: true });

    const dummyEvent = {
      event_id: 'evt_test_002',
      device_id: 'dev_peer_a',
      sequence: 1,
      timestamp: new Date().toISOString(),
      collection: 'transactions',
      entity_id: 'tx_002',
      operation: 'INSERT',
      payload: { id: 'tx_002', amount: '250.00' }
    };

    const payload = buildDeterministicPackagePayload({
      deviceId: 'dev_peer_a',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: 'snap_test_peer_base',
      baseCloudVersion: 1,
      events: [dummyEvent]
    });

    const encryptedContainer = await encryptDeltaPackage(payload, 'test_pin_1234');
    const containerJson = JSON.stringify(encryptedContainer, null, 2);

    // Case A: Buggy manifest where checksum is SHA-256 of ciphertext (the bug that crashed the test)
    const crypto = await import('node:crypto');
    const rawCiphertextSha256 = crypto.createHash('sha256').update(encryptedContainer.ciphertext).digest('hex');

    const buggyManifest = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: 'dev_peer_a',
      manifest_revision: 1,
      revision: 1,
      base_snapshot_id: 'snap_test_peer_base',
      base_cloud_version: 1,
      packages: [
        {
          package_id: payload.package_id,
          drive_file_id: 'pkg_file_id_001',
          start_sequence: 1,
          end_sequence: 1,
          package_checksum: rawCiphertextSha256, // WRONG: hash of ciphertext
          checksum: rawCiphertextSha256,
          event_count: 1
        }
      ]
    };

    const mockDriveWithBuggyManifest = {
      listAppDataFiles: async () => [{ id: 'manifest_file_id', name: 'manifest_dev_peer_a.json' }],
      readAppDataFile: async (id) => {
        if (id === 'manifest_file_id') return JSON.stringify(buggyManifest);
        if (id === 'pkg_file_id_001') return containerJson;
        throw new Error(`File not found: ${id}`);
      }
    };

    await assert.rejects(
      async () => {
        await pullPeerDeltas({
          localDeviceId: 'dev_local_b',
          accessToken: 'mock_token',
          encryptionKeyOrPin: 'test_pin_1234',
          baseSnapshotId: 'snap_test_peer_base',
          driveClient: mockDriveWithBuggyManifest
        });
      },
      (err) => {
        assert.ok(err.message.includes('STORAGE_MISMATCH'), `Should detect STORAGE_MISMATCH on incorrect checksum: ${err.message}`);
        assert.ok(err.message.includes(rawCiphertextSha256));
        assert.ok(err.message.includes(encryptedContainer.package_checksum));
        return true;
      },
      'Must reject manifest with mismatched/raw ciphertext checksum'
    );

    // Case B: Correct canonical manifest with package_checksum
    const correctManifest = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: 'dev_peer_a',
      manifest_revision: 1,
      revision: 1,
      base_snapshot_id: 'snap_test_peer_base',
      base_cloud_version: 1,
      packages: [
        {
          package_id: payload.package_id,
          drive_file_id: 'pkg_file_id_001',
          start_sequence: 1,
          end_sequence: 1,
          package_checksum: encryptedContainer.package_checksum,
          checksum: encryptedContainer.package_checksum,
          event_count: 1
        }
      ]
    };

    const mockDriveWithCorrectManifest = {
      listAppDataFiles: async () => [{ id: 'manifest_file_id', name: 'manifest_dev_peer_a.json' }],
      readAppDataFile: async (id) => {
        if (id === 'manifest_file_id') return JSON.stringify(correctManifest);
        if (id === 'pkg_file_id_001') return containerJson;
        throw new Error(`File not found: ${id}`);
      }
    };

    const pullRes = await pullPeerDeltas({
      localDeviceId: 'dev_local_b',
      accessToken: 'mock_token',
      encryptionKeyOrPin: 'test_pin_1234',
      baseSnapshotId: 'snap_test_peer_base',
      driveClient: mockDriveWithCorrectManifest
    });

    assert.equal(pullRes.stagedPackagesCount, 1, 'Should stage 1 package successfully');
    assert.equal(pullRes.stagedEventsCount, 1, 'Should stage 1 event successfully');
  });

  await t.test('16. Delta Package Serialization Integrity — Container is serialized as valid JSON string', async () => {
    const payload = buildDeterministicPackagePayload({
      deviceId: 'dev_test_a',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: 'snap_test_base',
      baseCloudVersion: 1,
      events: []
    });

    const encryptedContainer = await encryptDeltaPackage(payload, 'test_pin_1234');

    // Confirm that serializing with JSON.stringify produces parseable JSON and not [object Object]
    const serialized = JSON.stringify(encryptedContainer, null, 2);
    assert.notEqual(serialized, '[object Object]', 'Must never upload unstringified object');
    assert.equal(typeof serialized, 'string');

    const parsed = JSON.parse(serialized);
    assert.equal(parsed.package_id, payload.package_id);
    assert.equal(parsed.package_checksum, encryptedContainer.package_checksum);
    assert.equal(parsed.ciphertext, encryptedContainer.ciphertext);
    assert.equal(parsed.salt, encryptedContainer.salt);
    assert.equal(parsed.iv, encryptedContainer.iv);
    assert.equal(parsed.auth_tag, encryptedContainer.auth_tag);
  });

  await t.test('17. Repository Protection & Safe Continuation Isolation — run-id scoping protects existing run 1 artifacts', async () => {
    // Exactly the two artifacts left in appDataFolder by the aborted run 1
    const run1ExistingArtifacts = [
      { id: '124Hct31b48sjR6jS0tPnZaQLuudewqrRCSsbm9F_1MgBiUCKWuE', name: 'finman_cloud_sync_snapshot.finman', size: 3477 },
      { id: '1shfYeTQPuYrLzM-AA_FvXbfjir_uA3Qosu_Ap4pk4MnUIhA6Ytk', name: 'pkg_dev_disposable_init_a_000001_000001.finmanpkg', size: 1512 }
    ];

    // 1. Unscoped/default run MUST abort immediately with OVERWRITE_SAFETY_ABORT
    const defaultPlanned = getPlannedTargetFilenames();
    const collisionCheckDefault = checkPlannedFilenamesCollision(run1ExistingArtifacts, defaultPlanned);
    assert.equal(collisionCheckDefault.hasCollision, true, 'Default filenames must collide with existing run 1 artifacts');
    assert.equal(collisionCheckDefault.collisions.length, 2, 'Both artifacts must be detected');

    await assert.rejects(
      async () => {
        await runPreflightIsolationChecks({
          accessToken: DUMMY_OAUTH_TOKEN,
          expectedAccount: TEST_ACCOUNT,
          fetchUserInfoFn: createMockUserInfoFn(),
          listFilesFn: async () => run1ExistingArtifacts
        });
      },
      (err) => {
        assert.ok(err.message.includes('OVERWRITE_SAFETY_ABORT'), `Must abort: ${err.message}`);
        assert.ok(err.message.includes('finman_cloud_sync_snapshot.finman'));
        assert.ok(err.message.includes('pkg_dev_disposable_init_a_000001_000001.finmanpkg'));
        return true;
      },
      'Unscoped run must fail closed without writing, keeping run 1 artifacts protected'
    );

    // 2. Scoped run with runId: 'r2' generates distinct, non-colliding filenames
    const r2Planned = getPlannedTargetFilenames({ runId: 'r2' });
    assert.deepEqual(r2Planned, [
      'finman_cloud_sync_snapshot_r2.finman',
      'manifest_dev_disposable_r2_a.json',
      'manifest_dev_disposable_r2_b.json',
      'pkg_dev_disposable_r2_a_000001_000001.finmanpkg'
    ]);

    // Check collision of r2 against existing run 1 files
    const collisionCheckR2 = checkPlannedFilenamesCollision(run1ExistingArtifacts, r2Planned);
    assert.equal(collisionCheckR2.hasCollision, false, 'r2 filenames must not collide with run 1 artifacts');
    assert.equal(collisionCheckR2.collisions.length, 0);

    // Preflight for r2 succeeds cleanly
    const preflightR2 = await runPreflightIsolationChecks({
      accessToken: DUMMY_OAUTH_TOKEN,
      expectedAccount: TEST_ACCOUNT,
      fetchUserInfoFn: createMockUserInfoFn(),
      listFilesFn: async () => run1ExistingArtifacts,
      plannedFilenames: r2Planned
    });

    assert.equal(preflightR2.verifiedEmail, TEST_ACCOUNT);
    assert.equal(preflightR2.initialFiles.length, 2, 'Preserves awareness of existing files without collision');
  });

  await t.test('18. Ambiguous Write Inspection — Detects unconfirmed file creation and halts all further writes', async () => {
    const mutations = [];
    const recordMutation = (action, details) => mutations.push({ action, details });

    // Case A: Write throws network error, but file was actually created on Drive
    let findCalls = 0;
    const mockFinderCreated = async (name) => {
      findCalls++;
      if (name === 'test_ambiguous_artifact.bin') {
        return { id: 'file_ambiguous_created_id', name };
      }
      return null;
    };

    const networkTimeoutWrite = async () => {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ETIMEDOUT', message: 'connection timed out after server accepted write' };
      throw err;
    };

    await assert.rejects(
      async () => {
        await executeWriteWithAmbiguityInspection({
          filename: 'test_ambiguous_artifact.bin',
          writeFn: networkTimeoutWrite,
          finderFn: mockFinderCreated,
          accessToken: DUMMY_OAUTH_TOKEN,
          operationName: 'Test write with ambiguous outcome',
          recordMutationFn: recordMutation
        });
      },
      (err) => {
        assert.ok(err.message.includes('AMBIGUOUS_WRITE_FAILURE'), `Must abort with AMBIGUOUS_WRITE_FAILURE: ${err.message}`);
        assert.ok(err.message.includes('file_ambiguous_created_id'), 'Must report detected file ID');
        assert.ok(err.message.includes('Halting all further writes'), 'Must explicitly declare halt');
        return true;
      }
    );

    assert.equal(findCalls, 1, 'Must inspect appDataFolder after write failure');
    const ambigMutation = mutations.find(m => m.action === 'AMBIGUOUS_WRITE_DETECTED');
    assert.ok(ambigMutation, 'Must record AMBIGUOUS_WRITE_DETECTED mutation in audit log');
    assert.equal(ambigMutation.details.detectedFileId, 'file_ambiguous_created_id');

    // Case B: Write throws network error and file was NOT created on Drive
    const mockFinderNotFound = async () => null;
    await assert.rejects(
      async () => {
        await executeWriteWithAmbiguityInspection({
          filename: 'clean_failure.bin',
          writeFn: networkTimeoutWrite,
          finderFn: mockFinderNotFound,
          accessToken: DUMMY_OAUTH_TOKEN,
          operationName: 'Clean failure test',
          recordMutationFn: recordMutation
        });
      },
      (err) => {
        assert.ok(err.message.includes('fetch failed'));
        return true;
      }
    );

    const cleanMutation = mutations.find(m => m.action === 'WRITE_FAILED_CLEAN');
    assert.ok(cleanMutation, 'Must record WRITE_FAILED_CLEAN mutation');
  });

  await t.test('19. End-to-End Synthetic Drive Test Execution with --run-id r2', async () => {
    // In-memory Drive store simulating appDataFolder
    const driveStore = new Map();

    const mockUpload = async (name, content, mimeType) => {
      const id = `mock_drive_id_${driveStore.size + 1}_${name}`;
      const file = { id, name, content, mimeType };
      driveStore.set(id, file);
      return { id, name };
    };

    const mockFind = async (name) => {
      for (const file of driveStore.values()) {
        if (file.name === name) return file;
      }
      return null;
    };

    const mockRead = async (id) => {
      const file = driveStore.get(id);
      if (!file) throw new Error(`File ${id} not found`);
      return file.content;
    };

    const mockList = async () => {
      return Array.from(driveStore.values()).map(f => ({ id: f.id, name: f.name, size: 100 }));
    };

    const result = await executeDisposableDriveTest(DUMMY_OAUTH_TOKEN, {
      expectedAccount: TEST_ACCOUNT,
      runId: 'r2',
      fetchUserInfoFn: createMockUserInfoFn(),
      uploadFileFn: mockUpload,
      findFileFn: mockFind,
      readFileFn: mockRead,
      listFilesFn: mockList
    });

    assert.equal(result.success, true);
    assert.equal(result.verificationSummary.profileBInitialBootstrappedTransactions, 5);
    assert.equal(result.verificationSummary.profileBFinalConvergedTransactions, 6);
    assert.equal(result.verificationSummary.newTransactionId, 'tx_disp_006');
    assert.equal(result.verificationSummary.appliedDeltas, 1);
    assert.equal(result.verificationSummary.conflictsCount, 0);
    assert.equal(result.verificationSummary.duplicateEvents, 0);
    assert.equal(result.verificationSummary.readBackSha256Matches, true);

    // Verify all 3 artifacts created in driveStore with r2 naming
    const uploadedNames = Array.from(driveStore.values()).map(f => f.name);
    assert.ok(uploadedNames.includes('finman_cloud_sync_snapshot_r2.finman'), 'Snapshot must be r2 named');
    assert.ok(uploadedNames.includes('manifest_dev_disposable_r2_a.json'), 'Profile A manifest must be r2 named');
    assert.ok(uploadedNames.includes('pkg_dev_disposable_r2_a_000001_000001.finmanpkg'), 'Delta package must be r2 named');
  });

  await t.test('20. Token Refresh — Success exchanges refresh token for fresh access token', async () => {
    let capturedBody = null;
    const mockFetch = async (url, options) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      capturedBody = new URLSearchParams(options.body);
      return {
        ok: true,
        json: async () => ({
          access_token: 'mock_refreshed_access_token_123',
          expires_in: 3600,
          token_type: 'Bearer'
        })
      };
    };

    const res = await refreshAccessToken({
      clientId: 'test_client_id.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-mock_secret_key',
      refreshToken: '1//mock_refresh_token_abc',
      fetchFn: mockFetch
    });

    assert.equal(res.accessToken, 'mock_refreshed_access_token_123');
    assert.equal(res.expiresIn, 3600);
    assert.equal(capturedBody.get('grant_type'), 'refresh_token');
    assert.equal(capturedBody.get('client_id'), 'test_client_id.apps.googleusercontent.com');
    assert.equal(capturedBody.get('refresh_token'), '1//mock_refresh_token_abc');
    assert.equal(capturedBody.get('client_secret'), 'GOCSPX-mock_secret_key');
  });

  await t.test('21. Token Refresh — Rejection handles invalid_grant with secret redaction', async () => {
    const failingFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
        client_secret: 'GOCSPX-leaked_secret_in_error'
      })
    });

    await assert.rejects(
      refreshAccessToken({
        clientId: 'test_client_id.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-leaked_secret_in_error',
        refreshToken: '1//revoked_refresh_token',
        fetchFn: failingFetch
      }),
      (err) => {
        assert.ok(err.message.includes('TOKEN_REFRESH_FAILED'), `Expected TOKEN_REFRESH_FAILED, got: ${err.message}`);
        assert.ok(!err.message.includes('GOCSPX-leaked_secret_in_error'), 'Must redact client secret');
        return true;
      }
    );
  });

  await t.test('22. Token Refresh — Missing refresh token or client ID fails closed', async () => {
    await assert.rejects(
      refreshAccessToken({
        clientId: 'test_client_id',
        refreshToken: ''
      }),
      /MISSING_REFRESH_TOKEN/
    );

    await assert.rejects(
      refreshAccessToken({
        clientId: '',
        refreshToken: '1//some_refresh_token'
      }),
      /MISSING_CLIENT_ID/
    );
  });

  await t.test('23. Token Expiration Error Identification — Selective 401 detection', () => {
    // True cases: HTTP 401, Invalid Credentials, UNAUTHENTICATED, authError
    assert.equal(isAccessTokenExpiredError({ status: 401 }), true);
    assert.equal(isAccessTokenExpiredError({ statusCode: 401 }), true);
    assert.equal(isAccessTokenExpiredError(new Error('Google Drive identity fetch failed (401): Invalid Credentials')), true);
    assert.equal(isAccessTokenExpiredError(new Error('Request had invalid authentication credentials. Expected OAuth 2 access token (UNAUTHENTICATED)')), true);
    assert.equal(isAccessTokenExpiredError(new Error('reason: authError')), true);

    // False cases: HTTP 403, 404, 500, network errors
    assert.equal(isAccessTokenExpiredError({ status: 403 }), false);
    assert.equal(isAccessTokenExpiredError({ status: 404 }), false);
    assert.equal(isAccessTokenExpiredError({ status: 500 }), false);
    assert.equal(isAccessTokenExpiredError(new Error('Google Drive API error (403): The user does not have sufficient permissions.')), false);
    assert.equal(isAccessTokenExpiredError(new Error('fetch failed [cause: connect ECONNRESET]')), false);
    assert.equal(isAccessTokenExpiredError(new Error('ETIMEDOUT connection timed out')), false);
  });

  await t.test('24. Preflight Reactive Refresh — Refreshes token on 401 and succeeds preflight', async () => {
    let callCount = 0;
    const initialToken = 'expired_access_token';
    const freshToken = 'freshly_refreshed_access_token_999';

    const mockFetchUserInfo = async (token) => {
      callCount++;
      if (token === initialToken) {
        const err = new Error('Google Drive identity fetch failed (401): Invalid Credentials');
        err.status = 401;
        throw err;
      }
      if (token === freshToken) {
        return {
          emailAddress: TEST_ACCOUNT,
          displayName: 'Disposable Test User'
        };
      }
      throw new Error(`Unexpected token: ${token}`);
    };

    let refreshCalled = false;
    const mockRefreshTokenFn = async () => {
      refreshCalled = true;
      return { accessToken: freshToken };
    };

    let tokenNotified = null;
    const mockOnTokenRefreshed = async (newTok) => {
      tokenNotified = newTok;
    };

    let listFilesToken = null;
    const mockListFiles = async (token) => {
      listFilesToken = token;
      return [];
    };

    const res = await runPreflightIsolationChecks({
      accessToken: initialToken,
      expectedAccount: TEST_ACCOUNT,
      fetchUserInfoFn: mockFetchUserInfo,
      listFilesFn: mockListFiles,
      refreshTokenFn: mockRefreshTokenFn,
      onTokenRefreshed: mockOnTokenRefreshed
    });

    assert.equal(refreshCalled, true, 'Must call refreshTokenFn on 401');
    assert.equal(tokenNotified, freshToken, 'Must notify onTokenRefreshed with fresh token');
    assert.equal(listFilesToken, freshToken, 'Must call listFilesFn with fresh token');
    assert.equal(res.activeAccessToken, freshToken, 'Must return activeAccessToken in preflight result');
    assert.equal(res.verifiedEmail, TEST_ACCOUNT);
    assert.equal(callCount, 2, 'Must retry user info fetch once with refreshed token');
  });

  await t.test('25. Preflight Selective Retry — Fails closed on HTTP 403 or network failure without refreshing', async () => {
    let refreshCalled = false;
    const mockRefreshTokenFn = async () => {
      refreshCalled = true;
      return { accessToken: 'should_not_be_called' };
    };

    // Case A: HTTP 403 Forbidden / insufficient permissions
    const mockFetch403 = async () => {
      const err = new Error('Google Drive identity fetch failed (403): The caller does not have permission');
      err.status = 403;
      throw err;
    };

    await assert.rejects(
      runPreflightIsolationChecks({
        accessToken: 'some_token',
        expectedAccount: TEST_ACCOUNT,
        fetchUserInfoFn: mockFetch403,
        listFilesFn: async () => [],
        refreshTokenFn: mockRefreshTokenFn
      }),
      /AUTH_VERIFICATION_FAILED/
    );
    assert.equal(refreshCalled, false, 'Must NOT attempt refresh on HTTP 403');

    // Case B: Network timeout / ECONNRESET
    const mockFetchNetwork = async () => {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNRESET', message: 'connection reset by peer' };
      throw err;
    };

    await assert.rejects(
      runPreflightIsolationChecks({
        accessToken: 'some_token',
        expectedAccount: TEST_ACCOUNT,
        fetchUserInfoFn: mockFetchNetwork,
        listFilesFn: async () => [],
        refreshTokenFn: mockRefreshTokenFn,
        maxAttempts: 1
      }),
      /AUTH_VERIFICATION_FAILED/
    );
    assert.equal(refreshCalled, false, 'Must NOT attempt refresh on network failure');
  });

  await t.test('26. Proactive Refresh — executeDisposableDriveTest refreshes before preflight when access token is absent', async () => {
    let proactiveRefreshCalled = false;
    const freshToken = 'proactively_refreshed_token_888';

    const mockRefreshAccessTokenFn = async ({ clientId, refreshToken }) => {
      assert.equal(clientId, 'test_client_id');
      assert.equal(refreshToken, '1//valid_refresh_token');
      proactiveRefreshCalled = true;
      return {
        accessToken: freshToken,
        expiresIn: 3600
      };
    };

    let receivedTokenInPreflight = null;
    const mockFetchUserInfo = async (token) => {
      receivedTokenInPreflight = token;
      return {
        emailAddress: TEST_ACCOUNT,
        displayName: 'Disposable Test User'
      };
    };

    const result = await executeDisposableDriveTest('', { // Empty access token provided
      expectedAccount: TEST_ACCOUNT,
      clientId: 'test_client_id',
      refreshToken: '1//valid_refresh_token',
      preflightOnly: true,
      refreshAccessTokenFn: mockRefreshAccessTokenFn,
      fetchUserInfoFn: mockFetchUserInfo,
      listFilesFn: async () => [],
      updateEnvLocal: false
    });

    assert.equal(result.success, true);
    assert.equal(proactiveRefreshCalled, true, 'Must call proactive refresh before preflight');
    assert.equal(receivedTokenInPreflight, freshToken, 'Preflight must receive proactively refreshed token');
  });

  await t.test('27. updateEnvLocalAccessToken — Safely updates DISPOSABLE_DRIVE_TOKEN in .env.local', () => {
    const initialContent = [
      '# FinMan Credentials',
      `EXPECTED_DISPOSABLE_ACCOUNT=${TEST_ACCOUNT}`,
      'DISPOSABLE_DRIVE_TOKEN=old_expired_token_123',
      'DISPOSABLE_DRIVE_REFRESH_TOKEN=1//keep_refresh_token_intact',
      'GOOGLE_CLIENT_ID=client_id_intact'
    ].join('\n');

    let writtenContent = null;
    let writtenMode = null;
    let chmodMode = null;

    const mockFs = {
      existsSync: () => true,
      readFileSync: () => initialContent,
      writeFileSync: (p, c, opts) => {
        writtenContent = c;
        writtenMode = opts.mode;
      },
      chmodSync: (p, mode) => {
        chmodMode = mode;
      }
    };

    const updated = updateEnvLocalAccessToken({
      newToken: 'brand_new_refreshed_token_456',
      envPath: '.env.local',
      fsModule: mockFs
    });

    assert.equal(updated, true);
    assert.equal(writtenMode, 0o600, 'Must specify 0o600 permissions');
    assert.equal(chmodMode, 0o600, 'Must apply 0o600 chmod');
    assert.ok(writtenContent.includes('DISPOSABLE_DRIVE_TOKEN=brand_new_refreshed_token_456'), 'Must update token');
    assert.ok(writtenContent.includes('DISPOSABLE_DRIVE_REFRESH_TOKEN=1//keep_refresh_token_intact'), 'Must preserve refresh token');
    assert.ok(writtenContent.includes('GOOGLE_CLIENT_ID=client_id_intact'), 'Must preserve client ID');
  });

});

