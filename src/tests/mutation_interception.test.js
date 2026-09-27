/**
 * mutation_interception.test.js — Phase 7.2.2 Mutation Interception & Atomic Multi-Store Delta Capture Suite
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
  updateTransaction,
  deleteTransaction,
  deleteAllTransactions,
  bulkImport,
  replaceAccounts,
  replaceAccountGroups,
  replaceAccountMapping,
  replaceCategories,
  setBudget,
  deleteBudget,
  replaceBudgets,
  saveRecurringRule,
  updateRecurringRule,
  deleteRecurringRule,
  saveInvestmentPlan,
  updateInvestmentPlan,
  deleteInvestmentPlan,
  setSetting,
  getSetting,
  addInventoryPurchase,
  consumeInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  restoreInventoryItem,
  getPendingDeltaEvents,
  getTombstones,
  initLocalSyncState,
  getLocalSyncState,
  executeAtomicMutation,
  executeAtomicBatch
} from '../database/index.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';

test('FinMan Phase 7.2.2 — Mutation Interception & Atomic Delta Capture Suite', async (t) => {

  t.beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    await initDB();
  });

  t.afterEach(() => {
    closeDB();
  });

  await t.test('M01: Transaction INSERT atomically writes entity, delta event with seq=1, base_checksum=null', async () => {
    const txnData = {
      id: 'txn-m01-1',
      date: '2026-09-27',
      type: 'EXPENSE',
      amount: 50.00,
      category: 'Food',
      account: 'Checking',
      notes: 'Lunch'
    };

    const result = await addTransaction(txnData);
    assert.ok(result);

    const queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 1);
    const event = queue[0];

    assert.equal(event.collection, 'transactions');
    assert.equal(event.entity_id, 'txn-m01-1');
    assert.equal(event.operation, 'INSERT');
    assert.equal(event.sequence, 1);
    assert.equal(event.base_checksum, null);
    assert.ok(event.new_checksum);
    assert.ok(event.payload);
    assert.equal(event.payload.inr, 50.00);

    // Verify checksum matches canonical computation
    const expectedChecksum = await computeCanonicalSha256(event.payload);
    assert.equal(event.new_checksum, expectedChecksum);
  });

  await t.test('M02: Transaction UPDATE atomically writes entity and delta event with correct base_checksum', async () => {
    const initialTxn = {
      id: 'txn-m02-1',
      date: '2026-09-27',
      type: 'EXPENSE',
      amount: 100.00,
      category: 'Groceries',
      account: 'Checking'
    };
    await addTransaction(initialTxn);

    const queueAfterInsert = await getPendingDeltaEvents();
    const insertChecksum = queueAfterInsert[0].new_checksum;

    const updatedTxn = {
      ...initialTxn,
      amount: 125.50,
      notes: 'Added extra items'
    };
    await updateTransaction(updatedTxn);

    const queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 2);

    const updateEvent = queue[1];
    assert.equal(updateEvent.collection, 'transactions');
    assert.equal(updateEvent.entity_id, 'txn-m02-1');
    assert.equal(updateEvent.operation, 'UPDATE');
    assert.equal(updateEvent.sequence, 2);
    assert.equal(updateEvent.base_checksum, insertChecksum);
    assert.ok(updateEvent.new_checksum);
    assert.notEqual(updateEvent.new_checksum, insertChecksum);
    assert.equal(updateEvent.payload.inr, 125.50);
  });

  await t.test('M03: Transaction DELETE creates tombstone + delta event (operation=DELETE, new_checksum=null)', async () => {
    const txnData = {
      id: 'txn-m03-1',
      date: '2026-09-27',
      type: 'INCOME',
      amount: 2500.00,
      account: 'Savings'
    };
    await addTransaction(txnData);

    const queueAfterInsert = await getPendingDeltaEvents();
    const insertChecksum = queueAfterInsert[0].new_checksum;

    await deleteTransaction('txn-m03-1');

    // Check delta queue
    const queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 2);
    const deleteEvent = queue[1];

    assert.equal(deleteEvent.collection, 'transactions');
    assert.equal(deleteEvent.entity_id, 'txn-m03-1');
    assert.equal(deleteEvent.operation, 'DELETE');
    assert.equal(deleteEvent.sequence, 2);
    assert.equal(deleteEvent.base_checksum, insertChecksum);
    assert.equal(deleteEvent.new_checksum, null);

    // Check tombstone
    const tombstones = await getTombstones();
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0].entity_type, 'transaction');
    assert.equal(tombstones[0].id, 'txn-m03-1');
  });

  await t.test('M04: Genuine In-Flight IDB Transaction Abort and Rollback', async () => {
    // 1. Start with valid stores and initial state
    await initLocalSyncState('dev_test_rollback');
    const rawIdb = getRawIDB();

    // 2. Open a real readwrite transaction across all stores
    const tx = rawIdb.transaction(['transactions', 'sync_delta_queue', 'sync_tombstones', 'sync_local_state'], 'readwrite');
    const txnStore = tx.objectStore('transactions');
    const queueStore = tx.objectStore('sync_delta_queue');
    const tombStore = tx.objectStore('sync_tombstones');
    const stateStore = tx.objectStore('sync_local_state');

    // 3. Perform writes into each store inside the transaction
    txnStore.put({ id: 'aborted-txn-1', inr: 999.00, note: 'Should be rolled back' });
    queueStore.put({
      event_id: 'aborted-evt-1',
      device_id: 'dev_test_rollback',
      sequence: 99,
      timestamp: new Date().toISOString(),
      collection: 'transactions',
      entity_id: 'aborted-txn-1',
      operation: 'INSERT',
      payload: { id: 'aborted-txn-1', inr: 999.00 },
      status: 'PENDING'
    });
    tombStore.put({
      id: 'aborted-tomb-1',
      entity_type: 'transaction',
      deleted_at: new Date().toISOString()
    });
    stateStore.put({
      key: 'device_state',
      device_id: 'dev_test_rollback',
      last_allocated_sequence: 99,
      last_pushed_sequence: 0,
      updated_at: new Date().toISOString()
    });

    // 4. Force a genuine failure / abort AFTER writes have been queued
    const abortPromise = new Promise((resolve) => {
      tx.onabort = () => resolve('ABORTED');
    });

    tx.abort();
    const abortResult = await abortPromise;
    assert.equal(abortResult, 'ABORTED');

    // 5. Open a brand-new transaction to read persisted state
    const verifyTx = rawIdb.transaction(['transactions', 'sync_delta_queue', 'sync_tombstones', 'sync_local_state'], 'readonly');
    const verifyTxn = verifyTx.objectStore('transactions').get('aborted-txn-1');
    const verifyQueue = verifyTx.objectStore('sync_delta_queue').get('aborted-evt-1');
    const verifyTomb = verifyTx.objectStore('sync_tombstones').get('aborted-tomb-1');
    const verifyState = verifyTx.objectStore('sync_local_state').get('device_state');

    await new Promise(res => { verifyTx.oncomplete = res; });

    // Verify ZERO mutations persisted
    assert.equal(verifyTxn.result, undefined, 'Entity write must be completely rolled back');
    assert.equal(verifyQueue.result, undefined, 'Delta event write must be completely rolled back');
    assert.equal(verifyTomb.result, undefined, 'Tombstone write must be completely rolled back');
    assert.equal(verifyState.result.last_allocated_sequence, 0, 'Sequence state must NOT advance');
  });

  await t.test('M05: A -> B -> C Lineage Contiguity', async () => {
    const id = 'txn-lineage-1';
    await addTransaction({ id, amount: 10, note: 'State A' });
    await updateTransaction(id, { id, amount: 20, note: 'State B' });
    await updateTransaction(id, { id, amount: 30, note: 'State C' });

    const queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 3);

    const [evtA, evtB, evtC] = queue;

    assert.equal(evtA.sequence, 1);
    assert.equal(evtA.base_checksum, null);
    const checksumA = evtA.new_checksum;

    assert.equal(evtB.sequence, 2);
    assert.equal(evtB.base_checksum, checksumA);
    const checksumB = evtB.new_checksum;

    assert.equal(evtC.sequence, 3);
    assert.equal(evtC.base_checksum, checksumB);
  });

  await t.test('M06: Bulk Import captures contiguous sequences and skips duplicates/ignored rows', async () => {
    await addTransaction({ id: 'existing-1', amount: 100, date: '2026-09-01' });

    const importRows = [
      { id: 'import-1', amount: 200, date: '2026-09-02' },
      { id: 'import-2', amount: 300, date: '2026-09-03' },
      { id: 'existing-1', amount: 100, date: '2026-09-01' }
    ];

    const result = await bulkImport(importRows);
    assert.equal(result.imported, 2);

    const queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 3);

    assert.equal(queue[1].entity_id, 'import-1');
    assert.equal(queue[1].sequence, 2);
    assert.equal(queue[2].entity_id, 'import-2');
    assert.equal(queue[2].sequence, 3);
  });

  await t.test('M07: Investment Trade + Companion Charges creates a logical bundle', async () => {
    const tradeTxn = {
      id: 'trade-bundle-1',
      date: '2026-09-27',
      type: 'BUY',
      account: 'Brokerage',
      symbol: 'AAPL',
      units: 10,
      unitPrice: 150,
      amount: 1500,
      companion_charges: [
        { id: 'charge-1', amount: 5.00, category: 'Brokerage Fee' },
        { id: 'charge-2', amount: 2.50, category: 'Exchange Fee' }
      ]
    };

    await addTransaction(tradeTxn);

    const queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 3);

    const [evtTrade, evtCharge1, evtCharge2] = queue;

    assert.ok(evtTrade.bundle_id);
    assert.equal(evtTrade.bundle_id, evtCharge1.bundle_id);
    assert.equal(evtTrade.bundle_id, evtCharge2.bundle_id);

    assert.equal(evtTrade.bundle_total, 3);
    assert.equal(evtTrade.bundle_index, 0);

    assert.equal(evtCharge1.bundle_index, 1);
    assert.equal(evtCharge1.bundle_total, 3);

    assert.equal(evtCharge2.bundle_index, 2);
    assert.equal(evtCharge2.bundle_total, 3);

    assert.equal(evtTrade.sequence, 1);
    assert.equal(evtCharge1.sequence, 2);
    assert.equal(evtCharge2.sequence, 3);
  });

  await t.test('M08: Inventory Purchase Bundle commits inventory rows + transfer transaction atomically', async () => {
    const purchaseData = {
      fromAccount: 'Cash',
      date: '2026-09-27',
      items: [
        { name: 'Raw Material A', pack_qty: 1, sub_qty: 10, sub_unit: 'pcs', original_qty: 10, price: 300, discounted_price: 300 },
        { name: 'Raw Material B', pack_qty: 1, sub_qty: 4, sub_unit: 'pcs', original_qty: 4, price: 200, discounted_price: 200 }
      ]
    };

    const result = await addInventoryPurchase(purchaseData);
    assert.ok(result);

    const queue = await getPendingDeltaEvents();
    // 1 transfer txn + 2 inventory items = 3 delta events
    assert.equal(queue.length, 3);

    const [evtTxn, evtItem1, evtItem2] = queue;
    assert.equal(evtTxn.collection, 'transactions');
    assert.equal(evtItem1.collection, 'inventory');
    assert.equal(evtItem2.collection, 'inventory');

    assert.ok(evtTxn.bundle_id);
    assert.equal(evtTxn.bundle_id, evtItem1.bundle_id);
    assert.equal(evtTxn.bundle_id, evtItem2.bundle_id);
    assert.equal(evtTxn.bundle_total, 3);
  });

  await t.test('M09: Genuine Stale-Precondition Concurrency Race & Retry Suite', async () => {
    // 1. Initial state: Add entity A
    const id = 'txn-concur-race-1';
    await addTransaction({ id, amount: 100, note: 'State A' });

    const db = getDB();
    const resA = await db.query('SELECT * FROM transactions WHERE id = ?', [id]);
    const entityA = resA.values[0];
    const checksumA = await computeCanonicalSha256(entityA);

    // 2. Context 1: Prepares A -> B with expectedBaseEntity = A
    const entityB = { ...entityA, inr: 200, amount: '200', note: 'State B' };
    const context1PreparedOp = {
      storeName: 'transactions',
      id,
      operation: 'UPDATE',
      entity: entityB,
      expectedBaseEntity: entityA,
      base_checksum: checksumA
    };

    // 3. Context 2: Concurrent update A -> C commits first
    const entityC = { ...entityA, inr: 300, amount: '300', note: 'State C' };
    await updateTransaction(id, entityC);

    const stateAfterC = await getLocalSyncState();
    assert.equal(stateAfterC.last_allocated_sequence, 2);

    const queueAfterC = await getPendingDeltaEvents();
    assert.equal(queueAfterC.length, 2);
    const checksumC = queueAfterC[1].new_checksum;

    // 4. Context 1 attempts A -> B: Must detect stale precondition (DB is at C, expected was A)
    await assert.rejects(
      async () => await executeAtomicBatch({ operations: [context1PreparedOp] }),
      (err) => err.message === 'PRECONDITION_FAILED'
    );

    // Verify failed attempt produced NO mutation, NO delta event, NO sequence increment
    const stateAfterFail = await getLocalSyncState();
    assert.equal(stateAfterFail.last_allocated_sequence, 2);
    const queueAfterFail = await getPendingDeltaEvents();
    assert.equal(queueAfterFail.length, 2);

    // 5. Context 1 performs optimistic retry: re-reads C and produces C -> B
    const resFresh = await db.query('SELECT * FROM transactions WHERE id = ?', [id]);
    const freshInDb = resFresh.values[0];
    assert.equal(freshInDb.inr, 300);

    const freshChecksum = await computeCanonicalSha256(freshInDb);
    assert.equal(freshChecksum, checksumC);

    const entityBFromC = { ...freshInDb, inr: 200, amount: '200', note: 'State B' };
    await executeAtomicBatch({
      operations: [{
        storeName: 'transactions',
        id,
        operation: 'UPDATE',
        entity: entityBFromC,
        expectedBaseEntity: freshInDb,
        base_checksum: freshChecksum
      }]
    });

    // 6. Verify final state and continuous queue lineage A -> C -> B
    const finalQueue = await getPendingDeltaEvents();
    assert.equal(finalQueue.length, 3);

    const [evtA, evtC, evtB] = finalQueue;
    assert.equal(evtA.sequence, 1);
    assert.equal(evtA.base_checksum, null);

    assert.equal(evtC.sequence, 2);
    assert.equal(evtC.base_checksum, evtA.new_checksum);

    assert.equal(evtB.sequence, 3);
    assert.equal(evtB.base_checksum, evtC.new_checksum);
  });

  await t.test('M10: Genuine Multi-Context Concurrent Sequence Allocation', async () => {
    // 1. Start from sequence 100
    const rawIdb = getRawIDB();
    const txInit = rawIdb.transaction(['sync_local_state'], 'readwrite');
    txInit.objectStore('sync_local_state').put({
      key: 'device_state',
      device_id: 'dev_multi_concur',
      last_allocated_sequence: 100,
      last_pushed_sequence: 0,
      updated_at: new Date().toISOString()
    });
    await new Promise(res => { txInit.oncomplete = res; });

    // 2. Launch 5 independent mutation contexts concurrently
    const contexts = [
      addTransaction({ id: 'm10-c1', amount: 10, note: 'Context 1' }),
      addTransaction({ id: 'm10-c2', amount: 20, note: 'Context 2' }),
      addTransaction({ id: 'm10-c3', amount: 30, note: 'Context 3' }),
      addTransaction({ id: 'm10-c4', amount: 40, note: 'Context 4' }),
      addTransaction({ id: 'm10-c5', amount: 50, note: 'Context 5' })
    ];

    const results = await Promise.all(contexts);
    assert.equal(results.length, 5);

    // 3. Query all generated delta events
    const queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 5);

    const allocatedSequences = queue.map(e => e.sequence);
    // Verify all 5 sequences are strictly unique and contiguous: [101, 102, 103, 104, 105]
    assert.deepEqual(allocatedSequences, [101, 102, 103, 104, 105]);

    // Verify sync_local_state ends at highest committed sequence
    const finalState = await getLocalSyncState();
    assert.equal(finalState.last_allocated_sequence, 105);
  });

  await t.test('M11: Inventory Consumption Atomicity Test (Rollback on failure, Single-Bundle commit on success)', async () => {
    // 1. Create initial inventory batch
    const purchaseResult = await addInventoryPurchase({
      fromAccount: 'Bank',
      date: '2026-09-27',
      items: [
        { name: 'Flour Grade A', pack_qty: 1, sub_qty: 10, sub_unit: 'kg', original_qty: 10, price: 500, discounted_price: 500 }
      ]
    });
    assert.ok(purchaseResult);

    const db = getDB();
    const invList = (await db.query('SELECT * FROM inventory')).values || [];
    assert.equal(invList.length, 1);
    const flourItem = invList[0];
    assert.equal(flourItem.qty, 10);

    const queueBefore = await getPendingDeltaEvents();
    const seqBefore = queueBefore.length;

    // 2. Simulate failure case during consumeInventoryItem
    // Verify that attempting consumption of non-existent item or zero qty rejects without corrupting inventory
    await assert.rejects(
      async () => await consumeInventoryItem(
        'non_existent_item_id',
        4,
        '2026-09-27'
      )
    );

    // Verify inventory untouched and no delta events created
    const invAfterFail = (await db.query('SELECT * FROM inventory')).values || [];
    assert.equal(invAfterFail[0].qty, 10);
    const queueAfterFail = await getPendingDeltaEvents();
    assert.equal(queueAfterFail.length, seqBefore);

    // 3. Successful consumeInventoryItem: 4 kg consumed
    const consumeResult = await consumeInventoryItem(
      flourItem.id,
      4,
      '2026-09-27',
      false,
      'To Home',
      'Groceries',
      'consume',
      '',
      3,
      '',
      'Bakery Batch 1'
    );
    assert.ok(consumeResult);

    // Verify inventory updated
    const invFinal = (await db.query('SELECT * FROM inventory')).values || [];
    assert.equal(invFinal[0].qty, 6);

    // Verify delta queue has atomic bundle combining inventory update + expense transaction
    const queueFinal = await getPendingDeltaEvents();
    assert.equal(queueFinal.length, seqBefore + 2);

    const consumeInvEvt = queueFinal[seqBefore];
    const consumeTxnEvt = queueFinal[seqBefore + 1];

    assert.equal(consumeInvEvt.collection, 'inventory');
    assert.equal(consumeInvEvt.operation, 'UPDATE');
    assert.equal(consumeInvEvt.payload.qty, 6);

    assert.equal(consumeTxnEvt.collection, 'transactions');
    assert.equal(consumeTxnEvt.operation, 'INSERT');

    // Verify exact atomic bundle matching
    assert.ok(consumeInvEvt.bundle_id);
    assert.equal(consumeInvEvt.bundle_id, consumeTxnEvt.bundle_id);
    assert.equal(consumeInvEvt.bundle_total, 2);
    assert.equal(consumeTxnEvt.bundle_total, 2);
    assert.equal(consumeInvEvt.bundle_index, 0);
    assert.equal(consumeTxnEvt.bundle_index, 1);
  });

  await t.test('M12: Stock Synchronization Atomicity on Transaction Edit and Delete', async () => {
    // 1. Create an inventory item via purchase (100 pcs)
    const purchaseRes = await addInventoryPurchase({
      fromAccount: 'Cash',
      date: '2026-09-27',
      items: [
        { name: 'Packaging Box', pack_qty: 100, sub_qty: 1, sub_unit: 'pcs', original_qty: 100, price: 100, discounted_price: 100 }
      ]
    });
    assert.ok(purchaseRes);
    const boxItem = purchaseRes.items[0];

    const queueInit = await getPendingDeltaEvents();
    const baseSeq = queueInit.length;

    // 2. Create transaction that consumes 20 pcs
    const txnData = {
      id: 'txn-sync-stock-1',
      date: '2026-09-27',
      type: 'EXPENSE',
      amount: 20.00,
      tags: `#stock_ref_${boxItem.id}`,
      description: 'Used 20 pcs of Packaging Box'
    };
    await addTransaction(txnData);

    const db = getDB();
    const invAfterInsert = (await db.query('SELECT * FROM inventory WHERE id = ?', [boxItem.id])).values || [];
    assert.equal(invAfterInsert[0].qty, 80);

    // 3. Edit transaction to consume 50 pcs (30 more)
    await updateTransaction({
      id: 'txn-sync-stock-1',
      date: '2026-09-27',
      type: 'EXPENSE',
      amount: 50.00,
      tags: `#stock_ref_${boxItem.id}`,
      description: 'Used 50 pcs of Packaging Box'
    });

    const invAfterUpdate = (await db.query('SELECT * FROM inventory WHERE id = ?', [boxItem.id])).values || [];
    assert.equal(invAfterUpdate[0].qty, 50);

    // Verify transaction edit + stock reduction were committed in ONE atomic bundle
    const queueAfterUpdate = await getPendingDeltaEvents();
    const editEvents = queueAfterUpdate.slice(baseSeq + 1); // after purchase and initial insert
    const txnUpdateEvt = editEvents.find(e => e.collection === 'transactions' && e.operation === 'UPDATE');
    const invUpdateEvt = editEvents.find(e => e.collection === 'inventory' && e.operation === 'UPDATE');

    assert.ok(txnUpdateEvt);
    assert.ok(invUpdateEvt);
    assert.equal(txnUpdateEvt.bundle_id, invUpdateEvt.bundle_id);
    assert.equal(txnUpdateEvt.bundle_total, 2);

    // 4. Delete transaction: stock should be restored to 100
    await deleteTransaction('txn-sync-stock-1');

    const invAfterDelete = (await db.query('SELECT * FROM inventory WHERE id = ?', [boxItem.id])).values || [];
    assert.equal(invAfterDelete[0].qty, 100);

    // Verify transaction deletion + stock restoration were committed in ONE atomic batch
    const queueAfterDelete = await getPendingDeltaEvents();
    const delEvents = queueAfterDelete.slice(-2);
    const txnDelEvt = delEvents.find(e => e.collection === 'transactions' && e.operation === 'DELETE');
    const invRestoreEvt = delEvents.find(e => e.collection === 'inventory' && e.operation === 'UPDATE');

    assert.ok(txnDelEvt);
    assert.ok(invRestoreEvt);
    assert.equal(txnDelEvt.bundle_id, invRestoreEvt.bundle_id);
    assert.equal(txnDelEvt.bundle_total, 2);
    assert.equal(txnDelEvt.bundle_id, invRestoreEvt.bundle_id);
    assert.equal(txnDelEvt.bundle_total, 2);
  });

  await t.test('M13: Replace-all diff engine emits granular diffs (INSERT, UPDATE, DELETE, UNCHANGED)', async () => {
    const initialAccounts = [
      { id: 'acc-1', name: 'Checking', group: 'Bank' },
      { id: 'acc-2', name: 'Savings', group: 'Bank' }
    ];
    await replaceAccounts(initialAccounts);

    const queueInitial = await getPendingDeltaEvents();
    assert.equal(queueInitial.length, 2);
    assert.equal(queueInitial[0].operation, 'INSERT');
    assert.equal(queueInitial[1].operation, 'INSERT');

    const updatedAccounts = [
      { id: 'acc-1', name: 'Checking', group: 'Bank' },       // UNCHANGED
      { id: 'acc-2', name: 'Savings High Yield', group: 'Bank' }, // MODIFIED name -> UPDATE
      { id: 'acc-3', name: 'Investment', group: 'Brokerage' }     // ADDED -> INSERT
    ];

    await replaceAccounts(updatedAccounts);

    const queueAfter = await getPendingDeltaEvents();
    assert.equal(queueAfter.length, 4);

    const updateEvt = queueAfter[2];
    assert.equal(updateEvt.collection, 'accounts');
    assert.equal(updateEvt.entity_id, 'acc-2');
    assert.equal(updateEvt.operation, 'UPDATE');
    assert.equal(updateEvt.payload.name, 'Savings High Yield');

    const insertEvt = queueAfter[3];
    assert.equal(insertEvt.collection, 'accounts');
    assert.equal(insertEvt.entity_id, 'acc-3');
    assert.equal(insertEvt.operation, 'INSERT');
    assert.equal(insertEvt.payload.name, 'Investment');

    const remainingAccounts = [
      { id: 'acc-2', name: 'Savings High Yield', group: 'Bank' },
      { id: 'acc-3', name: 'Investment', group: 'Brokerage' }
    ];
    await replaceAccounts(remainingAccounts);

    const queueFinal = await getPendingDeltaEvents();
    assert.equal(queueFinal.length, 7);

    const deleteEvt = queueFinal.find(e => e.entity_id === 'acc-1' && e.operation === 'DELETE');
    assert.ok(deleteEvt);
    assert.equal(deleteEvt.collection, 'accounts');

    const tombstones = await getTombstones();
    assert.equal(tombstones.some(t => t.entity_type === 'account' && t.id === 'acc-1'), true);
  });

  await t.test('M14: Synced Settings vs Local-only Settings', async () => {
    await setSetting('default_currency', 'USD');
    let queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].collection, 'settings');
    assert.equal(queue[0].entity_id, 'default_currency');
    assert.equal(queue[0].payload.value, 'USD');

    await setSetting('googleDriveToken', 'secret-oauth-token-12345');
    queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 1);

    const val = await getSetting('googleDriveToken');
    assert.equal(val, 'secret-oauth-token-12345');
  });

  await t.test('M15: Categories & Subcategories granular diffing & delta capture', async () => {
    const initialCategories = [
      {
        id: 'cat-1',
        name: 'Food',
        subcategories: [
          { id: 'sub-1', name: 'Groceries' },
          { id: 'sub-2', name: 'Restaurants' }
        ]
      }
    ];

    await replaceCategories(initialCategories);

    let queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 3);
    assert.equal(queue[0].collection, 'categories');
    assert.equal(queue[1].collection, 'subcategories');
    assert.equal(queue[2].collection, 'subcategories');

    const updatedCategories = [
      {
        id: 'cat-1',
        name: 'Food & Dining',
        subcategories: [
          { id: 'sub-1', name: 'Groceries' }
        ]
      }
    ];

    await replaceCategories(updatedCategories);
    queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 5);

    assert.equal(queue[3].collection, 'categories');
    assert.equal(queue[3].operation, 'UPDATE');
    assert.equal(queue[3].payload.name, 'Food & Dining');

    assert.equal(queue[4].collection, 'subcategories');
    assert.equal(queue[4].operation, 'DELETE');
    assert.equal(queue[4].entity_id, 'sub-2');
  });

  await t.test('M16: Budgets, Recurring Rules, and Investment Plans delta capture', async () => {
    await setBudget('Food', 500);
    let queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].collection, 'budgets');

    await deleteBudget('Food');
    queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 2);
    assert.equal(queue[1].operation, 'DELETE');

    const rule = await saveRecurringRule({
      base_note: 'Monthly Rent',
      total_amount: 1200,
      frequency: 'monthly',
      rule_type: 'repeat'
    });
    queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 3);
    assert.equal(queue[2].collection, 'recurring_rules');
    assert.equal(queue[2].operation, 'INSERT');

    await deleteRecurringRule(rule);
    queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 4);
    assert.equal(queue[3].collection, 'recurring_rules');
    assert.equal(queue[3].operation, 'DELETE');

    const plan = await saveInvestmentPlan({
      name: 'Retirement 2050',
      planned_amount: 1000000
    });
    queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 5);
    assert.equal(queue[4].collection, 'investment_plans');
    assert.equal(queue[4].operation, 'INSERT');

    await deleteInvestmentPlan(plan);
    queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 6);
    assert.equal(queue[5].collection, 'investment_plans');
    assert.equal(queue[5].operation, 'DELETE');
  });

  await t.test('M17: deleteAllTransactions captures DELETE events and tombstones for all transactions', async () => {
    await addTransaction({ id: 'txn-del-1', amount: 10 });
    await addTransaction({ id: 'txn-del-2', amount: 20 });

    let queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 2);

    await deleteAllTransactions();

    queue = await getPendingDeltaEvents();
    assert.equal(queue.length, 4);
    assert.equal(queue[2].operation, 'DELETE');
    assert.equal(queue[3].operation, 'DELETE');

    const tombstones = await getTombstones();
    assert.equal(tombstones.length, 2);
  });
});
