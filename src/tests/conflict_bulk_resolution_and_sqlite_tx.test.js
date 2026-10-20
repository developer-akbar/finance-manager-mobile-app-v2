import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuid } from 'uuid';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, getDB, closeDB, getRawIDB, setRawIDB } from '../database/db.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';
import {
  reconcileStagedEvents,
  resolveConflict,
  resolveAllConflicts,
  autoResolveIdenticalConflicts,
  RECONCILIATION_STATUS,
  APPROVED_BASE_SNAPSHOT_ID
} from '../services/deltaReconciliation.js';
import { getConflict, getPendingConflicts, CONFLICT_STATUS, CONFLICT_TYPE, CONFLICT_RESOLUTION } from '../database/conflicts.js';

test('FinMan Conflict Resolution — SQLite Transaction & Bulk Resolution Suite', async (t) => {
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
    peerDeviceId = 'peer_dev_1',
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
          e.base_checksum,
          e.new_checksum,
          e.tombstone_generation || 0,
          typeof e.payload === 'object' ? JSON.stringify(e.payload) : e.payload,
          e.bundle_id || null,
          e.bundle_index ?? null,
          e.bundle_total ?? null,
          e.bundle_checksum || null,
          e.parent_event_id || null,
          now,
          'STAGED'
        ]
      );
    }

    await db.run(
      'INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      [peerDeviceId, endSequence, 0, baseSnapshotId, now]
    );
  }

  await t.test('1. resolveConflict executes with executeSet mock without raw BEGIN TRANSACTION errors', async () => {
    const db = await resetDB();
    const txnLocal = { id: 'txn_c1', date: '2026-10-14', inr: 50, note: 'Lunch' };
    const txnRemote = { id: 'txn_c1', date: '2026-10-14', inr: 60, note: 'Lunch Buffet' };

    await db.run('INSERT INTO transactions (id, date, inr, note) VALUES (?, ?, ?, ?)', [txnLocal.id, txnLocal.date, txnLocal.inr, txnLocal.note]);
    const localHash = await computeCanonicalSha256(txnLocal);
    const remoteHash = await computeCanonicalSha256(txnRemote);

    await stageTestPackage({
      peerDeviceId: 'peer_android',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_c1',
        operation: 'UPDATE',
        base_checksum: 'base_divergent',
        new_checksum: remoteHash,
        payload: txnRemote
      }]
    });

    // Reconcile -> creates conflict
    await reconcileStagedEvents({ peerDeviceId: 'peer_android' });
    const conflicts = await getPendingConflicts();
    assert.equal(conflicts.length, 1);
    const cId = conflicts[0].conflict_id;

    // Instrument db with executeSet and clear rawIdb to simulate Capacitor SQLite environment
    const originalIDB = getRawIDB();
    let executeSetCalled = false;
    db.executeSet = async (statements) => {
      executeSetCalled = true;
      for (const s of statements) {
        await db.run(s.statement, s.values);
      }
    };

    setRawIDB(null);
    let res;
    try {
      // Execute KEEP_LOCAL
      res = await resolveConflict(cId, CONFLICT_RESOLUTION.KEEP_LOCAL);
    } finally {
      setRawIDB(originalIDB);
    }
    assert.equal(res.success, true);
    assert.equal(executeSetCalled, true, 'executeSet must be called for SQLite batch atomicity');

    // Verify conflict is resolved
    const postConflicts = await getPendingConflicts();
    assert.equal(postConflicts.length, 0);

    // Verify local entity is intact
    const ent = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_c1'])).values[0];
    assert.equal(Number(ent.inr), 50);
  });

  await t.test('2. resolveAllConflicts resolves all pending conflicts in bulk and unblocks watermark', async () => {
    const db = await resetDB();

    // Stage 3 conflicting events
    for (let i = 1; i <= 3; i++) {
      const id = `txn_bulk_${i}`;
      const local = { id, date: '2026-10-14', inr: 10 * i, note: `Local ${i}` };
      const remote = { id, date: '2026-10-14', inr: 20 * i, note: `Remote ${i}` };

      await db.run('INSERT INTO transactions (id, date, inr, note) VALUES (?, ?, ?, ?)', [id, local.date, local.inr, local.note]);
      const rHash = await computeCanonicalSha256(remote);

      await stageTestPackage({
        peerDeviceId: 'peer_dev_bulk',
        startSequence: i,
        endSequence: i,
        events: [{
          sequence: i,
          collection: 'transactions',
          entity_id: id,
          operation: 'UPDATE',
          base_checksum: 'wrong_base',
          new_checksum: rHash,
          payload: remote
        }]
      });
    }

    await reconcileStagedEvents({ peerDeviceId: 'peer_dev_bulk' });
    const pendingBefore = await getPendingConflicts();
    assert.equal(pendingBefore.length, 3);

    // Call resolveAllConflicts
    const bulkRes = await resolveAllConflicts(CONFLICT_RESOLUTION.KEEP_LOCAL);
    assert.equal(bulkRes.total, 3);
    assert.equal(bulkRes.resolved, 3);
    assert.equal(bulkRes.failed, 0);

    const pendingAfter = await getPendingConflicts();
    assert.equal(pendingAfter.length, 0);

    // Peer watermark must have caught up
    const peerRow = (await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', ['peer_dev_bulk'])).values[0];
    assert.equal(peerRow.last_reconciled_sequence, 3);
  });

  await t.test('3. autoResolveIdenticalConflicts detects and automatically clears identical conflicts', async () => {
    const db = await resetDB();

    // Model the exact user scenario: investment_transactions SILVERBEES Brokerage Charges ₹21.5
    const id = 'inv_silverbees_1';
    const localInv = {
      id,
      date: '2026-10-14',
      inr: 21.5,
      amount: '21.5',
      type: 'Expense',
      category: 'Investment Charges',
      note: 'SILVERBEES Brokerage Charges',
      actual_amount: null,
      trade_id: null,
      order_id: null
    };

    const remoteInv = {
      id,
      date: '2026-10-14',
      inr: 21.5,
      amount: '21.5',
      type: 'Expense',
      category: 'Investment Charges',
      note: 'SILVERBEES Brokerage Charges'
    };

    await db.run(
      'INSERT INTO investment_transactions (id, date, inr, amount, type, category, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, localInv.date, localInv.inr, localInv.amount, localInv.type, localInv.category, localInv.note]
    );

    // Insert an existing conflict record directly to model pre-existing state on user device
    const now = new Date().toISOString();
    await db.run(
      'INSERT INTO sync_conflicts (conflict_id, collection, entity_id, conflict_type, peer_device_id, event_id, base_checksum, local_checksum, remote_checksum, local_payload, remote_payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'conf_identical_1',
        'investment_transactions',
        id,
        CONFLICT_TYPE.CONCURRENT_EDIT,
        'dev_peer',
        'evt_1',
        'base_hash',
        'local_hash_diff',
        'remote_hash_diff',
        JSON.stringify(localInv),
        JSON.stringify(remoteInv),
        CONFLICT_STATUS.PENDING,
        now
      ]
    );

    // Verify it exists in pending conflicts
    const pendingBefore = await getPendingConflicts();
    assert.equal(pendingBefore.length, 1);

    // Run autoResolveIdenticalConflicts
    const autoRes = await autoResolveIdenticalConflicts();
    assert.equal(autoRes.resolved, 1);

    const pendingAfter = await getPendingConflicts();
    assert.equal(pendingAfter.length, 0);
  });
});
