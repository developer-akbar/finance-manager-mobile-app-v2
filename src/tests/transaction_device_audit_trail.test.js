/**
 * transaction_device_audit_trail.test.js
 *
 * Automated Test Suite for Transaction Device Audit Trail in Developer Debug Info:
 * 1. New transaction creation records the correct creator device ID.
 * 2. Modification updates the modifier ID without changing creator ID.
 * 3. Device rename dynamically changes the displayed device name.
 * 4. Missing device registry entry falls back to device ID.
 * 5. Existing transactions without provenance show Unknown (Legacy).
 * 6. Historical provenance is populated only when reliable evidence exists.
 * 7. Sync does not replace the originating device with the receiving device.
 * 8. Offline modification preserves the originating device after sync.
 * 9. Conflict resolution preserves audit metadata from the winning transaction version.
 * 10. Snapshot restore preserves audit metadata.
 * 11. Imports and bulk operations assign appropriate provenance.
 * 12. Both ordinary and investment transactions render the fields correctly.
 * 13. Old records without the new fields continue to work.
 * 14. Device removal does not destroy historical device identity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, closeDB, getDB } from '../database/db.js';
import {
  addTransaction,
  updateTransaction,
  rowToTxn,
  bulkImport,
  convertTransactionToInstalment
} from '../database/transactions.js';
import {
  getCurrentDeviceId,
  setCachedLocalDeviceId,
  registerDeviceAuditName,
  setDeviceNickname,
  resolveDeviceAuditInfo,
  clearDeviceAuditRegistry
} from '../services/deviceAudit.js';
import {
  populateLocalEntitiesBootstrap,
  txnObjectToDBRow,
  invTxnObjectToDBRow
} from '../services/cloudSyncEngine.js';

test('TRANSACTION DEVICE AUDIT TRAIL TEST SUITE', async (t) => {
  let db;

  t.beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    clearDeviceAuditRegistry();
    db = await initDB();
  });

  t.afterEach(async () => {
    clearDeviceAuditRegistry();
    await closeDB();
  });

  // ── 1. New transaction creation records the correct creator device ID ─────
  await t.test('1. New transaction creation records the correct creator device ID', async () => {
    setCachedLocalDeviceId('dev_alpha_01');

    // Create ordinary transaction
    const regularTxn = await addTransaction({
      date: '2026-11-03',
      amount: '500',
      type: 'Expense',
      account: 'Bank',
      category: 'Food',
      note: 'Dinner'
    });

    assert.equal(regularTxn.created_by_device_id, 'dev_alpha_01');
    assert.equal(regularTxn.updated_by_device_id, 'dev_alpha_01');

    // Verify DB persistence
    const res = await db.query('SELECT created_by_device_id, updated_by_device_id FROM transactions WHERE id = ?', [regularTxn.id]);
    assert.equal(res.values[0].created_by_device_id, 'dev_alpha_01');
    assert.equal(res.values[0].updated_by_device_id, 'dev_alpha_01');

    // Create investment transaction
    const invTxn = await addTransaction({
      date: '2026-11-03',
      amount: '1000',
      type: 'Expense',
      account: 'Demat',
      InvestmentTransactionType: 'BUY',
      Brokerage: 'Zerodha',
      SecuritySymbol: 'INFY',
      SecurityISIN: 'INE009A01021',
      Quantity: 10,
      UnitPrice: 100
    });

    assert.equal(invTxn.created_by_device_id, 'dev_alpha_01');
    assert.equal(invTxn.updated_by_device_id, 'dev_alpha_01');

    const invRes = await db.query('SELECT created_by_device_id, updated_by_device_id FROM investment_transactions WHERE id = ?', [invTxn.id]);
    assert.equal(invRes.values[0].created_by_device_id, 'dev_alpha_01');
    assert.equal(invRes.values[0].updated_by_device_id, 'dev_alpha_01');
  });

  // ── 2. Modification updates the modifier ID without changing creator ID ───
  await t.test('2. Modification updates the modifier ID without changing creator ID', async () => {
    // Created on Device Alpha
    setCachedLocalDeviceId('dev_alpha_01');
    const created = await addTransaction({
      date: '2026-11-03',
      amount: '200',
      note: 'Initial'
    });

    // Modified on Device Beta
    setCachedLocalDeviceId('dev_beta_02');
    const updated = await updateTransaction(created.id, {
      amount: '250',
      note: 'Modified on Beta'
    });

    assert.equal(updated.created_by_device_id, 'dev_alpha_01', 'Creator must NOT be overwritten on modification');
    assert.equal(updated.updated_by_device_id, 'dev_beta_02', 'Modifier must be updated to current device');

    // Verify DB state
    const res = await db.query('SELECT created_by_device_id, updated_by_device_id FROM transactions WHERE id = ?', [created.id]);
    assert.equal(res.values[0].created_by_device_id, 'dev_alpha_01');
    assert.equal(res.values[0].updated_by_device_id, 'dev_beta_02');
  });

  // ── 3. Device rename dynamically changes the displayed device name ────────
  await t.test('3. Device rename dynamically changes the displayed device name', async () => {
    setCachedLocalDeviceId('dev_alpha_01');
    registerDeviceAuditName('dev_alpha_01', 'Office Laptop');

    const info1 = resolveDeviceAuditInfo('dev_alpha_01');
    assert.equal(info1.deviceId, 'dev_alpha_01');
    assert.equal(info1.deviceName, 'Office Laptop');
    assert.equal(info1.isLegacy, false);

    // User renames device to Home Workstation
    setDeviceNickname('dev_alpha_01', 'Home Workstation');

    const info2 = resolveDeviceAuditInfo('dev_alpha_01');
    assert.equal(info2.deviceId, 'dev_alpha_01');
    assert.equal(info2.deviceName, 'Home Workstation', 'Must resolve to renamed nickname dynamically');
    assert.equal(info2.isLegacy, false);
  });

  // ── 4. Missing device registry entry falls back to device ID ───────────────
  await t.test('4. Missing device registry entry falls back to device ID', async () => {
    const info = resolveDeviceAuditInfo('dev_unregistered_xyz');
    assert.equal(info.deviceId, 'dev_unregistered_xyz');
    assert.equal(info.deviceName, null, 'Unregistered device name must be null');
    assert.equal(info.isLegacy, false);
  });

  // ── 5. Existing transactions without provenance show Unknown (Legacy) ─────
  await t.test('5. Existing transactions without provenance show Unknown (Legacy)', async () => {
    assert.equal(resolveDeviceAuditInfo(null).isLegacy, true);
    assert.equal(resolveDeviceAuditInfo(undefined).isLegacy, true);
    assert.equal(resolveDeviceAuditInfo('').isLegacy, true);
    assert.equal(resolveDeviceAuditInfo('local_device').isLegacy, true);
    assert.equal(resolveDeviceAuditInfo('Unknown').isLegacy, true);

    // Verify rowToTxn on raw legacy row without audit columns
    const legacyRow = {
      id: 'tx_legacy_001',
      date: '2026-01-01',
      inr: 100,
      amount: '100',
      type: 'Expense'
    };
    const mapped = rowToTxn(legacyRow);
    assert.equal(mapped.created_by_device_id, null);
    assert.equal(mapped.updated_by_device_id, null);
    assert.equal(resolveDeviceAuditInfo(mapped.created_by_device_id).isLegacy, true);
  });

  // ── 6. Historical provenance is populated only when reliable evidence exists
  await t.test('6. Historical provenance is populated only when reliable evidence exists', async () => {
    // Insert a legacy record into the DB with NULL audit fields
    await db.run('INSERT INTO transactions (id, date, inr, amount, type) VALUES (?, ?, ?, ?, ?)', [
      'tx_hist_legacy', '2026-05-01', 50, '50', 'Expense'
    ]);

    const res = await db.query('SELECT * FROM transactions WHERE id = ?', ['tx_hist_legacy']);
    const row = res.values[0];
    const txn = rowToTxn(row);

    // Verify neither field was falsely populated with local device ID
    assert.equal(txn.created_by_device_id, null);
    assert.equal(txn.updated_by_device_id, null);
    assert.equal(resolveDeviceAuditInfo(txn.created_by_device_id).isLegacy, true);
    assert.equal(resolveDeviceAuditInfo(txn.updated_by_device_id).isLegacy, true);
  });

  // ── 7. Sync does not replace the originating device with the receiving device
  await t.test('7. Sync does not replace the originating device with the receiving device', async () => {
    // Current receiving device is Beta
    setCachedLocalDeviceId('dev_beta_02');

    // Incoming remote payload originated on Alpha
    const incomingRemotePayload = {
      id: 'tx_sync_origin_test',
      date: '2026-11-03',
      amount: '300',
      inr: 300,
      type: 'Expense',
      created_by_device_id: 'dev_alpha_01',
      updated_by_device_id: 'dev_alpha_01'
    };

    // Reconcile/write payload into local database (simulating delta sync insertion)
    const dbRow = txnObjectToDBRow(incomingRemotePayload);
    await db.run(
      'INSERT OR REPLACE INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [dbRow.id, dbRow.date, dbRow.amount, dbRow.inr, dbRow.type, dbRow.created_by_device_id, dbRow.updated_by_device_id]
    );

    const savedRes = await db.query('SELECT created_by_device_id, updated_by_device_id FROM transactions WHERE id = ?', ['tx_sync_origin_test']);
    const saved = rowToTxn(savedRes.values[0]);

    assert.equal(saved.created_by_device_id, 'dev_alpha_01', 'Must remain Device Alpha');
    assert.equal(saved.updated_by_device_id, 'dev_alpha_01', 'Must remain Device Alpha');
  });

  // ── 8. Offline modification preserves the originating device after sync ───
  await t.test('8. Offline modification preserves the originating device after sync', async () => {
    // Original created on Alpha
    const original = {
      id: 'tx_offline_edit_test',
      date: '2026-11-01',
      amount: '100',
      inr: 100,
      type: 'Expense',
      created_by_device_id: 'dev_alpha_01',
      updated_by_device_id: 'dev_alpha_01'
    };
    await db.run(
      'INSERT INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [original.id, original.date, original.amount, original.inr, original.type, original.created_by_device_id, original.updated_by_device_id]
    );

    // Modified on Beta while offline
    setCachedLocalDeviceId('dev_beta_02');
    const modified = await updateTransaction(original.id, {
      amount: '120',
      note: 'Offline modification'
    });

    assert.equal(modified.created_by_device_id, 'dev_alpha_01');
    assert.equal(modified.updated_by_device_id, 'dev_beta_02');

    // Synced to Gamma
    setCachedLocalDeviceId('dev_gamma_03');
    const gammaDbRow = txnObjectToDBRow(modified);
    await db.run(
      'INSERT OR REPLACE INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [gammaDbRow.id, gammaDbRow.date, gammaDbRow.amount, gammaDbRow.inr, gammaDbRow.type, gammaDbRow.created_by_device_id, gammaDbRow.updated_by_device_id]
    );

    const gammaRes = await db.query('SELECT created_by_device_id, updated_by_device_id FROM transactions WHERE id = ?', [original.id]);
    assert.equal(gammaRes.values[0].created_by_device_id, 'dev_alpha_01');
    assert.equal(gammaRes.values[0].updated_by_device_id, 'dev_beta_02');
  });

  // ── 9. Conflict resolution preserves audit metadata from the winning version
  await t.test('9. Conflict resolution preserves audit metadata from the winning version', async () => {
    const localWinning = {
      id: 'tx_conf_01',
      amount: '100',
      created_by_device_id: 'dev_alpha_01',
      updated_by_device_id: 'dev_beta_02'
    };
    const remoteWinning = {
      id: 'tx_conf_02',
      amount: '150',
      created_by_device_id: 'dev_alpha_01',
      updated_by_device_id: 'dev_gamma_03'
    };

    // KEEP_LOCAL resolution
    const keepLocalRow = txnObjectToDBRow(localWinning);
    assert.equal(keepLocalRow.created_by_device_id, 'dev_alpha_01');
    assert.equal(keepLocalRow.updated_by_device_id, 'dev_beta_02');

    // ACCEPT_REMOTE resolution
    const acceptRemoteRow = txnObjectToDBRow(remoteWinning);
    assert.equal(acceptRemoteRow.created_by_device_id, 'dev_alpha_01');
    assert.equal(acceptRemoteRow.updated_by_device_id, 'dev_gamma_03');
  });

  // ── 10. Snapshot restore preserves audit metadata ──────────────────────────
  await t.test('10. Snapshot restore preserves audit metadata', async () => {
    const snapshotEntities = {
      transactions: [
        {
          id: 'snap_tx_1',
          date: '2026-11-01',
          amount: '100',
          inr: 100,
          type: 'Expense',
          created_by_device_id: 'dev_alpha_01',
          updated_by_device_id: 'dev_beta_02'
        },
        {
          id: 'snap_tx_legacy',
          date: '2026-11-01',
          amount: '50',
          inr: 50,
          type: 'Expense',
          created_by_device_id: null,
          updated_by_device_id: null
        }
      ],
      investment_transactions: [
        {
          id: 'snap_inv_1',
          date: '2026-11-01',
          amount: '500',
          inr: 500,
          type: 'Expense',
          created_by_device_id: 'dev_gamma_03',
          updated_by_device_id: 'dev_gamma_03'
        }
      ]
    };

    await populateLocalEntitiesBootstrap(db, snapshotEntities, { allowRecoveryReplacement: true });

    const tx1Res = await db.query('SELECT created_by_device_id, updated_by_device_id FROM transactions WHERE id = ?', ['snap_tx_1']);
    assert.equal(tx1Res.values[0].created_by_device_id, 'dev_alpha_01');
    assert.equal(tx1Res.values[0].updated_by_device_id, 'dev_beta_02');

    const txLegRes = await db.query('SELECT created_by_device_id, updated_by_device_id FROM transactions WHERE id = ?', ['snap_tx_legacy']);
    assert.equal(txLegRes.values[0].created_by_device_id, null);
    assert.equal(txLegRes.values[0].updated_by_device_id, null);

    const inv1Res = await db.query('SELECT created_by_device_id, updated_by_device_id FROM investment_transactions WHERE id = ?', ['snap_inv_1']);
    assert.equal(inv1Res.values[0].created_by_device_id, 'dev_gamma_03');
    assert.equal(inv1Res.values[0].updated_by_device_id, 'dev_gamma_03');
  });

  // ── 11. Imports and bulk operations assign appropriate provenance ──────────
  await t.test('11. Imports and bulk operations assign appropriate provenance', async () => {
    setCachedLocalDeviceId('dev_import_device');

    // Case A: Import rows without pre-existing provenance
    const importRows = [
      {
        Date: '03/11/2026',
        Amount: 750,
        Account: 'Cash',
        Category: 'Shopping',
        'Income/Expense': 'Expense'
      }
    ];

    const result = await bulkImport(importRows);
    assert.equal(result.imported, 1);

    const importedTxnRes = await db.query('SELECT created_by_device_id, updated_by_device_id FROM transactions LIMIT 1');
    assert.equal(importedTxnRes.values[0].created_by_device_id, 'dev_import_device');
    assert.equal(importedTxnRes.values[0].updated_by_device_id, 'dev_import_device');

    // Case B: Installment conversion preserves creator and updates modifier
    const originalTxn = await addTransaction({
      date: '2026-11-03',
      amount: '3000',
      note: 'Laptop purchase'
    });

    setCachedLocalDeviceId('dev_instalment_device');
    const schedule = [
      { part: 1, total: 3, amount: 1000, date: '2026-11-03' },
      { part: 2, total: 3, amount: 1000, date: '2026-12-03' },
      { part: 3, total: 3, amount: 1000, date: '2027-01-03' }
    ];

    const convRes = await convertTransactionToInstalment({
      transactionId: originalTxn.id,
      updatedTransactionData: originalTxn,
      instalmentRule: { base_note: 'Laptop instalment' },
      schedule
    });

    // Part 1 preserves original creator ('dev_import_device') and updates modifier ('dev_instalment_device')
    assert.equal(convRes.updatedTransaction.created_by_device_id, 'dev_import_device');
    assert.equal(convRes.updatedTransaction.updated_by_device_id, 'dev_instalment_device');

    // Sibling parts (Parts 2..3) get local device as creator & modifier
    for (const sib of convRes.siblingTransactions) {
      assert.equal(sib.created_by_device_id, 'dev_instalment_device');
      assert.equal(sib.updated_by_device_id, 'dev_instalment_device');
    }
  });

  // ── 12. Both ordinary and investment transactions render the fields correctly
  await t.test('12. Both ordinary and investment transactions render the fields correctly', async () => {
    registerDeviceAuditName('dev_laptop_1', 'MacBook Pro');
    registerDeviceAuditName('dev_phone_2', 'Pixel Phone');

    const regularTxn = {
      id: 'reg_1',
      created_by_device_id: 'dev_laptop_1',
      updated_by_device_id: 'dev_phone_2'
    };
    const regMapped = rowToTxn(regularTxn);
    const regCreated = resolveDeviceAuditInfo(regMapped.created_by_device_id);
    const regUpdated = resolveDeviceAuditInfo(regMapped.updated_by_device_id);

    assert.equal(regCreated.deviceName, 'MacBook Pro');
    assert.equal(regCreated.deviceId, 'dev_laptop_1');
    assert.equal(regUpdated.deviceName, 'Pixel Phone');
    assert.equal(regUpdated.deviceId, 'dev_phone_2');

    const invTxn = {
      id: 'inv_1',
      investment_transaction_type: 'BUY',
      brokerage: 'Zerodha',
      created_by_device_id: 'dev_phone_2',
      updated_by_device_id: 'dev_phone_2'
    };
    const invMapped = rowToTxn(invTxn);
    const invCreated = resolveDeviceAuditInfo(invMapped.created_by_device_id);
    const invUpdated = resolveDeviceAuditInfo(invMapped.updated_by_device_id);

    assert.equal(invCreated.deviceName, 'Pixel Phone');
    assert.equal(invCreated.deviceId, 'dev_phone_2');
    assert.equal(invUpdated.deviceName, 'Pixel Phone');
    assert.equal(invUpdated.deviceId, 'dev_phone_2');
  });

  // ── 13. Old records without the new fields continue to work ───────────────
  await t.test('13. Old records without the new fields continue to work', async () => {
    // Insert old record missing the audit columns
    await db.run('INSERT INTO transactions (id, date, amount, inr, type) VALUES (?, ?, ?, ?, ?)', [
      'tx_legacy_pre_upgrade', '2026-01-01', '100', 100, 'Expense'
    ]);

    // Editing it on Device Delta sets modifier and leaves creator null
    setCachedLocalDeviceId('dev_delta_04');
    const updated = await updateTransaction('tx_legacy_pre_upgrade', {
      amount: '120',
      note: 'Upgraded note'
    });

    assert.equal(updated.created_by_device_id, null, 'Creator remains null for legacy transaction');
    assert.equal(updated.updated_by_device_id, 'dev_delta_04', 'Modifier is set to current device');

    assert.equal(resolveDeviceAuditInfo(updated.created_by_device_id).isLegacy, true);
    assert.equal(resolveDeviceAuditInfo(updated.updated_by_device_id).deviceId, 'dev_delta_04');
  });

  // ── 14. Device removal does not destroy historical device identity ────────
  await t.test('14. Device removal does not destroy historical device identity', async () => {
    setCachedLocalDeviceId('dev_alpha_01');
    registerDeviceAuditName('dev_retired_09', 'Old Office PC');

    const infoBefore = resolveDeviceAuditInfo('dev_retired_09');
    assert.equal(infoBefore.deviceId, 'dev_retired_09');
    assert.equal(infoBefore.deviceName, 'Old Office PC');

    // Simulate device removal from active registry
    clearDeviceAuditRegistry();

    // The historical transaction still holds 'dev_retired_09'
    const infoAfter = resolveDeviceAuditInfo('dev_retired_09');
    assert.equal(infoAfter.deviceId, 'dev_retired_09', 'Historical device ID must be preserved');
    assert.equal(infoAfter.deviceName, null, 'Device name falls back to null');
    assert.equal(infoAfter.isLegacy, false, 'Historical ID is preserved, not marked legacy');
  });
});

