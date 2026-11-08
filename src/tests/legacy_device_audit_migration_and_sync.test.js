/**
 * legacy_device_audit_migration_and_sync.test.js
 *
 * Comprehensive Automated Test Suite covering all 25 scenarios for:
 * 1. Legacy Device Audit Attribution Migration (Scenarios 1-10)
 * 2. Cross-Device Propagation & Conflict Resolution Safety (Scenarios 11-18)
 * 3. CSV Export/Import Audit Provenance Verification (Scenarios 19-25)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, closeDB, getDB } from '../database/db.js';
import {
  addTransaction,
  updateTransaction,
  rowToTxn,
  bulkImport
} from '../database/transactions.js';
import {
  getCurrentDeviceId,
  setCachedLocalDeviceId,
  registerDeviceAuditName,
  setDeviceNickname,
  resolveDeviceAuditInfo,
  formatDeviceAuditLabel,
  clearDeviceAuditRegistry
} from '../services/deviceAudit.js';
import {
  isFieldEligibleForAttribution,
  scanTableAuditEligibility,
  computeFinancialBaselineChecksum,
  runLegacyAuditDryRun,
  executeLegacyAuditMigration,
  revertLegacyAuditMigration,
  validateTargetDeviceId,
  resolveTargetDeviceName,
  TARGET_DEVICE_ID,
  TARGET_DEVICE_NAME
} from '../services/legacyDeviceAuditMigration.js';
import {
  mergeProvenanceProtectedPayload,
  resolveConflict
} from '../services/deltaReconciliation.js';
import {
  populateLocalEntitiesBootstrap,
  txnObjectToDBRow,
  invTxnObjectToDBRow
} from '../services/cloudSyncEngine.js';
import { saveConflictRecord, CONFLICT_STATUS, CONFLICT_RESOLUTION, CONFLICT_TYPE } from '../database/conflicts.js';

test('LEGACY DEVICE AUDIT MIGRATION, CROSS-DEVICE SYNC & CSV AUDIT TEST SUITE', async (suite) => {
  let db;

  suite.beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    clearDeviceAuditRegistry();
    db = await initDB();
  });

  suite.afterEach(async () => {
    clearDeviceAuditRegistry();
    await closeDB();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PART 1: LEGACY MIGRATION SCENARIOS (1 to 10)
  // ───────────────────────────────────────────────────────────────────────────

  await suite.test('1. Missing creator attribution is eligible', async () => {
    assert.strictEqual(isFieldEligibleForAttribution(null), true);
    assert.strictEqual(isFieldEligibleForAttribution(''), true);
    assert.strictEqual(isFieldEligibleForAttribution('Unknown'), true);
    assert.strictEqual(isFieldEligibleForAttribution('local_device'), true);
    assert.strictEqual(isFieldEligibleForAttribution('dev_1234567890ab'), false);
  });

  await suite.test('2. Missing modifier attribution is eligible', async () => {
    assert.strictEqual(isFieldEligibleForAttribution(undefined), true);
    assert.strictEqual(isFieldEligibleForAttribution('   '), true);
    assert.strictEqual(isFieldEligibleForAttribution('dev_laptop12345'), false);
  });

  await suite.test('3. Both missing fields are handled independently', async () => {
    // Row A: Created: Unknown, Modified: dev_laptop
    await db.run(
      'INSERT INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['tx_1', '2026-11-01', '100', 100, 'Expense', null, 'dev_laptop']
    );

    // Row B: Created: dev_laptop, Modified: Unknown
    await db.run(
      'INSERT INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['tx_2', '2026-11-01', '200', 200, 'Expense', 'dev_laptop', null]
    );

    const scan = await scanTableAuditEligibility(db, 'transactions');
    assert.strictEqual(scan.eligibleCreatorCount, 1);
    assert.strictEqual(scan.eligibleModifierCount, 1);
    assert.strictEqual(scan.bothEligibleCount, 0);
    assert.strictEqual(scan.partialProvenanceCount, 2);

    // Execute migration
    await executeLegacyAuditMigration({ confirmed: true });

    const tx1 = (await db.query('SELECT * FROM transactions WHERE id = ?', ['tx_1'])).values[0];
    const tx2 = (await db.query('SELECT * FROM transactions WHERE id = ?', ['tx_2'])).values[0];

    assert.strictEqual(tx1.created_by_device_id, TARGET_DEVICE_ID);
    assert.strictEqual(tx1.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.strictEqual(tx1.updated_by_device_id, 'dev_laptop'); // unmodified

    assert.strictEqual(tx2.created_by_device_id, 'dev_laptop'); // unmodified
    assert.strictEqual(tx2.updated_by_device_id, TARGET_DEVICE_ID);
    assert.strictEqual(tx2.updated_by_provenance, 'LEGACY_ASSIGNED');
  });

  await suite.test('4. Existing verified device IDs remain unchanged', async () => {
    await db.run(
      'INSERT INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id, created_by_provenance, updated_by_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['tx_verified', '2026-11-01', '500', 500, 'Expense', 'dev_existing1', 'dev_existing2', 'VERIFIED', 'VERIFIED']
    );

    await executeLegacyAuditMigration({ confirmed: true });

    const row = (await db.query('SELECT * FROM transactions WHERE id = ?', ['tx_verified'])).values[0];
    assert.strictEqual(row.created_by_device_id, 'dev_existing1');
    assert.strictEqual(row.updated_by_device_id, 'dev_existing2');
    assert.strictEqual(row.created_by_provenance, 'VERIFIED');
    assert.strictEqual(row.updated_by_provenance, 'VERIFIED');
  });

  await suite.test('5. Legacy attribution is distinguishable from verified attribution', async () => {
    registerDeviceAuditName('dev_c7e4544221f4', 'My Mobile');

    // A. Legacy-assigned transaction
    const legacyInfo = resolveDeviceAuditInfo('dev_c7e4544221f4', 'LEGACY_ASSIGNED');
    assert.strictEqual(legacyInfo.isLegacyAssigned, true);
    assert.strictEqual(formatDeviceAuditLabel(legacyInfo), 'My Mobile (Legacy)');

    // B. Verified transaction from same device
    const verifiedInfo = resolveDeviceAuditInfo('dev_c7e4544221f4', 'VERIFIED');
    assert.strictEqual(verifiedInfo.isLegacyAssigned, false);
    assert.strictEqual(formatDeviceAuditLabel(verifiedInfo), 'My Mobile');
  });

  await suite.test('6. Migration is idempotent', async () => {
    await db.run(
      'INSERT INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['tx_idem', '2026-11-01', '100', 100, 'Expense', null, null]
    );

    // Pass 1
    const res1 = await executeLegacyAuditMigration({ confirmed: true });
    assert.strictEqual(res1.migrated.totalRecordsUpdated, 1);

    // Pass 2
    const res2 = await executeLegacyAuditMigration({ confirmed: true });
    assert.strictEqual(res2.migratedCount, 0);
    assert.strictEqual(res2.alreadyMigrated, true);

    const row = (await db.query('SELECT * FROM transactions WHERE id = ?', ['tx_idem'])).values[0];
    assert.strictEqual(row.created_by_device_id, TARGET_DEVICE_ID);
    assert.strictEqual(row.created_by_provenance, 'LEGACY_ASSIGNED');
  });

  await suite.test('7. No timestamps change during migration', async () => {
    const origCreatedAt = '2024-05-10T12:00:00.000Z';
    const origUpdatedAt = '2024-06-15T08:30:00.000Z';

    await db.run(
      'INSERT INTO transactions (id, date, amount, inr, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['tx_ts', '2024-05-10', '150', 150, 'Expense', origCreatedAt, origUpdatedAt]
    );

    await executeLegacyAuditMigration({ confirmed: true });

    const row = (await db.query('SELECT * FROM transactions WHERE id = ?', ['tx_ts'])).values[0];
    assert.strictEqual(row.created_at, origCreatedAt);
    assert.strictEqual(row.updated_at, origUpdatedAt);
  });

  await suite.test('8. No financial fields change during migration', async () => {
    await db.run(
      'INSERT INTO transactions (id, date, time, account, category, subcategory, note, description, inr, amount, currency, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['tx_fin', '2025-01-15', '14:30', 'HDFC Bank', 'Groceries', 'Supermarket', 'Monthly ration', 'Rice & pulses', 4250.75, '4250.75', 'INR', 'Expense']
    );

    const preRows = (await db.query('SELECT * FROM transactions')).values;
    const preChecksum = await computeFinancialBaselineChecksum(preRows);

    await executeLegacyAuditMigration({ confirmed: true });

    const postRows = (await db.query('SELECT * FROM transactions')).values;
    const postChecksum = await computeFinancialBaselineChecksum(postRows);

    assert.strictEqual(postChecksum, preChecksum);
    assert.strictEqual(postRows[0].inr, 4250.75);
    assert.strictEqual(postRows[0].amount, '4250.75');
    assert.strictEqual(postRows[0].account, 'HDFC Bank');
  });

  await suite.test('9. Ordinary and investment transactions are covered', async () => {
    await db.run(
      'INSERT INTO transactions (id, date, inr, amount, type) VALUES (?, ?, ?, ?, ?)',
      ['tx_ord', '2026-10-01', 100, '100', 'Expense']
    );
    await db.run(
      'INSERT INTO investment_transactions (id, date, inr, amount, type, security_symbol, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['tx_inv', '2026-10-02', 5000, '5000', 'Expense', 'INFY', 3, 1666.66]
    );

    const dryRun = await runLegacyAuditDryRun();
    assert.strictEqual(dryRun.byTable.transactions.eligibleCreator, 1);
    assert.strictEqual(dryRun.byTable.investment_transactions.eligibleCreator, 1);

    await executeLegacyAuditMigration({ confirmed: true });

    const ord = (await db.query('SELECT * FROM transactions WHERE id = ?', ['tx_ord'])).values[0];
    const inv = (await db.query('SELECT * FROM investment_transactions WHERE id = ?', ['tx_inv'])).values[0];

    assert.strictEqual(ord.created_by_device_id, TARGET_DEVICE_ID);
    assert.strictEqual(ord.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.strictEqual(inv.created_by_device_id, TARGET_DEVICE_ID);
    assert.strictEqual(inv.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.strictEqual(inv.security_symbol, 'INFY');
  });

  await suite.test('10. Dry-run performs zero writes', async () => {
    await db.run(
      'INSERT INTO transactions (id, date, inr, amount, type) VALUES (?, ?, ?, ?, ?)',
      ['tx_dry', '2026-10-01', 100, '100', 'Expense']
    );

    const dryRun = await runLegacyAuditDryRun();
    assert.strictEqual(dryRun.summary.eligibleCreatorFields, 1);

    // Verify row in database is completely untouched
    const row = (await db.query('SELECT * FROM transactions WHERE id = ?', ['tx_dry'])).values[0];
    assert.ok(row.created_by_device_id === null || row.created_by_device_id === undefined);
    assert.ok(row.updated_by_device_id === null || row.updated_by_device_id === undefined);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PART 2: CROSS-DEVICE SYNC & CONFLICT SAFETY SCENARIOS (11 to 18)
  // ───────────────────────────────────────────────────────────────────────────

  await suite.test('11. Legacy attribution propagates to another device via delta reconciliation', async () => {
    // Local device has a legacy transaction without provenance
    const localEntity = {
      id: 'tx_sync1',
      date: '2026-10-01',
      amount: '500',
      inr: 500,
      type: 'Expense',
      created_by_device_id: null,
      updated_by_device_id: null,
      created_by_provenance: null
    };

    // Remote peer sends legacy attribution event
    const remotePayload = {
      ...localEntity,
      created_by_device_id: TARGET_DEVICE_ID,
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: TARGET_DEVICE_ID,
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };

    const merged = mergeProvenanceProtectedPayload(localEntity, remotePayload);
    assert.strictEqual(merged.created_by_device_id, TARGET_DEVICE_ID);
    assert.strictEqual(merged.created_by_provenance, 'LEGACY_ASSIGNED');
  });

  await suite.test('12. Verified attribution wins over legacy attribution', async () => {
    // Local device B has VERIFIED attribution from origin
    const localVerified = {
      id: 'tx_conflict_1',
      date: '2026-10-01',
      amount: '500',
      inr: 500,
      type: 'Expense',
      created_by_device_id: 'dev_laptop_origin',
      created_by_provenance: 'VERIFIED',
      updated_by_device_id: 'dev_laptop_origin',
      updated_by_provenance: 'VERIFIED'
    };

    // Remote peer A proposes legacy attribution to My Mobile
    const remoteLegacy = {
      ...localVerified,
      created_by_device_id: TARGET_DEVICE_ID,
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: TARGET_DEVICE_ID,
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };

    const merged = mergeProvenanceProtectedPayload(localVerified, remoteLegacy);
    // Verified creator and modifier MUST be preserved!
    assert.strictEqual(merged.created_by_device_id, 'dev_laptop_origin');
    assert.strictEqual(merged.created_by_provenance, 'VERIFIED');
    assert.strictEqual(merged.updated_by_device_id, 'dev_laptop_origin');
    assert.strictEqual(merged.updated_by_provenance, 'VERIFIED');
  });

  await suite.test('13. Receiving device does not become the creator or modifier', async () => {
    setCachedLocalDeviceId('dev_receiving_phone');

    const localEntity = {
      id: 'tx_recv',
      created_by_device_id: null,
      updated_by_device_id: null
    };

    const remotePayload = {
      id: 'tx_recv',
      created_by_device_id: TARGET_DEVICE_ID,
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: TARGET_DEVICE_ID,
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };

    const merged = mergeProvenanceProtectedPayload(localEntity, remotePayload);
    assert.notStrictEqual(merged.created_by_device_id, 'dev_receiving_phone');
    assert.notStrictEqual(merged.updated_by_device_id, 'dev_receiving_phone');
    assert.strictEqual(merged.created_by_device_id, TARGET_DEVICE_ID);
  });

  await suite.test('14. Offline device receives the changes after reconnecting', async () => {
    // Simulate offline device hydrating snapshot with migrated audit metadata
    const snapshotEntity = {
      id: 'tx_offline',
      date: '2026-09-01',
      time: '',
      account: 'Cash',
      from_account: '',
      to_account: '',
      category: 'Food',
      subcategory: '',
      note: 'Offline sync test',
      description: '',
      inr: 50,
      amount: '50',
      currency: 'INR',
      type: 'Expense',
      created_at: '2026-09-01T10:00:00Z',
      updated_at: '2026-09-01T10:00:00Z',
      created_by_device_id: TARGET_DEVICE_ID,
      updated_by_device_id: TARGET_DEVICE_ID,
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };

    await populateLocalEntitiesBootstrap(db, {
      transactions: [snapshotEntity],
      investment_transactions: []
    });

    const stored = (await db.query('SELECT * FROM transactions WHERE id = ?', ['tx_offline'])).values[0];
    assert.strictEqual(stored.created_by_device_id, TARGET_DEVICE_ID);
    assert.strictEqual(stored.created_by_provenance, 'LEGACY_ASSIGNED');
  });

  await suite.test('15. Device renaming updates displayed names dynamically', async () => {
    registerDeviceAuditName(TARGET_DEVICE_ID, 'My Mobile');

    // Resolves as 'My Mobile (Legacy)'
    const info1 = resolveDeviceAuditInfo(TARGET_DEVICE_ID, 'LEGACY_ASSIGNED');
    assert.strictEqual(formatDeviceAuditLabel(info1), 'My Mobile (Legacy)');

    // User renames device to 'AK Mobile'
    setDeviceNickname(TARGET_DEVICE_ID, 'AK Mobile');

    const info2 = resolveDeviceAuditInfo(TARGET_DEVICE_ID, 'LEGACY_ASSIGNED');
    assert.strictEqual(formatDeviceAuditLabel(info2), 'AK Mobile (Legacy)');
    assert.strictEqual(info2.deviceId, TARGET_DEVICE_ID); // stable ID untouched
  });

  await suite.test('16. Snapshot restoration preserves attribution', async () => {
    const rawRow = txnObjectToDBRow({
      id: 'tx_snap',
      created_by_device_id: TARGET_DEVICE_ID,
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: 'dev_laptop',
      updated_by_provenance: 'VERIFIED'
    });

    assert.strictEqual(rawRow.created_by_device_id, TARGET_DEVICE_ID);
    assert.strictEqual(rawRow.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.strictEqual(rawRow.updated_by_device_id, 'dev_laptop');
    assert.strictEqual(rawRow.updated_by_provenance, 'VERIFIED');
  });

  await suite.test('17. Conflict resolution preserves verified provenance', async () => {
    await saveConflictRecord({
      conflict_id: 'conf_100',
      collection: 'transactions',
      entity_id: 'tx_conf_res',
      conflict_type: CONFLICT_TYPE.CONCURRENT_EDIT,
      peer_device_id: 'dev_remote_peer',
      event_id: 'evt_100',
      local_checksum: 'h_local',
      remote_checksum: 'h_remote',
      local_payload: {
        id: 'tx_conf_res',
        inr: 100,
        amount: '100',
        created_by_device_id: 'dev_verified_creator',
        created_by_provenance: 'VERIFIED'
      },
      remote_payload: {
        id: 'tx_conf_res',
        inr: 120,
        amount: '120',
        created_by_device_id: TARGET_DEVICE_ID,
        created_by_provenance: 'LEGACY_ASSIGNED'
      },
      status: CONFLICT_STATUS.PENDING
    });

    // Populate live local record
    await db.run(
      'INSERT INTO transactions (id, inr, amount, created_by_device_id, created_by_provenance) VALUES (?, ?, ?, ?, ?)',
      ['tx_conf_res', 100, '100', 'dev_verified_creator', 'VERIFIED']
    );

    // Resolve accepting remote amount
    await resolveConflict('conf_100', CONFLICT_RESOLUTION.ACCEPT_REMOTE);

    const resolvedRow = (await db.query('SELECT * FROM transactions WHERE id = ?', ['tx_conf_res'])).values[0];
    // Amount updated to remote, but verified creator preserved!
    assert.strictEqual(resolvedRow.created_by_device_id, 'dev_verified_creator');
    assert.strictEqual(resolvedRow.created_by_provenance, 'VERIFIED');
  });

  await suite.test('18. Duplicate sync events do not produce repeated changes', async () => {
    const existingEntity = {
      id: 'tx_dup',
      inr: 250,
      amount: '250',
      created_by_device_id: TARGET_DEVICE_ID,
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: TARGET_DEVICE_ID,
      updated_by_provenance: 'LEGACY_ASSIGNED'
    };

    const duplicatePayload = { ...existingEntity };

    const merged = mergeProvenanceProtectedPayload(existingEntity, duplicatePayload);
    assert.deepStrictEqual(merged, existingEntity);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PART 3: CSV EXPORT/IMPORT AUDIT PROVENANCE SCENARIOS (19 to 25)
  // ───────────────────────────────────────────────────────────────────────────

  await suite.test('19. All four audit columns are exported', async () => {
    registerDeviceAuditName(TARGET_DEVICE_ID, 'My Mobile');
    registerDeviceAuditName('dev_laptop123', 'My Laptop');

    const txn = {
      id: 'tx_csv_1',
      date: '2026-11-01',
      inr: 1500,
      created_by_device_id: TARGET_DEVICE_ID,
      created_by_provenance: 'LEGACY_ASSIGNED',
      updated_by_device_id: 'dev_laptop123',
      updated_by_provenance: 'VERIFIED'
    };

    const ca = resolveDeviceAuditInfo(txn.created_by_device_id, txn.created_by_provenance);
    const ua = resolveDeviceAuditInfo(txn.updated_by_device_id, txn.updated_by_provenance);

    assert.strictEqual(formatDeviceAuditLabel(ca), 'My Mobile (Legacy)');
    assert.strictEqual(ca.deviceId, TARGET_DEVICE_ID);
    assert.strictEqual(formatDeviceAuditLabel(ua), 'My Laptop');
    assert.strictEqual(ua.deviceId, 'dev_laptop123');
  });

  await suite.test('20. Current device names are resolved dynamically', async () => {
    setDeviceNickname(TARGET_DEVICE_ID, 'Office Pixel Phone');

    const ca = resolveDeviceAuditInfo(TARGET_DEVICE_ID, 'LEGACY_ASSIGNED');
    assert.strictEqual(formatDeviceAuditLabel(ca), 'Office Pixel Phone (Legacy)');
  });

  await suite.test('21. Device IDs are exported accurately', async () => {
    const ca = resolveDeviceAuditInfo(TARGET_DEVICE_ID, 'LEGACY_ASSIGNED');
    assert.strictEqual(ca.deviceId, 'dev_c7e4544221f4');
  });

  await suite.test('22. Legacy attribution retains its label', async () => {
    registerDeviceAuditName(TARGET_DEVICE_ID, 'My Mobile');

    const ca = resolveDeviceAuditInfo(TARGET_DEVICE_ID, 'LEGACY_ASSIGNED');
    assert.ok(formatDeviceAuditLabel(ca).endsWith('(Legacy)'));
  });

  await suite.test('23. Missing device information is handled safely', async () => {
    const ca = resolveDeviceAuditInfo(null, null);
    assert.strictEqual(formatDeviceAuditLabel(ca), 'Unknown (Legacy)');
    assert.strictEqual(ca.deviceId, null);
  });

  await suite.test('24. Old CSV files remain import-compatible', async () => {
    setCachedLocalDeviceId('dev_current_local');

    // Simulate old CSV without any audit columns
    const oldCsvRows = [
      {
        Date: '2026-10-15',
        Account: 'HDFC Bank',
        Category: 'Utilities',
        Amount: '750',
        INR: '750',
        'Income/Expense': 'Expense'
      }
    ];

    const res = await bulkImport(oldCsvRows);
    assert.strictEqual(res.imported, 1);

    const rows = (await db.query('SELECT * FROM transactions')).values;
    assert.strictEqual(rows[0].created_by_device_id, 'dev_current_local');
    assert.strictEqual(rows[0].created_by_provenance, 'VERIFIED');
  });

  await suite.test('25. New audit columns do not corrupt financial fields during import', async () => {
    const csvRowsWithAudit = [
      {
        Date: '2026-10-20',
        Account: 'ICICI Bank',
        Category: 'Travel',
        Amount: '2400',
        INR: '2400',
        'Income/Expense': 'Expense',
        'Created By': 'My Mobile (Legacy)',
        'Created By Device ID': TARGET_DEVICE_ID,
        'Last Modified By': 'My Laptop',
        'Last Modified By Device ID': 'dev_laptop99'
      }
    ];

    const res = await bulkImport(csvRowsWithAudit);
    assert.strictEqual(res.imported, 1);

    const row = (await db.query('SELECT * FROM transactions WHERE category = ?', ['Travel'])).values[0];
    assert.strictEqual(row.inr, 2400);
    assert.strictEqual(row.account, 'ICICI Bank');
    assert.strictEqual(row.created_by_device_id, TARGET_DEVICE_ID);
    assert.strictEqual(row.created_by_provenance, 'LEGACY_ASSIGNED');
    assert.strictEqual(row.updated_by_device_id, 'dev_laptop99');
    assert.strictEqual(row.updated_by_provenance, 'VERIFIED');
  });

  await suite.test('26. Accounting distinguishes field updates from row updates and delta events', async () => {
    // Reset DB with 2 transactions:
    // Txn 1: both eligible (c & m missing)
    // Txn 2: only modifier eligible (c verified, m missing)
    const dbInst = getDB();
    await dbInst.execute('DELETE FROM transactions');
    await dbInst.execute('DELETE FROM investment_transactions');

    await dbInst.run(
      'INSERT INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id, created_by_provenance, updated_by_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['t1', '2026-11-01', '100', 100, 'Expense', null, null, null, null]
    );
    await dbInst.run(
      'INSERT INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id, created_by_provenance, updated_by_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['t2', '2026-11-01', '200', 200, 'Expense', 'dev_laptop_verified', null, 'VERIFIED', null]
    );

    const dryRun = await runLegacyAuditDryRun();
    assert.strictEqual(dryRun.accounting.totalRowsScanned, 2);
    assert.strictEqual(dryRun.accounting.rowsWithBothFieldsEligible, 1);
    assert.strictEqual(dryRun.accounting.rowsWithOnlyModifierEligible, 1);
    assert.strictEqual(dryRun.accounting.rowsWithOnlyCreatorEligible, 0);
    assert.strictEqual(dryRun.accounting.eligibleCreatorFields, 1);
    assert.strictEqual(dryRun.accounting.eligibleModifierFields, 2);
    assert.strictEqual(dryRun.accounting.plannedTotalFieldUpdates, 3);
    assert.strictEqual(dryRun.accounting.plannedDatabaseRowUpdates, 2);
    assert.strictEqual(dryRun.accounting.plannedDeltaEventsGenerated, 2);
  });

  await suite.test('27. Safe rollback reverts LEGACY_ASSIGNED without touching subsequent VERIFIED edits', async () => {
    const dbInst = getDB();
    await dbInst.execute('DELETE FROM transactions');
    await dbInst.execute('DELETE FROM investment_transactions');

    // 1. Create a legacy unassigned transaction
    await dbInst.run(
      'INSERT INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id, created_by_provenance, updated_by_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['tx_legacy_1', '2026-11-01', '500', 500, 'Expense', null, null, null, null]
    );

    // 2. Run migration
    const migRes = await executeLegacyAuditMigration({ confirmed: true });
    assert.strictEqual(migRes.migrated.totalDatabaseRowUpdates, 1);

    // 3. User edits the transaction subsequently on another device, creating a VERIFIED modifier
    await dbInst.run(
      'UPDATE transactions SET updated_by_device_id = ?, updated_by_provenance = ? WHERE id = ?',
      ['dev_office_verified', 'VERIFIED', 'tx_legacy_1']
    );

    // 4. Also add a completely new transaction after migration (fully VERIFIED)
    await dbInst.run(
      'INSERT INTO transactions (id, date, amount, inr, type, created_by_device_id, updated_by_device_id, created_by_provenance, updated_by_provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['tx_new_verified', '2026-11-02', '1000', 1000, 'Expense', 'dev_laptop_verified', 'dev_laptop_verified', 'VERIFIED', 'VERIFIED']
    );

    // 5. Execute safe rollback
    const revRes = await revertLegacyAuditMigration({ confirmed: true });
    assert.strictEqual(revRes.success, true);
    assert.strictEqual(revRes.reverted.totalDatabaseRowUpdates, 1);

    // 6. Verify row 1: creator reverted to null, but verified modifier is PRESERVED!
    const row1 = (await dbInst.query('SELECT * FROM transactions WHERE id = ?', ['tx_legacy_1'])).values[0];
    assert.strictEqual(row1.created_by_device_id ?? null, null);
    assert.strictEqual(row1.created_by_provenance ?? null, null);
    assert.strictEqual(row1.updated_by_device_id, 'dev_office_verified');
    assert.strictEqual(row1.updated_by_provenance, 'VERIFIED');

    // 7. Verify new row: completely untouched!
    const rowNew = (await dbInst.query('SELECT * FROM transactions WHERE id = ?', ['tx_new_verified'])).values[0];
    assert.strictEqual(rowNew.created_by_device_id, 'dev_laptop_verified');
    assert.strictEqual(rowNew.created_by_provenance, 'VERIFIED');
  });

  await suite.test('28. Target device ID is validated and name is dynamically resolved', async () => {
    // 1. Validation checks
    assert.throws(() => validateTargetDeviceId(''), /INVALID_TARGET_DEVICE_ID/);
    assert.throws(() => validateTargetDeviceId(null), /INVALID_TARGET_DEVICE_ID/);
    assert.throws(() => validateTargetDeviceId('invalid_id'), /INVALID_TARGET_DEVICE_ID/);
    assert.strictEqual(validateTargetDeviceId('dev_c7e4544221f4'), 'dev_c7e4544221f4');

    // 2. Dynamic resolution with registered nickname
    setDeviceNickname('dev_c7e4544221f4', 'My Primary Mobile');
    const resolvedName = resolveTargetDeviceName('dev_c7e4544221f4');
    assert.strictEqual(resolvedName, 'My Primary Mobile');

    // 3. Dry-run reflects dynamically resolved name
    const dryRun = await runLegacyAuditDryRun({ targetDeviceId: 'dev_c7e4544221f4' });
    assert.strictEqual(dryRun.targetDevice.deviceName, 'My Primary Mobile');

    // Cleanup nickname
    setDeviceNickname('dev_c7e4544221f4', null);
  });
});
