import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { initDB, closeDB, getDB } from '../database/db.js';
import {
  getManifestEntityKey,
  buildEntityManifest,
  createCanonicalSnapshotPayload,
  validateCloudSnapshotPayload,
  populateLocalEntitiesBootstrap,
  readLocalEntities,
  reconcile3Way,
  applyLocalEntityInsertOrUpdate
} from '../services/cloudSyncEngine.js';
import { isSafelyMergeableLegacyAttribution } from '../services/deltaReconciliation.js';

const OVERLAPPING_UUID = 'ef41e977-a250-47a7-a41c-fea7944aa71e';

const sampleOrdinaryTxn = {
  id: OVERLAPPING_UUID,
  date: '27/07/2026',
  time: '00:00',
  account: 'HDFC',
  from_account: '',
  to_account: '',
  category: 'Equity',
  subcategory: 'Default',
  note: 'Dividend',
  description: 'Dividend received from WIPRO# per share \u20b92.00',
  inr: 8.0,
  amount: '8',
  currency: 'INR',
  type: 'Income',
  created_at: '2026-10-23T18:14:04.263Z',
  updated_at: '2026-10-23T18:14:04.263Z',
  sub_account: 'Zerodha',
  from_sub_account: 'Zerodha',
  to_sub_account: '',
  created_by_device_id: null,
  created_by_provenance: null
};

const sampleInvestmentTxn = {
  id: OVERLAPPING_UUID,
  date: '27/07/2026',
  time: '00:00',
  account: 'HDFC',
  from_account: 'HDFC',
  to_account: '',
  category: 'Equity',
  subcategory: '',
  note: 'Dividend',
  description: 'Dividend received from WIPRO# per share \u20b92.00',
  inr: 8.0,
  amount: '8',
  currency: 'INR',
  type: 'Income',
  created_at: '2026-08-29T19:10:00.000Z',
  updated_at: '2026-08-29T19:10:00.000Z',
  investment_transaction_type: 'DIVIDEND',
  brokerage: 'Zerodha',
  security_symbol: 'WIPRO#',
  security_isin: '',
  quantity: 4.0,
  unit_price: 2.0,
  trade_value: 8.0,
  cost_basis: 0.0,
  cash_impact: 0.0,
  position_qty_change: 0.0,
  realized_pnl: 0.0,
  created_by_device_id: null,
  created_by_provenance: null
};

