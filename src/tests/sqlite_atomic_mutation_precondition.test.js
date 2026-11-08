import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { initDB, closeDB, getDB, setRawIDB, getRawIDB } from '../database/db.js';
import { executeAtomicBatch } from '../database/atomicMutation.js';
import { DELTA_OPERATION } from '../database/deltaQueue.js';

test('FinMan SQLite Precondition & executeSet Atomicity Test', async (t) => {
  t.beforeEach(async () => {
    closeDB();
    await initDB();
  });

  t.afterEach(() => {
    closeDB();
  });

  await t.test('1. PRECONDITION_FAILED thrown when current SQLite entity does not match expectedBaseEntity', async () => {
    const db = getDB();
    db.isNativeSQLite = true;

    // Insert an initial transaction
    await db.run(
      'INSERT INTO transactions (id, amount, note, created_by_device_id) VALUES (?, ?, ?, ?)',
      ['txn_concurrent_01', '500', 'Original note', 'dev_c7e4544221f4']
    );

    // Instrument db with executeSet mock and disable rawIdb to simulate native SQLite platform
    const originalIDB = getRawIDB();
    let executeSetCalled = false;
    db.executeSet = async (statements) => {
      executeSetCalled = true;
      for (const s of statements) {
        await db.run(s.statement, s.values);
      }
    };
    setRawIDB(null);

    // Concurrently mutate the row in the database so it no longer matches the expected base entity
    await db.run(
      'UPDATE transactions SET amount = ?, note = ? WHERE id = ?',
      ['999', 'Concurrently modified note', 'txn_concurrent_01']
    );

    try {
      await assert.rejects(
        async () => {
          await executeAtomicBatch({
            operations: [{
              storeName: 'transactions',
              id: 'txn_concurrent_01',
              operation: DELTA_OPERATION.UPDATE,
              entity: { id: 'txn_concurrent_01', amount: '600', note: 'Attempted update' },
              expectedBaseEntity: { id: 'txn_concurrent_01', amount: '500', note: 'Original note', created_by_device_id: 'dev_c7e4544221f4' }
            }]
          });
        },
        /PRECONDITION_FAILED: Concurrent modification detected/,
        'Must reject mutation when current SQLite entity does not match expectedBaseEntity'
      );

      assert.equal(executeSetCalled, false, 'executeSet must NEVER be executed if optimistic precondition fails');
    } finally {
      setRawIDB(originalIDB);
    }
  });

  await t.test('2. Mutation succeeds with executeSet when expectedBaseEntity matches current DB entity', async () => {
    const db = getDB();
    db.isNativeSQLite = true;

    // Insert initial entity
    const initialEntity = {
      id: 'txn_match_01',
      date: '2026-11-08',
      amount: '750',
      category: 'Food',
      created_by_device_id: null
    };
    await db.run(
      'INSERT INTO transactions (id, date, amount, category, created_by_device_id) VALUES (?, ?, ?, ?, ?)',
      [initialEntity.id, initialEntity.date, initialEntity.amount, initialEntity.category, initialEntity.created_by_device_id]
    );

    const originalIDB = getRawIDB();
    let executeSetCalled = false;
    db.executeSet = async (statements) => {
      executeSetCalled = true;
      for (const s of statements) {
        await db.run(s.statement, s.values);
      }
    };
    setRawIDB(null);

    try {
      // Query current entity from DB so expectedBaseEntity is an exact match
      const currentRes = await db.query('SELECT * FROM transactions WHERE id = ?', [initialEntity.id]);
      const currentInDb = currentRes.values[0];

      await executeAtomicBatch({
        operations: [{
          storeName: 'transactions',
          id: initialEntity.id,
          operation: DELTA_OPERATION.UPDATE,
          entity: { ...currentInDb, created_by_device_id: 'dev_c7e4544221f4' },
          expectedBaseEntity: currentInDb
        }]
      });

      assert.equal(executeSetCalled, true, 'executeSet must be called for SQLite batch transaction');

      // Verify row updated in DB
      const updatedRes = await db.query('SELECT created_by_device_id FROM transactions WHERE id = ?', [initialEntity.id]);
      assert.equal(updatedRes.values[0].created_by_device_id, 'dev_c7e4544221f4');
    } finally {
      setRawIDB(originalIDB);
    }
  });
});
