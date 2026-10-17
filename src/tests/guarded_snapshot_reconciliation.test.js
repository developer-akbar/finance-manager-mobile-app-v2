/**
 * guarded_snapshot_reconciliation.test.js
 * 
 * Comprehensive Isolated Test Suite for Guarded Existing-Device Snapshot Reconciliation:
 * 1. Snapshot v11 to v12 reconciliation
 * 2. Successful application of sequence 16 (Expense to Transfer-Out)
 * 3. Backup verification failure (fail-closed guard)
 * 4. Snapshot validation failure (trustworthy metadata & integrity checks)
 * 5. Mid-recovery failure and full rollback
 * 6. Preservation of local-only records and pending events (quarantine & rollback restoration)
 * 7. Duplicate package/event delivery (idempotency & replay safety)
 * 8. Checksum mismatch and sequence gaps
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import test from 'node:test';
import assert from 'node:assert/strict';

import { initDB, getDB, closeDB, getRawIDB } from '../database/db.js';
import { getSetting, setSetting } from '../database/settings.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import { txnObjectToDBRow } from '../services/cloudSyncEngine.js';
import {
  reconcileExistingDeviceWithSnapshot,
  validateTrustworthySnapshotPayload,
  createDurablePreImportBackup,
  restorePreImportBackup,
  verifyLocalRecoveryState,
  getQuarantinedDeltas,
  SNAPSHOT_IMPORT_ERROR_CODES,
  SnapshotImportError,
  V12_TARGET_REFERENCE
} from '../services/snapshotDeviceImport.js';
import { readLocalEntities } from '../services/cloudSyncEngine.js';
import { stagePeerPackageAtomically } from '../services/deltaTransport.js';
import { reconcileStagedEvents } from '../services/deltaReconciliation.js';

const DEVICE_A_ID = 'dev_fa18ce0c9349';
const DEVICE_D_ID = 'dev_a30fb118cec0';
const TARGET_TXN_ID = 'afd13723-b454-48a6-9ecf-9a184fc7cdc0';
const TARGET_EVENT_ID = '0c3138df-5af6-4c60-81d4-6daddf1d8b7b';

const SNAP_V11_ID = 'snap_1791971845415_ehhvql';
const SNAP_V12_ID = 'snap_1792067106302_gdxzub';

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
 * Creates synthetic Snapshot v12 fixture matching V12_TARGET_REFERENCE
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
 * Seeds Device A on baseline Snapshot v11
 */
