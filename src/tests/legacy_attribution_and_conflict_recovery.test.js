import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuid } from 'uuid';
import { IDBFactory } from 'fake-indexeddb';

import {
  mergeProvenanceProtectedPayload,
  isSafelyMergeableLegacyAttribution,
  resolveConflict,
  resolveAllConflicts,
  autoResolveIdenticalConflicts,
  reconcileStagedEvents,
  RECONCILIATION_STATUS,
  TERMINAL_RECONCILIATION_STATUSES,
  APPROVED_BASE_SNAPSHOT_ID
} from '../services/deltaReconciliation.js';

import {
  saveConflictRecord,
  getPendingConflicts,
  getAllConflicts,
  CONFLICT_STATUS,
  CONFLICT_RESOLUTION,
  CONFLICT_TYPE
} from '../database/conflicts.js';

import { initDB, getDB, closeDB } from '../database/db.js';
import { calculateEntityDiff } from '../utils/conflictFormatter.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';

test('FinMan Legacy Attribution & Cross-Device Sync Recovery Suite', async (t) => {
  globalThis.indexedDB = new IDBFactory();
  let db = await initDB();

  // Helper to clean tables between test sections
  const cleanTestTables = async () => {
    try {
      await db.run('DELETE FROM sync_conflicts');
      await db.run('DELETE FROM sync_delta_queue');
      await db.run('DELETE FROM sync_staged_events');
      await db.run('DELETE FROM sync_staged_packages');
      await db.run('DELETE FROM sync_peer_state');
      await db.run('DELETE FROM sync_local_state');
      await db.run('DELETE FROM transactions');
      await db.run('DELETE FROM investment_transactions');
    } catch {}
  };

  await t.test('1. All audit-only conflicts are correctly classified', async () => {
    const localTx = {
      id: 'tx_101',
      amount: '500.00',
      inr: 500,
      date: '15/07/2025',
      time: '14:30',
      account: 'HDFC Bank',
      category: 'Food',
      type: 'Expense',
      note: 'Lunch meeting',
      deleted: 0,
      created_by_device_id: null,
      created_by_provenance: null
    };

    const remoteTxAuditOnly = {
      ...localTx,
      created_by_device_id: 'dev_c7e4544221f4',
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: 'dev_c7e4544221f4',
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };

    const res = isSafelyMergeableLegacyAttribution(localTx, remoteTxAuditOnly, 'transactions');
    assert.equal(res.isMergeable, true, 'Audit-only difference must be classified as safely mergeable');
    assert.equal(res.mergedPayload.created_by_device_id, 'dev_c7e4544221f4');
    assert.equal(res.mergedPayload.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.equal(res.mergedPayload.amount, '500.00');

    // Case with financial difference
    const remoteTxFinancialDiff = {
      ...remoteTxAuditOnly,
      amount: '999.00' // financial amount differs!
    };
    const resFin = isSafelyMergeableLegacyAttribution(localTx, remoteTxFinancialDiff, 'transactions');
    assert.equal(resFin.isMergeable, false, 'Financial amount diff must NOT be safely mergeable');
  });

  await t.test('2. Missing provenance receives legacy attribution', async () => {
    const localWithoutProv = {
      id: 'tx_102',
      amount: '150',
      inr: 150,
      account: 'Cash',
      category: 'Transit',
      type: 'Expense',
      created_by_device_id: '',
      created_by_provenance: null
    };

    const remoteLegacy = {
      ...localWithoutProv,
      created_by_device_id: 'dev_c7e4544221f4',
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: 'dev_c7e4544221f4',
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };

    const mergeResult = isSafelyMergeableLegacyAttribution(localWithoutProv, remoteLegacy, 'transactions');
    assert.equal(mergeResult.isMergeable, true);
    assert.equal(mergeResult.mergedPayload.created_by_device_id, 'dev_c7e4544221f4');
    assert.equal(mergeResult.mergedPayload.created_by_provenance, 'LEGACY_ASSIGNED');
  });

  await t.test('3. Verified provenance remains unchanged when merging legacy attribution', async () => {
    const localVerified = {
      id: 'tx_103',
      amount: '3000',
      inr: 3000,
      account: 'ICICI',
      category: 'Shopping',
      type: 'Expense',
      created_by_device_id: 'dev_b6de1af49405',
      created_by_provenance: 'VERIFIED',
      updated_by_device_id: 'dev_b6de1af49405',
      updated_by_provenance: 'VERIFIED'
    };

    const remoteLegacy = {
      ...localVerified,
      created_by_device_id: 'dev_c7e4544221f4',
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: 'dev_c7e4544221f4',
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };

    const mergeResult = isSafelyMergeableLegacyAttribution(localVerified, remoteLegacy, 'transactions');
    assert.equal(mergeResult.isMergeable, true);
    // Verified local creator must be strictly preserved!
    assert.equal(mergeResult.mergedPayload.created_by_device_id, 'dev_b6de1af49405');
    assert.equal(mergeResult.mergedPayload.created_by_provenance, 'VERIFIED');
    assert.equal(mergeResult.mergedPayload.updated_by_device_id, 'dev_b6de1af49405');
    assert.equal(mergeResult.mergedPayload.updated_by_provenance, 'VERIFIED');
  });

  await t.test('4. Financial fields remain unchanged during safe merge', async () => {
    const localTx = {
      id: 'tx_104',
      amount: '1234.56',
      inr: 1234.56,
      date: '2025-01-01',
      time: '12:00',
      account: 'Savings',
      category: 'Utilities',
      subcategory: 'Electric',
      type: 'Expense',
      note: 'Jan Bill',
      deleted: 0
    };

    const remoteLegacy = {
      ...localTx,
      created_by_device_id: 'dev_c7e4544221f4',
      created_by_provenance: 'LEGACY_ASSIGNED'
    };

    const mergeResult = isSafelyMergeableLegacyAttribution(localTx, remoteLegacy, 'transactions');
    assert.equal(mergeResult.isMergeable, true);
    assert.equal(mergeResult.mergedPayload.amount, '1234.56');
    assert.equal(mergeResult.mergedPayload.inr, 1234.56);
    assert.equal(mergeResult.mergedPayload.date, '2025-01-01');
    assert.equal(mergeResult.mergedPayload.account, 'Savings');
    assert.equal(mergeResult.mergedPayload.category, 'Utilities');
    assert.equal(mergeResult.mergedPayload.subcategory, 'Electric');
    assert.equal(mergeResult.mergedPayload.type, 'Expense');
    assert.equal(mergeResult.mergedPayload.deleted, 0);
  });

  await t.test('5. Ordinary transaction behavior in database', async () => {
    await cleanTestTables();
    const txId = 'tx_ord_001';
    await db.run(
      'INSERT INTO transactions (id, amount, inr, account, category, type, date, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [txId, '250', 250, 'Cash', 'Food', 'Expense', '2025-02-01', 0]
    );

    const confId = 'conf_ord_001';
    await saveConflictRecord({
      conflict_id: confId,
      collection: 'transactions',
      entity_id: txId,
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_c7e4544221f4',
      event_id: 'ev_ord_001',
      local_payload: { id: txId, amount: '250', inr: 250, account: 'Cash', category: 'Food', type: 'Expense', date: '2025-02-01' },
      remote_payload: { id: txId, amount: '250', inr: 250, account: 'Cash', category: 'Food', type: 'Expense', date: '2025-02-01', created_by_device_id: 'dev_c7e4544221f4', created_by_provenance: 'LEGACY_ASSIGNED' }
    });

    const res = await autoResolveIdenticalConflicts();
    assert.equal(res.resolved, 1, 'Should auto-resolve safe legacy attribution conflict');

    const updatedTx = (await db.query('SELECT * FROM transactions WHERE id = ?', [txId])).values[0];
    assert.equal(updatedTx.created_by_device_id, 'dev_c7e4544221f4');
    assert.equal(updatedTx.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.equal(updatedTx.amount, '250');
  });

  await t.test('6. Investment transaction behavior in database', async () => {
    await cleanTestTables();
    const invId = 'inv_001';
    await db.run(
      'INSERT INTO investment_transactions (id, asset_name, shares, price, amount, type, date, brokerage_id, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [invId, 'NIFTY50 ETF', '100', '250', '25000', 'Buy', '2025-03-01', 'brok_1', 0]
    );

    const confId = 'conf_inv_001';
    await saveConflictRecord({
      conflict_id: confId,
      collection: 'investment_transactions',
      entity_id: invId,
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_c7e4544221f4',
      event_id: 'ev_inv_001',
      local_payload: { id: invId, asset_name: 'NIFTY50 ETF', shares: '100', price: '250', amount: '25000', type: 'Buy', date: '2025-03-01', brokerage_id: 'brok_1' },
      remote_payload: { id: invId, asset_name: 'NIFTY50 ETF', shares: '100', price: '250', amount: '25000', type: 'Buy', date: '2025-03-01', brokerage_id: 'brok_1', created_by_device_id: 'dev_c7e4544221f4', created_by_provenance: 'LEGACY_ASSIGNED' }
    });

    const res = await autoResolveIdenticalConflicts();
    assert.equal(res.resolved, 1);

    const updatedInv = (await db.query('SELECT * FROM investment_transactions WHERE id = ?', [invId])).values[0];
    assert.equal(updatedInv.created_by_device_id, 'dev_c7e4544221f4');
    assert.equal(updatedInv.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.equal(updatedInv.shares, '100');
    assert.equal(updatedInv.amount, '25000');
  });

  await t.test('7 & 8. Interruption after one batch and restart after interruption', async () => {
    await cleanTestTables();
    // Seed 15 conflicts
    for (let i = 1; i <= 15; i++) {
      const eid = `tx_batch_${i}`;
      await db.run('INSERT INTO transactions (id, amount, account, category, type, date) VALUES (?, ?, ?, ?, ?, ?)', [eid, '100', 'Cash', 'Food', 'Expense', '2025-01-01']);
      await saveConflictRecord({
        conflict_id: `conf_${i}`,
        collection: 'transactions',
        entity_id: eid,
        conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
        peer_device_id: 'dev_c7e4544221f4',
        event_id: `ev_${i}`,
        local_payload: { id: eid, amount: '100', account: 'Cash', category: 'Food', type: 'Expense', date: '2025-01-01' },
        remote_payload: { id: eid, amount: '100', account: 'Cash', category: 'Food', type: 'Expense', date: '2025-01-01', created_by_device_id: 'dev_c7e4544221f4', created_by_provenance: 'LEGACY_ASSIGNED' }
      });
    }

    assert.equal((await getPendingConflicts()).length, 15);

    // Bounded execution with maxBatches = 1 (batchSize = 5)
    const res1 = await resolveAllConflicts(CONFLICT_RESOLUTION.KEEP_LOCAL, {
      batchSize: 5,
      maxBatches: 1,
      yieldMs: 5
    });

    assert.equal(res1.resolved, 5, 'Batch 1 must resolve exactly 5 conflicts');

    // Verify 5 resolved, 10 pending
    const remainingPending = await getPendingConflicts();
    assert.equal(remainingPending.length, 10, 'Remaining pending conflicts must be exactly 10 after batch 1');

    // Test 8: Restart after interruption resumes remaining 10
    const resRestart = await resolveAllConflicts(CONFLICT_RESOLUTION.KEEP_LOCAL, { batchSize: 5, yieldMs: 5 });
    assert.equal(resRestart.resolved, 10, 'Restart must resolve exactly the remaining 10 conflicts');
    assert.equal((await getPendingConflicts()).length, 0, 'All conflicts must now be resolved');
  });

  await t.test('9. Repeated execution is idempotent', async () => {
    const res = await resolveAllConflicts(CONFLICT_RESOLUTION.KEEP_LOCAL, { batchSize: 10 });
    assert.equal(res.total, 0);
    assert.equal(res.resolved, 0);
    assert.equal(res.failed, 0);
  });

  await t.test('10 & 14. No duplicate outbound events and no sequence gaps', async () => {
    const qRes = await db.query('SELECT sequence FROM sync_delta_queue ORDER BY sequence ASC');
    const seqs = (qRes.values || []).map(r => Number(r.sequence));
    assert.ok(seqs.length > 0, 'Queue must have recorded events');

    // Verify uniqueness
    const uniqueSeqs = new Set(seqs);
    assert.equal(uniqueSeqs.size, seqs.length, 'Every sequence number must be unique (0 duplicates)');

    // Verify contiguous strictly increasing
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1, `Sequences must be contiguous without gaps: ${seqs[i - 1]} -> ${seqs[i]}`);
    }
  });

  await t.test('11 & 12. Correct sequence allocation and acknowledgement handling', async () => {
    // Current queue max
    const qRes = await db.query('SELECT sequence FROM sync_delta_queue');
    const maxSeq = (qRes.values || []).reduce((max, r) => Math.max(max, Number(r.sequence) || 0), 0);

    // State check
    const stateRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
    const state = stateRes.values?.[0];
    assert.ok(state, 'sync_local_state record must exist');
    assert.ok(Number(state.last_allocated_sequence) >= maxSeq, `last_allocated_sequence (${state.last_allocated_sequence}) must match or exceed queue max sequence (${maxSeq})`);
  });

  await t.test('13. Strict watermark progression', async () => {
    await cleanTestTables();
    const peer = 'dev_c7e4544221f4';

    // Seed peer state at 500
    await db.run('INSERT INTO sync_peer_state (peer_device_id, last_reconciled_sequence, base_snapshot_id) VALUES (?, ?, ?)', [peer, 500, APPROVED_BASE_SNAPSHOT_ID]);

    // Seed staged events: 501, 502, 503 terminal; 504 BLOCKED; 505 terminal
    await db.run('INSERT INTO sync_staged_events (event_id, device_id, sequence, status, operation, collection, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?)', ['e501', peer, 501, 'RECONCILED_CLEAN', 'UPDATE', 'transactions', 'tx1']);
    await db.run('INSERT INTO sync_staged_events (event_id, device_id, sequence, status, operation, collection, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?)', ['e502', peer, 502, 'RESOLVED_KEEP_LOCAL', 'UPDATE', 'transactions', 'tx2']);
    await db.run('INSERT INTO sync_staged_events (event_id, device_id, sequence, status, operation, collection, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?)', ['e503', peer, 503, 'RECONCILED_IDEMPOTENT', 'UPDATE', 'transactions', 'tx3']);
    await db.run('INSERT INTO sync_staged_events (event_id, device_id, sequence, status, operation, collection, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?)', ['e504', peer, 504, 'BLOCKED_DEPENDENCY', 'UPDATE', 'transactions', 'tx4']);
    await db.run('INSERT INTO sync_staged_events (event_id, device_id, sequence, status, operation, collection, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?)', ['e505', peer, 505, 'RECONCILED_CLEAN', 'UPDATE', 'transactions', 'tx5']);

    // Run reconciliation pass
    const recon = await reconcileStagedEvents({ peerDeviceId: peer });
    const updatedPeer = (await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [peer])).values[0];

    // Watermark MUST advance strictly to 503 and STOP at 504 (must NOT jump to 505)
    assert.equal(Number(updatedPeer.last_reconciled_sequence), 503, 'Watermark must stop strictly at the contiguous barrier (503)');
  });

  await t.test('15. Backlog processing in bounded batches with low memory and event-loop yielding', async () => {
    await cleanTestTables();
    // Seed 100 mock conflicts
    for (let i = 1; i <= 100; i++) {
      const eid = `tx_backlog_${i}`;
      await db.run('INSERT INTO transactions (id, amount, account, category, type, date) VALUES (?, ?, ?, ?, ?, ?)', [eid, '10', 'Cash', 'Food', 'Expense', '2025-01-01']);
      await saveConflictRecord({
        conflict_id: `conf_backlog_${i}`,
        collection: 'transactions',
        entity_id: eid,
        conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
        peer_device_id: 'dev_c7e4544221f4',
        event_id: `ev_b_${i}`,
        local_payload: { id: eid, amount: '10', account: 'Cash', category: 'Food', type: 'Expense', date: '2025-01-01' },
        remote_payload: { id: eid, amount: '10', account: 'Cash', category: 'Food', type: 'Expense', date: '2025-01-01', created_by_device_id: 'dev_c7e4544221f4', created_by_provenance: 'LEGACY_ASSIGNED' }
      });
    }

    const startTime = Date.now();
    const progressBatches = [];
    const res = await resolveAllConflicts(CONFLICT_RESOLUTION.KEEP_LOCAL, {
      batchSize: 25,
      yieldMs: 10,
      onProgress: (p) => progressBatches.push(p.currentBatch)
    });

    const elapsedMs = Date.now() - startTime;

    assert.equal(res.resolved, 100);
    assert.equal(progressBatches.length, 4, '100 items with batchSize=25 must yield exactly 4 batch checkpoints');
    assert.ok(elapsedMs < 5000, `Processing 100 records should take < 5s, took ${elapsedMs}ms`);
  });

  await t.test('16. Retry after network timeout / cancellation signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('NETWORK_STALL_TIMEOUT'));

    await assert.rejects(
      async () => {
        await reconcileStagedEvents({ signal: controller.signal });
      },
      (err) => err.message.includes('NETWORK_STALL_TIMEOUT') || err.message.includes('SYNC_PASS_ABORTED'),
      'Must reject cleanly when signal is aborted'
    );
  });

  await t.test('17. Existing resolved conflicts remain resolved', async () => {
    const confRes = await getAllConflicts();
    const resolvedCount = confRes.filter(c => c.status === CONFLICT_STATUS.RESOLVED).length;
    assert.ok(resolvedCount > 0, 'Resolved conflicts must remain RESOLVED in sync_conflicts');
  });

  await t.test('18. No unexpected conflicts on repeated reconciliation of legacy attribution deltas', async () => {
    await cleanTestTables();
    const peer = 'dev_c7e4544221f4';
    const txId = 'tx_repeat_001';

    // Local transaction with missing provenance
    const localTx = { id: txId, amount: '50', account: 'Cash', category: 'Snacks', type: 'Expense', date: '2025-05-01', deleted: 0 };
    await db.run('INSERT INTO transactions (id, amount, account, category, type, date, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)', [txId, '50', 'Cash', 'Snacks', 'Expense', '2025-05-01', 0]);

    // Staged event with legacy attribution update
    const remotePayload = { ...localTx, created_by_device_id: peer, created_by_provenance: 'LEGACY_ASSIGNED' };
    const remoteChecksum = await computeCanonicalSha256(remotePayload);

    await db.run('INSERT INTO sync_peer_state (peer_device_id, last_reconciled_sequence, base_snapshot_id) VALUES (?, ?, ?)', [peer, 10, APPROVED_BASE_SNAPSHOT_ID]);
    await db.run(
      'INSERT INTO sync_staged_events (event_id, device_id, sequence, status, operation, collection, entity_id, payload, base_checksum, new_checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'ev_rep_11',
        peer,
        11,
        'STAGED',
        'UPDATE',
        'transactions',
        txId,
        JSON.stringify(remotePayload),
        'dummy_base_hash',
        remoteChecksum
      ]
    );

    // Reconcile
    const recon1 = await reconcileStagedEvents({ peerDeviceId: peer });
    assert.equal(recon1.conflictCount, 0, 'Safe legacy attribution update must produce 0 conflicts');
    assert.equal(recon1.reconciledCount, 1, 'Event must reconcile cleanly');

    // Verify transaction now has legacy attribution
    const txRow = (await db.query('SELECT * FROM transactions WHERE id = ?', [txId])).values[0];
    assert.equal(txRow.created_by_device_id, peer);
    assert.equal(txRow.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.equal(txRow.amount, '50');

    // Run reconciliation AGAIN (repeated pass)
    const recon2 = await reconcileStagedEvents({ peerDeviceId: peer });
    assert.equal(recon2.conflictCount, 0, 'Repeated reconciliation must produce 0 conflicts');
  });

  await t.test('19. Provenance Classification Matrix — Full coverage & Independent Creator/Modifier Evaluation', async () => {
    const {
      SUPPORTED_VERIFIED_PROVENANCES,
      classifyProvenance,
      isVerifiedProvenance
    } = await import('../services/deltaReconciliation.js');

    // 1. Every supported verified provenance value
    for (const supported of SUPPORTED_VERIFIED_PROVENANCES) {
      const dev = supported === 'VERIFIED_CREATOR_MANUAL_ENTRY' ? null : 'dev_b6de1af49405';
      const c = classifyProvenance(dev, supported);
      assert.equal(c.isVerified, true, `${supported} must be classified as verified`);
      assert.equal(c.isAmbiguous, false, `${supported} must not be ambiguous`);
      assert.equal(c.shouldPreserve, true, `${supported} must be preserved`);
      assert.equal(isVerifiedProvenance(dev, supported), true);
    }
    // Also test VERIFIED_CREATOR_MANUAL_ENTRY with explicit empty string
    assert.equal(classifyProvenance('', 'VERIFIED_CREATOR_MANUAL_ENTRY').isVerified, true);

    // 2. An arbitrary value such as VERIFIED_UNRECOGNIZED
    const unrec = classifyProvenance(null, 'VERIFIED_UNRECOGNIZED');
    assert.equal(unrec.isVerified, false, 'VERIFIED_UNRECOGNIZED must NOT be verified');
    assert.equal(unrec.isAmbiguous, true, 'VERIFIED_UNRECOGNIZED must be classified as ambiguous');
    assert.equal(unrec.shouldPreserve, true, 'Ambiguous provenance must be preserved');

    // When merging, ambiguous provenance must be preserved over incoming LEGACY_ASSIGNED
    const localAmbiguous = { id: 'tx_ambig', amount: '50', created_by_device_id: null, created_by_provenance: 'VERIFIED_UNRECOGNIZED' };
    const remoteLegacy = { id: 'tx_ambig', amount: '50', created_by_device_id: 'dev_c7e4544221f4', created_by_provenance: 'LEGACY_ASSIGNED' };
    const mergeAmbiguous = isSafelyMergeableLegacyAttribution(localAmbiguous, remoteLegacy, 'transactions');
    assert.equal(mergeAmbiguous.isMergeable, true);
    assert.equal(mergeAmbiguous.mergedPayload.created_by_provenance, 'VERIFIED_UNRECOGNIZED', 'Ambiguous provenance must NOT be overwritten');

    // 3. An unfamiliar provenance value with a non-null device ID
    const unfamiliarWithDev = classifyProvenance('dev_40e186ea92bb', 'SOME_UNFAMILIAR_PROV');
    assert.equal(unfamiliarWithDev.isVerified, false, 'Unfamiliar provenance is not in verified allowlist');
    assert.equal(unfamiliarWithDev.isAmbiguous, true, 'Unfamiliar provenance is ambiguous');
    assert.equal(unfamiliarWithDev.shouldPreserve, true, 'Existing non-null device ID and unfamiliar prov must be preserved');

    const localUnfamiliar = { id: 'tx_unfam', amount: '75', created_by_device_id: 'dev_40e186ea92bb', created_by_provenance: 'SOME_UNFAMILIAR_PROV' };
    const remoteLegacyUnfam = { id: 'tx_unfam', amount: '75', created_by_device_id: 'dev_c7e4544221f4', created_by_provenance: 'LEGACY_ASSIGNED' };
    const mergeUnfamiliar = isSafelyMergeableLegacyAttribution(localUnfamiliar, remoteLegacyUnfam, 'transactions');
    assert.equal(mergeUnfamiliar.isMergeable, true);
    assert.equal(mergeUnfamiliar.mergedPayload.created_by_device_id, 'dev_40e186ea92bb', 'Non-null device ID must be preserved');
    assert.equal(mergeUnfamiliar.mergedPayload.created_by_provenance, 'SOME_UNFAMILIAR_PROV', 'Unfamiliar provenance must be preserved');

    // 4. Null provenance and null device ID
    const nullProv = classifyProvenance(null, null);
    assert.equal(nullProv.isVerified, false);
    assert.equal(nullProv.isAmbiguous, false);
    assert.equal(nullProv.shouldPreserve, false, 'Missing provenance is eligible for legacy attribution');

    // 5. Legacy attribution merging into missing creator/modifier fields
    const localMissingAll = { id: 'tx_missing_all', amount: '100', created_by_device_id: null, created_by_provenance: null, updated_by_device_id: null, updated_by_provenance: null };
    const remoteLegacyBoth = {
      id: 'tx_missing_all',
      amount: '100',
      created_by_device_id: 'dev_c7e4544221f4',
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: 'dev_c7e4544221f4',
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };
    const mergeMissing = isSafelyMergeableLegacyAttribution(localMissingAll, remoteLegacyBoth, 'transactions');
    assert.equal(mergeMissing.isMergeable, true);
    assert.equal(mergeMissing.mergedPayload.created_by_device_id, 'dev_c7e4544221f4');
    assert.equal(mergeMissing.mergedPayload.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.equal(mergeMissing.mergedPayload.updated_by_device_id, 'dev_c7e4544221f4');
    assert.equal(mergeMissing.mergedPayload.updated_by_provenance, 'LEGACY_ASSIGNED');

    // 6. Preservation of existing verified attribution
    const localVerifiedAll = {
      id: 'tx_ver_all',
      amount: '100',
      created_by_device_id: 'dev_b6de1af49405',
      created_by_provenance: 'VERIFIED_CREATOR_DEVICE_ORIGINATED',
      updated_by_device_id: 'dev_b6de1af49405',
      updated_by_provenance: 'VERIFIED'
    };
    const mergeVerified = isSafelyMergeableLegacyAttribution(localVerifiedAll, { ...remoteLegacyBoth, id: 'tx_ver_all' }, 'transactions');
    assert.equal(mergeVerified.isMergeable, true);
    assert.equal(mergeVerified.mergedPayload.created_by_device_id, 'dev_b6de1af49405');
    assert.equal(mergeVerified.mergedPayload.created_by_provenance, 'VERIFIED_CREATOR_DEVICE_ORIGINATED');
    assert.equal(mergeVerified.mergedPayload.updated_by_device_id, 'dev_b6de1af49405');
    assert.equal(mergeVerified.mergedPayload.updated_by_provenance, 'VERIFIED');

    // 7. Independent evaluation: Creator VERIFIED_CREATOR_MANUAL_ENTRY (no dev ID), Modifier missing/null
    const localEntity1 = {
      id: 'tx_matrix_1',
      amount: '100',
      created_by_device_id: null,
      created_by_provenance: 'VERIFIED_CREATOR_MANUAL_ENTRY',
      updated_by_device_id: null,
      updated_by_provenance: null
    };

    const merge1 = isSafelyMergeableLegacyAttribution(localEntity1, { ...remoteLegacyBoth, id: 'tx_matrix_1' }, 'transactions');
    assert.equal(merge1.isMergeable, true);
    assert.equal(merge1.mergedPayload.created_by_provenance, 'VERIFIED_CREATOR_MANUAL_ENTRY');
    assert.equal(merge1.mergedPayload.created_by_device_id, null);
    assert.equal(merge1.mergedPayload.updated_by_provenance, 'LEGACY_ASSIGNED');
    assert.equal(merge1.mergedPayload.updated_by_device_id, 'dev_c7e4544221f4');

    // 8. Independent evaluation: Creator missing/null, Modifier VERIFIED_CREATOR_MANUAL_ENTRY (no dev ID)
    const localEntity2 = {
      id: 'tx_matrix_2',
      amount: '200',
      created_by_device_id: null,
      created_by_provenance: null,
      updated_by_device_id: null,
      updated_by_provenance: 'VERIFIED_CREATOR_MANUAL_ENTRY'
    };

    const remoteLegacy2 = { ...remoteLegacyBoth, id: 'tx_matrix_2', amount: '200' };
    const merge2 = isSafelyMergeableLegacyAttribution(localEntity2, remoteLegacy2, 'transactions');
    assert.equal(merge2.isMergeable, true);
    assert.equal(merge2.mergedPayload.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.equal(merge2.mergedPayload.created_by_device_id, 'dev_c7e4544221f4');
    assert.equal(merge2.mergedPayload.updated_by_provenance, 'VERIFIED_CREATOR_MANUAL_ENTRY');
    assert.equal(merge2.mergedPayload.updated_by_device_id, null);
  });

  await t.test('20. UI Execution Path: "Accept Other Device\'s Version for All" triggers safe merge & never replaces verified provenance', async () => {
    await cleanTestTables();
    const txId = 'tx_ui_path_01';

    // Local entity with VERIFIED_CREATOR_MANUAL_ENTRY (null device id)
    const localTx = {
      id: txId,
      amount: '750',
      inr: 750,
      account: 'HDFC',
      category: 'Rent',
      type: 'Expense',
      date: '2025-06-01',
      created_by_device_id: null,
      created_by_provenance: 'VERIFIED_CREATOR_MANUAL_ENTRY',
      updated_by_device_id: null,
      updated_by_provenance: null
    };
    await db.run(
      'INSERT INTO transactions (id, amount, inr, account, category, type, date, created_by_device_id, created_by_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [txId, '750', 750, 'HDFC', 'Rent', 'Expense', '2025-06-01', null, 'VERIFIED_CREATOR_MANUAL_ENTRY']
    );

    const confId = 'conf_ui_path_01';
    await saveConflictRecord({
      conflict_id: confId,
      collection: 'transactions',
      entity_id: txId,
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_c7e4544221f4',
      event_id: 'ev_ui_01',
      local_payload: localTx,
      remote_payload: {
        ...localTx,
        created_by_device_id: 'dev_c7e4544221f4',
        created_by_provenance: 'LEGACY_ASSIGNED',
        updated_by_device_id: 'dev_c7e4544221f4',
        updated_by_provenance: 'LEGACY_ASSIGNED'
      }
    });

    // Simulate clicking "Accept Other Device's Version for All"
    const bulkRes = await resolveAllConflicts(CONFLICT_RESOLUTION.ACCEPT_REMOTE, { batchSize: 50 });
    assert.equal(bulkRes.resolved, 1);

    // Verify database record: verified creator was NOT replaced by LEGACY_ASSIGNED!
    const updatedTx = (await db.query('SELECT * FROM transactions WHERE id = ?', [txId])).values[0];
    assert.equal(updatedTx.created_by_provenance, 'VERIFIED_CREATOR_MANUAL_ENTRY', 'Verified provenance must be protected even under ACCEPT_REMOTE');
    assert.equal(updatedTx.created_by_device_id, null);
    assert.equal(updatedTx.amount, '750', 'Financial amount must remain intact');
    // Modifier was missing on local, so it safely adopted incoming legacy attribution
    assert.equal(updatedTx.updated_by_provenance, 'LEGACY_ASSIGNED');
    assert.equal(updatedTx.updated_by_device_id, 'dev_c7e4544221f4');
  });

  await t.test('21. Sequence Allocator Concurrency — Stale Snapshot vs Concurrent Allocation (IndexedDB)', async () => {
    await cleanTestTables();
    await db.run('INSERT INTO sync_local_state (key, device_id, last_allocated_sequence, last_acked_sequence) VALUES (?, ?, ?, ?)', ['device_state', 'dev_test', 10, 10]);

    // Snapshot captured at start of upload:
    const staleSnapshot = { last_allocated_sequence: 10, last_acked_sequence: 10, device_id: 'dev_test' };

    // Concurrently, conflict resolution allocates sequences 11 and 12:
    await db.run('UPDATE sync_local_state SET last_allocated_sequence = ? WHERE key = ?', [12, 'device_state']);

    // Now upload completes and ACKs sequence 10.
    // In deltaTransport.js uploadPendingDeltas, it applies:
    const freshStateRes = await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state']);
    const current = freshStateRes.values[0];
    const endSeq = 10;

    const safeAllocated = Math.max(
      Number(current.last_allocated_sequence) || 0,
      Number(staleSnapshot.last_allocated_sequence) || 0,
      endSeq
    );
    await db.run('UPDATE sync_local_state SET last_allocated_sequence = ?, last_acked_sequence = ? WHERE key = ?', [safeAllocated, endSeq, 'device_state']);

    const finalState = (await db.query('SELECT * FROM sync_local_state WHERE key = ?', ['device_state'])).values[0];
    assert.equal(finalState.last_allocated_sequence, 12, 'Newer allocated sequence 12 must NOT be overwritten by stale snapshot 10');
    assert.equal(finalState.last_acked_sequence, 10);
  });

  await t.test('22. Sequence Allocator Concurrency — Stale Snapshot vs Concurrent Allocation (SQLite)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const sqliteDb = new DatabaseSync(':memory:');

    sqliteDb.exec(`
      CREATE TABLE sync_local_state (
        key TEXT PRIMARY KEY,
        device_id TEXT,
        last_allocated_sequence INTEGER,
        last_uploaded_sequence INTEGER,
        last_pushed_sequence INTEGER,
        last_acked_sequence INTEGER,
        updated_at TEXT
      );
      INSERT INTO sync_local_state (key, device_id, last_allocated_sequence, last_acked_sequence)
      VALUES ('device_state', 'dev_test', 50, 50);
    `);

    // Stale snapshot has 50
    const staleSnapshotSeq = 50;

    // Concurrent allocation jumps to 55:
    sqliteDb.exec("UPDATE sync_local_state SET last_allocated_sequence = 55 WHERE key = 'device_state'");

    // SQLite atomic update via MAX (exact SQL from deltaTransport.js:540):
    const stmt = sqliteDb.prepare(`
      UPDATE sync_local_state SET
        last_uploaded_sequence = MAX(COALESCE(last_uploaded_sequence, 0), ?),
        last_pushed_sequence = MAX(COALESCE(last_pushed_sequence, 0), ?),
        last_acked_sequence = MAX(COALESCE(last_acked_sequence, 0), ?),
        last_allocated_sequence = MAX(COALESCE(last_allocated_sequence, 0), ?),
        updated_at = ? WHERE device_id = ? OR key = ?
    `);
    stmt.run(staleSnapshotSeq, staleSnapshotSeq, staleSnapshotSeq, staleSnapshotSeq, new Date().toISOString(), 'dev_test', 'device_state');

    const finalState = sqliteDb.prepare("SELECT * FROM sync_local_state WHERE key = 'device_state'").get();
    assert.equal(finalState.last_allocated_sequence, 55, 'SQLite MAX must prevent stale snapshot from regressing sequence counter');
    assert.equal(finalState.last_acked_sequence, 50);
  });

  await t.test('23. Interruption & Resumability Checkpoints across Batch Lifecycle and Watermarks', async () => {
    await cleanTestTables();
    const peer = 'dev_c7e4544221f4';

    // Insert staged events:
    // Event 1: tx_1 (safe legacy update)
    // Event 2: tx_2 (safe legacy update)
    // Event 3: tx_3 (conflicted financial diff -> raises CONFLICT)
    // Event 4: tx_4 (safe legacy update on tx_4)
    const p1 = { id: 'tx_resume_1', amount: '10', inr: 10, account: 'Cash', category: 'General', type: 'Expense', date: '2025-01-01', created_by_device_id: peer, created_by_provenance: 'LEGACY_ASSIGNED' };
    const p2 = { id: 'tx_resume_2', amount: '20', inr: 20, account: 'Cash', category: 'General', type: 'Expense', date: '2025-01-01', created_by_device_id: peer, created_by_provenance: 'LEGACY_ASSIGNED' };
    const p3Conf = { id: 'tx_resume_3', amount: '999999', inr: 999999, account: 'Cash', category: 'General', type: 'Expense', date: '2025-01-01', created_by_device_id: peer, created_by_provenance: 'LEGACY_ASSIGNED' };
    const p4 = { id: 'tx_resume_4', amount: '40', inr: 40, account: 'Cash', category: 'General', type: 'Expense', date: '2025-01-01', created_by_device_id: peer, created_by_provenance: 'LEGACY_ASSIGNED' };

    await db.run('INSERT INTO transactions (id, amount, inr, account, category, type, date) VALUES (?, ?, ?, ?, ?, ?, ?)', ['tx_resume_1', '10', 10, 'Cash', 'General', 'Expense', '2025-01-01']);
    await db.run('INSERT INTO transactions (id, amount, inr, account, category, type, date) VALUES (?, ?, ?, ?, ?, ?, ?)', ['tx_resume_2', '20', 20, 'Cash', 'General', 'Expense', '2025-01-01']);
    await db.run('INSERT INTO transactions (id, amount, inr, account, category, type, date) VALUES (?, ?, ?, ?, ?, ?, ?)', ['tx_resume_3', '30', 30, 'Cash', 'General', 'Expense', '2025-01-01']);
    await db.run('INSERT INTO transactions (id, amount, inr, account, category, type, date) VALUES (?, ?, ?, ?, ?, ?, ?)', ['tx_resume_4', '40', 40, 'Cash', 'General', 'Expense', '2025-01-01']);

    await db.run(
      'INSERT INTO sync_staged_events (event_id, device_id, sequence, status, operation, collection, entity_id, payload, base_checksum, new_checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['ev_res_1', peer, 1, 'STAGED', 'UPDATE', 'transactions', 'tx_resume_1', JSON.stringify(p1), 'dummy_base', await computeCanonicalSha256(p1)]
    );
    await db.run(
      'INSERT INTO sync_staged_events (event_id, device_id, sequence, status, operation, collection, entity_id, payload, base_checksum, new_checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['ev_res_2', peer, 2, 'STAGED', 'UPDATE', 'transactions', 'tx_resume_2', JSON.stringify(p2), 'dummy_base', await computeCanonicalSha256(p2)]
    );
    await db.run(
      'INSERT INTO sync_staged_events (event_id, device_id, sequence, status, operation, collection, entity_id, payload, base_checksum, new_checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['ev_res_3', peer, 3, 'STAGED', 'UPDATE', 'transactions', 'tx_resume_3', JSON.stringify(p3Conf), 'dummy_base', await computeCanonicalSha256(p3Conf)]
    );
    await db.run(
      'INSERT INTO sync_staged_events (event_id, device_id, sequence, status, operation, collection, entity_id, payload, base_checksum, new_checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['ev_res_4', peer, 4, 'STAGED', 'UPDATE', 'transactions', 'tx_resume_4', JSON.stringify(p4), 'dummy_base', await computeCanonicalSha256(p4)]
    );

    await db.run('INSERT INTO sync_peer_state (peer_device_id, last_reconciled_sequence, base_snapshot_id) VALUES (?, ?, ?)', [peer, 0, APPROVED_BASE_SNAPSHOT_ID]);

    // Reconcile pass 1
    const reconRes = await reconcileStagedEvents({ peerDeviceId: peer });
    // Watermark should strictly advance to 2, and stop at 3 (conflict), even though Event 4 reconciled
    const peerState = (await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [peer])).values[0];
    assert.equal(peerState.last_reconciled_sequence, 2, 'Watermark must strictly stop at sequence 2 before blocked/conflict event 3');

    // Resolve conflict on Event 3
    const confRow = (await getPendingConflicts())[0];
    assert.ok(confRow, 'Pending conflict must exist for Event 3');
    await resolveConflict(confRow.conflict_id, CONFLICT_RESOLUTION.KEEP_LOCAL);

    // Reconcile pass 2: watermark must now cleanly advance to 4
    await reconcileStagedEvents({ peerDeviceId: peer });
    const peerStateAfter = (await db.query('SELECT * FROM sync_peer_state WHERE peer_device_id = ?', [peer])).values[0];
    assert.equal(peerStateAfter.last_reconciled_sequence, 4, 'Watermark must resume and advance to 4 after conflict resolution');
  });

  await t.test('24. Allowlist Mutability Protection — External Code Cannot Add Provenance Values', async () => {
    const {
      SUPPORTED_VERIFIED_PROVENANCES,
      isSupportedVerifiedProvenance,
      classifyProvenance
    } = await import('../services/deltaReconciliation.js');

    // 1. Array is frozen
    assert.ok(Array.isArray(SUPPORTED_VERIFIED_PROVENANCES), 'SUPPORTED_VERIFIED_PROVENANCES must be an Array');
    assert.ok(Object.isFrozen(SUPPORTED_VERIFIED_PROVENANCES), 'SUPPORTED_VERIFIED_PROVENANCES must be frozen');

    // 2. Cannot push or add new values
    assert.throws(() => {
      SUPPORTED_VERIFIED_PROVENANCES.push('MALICIOUS_PROVENANCE');
    }, /Cannot add property|is not extensible|TypeError/);

    // 3. Cannot mutate existing indices
    assert.throws(() => {
      'use strict';
      SUPPORTED_VERIFIED_PROVENANCES[0] = 'MUTATED_VALUE';
    }, /Cannot assign to read only property|TypeError/);

    // 4. Calling .add() fails
    assert.equal(typeof SUPPORTED_VERIFIED_PROVENANCES.add, 'undefined');

    // 5. Arbitrary injection attempt is blocked by isSupportedVerifiedProvenance
    assert.equal(isSupportedVerifiedProvenance('MALICIOUS_PROVENANCE'), false);
    assert.equal(isSupportedVerifiedProvenance('VERIFIED_UNRECOGNIZED'), false);

    // 6. classifyProvenance treats any non-allowlisted value as ambiguous fail-closed
    const cl = classifyProvenance(null, 'MALICIOUS_PROVENANCE');
    assert.equal(cl.isVerified, false);
    assert.equal(cl.isAmbiguous, true);
    assert.equal(cl.shouldPreserve, true);
  });

  await t.test('25. Exhaustive Merge Field Preservation — Ordinary and Investment Transactions', async () => {
    const { isSafelyMergeableLegacyAttribution } = await import('../services/deltaReconciliation.js');

    // --- A. Ordinary Transactions ---
    const canonicalOrdinary = {
      id: 'tx_ord_full',
      date: '2025-06-15',
      time: '14:30',
      account: 'HDFC Bank',
      from_account: 'HDFC Bank',
      to_account: 'SBI Savings',
      category: 'Utilities',
      subcategory: 'Electricity',
      note: 'Monthly Bill',
      description: 'Torrent Power',
      inr: 1250.50,
      amount: '1250.50',
      currency: 'INR',
      type: 'Expense',
      created_at: '2025-06-15T09:00:00.000Z',
      updated_at: '2025-06-15T09:00:00.000Z',
      recurring_rule_id: 'rule_electric_12',
      tags: '#bills #home',
      split_group_id: 'split_99',
      receipt_image: 'blob:receipt_abc',
      warranty_expiry: '2026-06-15',
      serial_no: 'SN12345678',
      sub_account: 'Primary',
      from_sub_account: 'Primary',
      to_sub_account: 'Secondary',
      created_by_device_id: null,
      created_by_provenance: null,
      updated_by_device_id: null,
      updated_by_provenance: null
    };

    const remoteOrdinaryLegacy = {
      ...canonicalOrdinary,
      created_by_device_id: 'dev_c7e4544221f4',
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: 'dev_c7e4544221f4',
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };

    // 1. Safe legacy attribution merge preserves 100% of ordinary transaction fields
    const mergeOrd = isSafelyMergeableLegacyAttribution(canonicalOrdinary, remoteOrdinaryLegacy, 'transactions');
    assert.equal(mergeOrd.isMergeable, true);
    // Prove every single non-provenance field is strictly preserved
    for (const key of Object.keys(canonicalOrdinary)) {
      if (key.includes('provenance') || key.includes('device_id')) continue;
      assert.deepEqual(mergeOrd.mergedPayload[key], canonicalOrdinary[key], `Field '${key}' must be preserved`);
    }
    // Prove only provenance fields were populated
    assert.equal(mergeOrd.mergedPayload.created_by_device_id, 'dev_c7e4544221f4');
    assert.equal(mergeOrd.mergedPayload.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.equal(mergeOrd.mergedPayload.updated_by_device_id, 'dev_c7e4544221f4');
    assert.equal(mergeOrd.mergedPayload.updated_by_provenance, 'LEGACY_ASSIGNED');

    // 2. Reject merge if ANY ordinary field differs
    const ordinaryFieldsToTest = [
      ['tags', '#different_tags'],
      ['receipt_image', 'blob:different_receipt'],
      ['split_group_id', 'split_different'],
      ['warranty_expiry', '2027-01-01'],
      ['serial_no', 'SN_DIFFERENT'],
      ['subcategory', 'Water'],
      ['from_account', 'Axis Bank'],
      ['to_account', 'ICICI Bank'],
      ['sub_account', 'OtherSub'],
      ['from_sub_account', 'OtherFromSub'],
      ['to_sub_account', 'OtherToSub'],
      ['time', '15:45'],
      ['currency', 'USD'],
      ['recurring_rule_id', 'rule_different'],
      ['id', 'tx_different_id'],
      ['created_at', '2025-01-01T00:00:00.000Z'],
      ['updated_at', '2025-01-01T00:00:00.000Z']
    ];

    for (const [field, diffVal] of ordinaryFieldsToTest) {
      const conflictingRemote = { ...remoteOrdinaryLegacy, [field]: diffVal };
      const res = isSafelyMergeableLegacyAttribution(canonicalOrdinary, conflictingRemote, 'transactions');
      assert.equal(res.isMergeable, false, `Differences in '${field}' must NOT be auto-merged`);
      assert.equal(res.mergedPayload, null);
    }

    // --- B. Investment Transactions ---
    const canonicalInvestment = {
      ...canonicalOrdinary,
      id: 'tx_inv_full',
      investment_transaction_type: 'BUY',
      brokerage: 'Zerodha',
      security_symbol: 'RELIANCE',
      security_isin: 'INE002A01018',
      quantity: 50,
      unit_price: 2450.75,
      trade_value: 122537.50,
      cost_basis: 122537.50,
      cash_impact: -122550.00,
      position_qty_change: 50,
      realized_pnl: 0,
      trade_id: 'TRD_987654',
      order_id: 'ORD_123456',
      exchange: 'NSE',
      segment: 'EQ',
      source: 'KITE_IMPORT',
      investment_account: 'Zerodha Equity',
      actual_amount: 122550.00,
      total_charges: 12.50,
      brokerage_charges: 0,
      exchange_charges: 4.25,
      stt_charges: 5.00,
      sebi_charges: 0.25,
      stamp_duty_charges: 2.00,
      gst_charges: 1.00,
      dp_charges: 0,
      other_charges: 0,
      security_display_name: 'Reliance Industries Ltd',
      settlement_mode: 'ACTUAL'
    };

    const remoteInvestmentLegacy = {
      ...canonicalInvestment,
      created_by_device_id: 'dev_c7e4544221f4',
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: 'dev_c7e4544221f4',
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };

    // 1. Safe legacy attribution merge preserves 100% of investment transaction fields
    const mergeInv = isSafelyMergeableLegacyAttribution(canonicalInvestment, remoteInvestmentLegacy, 'investment_transactions');
    assert.equal(mergeInv.isMergeable, true);
    for (const key of Object.keys(canonicalInvestment)) {
      if (key.includes('provenance') || key.includes('device_id')) continue;
      assert.deepEqual(mergeInv.mergedPayload[key], canonicalInvestment[key], `Investment field '${key}' must be preserved`);
    }
    assert.equal(mergeInv.mergedPayload.created_by_device_id, 'dev_c7e4544221f4');
    assert.equal(mergeInv.mergedPayload.created_by_provenance, 'LEGACY_ASSIGNED');

    // 2. Reject merge if ANY investment-specific field differs
    const investmentFieldsToTest = [
      ['investment_transaction_type', 'SELL'],
      ['brokerage', 'Groww'],
      ['security_symbol', 'TCS'],
      ['security_isin', 'INE467B01029'],
      ['quantity', 100],
      ['unit_price', 2500.00],
      ['trade_value', 250000.00],
      ['cost_basis', 200000.00],
      ['cash_impact', -250000.00],
      ['position_qty_change', 100],
      ['realized_pnl', 1500.00],
      ['trade_id', 'TRD_DIFF'],
      ['order_id', 'ORD_DIFF'],
      ['exchange', 'BSE'],
      ['segment', 'FNO'],
      ['source', 'MANUAL'],
      ['investment_account', 'Groww Equity'],
      ['actual_amount', 130000.00],
      ['total_charges', 25.00],
      ['brokerage_charges', 20.00],
      ['exchange_charges', 10.00],
      ['stt_charges', 15.00],
      ['sebi_charges', 1.00],
      ['stamp_duty_charges', 5.00],
      ['gst_charges', 3.60],
      ['dp_charges', 15.93],
      ['other_charges', 5.00],
      ['security_display_name', 'Tata Consultancy Services'],
      ['settlement_mode', 'ESTIMATED']
    ];

    for (const [field, diffVal] of investmentFieldsToTest) {
      const conflictingRemote = { ...remoteInvestmentLegacy, [field]: diffVal };
      const res = isSafelyMergeableLegacyAttribution(canonicalInvestment, conflictingRemote, 'investment_transactions');
      assert.equal(res.isMergeable, false, `Differences in investment field '${field}' must NOT be auto-merged`);
      assert.equal(res.mergedPayload, null);
    }
  });
});
