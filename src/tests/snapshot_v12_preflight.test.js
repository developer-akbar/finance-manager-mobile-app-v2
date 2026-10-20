/**
 * snapshot_v12_preflight.test.js — Read-Only Cloud Pre-Flight Verification Test Suite
 * 
 * Verifies:
 * 1. Happy Path: Read-only inspection of Snapshot v12, Device D manifest, and sequence-16 package.
 * 2. Missing Snapshot File: Fails closed with SNAPSHOT_NOT_FOUND without mutating database.
 * 3. Expired / Missing Authorization: Fails closed with MISSING_PARAMETERS without scraping storage.
 * 4. Missing Peer Manifest: Fails closed with PEER_MANIFEST_NOT_FOUND.
 * 5. Incompatible Peer Baseline: Fails closed with INCOMPATIBLE_BASELINE when peer baseline diverges.
 * 6. Sequence Gap: Fails closed with SEQUENCE_GAP_DETECTED when package does not match watermark + 1.
 * 7. Package Checksum Mismatch: Fails closed with CHECKSUM_MISMATCH when package is corrupted.
 * 8. Missing Target Event: Fails closed with TARGET_EVENT_NOT_FOUND when event 16 is absent.
 * 9. Strictly Read-Only Invariant: Database tables, settings, watermarks, and Drive files remain 100% untouched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { initDB, getDB, getRawIDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import { encryptBackupData } from '../utils/cryptoBackup.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import { txnObjectToDBRow } from '../services/cloudSyncEngine.js';
import {
  preflightSnapshotV12Reconciliation,
  SNAPSHOT_IMPORT_ERROR_CODES,
  SnapshotImportError,
  V12_TARGET_REFERENCE
} from '../services/snapshotDeviceImport.js';
import { encryptDeltaPackage, computePackageChecksum } from '../services/deltaTransport.js';

const DEVICE_A_ID = 'dev_fa18ce0c9349';
const DEVICE_D_ID = 'dev_a30fb118cec0';
const TARGET_TXN_ID = 'afd13723-b454-48a6-9ecf-9a184fc7cdc0';
const TARGET_EVENT_ID = '0c3138df-5af6-4c60-81d4-6daddf1d8b7b';

const SNAP_V11_ID = 'snap_1791971845415_ehhvql';
const SNAP_V12_ID = 'snap_1792067106302_gdxzub';
const TEST_PIN = '7890';
const MOCK_TOKEN = 'mock_valid_token_123';

/**
 * Creates synthetic Snapshot v11 fixture
 */
function createSyntheticV11Fixture() {
  const transactions = [
    {
      id: TARGET_TXN_ID,
      Date: '2026-10-06',
      Time: '16:59',
      Account: 'Lend',
      Category: 'Lend',
      Subcategory: '',
      Note: 'Test loan expense',
      Description: 'Loan expense',
      INR: 132,
      'Income/Expense': 'Expense',
      type: 'Expense',
      created_at: '2026-10-06T16:59:12.885Z',
      updated_at: '2026-10-06T16:59:12.885Z',
      tags: '#loan'
    },
    {
      id: 'txn_v11_sample_1',
      Date: '2026-10-05',
      Time: '10:00',
      Account: 'Cash',
      Category: 'Food',
      Subcategory: 'Lunch',
      Note: 'Lunch expense',
      Description: 'Lunch',
      INR: 50,
      'Income/Expense': 'Expense',
      type: 'Expense',
      created_at: '2026-10-05T10:00:00.000Z',
      updated_at: '2026-10-05T10:00:00.000Z'
    }
  ];

  const accounts = [
    { id: 'Lend', name: 'Lend', type: 'Bank Accounts', group: 'Loans', currency: 'INR' },
    { id: 'Stock', name: 'Stock', type: 'Bank Accounts', group: 'Trading', currency: 'INR' },
    { id: 'Cash', name: 'Cash', type: 'Cash', group: 'Cash', currency: 'INR' }
  ];

  const categories = [
    { id: 'Lend', name: 'Lend', type: 'Expense' },
    { id: 'Food', name: 'Food', type: 'Expense' },
    { id: 'Transfer', name: 'Transfer', type: 'Transfer' }
  ];

  return {
    snapshot_id: SNAP_V11_ID,
    cloud_version: 11,
    schema_version: 13,
    parent_snapshot_id: 'snap_1791810470667_candidate_v10',
    device_id: 'dev_v11_creator',
    created_at: '2026-10-13T12:00:00Z',
    covered_peer_watermarks: {
      [DEVICE_D_ID]: 15
    },
    entities: {
      transactions,
      investment_transactions: [],
      accounts,
      categories,
      subcategories: [],
      account_groups: [
        { id: 'Loans', name: 'Loans', order: 1 },
        { id: 'Cash', name: 'Cash', order: 2 }
      ],
      inventory: [
        { id: 'item_1', name: 'Sugar', qty: 5, price: 40 }
      ],
      brokerages: []
    }
  };
}

