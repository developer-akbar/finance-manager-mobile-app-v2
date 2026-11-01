/**
 * bootstrap_eligibility_safeguard.test.js
 *
 * Dedicated Automated Test Suite for Bootstrap Eligibility & Safeguards:
 * Case A: Fresh browser (Empty financial records, default seed accounts/categories, clean sync state -> Eligible for restore prompt)
 * Case B: Existing Office Laptop (Real transactions / investment transactions present -> Must suppress restore prompt)
 * Case C: Browser with pending changes (Local delta queue has unsynced operations -> Must suppress restore prompt)
 * Case D: Browser with stale tombstones / staged events / conflicts (Incomplete sync / offline changes -> Must suppress restore prompt)
 * Case E: Unverifiable database (Database query throws error / table missing -> Must fail closed and suppress restore prompt)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { v4 as uuid } from 'uuid';

import { initDB, closeDB, getDB } from '../database/db.js';
import { DEFAULT_ACCOUNT_GROUPS, DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES } from '../database/defaults.js';
import { replaceAccounts, replaceAccountGroups } from '../database/accounts.js';
import { replaceCategories } from '../database/categories.js';
import { setSetting } from '../database/settings.js';
import {
  checkDatabaseBootstrapEligibility,
  assertDatabaseBootstrapEmpty,
  isDatabasePopulatedWithUserData,
  isDatabaseBootstrapEmpty
} from '../services/cloudSyncEngine.js';

test('SAFE BOOTSTRAP ELIGIBILITY & SAFEGUARD TEST SUITE', async (t) => {
  t.beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await initDB();
  });

  t.afterEach(async () => {
    try {
      await closeDB();
    } catch {}
  });

  // ─────────────────────────────────────────────────────────────
  // CASE A: Fresh browser
  // Empty financial records, default seed accounts/categories, clean sync state
  // Safe for restore prompt
  // ─────────────────────────────────────────────────────────────
  await t.test('Case A: Fresh browser with default seed accounts/categories is eligible for restore prompt', async () => {
    const db = getDB();

    // 1. Simulate standard fresh app startup: seed default groups, accounts, categories, and settings
    await replaceAccountGroups(DEFAULT_ACCOUNT_GROUPS, { suppressDeltaQueue: true });
    await replaceAccounts(DEFAULT_ACCOUNTS.map((a, i) => ({ id: uuid(), ...a, sortOrder: i })), { suppressDeltaQueue: true });
    await replaceCategories(DEFAULT_CATEGORIES.map((c, i) => ({
      id: uuid(),
      name: c.name,
      type: c.type,
      sortOrder: i,
      subcategories: c.subcategories.map((s, si) => ({ id: uuid(), name: s, sortOrder: si }))
    })), { suppressDeltaQueue: true });
    await setSetting('sub_accounts_migrated_v2', 'true');

    // 2. Audit bootstrap eligibility
    const eligibility = await checkDatabaseBootstrapEligibility(db);

    assert.strictEqual(eligibility.isEligible, true, 'Fresh browser must be eligible for cloud restore');
    assert.strictEqual(eligibility.isPopulated, false, 'Fresh browser must not be classified as populated');
    assert.strictEqual(eligibility.reasons.length, 0, 'Fresh browser must have zero suppression reasons');
    assert.strictEqual(eligibility.details.transactions, 0, 'Transactions count must be 0');
    assert.strictEqual(eligibility.details.investment_transactions, 0, 'Investment transactions count must be 0');
    assert.strictEqual(eligibility.details.sync_delta_queue, 0, 'Queue count must be 0');
    assert.strictEqual(eligibility.details.sync_tombstones, 0, 'Tombstones count must be 0');
    assert.strictEqual(eligibility.details.sync_staged_events, 0, 'Staged events count must be 0');
    assert.strictEqual(eligibility.details.sync_conflicts, 0, 'Conflicts count must be 0');

    // 3. Fail-closed helper and assertion must both succeed without throwing
    const isPopulated = await isDatabasePopulatedWithUserData(db);
    assert.strictEqual(isPopulated, false, 'isDatabasePopulatedWithUserData must return false for fresh browser');

    const assertResult = await assertDatabaseBootstrapEmpty(db);
    assert.strictEqual(assertResult, true, 'assertDatabaseBootstrapEmpty must pass for fresh browser');
  });

  await t.test('Case A2: Fresh browser with 107 default seed metadata tombstones is eligible for restore prompt', async () => {
    const db = getDB();

    // 1. Seed standard defaults
    for (const a of DEFAULT_ACCOUNTS) {
      await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', [a.name, a.name, a.group || '']);
    }
    for (const c of DEFAULT_CATEGORIES) {
      await db.run('INSERT INTO categories (id, name, type) VALUES (?, ?, ?)', [c.name, c.name, c.type || 'Expense']);
    }

    // 2. Insert 107 metadata seed tombstones (18 account/sub_account, 89 category/subcategory)
    for (let i = 0; i < 18; i++) {
      await db.run('INSERT INTO sync_tombstones (id, entity_type, deleted_at) VALUES (?, ?, ?)', [`tomb_seed_acct_${i}`, 'account', new Date().toISOString()]);
    }
    for (let i = 0; i < 89; i++) {
      await db.run('INSERT INTO sync_tombstones (id, entity_type, deleted_at) VALUES (?, ?, ?)', [`tomb_seed_cat_${i}`, 'category', new Date().toISOString()]);
    }

    // 3. Audit bootstrap eligibility
    const eligibility = await checkDatabaseBootstrapEligibility(db);

    assert.strictEqual(eligibility.isEligible, true, 'Fresh browser with 107 seed tombstones must remain eligible');
    assert.strictEqual(eligibility.isPopulated, false, 'Must not be classified as populated');
    assert.strictEqual(eligibility.reasons.length, 0, 'Must have zero suppression reasons');
    assert.strictEqual(eligibility.details.sync_tombstones, 107, 'Tombstones count must be exactly 107');
    assert.strictEqual(eligibility.details.transactions, 0);
    assert.strictEqual(eligibility.details.investment_transactions, 0);

    const isPopulated = await isDatabasePopulatedWithUserData(db);
    assert.strictEqual(isPopulated, false);

    const assertResult = await assertDatabaseBootstrapEmpty(db);
    assert.strictEqual(assertResult, true);
  });

  // ─────────────────────────────────────────────────────────────
  // CASE B: Existing Office Laptop
  // Real transactions / investment transactions present
  // Must suppress restore prompt
  // ─────────────────────────────────────────────────────────────
  await t.test('Case B: Existing Office Laptop with real transactions strictly suppresses restore prompt', async () => {
    const db = getDB();

    // 1. Seed seed accounts plus real financial records
    await replaceAccountGroups(DEFAULT_ACCOUNT_GROUPS, { suppressDeltaQueue: true });
    await replaceAccounts(DEFAULT_ACCOUNTS.map((a, i) => ({ id: uuid(), ...a, sortOrder: i })), { suppressDeltaQueue: true });

    await db.run(
      'INSERT INTO transactions (id, date, time, inr, amount, type, account, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['tx_office_laptop_1', '2026-10-31', '12:00', 54931, 54931, 'Income', 'Share Market', 'Investment Returns']
    );

    // 2. Audit bootstrap eligibility
    const eligibility = await checkDatabaseBootstrapEligibility(db);

    assert.strictEqual(eligibility.isEligible, false, 'Populated Office Laptop must NOT be eligible for restore');
    assert.strictEqual(eligibility.isPopulated, true, 'Populated Office Laptop must be marked populated');
    assert.ok(
      eligibility.reasons.some(r => r.includes('1 transactions')),
      `Expected reason mentioning transactions, got: ${eligibility.reasons.join(', ')}`
    );
    assert.ok(eligibility.summary.includes('transactions'), `Summary must mention transactions: ${eligibility.summary}`);

    // 3. Verify fail-closed functions
    const isPopulated = await isDatabasePopulatedWithUserData(db);
    assert.strictEqual(isPopulated, true, 'isDatabasePopulatedWithUserData must return true');

    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED.*1 transactions/
    );
  });

  await t.test('Case B2: Device with investment transactions strictly suppresses restore prompt', async () => {
    const db = getDB();

    await db.run(
      'INSERT INTO investment_transactions (id, date, symbol, type, qty, price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['inv_tx_1', '2026-10-31', 'TCS', 'BUY', 10, 3500, 35000]
    );

    const eligibility = await checkDatabaseBootstrapEligibility(db);
    assert.strictEqual(eligibility.isEligible, false);
    assert.strictEqual(eligibility.isPopulated, true);
    assert.ok(eligibility.reasons.some(r => r.includes('1 investment transactions')));

    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED.*1 investment transactions/
    );
  });

  await t.test('Case B3: Device with custom user accounts strictly suppresses restore prompt', async () => {
    const db = getDB();

    // User added custom bank account 'Swiss Secret Account'
    await db.run('INSERT INTO accounts (id, name, group_name) VALUES (?, ?, ?)', ['acc_custom_1', 'Swiss Secret Account', 'Bank Accounts']);

    const eligibility = await checkDatabaseBootstrapEligibility(db);
    assert.strictEqual(eligibility.isEligible, false);
    assert.strictEqual(eligibility.isPopulated, true);
    assert.ok(eligibility.reasons.some(r => r.includes('custom user accounts')));

    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED.*custom user accounts/
    );
  });

  // ─────────────────────────────────────────────────────────────
  // CASE C: Browser with pending changes
  // Local delta queue has unsynced operations
  // Must suppress restore prompt
  // ─────────────────────────────────────────────────────────────
  await t.test('Case C: Browser with pending delta queue records strictly suppresses restore prompt', async () => {
    const db = getDB();

    // 0 transactions, but 2 unpushed delta mutations in queue
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, sequence, store_name, entity_id, operation, status) VALUES (?, ?, ?, ?, ?, ?)',
      ['evt_pending_1', 1, 'accounts', 'acc_1', 'UPDATE', 'PENDING']
    );
    await db.run(
      'INSERT INTO sync_delta_queue (event_id, sequence, store_name, entity_id, operation, status) VALUES (?, ?, ?, ?, ?, ?)',
      ['evt_pending_2', 2, 'accounts', 'acc_2', 'UPDATE', 'PENDING']
    );

    const eligibility = await checkDatabaseBootstrapEligibility(db);
    assert.strictEqual(eligibility.isEligible, false, 'Pending delta operations must disqualify restore prompt');
    assert.strictEqual(eligibility.isPopulated, true);
    assert.ok(
      eligibility.reasons.some(r => r.includes('2 pending sync queue entries')),
      `Expected reason mentioning pending queue entries, got: ${eligibility.reasons.join(', ')}`
    );

    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED.*2 pending sync queue entries/
    );
  });

  // ─────────────────────────────────────────────────────────────
  // CASE D: Browser with stale tombstones / staged events / conflicts
  // Incomplete sync / offline changes
  // Must suppress restore prompt
  // ─────────────────────────────────────────────────────────────
  await t.test('Case D1: Browser with sync tombstones strictly suppresses restore prompt', async () => {
    const db = getDB();

    await db.run(
      'INSERT INTO sync_tombstones (id, entity_type, entity_id, deleted_at) VALUES (?, ?, ?, ?)',
      ['tomb_stale_1', 'transaction', 'tx_stale_1', new Date().toISOString()]
    );

    const eligibility = await checkDatabaseBootstrapEligibility(db);
    assert.strictEqual(eligibility.isEligible, false);
    assert.strictEqual(eligibility.isPopulated, true);
    assert.ok(eligibility.reasons.some(r => r.includes('1 sync tombstones')));

    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED.*1 sync tombstones/
    );
  });

  await t.test('Case D2: Browser with unprocessed staged events strictly suppresses restore prompt', async () => {
    const db = getDB();

    await db.run(
      'INSERT INTO sync_staged_events (event_id, package_id, peer_device_id, sequence, operation) VALUES (?, ?, ?, ?, ?)',
      ['stg_evt_1', 'pkg_1', 'dev_peer_1', 10, 'INSERT']
    );

    const eligibility = await checkDatabaseBootstrapEligibility(db);
    assert.strictEqual(eligibility.isEligible, false);
    assert.strictEqual(eligibility.isPopulated, true);
    assert.ok(
      eligibility.reasons.some(r => r.includes('1 unprocessed staged sync events')),
      `Expected reason mentioning staged events, got: ${eligibility.reasons.join(', ')}`
    );

    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED.*1 unprocessed staged sync events/
    );
  });

  await t.test('Case D3: Browser with unresolved sync conflicts strictly suppresses restore prompt', async () => {
    const db = getDB();

    await db.run(
      'INSERT INTO sync_conflicts (conflict_id, store_name, entity_id, conflict_type, status) VALUES (?, ?, ?, ?, ?)',
      ['conf_1', 'transactions', 'tx_conf_1', 'UPDATE_UPDATE', 'UNRESOLVED']
    );

    const eligibility = await checkDatabaseBootstrapEligibility(db);
    assert.strictEqual(eligibility.isEligible, false);
    assert.strictEqual(eligibility.isPopulated, true);
    assert.ok(
      eligibility.reasons.some(r => r.includes('1 unresolved sync conflicts')),
      `Expected reason mentioning conflicts, got: ${eligibility.reasons.join(', ')}`
    );

    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED.*1 unresolved sync conflicts/
    );
  });

  await t.test('Case D4: Device with established snapshot baseline in sync_local_state suppresses restore prompt', async () => {
    const db = getDB();

    await db.run(
      'INSERT OR REPLACE INTO sync_local_state (key, device_id, base_snapshot_id, lifecycle_state) VALUES (?, ?, ?, ?)',
      ['device_state', 'dev_existing_web', 'snap_1793462321951_40e186ea', 'ACTIVE']
    );

    const eligibility = await checkDatabaseBootstrapEligibility(db);
    assert.strictEqual(eligibility.isEligible, false);
    assert.strictEqual(eligibility.isPopulated, true);
    assert.ok(
      eligibility.reasons.some(r => r.includes('established snapshot baseline')),
      `Expected baseline suppression, got: ${eligibility.reasons.join(', ')}`
    );

    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(db),
      /BOOTSTRAP_SAFEGUARD_REJECTED.*established snapshot baseline/
    );
  });

  // ─────────────────────────────────────────────────────────────
  // CASE E: Unverifiable database
  // Database query throws error / table missing
  // Must fail closed and suppress restore prompt
  // ─────────────────────────────────────────────────────────────
  await t.test('Case E1: Database query failure strictly fails closed and suppresses restore prompt', async () => {
    const brokenDb = {
      query: async () => {
        throw new Error('Simulated IO error: IndexedDB connection unexpectedly terminated');
      }
    };

    const eligibility = await checkDatabaseBootstrapEligibility(brokenDb);
    assert.strictEqual(eligibility.isEligible, false, 'Unverifiable DB must fail closed');
    assert.strictEqual(eligibility.isPopulated, true, 'Unverifiable DB must be classified as populated');
    assert.ok(eligibility.error.includes('Simulated IO error'));
    assert.ok(
      eligibility.reasons.some(r => r.includes('Database query failed')),
      `Expected query failure reason, got: ${eligibility.reasons.join(', ')}`
    );
    assert.ok(eligibility.summary.includes('Emptiness query failed'));

    // isDatabasePopulatedWithUserData must return true (failing closed)
    const isPopulated = await isDatabasePopulatedWithUserData(brokenDb);
    assert.strictEqual(isPopulated, true);

    // assertDatabaseBootstrapEmpty must throw BOOTSTRAP_SAFEGUARD_FAILED
    await assert.rejects(
      async () => await assertDatabaseBootstrapEmpty(brokenDb),
      /BOOTSTRAP_SAFEGUARD_FAILED.*Database emptiness query failed/
    );
  });

  await t.test('Case E2: Unavailable database handle strictly fails closed and suppresses restore prompt', async () => {
    // Pass explicit null where initDB is also mocked to fail
    const eligibility = await checkDatabaseBootstrapEligibility({ query: null });
    // In this case broken query function will throw
    assert.strictEqual(eligibility.isEligible, false);
    assert.strictEqual(eligibility.isPopulated, true);
  });
});

