/**
 * fail_closed_restore_safeguard.test.js
 *
 * Comprehensive Automated Test Suite for Fail-Closed Restore Safeguards:
 * 1. Populated Database Rejection (Transactions present)
 * 2. Investment-Only Data Rejection (0 regular txns, populated investment_transactions)
 * 3. Accounts Without Transactions Rejection (Custom user accounts configured)
 * 4. Pending Sync Queue Rejection (0 txns, but pending mutation queue entries)
 * 5. Query Failure Resilience (Fail-Closed: DB errors strictly suppress restore)
 * 6. Genuinely Empty New Devices (Pure empty DB and default-seed-only DB allowed)
 * 7. Ancillary Financial Store Protection (Inventory, budgets, recurring rules, plans, tombstones)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, closeDB, getDB, getRawIDB } from '../database/db.js';
import { DEFAULT_ACCOUNTS } from '../database/defaults.js';
import {
  isDatabaseBootstrapEmpty,
  assertDatabaseBootstrapEmpty,
  isDatabasePopulatedWithUserData,
  populateLocalEntitiesBootstrap,
  SNAPSHOT_FILENAME
} from '../services/cloudSyncEngine.js';
import {
  bootstrapNewDevice,
  DEVICE_LIFECYCLE,
  getDeviceLifecycleState
} from '../services/deltaSyncCoordinator.js';
import { encryptBackupData } from '../utils/cryptoBackup.js';

// Synthetic cloud snapshot fixture for test bootstrap attempts
const TEST_PIN = '1234';
const SYNTHETIC_CLOUD_SNAPSHOT = {
  snapshot_id: 'snap_synthetic_cloud_test_001',
  cloud_version: 1,
  schema_version: 13,
  created_at: new Date().toISOString(),
  device_id: 'dev_cloud_master',
  covered_peer_watermarks: {},
  entities: {
    transactions: [
      { id: 'tx_cloud_1', date: '2026-10-18', time: '10:00', inr: 500, amount: 500, type: 'Expense', account: 'Cash' }
    ],
    investment_transactions: [],
    accounts: [{ id: 'acc_cloud_1', name: 'Cloud Bank', group_name: 'Bank Accounts' }],
    categories: [{ id: 'cat_cloud_1', name: 'Food', type: 'Expense' }]
  }
};

// In-Memory Mock Drive Storage
class MockDriveTransport {
  constructor() {
    this.files = new Map();
  }
  async findFiles({ name }) {
    const f = this.files.get(name);
    return f ? [f] : [];
  }
  async findAppDataFile(name) {
    return this.files.get(name) || null;
  }
  async readAppDataFile(fileId) {
    for (const f of this.files.values()) {
      if (f.id === fileId) return f.content;
    }
    throw new Error('File not found in mock drive');
  }
  async uploadAppDataFile(name, content) {
    const f = { id: `id_${name}`, name, content };
    this.files.set(name, f);
    return f;
  }
}

test('FAIL-CLOSED RESTORE SAFEGUARD TEST SUITE', async (t) => {
  let mockDrive;
  let encryptedSnapshot;

  t.before(async () => {
    encryptedSnapshot = await encryptBackupData(SYNTHETIC_CLOUD_SNAPSHOT, TEST_PIN);
  });

  t.beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await initDB();
    mockDrive = new MockDriveTransport();
    await mockDrive.uploadAppDataFile(SNAPSHOT_FILENAME, encryptedSnapshot);
  });

  t.afterEach(async () => {
    try {
      await closeDB();
    } catch {}
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Populated Database (Transactions present)
  // ─────────────────────────────────────────────────────────────
  await t.test('1. Populated database with regular transactions strictly rejects restore', async () => {
    const db = getDB();
    await db.run(
      'INSERT INTO transactions (id, date, inr, amount, type, description) VALUES (?, ?, ?, ?, ?, ?)',
      ['tx_user_1', '2026-10-18', 100, 100, 'Expense', 'User Expense 1']
    );
    await db.run(
      'INSERT INTO transactions (id, date, inr, amount, type, description) VALUES (?, ?, ?, ?, ?, ?)',
      ['tx_user_2', '2026-10-18', 250, 250, 'Expense', 'User Expense 2']
    );

    // Assert assertDatabaseBootstrapEmpty throws BOOTSTRAP_SAFEGUARD_REJECTED
    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED:.*2 transactions/
    );

    // Assert isDatabasePopulatedWithUserData returns true
    const isPopulated = await isDatabasePopulatedWithUserData(db);
    assert.strictEqual(isPopulated, true, 'Populated DB must return true');

    // Assert in-memory entity checker returns false
    assert.strictEqual(
      isDatabaseBootstrapEmpty({ transactions: [{ id: 'tx_user_1' }] }),
      false,
      'isDatabaseBootstrapEmpty must return false when transactions present'
    );

    // Assert bootstrapNewDevice aborts with BOOTSTRAP_SAFEGUARD_REJECTED
    await assert.rejects(
      async () => await bootstrapNewDevice({
        deviceId: 'dev_populated_1',
        driveClient: mockDrive,
        pin: TEST_PIN,
        db
      }),
      /BOOTSTRAP_SAFEGUARD_REJECTED/
    );

    // Assert populateLocalEntitiesBootstrap aborts without allowRecoveryReplacement
    await assert.rejects(
      async () => await populateLocalEntitiesBootstrap(db, SYNTHETIC_CLOUD_SNAPSHOT.entities),
      /BOOTSTRAP_SAFEGUARD_REJECTED/
    );

    // Verify existing transactions remain 100% untouched
    const txnsAfter = (await db.query('SELECT * FROM transactions')).values || [];
    assert.strictEqual(txnsAfter.length, 2, 'Local transactions must remain intact');
    assert.strictEqual(txnsAfter[0].id, 'tx_user_1');
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Investment-Only Data (0 regular txns, populated investment_transactions)
  // ─────────────────────────────────────────────────────────────
  await t.test('2. Investment-only dataset strictly rejects restore without wiping trades', async () => {
    const db = getDB();
    await db.run(
      'INSERT INTO investment_transactions (id, date, inr, amount, type, security_symbol, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['inv_tx_1', '2026-10-18', 5000, 5000, 'BUY', 'TCS', 2]
    );

    // Assert assertion catches investment transactions even with 0 regular transactions
    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED:.*1 investment transactions/
    );

    const isPopulated = await isDatabasePopulatedWithUserData(db);
    assert.strictEqual(isPopulated, true);

    assert.strictEqual(
      isDatabaseBootstrapEmpty({ transactions: [], investment_transactions: [{ id: 'inv_1' }] }),
      false
    );

    // Assert bootstrap is rejected
    await assert.rejects(
      async () => await bootstrapNewDevice({
        deviceId: 'dev_invest_only',
        driveClient: mockDrive,
        pin: TEST_PIN,
        db
      }),
      /BOOTSTRAP_SAFEGUARD_REJECTED/
    );

    const invAfter = (await db.query('SELECT * FROM investment_transactions')).values || [];
    assert.strictEqual(invAfter.length, 1);
    assert.strictEqual(invAfter[0].security_symbol, 'TCS');
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Accounts Without Transactions (Custom user accounts configured)
  // ─────────────────────────────────────────────────────────────
  await t.test('3. Custom user accounts without transactions strictly reject restore', async () => {
    const db = getDB();
    // User configured a custom bank account but hasn't entered transactions yet
    await db.run(
      'INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)',
      ['acc_custom_wealth', 'Private Wealth Management', 'Bank Accounts']
    );

    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED:.*user accounts/
    );

    const isPopulated = await isDatabasePopulatedWithUserData(db);
    assert.strictEqual(isPopulated, true);

    assert.strictEqual(
      isDatabaseBootstrapEmpty({ accounts: [{ id: 'acc_1', name: 'Private Wealth Management' }] }),
      false
    );

    await assert.rejects(
      async () => await bootstrapNewDevice({
        deviceId: 'dev_accts_only',
        driveClient: mockDrive,
        pin: TEST_PIN,
        db
      }),
      /BOOTSTRAP_SAFEGUARD_REJECTED/
    );

    const acctsAfter = (await db.query('SELECT * FROM accounts')).values || [];
    assert.strictEqual(acctsAfter.length, 1);
    assert.strictEqual(acctsAfter[0].name, 'Private Wealth Management');
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Pending Sync Queue Entries (e.g. 5 changes waiting on Android)
  // ─────────────────────────────────────────────────────────────
  await t.test('4. Pending sync delta queue records strictly reject restore', async () => {
    const db = getDB();
    // 0 transactions, but uncommitted delta mutations in queue
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, entity_type, entity_id, operation, created_at) VALUES (?, ?, ?, ?, ?)',
      ['ev_queue_1', 'settings', 'google_client_id', 'UPSERT', new Date().toISOString()]
    );
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, entity_type, entity_id, operation, created_at) VALUES (?, ?, ?, ?, ?)',
      ['ev_queue_2', 'settings', 'sync_session', 'UPSERT', new Date().toISOString()]
    );

    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED:.*2 pending sync queue entries/
    );

    const isPopulated = await isDatabasePopulatedWithUserData(db);
    assert.strictEqual(isPopulated, true);

    assert.strictEqual(
      isDatabaseBootstrapEmpty({ sync_delta_queue: [{ event_id: 'ev_1' }] }),
      false
    );

    await assert.rejects(
      async () => await bootstrapNewDevice({
        deviceId: 'dev_queue_only',
        driveClient: mockDrive,
        pin: TEST_PIN,
        db
      }),
      /BOOTSTRAP_SAFEGUARD_REJECTED/
    );

    const queueAfter = (await db.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.strictEqual(queueAfter.length, 2);
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Query Failure Resilience (Fail-Closed Guarantees)
  // ─────────────────────────────────────────────────────────────
  await t.test('5. Database query failures strictly fail closed and suppress restore', async () => {
    // Mock a broken DB where queries fail due to lock or disk error
    const brokenDb = {
      query: async () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      run: async () => {
        throw new Error('SQLITE_BUSY: database is locked');
      }
    };

    // assertDatabaseBootstrapEmpty must throw BOOTSTRAP_SAFEGUARD_FAILED
    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(brokenDb),
      /BOOTSTRAP_SAFEGUARD_FAILED:.*SQLITE_BUSY/
    );

    // isDatabasePopulatedWithUserData must return TRUE (failing closed)
    const isPopulated = await isDatabasePopulatedWithUserData(brokenDb);
    assert.strictEqual(isPopulated, true, 'Fail-closed: query failure must be treated as populated');

    // Missing or invalid entities object in isDatabaseBootstrapEmpty must return false (fail closed)
    assert.strictEqual(isDatabaseBootstrapEmpty(null), false, 'Null entities must fail closed');
    assert.strictEqual(isDatabaseBootstrapEmpty(undefined), false, 'Undefined entities must fail closed');
    assert.strictEqual(isDatabaseBootstrapEmpty('corrupt_string'), false, 'Non-object entities must fail closed');

    // bootstrapNewDevice with broken DB must reject before attempting anything
    await assert.rejects(
      async () => await bootstrapNewDevice({
        deviceId: 'dev_broken_db',
        driveClient: mockDrive,
        pin: TEST_PIN,
        db: brokenDb
      }),
      /BOOTSTRAP_SAFEGUARD_FAILED/
    );
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Genuinely Empty New Devices
  // ─────────────────────────────────────────────────────────────
  await t.test('6A. Genuinely empty fresh device (0 records across all stores) passes safeguard', async () => {
    const db = getDB();

    // Emptiness assertion passes without throwing
    const passed = await assertDatabaseBootstrapEmpty(db);
    assert.strictEqual(passed, true);

    const isPopulated = await isDatabasePopulatedWithUserData(db);
    assert.strictEqual(isPopulated, false, 'Fresh clean DB must return false for isPopulated');

    assert.strictEqual(isDatabaseBootstrapEmpty({}), true, 'Empty entities object returns true');

    // Controlled bootstrap succeeds on clean device
    const res = await bootstrapNewDevice({
      deviceId: 'dev_clean_new',
      driveClient: mockDrive,
      pin: TEST_PIN,
      db
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'BOOTSTRAP_SUCCESS');

    // Post-bootstrap verify cloud records were installed
    const txns = (await db.query('SELECT * FROM transactions')).values || [];
    assert.strictEqual(txns.length, 1);
    assert.strictEqual(txns[0].id, 'tx_cloud_1');
  });

  await t.test('6B. Fresh device with standard default seed accounts passes safeguard', async () => {
    const db = getDB();
    // Insert exact standard 12 default seed accounts (as AppContext does on fresh install)
    for (const a of DEFAULT_ACCOUNTS) {
      await db.run(
        'INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)',
        [`seed_${a.name.toLowerCase().replace(/\s+/g, '_')}`, a.name, a.group]
      );
    }

    // Must be recognized as clean default seed (not custom user data)
    const passed = await assertDatabaseBootstrapEmpty(db);
    assert.strictEqual(passed, true);

    const isPopulated = await isDatabasePopulatedWithUserData(db);
    assert.strictEqual(isPopulated, false, 'Default-seed-only device must be eligible for restore');

    const res = await bootstrapNewDevice({
      deviceId: 'dev_default_seed_device',
      driveClient: mockDrive,
      pin: TEST_PIN,
      db
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'BOOTSTRAP_SUCCESS');
  });

  // ─────────────────────────────────────────────────────────────
  // 7. Ancillary Financial Store Protection (Inventory, budgets, rules, plans, tombstones)
  // ─────────────────────────────────────────────────────────────
  await t.test('7. Ancillary financial stores without transactions strictly reject restore', async () => {
    const db = getDB();

    // 7.1 Inventory
    await db.run('INSERT INTO inventory (id, name, qty, price) VALUES (?, ?, ?, ?)', ['inv_1', 'Gold Bar', 1, 60000]);
    await assert.rejects(async () => await assertDatabaseBootstrapEmpty(db), /1 inventory items/);
    await db.run('DELETE FROM inventory');

    // 7.2 Recurring Rules
    await db.run('INSERT INTO recurring_rules (id, name, frequency) VALUES (?, ?, ?)', ['rule_1', 'Monthly Rent', 'monthly']);
    await assert.rejects(async () => await assertDatabaseBootstrapEmpty(db), /1 recurring rules/);
    await db.run('DELETE FROM recurring_rules');

    // 7.3 Budgets
    await db.run('INSERT INTO budgets (id, category, amount) VALUES (?, ?, ?)', ['bud_1', 'Food', 15000]);
    await assert.rejects(async () => await assertDatabaseBootstrapEmpty(db), /1 budgets/);
    await db.run('DELETE FROM budgets');

    // 7.4 Investment Plans
    await db.run('INSERT INTO investment_plans (id, name, target_amount) VALUES (?, ?, ?)', ['plan_1', 'Retirement', 1000000]);
    await assert.rejects(async () => await assertDatabaseBootstrapEmpty(db), /1 investment plans/);
    await db.run('DELETE FROM investment_plans');

    // 7.5 Sync Tombstones
    await db.run('INSERT INTO sync_tombstones (id, entity_type, entity_id, deleted_at) VALUES (?, ?, ?, ?)', ['tomb_1', 'transaction', 'tx_old', new Date().toISOString()]);
    await assert.rejects(async () => await assertDatabaseBootstrapEmpty(db), /1 sync tombstones/);
    await db.run('DELETE FROM sync_tombstones');

    // Now clean again
    const finalCheck = await assertDatabaseBootstrapEmpty(db);
    assert.strictEqual(finalCheck, true);
  });
});
