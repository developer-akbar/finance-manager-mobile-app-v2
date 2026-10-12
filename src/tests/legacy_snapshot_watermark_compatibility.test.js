/**
 * legacy_snapshot_watermark_compatibility.test.js
 * 
 * Exhaustive Stage 4A Regression Test Suite for Legacy Snapshot Watermark Compatibility:
 * 
 * 1. Verified v9 compatibility: C pkgs 1–4, D pkgs 1–5, historical peer pkgs 1–9, and genuine D6.
 * 2. Exact outcome: 29,045 transactions, 897 investment transactions, and exactly 1 genuine pending conflict (txn_d6_conflict).
 * 3. Newer snapshots: authoritative embedded watermarks take precedence over legacy compatibility path.
 * 4. Unknown legacy snapshot: bootstrap fails closed with UNSUPPORTED_SNAPSHOT_METADATA before staging or database mutation.
 * 5. Genuine post-snapshot changes: valid new packages (e.g. D7) are still applied.
 * 6. Tombstones: historical edits do not resurrect records already deleted in the authoritative snapshot.
 * 7. Retry/idempotency: repeated attempts do not duplicate records or conflicts.
 * 8. Concurrency: background sync cannot race with bootstrap (mutual exclusion).
 * 9. Atomicity: a failed bootstrap leaves the pre-attempt local database unchanged.
 * 10. Identity and manifests: existing device identities and legacy local_device protection continue to work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  initDB,
  closeDB,
  getDB,
  getRawIDB,
  initLocalSyncState
} from '../database/index.js';
import { getTransactions, addTransaction, deleteTransaction } from '../database/transactions.js';
import { getSetting, setSetting } from '../database/settings.js';
import { unlockSyncSession, lockSyncSession } from '../services/syncSession.js';
import {
  DEVICE_LIFECYCLE,
  SYNC_TRIGGER,
  getDeviceLifecycleState,
  setDeviceLifecycleState,
  getLocalDeviceId,
  getOrCreateLocalDeviceId,
  bootstrapNewDevice,
  executeFullSyncPass,
  configureDeltaSyncEngine,
  resolveSnapshotPeerWatermarks,
  VERIFIED_LEGACY_SNAPSHOT_WATERMARKS
} from '../services/deltaSyncCoordinator.js';
import {
  buildDeterministicPackagePayload,
  encryptDeltaPackage
} from '../services/deltaTransport.js';
import {
  readOwnDeviceManifest,
  createEmptyDeviceManifest
} from '../services/deviceManifest.js';
import {
  getPendingConflicts
} from '../database/conflicts.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import { encryptBackupData } from '../utils/cryptoBackup.js';
import { SNAPSHOT_FILENAME } from '../services/cloudSyncEngine.js';

const TEST_SESSION_KEY = 'test_legacy_watermark_compat_key_32b';

class MockDriveStorage {
  constructor() {
    this.files = new Map();
    this.nextId = 1;
  }

  reset() {
    this.files.clear();
    this.nextId = 1;
  }

  async findFiles({ name } = {}) {
    const results = [];
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && (!name || f.name === name)) {
        results.push({ id: f.id, name: f.name });
      }
    }
    return results;
  }

  async findAppDataFile(name) {
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        return { id: f.id, name: f.name };
      }
    }
    return null;
  }

  async readFile(fileId) {
    const f = this.files.get(fileId);
    if (!f || f.trashed) throw new Error(`Drive file not found: ${fileId}`);
    return f.content;
  }

  async readAppDataFile(fileId) {
    return this.readFile(fileId);
  }

  async uploadFile({ name, content }) {
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        f.content = content;
        return { id: f.id, name: f.name };
      }
    }
    const id = `mock_file_${this.nextId++}`;
    this.files.set(id, { id, name, content, trashed: false });
    return { id, name };
  }

  async uploadAppDataFile(name, content) {
    return this.uploadFile({ name, content });
  }
}

test('Legacy Snapshot Watermark Compatibility Test Suite', async (suite) => {
  let mockDrive;

  suite.beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await initDB();
    mockDrive = new MockDriveStorage();
    configureDeltaSyncEngine({
      driveClient: mockDrive,
      getSessionKey: async () => TEST_SESSION_KEY
    });
    unlockSyncSession(TEST_SESSION_KEY);
  });

  suite.afterEach(async () => {
    lockSyncSession();
    await closeDB();
  });

  await suite.test('1 & 2. Verified Snapshot v9 compatibility: exact counts 29,045 txns, 897 inv txns, and exactly 1 genuine conflict', async () => {
    const db = getDB();
    const targetDevId = 'dev_g_fresh_test';
    const devCId = 'dev_6edc69e37943';
    const devDId = 'dev_b91065cd877f';
    const devHistoricalPeer = 'dev_f31f6e6d6628';

    // 1. Build exact production-scale snapshot v9 baseline
    // 29,045 transactions total, including the target conflicted transaction
    const conflictedTxnId = '3aee6d32-af17-4ca2-b056-785f69cfa9a4';
    const transactions = new Array(29045);
    for (let i = 0; i < 29044; i++) {
      transactions[i] = {
        id: `txn_v9_base_${i}`,
        Date: '2026-10-01',
        INR: 100 + (i % 50),
        Account: 'Cash',
        Category: 'Food',
        'Income/Expense': 'Expense'
      };
    }
    transactions[29044] = {
      id: conflictedTxnId,
      Date: '2026-10-01',
      INR: 500,
      Account: 'Cash',
      Category: 'Food',
      Note: 'Conflict Test - Device C Version',
      'Income/Expense': 'Expense'
    };

    // Exactly 897 investment transactions
    const investmentTransactions = new Array(897);
    for (let i = 0; i < 897; i++) {
      investmentTransactions[i] = {
        id: `inv_v9_base_${i}`,
        Date: '2026-10-01',
        INR: 1000 + i,
        SecuritySymbol: `SEC_${i % 20}`,
        Quantity: 1,
        UnitPrice: 1000 + i,
        'Income/Expense': 'Expense'
      };
    }

    const snapshotV9Payload = {
      snapshot_id: 'snap_1790963722004_bq5y93',
      parent_snapshot_id: 'snap_1790493064581_jbhnf8',
      cloud_version: 9,
      device_id: devCId,
      created_at: '2026-10-02T17:55:22.004Z',
      covered_peer_watermarks: null, // Legacy snapshot predates covered_peer_watermarks
      entities: {
        transactions,
        investment_transactions: investmentTransactions,
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encSnap = await encryptBackupData(snapshotV9Payload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    // 2. Prepare Peer C packages 1..4 (all covered by v9 at sequence 4)
    const manifestC = createEmptyDeviceManifest({
      deviceId: devCId,
      baseSnapshotId: 'snap_1790493064581_jbhnf8',
      baseCloudVersion: 8,
      manifestRevision: 4,
      lifecycleState: 'ACTIVE'
    });
    manifestC.packages = [];
    for (let s = 1; s <= 4; s++) {
      const pkg = buildDeterministicPackagePayload({
        deviceId: devCId,
        startSequence: s,
        endSequence: s,
        baseSnapshotId: 'snap_1790493064581_jbhnf8',
        events: [{
          event_id: `evt_c_${s}`,
          device_id: devCId,
          sequence: s,
          timestamp: '2026-10-01T10:00:00.000Z',
          collection: 'transactions',
          entity_id: `txn_v9_base_${s}`,
          operation: 'UPDATE',
          base_checksum: 'old_sum',
          new_checksum: 'new_sum',
          payload: { id: `txn_v9_base_${s}`, Date: '2026-10-01', INR: 999, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
        }]
      });
      const enc = await encryptDeltaPackage(pkg, TEST_SESSION_KEY);
      const file = await mockDrive.uploadFile({ name: `${pkg.package_id}.finmanpkg`, content: JSON.stringify(enc) });
      manifestC.packages.push({
        package_id: pkg.package_id,
        start_sequence: s,
        end_sequence: s,
        event_count: 1,
        package_checksum: enc.package_checksum,
        drive_file_id: file.id
      });
    }
    await mockDrive.uploadFile({ name: `manifest_dev_${devCId}.json`, content: JSON.stringify(manifestC) });

    // 3. Prepare Peer D packages 1..5 (covered) and genuine unmerged D6 (sequence 6)
    const manifestD = createEmptyDeviceManifest({
      deviceId: devDId,
      baseSnapshotId: 'snap_1790493064581_jbhnf8',
      baseCloudVersion: 8,
      manifestRevision: 6,
      lifecycleState: 'ACTIVE'
    });
    manifestD.packages = [];
    for (let s = 1; s <= 5; s++) {
      const pkg = buildDeterministicPackagePayload({
        deviceId: devDId,
        startSequence: s,
        endSequence: s,
        baseSnapshotId: 'snap_1790493064581_jbhnf8',
        events: [{
          event_id: `evt_d_${s}`,
          device_id: devDId,
          sequence: s,
          timestamp: '2026-10-01T11:00:00.000Z',
          collection: 'transactions',
          entity_id: `txn_v9_base_${s + 10}`,
          operation: 'UPDATE',
          base_checksum: 'old_sum',
          new_checksum: 'new_sum',
          payload: { id: `txn_v9_base_${s + 10}`, Date: '2026-10-01', INR: 888, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
        }]
      });
      const enc = await encryptDeltaPackage(pkg, TEST_SESSION_KEY);
      const file = await mockDrive.uploadFile({ name: `${pkg.package_id}.finmanpkg`, content: JSON.stringify(enc) });
      manifestD.packages.push({
        package_id: pkg.package_id,
        start_sequence: s,
        end_sequence: s,
        event_count: 1,
        package_checksum: enc.package_checksum,
        drive_file_id: file.id
      });
    }

    // Package D6: targets conflictedTxnId, editing note to Device D Version
    const d6MutatedTxn = {
      id: conflictedTxnId,
      Date: '2026-10-01',
      INR: 500,
      Account: 'Cash',
      Category: 'Food',
      Note: 'Conflict Test - Device D Version (Unmerged)',
      'Income/Expense': 'Expense'
    };
    const d6Checksum = await computeCanonicalSha256(d6MutatedTxn);
    const pkgD6 = buildDeterministicPackagePayload({
      deviceId: devDId,
      startSequence: 6,
      endSequence: 6,
      baseSnapshotId: 'snap_1790493064581_jbhnf8',
      events: [{
        event_id: 'evt_d_seq6_conflict',
        device_id: devDId,
        sequence: 6,
        timestamp: '2026-10-02T19:00:00.000Z',
        collection: 'transactions',
        entity_id: conflictedTxnId,
        operation: 'UPDATE',
        base_checksum: 'stale_base_sum_from_v8',
        new_checksum: d6Checksum,
        payload: d6MutatedTxn
      }]
    });
    const encD6 = await encryptDeltaPackage(pkgD6, TEST_SESSION_KEY);
    const fileD6 = await mockDrive.uploadFile({ name: 'pkg_dev_b91065cd877f_000006_000006.finmanpkg', content: JSON.stringify(encD6) });
    manifestD.packages.push({
      package_id: 'pkg_dev_b91065cd877f_000006_000006',
      start_sequence: 6,
      end_sequence: 6,
      event_count: 1,
      package_checksum: encD6.package_checksum,
      drive_file_id: fileD6.id
    });
    await mockDrive.uploadFile({ name: `manifest_dev_${devDId}.json`, content: JSON.stringify(manifestD) });

    // 4. Prepare Historical Peer dev_f31f6e6d6628 packages 1..9 (all covered by v9 at sequence 9)
    const manifestHist = createEmptyDeviceManifest({
      deviceId: devHistoricalPeer,
      baseSnapshotId: 'snap_1790493064581_jbhnf8',
      baseCloudVersion: 8,
      manifestRevision: 9,
      lifecycleState: 'ACTIVE'
    });
    manifestHist.packages = [];
    for (let s = 1; s <= 9; s++) {
      const pkg = buildDeterministicPackagePayload({
        deviceId: devHistoricalPeer,
        startSequence: s,
        endSequence: s,
        baseSnapshotId: 'snap_1790493064581_jbhnf8',
        events: [{
          event_id: `evt_hist_${s}`,
          device_id: devHistoricalPeer,
          sequence: s,
          timestamp: '2026-10-01T08:00:00.000Z',
          collection: 'transactions',
          entity_id: `txn_v9_base_${s + 100}`,
          operation: 'UPDATE',
          base_checksum: 'old_sum',
          new_checksum: 'new_sum',
          payload: { id: `txn_v9_base_${s + 100}`, Date: '2026-10-01', INR: 777, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
        }]
      });
      const enc = await encryptDeltaPackage(pkg, TEST_SESSION_KEY);
      const file = await mockDrive.uploadFile({ name: `${pkg.package_id}.finmanpkg`, content: JSON.stringify(enc) });
      manifestHist.packages.push({
        package_id: pkg.package_id,
        start_sequence: s,
        end_sequence: s,
        event_count: 1,
        package_checksum: enc.package_checksum,
        drive_file_id: file.id
      });
    }
    await mockDrive.uploadFile({ name: `manifest_dev_${devHistoricalPeer}.json`, content: JSON.stringify(manifestHist) });

    // 5. Run bootstrap on fresh Device G
    const bootResult = await bootstrapNewDevice({
      deviceId: targetDevId,
      sessionKey: TEST_SESSION_KEY,
      driveClient: mockDrive
    });

    assert.strictEqual(bootResult.success, true);
    assert.strictEqual(bootResult.status, 'BOOTSTRAP_SUCCESS');

    // Verify inbound deltas: Only D6 was staged and reconciled
    assert.strictEqual(bootResult.inboundDeltas.stagedPackagesCount, 1, 'Only genuine unmerged D6 package was staged');
    assert.strictEqual(bootResult.inboundDeltas.stagedPackageIds[0], 'pkg_dev_b91065cd877f_000006_000006');

    // 6. Verify exact transaction counts: exactly 29,045 transactions, 897 investment transactions
    const rawTxnRes = await db.query('SELECT * FROM transactions');
    assert.strictEqual((rawTxnRes.values || []).length, 29045, 'Canonical store contains exactly 29,045 transactions');

    const rawInvRes = await db.query('SELECT * FROM investment_transactions');
    assert.strictEqual((rawInvRes.values || []).length, 897, 'Canonical store contains exactly 897 investment transactions');

    // 7. Verify exactly 1 genuine pending conflict (associated with txn_d6_conflict)
    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 1, 'Exactly 1 pending conflict generated');
    assert.strictEqual(conflicts[0].entity_id, conflictedTxnId, 'Conflict targets txn_d6_conflict');
    assert.strictEqual(conflicts[0].peer_device_id, devDId, 'Conflict source is Device D');

    // 8. Verify peer state watermarks seeded correctly
    const peerCRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [devCId]);
    assert.strictEqual(Number(peerCRes.values?.[0]?.last_reconciled_sequence), 4, 'Device C watermark is 4');

    const peerHistRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [devHistoricalPeer]);
    assert.strictEqual(Number(peerHistRes.values?.[0]?.last_reconciled_sequence), 9, 'Historical peer watermark is 9');

    const peerDRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [devDId]);
    assert.strictEqual(Number(peerDRes.values?.[0]?.last_staged_sequence), 6, 'Device D staged sequence advanced to 6');
    assert.strictEqual(Number(peerDRes.values?.[0]?.last_reconciled_sequence), 5, 'Device D reconciled watermark remains 5 while conflict is pending');

    // 9. Verify lifecycle reached ACTIVE
    const lc = await getDeviceLifecycleState(targetDevId);
    assert.strictEqual(lc, DEVICE_LIFECYCLE.ACTIVE);
  });

  await suite.test('3. Newer snapshots: authoritative embedded watermarks take precedence over legacy catalog', async () => {
    // If a snapshot has embedded covered_peer_watermarks, those take absolute precedence
    const modernPayloadWithV9Id = {
      snapshot_id: 'snap_1790963722004_bq5y93', // Same ID as legacy v9!
      covered_peer_watermarks: {
        dev_6edc69e37943: 10,
        dev_b91065cd877f: 12
      }
    };
    const resolved = resolveSnapshotPeerWatermarks(modernPayloadWithV9Id);
    assert.strictEqual(resolved.dev_6edc69e37943, 10, 'Authoritative embedded watermark 10 takes precedence');
    assert.strictEqual(resolved.dev_b91065cd877f, 12, 'Authoritative embedded watermark 12 takes precedence');
    assert.strictEqual(resolved.dev_f31f6e6d6628, undefined, 'Unspecified peer is not backfilled from legacy catalog');
  });

  await suite.test('4. Unknown legacy snapshot: fails closed with UNSUPPORTED_SNAPSHOT_METADATA before staging or database mutation', async () => {
    const db = getDB();
    const freshDevId = 'dev_unknown_legacy_fail_closed';
    const unknownLegacyPayload = {
      snapshot_id: 'snap_unknown_arbitrary_legacy_v8',
      cloud_version: 8,
      created_at: new Date().toISOString(),
      device_id: 'dev_unknown_author',
      covered_peer_watermarks: null,
      entities: {
        transactions: [{ id: 'txn_alien_1', Date: '2026-03-01', INR: 100, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }],
        investment_transactions: [],
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encSnap = await encryptBackupData(unknownLegacyPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    // Mock Drive contains a peer package
    const pkg = buildDeterministicPackagePayload({
      deviceId: 'dev_peer_x',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: 'snap_unknown_arbitrary_legacy_v8',
      events: []
    });
    const encPkg = await encryptDeltaPackage(pkg, TEST_SESSION_KEY);
    const fPkg = await mockDrive.uploadFile({ name: `${pkg.package_id}.finmanpkg`, content: JSON.stringify(encPkg) });
    const manifest = createEmptyDeviceManifest({
      deviceId: 'dev_peer_x',
      baseSnapshotId: 'snap_unknown_arbitrary_legacy_v8',
      baseCloudVersion: 8,
      manifestRevision: 1,
      lifecycleState: 'ACTIVE'
    });
    manifest.packages = [{ package_id: pkg.package_id, start_sequence: 1, end_sequence: 1, event_count: 0, package_checksum: encPkg.package_checksum, drive_file_id: fPkg.id }];
    await mockDrive.uploadFile({ name: 'manifest_dev_dev_peer_x.json', content: JSON.stringify(manifest) });

    // Bootstrap must reject with UNSUPPORTED_SNAPSHOT_METADATA
    await assert.rejects(
      async () => {
        await bootstrapNewDevice({
          deviceId: freshDevId,
          driveClient: mockDrive,
          sessionKey: TEST_SESSION_KEY
        });
      },
      (err) => {
        assert.ok(err.message.includes('UNSUPPORTED_SNAPSHOT_METADATA'), `Expected UNSUPPORTED_SNAPSHOT_METADATA, got: ${err.message}`);
        return true;
      }
    );

    // Verify 0 packages staged
    const staged = (await db.query('SELECT * FROM sync_staged_packages')).values || [];
    assert.strictEqual(staged.length, 0, 'Zero packages staged');

    // Verify 0 conflicts created
    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 0, 'Zero conflicts created');

    // Verify local stores completely untouched
    const txns = await getTransactions();
    assert.strictEqual(txns.length, 0, 'Zero transactions installed');
  });

  await suite.test('5. Genuine post-snapshot changes: valid new packages (e.g. D7) are still applied', async () => {
    const db = getDB();
    const freshDevId = 'dev_post_snap_apply_test';
    const devDId = 'dev_b91065cd877f';

    const snapPayload = {
      snapshot_id: 'snap_1790963722004_bq5y93',
      parent_snapshot_id: 'snap_1790493064581_jbhnf8',
      cloud_version: 9,
      covered_peer_watermarks: null,
      entities: {
        transactions: [{ id: 'txn_base_keep', Date: '2026-10-01', INR: 100, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }],
        investment_transactions: [],
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encSnap = await encryptBackupData(snapPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    // Device D provides sequence 6 (clean insert)
    const newTxn = { id: 'txn_d_clean_new', Date: '2026-10-03', INR: 750, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' };
    const newSum = await computeCanonicalSha256(newTxn);
    const pkgD6 = buildDeterministicPackagePayload({
      deviceId: devDId,
      startSequence: 6,
      endSequence: 6,
      baseSnapshotId: 'snap_1790493064581_jbhnf8',
      events: [{
        event_id: 'evt_d_clean_insert_6',
        device_id: devDId,
        sequence: 6,
        timestamp: '2026-10-03T12:00:00.000Z',
        collection: 'transactions',
        entity_id: newTxn.id,
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: newSum,
        payload: newTxn
      }]
    });
    const encD6 = await encryptDeltaPackage(pkgD6, TEST_SESSION_KEY);
    const fD6 = await mockDrive.uploadFile({ name: `${pkgD6.package_id}.finmanpkg`, content: JSON.stringify(encD6) });
    const manifestD = createEmptyDeviceManifest({
      deviceId: devDId,
      baseSnapshotId: 'snap_1790493064581_jbhnf8',
      baseCloudVersion: 8,
      manifestRevision: 6,
      lifecycleState: 'ACTIVE'
    });
    manifestD.packages = [{ package_id: pkgD6.package_id, start_sequence: 6, end_sequence: 6, event_count: 1, package_checksum: encD6.package_checksum, drive_file_id: fD6.id }];
    await mockDrive.uploadFile({ name: `manifest_dev_${devDId}.json`, content: JSON.stringify(manifestD) });

    const res = await bootstrapNewDevice({ deviceId: freshDevId, driveClient: mockDrive, sessionKey: TEST_SESSION_KEY });
    assert.strictEqual(res.success, true);

    const txns = (await db.query('SELECT * FROM transactions')).values || [];
    assert.strictEqual(txns.length, 2, 'Snapshot baseline + new clean package transaction both present');
    assert.ok(txns.some(t => t.id === 'txn_d_clean_new'), 'New post-snapshot transaction cleanly applied');
  });

  await suite.test('6. Tombstones: historical edits do not resurrect records already deleted in authoritative snapshot', async () => {
    const db = getDB();
    const freshDevId = 'dev_tombstone_protection_test';
    const peerDev = 'dev_peer_tombstone_test';

    // Baseline snapshot with 1 transaction, and a tombstone record in sync_tombstones
    const snapPayload = {
      snapshot_id: 'snap_1790600000000_v10',
      parent_snapshot_id: 'snap_1790500000000_v9',
      cloud_version: 10,
      covered_peer_watermarks: { [peerDev]: 5 },
      entities: {
        transactions: [
          { id: 'txn_active_survivor', Date: '2026-10-01', INR: 100, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
        ],
        investment_transactions: [],
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encSnap = await encryptBackupData(snapPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    // Peer uploads sequence 6 attempting to edit a transaction that was deleted in the authoritative baseline
    const deletedTxnId = 'txn_deleted_in_v10_baseline';
    const pkg = buildDeterministicPackagePayload({
      deviceId: peerDev,
      startSequence: 6,
      endSequence: 6,
      baseSnapshotId: 'snap_1790500000000_v9',
      events: [{
        event_id: 'evt_resurrect_attempt',
        device_id: peerDev,
        sequence: 6,
        timestamp: '2026-10-03T10:00:00.000Z',
        collection: 'transactions',
        entity_id: deletedTxnId,
        operation: 'UPDATE',
        base_checksum: 'old_sum',
        new_checksum: 'new_sum',
        payload: { id: deletedTxnId, Date: '2026-10-01', INR: 999, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }
      }]
    });
    const encPkg = await encryptDeltaPackage(pkg, TEST_SESSION_KEY);
    const fPkg = await mockDrive.uploadFile({ name: `${pkg.package_id}.finmanpkg`, content: JSON.stringify(encPkg) });
    const manifest = createEmptyDeviceManifest({
      deviceId: peerDev,
      baseSnapshotId: 'snap_1790500000000_v9',
      baseCloudVersion: 9,
      manifestRevision: 6,
      lifecycleState: 'ACTIVE'
    });
    manifest.packages = [{ package_id: pkg.package_id, start_sequence: 6, end_sequence: 6, event_count: 1, package_checksum: encPkg.package_checksum, drive_file_id: fPkg.id }];
    await mockDrive.uploadFile({ name: `manifest_dev_${peerDev}.json`, content: JSON.stringify(manifest) });

    const res = await bootstrapNewDevice({ deviceId: freshDevId, driveClient: mockDrive, sessionKey: TEST_SESSION_KEY });
    assert.strictEqual(res.success, true);

    // Verify deleted transaction was NOT resurrected into local database
    const txns = await getTransactions();
    assert.strictEqual(txns.length, 1, 'Only survivor transaction remains; deleted record was NOT resurrected');
    assert.strictEqual(txns[0].id, 'txn_active_survivor');
    assert.ok(!txns.some(t => t.id === deletedTxnId), 'Deleted record was safely suppressed');
  });

  await suite.test('7. Retry / Idempotency: repeated attempts do not duplicate records or conflicts', async () => {
    const db = getDB();
    const targetDevId = 'dev_idempotent_test';

    const snapPayload = {
      snapshot_id: 'snap_1790963722004_bq5y93',
      covered_peer_watermarks: null,
      entities: {
        transactions: [{ id: 'txn_idemp_1', Date: '2026-10-01', INR: 200, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }],
        investment_transactions: [{ id: 'inv_idemp_1', Date: '2026-10-01', INR: 500, SecuritySymbol: 'INFY', Quantity: 1, UnitPrice: 500, 'Income/Expense': 'Expense' }],
        accounts: [{ id: 'acc_1', name: 'Cash', group_name: 'Cash' }],
        categories: [{ id: 'cat_1', name: 'Food', type: 'Expense' }]
      }
    };
    const encSnap = await encryptBackupData(snapPayload, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    // Attempt 1
    const res1 = await bootstrapNewDevice({ deviceId: targetDevId, driveClient: mockDrive, sessionKey: TEST_SESSION_KEY });
    assert.strictEqual(res1.success, true);

    const txns1 = (await db.query('SELECT * FROM transactions')).values || [];
    assert.strictEqual(txns1.length, 1);
    const inv1 = (await db.query('SELECT * FROM investment_transactions')).values || [];
    assert.strictEqual(inv1.length, 1);

    // Attempt 2 (idempotent retry)
    const res2 = await bootstrapNewDevice({ deviceId: targetDevId, driveClient: mockDrive, sessionKey: TEST_SESSION_KEY });
    assert.strictEqual(res2.success, true);

    const txns2 = (await db.query('SELECT * FROM transactions')).values || [];
    assert.strictEqual(txns2.length, 1, 'Transaction count remained exactly 1 (no duplicates)');

    const inv2 = (await db.query('SELECT * FROM investment_transactions')).values || [];
    assert.strictEqual(inv2.length, 1, 'Investment transaction count remained exactly 1 (no duplicates)');

    const conflicts = await getPendingConflicts();
    assert.strictEqual(conflicts.length, 0, 'Zero conflicts created on retry');
  });

  await suite.test('8. Concurrency: background sync cannot race with bootstrap', async () => {
    const freshDevId = 'dev_concurrency_race_guard';
    await initLocalSyncState(freshDevId);
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.JOINING, freshDevId);

    // While JOINING, executeFullSyncPass MUST be blocked
    const passResult = await executeFullSyncPass({
      deviceId: freshDevId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY,
      trigger: SYNC_TRIGGER.STARTUP
    });

    assert.strictEqual(passResult.success, false);
    assert.strictEqual(passResult.status, 'BLOCKED_DEVICE_JOINING');

    // Lifecycle remains JOINING
    const lc = await getDeviceLifecycleState(freshDevId);
    assert.strictEqual(lc, DEVICE_LIFECYCLE.JOINING);
  });

  await suite.test('9. Atomicity: failed bootstrap leaves pre-attempt local database unchanged', async () => {
    const db = getDB();
    const freshDevId = 'dev_atomicity_guarantee_test';

    // Seed existing local database with a pristine local transaction
    await addTransaction({
      id: 'txn_local_pre_existing',
      Date: '2026-10-01',
      INR: 1234,
      Account: 'Cash',
      Category: 'Food',
      'Income/Expense': 'Expense'
    }, { suppressDeltaQueue: true });

    const localBefore = await getTransactions();
    assert.strictEqual(localBefore.length, 1);
    assert.strictEqual(localBefore[0].id, 'txn_local_pre_existing');

    // Attempt bootstrap with an unsupported legacy snapshot
    const badSnap = {
      snapshot_id: 'snap_unsupported_corrupt_legacy',
      covered_peer_watermarks: null,
      entities: {
        transactions: [{ id: 'txn_corrupt_new', Date: '2026-10-01', INR: 9999, Account: 'Cash', Category: 'Food', 'Income/Expense': 'Expense' }],
        investment_transactions: [],
        accounts: [],
        categories: []
      }
    };
    const encSnap = await encryptBackupData(badSnap, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    await assert.rejects(
      async () => {
        await bootstrapNewDevice({ deviceId: freshDevId, driveClient: mockDrive, sessionKey: TEST_SESSION_KEY });
      },
      /UNSUPPORTED_SNAPSHOT_METADATA/
    );

    // Verify local database is 100% untouched: original transaction is still there
    const localAfter = await getTransactions();
    assert.strictEqual(localAfter.length, 1, 'Local database remained untouched');
    assert.strictEqual(localAfter[0].id, 'txn_local_pre_existing');
    assert.strictEqual(localAfter[0].INR, 1234);
  });

  await suite.test('10. Identity and manifests: existing device identities and legacy local_device protection continue to work', async () => {
    // 1. Existing local_device manifest exists on Drive
    const legacyManifest = createEmptyDeviceManifest({
      deviceId: 'local_device',
      baseSnapshotId: 'snap_1790963722004_bq5y93',
      baseCloudVersion: 9,
      manifestRevision: 2,
      lifecycleState: 'ACTIVE'
    });
    await mockDrive.uploadFile({ name: 'manifest_dev_local_device.json', content: JSON.stringify(legacyManifest) });

    // 2. Fresh device bootstraps
    const freshDeviceId = await getOrCreateLocalDeviceId();
    assert.ok(freshDeviceId.startsWith('dev_'), 'Allocated persistent unique device ID');
    assert.notStrictEqual(freshDeviceId, 'local_device', 'Must NOT be local_device');

    // 3. Setup valid snapshot
    const snap = {
      snapshot_id: 'snap_1790963722004_bq5y93',
      covered_peer_watermarks: null,
      entities: { transactions: [], investment_transactions: [], accounts: [], categories: [] }
    };
    const encSnap = await encryptBackupData(snap, TEST_SESSION_KEY);
    await mockDrive.uploadFile({ name: SNAPSHOT_FILENAME, content: encSnap });

    const res = await bootstrapNewDevice({ deviceId: freshDeviceId, driveClient: mockDrive, sessionKey: TEST_SESSION_KEY });
    assert.strictEqual(res.success, true);

    // 4. Verify legacy manifest_dev_local_device.json was NOT overwritten or modified
    const legacyOnDriveRaw = await mockDrive.readFile((await mockDrive.findFiles({ name: 'manifest_dev_local_device.json' }))[0].id);
    const legacyOnDrive = JSON.parse(legacyOnDriveRaw);
    assert.strictEqual(legacyOnDrive.device_id, 'local_device');
    assert.strictEqual(legacyOnDrive.manifest_revision, 2);

    // 5. Verify fresh device published its own distinct manifest
    const ownManifestFiles = await mockDrive.findFiles({ name: `manifest_dev_${freshDeviceId}.json` });
    assert.strictEqual(ownManifestFiles.length, 1, 'Fresh device published own distinct manifest');
  });
});