/**
 * Creates synthetic Snapshot v12 fixture
 */
function createSyntheticV12Fixture() {
  const v11 = createSyntheticV11Fixture();

  return {
    snapshot_id: SNAP_V12_ID,
    cloud_version: 12,
    schema_version: 13,
    parent_snapshot_id: SNAP_V11_ID,
    device_id: 'dev_v12_creator',
    created_at: '2026-10-14T12:25:06Z',
    covered_peer_watermarks: {
      [DEVICE_D_ID]: 15
    },
    entities: {
      ...v11.entities,
      transactions: [
        ...v11.entities.transactions,
        {
          id: 'txn_v12_extra_1',
          Date: '2026-10-14',
          Time: '11:00',
          Account: 'Cash',
          Category: 'Food',
          INR: 80,
          'Income/Expense': 'Expense',
          type: 'Expense',
          created_at: '2026-10-14T11:00:00.000Z',
          updated_at: '2026-10-14T11:00:00.000Z'
        }
      ]
    }
  };
}

/**
 * Seeds Device A on baseline Snapshot v11 with target transaction as Expense
 */
async function seedDeviceABaseline(db) {
  const v11 = createSyntheticV11Fixture();

  for (const t of v11.entities.transactions) {
    const row = txnObjectToDBRow(t);
    await db.run(
      'INSERT OR REPLACE INTO transactions (id, date, time, account, category, note, description, inr, amount, type, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.date, row.time, row.account, row.category, row.note, row.description, row.inr, row.amount, row.type, row.tags, row.created_at, row.updated_at]
    );
  }
  for (const a of v11.entities.accounts) {
    await db.run('INSERT OR REPLACE INTO accounts (id, name, group_name) VALUES (?, ?, ?)', [a.id, a.name, a.group]);
  }
  for (const c of v11.entities.categories) {
    await db.run('INSERT OR REPLACE INTO categories (id, name, type) VALUES (?, ?, ?)', [c.id, c.name, c.type]);
  }
  for (const inv of v11.entities.inventory) {
    await db.run('INSERT OR REPLACE INTO inventory (id, name, qty, price) VALUES (?, ?, ?, ?)', [inv.id, inv.name, inv.qty, inv.price]);
  }

  const rawIdb = getRawIDB();
  const now = new Date().toISOString();
  if (rawIdb) {
    await new Promise((resolve, reject) => {
      const tx = rawIdb.transaction(['sync_local_state', 'sync_peer_state'], 'readwrite');
      tx.objectStore('sync_local_state').put({
        key: 'device_state',
        deviceId: DEVICE_A_ID,
        device_id: DEVICE_A_ID,
        base_snapshot_id: SNAP_V11_ID,
        base_cloud_version: 11,
        last_allocated_sequence: 0,
        last_uploaded_sequence: 0,
        last_pushed_sequence: 0,
        last_acked_sequence: 0,
        lifecycle_state: 'ACTIVE',
        updated_at: now
      });
      tx.objectStore('sync_peer_state').put({
        peer_device_id: DEVICE_D_ID,
        last_staged_sequence: 15,
        last_reconciled_sequence: 15,
        base_snapshot_id: SNAP_V11_ID,
        updated_at: now
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  await setSetting('last_snapshot_id', SNAP_V11_ID, { suppressDeltaQueue: true });
  await setSetting('last_parent_snapshot_id', 'snap_1791810470667_candidate_v10', { suppressDeltaQueue: true });
  await setSetting('device_lifecycle_state', 'ACTIVE', { suppressDeltaQueue: true });
}

/**
 * Builds package 16 payload and container
 */
async function buildMockPackage16(db, pin = TEST_PIN) {
  const res = await db.query('SELECT * FROM transactions WHERE id = ?', [TARGET_TXN_ID]);
  const baseRow = res.values[0];
  const baseChecksum = await computeCanonicalSha256(baseRow);

  const updatedPayload = {
    ...baseRow,
    account: 'Stock',
    from_account: 'Stock',
    to_account: 'Lend',
    category: 'Transfer',
    type: 'Transfer',
    transfer_type: 'out',
    inr: 132,
    amount: '132',
    updated_at: '2026-10-15T12:02:40.009Z'
  };
  const newChecksum = await computeCanonicalSha256(updatedPayload);

  const event16 = {
    event_id: TARGET_EVENT_ID,
    device_id: DEVICE_D_ID,
    sequence: 16,
    timestamp: '2026-10-15T12:02:40.009Z',
    collection: 'transactions',
    entity_id: TARGET_TXN_ID,
    operation: 'UPDATE',
    base_checksum: baseChecksum,
    new_checksum: newChecksum,
    tombstone_generation: 0,
    payload: updatedPayload,
    bundle_id: null,
    bundle_index: 0,
    bundle_total: 1,
    bundle_checksum: null,
    parent_event_id: null
  };

  const packagePayload = {
    schema_version: 1,
    package_id: `pkg_${DEVICE_D_ID}_000016_000016`,
    device_id: DEVICE_D_ID,
    base_snapshot_id: SNAP_V12_ID,
    base_cloud_version: 12,
    start_sequence: 16,
    end_sequence: 16,
    event_count: 1,
    events: [event16]
  };

  const encryptedContainer = await encryptDeltaPackage(packagePayload, pin);
  return { packagePayload, encryptedContainer };
}

/**
 * Creates Mock Drive Client tracking write operations
 */
function createMockDriveClient(files = {}) {
  const writeOps = [];
  return {
    files,
    writeOps,
    findAppDataFile: async (name, token) => {
      if (files[name]) return { id: files[name].id, name };
      return null;
    },
    findFiles: async ({ name }) => {
      if (name && files[name]) return [{ id: files[name].id, name }];
      return [];
    },
    readAppDataFile: async (id, token) => {
      const file = Object.values(files).find(f => f.id === id);
      if (!file) throw new Error(`File not found: ${id}`);
      return file.content;
    },
    readFile: async (id) => {
      const file = Object.values(files).find(f => f.id === id);
      if (!file) throw new Error(`File not found: ${id}`);
      return file.content;
    },
    uploadAppDataFile: async (name, content) => {
      writeOps.push({ op: 'UPLOAD', name });
      throw new Error('READ_ONLY_VIOLATION: uploadAppDataFile called during preflight!');
    },
    uploadFile: async ({ name }) => {
      writeOps.push({ op: 'UPLOAD', name });
      throw new Error('READ_ONLY_VIOLATION: uploadFile called during preflight!');
    },
    deleteAppDataFile: async (id) => {
      writeOps.push({ op: 'DELETE', id });
      throw new Error('READ_ONLY_VIOLATION: deleteAppDataFile called during preflight!');
    }
  };
}

test('FinMan Phase 14 — Snapshot v12 Read-Only Cloud Pre-Flight Test Suite', async (t) => {
  let db;

  t.beforeEach(async () => {
    indexedDB._databases?.clear?.();
    db = await initDB();
    await seedDeviceABaseline(db);
  });

  await t.test('TEST 1: Happy Path — Pre-flight successfully retrieves and verifies Snapshot v12, Manifest D, and sequence 16', async () => {
    const v12 = createSyntheticV12Fixture();
    const v12Ciphertext = await encryptBackupData(v12, TEST_PIN);
    const { packagePayload, encryptedContainer } = await buildMockPackage16(db, TEST_PIN);

    const manifestD = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: DEVICE_D_ID,
      base_snapshot_id: SNAP_V12_ID,
      base_cloud_version: 12,
      last_sequence: 16,
      packages: [
        {
          package_id: packagePayload.package_id,
          start_sequence: 16,
          end_sequence: 16,
          event_count: 1,
          package_checksum: encryptedContainer.package_checksum,
          drive_file_id: 'drive_file_pkg_16'
        }
      ]
    };

    const mockDrive = createMockDriveClient({
      'finman_cloud_sync_snapshot.finman': {
        id: 'drive_file_snap_v12',
        content: v12Ciphertext
      },
      [`manifest_dev_${DEVICE_D_ID}.json`]: {
        id: 'drive_file_manifest_d',
        content: JSON.stringify(manifestD)
      },
      'pkg_16': {
        id: 'drive_file_pkg_16',
        content: JSON.stringify(encryptedContainer)
      }
    });

    const result = await preflightSnapshotV12Reconciliation({
      accessToken: MOCK_TOKEN,
      pin: TEST_PIN,
      driveClient: mockDrive,
      dbInstance: db,
      peerDeviceId: DEVICE_D_ID,
      targetEventId: TARGET_EVENT_ID,
      targetSequence: 16,
      expectedLocalWatermark: 15
    });

    assert.equal(result.ready, true);
    assert.equal(result.status, 'PREFLIGHT_PASS');
    assert.equal(result.snapshot.snapshotId, SNAP_V12_ID);
    assert.equal(result.snapshot.cloudVersion, 12);
    assert.equal(result.peerManifest.deviceId, DEVICE_D_ID);
    assert.equal(result.peerManifest.baseSnapshotId, SNAP_V12_ID);
    assert.equal(result.peerManifest.isBaselineCompatible, true);
    assert.equal(result.package.startSequence, 16);
    assert.equal(result.package.continuityValid, true);
    assert.equal(result.package.checksumValid, true);
    assert.equal(result.targetEvent.eventId, TARGET_EVENT_ID);
    assert.equal(result.targetEvent.sequence, 16);
    assert.equal(result.targetEvent.operation, 'UPDATE');
    assert.equal(result.targetEvent.collection, 'transactions');
    assert.equal(result.deviceA.deviceId, DEVICE_A_ID);
    assert.equal(result.deviceA.reconciledWatermark, 15);
    assert.equal(result.deviceA.targetTransaction.currentType, 'Expense');
    assert.equal(mockDrive.writeOps.length, 0, 'Zero write operations permitted');
  });

  await t.test('TEST 2: Missing Snapshot File — Rejects with SNAPSHOT_NOT_FOUND', async () => {
    const mockDrive = createMockDriveClient({}); // Empty Drive

    await assert.rejects(
      async () => {
        await preflightSnapshotV12Reconciliation({
          accessToken: MOCK_TOKEN,
          pin: TEST_PIN,
          driveClient: mockDrive,
          dbInstance: db
        });
      },
      (err) => {
        assert.ok(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.SNAPSHOT_NOT_FOUND);
        return true;
      }
    );

    assert.equal(mockDrive.writeOps.length, 0);
  });

  await t.test('TEST 3: Missing / Expired Access Token — Rejects with MISSING_PARAMETERS', async () => {
    await assert.rejects(
      async () => {
        await preflightSnapshotV12Reconciliation({
          accessToken: null,
          pin: TEST_PIN,
          driveClient: null,
          dbInstance: db
        });
      },
      (err) => {
        assert.ok(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.MISSING_PARAMETERS);
        return true;
      }
    );
  });

  await t.test('TEST 4: Missing Peer Manifest — Rejects with PEER_MANIFEST_NOT_FOUND', async () => {
    const v12 = createSyntheticV12Fixture();
    const v12Ciphertext = await encryptBackupData(v12, TEST_PIN);

    const mockDrive = createMockDriveClient({
      'finman_cloud_sync_snapshot.finman': {
        id: 'drive_file_snap_v12',
        content: v12Ciphertext
      }
      // Manifest omitted
    });

    await assert.rejects(
      async () => {
        await preflightSnapshotV12Reconciliation({
          accessToken: MOCK_TOKEN,
          pin: TEST_PIN,
          driveClient: mockDrive,
          dbInstance: db,
          peerDeviceId: DEVICE_D_ID
        });
      },
      (err) => {
        assert.ok(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.PEER_MANIFEST_NOT_FOUND);
        return true;
      }
    );

    assert.equal(mockDrive.writeOps.length, 0);
  });

  await t.test('TEST 5: Incompatible Peer Baseline — Rejects with INCOMPATIBLE_BASELINE', async () => {
    const v12 = createSyntheticV12Fixture();
    const v12Ciphertext = await encryptBackupData(v12, TEST_PIN);

    const manifestDIncompatible = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: DEVICE_D_ID,
      base_snapshot_id: 'snap_ancient_unrelated_v7',
      base_cloud_version: 7,
      last_sequence: 16,
      packages: []
    };

    const mockDrive = createMockDriveClient({
      'finman_cloud_sync_snapshot.finman': {
        id: 'drive_file_snap_v12',
        content: v12Ciphertext
      },
      [`manifest_dev_${DEVICE_D_ID}.json`]: {
        id: 'drive_file_manifest_d',
        content: JSON.stringify(manifestDIncompatible)
      }
    });

    await assert.rejects(
      async () => {
        await preflightSnapshotV12Reconciliation({
          accessToken: MOCK_TOKEN,
          pin: TEST_PIN,
          driveClient: mockDrive,
          dbInstance: db,
          peerDeviceId: DEVICE_D_ID
        });
      },
      (err) => {
        assert.ok(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.INCOMPATIBLE_BASELINE);
        return true;
      }
    );

    assert.equal(mockDrive.writeOps.length, 0);
  });

  await t.test('TEST 6: Sequence Gap — Rejects with SEQUENCE_GAP_DETECTED when package does not follow watermark', async () => {
    const v12 = createSyntheticV12Fixture();
    const v12Ciphertext = await encryptBackupData(v12, TEST_PIN);

    const manifestDWithGap = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: DEVICE_D_ID,
      base_snapshot_id: SNAP_V12_ID,
      base_cloud_version: 12,
      last_sequence: 18,
      packages: [
        {
          package_id: `pkg_${DEVICE_D_ID}_000017_000018`,
          start_sequence: 17, // Gap! Watermark is 15, expected 16
          end_sequence: 18,
          event_count: 2,
          package_checksum: 'checksum_gap'
        }
      ]
    };

    const mockDrive = createMockDriveClient({
      'finman_cloud_sync_snapshot.finman': {
        id: 'drive_file_snap_v12',
        content: v12Ciphertext
      },
      [`manifest_dev_${DEVICE_D_ID}.json`]: {
        id: 'drive_file_manifest_d',
        content: JSON.stringify(manifestDWithGap)
      }
    });

    await assert.rejects(
      async () => {
        await preflightSnapshotV12Reconciliation({
          accessToken: MOCK_TOKEN,
          pin: TEST_PIN,
          driveClient: mockDrive,
          dbInstance: db,
          peerDeviceId: DEVICE_D_ID,
          targetSequence: 17,
          expectedLocalWatermark: 15
        });
      },
      (err) => {
        assert.ok(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.SEQUENCE_GAP_DETECTED);
        return true;
      }
    );

    assert.equal(mockDrive.writeOps.length, 0);
  });

  await t.test('TEST 7: Package Checksum Mismatch — Rejects with CHECKSUM_MISMATCH when package is tampered', async () => {
    const v12 = createSyntheticV12Fixture();
    const v12Ciphertext = await encryptBackupData(v12, TEST_PIN);
    const { packagePayload, encryptedContainer } = await buildMockPackage16(db, TEST_PIN);

    // Tamper with package container
    const tamperedContainer = {
      ...encryptedContainer,
      package_checksum: 'tampered_declared_checksum_999'
    };

    const manifestD = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: DEVICE_D_ID,
      base_snapshot_id: SNAP_V12_ID,
      base_cloud_version: 12,
      last_sequence: 16,
      packages: [
        {
          package_id: packagePayload.package_id,
          start_sequence: 16,
          end_sequence: 16,
          event_count: 1,
          package_checksum: 'tampered_declared_checksum_999',
          drive_file_id: 'drive_file_pkg_16'
        }
      ]
    };

    const mockDrive = createMockDriveClient({
      'finman_cloud_sync_snapshot.finman': {
        id: 'drive_file_snap_v12',
        content: v12Ciphertext
      },
      [`manifest_dev_${DEVICE_D_ID}.json`]: {
        id: 'drive_file_manifest_d',
        content: JSON.stringify(manifestD)
      },
      'pkg_16': {
        id: 'drive_file_pkg_16',
        content: JSON.stringify(tamperedContainer)
      }
    });

    await assert.rejects(
      async () => {
        await preflightSnapshotV12Reconciliation({
          accessToken: MOCK_TOKEN,
          pin: TEST_PIN,
          driveClient: mockDrive,
          dbInstance: db,
          peerDeviceId: DEVICE_D_ID,
          targetEventId: TARGET_EVENT_ID,
          targetSequence: 16,
          expectedLocalWatermark: 15
        });
      },
      (err) => {
        assert.ok(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.CHECKSUM_MISMATCH);
        return true;
      }
    );

    assert.equal(mockDrive.writeOps.length, 0);
  });

  await t.test('TEST 8: Target Event Not Found in Package — Rejects with TARGET_EVENT_NOT_FOUND', async () => {
    const v12 = createSyntheticV12Fixture();
    const v12Ciphertext = await encryptBackupData(v12, TEST_PIN);

    // Package 16 has sequence 16 but different event ID
    const dummyEvent = {
      event_id: 'different_unrelated_event_id',
      device_id: DEVICE_D_ID,
      sequence: 16,
      timestamp: '2026-10-15T12:02:40.009Z',
      collection: 'transactions',
      entity_id: 'different_txn_id',
      operation: 'UPDATE',
      base_checksum: 'abc',
      new_checksum: 'def',
      tombstone_generation: 0,
      payload: { id: 'different_txn_id', type: 'Expense' }
    };

    const dummyPackage = {
      schema_version: 1,
      package_id: `pkg_${DEVICE_D_ID}_000016_000016`,
      device_id: DEVICE_D_ID,
      base_snapshot_id: SNAP_V12_ID,
      base_cloud_version: 12,
      start_sequence: 16,
      end_sequence: 16,
      event_count: 1,
      events: [dummyEvent]
    };

    const dummyEncrypted = await encryptDeltaPackage(dummyPackage, TEST_PIN);

    const manifestD = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: DEVICE_D_ID,
      base_snapshot_id: SNAP_V12_ID,
      base_cloud_version: 12,
      last_sequence: 16,
      packages: [
        {
          package_id: dummyPackage.package_id,
          start_sequence: 16,
          end_sequence: 16,
          event_count: 1,
          package_checksum: dummyEncrypted.package_checksum,
          drive_file_id: 'drive_file_pkg_16'
        }
      ]
    };

    const mockDrive = createMockDriveClient({
      'finman_cloud_sync_snapshot.finman': {
        id: 'drive_file_snap_v12',
        content: v12Ciphertext
      },
      [`manifest_dev_${DEVICE_D_ID}.json`]: {
        id: 'drive_file_manifest_d',
        content: JSON.stringify(manifestD)
      },
      'pkg_16': {
        id: 'drive_file_pkg_16',
        content: JSON.stringify(dummyEncrypted)
      }
    });

    await assert.rejects(
      async () => {
        await preflightSnapshotV12Reconciliation({
          accessToken: MOCK_TOKEN,
          pin: TEST_PIN,
          driveClient: mockDrive,
          dbInstance: db,
          peerDeviceId: DEVICE_D_ID,
          targetEventId: TARGET_EVENT_ID, // expecting TARGET_EVENT_ID
          targetSequence: 16,
          expectedLocalWatermark: 15
        });
      },
      (err) => {
        assert.ok(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.TARGET_EVENT_NOT_FOUND);
        return true;
      }
    );

    assert.equal(mockDrive.writeOps.length, 0);
  });

  await t.test('TEST 9: Strictly Read-Only Invariant — Asserts zero local database mutations and zero Drive writes', async () => {
    // 1. Snapshot initial local database state
    const initialTxns = (await db.query('SELECT * FROM transactions')).values;
    const initialSettings = (await db.query('SELECT * FROM settings')).values;
    const initialPeerState = (await db.query('SELECT * FROM sync_peer_state')).values;
    const initialLocalState = (await db.query('SELECT * FROM sync_local_state')).values;

    const v12 = createSyntheticV12Fixture();
    const v12Ciphertext = await encryptBackupData(v12, TEST_PIN);
    const { packagePayload, encryptedContainer } = await buildMockPackage16(db, TEST_PIN);

    const manifestD = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: DEVICE_D_ID,
      base_snapshot_id: SNAP_V12_ID,
      base_cloud_version: 12,
      last_sequence: 16,
      packages: [
        {
          package_id: packagePayload.package_id,
          start_sequence: 16,
          end_sequence: 16,
          event_count: 1,
          package_checksum: encryptedContainer.package_checksum,
          drive_file_id: 'drive_file_pkg_16'
        }
      ]
    };

    const mockDrive = createMockDriveClient({
      'finman_cloud_sync_snapshot.finman': {
        id: 'drive_file_snap_v12',
        content: v12Ciphertext
      },
      [`manifest_dev_${DEVICE_D_ID}.json`]: {
        id: 'drive_file_manifest_d',
        content: JSON.stringify(manifestD)
      },
      'pkg_16': {
        id: 'drive_file_pkg_16',
        content: JSON.stringify(encryptedContainer)
      }
    });

    // Run preflight
    await preflightSnapshotV12Reconciliation({
      accessToken: MOCK_TOKEN,
      pin: TEST_PIN,
      driveClient: mockDrive,
      dbInstance: db,
      peerDeviceId: DEVICE_D_ID,
      targetEventId: TARGET_EVENT_ID,
      targetSequence: 16,
      expectedLocalWatermark: 15
    });

    // 2. Assert zero Drive writes
    assert.equal(mockDrive.writeOps.length, 0, 'Zero Drive mutations must occur during preflight');

    // 3. Assert zero local database mutations
    const postTxns = (await db.query('SELECT * FROM transactions')).values;
    const postSettings = (await db.query('SELECT * FROM settings')).values;
    const postPeerState = (await db.query('SELECT * FROM sync_peer_state')).values;
    const postLocalState = (await db.query('SELECT * FROM sync_local_state')).values;

    assert.deepEqual(postTxns, initialTxns, 'transactions table must be completely unchanged');
    assert.deepEqual(postSettings, initialSettings, 'settings table must be completely unchanged');
    assert.deepEqual(postPeerState, initialPeerState, 'sync_peer_state must be completely unchanged');
    assert.deepEqual(postLocalState, initialLocalState, 'sync_local_state must be completely unchanged');

    // Check target transaction still has original type Expense
    const targetRow = postTxns.find(t => t.id === TARGET_TXN_ID);
    assert.equal(targetRow.type, 'Expense', 'Target transaction must not be mutated by preflight');
  });

  await t.test('TEST 10: Real-World Incident Case — Manifest with Snapshot v9 baseline (snap_1790963722004_bq5y93) is recognized as ancestral baseline', async () => {
    const v12 = createSyntheticV12Fixture();
    const v12Ciphertext = await encryptBackupData(v12, TEST_PIN);
    const { packagePayload, encryptedContainer } = await buildMockPackage16(db, TEST_PIN);

    // Manifest D with real-world base_snapshot_id from Snapshot v9
    const manifestD = {
      schema_version: 1,
      manifest_type: 'DEVICE_MANIFEST',
      device_id: DEVICE_D_ID,
      base_snapshot_id: 'snap_1790963722004_bq5y93', // The real-world v9 baseline!
      base_cloud_version: 9,
      last_sequence: 16,
      packages: [
        {
          package_id: packagePayload.package_id,
          start_sequence: 16,
          end_sequence: 16,
          event_count: 1,
          package_checksum: encryptedContainer.package_checksum,
          drive_file_id: 'drive_file_pkg_16'
        }
      ]
    };

    const mockDrive = createMockDriveClient({
      'finman_cloud_sync_snapshot.finman': {
        id: 'drive_file_snap_v12',
        content: v12Ciphertext
      },
      [`manifest_dev_${DEVICE_D_ID}.json`]: {
        id: 'drive_file_manifest_d',
        content: JSON.stringify(manifestD)
      },
      'pkg_16': {
        id: 'drive_file_pkg_16',
        content: JSON.stringify(encryptedContainer)
      }
    });

    const result = await preflightSnapshotV12Reconciliation({
      accessToken: MOCK_TOKEN,
      pin: TEST_PIN,
      driveClient: mockDrive,
      dbInstance: db,
      peerDeviceId: DEVICE_D_ID,
      targetEventId: TARGET_EVENT_ID,
      targetSequence: 16,
      expectedLocalWatermark: 15
    });

    assert.equal(result.ready, true);
    assert.equal(result.status, 'PREFLIGHT_PASS');
    assert.equal(result.peerManifest.baseSnapshotId, 'snap_1790963722004_bq5y93');
    assert.equal(result.peerManifest.isBaselineCompatible, true);
    assert.equal(result.package.startSequence, 16);
    assert.equal(result.package.checksumValid, true);
    assert.equal(result.targetEvent.eventId, TARGET_EVENT_ID);
    assert.equal(result.targetEvent.payload.type, 'Transfer');

    const manifestCheck = result.checks.find(c => c.name === 'PEER_MANIFEST_AND_BASELINE');
    assert.equal(manifestCheck.status, 'WARN_ANCESTRAL_BASELINE');
    assert.equal(manifestCheck.details.lineageType, 'ANCESTRAL_V9');
    assert.ok(manifestCheck.details.rootCauseAnalysis.includes('snap_1790963722004_bq5y93'));
  });
});