test('Collection-Scoped Entity Identity Suite', async (suite) => {
  suite.beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await initDB();
  });

  suite.afterEach(async () => {
    try {
      await closeDB();
    } catch {}
  });

  await suite.test('1. getManifestEntityKey scopes investment_transactions while preserving transaction key', () => {
    const txnKey = getManifestEntityKey('transactions', OVERLAPPING_UUID);
    const invKey = getManifestEntityKey('investment_transactions', OVERLAPPING_UUID);
    const invSingularKey = getManifestEntityKey('investment_transaction', OVERLAPPING_UUID);

    assert.equal(txnKey, OVERLAPPING_UUID, 'Ordinary transactions retain un-prefixed raw UUID');
    assert.equal(invKey, `investment_transactions:${OVERLAPPING_UUID}`, 'Investment transactions receive collection scope prefix');
    assert.equal(invSingularKey, `investment_transactions:${OVERLAPPING_UUID}`, 'Singular collection name normalizes to investment_transactions');
    assert.notEqual(txnKey, invKey, 'Keys must be distinct to prevent map collision');
  });

  await suite.test('2. buildEntityManifest retains BOTH entities with shared UUID without overwrite', async () => {
    const entities = {
      transactions: [sampleOrdinaryTxn],
      investment_transactions: [sampleInvestmentTxn]
    };

    const manifest = await buildEntityManifest(entities);
    const manifestKeys = Object.keys(manifest);

    assert.equal(manifestKeys.length, 2, 'Manifest must contain exactly 2 entries, not 1');
    assert.ok(manifest[OVERLAPPING_UUID], 'Manifest contains ordinary transaction key');
    assert.ok(manifest[`investment_transactions:${OVERLAPPING_UUID}`], 'Manifest contains investment transaction key');

    assert.equal(manifest[OVERLAPPING_UUID].type, 'transactions');
    assert.equal(manifest[`investment_transactions:${OVERLAPPING_UUID}`].type, 'investment_transactions');
  });

  await suite.test('3. Snapshot generation and checksum calculation preserve both entities', async () => {
    const snapshotResult = await createCanonicalSnapshotPayload({
      entities: {
        transactions: [sampleOrdinaryTxn],
        investment_transactions: [sampleInvestmentTxn],
        accounts: [{ id: 'HDFC', name: 'HDFC' }]
      },
      snapshotId: 'snap_test_scoped_v18',
      cloudVersion: 18,
      deviceId: 'dev_test_device'
    });

    assert.ok(snapshotResult.payload);
    assert.ok(snapshotResult.checksum);
    assert.equal(snapshotResult.payload.entities.transactions.length, 1);
    assert.equal(snapshotResult.payload.entities.investment_transactions.length, 1);
    assert.equal(snapshotResult.payload.entities.transactions[0].id, OVERLAPPING_UUID);
    assert.equal(snapshotResult.payload.entities.investment_transactions[0].id, OVERLAPPING_UUID);

    // Deep validation of snapshot payload structure
    await validateCloudSnapshotPayload(snapshotResult.payload);
  });

  await suite.test('4. Snapshot restore populates and validates both tables independently', async () => {
    const db = getDB();

    const snapshotResult = await createCanonicalSnapshotPayload({
      entities: {
        transactions: [sampleOrdinaryTxn],
        investment_transactions: [sampleInvestmentTxn],
        accounts: [{ id: 'HDFC', name: 'HDFC' }]
      },
      snapshotId: 'snap_test_scoped_v18',
      cloudVersion: 18,
      deviceId: 'dev_test_device'
    });

    // Populate into empty database
    await populateLocalEntitiesBootstrap(db, snapshotResult.payload.entities, { allowRecoveryReplacement: true });

    // Verify physical records in both tables
    const local = await readLocalEntities(db);
    assert.equal(local.transactions.length, 1);
    assert.equal(local.investment_transactions.length, 1);

    const physicalTxn = local.transactions[0];
    const physicalInv = local.investment_transactions[0];

    assert.equal(physicalTxn.id, OVERLAPPING_UUID);
    assert.equal(physicalInv.id, OVERLAPPING_UUID);

    // Verify table-specific fields are preserved correctly
    assert.equal(physicalTxn.sub_account, 'Zerodha');
    assert.equal(physicalInv.security_symbol, 'WIPRO#');
    assert.equal(physicalInv.quantity, 4.0);
    assert.equal(physicalInv.unit_price, 2.0);

    // Post-bootstrap manifest equality verification
    const localManifest = await buildEntityManifest(local);
    const cloudManifest = await buildEntityManifest(snapshotResult.payload.entities);

    assert.equal(Object.keys(localManifest).length, Object.keys(cloudManifest).length);
    for (const [k, cloudEntry] of Object.entries(cloudManifest)) {
      const localEntry = localManifest[k];
      assert.ok(localEntry, `Entry ${k} must exist in local manifest`);
      assert.equal(localEntry.canonical, cloudEntry.canonical);
    }
  });

  await suite.test('5. Delta reconciliation safely merges legacy attribution for both collections', () => {
    const remoteTxnPayload = {
      ...sampleOrdinaryTxn,
      created_by_device_id: 'dev_c7e4544221f4',
      created_by_provenance: 'LEGACY_ASSIGNED'
    };

    const remoteInvPayload = {
      ...sampleInvestmentTxn,
      created_by_device_id: 'dev_c7e4544221f4',
      created_by_provenance: 'LEGACY_ASSIGNED'
    };

    const txnMerge = isSafelyMergeableLegacyAttribution(sampleOrdinaryTxn, remoteTxnPayload, 'transactions');
    assert.equal(txnMerge.isMergeable, true, 'Ordinary transaction legacy attribution is safely mergeable');
    assert.equal(txnMerge.mergedPayload.created_by_device_id, 'dev_c7e4544221f4');

    const invMerge = isSafelyMergeableLegacyAttribution(sampleInvestmentTxn, remoteInvPayload, 'investment_transactions');
    assert.equal(invMerge.isMergeable, true, 'Investment transaction legacy attribution is safely mergeable');
    assert.equal(invMerge.mergedPayload.created_by_device_id, 'dev_c7e4544221f4');
    assert.equal(invMerge.mergedPayload.security_symbol, 'WIPRO#');
    assert.equal(invMerge.mergedPayload.quantity, 4.0);
  });

  await suite.test('6. Ordinary transaction deletion while investment transaction survives', async () => {
    // Cloud has deleted the ordinary transaction (tombstone for transactions)
    const baseManifest = await buildEntityManifest({
      transactions: [sampleOrdinaryTxn],
      investment_transactions: [sampleInvestmentTxn]
    });

    const localEntities = {
      transactions: [sampleOrdinaryTxn],
      investment_transactions: [sampleInvestmentTxn],
      sync_tombstones: []
    };

    const cloudEntities = {
      transactions: [],
      investment_transactions: [sampleInvestmentTxn],
      sync_tombstones: [{
        id: OVERLAPPING_UUID,
        entity_id: OVERLAPPING_UUID,
        entity_type: 'transactions',
        deleted_at: new Date().toISOString()
      }]
    };

    const plan = await reconcile3Way({
      baseManifest,
      localEntities,
      cloudEntities
    });

    // Planned local deletes must contain ONLY ordinary transaction
    assert.equal(plan.plannedLocalDeletes.length, 1);
    assert.equal(plan.plannedLocalDeletes[0].id, OVERLAPPING_UUID);
    assert.equal(plan.plannedLocalDeletes[0].type, 'transactions');

    // Investment transaction must NOT be deleted
    const invDeleted = plan.plannedLocalDeletes.some(d => d.type === 'investment_transactions');
    assert.equal(invDeleted, false, 'Investment transaction must survive');
  });

  await suite.test('7. Investment transaction deletion while ordinary transaction survives', async () => {
    // Cloud has deleted the investment transaction (tombstone for investment_transactions)
    const baseManifest = await buildEntityManifest({
      transactions: [sampleOrdinaryTxn],
      investment_transactions: [sampleInvestmentTxn]
    });

    const localEntities = {
      transactions: [sampleOrdinaryTxn],
      investment_transactions: [sampleInvestmentTxn],
      sync_tombstones: []
    };

    const cloudEntities = {
      transactions: [sampleOrdinaryTxn],
      investment_transactions: [],
      sync_tombstones: [{
        id: `investment_transactions:${OVERLAPPING_UUID}`,
        entity_id: OVERLAPPING_UUID,
        entity_type: 'investment_transactions',
        deleted_at: new Date().toISOString()
      }]
    };

    const plan = await reconcile3Way({
      baseManifest,
      localEntities,
      cloudEntities
    });

    // Planned local deletes must contain ONLY investment transaction
    assert.equal(plan.plannedLocalDeletes.length, 1);
    assert.equal(plan.plannedLocalDeletes[0].id, OVERLAPPING_UUID);
    assert.equal(plan.plannedLocalDeletes[0].type, 'investment_transactions');

    // Ordinary transaction must NOT be deleted
    const txnDeleted = plan.plannedLocalDeletes.some(d => d.type === 'transactions');
    assert.equal(txnDeleted, false, 'Ordinary transaction must survive');
  });

  await suite.test('8. Both records modified independently across devices without collision', async () => {
    const baseManifest = await buildEntityManifest({
      transactions: [sampleOrdinaryTxn],
      investment_transactions: [sampleInvestmentTxn]
    });

    // Local modifies ordinary transaction (e.g. note updated)
    const modifiedLocalTxn = { ...sampleOrdinaryTxn, note: 'Updated Dividend Note' };

    // Cloud modifies investment transaction (e.g. quantity updated from 4 to 8)
    const modifiedCloudInv = { ...sampleInvestmentTxn, quantity: 8.0, trade_value: 16.0 };

    const plan = await reconcile3Way({
      baseManifest,
      localEntities: {
        transactions: [modifiedLocalTxn],
        investment_transactions: [sampleInvestmentTxn]
      },
      cloudEntities: {
        transactions: [sampleOrdinaryTxn],
        investment_transactions: [modifiedCloudInv]
      }
    });

    // Local changes to ordinary transaction should propagate to cloud
    assert.equal(plan.plannedCloudUpdates.length, 1);
    assert.equal(plan.plannedCloudUpdates[0].id, OVERLAPPING_UUID);
    assert.equal(plan.plannedCloudUpdates[0]._collection, 'transactions');
    assert.equal(plan.plannedCloudUpdates[0].note, 'Updated Dividend Note');

    // Cloud changes to investment transaction should propagate to local
    assert.equal(plan.plannedLocalUpdates.length, 1);
    assert.equal(plan.plannedLocalUpdates[0].id, OVERLAPPING_UUID);
    assert.equal(plan.plannedLocalUpdates[0]._collection, 'investment_transactions');
    assert.equal(plan.plannedLocalUpdates[0].quantity, 8.0);

    // Zero cross-table conflicts
    assert.equal(plan.conflicts.length, 0);
  });

  await suite.test('9. Old snapshot manifest compatibility (legacy un-prefixed manifest keys)', async () => {
    // In legacy snapshot manifests, investment transactions were keyed by raw ID
    const legacyBaseManifest = {
      [OVERLAPPING_UUID]: {
        type: 'investment_transactions',
        rawId: OVERLAPPING_UUID,
        fp: 'legacy_hash',
        canonical: 'legacy_canonical'
      }
    };

    // Current local and cloud have modern scoped keys
    const modernLocalEntities = {
      transactions: [sampleOrdinaryTxn],
      investment_transactions: [sampleInvestmentTxn]
    };

    const modernCloudEntities = {
      transactions: [sampleOrdinaryTxn],
      investment_transactions: [sampleInvestmentTxn]
    };

    const plan = await reconcile3Way({
      baseManifest: legacyBaseManifest,
      localEntities: modernLocalEntities,
      cloudEntities: modernCloudEntities
    });

    // Both identical between local and cloud -> zero unwanted conflicts
    assert.equal(plan.conflicts.length, 0);
  });

  await suite.test('10. Delta replay after restore applies updates to correct table', async () => {
    const db = getDB();

    // Bootstrap both into local DB
    await populateLocalEntitiesBootstrap(db, {
      transactions: [sampleOrdinaryTxn],
      investment_transactions: [sampleInvestmentTxn],
      accounts: [{ id: 'HDFC', name: 'HDFC' }]
    }, { allowRecoveryReplacement: true });

    // 1. Apply delta update for ordinary transaction
    const updatedTxn = {
      ...sampleOrdinaryTxn,
      note: 'Replayed Dividend Note',
      amount: '10'
    };
    await applyLocalEntityInsertOrUpdate(db, updatedTxn, 'transactions');

    // 2. Apply delta update for investment transaction
    const updatedInv = {
      ...sampleInvestmentTxn,
      quantity: 12.0,
      trade_value: 24.0
    };
    await applyLocalEntityInsertOrUpdate(db, updatedInv, 'investment_transactions');

    // Query both tables directly
    const txRow = (await db.query('SELECT * FROM transactions WHERE id = ?', [OVERLAPPING_UUID])).values[0];
    const invRow = (await db.query('SELECT * FROM investment_transactions WHERE id = ?', [OVERLAPPING_UUID])).values[0];

    assert.equal(txRow.note, 'Replayed Dividend Note');
    assert.equal(txRow.amount, '10');
    assert.equal(txRow.sub_account, 'Zerodha');

    assert.equal(invRow.quantity, 12.0);
    assert.equal(invRow.trade_value, 24.0);
    assert.equal(invRow.security_symbol, 'WIPRO#');
  });
});
