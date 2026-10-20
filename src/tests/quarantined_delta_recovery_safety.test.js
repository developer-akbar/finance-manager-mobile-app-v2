/**
 * quarantined_delta_recovery_safety.test.js
 * 
 * Comprehensive safety verification for restoreQuarantinedDeltas():
 * 1. Repeated calls (idempotency, zero duplicate sequences, zero queue bloat).
 * 2. Crash / interruption midway during restoration and resume across cold restart.
 * 3. Missing target entity handling (preserves for review, does not blindly discard or re-queue).
 * 4. Divergent target entity handling (preserves for review, prevents silent overwrites).
 * 5. Identical data handling (skips as clean no-op).
 * 6. Clean offline insert & clean update re-queuing with contiguous sequences.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initDB, getDB, closeDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import {
  quarantinePendingDeltas,
  getQuarantinedDeltas,
  getQuarantinedHeldEvents,
  restoreQuarantinedDeltas,
  evaluateQuarantinedEventAgainstSnapshot
} from '../services/snapshotDeviceImport.js';
import { fastFingerprint, canonicalizeEntity } from '../services/cloudSyncEngine.js';

test('Quarantined Delta Recovery Safety Suite', async (t) => {
  let db;

  t.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    db = await initDB();
  });

  t.afterEach(async () => {
    closeDB();
  });

  await t.test('1. Repeated Calls (Idempotency): Multiple executions produce zero duplicates and do not advance sequences', async () => {
    // Seed snapshot baseline entities
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_cash', 'Cash', 'Cash']);
    await db.run(
      'INSERT INTO sync_local_state (key, device_id, last_allocated_sequence, lifecycle_state) VALUES (?, ?, ?, ?)',
      ['device_state', 'dev_test_idempotent', 0, 'ACTIVE']
    );

    // Seed quarantined records: 2 clean offline events
    const initialQuarantine = {
      quarantine_id: 'q_test_idempotent',
      quarantined_at: new Date().toISOString(),
      reason: 'SNAPSHOT_LINEAGE_RESET',
      source_device_id: 'dev_test_idempotent',
      target_snapshot_id: 'snap_v10',
      target_cloud_version: 10,
      counts: { total: 2, unacknowledged: 2, acknowledged: 0 },
      events: [
        {
          event_id: 'evt_clean_1',
          device_id: 'dev_test_idempotent',
          collection: 'transactions',
          entity_id: 'tx_offline_new_1',
          operation: 'INSERT',
          payload: { id: 'tx_offline_new_1', date: '2026-10-10', inr: 100, note: 'New Txn 1' },
          status: 'PENDING'
        },
        {
          event_id: 'evt_clean_2',
          device_id: 'dev_test_idempotent',
          collection: 'transactions',
          entity_id: 'tx_offline_new_2',
          operation: 'INSERT',
          payload: { id: 'tx_offline_new_2', date: '2026-10-10', inr: 200, note: 'New Txn 2' },
          status: 'PENDING'
        }
      ]
    };
    await setSetting('pre_recovery_quarantined_deltas', JSON.stringify(initialQuarantine), { suppressDeltaQueue: true });

    // Call 1: Re-queues both events (sequences 1 and 2)
    const call1 = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(call1.success, true);
    assert.equal(call1.restoredCount, 2);
    assert.equal(call1.alreadyRestoredCount, 0);
    assert.equal(call1.newAllocatedSequence, 2);

    const q1 = (await db.query('SELECT * FROM sync_delta_queue ORDER BY sequence ASC')).values || [];
    assert.equal(q1.length, 2);
    assert.equal(q1[0].event_id, 'evt_clean_1');
    assert.equal(Number(q1[0].sequence), 1);
    assert.equal(q1[1].event_id, 'evt_clean_2');
    assert.equal(Number(q1[1].sequence), 2);

    // Call 2: Immediate repeated call
    const call2 = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(call2.success, true);
    assert.equal(call2.restoredCount, 0, 'Zero new events restored on 2nd call');
    assert.equal(call2.alreadyRestoredCount, 2, 'Reports 2 already restored events');
    assert.equal(call2.newAllocatedSequence, 2, 'Sequence counter must NOT advance');

    const q2 = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(q2.length, 2, 'Zero new rows in queue');

    // Call 3: Third repeated call
    const call3 = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(call3.success, true);
    assert.equal(call3.restoredCount, 0);
    assert.equal(call3.alreadyRestoredCount, 2);
    assert.equal(call3.newAllocatedSequence, 2);

    // Check device state was not inflated
    const localStateRes = await db.query('SELECT last_allocated_sequence FROM sync_local_state WHERE key = ?', ['device_state']);
    assert.equal(Number(localStateRes.values[0].last_allocated_sequence), 2);
  });

  await t.test('2. Interruption / Crash Midway: Resumes without duplicate application across cold restart', async () => {
    await db.run(
      'INSERT INTO sync_local_state (key, device_id, last_allocated_sequence, lifecycle_state) VALUES (?, ?, ?, ?)',
      ['device_state', 'dev_test_crash', 0, 'ACTIVE']
    );

    const initialQuarantine = {
      quarantine_id: 'q_test_crash',
      quarantined_at: new Date().toISOString(),
      reason: 'SNAPSHOT_LINEAGE_RESET',
      source_device_id: 'dev_test_crash',
      target_snapshot_id: 'snap_v10',
      target_cloud_version: 10,
      counts: { total: 3, unacknowledged: 3, acknowledged: 0 },
      events: [
        {
          event_id: 'evt_crash_1',
          device_id: 'dev_test_crash',
          collection: 'transactions',
          entity_id: 'tx_crash_1',
          operation: 'INSERT',
          payload: { id: 'tx_crash_1', inr: 100 },
          status: 'PENDING'
        },
        {
          event_id: 'evt_crash_2',
          device_id: 'dev_test_crash',
          collection: 'transactions',
          entity_id: 'tx_crash_2',
          operation: 'INSERT',
          payload: { id: 'tx_crash_2', inr: 200 },
          status: 'PENDING'
        },
        {
          event_id: 'evt_crash_3',
          device_id: 'dev_test_crash',
          collection: 'transactions',
          entity_id: 'tx_crash_3',
          operation: 'INSERT',
          payload: { id: 'tx_crash_3', inr: 300 },
          status: 'PENDING'
        }
      ]
    };
    await setSetting('pre_recovery_quarantined_deltas', JSON.stringify(initialQuarantine), { suppressDeltaQueue: true });

    // Simulate crash where evt_crash_1 was successfully inserted with sequence 1,
    // but the process crashed before evt_crash_2 and evt_crash_3 were written
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_crash_1', 'dev_test_crash', 1, '2026-10-14T12:00:00Z', 'transactions', 'tx_crash_1', 'INSERT', '{"inr":100}', 'PENDING']
    );
    await db.run('UPDATE sync_local_state SET last_allocated_sequence = 1 WHERE key = ?', ['device_state']);

    // Simulate cold restart
    closeDB();
    const freshDb = await initDB();

    // Verify DB has only event 1
    const midQueue = (await freshDb.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(midQueue.length, 1);
    assert.equal(midQueue[0].event_id, 'evt_crash_1');

    // Run recovery on freshDb
    const resumeRes = await restoreQuarantinedDeltas({ dbInstance: freshDb });
    assert.equal(resumeRes.success, true);
    assert.equal(resumeRes.restoredCount, 2, 'Restored the 2 remaining events (crash_2 and crash_3)');
    assert.equal(resumeRes.alreadyRestoredCount, 1, 'Recognized event crash_1 as already restored');
    assert.equal(resumeRes.newAllocatedSequence, 3);

    // Verify all 3 events are present in sequence 1, 2, 3 without duplication
    const finalQueue = (await freshDb.query('SELECT * FROM sync_delta_queue ORDER BY sequence ASC')).values || [];
    assert.equal(finalQueue.length, 3);
    assert.equal(finalQueue[0].event_id, 'evt_crash_1');
    assert.equal(Number(finalQueue[0].sequence), 1);
    assert.equal(finalQueue[1].event_id, 'evt_crash_2');
    assert.equal(Number(finalQueue[1].sequence), 2);
    assert.equal(finalQueue[2].event_id, 'evt_crash_3');
    assert.equal(Number(finalQueue[2].sequence), 3);
  });

  await t.test('3. Missing Target Entity (UPDATE): Held for review, logged in sync_conflicts, NOT re-queued into active delta queue', async () => {
    // Snapshot has transactions tx_snap_1 and tx_snap_2, but NOT tx_missing_999
    await db.run('INSERT INTO transactions (id, date, inr, amount, type, category, account) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['tx_snap_1', '2026-10-10', 100, '100', 'Expense', 'Food', 'Cash']);
    await db.run(
      'INSERT INTO sync_local_state (key, device_id, last_allocated_sequence, lifecycle_state) VALUES (?, ?, ?, ?)',
      ['device_state', 'dev_test_missing', 0, 'ACTIVE']
    );

    const quarantineRecord = {
      quarantine_id: 'q_test_missing',
      quarantined_at: new Date().toISOString(),
      reason: 'SNAPSHOT_LINEAGE_RESET',
      source_device_id: 'dev_test_missing',
      target_snapshot_id: 'snap_v10',
      target_cloud_version: 10,
      counts: { total: 1, unacknowledged: 1, acknowledged: 0 },
      events: [
        {
          event_id: 'evt_update_missing_target',
          device_id: 'dev_test_missing',
          collection: 'transactions',
          entity_id: 'tx_missing_999',
          operation: 'UPDATE',
          payload: { inr: 500, note: 'Update on missing entity' },
          status: 'PENDING'
        }
      ]
    };
    await setSetting('pre_recovery_quarantined_deltas', JSON.stringify(quarantineRecord), { suppressDeltaQueue: true });

    const res = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(res.success, true);
    assert.equal(res.restoredCount, 0, 'Must NOT re-queue update on non-existent entity');
    assert.equal(res.heldCount, 1, 'Must hold missing entity event for review');
    assert.equal(res.heldEvents.length, 1);
    assert.equal(res.heldEvents[0].event_id, 'evt_update_missing_target');
    assert.equal(res.heldEvents[0].reason, 'TARGET_ENTITY_MISSING_IN_SNAPSHOT');

    // Assert active sync_delta_queue remains 0
    const queue = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(queue.length, 0, 'Active sync_delta_queue must be 0');

    // Assert logged in sync_conflicts for review
    const conflicts = (await db.query('SELECT * FROM sync_conflicts WHERE conflict_id = ?', ['conf_quarantine_evt_update_missing_target'])).values || [];
    assert.equal(conflicts.length, 1, 'Conflict record must exist in sync_conflicts');
    assert.equal(conflicts[0].status, 'PENDING_REVIEW');
    assert.equal(conflicts[0].entity_id, 'tx_missing_999');

    // Assert quarantine held_for_review stores audit details
    const heldList = await getQuarantinedHeldEvents(db);
    assert.equal(heldList.length, 1);
    assert.equal(heldList[0].event_id, 'evt_update_missing_target');
  });

  await t.test('4. Divergent Target Entity (UPDATE with base_checksum mismatch): Held for review to prevent silent overwrite', async () => {
    // Snapshot has tx_snap_existing with current data
    const existingTxn = { id: 'tx_snap_existing', date: '2026-10-10', time: '12:00', inr: 100, amount: '100', type: 'Expense', category: 'Food', account: 'Cash' };
    await db.run(
      'INSERT INTO transactions (id, date, time, inr, amount, type, category, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [existingTxn.id, existingTxn.date, existingTxn.time, existingTxn.inr, existingTxn.amount, existingTxn.type, existingTxn.category, existingTxn.account]
    );

    await db.run(
      'INSERT INTO sync_local_state (key, device_id, last_allocated_sequence, lifecycle_state) VALUES (?, ?, ?, ?)',
      ['device_state', 'dev_test_diverged', 0, 'ACTIVE']
    );

    // Event has a base_checksum that does NOT match the snapshot's canonical fingerprint
    const divergentEvent = {
      event_id: 'evt_diverged_update',
      device_id: 'dev_test_diverged',
      collection: 'transactions',
      entity_id: 'tx_snap_existing',
      operation: 'UPDATE',
      base_checksum: 'stale_base_fingerprint_from_old_device_v8',
      payload: { inr: 999, note: 'Overriding edit' },
      status: 'PENDING'
    };

    const quarantineRecord = {
      quarantine_id: 'q_test_diverged',
      quarantined_at: new Date().toISOString(),
      reason: 'SNAPSHOT_LINEAGE_RESET',
      source_device_id: 'dev_test_diverged',
      target_snapshot_id: 'snap_v10',
      target_cloud_version: 10,
      counts: { total: 1, unacknowledged: 1, acknowledged: 0 },
      events: [divergentEvent]
    };
    await setSetting('pre_recovery_quarantined_deltas', JSON.stringify(quarantineRecord), { suppressDeltaQueue: true });

    const res = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(res.success, true);
    assert.equal(res.restoredCount, 0, 'Divergent event must NOT be automatically re-queued');
    assert.equal(res.heldCount, 1, 'Must be held for review');
    assert.equal(res.heldEvents[0].reason, 'TARGET_ENTITY_DIVERGED_IN_SNAPSHOT');

    // Confirm active sync queue has 0 rows
    const q = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(q.length, 0);

    // Confirm local database record was untouched (inr is still 100, not 999)
    const txRow = (await db.query('SELECT inr FROM transactions WHERE id = ?', ['tx_snap_existing'])).values[0];
    assert.equal(Number(txRow.inr), 100, 'Snapshot transaction data was NOT overwritten');
  });

  await t.test('5. Identical Target Entity (INSERT or UPDATE): Skipped as clean no-op without bloating delta queue', async () => {
    // Snapshot has account Cash
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['Cash', 'Cash', 'Cash']);
    await db.run(
      'INSERT INTO sync_local_state (key, device_id, last_allocated_sequence, lifecycle_state) VALUES (?, ?, ?, ?)',
      ['device_state', 'dev_test_identical', 0, 'ACTIVE']
    );

    // Event wants to insert identical account Cash
    const identicalEvent = {
      event_id: 'evt_identical_insert',
      device_id: 'dev_test_identical',
      collection: 'accounts',
      entity_id: 'Cash',
      operation: 'INSERT',
      payload: { id: 'Cash', name: 'Cash', group_name: 'Cash' },
      status: 'PENDING'
    };

    const quarantineRecord = {
      quarantine_id: 'q_test_identical',
      quarantined_at: new Date().toISOString(),
      reason: 'SNAPSHOT_LINEAGE_RESET',
      source_device_id: 'dev_test_identical',
      target_snapshot_id: 'snap_v10',
      target_cloud_version: 10,
      counts: { total: 1, unacknowledged: 1, acknowledged: 0 },
      events: [identicalEvent]
    };
    await setSetting('pre_recovery_quarantined_deltas', JSON.stringify(quarantineRecord), { suppressDeltaQueue: true });

    const res = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(res.success, true);
    assert.equal(res.restoredCount, 0);
    assert.equal(res.skippedCount, 1, 'Must skip identical entity as no-op');
    assert.equal(res.heldCount, 0);

    const q = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(q.length, 0);
  });

  await t.test('6. Exact Interruption Scenario: Crash after queue insertion but before sequence-state persistence', async () => {
    // 1. Start with sync_local_state.last_allocated_sequence = 0
    await db.run(
      'INSERT INTO sync_local_state (key, device_id, last_allocated_sequence, lifecycle_state) VALUES (?, ?, ?, ?)',
      ['device_state', 'dev_test_seq_crash', 0, 'ACTIVE']
    );

    // Seed snapshot accounts so inserts are clean
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_cash', 'Cash', 'Cash']);

    const initialQuarantine = {
      quarantine_id: 'q_test_seq_crash',
      quarantined_at: new Date().toISOString(),
      reason: 'SNAPSHOT_LINEAGE_RESET',
      source_device_id: 'dev_test_seq_crash',
      target_snapshot_id: 'snap_v10',
      target_cloud_version: 10,
      counts: { total: 3, unacknowledged: 3, acknowledged: 0 },
      events: [
        {
          event_id: 'evt_seq_crash_1',
          device_id: 'dev_test_seq_crash',
          collection: 'transactions',
          entity_id: 'tx_seq_crash_1',
          operation: 'INSERT',
          payload: { id: 'tx_seq_crash_1', inr: 100 },
          status: 'PENDING'
        },
        {
          event_id: 'evt_seq_crash_2',
          device_id: 'dev_test_seq_crash',
          collection: 'transactions',
          entity_id: 'tx_seq_crash_2',
          operation: 'INSERT',
          payload: { id: 'tx_seq_crash_2', inr: 200 },
          status: 'PENDING'
        },
        {
          event_id: 'evt_seq_crash_3',
          device_id: 'dev_test_seq_crash',
          collection: 'transactions',
          entity_id: 'tx_seq_crash_3',
          operation: 'INSERT',
          payload: { id: 'tx_seq_crash_3', inr: 300 },
          status: 'PENDING'
        }
      ]
    };
    await setSetting('pre_recovery_quarantined_deltas', JSON.stringify(initialQuarantine), { suppressDeltaQueue: true });

    // 2. Insert two quarantined events into sync_delta_queue with sequences 1 and 2
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_seq_crash_1', 'dev_test_seq_crash', 1, '2026-10-14T12:00:00Z', 'transactions', 'tx_seq_crash_1', 'INSERT', '{"id":"tx_seq_crash_1","inr":100}', 'PENDING']
    );
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_seq_crash_2', 'dev_test_seq_crash', 2, '2026-10-14T12:00:01Z', 'transactions', 'tx_seq_crash_2', 'INSERT', '{"id":"tx_seq_crash_2","inr":200}', 'PENDING']
    );

    // 3. Leave last_allocated_sequence at 0 to simulate crash after queue inserts but before sequence-state persistence
    const stateBeforeRestart = (await db.query('SELECT last_allocated_sequence FROM sync_local_state WHERE key = ?', ['device_state'])).values[0];
    assert.equal(Number(stateBeforeRestart.last_allocated_sequence), 0, 'Pre-condition: last_allocated_sequence is still 0');

    // 4. Close and reopen the database, then rerun restoreQuarantinedDeltas()
    closeDB();
    const freshDb = await initDB();

    const res = await restoreQuarantinedDeltas({ dbInstance: freshDb });
    assert.equal(res.success, true);
    assert.equal(res.alreadyRestoredCount, 2, 'Events 1 and 2 must be detected as already restored');
    assert.equal(res.restoredCount, 1, 'Event 3 must be newly restored');
    assert.equal(res.newAllocatedSequence, 3, 'Allocated sequence must be 3');

    // 5. Verify the existing events are not duplicated, the next event receives sequence 3,
    // the sequence state advances to 3, and the queue has contiguous sequences 1, 2, 3.
    const queueRows = (await freshDb.query('SELECT event_id, sequence FROM sync_delta_queue ORDER BY sequence ASC')).values || [];
    assert.equal(queueRows.length, 3, 'Queue must contain exactly 3 events without duplication');
    assert.equal(queueRows[0].event_id, 'evt_seq_crash_1');
    assert.equal(Number(queueRows[0].sequence), 1);
    assert.equal(queueRows[1].event_id, 'evt_seq_crash_2');
    assert.equal(Number(queueRows[1].sequence), 2);
    assert.equal(queueRows[2].event_id, 'evt_seq_crash_3');
    assert.equal(Number(queueRows[2].sequence), 3);

    const stateAfter = (await freshDb.query('SELECT last_allocated_sequence FROM sync_local_state WHERE key = ?', ['device_state'])).values[0];
    assert.equal(Number(stateAfter.last_allocated_sequence), 3, 'Sequence state in sync_local_state must advance to 3');
  });

  await t.test('7. Event ID Deduplication: Matching Payloads Treated as Already Restored without Duplicating or Advancing Sequence', async () => {
    await db.run(
      'INSERT INTO sync_local_state (key, device_id, last_allocated_sequence, lifecycle_state) VALUES (?, ?, ?, ?)',
      ['device_state', 'dev_test_id_match', 1, 'ACTIVE']
    );

    // Pre-existing event in sync_delta_queue with event_id = 'evt_matched_id', payload INR = 100
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_matched_id', 'dev_test_id_match', 1, '2026-10-14T12:00:00Z', 'transactions', 'tx_matched', 'INSERT', JSON.stringify({ id: 'tx_matched', inr: 100, note: 'identical payload' }), 'PENDING']
    );

    // Quarantined event has THE SAME event_id ('evt_matched_id') AND MATCHING payload
    const quarantineRecord = {
      quarantine_id: 'q_test_id_match',
      quarantined_at: new Date().toISOString(),
      reason: 'SNAPSHOT_LINEAGE_RESET',
      source_device_id: 'dev_test_id_match',
      target_snapshot_id: 'snap_v10',
      target_cloud_version: 10,
      counts: { total: 1, unacknowledged: 1, acknowledged: 0 },
      events: [
        {
          event_id: 'evt_matched_id',
          device_id: 'dev_test_id_match',
          collection: 'transactions',
          entity_id: 'tx_matched',
          operation: 'INSERT',
          payload: { id: 'tx_matched', inr: 100, note: 'identical payload' },
          status: 'PENDING'
        }
      ]
    };
    await setSetting('pre_recovery_quarantined_deltas', JSON.stringify(quarantineRecord), { suppressDeltaQueue: true });

    const res = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(res.success, true);
    assert.equal(res.restoredCount, 0, 'Zero new events restored');
    assert.equal(res.alreadyRestoredCount, 1, 'Recognized matching event as already restored');
    assert.equal(res.heldCount, 0, 'Zero events held');
    assert.equal(res.newAllocatedSequence, 1, 'Sequence must not advance');

    const queueRows = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(queueRows.length, 1, 'Zero duplicate rows in queue');
    assert.equal(queueRows[0].event_id, 'evt_matched_id');
    assert.equal(Number(queueRows[0].sequence), 1);
  });

  await t.test('8. Event ID Collision with Divergent Payload: Held for Review, Idempotent on Retries, and Preserves Both Versions Across Interruption/Restart', async () => {
    await db.run(
      'INSERT INTO sync_local_state (key, device_id, last_allocated_sequence, lifecycle_state) VALUES (?, ?, ?, ?)',
      ['device_state', 'dev_test_id_diverge', 1, 'ACTIVE']
    );

    // Pre-existing event in sync_delta_queue with event_id = 'evt_collision_id', payload INR = 100
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['evt_collision_id', 'dev_test_id_diverge', 1, '2026-10-14T12:00:00Z', 'transactions', 'tx_collision', 'INSERT', JSON.stringify({ id: 'tx_collision', inr: 100, note: 'queued original payload' }), 'PENDING']
    );

    // Quarantined event has THE SAME event_id ('evt_collision_id') but a DIVERGENT payload (INR = 9999)
    const quarantineRecord = {
      quarantine_id: 'q_test_id_diverge',
      quarantined_at: new Date().toISOString(),
      reason: 'SNAPSHOT_LINEAGE_RESET',
      source_device_id: 'dev_test_id_diverge',
      target_snapshot_id: 'snap_v10',
      target_cloud_version: 10,
      counts: { total: 1, unacknowledged: 1, acknowledged: 0 },
      events: [
        {
          event_id: 'evt_collision_id',
          device_id: 'dev_test_id_diverge',
          collection: 'transactions',
          entity_id: 'tx_collision',
          operation: 'INSERT',
          payload: { id: 'tx_collision', inr: 9999, note: 'quarantined divergent payload' },
          status: 'PENDING'
        }
      ]
    };
    await setSetting('pre_recovery_quarantined_deltas', JSON.stringify(quarantineRecord), { suppressDeltaQueue: true });

    // --- CALL 1: Detects collision, holds for review, logs conflict ---
    const res1 = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(res1.success, true);
    assert.equal(res1.restoredCount, 0, 'Must NOT re-queue divergent collision');
    assert.equal(res1.alreadyRestoredCount, 0, 'Must NOT treat divergent collision as already restored');
    assert.equal(res1.newlyHeldCount, 1, 'Must hold divergent collision for review');
    assert.equal(res1.heldEvents[0].reason, 'EVENT_ID_COLLISION_WITH_DIVERGENT_PAYLOAD');
    assert.equal(res1.newAllocatedSequence, 1, 'Sequence must not advance');

    // Verify existing queued row was NOT overwritten
    const qRows1 = (await db.query('SELECT * FROM sync_delta_queue WHERE event_id = ?', ['evt_collision_id'])).values || [];
    assert.equal(qRows1.length, 1);
    const qPayload1 = JSON.parse(qRows1[0].payload);
    assert.equal(qPayload1.inr, 100, 'Original queued payload (100) must remain intact');

    // Verify quarantined divergent payload was preserved in sync_conflicts
    const confRows1 = (await db.query('SELECT * FROM sync_conflicts WHERE conflict_id = ?', ['conf_quarantine_evt_collision_id'])).values || [];
    assert.equal(confRows1.length, 1);
    assert.equal(confRows1[0].status, 'PENDING_REVIEW');
    assert.equal(confRows1[0].resolution, 'QUARANTINE_HELD: EVENT_ID_COLLISION_WITH_DIVERGENT_PAYLOAD');
    const remoteState = JSON.parse(confRows1[0].remote_state);
    assert.equal(remoteState.inr, 9999, 'Quarantined divergent payload (9999) must be preserved in remote_state');

    // --- CALL 2: Repeated call (idempotency) ---
    const res2 = await restoreQuarantinedDeltas({ dbInstance: db });
    assert.equal(res2.success, true);
    assert.equal(res2.restoredCount, 0);
    assert.equal(res2.newlyHeldCount, 0);
    assert.equal(res2.alreadyHeldCount, 1, 'Recognized as already held');
    assert.equal(res2.newAllocatedSequence, 1);

    const confRows2 = (await db.query('SELECT * FROM sync_conflicts WHERE conflict_id = ?', ['conf_quarantine_evt_collision_id'])).values || [];
    assert.equal(confRows2.length, 1, 'Conflict record must not duplicate on repeated calls');

    // --- CALL 3: Interruption / Restart Simulation ---
    closeDB();
    const freshDb = await initDB();

    const res3 = await restoreQuarantinedDeltas({ dbInstance: freshDb });
    assert.equal(res3.success, true);
    assert.equal(res3.restoredCount, 0);
    assert.equal(res3.newAllocatedSequence, 1);

    // Confirm neither version was lost across restart
    const qRowsRestart = (await freshDb.query('SELECT * FROM sync_delta_queue WHERE event_id = ?', ['evt_collision_id'])).values || [];
    assert.equal(qRowsRestart.length, 1);
    assert.equal(JSON.parse(qRowsRestart[0].payload).inr, 100, 'Queued version (100) intact after restart');

    const confRestart = (await freshDb.query('SELECT * FROM sync_conflicts WHERE conflict_id = ?', ['conf_quarantine_evt_collision_id'])).values || [];
    assert.equal(confRestart.length, 1);
    assert.equal(JSON.parse(confRestart[0].remote_state).inr, 9999, 'Quarantined divergent version (9999) intact after restart');
  });
});

