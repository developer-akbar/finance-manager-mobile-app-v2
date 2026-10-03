import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuid } from 'uuid';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, getDB, closeDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import { listPeerManifests } from '../services/deviceManifest.js';
import {
  reconcileStagedEvents,
  RECONCILIATION_STATUS,
  APPROVED_BASE_SNAPSHOT_ID
} from '../services/deltaReconciliation.js';
import { getPendingConflicts, CONFLICT_STATUS, CONFLICT_TYPE } from '../database/conflicts.js';

test('Snapshot Lineage Compatibility Test Suite (Phase 7.5)', async (t) => {
  globalThis.indexedDB = new IDBFactory();

  async function resetDB() {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    const db = await initDB();
    await db.run('DELETE FROM transactions');
    await db.run('DELETE FROM accounts');
    await db.run('DELETE FROM inventory');
    await db.run('DELETE FROM investment_transactions');
    await db.run('DELETE FROM settings');
    await db.run('DELETE FROM sync_tombstones');
    await db.run('DELETE FROM sync_delta_queue');
    await db.run('DELETE FROM sync_local_state');
    await db.run('DELETE FROM sync_staged_packages');
    await db.run('DELETE FROM sync_staged_events');
    await db.run('DELETE FROM sync_peer_state');
    await db.run('DELETE FROM sync_process_locks');
    await db.run('DELETE FROM sync_conflicts');
    return db;
  }

  async function stageTestPackage({
    peerDeviceId = 'peer_dev_d',
    startSequence = 1,
    endSequence = 1,
    baseSnapshotId = APPROVED_BASE_SNAPSHOT_ID,
    events = []
  }) {
    const db = getDB();
    const packageId = `pkg_${peerDeviceId}_${String(startSequence).padStart(6, '0')}_${String(endSequence).padStart(6, '0')}`;
    const now = new Date().toISOString();

    await db.run(
      'INSERT OR REPLACE INTO sync_staged_packages (package_id, device_id, start_sequence, end_sequence, event_count, package_checksum, drive_file_id, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [packageId, peerDeviceId, startSequence, endSequence, events.length, 'checksum_' + packageId, 'drive_' + packageId, now, 'STAGED']
    );

    for (const e of events) {
      await db.run(
        'INSERT OR REPLACE INTO sync_staged_events (event_id, package_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, tombstone_generation, payload, bundle_id, bundle_index, bundle_total, bundle_checksum, parent_event_id, staged_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          e.event_id || uuid(),
          packageId,
          peerDeviceId,
          e.sequence,
          e.timestamp || now,
          e.collection,
          e.entity_id,
          e.operation,
          e.base_checksum || null,
          e.new_checksum || null,
          e.tombstone_generation || 0,
          typeof e.payload === 'object' ? JSON.stringify(e.payload) : e.payload,
          e.bundle_id || null,
          e.bundle_index || 0,
          e.bundle_total || 1,
          e.bundle_checksum || null,
          e.parent_event_id || null,
          now,
          e.status || RECONCILIATION_STATUS.STAGED
        ]
      );
    }

    const peerRes = await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [peerDeviceId]);
    const currentReconciled = Number(peerRes.values?.[0]?.last_reconciled_sequence) || 0;

    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      [peerDeviceId, endSequence, currentReconciled, baseSnapshotId, now]
    );

    return packageId;
  }

  // --- A. Active-base INSERT ---
  await t.test('A. Active-base INSERT applies normally', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790493064581_v9';
    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', 'snap_1790490000000_v8');

    const txn = { id: 'txn_act_1', Date: '2026-03-01', INR: 150, Description: 'Active Base Txn' };
    const newChecksum = await computeCanonicalSha256(txn);

    await stageTestPackage({
      peerDeviceId: 'peer_dev_a',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: activeSnap,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: txn.id,
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: newChecksum,
        payload: txn
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'peer_dev_a' });
    assert.equal(res.reconciledCount, 1);
    assert.equal(res.conflictCount, 0);
    assert.equal(res.peerWatermarks['peer_dev_a'], 1);

    const row = (await db.query('SELECT * FROM transactions WHERE id = ?', [txn.id])).values[0];
    assert.ok(row, 'Transaction was inserted into database');
    assert.equal(row.Description, 'Active Base Txn');
  });

  // --- B. Immediate-parent INSERT & Discovery & Staging ---
  await t.test('B. Immediate-parent INSERT is discovered, staged, and reconciled (C and D live scenario)', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';

    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', parentSnap);

    // Initial local transaction count
    for (let i = 0; i < 5; i++) {
      await db.run('INSERT INTO transactions (id, Description, INR) VALUES (?, ?, ?)', [`txn_local_${i}`, `Txn ${i}`, 100]);
    }

    const txnD = { id: 'txn_d_seq6', Date: '2026-03-02', INR: 500, Description: 'Peer D seq6 Txn' };
    const newChecksum = await computeCanonicalSha256(txnD);

    // Peer D is still based on parentSnap (v8)
    const mockDrive = {
      files: new Map(),
      findFiles: async ({ name }) => {
        return Array.from(mockDrive.files.values()).filter(f => !name || f.name === name);
      },
      readFile: async (id) => {
        const file = mockDrive.files.get(id);
        return file ? file.content : null;
      }
    };

    const dManifest = {
      schema_version: 1,
      device_id: 'dev_d',
      base_snapshot_id: parentSnap,
      packages: [{
        package_id: 'pkg_dev_d_000006_000006',
        start_sequence: 6,
        end_sequence: 6,
        drive_file_id: 'file_d_pkg6',
        package_checksum: 'chk_d_6'
      }]
    };

    mockDrive.files.set('file_manifest_d', {
      id: 'file_manifest_d',
      name: 'manifest_dev_d.json',
      content: JSON.stringify(dManifest)
    });

    // 1. Verify listPeerManifests discovers D because base === immediate parent
    const discovered = await listPeerManifests({ driveClient: mockDrive, localDeviceId: 'dev_c' });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].device_id, 'dev_d');
    assert.equal(discovered[0].base_snapshot_id, parentSnap);

    // Set initial peer watermark for D at 5
    await db.run(
      'INSERT INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['dev_d', 5, 5, parentSnap, new Date().toISOString()]
    );

    // Stage seq 6 directly
    await stageTestPackage({
      peerDeviceId: 'dev_d',
      startSequence: 6,
      endSequence: 6,
      baseSnapshotId: parentSnap,
      events: [{
        sequence: 6,
        collection: 'transactions',
        entity_id: txnD.id,
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: newChecksum,
        payload: txnD
      }]
    });

    // 2. Reconcile
    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_d' });
    assert.equal(res.reconciledCount, 1, 'Event from immediate-parent package should be reconciled cleanly');
    assert.equal(res.conflictCount, 0);
    assert.equal(res.peerWatermarks['dev_d'], 6, 'Peer watermark for D should advance from 5 to 6');

    const stagedStatus = (await db.query('SELECT status FROM sync_staged_events WHERE device_id = ?', ['dev_d'])).values[0].status;
    assert.equal(stagedStatus, RECONCILIATION_STATUS.RECONCILED_CLEAN);

    const insertedRow = (await db.query('SELECT * FROM transactions WHERE id = ?', [txnD.id])).values[0];
    assert.ok(insertedRow, 'Transaction from D seq6 was inserted into C database');
    assert.equal(insertedRow.Description, 'Peer D seq6 Txn');
  });

  // --- C. Immediate-parent clean UPDATE ---
  await t.test('C. Immediate-parent clean UPDATE applies normally when local matches base checksum', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';

    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', parentSnap);

    const origTxn = { id: 'txn_common_1', Date: '2026-03-01', INR: 100, Description: 'Original' };
    const baseChecksum = await computeCanonicalSha256(origTxn);
    await db.run('INSERT INTO transactions (id, Date, INR, Description) VALUES (?, ?, ?, ?)', [origTxn.id, origTxn.Date, origTxn.INR, origTxn.Description]);

    const updatedTxn = { id: 'txn_common_1', Date: '2026-03-01', INR: 120, Description: 'Updated by Peer' };
    const newChecksum = await computeCanonicalSha256(updatedTxn);

    await stageTestPackage({
      peerDeviceId: 'peer_dev_d',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: parentSnap,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: origTxn.id,
        operation: 'UPDATE',
        base_checksum: baseChecksum,
        new_checksum: newChecksum,
        payload: updatedTxn
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'peer_dev_d' });
    assert.equal(res.reconciledCount, 1);
    assert.equal(res.conflictCount, 0);

    const row = (await db.query('SELECT * FROM transactions WHERE id = ?', [origTxn.id])).values[0];
    assert.equal(Number(row.INR), 120);
    assert.equal(row.Description, 'Updated by Peer');
  });

  // --- D. Immediate-parent UPDATE conflict ---
  await t.test('D. Immediate-parent UPDATE conflict preserves local branch without silent overwrite', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';

    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', parentSnap);

    // Common ancestor base
    const ancestorTxn = { id: 'txn_conflict_1', Date: '2026-03-01', INR: 100, Description: 'Base Version' };
    const baseChecksum = await computeCanonicalSha256(ancestorTxn);

    // Local has modified it to INR 200
    const localModifiedTxn = { id: 'txn_conflict_1', Date: '2026-03-01', INR: 200, Description: 'Local Edit' };
    await db.run('INSERT INTO transactions (id, Date, INR, Description) VALUES (?, ?, ?, ?)', [localModifiedTxn.id, localModifiedTxn.Date, localModifiedTxn.INR, localModifiedTxn.Description]);

    // Peer on parentSnap modified it to INR 300
    const peerModifiedTxn = { id: 'txn_conflict_1', Date: '2026-03-01', INR: 300, Description: 'Peer Edit' };
    const peerNewChecksum = await computeCanonicalSha256(peerModifiedTxn);

    await stageTestPackage({
      peerDeviceId: 'peer_dev_d',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: parentSnap,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_conflict_1',
        operation: 'UPDATE',
        base_checksum: baseChecksum,
        new_checksum: peerNewChecksum,
        payload: peerModifiedTxn
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'peer_dev_d' });
    assert.equal(res.reconciledCount, 0);
    assert.equal(res.conflictCount, 1);

    // Verify local record was NOT silently overwritten
    const localRow = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_conflict_1'])).values[0];
    assert.equal(Number(localRow.INR), 200);
    assert.equal(localRow.Description, 'Local Edit');

    // Verify conflict record created
    const pending = await getPendingConflicts();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].conflict_type, CONFLICT_TYPE.CONCURRENT_EDIT);
  });

  // --- E. Immediate-parent DELETE conflict ---
  await t.test('E. Immediate-parent DELETE conflict detects remote-delete vs local-edit', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';

    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', parentSnap);

    const ancestorTxn = { id: 'txn_del_conf_1', Date: '2026-03-01', INR: 100, Description: 'Base Version' };
    const baseChecksum = await computeCanonicalSha256(ancestorTxn);

    // Local edited after common ancestor
    await db.run('INSERT INTO transactions (id, Date, INR, Description) VALUES (?, ?, ?, ?)', ['txn_del_conf_1', '2026-03-01', 150, 'Local Modified']);

    // Peer on parent baseline deleted the entity
    await stageTestPackage({
      peerDeviceId: 'peer_dev_d',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: parentSnap,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_del_conf_1',
        operation: 'DELETE',
        base_checksum: baseChecksum,
        new_checksum: null,
        payload: null
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'peer_dev_d' });
    assert.equal(res.reconciledCount, 0);
    assert.equal(res.conflictCount, 1);

    // Local entity must not be deleted
    const localRow = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_del_conf_1'])).values[0];
    assert.ok(localRow, 'Local row was preserved');
    assert.equal(Number(localRow.INR), 150);

    const pending = await getPendingConflicts();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].conflict_type, CONFLICT_TYPE.REMOTE_DELETE_LOCAL_EDIT);
  });

  // --- F. Immediate-parent clean DELETE ---
  await t.test('F. Immediate-parent clean DELETE applies and creates tombstone', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';

    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', parentSnap);

    const origTxn = { id: 'txn_clean_del_1', Date: '2026-03-01', INR: 100, Description: 'To Delete' };
    const baseChecksum = await computeCanonicalSha256(origTxn);
    await db.run('INSERT INTO transactions (id, Date, INR, Description) VALUES (?, ?, ?, ?)', [origTxn.id, origTxn.Date, origTxn.INR, origTxn.Description]);

    await stageTestPackage({
      peerDeviceId: 'peer_dev_d',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: parentSnap,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: origTxn.id,
        operation: 'DELETE',
        base_checksum: baseChecksum,
        new_checksum: null,
        payload: null
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'peer_dev_d' });
    assert.equal(res.reconciledCount, 1);
    assert.equal(res.conflictCount, 0);

    const localRow = (await db.query('SELECT * FROM transactions WHERE id = ?', [origTxn.id])).values;
    assert.equal(localRow.length, 0, 'Entity was removed from local transactions table');

    const tombstone = (await db.query('SELECT * FROM sync_tombstones WHERE id = ?', [origTxn.id])).values[0];
    assert.ok(tombstone, 'Tombstone was created for deleted entity');
  });

  // --- G. Ancient baseline ---
  await t.test('G. Ancient baseline package remains blocked with BLOCKED_OLDER_BASE', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';
    const ancientSnap = 'snap_1000000000000_older_v1';

    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', parentSnap);

    await stageTestPackage({
      peerDeviceId: 'dev_ancient',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: ancientSnap,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_ancient',
        operation: 'INSERT',
        payload: { id: 'txn_ancient', inr: 10 }
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_ancient' });
    assert.equal(res.reconciledCount, 0);
    assert.equal(res.peerWatermarks['dev_ancient'], 0);

    const stagedStatus = (await db.query('SELECT status FROM sync_staged_events WHERE device_id = ?', ['dev_ancient'])).values[0].status;
    assert.equal(stagedStatus, RECONCILIATION_STATUS.BLOCKED_OLDER_BASE);
  });

  // --- H. Unknown baseline ---
  await t.test('H. Unknown baseline package is blocked with BLOCKED_UNKNOWN_BASE', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';
    const unknownSnap = 'snap_unknown_foreign_repo_999';

    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', parentSnap);

    await stageTestPackage({
      peerDeviceId: 'dev_unknown',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: unknownSnap,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_unknown',
        operation: 'INSERT',
        payload: { id: 'txn_unknown', inr: 50 }
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_unknown' });
    assert.equal(res.reconciledCount, 0);
    assert.equal(res.peerWatermarks['dev_unknown'], 0);

    const stagedStatus = (await db.query('SELECT status FROM sync_staged_events WHERE device_id = ?', ['dev_unknown'])).values[0].status;
    assert.equal(stagedStatus, RECONCILIATION_STATUS.BLOCKED_UNKNOWN_BASE);
  });

  // --- I. Parentless active snapshot ---
  await t.test('I. Parentless active snapshot accepts active-base and blocks older/unknown', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v1';

    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', '');

    // 1. Active-base package
    const txn1 = { id: 'txn_parentless_1', Date: '2026-03-01', INR: 100, Description: 'Parentless Active' };
    const checksum1 = await computeCanonicalSha256(txn1);
    await stageTestPackage({
      peerDeviceId: 'dev_p1',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: activeSnap,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: txn1.id,
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: checksum1,
        payload: txn1
      }]
    });

    const res1 = await reconcileStagedEvents({ peerDeviceId: 'dev_p1' });
    assert.equal(res1.reconciledCount, 1);

    // 2. Older / different base package must be blocked
    await stageTestPackage({
      peerDeviceId: 'dev_p2',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: 'snap_1000000000000_older',
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_parentless_2',
        operation: 'INSERT',
        payload: { id: 'txn_parentless_2', inr: 20 }
      }]
    });

    const res2 = await reconcileStagedEvents({ peerDeviceId: 'dev_p2' });
    assert.equal(res2.reconciledCount, 0);
    const status2 = (await db.query('SELECT status FROM sync_staged_events WHERE device_id = ?', ['dev_p2'])).values[0].status;
    assert.equal(status2, RECONCILIATION_STATUS.BLOCKED_OLDER_BASE);
  });

  // --- Persistence Lineage Verification ---
  await t.test('Lineage persistence verification: Discovery & reconciliation use persisted settings', async () => {
    const db = await resetDB();
    const activeSnap = 'snap_1790500000000_v9';
    const parentSnap = 'snap_1790400000000_v8';

    await setSetting('last_snapshot_id', activeSnap);
    await setSetting('last_parent_snapshot_id', parentSnap);

    // Verify persisted in DB
    const persistedActive = await getSetting('last_snapshot_id');
    const persistedParent = await getSetting('last_parent_snapshot_id');
    assert.equal(persistedActive, activeSnap);
    assert.equal(persistedParent, parentSnap);

    const mockDrive = {
      files: new Map(),
      findFiles: async () => Array.from(mockDrive.files.values()),
      readFile: async (id) => mockDrive.files.get(id)?.content || null
    };

    mockDrive.files.set('f1', {
      id: 'f1',
      name: 'manifest_dev_active.json',
      content: JSON.stringify({ schema_version: 1, device_id: 'dev_active', base_snapshot_id: activeSnap })
    });
    mockDrive.files.set('f2', {
      id: 'f2',
      name: 'manifest_dev_parent.json',
      content: JSON.stringify({ schema_version: 1, device_id: 'dev_parent', base_snapshot_id: parentSnap })
    });
    mockDrive.files.set('f3', {
      id: 'f3',
      name: 'manifest_dev_unknown.json',
      content: JSON.stringify({ schema_version: 1, device_id: 'dev_unknown', base_snapshot_id: 'snap_unknown_999' })
    });

    // Call listPeerManifests without passing snapshot IDs (relies on persisted settings)
    const discovered = await listPeerManifests({ driveClient: mockDrive, localDeviceId: 'dev_local' });
    const discoveredIds = discovered.map(d => d.device_id).sort();

    assert.deepEqual(discoveredIds, ['dev_active', 'dev_parent'], 'Only active and immediate parent manifests should be discovered');
  });
});
