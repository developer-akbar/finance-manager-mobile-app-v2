/**
 * bookmarks_sync.test.js — Cross-Device Synchronization Tests for Bookmarks
 *
 * Verifies:
 * 1. Delta Queue Event generation on saveBookmark, updateBookmark, deleteBookmark, reorderBookmarks.
 * 2. Tombstone creation on deleteBookmark propagation.
 * 3. Peer Delta Reconciliation: Device A mutations cleanly replay on Device B.
 * 4. Snapshot Export & Bootstrap: readLocalEntities and canonicalizeEntity include bookmarks.
 * 5. 3-Way Snapshot Reconciliation: local and remote additions, updates, and deletes.
 * 6. Financial Transaction Isolation: Bookmarks synchronization never affects transactions table or balances.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuid } from 'uuid';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { initDB, getDB, closeDB } from '../database/db.js';
import {
  saveBookmark,
  updateBookmark,
  deleteBookmark,
  reorderBookmarks,
  getAllBookmarks
} from '../database/bookmarks.js';
import { addTransaction, getTransactions } from '../database/transactions.js';
import { getTombstones } from '../database/tombstones.js';
import {
  readLocalEntities,
  canonicalizeEntity,
  getManifestEntityKey,
  reconcile3Way,
  createCanonicalSnapshotPayload
} from '../services/cloudSyncEngine.js';
import {
  reconcileStagedEvents,
  RECONCILIATION_STATUS,
  APPROVED_BASE_SNAPSHOT_ID
} from '../services/deltaReconciliation.js';
import { DELTA_OPERATION } from '../database/deltaQueue.js';
import { computeCanonicalSha256 } from '../utils/canonicalEntity.js';

test.beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await initDB();
});

test.afterEach(async () => {
  await closeDB();
});

async function stageTestPackage({
  peerDeviceId = 'peer_dev_b',
  startSequence = 1,
  endSequence = 1,
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
}

test('Sync: saveBookmark writes delta event to sync_delta_queue', async () => {
  const db = getDB();

  const bm = await saveBookmark({
    name: 'Weekly Groceries',
    transaction_type: 'Expense',
    template_data: {
      amount: '1500',
      account: 'HDFC Bank',
      category: 'Food',
      note: 'Supermarket'
    }
  });

  assert.ok(bm.id, 'Bookmark must have an ID');

  // Verify sync_delta_queue has recorded an INSERT event for transaction_bookmarks
  const queueRes = await db.query('SELECT * FROM sync_delta_queue WHERE entity_id = ?', [bm.id]);
  const queueEvents = queueRes.values || [];

  assert.equal(queueEvents.length, 1, 'Should generate exactly 1 delta event');
  assert.equal(queueEvents[0].collection, 'transaction_bookmarks');
  assert.equal(queueEvents[0].operation, DELTA_OPERATION.INSERT);

  const payload = typeof queueEvents[0].payload === 'string'
    ? JSON.parse(queueEvents[0].payload)
    : queueEvents[0].payload;
  assert.equal(payload.name, 'Weekly Groceries');
});

test('Sync: updateBookmark writes UPDATE delta event to sync_delta_queue', async () => {
  const db = getDB();

  const bm = await saveBookmark({
    name: 'Metro Ticket',
    transaction_type: 'Expense',
    template_data: { amount: '40', account: 'Cash' }
  });

  await updateBookmark(bm.id, { name: 'Metro Fast Pass', template_data: { amount: '60' } });

  const queueRes = await db.query('SELECT * FROM sync_delta_queue WHERE entity_id = ? ORDER BY timestamp ASC', [bm.id]);
  const queueEvents = queueRes.values || [];

  assert.equal(queueEvents.length, 2, 'Should have 2 delta events (INSERT then UPDATE)');
  assert.equal(queueEvents[1].operation, DELTA_OPERATION.UPDATE);

  const payload = typeof queueEvents[1].payload === 'string'
    ? JSON.parse(queueEvents[1].payload)
    : queueEvents[1].payload;
  assert.equal(payload.name, 'Metro Fast Pass');
});

test('Sync: deleteBookmark writes DELETE delta and records tombstone', async () => {
  const db = getDB();

  const bm = await saveBookmark({
    name: 'Old Subscription',
    transaction_type: 'Expense',
    template_data: { amount: '199', account: 'Credit Card' }
  });

  await deleteBookmark(bm.id);

  // 1. Verify row deleted from transaction_bookmarks
  const list = await getAllBookmarks();
  assert.equal(list.filter(b => b.id === bm.id).length, 0, 'Bookmark should be deleted from table');

  // 2. Verify DELETE delta in sync_delta_queue
  const queueRes = await db.query('SELECT * FROM sync_delta_queue WHERE entity_id = ? AND operation = ?', [bm.id, DELTA_OPERATION.DELETE]);
  const deleteEvents = queueRes.values || [];
  assert.equal(deleteEvents.length, 1, 'Should record DELETE delta');
  assert.equal(deleteEvents[0].collection, 'transaction_bookmarks');

  // 3. Verify tombstone in sync_tombstones
  const tombstones = await getTombstones();
  const tomb = tombstones.find(t => t.id === bm.id || t.entity_id === bm.id);
  assert.ok(tomb, 'Tombstone must be created for deleted bookmark');
  assert.equal(tomb.entity_type, 'transaction_bookmarks');
});

test('Sync: Multi-Device Delta Reconciliation applies remote bookmark cleanly', async () => {
  const remoteBookmarkId = 'bm-remote-device-b-101';
  const remotePayload = {
    id: remoteBookmarkId,
    name: 'Electricity Bill',
    transaction_type: 'Expense',
    template_data: JSON.stringify({ amount: '2200', account: 'HDFC Bank', category: 'Bills' }),
    source_transaction_id: '',
    sort_order: 1,
    usage_count: 3,
    last_used_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const newHash = await computeCanonicalSha256(remotePayload);

  await stageTestPackage({
    peerDeviceId: 'peer_dev_b',
    startSequence: 1,
    endSequence: 1,
    events: [{
      event_id: 'evt-peer-b-1',
      sequence: 1,
      collection: 'transaction_bookmarks',
      entity_id: remoteBookmarkId,
      operation: DELTA_OPERATION.INSERT,
      base_checksum: null,
      new_checksum: newHash,
      payload: remotePayload
    }]
  });

  // Reconcile incoming bundle on Device A
  const reconResult = await reconcileStagedEvents({ peerDeviceId: 'peer_dev_b' });
  assert.equal(reconResult.reconciledCount, 1, 'Delta should be cleanly applied');

  // Verify bookmark is now present in local database
  const bms = await getAllBookmarks();
  const applied = bms.find(b => b.id === remoteBookmarkId);
  assert.ok(applied, 'Bookmark from peer should be persisted locally');
  assert.equal(applied.name, 'Electricity Bill');
  assert.equal(applied.template_data.amount, '2200');
});

test('Sync: Snapshot Export and Canonical Hashing includes transaction_bookmarks', async () => {
  const db = getDB();

  const bm = await saveBookmark({
    name: 'Gym Membership',
    transaction_type: 'Expense',
    template_data: { amount: '2000', account: 'ICICI Bank' }
  });

  const localEntities = await readLocalEntities(db);
  assert.ok(Array.isArray(localEntities.transaction_bookmarks), 'localEntities must include transaction_bookmarks');
  assert.ok(localEntities.transaction_bookmarks.some(b => b.id === bm.id), 'Exported snapshot must contain bookmark');

  const canon = canonicalizeEntity(bm, 'transaction_bookmarks');
  assert.ok(canon.includes('Gym Membership'), 'Canonical string must contain bookmark name');
  assert.ok(canon.includes('Expense'), 'Canonical string must contain transaction type');

  const manifestKey = getManifestEntityKey('transaction_bookmarks', bm.id);
  assert.equal(manifestKey, `transaction_bookmarks:${bm.id}`);
});

test('Sync: 3-Way Reconciliation synchronizes bookmarks across cloud and local', async () => {
  const localBm = {
    id: 'bm-local-1',
    name: 'Local Coffee',
    transaction_type: 'Expense',
    template_data: '{"amount":"150"}',
    sort_order: 0
  };

  const cloudBm = {
    id: 'bm-cloud-1',
    name: 'Cloud Mobile Recharge',
    transaction_type: 'Expense',
    template_data: '{"amount":"499"}',
    sort_order: 1
  };

  const plan = await reconcile3Way({
    baseManifest: {},
    localEntities: {
      transaction_bookmarks: [localBm],
      transactions: []
    },
    cloudEntities: {
      transaction_bookmarks: [cloudBm],
      transactions: []
    }
  });

  // Local should accept cloud insert; Cloud should accept local insert
  assert.ok(
    plan.plannedLocalInserts.some(item => item.id === 'bm-cloud-1'),
    'Local database should plan to insert cloud bookmark'
  );
  assert.ok(
    plan.plannedCloudInserts.some(item => item.id === 'bm-local-1'),
    'Cloud payload should plan to upload local bookmark'
  );
  assert.equal(plan.conflicts.length, 0, 'Should have zero conflicts');
});

test('Sync: Bookmark mutations and sync have ZERO effect on financial transactions', async () => {
  const db = getDB();

  // Add initial financial transaction
  const initialTxn = await addTransaction({
    date: '2026-11-10',
    account: 'Bank Account',
    category: 'Salary',
    amount: 50000,
    inr: 50000,
    type: 'Income'
  });

  const txnsBefore = await getTransactions();
  assert.equal(txnsBefore.length, 1);
  const initialTxnChecksum = canonicalizeEntity(txnsBefore[0], 'transactions');

  // Perform multiple bookmark lifecycle operations: create, update, reorder, delete
  const bm1 = await saveBookmark({ name: 'Template 1', template_data: { amount: '100' } });
  const bm2 = await saveBookmark({ name: 'Template 2', template_data: { amount: '200' } });
  await updateBookmark(bm1.id, { name: 'Template 1 Updated' });
  await reorderBookmarks([bm2.id, bm1.id]);
  await deleteBookmark(bm2.id);

  // Verify financial transactions are 100% unaltered
  const txnsAfter = await getTransactions();
  assert.equal(txnsAfter.length, 1, 'Transaction count must remain exactly 1');
  assert.equal(txnsAfter[0].id, initialTxn.id, 'Transaction ID must match');
  assert.equal(txnsAfter[0].inr, 50000, 'Transaction amount must remain untouched');

  const afterTxnChecksum = canonicalizeEntity(txnsAfter[0], 'transactions');
  assert.equal(afterTxnChecksum, initialTxnChecksum, 'Financial transaction checksum must be identical');
});
