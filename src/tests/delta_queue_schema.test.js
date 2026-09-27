/**
 * delta_queue_schema.test.js — Phase 7.1 Schema Upgrade & Delta Queue Storage Tests
 * 
 * Verifies non-destructive v13 -> v14 schema migration, sync_delta_queue and sync_local_state
 * storage creation, durable sequence state management, and delta event querying.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  initDB,
  closeDB,
  getDB,
  getRawIDB,
  addTransaction,
  getTransactions,
  recordTombstone,
  getTombstones,
  createDeltaEvent,
  initLocalSyncState,
  getLocalSyncState,
  getPendingDeltaEvents,
  getDeltaQueueStats,
  DELTA_STATUS,
  DELTA_OPERATION
} from '../database/index.js';

test('FinMan Phase 7.1 — Delta Queue Schema & Sequence State Test Suite', async (t) => {

  t.beforeEach(() => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
  });

  t.afterEach(() => {
    closeDB();
  });

  await t.test('1. Fresh DB Creation (v14) — sync_delta_queue and sync_local_state stores exist and are operational', async () => {
    const db = await initDB();
    assert.ok(db, 'DB instance initialized');

    const queueRes = await db.query('SELECT * FROM sync_delta_queue');
    assert.deepEqual(queueRes.values, []);

    const stateRes = await db.query('SELECT * FROM sync_local_state');
    assert.deepEqual(stateRes.values, []);
  });

  await t.test('2. v13 -> v14 Schema Migration — Existing financial records, tombstones, and settings are 100% preserved', async () => {
    // Step 1: Open v13 database manually and seed legacy data
    const idb = await new Promise((resolve, reject) => {
      const req = globalThis.indexedDB.open('finman_v2', 13);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        d.createObjectStore('transactions', { keyPath: 'id' });
        d.createObjectStore('accounts', { keyPath: 'id' });
        d.createObjectStore('categories', { keyPath: 'id' });
        d.createObjectStore('settings', { keyPath: 'key' });
        d.createObjectStore('sync_tombstones', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // Seed v13 data
    await new Promise((resolve, reject) => {
      const tx = idb.transaction(['transactions', 'settings', 'sync_tombstones'], 'readwrite');
      tx.objectStore('transactions').put({
        id: 'txn_v13_seed',
        date: '2026-09-27',
        inr: 5000,
        account: 'HDFC',
        category: 'Salary'
      });
      tx.objectStore('settings').put({ key: 'theme', value: 'dark' });
      tx.objectStore('sync_tombstones').put({
        id: 'txn_deleted_in_v13',
        entity_type: 'transaction',
        deleted_at: '2026-09-20T10:00:00.000Z'
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    idb.close();

    // Step 2: Run initDB() to execute v13 -> v14 migration
    const upgradedDb = await initDB();
    assert.ok(upgradedDb);

    // Verify existing v13 data survived
    const txns = await getTransactions();
    assert.equal(txns.length, 1);
    assert.equal(txns[0].id, 'txn_v13_seed');
    assert.equal(txns[0].INR, 5000);

    const tombstones = await getTombstones();
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0].id, 'txn_deleted_in_v13');

    const setting = await upgradedDb.query('SELECT * FROM settings WHERE key = ?', ['theme']);
    assert.equal(setting.values?.[0]?.value, 'dark');

    // Verify new v14 stores were created during upgrade
    const stats = await getDeltaQueueStats();
    assert.equal(stats.totalEvents, 0);
  });

  await t.test('3. DeltaEvent Factory Validation — Rejects invalid events and enforces required schema fields', () => {
    // Valid event
    const validEvent = createDeltaEvent({
      device_id: 'dev_test_1',
      sequence: 1,
      collection: 'transactions',
      entity_id: 'txn_001',
      operation: DELTA_OPERATION.INSERT,
      new_checksum: 'a'.repeat(64),
      payload: { inr: 100 }
    });

    assert.equal(validEvent.device_id, 'dev_test_1');
    assert.equal(validEvent.sequence, 1);
    assert.equal(validEvent.status, DELTA_STATUS.PENDING);
    assert.equal(validEvent.bundle_total, 1);
    assert.equal(validEvent.tombstone_generation, 0);

    // Invalid: missing device_id
    assert.throws(() => {
      createDeltaEvent({
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_001',
        operation: 'INSERT'
      });
    }, /device_id/);

    // Invalid: sequence < 1
    assert.throws(() => {
      createDeltaEvent({
        device_id: 'dev_test_1',
        sequence: 0,
        collection: 'transactions',
        entity_id: 'txn_001',
        operation: 'INSERT'
      });
    }, /positive numeric sequence/);

    // Invalid: unknown operation
    assert.throws(() => {
      createDeltaEvent({
        device_id: 'dev_test_1',
        sequence: 1,
        collection: 'transactions',
        entity_id: 'txn_001',
        operation: 'DROP_TABLE'
      });
    }, /Invalid DeltaEvent operation/);
  });

  await t.test('4. Durable Device State Initialization & Persistence', async () => {
    const db = await initDB();

    // Initial state setup
    const state = await initLocalSyncState('dev_custom_c');
    assert.equal(state.device_id, 'dev_custom_c');
    assert.equal(state.last_allocated_sequence, 0);
    assert.equal(state.last_pushed_sequence, 0);

    // Idempotent init: calling again returns the existing state
    const stateSecondCall = await initLocalSyncState('dev_ignored');
    assert.equal(stateSecondCall.device_id, 'dev_custom_c');

    // Verify persisted in DB
    const fetched = await getLocalSyncState();
    assert.equal(fetched.device_id, 'dev_custom_c');
    assert.equal(fetched.last_allocated_sequence, 0);
  });

  await t.test('5. Queue Insertion & Pending Event Watermark Querying', async () => {
    const db = await initDB();
    await initLocalSyncState('dev_test_node');

    // Insert 3 sequential delta events
    const event1 = createDeltaEvent({
      event_id: 'evt_1',
      device_id: 'dev_test_node',
      sequence: 1,
      collection: 'transactions',
      entity_id: 'txn_1',
      operation: DELTA_OPERATION.INSERT,
      new_checksum: '1'.repeat(64),
      payload: { id: 'txn_1', inr: 100 }
    });

    const event2 = createDeltaEvent({
      event_id: 'evt_2',
      device_id: 'dev_test_node',
      sequence: 2,
      collection: 'transactions',
      entity_id: 'txn_1',
      operation: DELTA_OPERATION.UPDATE,
      base_checksum: '1'.repeat(64),
      new_checksum: '2'.repeat(64),
      payload: { id: 'txn_1', inr: 200 }
    });

    const event3 = createDeltaEvent({
      event_id: 'evt_3',
      device_id: 'dev_test_node',
      sequence: 3,
      collection: 'transactions',
      entity_id: 'txn_2',
      operation: DELTA_OPERATION.INSERT,
      new_checksum: '3'.repeat(64),
      payload: { id: 'txn_2', inr: 300 }
    });

    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, tombstone_generation, payload, status, bundle_id, bundle_index, bundle_total, bundle_checksum, parent_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [event1.event_id, event1.device_id, event1.sequence, event1.timestamp, event1.collection, event1.entity_id, event1.operation, event1.base_checksum, event1.new_checksum, event1.tombstone_generation, JSON.stringify(event1.payload), event1.status, event1.bundle_id, event1.bundle_index, event1.bundle_total, event1.bundle_checksum, event1.parent_event_id]
    );

    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, tombstone_generation, payload, status, bundle_id, bundle_index, bundle_total, bundle_checksum, parent_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [event2.event_id, event2.device_id, event2.sequence, event2.timestamp, event2.collection, event2.entity_id, event2.operation, event2.base_checksum, event2.new_checksum, event2.tombstone_generation, JSON.stringify(event2.payload), event2.status, event2.bundle_id, event2.bundle_index, event2.bundle_total, event2.bundle_checksum, event2.parent_event_id]
    );

    await db.run(
      'INSERT INTO sync_delta_queue (event_id, device_id, sequence, timestamp, collection, entity_id, operation, base_checksum, new_checksum, tombstone_generation, payload, status, bundle_id, bundle_index, bundle_total, bundle_checksum, parent_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [event3.event_id, event3.device_id, event3.sequence, event3.timestamp, event3.collection, event3.entity_id, event3.operation, event3.base_checksum, event3.new_checksum, event3.tombstone_generation, JSON.stringify(event3.payload), event3.status, event3.bundle_id, event3.bundle_index, event3.bundle_total, event3.bundle_checksum, event3.parent_event_id]
    );

    // Query all pending
    const allPending = await getPendingDeltaEvents();
    assert.equal(allPending.length, 3);
    assert.equal(allPending[0].sequence, 1);
    assert.equal(allPending[1].sequence, 2);
    assert.equal(allPending[2].sequence, 3);
    assert.deepEqual(allPending[0].payload, { id: 'txn_1', inr: 100 });

    // Query with watermark <= 2
    const watermarked = await getPendingDeltaEvents(2);
    assert.equal(watermarked.length, 2);
    assert.equal(watermarked[0].event_id, 'evt_1');
    assert.equal(watermarked[1].event_id, 'evt_2');

    // Verify stats
    const stats = await getDeltaQueueStats();
    assert.equal(stats.totalEvents, 3);
    assert.equal(stats.pendingCount, 3);
    assert.equal(stats.maxSequence, 3);
  });

  await t.test('6. Reopening Database After Migration — Retains all v14 structures cleanly', async () => {
    const db1 = await initDB();
    await initLocalSyncState('dev_restart_test');
    closeDB();

    // Reopen
    const db2 = await initDB();
    const state = await getLocalSyncState();
    assert.equal(state.device_id, 'dev_restart_test');
  });

  await t.test('7. Atomic Transaction Sequence Allocation — Entity mutation, queue event, and sequence state commit together', async () => {
    await initDB();
    await initLocalSyncState('dev_txn_coupling');

    // Simulate an atomic transaction boundary (such as Phase 7.2 interceptor)
    const rawIdb = getRawIDB();

    await new Promise((resolve, reject) => {
      const tx = rawIdb.transaction(['transactions', 'sync_delta_queue', 'sync_local_state'], 'readwrite');
      const stateStore = tx.objectStore('sync_local_state');
      const txnStore = tx.objectStore('transactions');
      const queueStore = tx.objectStore('sync_delta_queue');

      const stateReq = stateStore.get('device_state');
      stateReq.onsuccess = () => {
        const state = stateReq.result;
        const nextSeq = (state.last_allocated_sequence || 0) + 1;
        state.last_allocated_sequence = nextSeq;
        state.updated_at = new Date().toISOString();

        stateStore.put(state);
        txnStore.put({ id: 'txn_coupled_1', inr: 450, account: 'Cash' });
        queueStore.put(createDeltaEvent({
          event_id: 'evt_coupled_1',
          device_id: state.device_id,
          sequence: nextSeq,
          collection: 'transactions',
          entity_id: 'txn_coupled_1',
          operation: DELTA_OPERATION.INSERT,
          new_checksum: '4'.repeat(64),
          payload: { id: 'txn_coupled_1', inr: 450 }
        }));
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Verify all 3 stores committed
    const state = await getLocalSyncState();
    assert.equal(state.last_allocated_sequence, 1);

    const txns = await getTransactions();
    assert.equal(txns.length, 1);
    assert.equal(txns[0].id, 'txn_coupled_1');

    const stats = await getDeltaQueueStats();
    assert.equal(stats.totalEvents, 1);
    assert.equal(stats.maxSequence, 1);
  });

  await t.test('8. Transaction Abort Rollback — Failed mutation leaves sequence state un-incremented (no gaps/orphans)', async () => {
    await initDB();
    await initLocalSyncState('dev_abort_test');

    const rawIdb = getRawIDB();

    // Attempt a transaction that aborts midway
    let caughtErr = null;
    try {
      await new Promise((resolve, reject) => {
        const tx = rawIdb.transaction(['transactions', 'sync_delta_queue', 'sync_local_state'], 'readwrite');
        const stateStore = tx.objectStore('sync_local_state');
        const stateReq = stateStore.get('device_state');
        stateReq.onsuccess = () => {
          const state = stateReq.result;
          state.last_allocated_sequence = 999;
          stateStore.put(state);
          // Force transaction abort
          try {
            tx.abort();
            reject(new Error('Transaction deliberately aborted'));
          } catch (e) {
            reject(e);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(new Error('Transaction deliberately aborted'));
        tx.onerror = () => reject(tx.error || new Error('Transaction error'));
      });
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Transaction must throw on abort');
    assert.match(caughtErr.message, /aborted/);

    // Verify sequence state remained rolled back at 0
    const state = await getLocalSyncState();
    assert.equal(state.last_allocated_sequence, 0);

    const stats = await getDeltaQueueStats();
    assert.equal(stats.totalEvents, 0);
  });

  await t.test('9. Browser Restart Sequence Resumption — Resumes from durable sequence without duplicate IDs', async () => {
    // Context 1: Allocate up to sequence 5
    await initDB();
    await initLocalSyncState('dev_restart_seq');
    const db1 = getDB();
    await db1.run(
      'UPDATE sync_local_state SET last_allocated_sequence = ? WHERE key = ?',
      [5, 'device_state']
    );
    closeDB();

    // Context 2: Simulated browser restart
    await initDB();
    const state = await getLocalSyncState();
    assert.equal(state.last_allocated_sequence, 5);

    // Next sequence allocated is 6
    const nextSeq = state.last_allocated_sequence + 1;
    assert.equal(nextSeq, 6);
  });
});

