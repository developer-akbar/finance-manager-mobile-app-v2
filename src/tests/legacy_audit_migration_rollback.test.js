import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { initDB, closeDB, getDB } from '../database/db.js';
import { executeLegacyAuditMigration, computeFinancialBaselineChecksum } from '../services/legacyDeviceAuditMigration.js';
import { getSetting } from '../database/settings.js';

test('FinMan Legacy Audit Migration — Batch Failure & Atomic Rollback Test Suite', async (t) => {
  t.beforeEach(async () => {
    closeDB();
    if (typeof localStorage !== 'undefined') localStorage.clear();
    await initDB();
  });

  t.afterEach(() => {
    closeDB();
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  await t.test('1. When batch N fails, committed batches are rolled back, delta events purged, and recovery lock re-armed', async () => {
    const db = getDB();
    db.isNativeSQLite = true;

    // Seed 5 transactions: Batch size will be 2 so there are 3 batches (batch 1: 2, batch 2: 2, batch 3: 1)
    const originalTxns = [
      { id: 'tx_rb_01', date: '2026-11-01', amount: '100', inr: 100, category: 'Food', created_by_device_id: null },
      { id: 'tx_rb_02', date: '2026-11-02', amount: '200', inr: 200, category: 'Food', created_by_device_id: null },
      { id: 'tx_rb_03', date: '2026-11-03', amount: '300', inr: 300, category: 'Food', created_by_device_id: null },
      { id: 'tx_rb_04', date: '2026-11-04', amount: '400', inr: 400, category: 'Food', created_by_device_id: null },
      { id: 'tx_rb_05', date: '2026-11-05', amount: '500', inr: 500, category: 'Food', created_by_device_id: null }
    ];

    for (const tx of originalTxns) {
      await db.run(
        'INSERT INTO transactions (id, date, amount, inr, category, created_by_device_id) VALUES (?, ?, ?, ?, ?, ?)',
        [tx.id, tx.date, tx.amount, tx.inr, tx.category, tx.created_by_device_id]
      );
    }

    const baselineChecksum = await computeFinancialBaselineChecksum(originalTxns.map(r => ({ ...r, _table: 'transactions' })));

    // Track original delta queue count (should be 0)
    const initialDeltaQueue = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(initialDeltaQueue.length, 0);

    // Instrument executeSet / run to fail on batch 2 (when tx_rb_03 is processed)
    let executionAttempts = 0;
    const realExecuteSet = db.executeSet;
    const realRun = db.run;

    // We make batch 2 fail:
    let failBatchTriggered = false;
    db.executeSet = async (statements) => {
      // Check if this batch contains tx_rb_03
      const isBatch2 = statements.some(s => s.values && s.values.includes('tx_rb_03'));
      if (isBatch2 && !failBatchTriggered) {
        failBatchTriggered = true;
        throw new Error('SIMULATED_SQLITE_IO_FAILURE_ON_BATCH_2');
      }
      if (realExecuteSet) {
        return await realExecuteSet.call(db, statements);
      } else {
        for (const s of statements) {
          await db.run(s.statement, s.values);
        }
      }
    };

    // Execute migration with batchSize: 2
    let migrationCaughtError = null;
    try {
      await executeLegacyAuditMigration({
        confirmed: true,
        batchSize: 2,
        db
      });
    } catch (err) {
      migrationCaughtError = err;
    }

    assert.ok(migrationCaughtError, 'Migration must throw an error when batch fails');
    assert.ok(failBatchTriggered, 'Batch 2 must have failed as simulated');
    assert.match(migrationCaughtError.message, /ROLLED_BACK_CLEANLY/, 'Error must confirm clean rollback');

    // VERIFY 1: Transactions table restored to pre-migration baseline
    const postRollbackTxns = (await db.query('SELECT * FROM transactions')).values || [];
    assert.equal(postRollbackTxns.length, 5, 'All 5 transactions must be present after rollback');
    for (const r of postRollbackTxns) {
      assert.equal(r.created_by_device_id ?? null, null, 'Attribution must be rolled back to original null value');
      assert.equal(r.created_by_provenance ?? null, null, 'Provenance must be rolled back to original null value');
    }

    // VERIFY 2: Financial checksum remains 100% identical to pre-migration baseline
    const postRollbackChecksum = await computeFinancialBaselineChecksum(postRollbackTxns.map(r => ({ ...r, _table: 'transactions' })));
    assert.equal(postRollbackChecksum, baselineChecksum, 'Financial checksum must match pristine baseline after rollback');

    // VERIFY 3: sync_delta_queue is purged of all migration events (zero delta events remain from batch 1)
    const postRollbackDeltaQueue = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.equal(postRollbackDeltaQueue.length, 0, 'sync_delta_queue must be restored and have 0 leftover migration delta events');

    // VERIFY 4: Recovery lock is armed in SQLite settings
    const lockSetting = await getSetting('finman_recovery_safety_lock');
    assert.ok(lockSetting, 'Recovery safety lock setting must exist');
    const parsedLock = typeof lockSetting === 'string' ? JSON.parse(lockSetting) : lockSetting;
    assert.equal(parsedLock.locked, true, 'Recovery lock in SQLite must be armed (locked: true)');

    // VERIFY 5: Recovery lock is armed in localStorage
    if (typeof localStorage !== 'undefined') {
      const rawLocal = localStorage.getItem('finman_recovery_safety_lock');
      assert.ok(rawLocal, 'localStorage lock must exist');
      const parsedLocal = JSON.parse(rawLocal);
      assert.equal(parsedLocal.locked, true, 'Recovery lock in localStorage must be armed');
    }
  });
});
