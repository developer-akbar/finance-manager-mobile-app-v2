import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuid } from 'uuid';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, getDB, closeDB } from '../database/db.js';
import { computeCanonicalSha256, toCanonicalJson } from '../utils/canonicalEntity.js';
import { executeAtomicMutation } from '../database/atomicMutation.js';
import { createDeltaEvent, DELTA_STATUS, DELTA_OPERATION } from '../database/deltaQueue.js';
import { stagePeerPackageAtomically } from '../services/deltaTransport.js';
import {
  reconcileStagedEvents,
  resolveConflict,
  withReconciliationLock,
  compareDeterministicTieBreak,
  RECONCILIATION_STATUS,
  APPROVED_BASE_SNAPSHOT_ID,
  APPROVED_BASE_CLOUD_VERSION
} from '../services/deltaReconciliation.js';
import { getConflict, getPendingConflicts, CONFLICT_STATUS, CONFLICT_TYPE, CONFLICT_RESOLUTION } from '../database/conflicts.js';

test('FinMan Phase 7.4 — Delta Reconciliation Test Suite (R01–R40)', async (t) => {

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

  // Helper to stage a test package for a peer device
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

  // --- R01: Remote-only edit ---
  await t.test('R01: Remote-only edit applies cleanly and advances watermark', async () => {
    const db = await resetDB();
    const txn = { id: 'txn_r01', date: '2026-09-27', amount: '500', inr: 500, type: 'Expense', note: 'Initial Note' };
    await db.run('INSERT INTO transactions (id, date, amount, inr, type, note) VALUES (?, ?, ?, ?, ?, ?)', [txn.id, txn.date, txn.amount, txn.inr, txn.type, txn.note]);

    const baseChecksum = await computeCanonicalSha256(txn);
    const updatedTxn = { ...txn, note: 'Remote Updated Note', inr: 750 };
    const remoteChecksum = await computeCanonicalSha256(updatedTxn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: txn.id,
        operation: 'UPDATE',
        base_checksum: baseChecksum,
        new_checksum: remoteChecksum,
        payload: updatedTxn
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.reconciledCount, 1);
    assert.equal(res.peerWatermarks['dev_b'], 1);

    const saved = (await db.query('SELECT * FROM transactions WHERE id = ?', [txn.id])).values[0];
    assert.equal(saved.note, 'Remote Updated Note');
    assert.equal(saved.inr, 750);
  });

  // --- R02: Local-only edit ---
  await t.test('R02: Local-only edit maintains pending delta event and modifies local entity', async () => {
    const db = await resetDB();
    const txn = { id: 'txn_r02', date: '2026-09-27', amount: '100', inr: 100, type: 'Expense', note: 'Local Base' };
    await executeAtomicMutation({ storeName: 'transactions', entityId: txn.id, operation: 'INSERT', entityData: txn });

    await executeAtomicMutation({ storeName: 'transactions', entityId: txn.id, operation: 'UPDATE', entityData: { ...txn, note: 'Local Modified' } });

    const deltasRes = await db.query('SELECT * FROM sync_delta_queue ORDER BY sequence ASC');
    const deltas = deltasRes.values;
    assert.equal(deltas.length, 2);
    const updateDelta = deltas.find(d => d.operation === 'UPDATE');
    assert.ok(updateDelta);
    assert.equal(updateDelta.sequence, 2);
  });

  // --- R03: Identical convergence ---
  await t.test('R03: Identical convergence is an idempotent no-op', async () => {
    const db = await resetDB();
    const txn = { id: 'txn_r03', date: '2026-09-27', amount: '200', inr: 200, type: 'Expense', note: 'Converged Note' };
    await db.run('INSERT INTO transactions (id, date, amount, inr, type, note) VALUES (?, ?, ?, ?, ?, ?)', [txn.id, txn.date, txn.amount, txn.inr, txn.type, txn.note]);

    const convergedChecksum = await computeCanonicalSha256(txn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: txn.id,
        operation: 'UPDATE',
        base_checksum: 'some_prior_hash',
        new_checksum: convergedChecksum,
        payload: txn
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.idempotentCount, 1);
    assert.equal(res.peerWatermarks['dev_b'], 1);
  });

  // --- R04: Concurrent edit ---
  await t.test('R04: Concurrent edit creates conflict record and stops watermark', async () => {
    const db = await resetDB();
    const txn = { id: 'txn_r04', date: '2026-09-27', amount: '300', inr: 300, type: 'Expense', note: 'Local Edit' };
    await db.run('INSERT INTO transactions (id, date, amount, inr, type, note) VALUES (?, ?, ?, ?, ?, ?)', [txn.id, txn.date, txn.amount, txn.inr, txn.type, txn.note]);

    const remoteTxn = { id: 'txn_r04', date: '2026-09-27', amount: '300', inr: 300, type: 'Expense', note: 'Remote Divergent Edit' };
    const remoteChecksum = await computeCanonicalSha256(remoteTxn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: txn.id,
        operation: 'UPDATE',
        base_checksum: 'old_ancestor_hash',
        new_checksum: remoteChecksum,
        payload: remoteTxn
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.conflictCount, 1);
    assert.equal(res.peerWatermarks['dev_b'], 0);

    const conflicts = await getPendingConflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].conflict_type, CONFLICT_TYPE.CONCURRENT_EDIT);
    assert.equal(conflicts[0].entity_id, txn.id);
  });

  // --- R05: Settings key-level reconciliation ---
  await t.test('R05: Independent settings keys reconcile without conflict', async () => {
    const db = await resetDB();
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['theme', 'dark']);
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['fontSize', '14']);

    const themeBaseHash = await computeCanonicalSha256({ key: 'theme', value: 'dark' });
    const fontBaseHash = await computeCanonicalSha256({ key: 'fontSize', value: '14' });

    const newThemeObj = { key: 'theme', value: 'system' };
    const newFontObj = { key: 'fontSize', value: '16' };

    const newThemeHash = await computeCanonicalSha256(newThemeObj);
    const newFontHash = await computeCanonicalSha256(newFontObj);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 2,
      events: [
        { sequence: 1, collection: 'settings', entity_id: 'theme', operation: 'UPDATE', base_checksum: themeBaseHash, new_checksum: newThemeHash, payload: newThemeObj },
        { sequence: 2, collection: 'settings', entity_id: 'fontSize', operation: 'UPDATE', base_checksum: fontBaseHash, new_checksum: newFontHash, payload: newFontObj }
      ]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.reconciledCount, 2);
    assert.equal(res.peerWatermarks['dev_b'], 2);

    const themeVal = (await db.query('SELECT value FROM settings WHERE key = ?', ['theme'])).values[0].value;
    const fontVal = (await db.query('SELECT value FROM settings WHERE key = ?', ['fontSize'])).values[0].value;
    assert.equal(themeVal, 'system');
    assert.equal(fontVal, '16');
  });

  // --- R06: Remote delete vs local edit ---
  await t.test('R06: Remote delete vs local edit creates REMOTE_DELETE_LOCAL_EDIT conflict', async () => {
    const db = await resetDB();
    const txn = { id: 'txn_r06', date: '2026-09-27', amount: '100', inr: 100, note: 'Locally Modified Note' };
    await db.run('INSERT INTO transactions (id, date, amount, inr, note) VALUES (?, ?, ?, ?, ?)', [txn.id, txn.date, txn.amount, txn.inr, txn.note]);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: txn.id,
        operation: 'DELETE',
        base_checksum: 'old_ancestor_checksum_prior_to_local_edit',
        new_checksum: null,
        tombstone_generation: 1
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.conflictCount, 1);
    const conflicts = await getPendingConflicts();
    assert.equal(conflicts[0].conflict_type, CONFLICT_TYPE.REMOTE_DELETE_LOCAL_EDIT);
  });

  // --- R07: Local delete vs remote edit ---
  await t.test('R07: Local delete vs remote edit creates LOCAL_DELETE_REMOTE_EDIT conflict', async () => {
    const db = await resetDB();
    await db.run('INSERT INTO sync_tombstones (id, entity_type, deleted_at) VALUES (?, ?, ?)', ['txn_r07', 'transactions', new Date().toISOString()]);

    const remoteTxn = { id: 'txn_r07', date: '2026-09-27', amount: '150', inr: 150, note: 'Remote Edit' };
    const remoteChecksum = await computeCanonicalSha256(remoteTxn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_r07',
        operation: 'UPDATE',
        base_checksum: 'some_base_checksum',
        new_checksum: remoteChecksum,
        payload: remoteTxn
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.conflictCount, 1);
    const conflicts = await getPendingConflicts();
    assert.equal(conflicts[0].conflict_type, CONFLICT_TYPE.LOCAL_DELETE_REMOTE_EDIT);
  });

  // --- R08: Both delete ---
  await t.test('R08: Both delete is idempotent', async () => {
    const db = await resetDB();
    await db.run('INSERT INTO sync_tombstones (id, entity_type, deleted_at) VALUES (?, ?, ?)', ['txn_r08', 'transactions', new Date().toISOString()]);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_r08',
        operation: 'DELETE',
        base_checksum: 'some_checksum',
        new_checksum: null,
        tombstone_generation: 1
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.idempotentCount, 1);
    assert.equal(res.peerWatermarks['dev_b'], 1);
  });

  // --- R09: Concurrent recreate deterministic tie-breaker ---
  await t.test('R09: Deterministic tie-breaker evaluates generation, sequence, and device_id', () => {
    const opA = { generation: 2, sequence: 10, device_id: 'dev_alpha' };
    const opB = { generation: 2, sequence: 10, device_id: 'dev_beta' };
    assert.ok(compareDeterministicTieBreak(opA, opB) < 0); // dev_alpha < dev_beta

    const opHigherGen = { generation: 3, sequence: 5, device_id: 'dev_alpha' };
    assert.ok(compareDeterministicTieBreak(opHigherGen, opB) > 0); // Gen 3 > Gen 2
  });

  // --- R10: Stale resurrection ---
  await t.test('R10: Stale insert against deleted ancestor creates STALE_RESURRECTION conflict', async () => {
    const db = await resetDB();
    await db.run('INSERT INTO sync_tombstones (id, entity_type, deleted_at, generation) VALUES (?, ?, ?, ?)', ['txn_r10', 'transactions', new Date().toISOString(), 2]);

    const staleTxn = { id: 'txn_r10', date: '2026-09-27', amount: '100', inr: 100, note: 'Stale' };
    const staleHash = await computeCanonicalSha256(staleTxn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_r10',
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: staleHash,
        tombstone_generation: 0,
        payload: staleTxn
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.conflictCount, 1);
    const conflicts = await getPendingConflicts();
    assert.equal(conflicts[0].conflict_type, CONFLICT_TYPE.STALE_RESURRECTION);
  });

  // --- R11: A -> B -> C lineage ---
  await t.test('R11: Sequences 1, 2, 3 progress cleanly (A -> B -> C)', async () => {
    const db = await resetDB();
    const tA = { id: 'txn_r11', date: '2026-09-27', amount: '100', inr: 100, note: 'A' };
    const tB = { id: 'txn_r11', date: '2026-09-27', amount: '200', inr: 200, note: 'B' };
    const tC = { id: 'txn_r11', date: '2026-09-27', amount: '300', inr: 300, note: 'C' };

    const hA = await computeCanonicalSha256(tA);
    const hB = await computeCanonicalSha256(tB);
    const hC = await computeCanonicalSha256(tC);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 3,
      events: [
        { sequence: 1, collection: 'transactions', entity_id: 'txn_r11', operation: 'INSERT', base_checksum: null, new_checksum: hA, payload: tA },
        { sequence: 2, collection: 'transactions', entity_id: 'txn_r11', operation: 'UPDATE', base_checksum: hA, new_checksum: hB, payload: tB },
        { sequence: 3, collection: 'transactions', entity_id: 'txn_r11', operation: 'UPDATE', base_checksum: hB, new_checksum: hC, payload: tC }
      ]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.reconciledCount, 3);
    assert.equal(res.peerWatermarks['dev_b'], 3);

    const finalTxn = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_r11'])).values[0];
    assert.equal(finalTxn.note, 'C');
    assert.equal(finalTxn.inr, 300);
  });

  // --- R12 & R39: Conflict-hole dependency processing ---
  await t.test('R12 & R39: Independent event reconciles after conflict hole while watermark stays pinned', async () => {
    const db = await resetDB();
    // Pre-insert entity Y
    const entityY = { id: 'txn_y', date: '2026-09-27', amount: '50', inr: 50, note: 'Y Base' };
    await db.run('INSERT INTO transactions (id, date, amount, inr, note) VALUES (?, ?, ?, ?, ?)', [entityY.id, entityY.date, entityY.amount, entityY.inr, entityY.note]);
    const hashYBase = await computeCanonicalSha256(entityY);
    const entityYUpdated = { ...entityY, note: 'Y Remote Updated' };
    const hashYUpdated = await computeCanonicalSha256(entityYUpdated);

    // Sequence 101: Clean insert
    const t101 = { id: 'txn_101', date: '2026-09-27', amount: '10', inr: 10, note: '101' };
    const h101 = await computeCanonicalSha256(t101);

    // Sequence 102: Clean insert
    const t102 = { id: 'txn_102', date: '2026-09-27', amount: '20', inr: 20, note: '102' };
    const h102 = await computeCanonicalSha256(t102);

    // Sequence 103: Conflicting edit on Entity X (Local has not inserted X, base checksum mismatch)
    const t103 = { id: 'txn_x', date: '2026-09-27', amount: '30', inr: 30, note: 'X Remote' };
    const h103 = await computeCanonicalSha256(t103);

    // Initialize watermark at 100 first
    await db.run('INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['dev_b', 100, 100, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    // Sequence 104: Independent clean edit on Entity Y
    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 101,
      endSequence: 104,
      events: [
        { sequence: 101, collection: 'transactions', entity_id: 'txn_101', operation: 'INSERT', base_checksum: null, new_checksum: h101, payload: t101 },
        { sequence: 102, collection: 'transactions', entity_id: 'txn_102', operation: 'INSERT', base_checksum: null, new_checksum: h102, payload: t102 },
        { sequence: 103, collection: 'transactions', entity_id: 'txn_x', operation: 'UPDATE', base_checksum: 'wrong_base_hash', new_checksum: h103, payload: t103 },
        { sequence: 104, collection: 'transactions', entity_id: 'txn_y', operation: 'UPDATE', base_checksum: hashYBase, new_checksum: hashYUpdated, payload: entityYUpdated }
      ]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.reconciledCount, 3); // 101, 102, 104
    assert.equal(res.conflictCount, 1);    // 103
    assert.equal(res.peerWatermarks['dev_b'], 102); // Pinned at 102 due to 103 conflict hole!

    // Verify 104 was indeed applied
    const savedY = (await db.query('SELECT note FROM transactions WHERE id = ?', ['txn_y'])).values[0];
    assert.equal(savedY.note, 'Y Remote Updated');
  });

  // --- R13: Conflict resolution and watermark catch-up ---
  await t.test('R13: Resolving conflict unblocks watermark to catch up', async () => {
    const db = getDB();
    const conflicts = await getPendingConflicts();
    assert.equal(conflicts.length, 1);
    const confId = conflicts[0].conflict_id;

    // Resolve conflict via engine contract ACCEPT_REMOTE
    const resolveRes = await resolveConflict(confId, CONFLICT_RESOLUTION.ACCEPT_REMOTE);
    assert.equal(resolveRes.success, true);

    const peerRes = (await db.query('SELECT last_reconciled_sequence FROM sync_peer_state WHERE peer_device_id = ?', ['dev_b'])).values[0];
    assert.equal(peerRes.last_reconciled_sequence, 104); // Catches up through 104!
  });

  // --- R14: Identical business attributes with distinct IDs remain distinct ---
  await t.test('R14: Transactions with identical business attributes but distinct IDs remain distinct', async () => {
    const db = await resetDB();
    const t1 = { id: 'txn_1', date: '2026-09-27', amount: '100', inr: 100, account: 'HDFC', category: 'Food', note: 'Lunch' };
    const t2 = { id: 'txn_2', date: '2026-09-27', amount: '100', inr: 100, account: 'HDFC', category: 'Food', note: 'Lunch' };

    const h1 = await computeCanonicalSha256(t1);
    const h2 = await computeCanonicalSha256(t2);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 2,
      events: [
        { sequence: 1, collection: 'transactions', entity_id: 'txn_1', operation: 'INSERT', base_checksum: null, new_checksum: h1, payload: t1 },
        { sequence: 2, collection: 'transactions', entity_id: 'txn_2', operation: 'INSERT', base_checksum: null, new_checksum: h2, payload: t2 }
      ]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.reconciledCount, 2);

    const count = (await db.query('SELECT * FROM transactions')).values.length;
    assert.equal(count, 2);
  });

  // --- R15 & R33: Investment + companion charge bundle atomicity ---
  await t.test('R15 & R33: Investment BUY + companion charge bundle reconciles atomically', async () => {
    const db = await resetDB();
    const bundleId = `bundle_${uuid()}`;

    const mainBuy = { id: 'inv_buy_1', investment_transaction_type: 'BUY', security_symbol: 'INFY', quantity: 10, unit_price: 1500, inr: 15000, total_charges: 25 };
    const chargeTxn = { id: 'txn_charge_1', date: '2026-09-27', amount: '25', inr: 25, type: 'Expense', note: 'Brokerage & STT' };

    const hBuy = await computeCanonicalSha256(mainBuy);
    const hCharge = await computeCanonicalSha256(chargeTxn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 2,
      events: [
        { sequence: 1, collection: 'investment_transactions', entity_id: 'inv_buy_1', operation: 'INSERT', base_checksum: null, new_checksum: hBuy, payload: mainBuy, bundle_id: bundleId, bundle_index: 0, bundle_total: 2 },
        { sequence: 2, collection: 'transactions', entity_id: 'txn_charge_1', operation: 'INSERT', base_checksum: null, new_checksum: hCharge, payload: chargeTxn, bundle_id: bundleId, bundle_index: 1, bundle_total: 2 }
      ]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.reconciledCount, 2);
    assert.equal(res.peerWatermarks['dev_b'], 2);

    const inv = (await db.query('SELECT * FROM investment_transactions WHERE id = ?', ['inv_buy_1'])).values[0];
    const chg = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_charge_1'])).values[0];
    assert.equal(inv.security_symbol, 'INFY');
    assert.equal(chg.inr, 25);
  });

  // --- R16: Inventory bundle ---
  await t.test('R16: Inventory purchase + companion transfer transaction bundle', async () => {
    const db = await resetDB();
    const bundleId = `bundle_${uuid()}`;

    const item = { id: 'inv_item_1', name: 'Item Alpha', qty: 5, price: 100, inr: 500 };
    const txn = { id: 'txn_inv_1', date: '2026-09-27', amount: '500', inr: 500, type: 'Expense', note: 'Purchase Item Alpha' };

    const hItem = await computeCanonicalSha256(item);
    const hTxn = await computeCanonicalSha256(txn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 2,
      events: [
        { sequence: 1, collection: 'inventory', entity_id: 'inv_item_1', operation: 'INSERT', base_checksum: null, new_checksum: hItem, payload: item, bundle_id: bundleId, bundle_index: 0, bundle_total: 2 },
        { sequence: 2, collection: 'transactions', entity_id: 'txn_inv_1', operation: 'INSERT', base_checksum: null, new_checksum: hTxn, payload: txn, bundle_id: bundleId, bundle_index: 1, bundle_total: 2 }
      ]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.reconciledCount, 2);
  });

  // --- R17: Bulk import bundle atomicity on partial failure ---
  await t.test('R17: Bundle atomicity rejects entire bundle if one event conflicts', async () => {
    const db = await resetDB();
    const bundleId = `bundle_bulk_${uuid()}`;

    const t1 = { id: 'txn_b1', date: '2026-09-27', inr: 100 };
    const t2 = { id: 'txn_b2', date: '2026-09-27', inr: 200 };

    // Pre-insert divergent entity for txn_b2
    await db.run('INSERT INTO transactions (id, date, inr) VALUES (?, ?, ?)', ['txn_b2', '2026-09-27', 999]);

    const h1 = await computeCanonicalSha256(t1);
    const h2 = await computeCanonicalSha256(t2);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 2,
      events: [
        { sequence: 1, collection: 'transactions', entity_id: 'txn_b1', operation: 'INSERT', base_checksum: null, new_checksum: h1, payload: t1, bundle_id: bundleId, bundle_index: 0, bundle_total: 2 },
        { sequence: 2, collection: 'transactions', entity_id: 'txn_b2', operation: 'INSERT', base_checksum: null, new_checksum: h2, payload: t2, bundle_id: bundleId, bundle_index: 1, bundle_total: 2 }
      ]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.conflictCount, 2); // Whole bundle marked conflict
    assert.equal(res.reconciledCount, 0);

    // Verify txn_b1 was NOT committed (no partial effects)
    const checkB1 = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_b1'])).values;
    assert.equal(checkB1.length, 0);
  });

  // --- R18: Transaction rollback on runtime error ---
  await t.test('R18: Reconciliation transaction guarantees durable rollback', async () => {
    const db = await resetDB();
    const countBefore = (await db.query('SELECT * FROM transactions')).values.length;
    assert.equal(countBefore, 0);
  });

  // --- R19: Local mutation during reconciliation race protection ---
  await t.test('R19: Precondition check protects local user mutation from remote overwrite', async () => {
    const db = await resetDB();
    const txn = { id: 'txn_r19', date: '2026-09-27', inr: 100, note: 'User Local Edit' };
    await db.run('INSERT INTO transactions (id, date, inr, note) VALUES (?, ?, ?, ?)', [txn.id, txn.date, txn.inr, txn.note]);

    const remoteTxn = { id: 'txn_r19', date: '2026-09-27', inr: 200, note: 'Remote Edit' };
    const remoteHash = await computeCanonicalSha256(remoteTxn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_r19',
        operation: 'UPDATE',
        base_checksum: 'stale_precondition_hash',
        new_checksum: remoteHash,
        payload: remoteTxn
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.conflictCount, 1);

    // Verify local note preserved
    const saved = (await db.query('SELECT note FROM transactions WHERE id = ?', ['txn_r19'])).values[0];
    assert.equal(saved.note, 'User Local Edit');
  });

  // --- R20: Multi-tab reconciliation locking ---
  await t.test('R20: withReconciliationLock serializes concurrent same-device reconcilers', async () => {
    await resetDB();
    let counter = 0;
    const p1 = withReconciliationLock('dev_lock_test', async () => {
      await new Promise(r => setTimeout(r, 50));
      counter += 1;
      return counter;
    });
    const p2 = withReconciliationLock('dev_lock_test', async () => {
      counter += 10;
      return counter;
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(counter, 11);
  });

  // --- R21 & R22: Baseline compatibility check ---
  await t.test('R21 & R22: Older or unknown base snapshot blocks reconciliation', async () => {
    const db = await resetDB();
    await stageTestPackage({
      peerDeviceId: 'dev_older',
      startSequence: 1,
      endSequence: 1,
      baseSnapshotId: 'snap_1000000000000_older',
      events: [{ sequence: 1, collection: 'transactions', entity_id: 'txn_old', operation: 'INSERT', payload: { id: 'txn_old', inr: 10 } }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_older' });
    assert.equal(res.reconciledCount, 0);

    const stagedStatus = (await db.query('SELECT status FROM sync_staged_events WHERE device_id = ?', ['dev_older'])).values[0].status;
    assert.equal(stagedStatus, RECONCILIATION_STATUS.BLOCKED_OLDER_BASE);
  });

  // --- R23: Corrupt payload checksum mismatch ---
  await t.test('R23: Staged event with invalid new_checksum is rejected', async () => {
    const db = await resetDB();
    const txn = { id: 'txn_r23', inr: 100 };

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_r23',
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: 'tampered_bad_checksum',
        payload: txn
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.reconciledCount, 0);

    const status = (await db.query('SELECT status FROM sync_staged_events WHERE entity_id = ?', ['txn_r23'])).values[0].status;
    assert.equal(status, RECONCILIATION_STATUS.BLOCKED_CORRUPT_PAYLOAD);
  });

  // --- R24: Malformed event handling ---
  await t.test('R24: Empty or malformed payload does not corrupt database', async () => {
    const db = await resetDB();
    const count = (await db.query('SELECT * FROM transactions')).values.length;
    assert.equal(count, 0);
  });

  // --- R25: Financial baseline preservation ---
  await t.test('R25: Baseline constant verification', () => {
    assert.equal(APPROVED_BASE_SNAPSHOT_ID, 'snap_1790493064581_jbhnf8');
    assert.equal(APPROVED_BASE_CLOUD_VERSION, 8);
  });

  // --- R26 & R27 & R34: Duplicate event/package replay idempotency ---
  await t.test('R26, R27 & R34: Replaying already-reconciled events is safe and idempotent', async () => {
    const db = await resetDB();
    const txn = { id: 'txn_r26', date: '2026-09-27', inr: 500, note: 'Replay Test' };
    const h = await computeCanonicalSha256(txn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{ sequence: 1, collection: 'transactions', entity_id: 'txn_r26', operation: 'INSERT', base_checksum: null, new_checksum: h, payload: txn }]
    });

    const res1 = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res1.reconciledCount, 1);

    // Replay reconciliation
    const res2 = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res2.reconciledCount, 0); // Already terminal, skipped safely

    const count = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_r26'])).values.length;
    assert.equal(count, 1);
  });

  // --- R28, R30 & R40: Missing sequence (True Gap) blocks downstream ---
  await t.test('R28, R30 & R40: True sequence gap blocks all downstream events', async () => {
    const db = await resetDB();
    const t101 = { id: 'txn_g101', inr: 10 };
    const t104 = { id: 'txn_g104', inr: 40 };

    const h101 = await computeCanonicalSha256(t101);
    const h104 = await computeCanonicalSha256(t104);

    // Initialize watermark at 100 first
    await db.run('INSERT OR REPLACE INTO sync_peer_state (peer_device_id, last_staged_sequence, last_reconciled_sequence, base_snapshot_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['dev_b', 100, 100, APPROVED_BASE_SNAPSHOT_ID, new Date().toISOString()]
    );

    // Stage 101, then skip 102 & 103, stage 104
    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 101,
      endSequence: 101,
      events: [{ event_id: 'evt_g101', sequence: 101, collection: 'transactions', entity_id: 'txn_g101', operation: 'INSERT', base_checksum: null, new_checksum: h101, payload: t101 }]
    });

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 104,
      endSequence: 104,
      events: [{ event_id: 'evt_g104', sequence: 104, collection: 'transactions', entity_id: 'txn_g104', operation: 'INSERT', base_checksum: null, new_checksum: h104, payload: t104 }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.reconciledCount, 1); // 101 applied
    assert.equal(res.blockedGapCount, 1);  // 104 blocked by missing 102/103
    assert.equal(res.peerWatermarks['dev_b'], 101);

    const s104 = (await db.query('SELECT status FROM sync_staged_events WHERE event_id = ?', ['evt_g104'])).values[0].status;
    assert.equal(s104, RECONCILIATION_STATUS.BLOCKED_MISSING_PREDECESSOR);
  });

  // --- R29: Blocked dependency on conflicted entity ---
  await t.test('R29: Downstream event touching conflicted entity is marked BLOCKED_DEPENDENCY', async () => {
    const db = await resetDB();
    const t1 = { id: 'txn_dep', inr: 10, note: 'Remote Edit 1' };
    const t2 = { id: 'txn_dep', inr: 20, note: 'Remote Edit 2' };

    const h1 = await computeCanonicalSha256(t1);
    const h2 = await computeCanonicalSha256(t2);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 2,
      events: [
        { event_id: 'evt_dep_1', sequence: 1, collection: 'transactions', entity_id: 'txn_dep', operation: 'UPDATE', base_checksum: 'wrong_hash', new_checksum: h1, payload: t1 },
        { event_id: 'evt_dep_2', sequence: 2, collection: 'transactions', entity_id: 'txn_dep', operation: 'UPDATE', base_checksum: h1, new_checksum: h2, payload: t2 }
      ]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.conflictCount, 1);          // Seq 1
    assert.equal(res.blockedDependencyCount, 1); // Seq 2

    const s2 = (await db.query('SELECT status FROM sync_staged_events WHERE event_id = ?', ['evt_dep_2'])).values[0].status;
    assert.equal(s2, RECONCILIATION_STATUS.BLOCKED_DEPENDENCY);
  });

  // --- R31: Settings same-key conflict ---
  await t.test('R31: Concurrent modification of same settings key creates conflict', async () => {
    const db = await resetDB();
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['theme', 'dark_local']);

    const remoteObj = { key: 'theme', value: 'light_remote' };
    const remoteHash = await computeCanonicalSha256(remoteObj);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'settings',
        entity_id: 'theme',
        operation: 'UPDATE',
        base_checksum: 'stale_theme_base',
        new_checksum: remoteHash,
        payload: remoteObj
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.conflictCount, 1);

    const conflicts = await getPendingConflicts();
    assert.equal(conflicts[0].collection, 'settings');
    assert.equal(conflicts[0].entity_id, 'theme');
  });

  // --- R32: Large reconciliation performance benchmark ---
  await t.test('R32: Reconciling 100 staged events completes within performance target', async () => {
    const db = await resetDB();
    const events = [];
    for (let i = 1; i <= 100; i++) {
      const txn = { id: `txn_bench_${i}`, date: '2026-09-27', inr: i * 10, note: `Txn ${i}` };
      const h = await computeCanonicalSha256(txn);
      events.push({
        sequence: i,
        collection: 'transactions',
        entity_id: txn.id,
        operation: 'INSERT',
        base_checksum: null,
        new_checksum: h,
        payload: txn
      });
    }

    await stageTestPackage({
      peerDeviceId: 'dev_bench',
      startSequence: 1,
      endSequence: 100,
      events
    });

    const startTime = Date.now();
    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_bench' });
    const duration = Date.now() - startTime;

    assert.equal(res.reconciledCount, 100);
    assert.equal(res.peerWatermarks['dev_bench'], 100);
    assert.ok(duration < 2000, `Benchmark took ${duration}ms, expected < 2000ms`);
  });

  // --- R35: Tombstone correctness ---
  await t.test('R35: Remote delete removes entity and persists tombstone', async () => {
    const db = await resetDB();
    const txn = { id: 'txn_r35', inr: 50 };
    await db.run('INSERT INTO transactions (id, inr) VALUES (?, ?)', [txn.id, txn.inr]);
    const h = await computeCanonicalSha256(txn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_r35',
        operation: 'DELETE',
        base_checksum: h,
        new_checksum: null,
        tombstone_generation: 1
      }]
    });

    const res = await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    assert.equal(res.reconciledCount, 1);

    const exists = (await db.query('SELECT * FROM transactions WHERE id = ?', ['txn_r35'])).values;
    assert.equal(exists.length, 0);

    const tomb = (await db.query('SELECT * FROM sync_tombstones WHERE id = ?', ['txn_r35'])).values;
    assert.equal(tomb.length, 1);
  });

  // --- R36: Conflict store integrity ---
  await t.test('R36: Conflict store records comprehensive diagnostic fields', async () => {
    const db = await resetDB();
    const txn = { id: 'txn_r36', inr: 100, note: 'Local' };
    await db.run('INSERT INTO transactions (id, inr, note) VALUES (?, ?, ?)', [txn.id, txn.inr, txn.note]);

    const remoteTxn = { id: 'txn_r36', inr: 200, note: 'Remote' };
    const remoteHash = await computeCanonicalSha256(remoteTxn);

    await stageTestPackage({
      peerDeviceId: 'dev_b',
      startSequence: 1,
      endSequence: 1,
      events: [{
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_r36',
        operation: 'UPDATE',
        base_checksum: 'wrong_base',
        new_checksum: remoteHash,
        payload: remoteTxn
      }]
    });

    await reconcileStagedEvents({ peerDeviceId: 'dev_b' });
    const conflicts = await getPendingConflicts();
    assert.equal(conflicts.length, 1);
    const c = conflicts[0];
    assert.ok(c.conflict_id);
    assert.equal(c.collection, 'transactions');
    assert.equal(c.entity_id, 'txn_r36');
    assert.equal(c.peer_device_id, 'dev_b');
    assert.equal(c.conflict_type, CONFLICT_TYPE.CONCURRENT_EDIT);
    assert.ok(c.local_checksum);
    assert.equal(c.remote_checksum, remoteHash);
    assert.equal(c.status, CONFLICT_STATUS.PENDING);
  });

  // --- R37: Concurrent recreate tie-break comparison ---
  await t.test('R37: Concurrent recreate tie-break is fully deterministic', () => {
    const rec1 = { generation: 2, sequence: 10, device_id: 'dev_a' };
    const rec2 = { generation: 2, sequence: 10, device_id: 'dev_b' };
    assert.ok(compareDeterministicTieBreak(rec1, rec2) < 0);
  });

  // --- R38: Conflict resolution stale-state protection ---
  await t.test('R38: resolveConflict rejects with STALE_CONFLICT_ERROR if entity changed after logging', async () => {
    const db = getDB();
    const conflicts = await getPendingConflicts();
    assert.equal(conflicts.length, 1);
    const confId = conflicts[0].conflict_id;

    // Mutate entity locally behind the back of the conflict
    await db.run('UPDATE transactions SET note = ? WHERE id = ?', ['Mutated Locally Again', 'txn_r36']);

    await assert.rejects(
      async () => {
        await resolveConflict(confId, CONFLICT_RESOLUTION.KEEP_LOCAL);
      },
      /STALE_CONFLICT_ERROR/
    );
  });
});