async function seedDeviceABaseline(db) {
  const v11 = createSyntheticV11Fixture();

  // Populate operational entities
  for (const t of v11.entities.transactions) {
    const row = txnObjectToDBRow(t);
    await db.run(
      'INSERT OR REPLACE INTO transactions (id, date, time, account, category, note, description, inr, amount, type, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.date, row.time, row.account, row.category, row.note, row.description, row.inr, row.amount, row.type, row.tags]
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

  // Seed sync state
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
 * Builds package 16 from Device D representing the Expense -> Transfer-Out edit
 */
async function buildPackage16(db) {
  // Query current base transaction from DB to compute exact canonical base checksum
  const res = await db.query('SELECT * FROM transactions WHERE id = ?', [TARGET_TXN_ID]);
  const baseRow = res.values[0];
  assert.ok(baseRow, 'Target transaction must exist in DB');
  const baseChecksum = await computeCanonicalSha256(baseRow);

  const updatedPayload = {
    ...baseRow,
    account: 'Stock',
    from_account: 'Stock',
    to_account: 'Lend',
    category: 'Transfer',
    type: 'Transfer-Out',
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

  return {
    packagePayload,
    packageChecksum: 'checksum_pkg_16_valid'
  };
}

test('FinMan Phase 13 — Guarded Snapshot Reconciliation Test Suite', async (t) => {
  let db;

  t.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    db = await initDB();
  });

  t.afterEach(async () => {
    closeDB();
  });

  await t.test('SCENARIO 1: Snapshot v11 to v12 reconciliation preserves Device A identity and seeds peer D watermark to 15', async () => {
    await seedDeviceABaseline(db);

    const v12 = createSyntheticV12Fixture();

    const result = await reconcileExistingDeviceWithSnapshot({
      dbInstance: db,
      deviceId: DEVICE_A_ID,
      snapshotPayload: v12,
      confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
      replayInboundDeltas: false
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'RECONCILIATION_SUCCESS');
    assert.equal(result.snapshotId, SNAP_V12_ID);
    assert.equal(result.cloudVersion, 12);
    assert.equal(result.deviceId, DEVICE_A_ID, 'Device A persistent identity must be preserved');

    // Verify local sequence state in DB
    const localStateRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
    const localState = localStateRes.values?.[0];
    assert.ok(localState);
    assert.equal(localState.device_id, DEVICE_A_ID, 'Must keep Device A ID in sync_local_state');
    assert.equal(localState.base_snapshot_id, SNAP_V12_ID);
    assert.equal(localState.base_cloud_version, 12);
    assert.equal(Number(localState.last_allocated_sequence), 0);

    // Verify peer D watermark is preserved at sequence 15 under baseline v12
    const peerRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [DEVICE_D_ID]);
    const peerD = peerRes.values?.[0];
    assert.ok(peerD);
    assert.equal(Number(peerD.last_staged_sequence), 15);
    assert.equal(Number(peerD.last_reconciled_sequence), 15);
    assert.equal(peerD.base_snapshot_id, SNAP_V12_ID);

    // Verify settings updated
    assert.equal(await getSetting('last_snapshot_id'), SNAP_V12_ID);
    assert.equal(await getSetting('last_parent_snapshot_id'), SNAP_V11_ID);
  });

  await t.test('SCENARIO 2: Successful application of sequence 16 transitions Expense to Transfer-Out cleanly via staging and reconciliation', async () => {
    await seedDeviceABaseline(db);
    const v12 = createSyntheticV12Fixture();

    // Verify initial transaction state before reconcile: Expense
    const initTxnRes = await db.query('SELECT * FROM transactions WHERE id = ?', [TARGET_TXN_ID]);
    assert.equal(initTxnRes.values[0].type, 'Expense');
    assert.equal(initTxnRes.values[0].account, 'Lend');

    // First install v12 baseline so we can compute the valid package 16 against it
    await reconcileExistingDeviceWithSnapshot({
      dbInstance: db,
      deviceId: DEVICE_A_ID,
      snapshotPayload: v12,
      confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
      replayInboundDeltas: false
    });

    // Build package 16 with exact canonical checksums of the installed transaction
    const pkg16 = await buildPackage16(db);

    // Now execute reconciliation pipeline with package 16
    const result = await reconcileExistingDeviceWithSnapshot({
      dbInstance: db,
      deviceId: DEVICE_A_ID,
      snapshotPayload: v12,
      confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
      inboundPackages: [pkg16],
      inboundPeerDeviceId: DEVICE_D_ID,
      replayInboundDeltas: true
    });

    assert.equal(result.success, true);
    assert.equal(result.reconciledDeltasCount, 1, 'Exactly 1 delta must be reconciled');

    // Verify target transaction is now Transfer-Out
    const finalTxnRes = await db.query('SELECT * FROM transactions WHERE id = ?', [TARGET_TXN_ID]);
    const finalTxn = finalTxnRes.values[0];
    assert.equal(finalTxn.type, 'Transfer-Out');
    assert.equal(finalTxn.account, 'Stock');
    assert.equal(finalTxn.from_account, 'Stock');
    assert.equal(finalTxn.to_account, 'Lend');
    assert.equal(Number(finalTxn.inr), 132);

    // Verify Device D peer watermark in sync_peer_state has advanced to sequence 16
    const peerRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [DEVICE_D_ID]);
    assert.equal(Number(peerRes.values[0].last_reconciled_sequence), 16);
    assert.equal(Number(peerRes.values[0].last_staged_sequence), 16);

    // Verify sync_staged_events status is RECONCILED_CLEAN
    const stagedRes = await db.query('SELECT * FROM sync_staged_events WHERE event_id = ?', [TARGET_EVENT_ID]);
    assert.equal(stagedRes.values[0].status, 'RECONCILED_CLEAN');
  });

  await t.test('SCENARIO 3: Backup verification failure fails closed before any mutations', async () => {
    await seedDeviceABaseline(db);
    const v12 = createSyntheticV12Fixture();

    // Intercept db.run to simulate disk quota/storage failure when writing durable backup
    const origRun = db.run.bind(db);
    db.run = async (sql, params) => {
      if (typeof sql === 'string' && params && params.includes('pre_recovery_durable_backup')) {
        throw new Error('SIMULATED_QUOTA_ERROR: Storage full during pre-backup creation');
      }
      return origRun(sql, params);
    };

    await assert.rejects(
      async () => {
        await reconcileExistingDeviceWithSnapshot({
          dbInstance: db,
          deviceId: DEVICE_A_ID,
          snapshotPayload: v12,
          confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE'
        });
      },
      (err) => {
        assert(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.PRE_BACKUP_FAILED);
        return true;
      }
    );

    // Assert: zero changes to database, snapshot remains v11
    assert.equal(await getSetting('last_snapshot_id'), SNAP_V11_ID);
    const txn = (await db.query('SELECT * FROM transactions WHERE id = ?', [TARGET_TXN_ID])).values[0];
    assert.equal(txn.type, 'Expense');
  });

  await t.test('SCENARIO 4: Snapshot validation failure rejects corrupt or regressive payloads before mutation', async () => {
    await seedDeviceABaseline(db);

    // 4a. Duplicate transaction ID in snapshot payload
    const corruptPayload = createSyntheticV12Fixture();
    corruptPayload.entities.transactions.push({
      id: TARGET_TXN_ID, // Duplicate!
      Date: '2026-10-06',
      INR: 999,
      type: 'Expense'
    });

    await assert.rejects(
      async () => {
        await reconcileExistingDeviceWithSnapshot({
          dbInstance: db,
          deviceId: DEVICE_A_ID,
          snapshotPayload: corruptPayload,
          confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE'
        });
      },
      (err) => {
        assert(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED);
        assert(err.message.includes('Duplicate transaction ID'));
        return true;
      }
    );

    // 4b. Regressive cloud version (v9 < active v11)
    const regressivePayload = createSyntheticV12Fixture();
    regressivePayload.cloud_version = 9;

    await assert.rejects(
      async () => {
        await reconcileExistingDeviceWithSnapshot({
          dbInstance: db,
          deviceId: DEVICE_A_ID,
          snapshotPayload: regressivePayload,
          confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE'
        });
      },
      (err) => {
        assert(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.VALIDATION_FAILED);
        assert(err.message.includes('older than active baseline'));
        return true;
      }
    );

    // Assert baseline remains v11 untouched
    assert.equal(await getSetting('last_snapshot_id'), SNAP_V11_ID);
  });

  await t.test('SCENARIO 5: Mid-recovery failure triggers automated rollback and restores full pre-recovery state', async () => {
    await seedDeviceABaseline(db);
    const v12 = createSyntheticV12Fixture();

    // Intercept db.batchReplace to crash during transaction insertion
    let crashTriggered = false;
    const origBatch = db.batchReplace?.bind(db);
    db.batchReplace = async (store, items) => {
      if (store === 'transactions' && !crashTriggered) {
        crashTriggered = true;
        throw new Error('SIMULATED_CRASH_MID_POPULATION: Database write failed mid-transaction');
      }
      return origBatch ? origBatch(store, items) : { replaced: items.length };
    };

    await assert.rejects(
      async () => {
        await reconcileExistingDeviceWithSnapshot({
          dbInstance: db,
          deviceId: DEVICE_A_ID,
          snapshotPayload: v12,
          confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE'
        });
      },
      (err) => {
        assert(err instanceof SnapshotImportError);
        assert.equal(err.code, SNAPSHOT_IMPORT_ERROR_CODES.ROLLBACK_TRIGGERED);
        assert(err.details.rollbackSuccess === true);
        return true;
      }
    );

    // Assert: full rollback restored v11 baseline
    assert.equal(await getSetting('last_snapshot_id'), SNAP_V11_ID);
    const entities = await readLocalEntities(db);
    assert.equal(entities.transactions.length, 2);
    const targetTxn = entities.transactions.find(t => t.id === TARGET_TXN_ID);
    assert.ok(targetTxn);
    assert.equal(targetTxn['Income/Expense'] || targetTxn.type, 'Expense');

    // verifyLocalRecoveryState confirms clean restoration
    const recCheck = await verifyLocalRecoveryState(db);
    assert.equal(recCheck.status, 'RECOVERED_MATCHES_BACKUP');
  });

  await t.test('SCENARIO 6: Preservation of local-only records and pending events (quarantined on success, restored on rollback)', async () => {
    await seedDeviceABaseline(db);

    // Add 2 pending unacknowledged events in sync_delta_queue
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_offline_1', DEVICE_A_ID, 1, '2026-10-14T08:00:00Z', 'transactions', 'txn_offline_1', 'INSERT', JSON.stringify({ inr: 450 }), 'PENDING']
    );
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_offline_2', DEVICE_A_ID, 2, '2026-10-14T08:05:00Z', 'transactions', 'txn_offline_2', 'UPDATE', JSON.stringify({ inr: 550 }), 'PENDING']
    );

    const v12 = createSyntheticV12Fixture();

    // 6a. Successful reconciliation quarantines pending deltas
    const res = await reconcileExistingDeviceWithSnapshot({
      dbInstance: db,
      deviceId: DEVICE_A_ID,
      snapshotPayload: v12,
      confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
      replayInboundDeltas: false
    });

    assert.equal(res.success, true);
    assert.equal(res.quarantinedDeltaEventsCount, 2);

    // sync_delta_queue must be reset to 0 so no ghost replays occur
    const remainingQueue = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(remainingQueue.length, 0);

    // Check quarantine record in settings
    const qRecord = await getQuarantinedDeltas(db);
    assert.ok(qRecord);
    assert.equal(qRecord.counts.unacknowledged, 2);
    assert.equal(qRecord.target_snapshot_id, SNAP_V12_ID);

    // 6b. Rollback restoration test:
    // If we restore pre-import backup, sync_delta_queue must be restored and quarantine cleared
    const rollbackRes = await restorePreImportBackup({ dbInstance: db });
    assert.equal(rollbackRes.success, true);

    const restoredQueue = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(restoredQueue.length, 2, 'Both pending events must be restored to sync_delta_queue on rollback');
    assert.equal(restoredQueue[0].event_id, 'evt_offline_1');
    assert.equal(restoredQueue[1].event_id, 'evt_offline_2');

    // Quarantine setting should be cleaned up because it was null before the attempt
    const postRollbackQ = await getQuarantinedDeltas(db);
    assert.equal(postRollbackQ, null, 'Temporary quarantine record must be cleaned up on rollback');
  });

  await t.test('SCENARIO 7: Duplicate package/event delivery is idempotent with zero double-application', async () => {
    await seedDeviceABaseline(db);
    const v12 = createSyntheticV12Fixture();

    // Install v12 baseline
    await reconcileExistingDeviceWithSnapshot({
      dbInstance: db,
      deviceId: DEVICE_A_ID,
      snapshotPayload: v12,
      confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
      replayInboundDeltas: false
    });

    const pkg16 = await buildPackage16(db);

    // Replay 1st time
    const res1 = await reconcileExistingDeviceWithSnapshot({
      dbInstance: db,
      deviceId: DEVICE_A_ID,
      snapshotPayload: v12,
      confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
      inboundPackages: [pkg16],
      inboundPeerDeviceId: DEVICE_D_ID,
      replayInboundDeltas: true
    });
    assert.equal(res1.reconciledDeltasCount, 1);

    // Replay 2nd time with exact same package 16 (duplicate delivery)
    const res2 = await reconcileExistingDeviceWithSnapshot({
      dbInstance: db,
      deviceId: DEVICE_A_ID,
      snapshotPayload: v12,
      confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
      inboundPackages: [pkg16],
      inboundPeerDeviceId: DEVICE_D_ID,
      replayInboundDeltas: true
    });

    assert.equal(res2.success, true);
    // Package was already staged, no new reconciliations, watermark preserved
    assert.equal(res2.reconciledDeltasCount, 0);

    const peerRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [DEVICE_D_ID]);
    assert.equal(Number(peerRes.values[0].last_reconciled_sequence), 16, 'Watermark must stay at 16');

    const txn = (await db.query('SELECT * FROM transactions WHERE id = ?', [TARGET_TXN_ID])).values[0];
    assert.equal(txn.type, 'Transfer-Out');
  });

  await t.test('SCENARIO 8: Checksum mismatch and sequence gaps are safely rejected without clobbering local state', async () => {
    await seedDeviceABaseline(db);
    const v12 = createSyntheticV12Fixture();

    await reconcileExistingDeviceWithSnapshot({
      dbInstance: db,
      deviceId: DEVICE_A_ID,
      snapshotPayload: v12,
      confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
      replayInboundDeltas: false
    });

    // 8a. Sequence gap: Peer watermark is 15, package starts at sequence 18
    const gapPackage = {
      packagePayload: {
        schema_version: 1,
        package_id: `pkg_${DEVICE_D_ID}_000018_000018`,
        device_id: DEVICE_D_ID,
        base_snapshot_id: SNAP_V12_ID,
        base_cloud_version: 12,
        start_sequence: 18, // Gap! Expected 16
        end_sequence: 18,
        event_count: 1,
        events: [{
          event_id: 'evt_gap_18',
          device_id: DEVICE_D_ID,
          sequence: 18,
          timestamp: '2026-10-15T12:00:00Z',
          collection: 'transactions',
          entity_id: TARGET_TXN_ID,
          operation: 'UPDATE',
          payload: { inr: 999 }
        }]
      }
    };

    await assert.rejects(
      async () => {
        await stagePeerPackageAtomically(gapPackage);
      },
      (err) => {
        assert(err.message.includes('Sequence gap detected'));
        return true;
      }
    );

    // Watermark must remain at 15
    const peerRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [DEVICE_D_ID]);
    assert.equal(Number(peerRes.values[0].last_staged_sequence), 15);

    // 8b. Checksum mismatch: Event has divergent base_checksum
    const corruptChecksumPkg = await buildPackage16(db);
    corruptChecksumPkg.packagePayload.events[0].base_checksum = 'tampered_divergent_base_checksum_0000000000000000000000000000';

    // Stage package
    const stageRes = await stagePeerPackageAtomically(corruptChecksumPkg);
    assert.equal(stageRes.staged, true);

    // Reconcile -> detects CONCURRENT_EDIT conflict because base_checksum does not match local checksum
    const reconRes = await reconcileStagedEvents({ peerDeviceId: DEVICE_D_ID });
    assert.equal(reconRes.conflictCount, 1, 'Must register 1 conflict due to checksum mismatch');
    assert.equal(reconRes.reconciledCount, 0, 'Must NOT reconcile divergent event');

    // Local transaction remains Expense! (Not overwritten)
    const localTxn = (await db.query('SELECT * FROM transactions WHERE id = ?', [TARGET_TXN_ID])).values[0];
    assert.equal(localTxn.type, 'Expense');

    // Peer reconciled watermark must NOT advance past 15
    const peerStateAfterConflict = (await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [DEVICE_D_ID])).values[0];
    assert.equal(Number(peerStateAfterConflict.last_reconciled_sequence), 15);
  });
});
