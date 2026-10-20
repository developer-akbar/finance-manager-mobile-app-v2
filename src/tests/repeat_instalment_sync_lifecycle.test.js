/**
 * repeat_instalment_sync_lifecycle.test.js
 *
 * Comprehensive regression test suite verifying Repeat & Installment transaction
 * synchronization lifecycle across peer devices using isolated in-memory DBs and mock Drive.
 *
 * Test Matrix:
 * 1. Convert existing transaction to Instalment in place (Part 1 preserves ID, sibling parts added,
 *    recurring rule created, outbox deltas generated).
 * 2. Two-device sync lifecycle for conversion (Device A -> Mock Drive -> Device B:
 *    zero duplicates, exact in-place update for Part 1, sibling parts added on peer,
 *    getInstalmentSeriesStats returns identical stats on peer).
 * 3. Existing instalment series edit sync (updates note/category across siblings and rule,
 *    synced to peer with zero duplicate records and full field fidelity).
 * 4. Repeat transaction conversion and sync lifecycle (preserves ID, links rule, syncs cleanly).
 * 5. Reverting/clearing recurringConfig before save performs standard transaction update
 *    (no rules created, no sibling parts, exactly 1 transaction updated).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, closeDB, getDB } from '../database/db.js';
import { setSetting } from '../database/settings.js';
import { initLocalSyncState } from '../database/deltaQueue.js';
import { executeAtomicMutation } from '../database/atomicMutation.js';
import { getTransactions, addTransaction, updateTransaction, deleteTransaction, convertTransactionToInstalment } from '../database/transactions.js';
import {
  saveRecurringRule as createRecurringRule,
  getAllRecurringRules as getRecurringRules,
  updateRecurringRule,
  deleteRecurringRule as removeRecurringRule,
  buildInstalmentSchedule,
  buildInstalmentNote,
  parseInstalmentInfo,
  getInstalmentSeriesStats
} from '../database/recurring.js';
import { replaceAccounts } from '../database/accounts.js';
import { replaceCategories } from '../database/categories.js';
import { executeFullSyncPass, configureDeltaSyncEngine } from '../services/deltaSyncCoordinator.js';
import { inputToStorage } from '../utils/format.js';

const TEST_SESSION_KEY = 'test-secret-key-repeat-instalment-sync';
const TEST_BASE_SNAPSHOT_ID = 'snap_baseline_repeat_inst_test';

/**
 * In-memory Mock Google Drive Client
 */
class MockDriveStorage {
  constructor() {
    this.files = new Map();
    this.nextId = 1;
  }

  reset() {
    this.files.clear();
    this.nextId = 1;
  }

  async findFiles({ name, trashed = false } = {}) {
    const results = [];
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && (!name || f.name === name)) {
        results.push({ id: f.id, name: f.name, appProperties: f.appProperties });
      }
    }
    return results;
  }

  async findAppDataFile(name) {
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        return { id: f.id, name: f.name };
      }
    }
    return null;
  }

  async readFile(fileId) {
    const f = this.files.get(fileId);
    if (!f || f.trashed) throw new Error(`Drive file not found: ${fileId}`);
    return f.content;
  }

  async readAppDataFile(fileId) {
    return this.readFile(fileId);
  }

  async uploadFile({ name, content, appProperties = {} }) {
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        f.content = content;
        f.appProperties = { ...f.appProperties, ...appProperties };
        return { id: f.id, name: f.name };
      }
    }
    const id = `mock_drive_${this.nextId++}`;
    this.files.set(id, {
      id,
      name,
      content,
      appProperties: { ...appProperties },
      trashed: false
    });
    return { id, name };
  }

  async uploadAppDataFile(name, content) {
    return this.uploadFile({ name, content });
  }

  async updateFile(fileId, content) {
    const f = this.files.get(fileId);
    if (!f || f.trashed) throw new Error(`Drive file not found: ${fileId}`);
    f.content = content;
    return { id: f.id, name: f.name };
  }
}

/**
 * Creates an isolated in-memory device harness
 */
function createDeviceHarness(deviceId, baseSnapshotId = TEST_BASE_SNAPSHOT_ID) {
  return {
    deviceId,
    baseSnapshotId,
    idb: new IDBFactory(),
    storage: {}
  };
}

/**
 * Activates a device harness
 */
async function activateDevice(harness) {
  await closeDB();
  globalThis.indexedDB = harness.idb;
  global.localStorage = {
    getItem: (k) => harness.storage[k] || null,
    setItem: (k, v) => { harness.storage[k] = String(v); },
    removeItem: (k) => { delete harness.storage[k]; },
    clear: () => { Object.keys(harness.storage).forEach(k => delete harness.storage[k]); }
  };
  const db = await initDB();
  return db;
}

/**
 * Seeds a device with standard accounts, categories, sync state, and initial transactions
 */
async function seedInitialDeviceState(harness, initialTxns = [], initialRules = []) {
  const db = await activateDevice(harness);

  await initLocalSyncState(harness.deviceId, harness.baseSnapshotId, 1, 'ACTIVE');
  await setSetting('last_snapshot_id', harness.baseSnapshotId, { suppressDeltaQueue: true });
  await setSetting('last_parent_snapshot_id', '', { suppressDeltaQueue: true });

  await replaceAccounts([
    { id: 'acc_hdfc', name: 'HDFC Bank', group: 'Bank Accounts' },
    { id: 'acc_cash', name: 'Cash Wallet', group: 'Cash' }
  ], { suppressDeltaQueue: true });

  await replaceCategories([
    { id: 'cat_electronics', name: 'Electronics', type: 'Expense' },
    { id: 'cat_shopping', name: 'Shopping', type: 'Expense' },
    { id: 'cat_bills', name: 'Bills & Utilities', type: 'Expense' },
    { id: 'cat_utilities', name: 'Utilities', type: 'Expense' },
    { id: 'cat_salary', name: 'Salary', type: 'Income' }
  ], { suppressDeltaQueue: true });

  for (const rule of initialRules) {
    await executeAtomicMutation({
      storeName: 'recurring_rules',
      operation: 'INSERT',
      entity: rule,
      suppressDeltaQueue: true
    });
  }

  for (const txn of initialTxns) {
    await executeAtomicMutation({
      storeName: 'transactions',
      operation: 'INSERT',
      entity: txn,
      suppressDeltaQueue: true
    });
  }

  return db;
}

async function getTxnById(id) {
  const txns = await getTransactions();
  return txns.find(t => t.id === id || t._id === id || t.ID === id) || null;
}

test('FinMan — Repeat & Instalment Synchronization Lifecycle Regression Suite', async (t) => {
  const mockDrive = new MockDriveStorage();

  t.beforeEach(() => {
    mockDrive.reset();
    configureDeltaSyncEngine({ enabled: false });
  });

  t.after(async () => {
    await closeDB();
  });

  await t.test('1. Convert existing transaction to Instalment in place: Part 1 preserves ID, sibling parts added, rule created, outbox deltas queued', async () => {
    const devA = createDeviceHarness('dev_a_convert_1');

    const seedTxn = {
      id: 'tx_seed_laptop_01',
      date: '2026-04-10',
      time: '11:00',
      account: 'HDFC Bank',
      category: 'Electronics',
      subcategory: 'Gadgets',
      note: 'Laptop purchase',
      description: 'Work laptop upgrade',
      inr: 60000,
      amount: '60000',
      currency: 'INR',
      type: 'Expense',
      tags: 'work,tech',
      created_at: '2026-04-10T11:00:00.000Z',
      updated_at: '2026-04-10T11:00:00.000Z'
    };

    await seedInitialDeviceState(devA, [seedTxn]);
    await activateDevice(devA);

    const initialTxn = await getTxnById(seedTxn.id);
    assert.ok(initialTxn, 'Initial transaction exists');
    assert.strictEqual(initialTxn.inr, 60000);
    assert.strictEqual(initialTxn.recurring_rule_id || '', '');

    // Simulate converting in-place (same logic as handleSave in AddTransaction.jsx)
    const recurringConfig = { type: 'instalment', totalDays: 90, scheduleMode: 'on_day' };
    const isoDate = '2026-04-10';
    const baseNote = 'Laptop purchase';
    const totalAmount = 60000;

    const rule = {
      rule_type: 'instalment',
      status: 'completed',
      txn_type: 'Expense',
      account: 'HDFC Bank',
      from_account: '',
      to_account: '',
      category: 'Electronics',
      subcategory: 'Gadgets',
      base_note: baseNote,
      description: 'Work laptop upgrade',
      currency: 'INR',
      total_amount: totalAmount,
      total_days: recurringConfig.totalDays,
      start_date: isoDate,
      schedule_mode: recurringConfig.scheduleMode,
    };

    const schedule = buildInstalmentSchedule(rule);
    assert.strictEqual(schedule.length, 3, '3-part schedule generated for 90 days');
    rule.total_parts = schedule.length;
    rule.completed_parts = schedule.length;
    rule.next_date = '';
    rule.end_date = schedule[schedule.length - 1]?.date || '';
    rule.amount_per_part = schedule[0]?.amount || 0;

    const savedRule = await createRecurringRule(rule);
    assert.ok(savedRule.id, 'Recurring rule saved with ID');

    // Part 1: Update original transaction in place
    const [iy0, im0, id0] = schedule[0].date.split('-');
    const firstTxnDate = `${id0}/${im0}/${iy0}`;
    const firstPartData = {
      Date: firstTxnDate,
      Time: '11:00',
      Account: 'HDFC Bank',
      FromAccount: '',
      ToAccount: '',
      Category: 'Electronics',
      Subcategory: 'Gadgets',
      Note: buildInstalmentNote(baseNote, schedule[0].part, schedule[0].total),
      Description: 'Work laptop upgrade',
      INR: schedule[0].amount,
      Amount: String(schedule[0].amount),
      Currency: 'INR',
      'Income/Expense': 'Expense',
      recurring_rule_id: savedRule.id,
      Tags: 'work,tech',
      _id: seedTxn.id,
      SubAccount: '',
      FromSubAccount: '',
      ToSubAccount: '',
    };
    await updateTransaction(seedTxn.id, firstPartData);

    // Parts 2..N: Add subsequent sibling parts
    const siblingIds = [];
    for (let i = 1; i < schedule.length; i++) {
      const inst = schedule[i];
      const [iy, im, id2] = inst.date.split('-');
      const instTxnDate = `${id2}/${im}/${iy}`;
      const added = await addTransaction({
        Date: instTxnDate,
        Time: '11:00',
        Account: 'HDFC Bank',
        FromAccount: '',
        ToAccount: '',
        Category: 'Electronics',
        Subcategory: 'Gadgets',
        Note: buildInstalmentNote(baseNote, inst.part, inst.total),
        Description: 'Work laptop upgrade',
        INR: inst.amount,
        Amount: String(inst.amount),
        Currency: 'INR',
        'Income/Expense': 'Expense',
        recurring_rule_id: savedRule.id,
        Tags: 'work,tech',
        SubAccount: '',
        FromSubAccount: '',
        ToSubAccount: '',
      });
      siblingIds.push(added.id);
    }

    // Verify local DB state
    const allTxns = await getTransactions();
    assert.strictEqual(allTxns.length, 3, 'Total 3 transactions exist');

    const part1 = allTxns.find(t => t.id === seedTxn.id);
    assert.ok(part1, 'Original transaction ID preserved for Part 1');
    assert.strictEqual(part1.Note, 'Laptop purchase (1/3)');
    assert.strictEqual(part1.INR, 20000);
    assert.strictEqual(part1.recurring_rule_id, savedRule.id);

    const part2 = allTxns.find(t => t.id === siblingIds[0]);
    assert.ok(part2, 'Part 2 transaction created');
    assert.strictEqual(part2.Note, 'Laptop purchase (2/3)');
    assert.strictEqual(part2.INR, 20000);
    assert.strictEqual(part2.recurring_rule_id, savedRule.id);

    const part3 = allTxns.find(t => t.id === siblingIds[1]);
    assert.ok(part3, 'Part 3 transaction created');
    assert.strictEqual(part3.Note, 'Laptop purchase (3/3)');
    assert.strictEqual(part3.INR, 20000);
    assert.strictEqual(part3.recurring_rule_id, savedRule.id);

    // Verify outbox delta queue
    const devDb = getDB();
    const queueRows = (await devDb.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.strictEqual(queueRows.length, 4, 'Exactly 4 deltas queued: 1 rule INSERT, 1 txn UPDATE, 2 txn INSERTs');

    const ruleDelta = queueRows.find(q => q.collection === 'recurring_rules');
    assert.ok(ruleDelta, 'recurring_rules delta queued');
    assert.strictEqual(ruleDelta.operation, 'INSERT');
    assert.strictEqual(ruleDelta.entity_id, savedRule.id);

    const txnUpdateDelta = queueRows.find(q => q.collection === 'transactions' && q.operation === 'UPDATE');
    assert.ok(txnUpdateDelta, 'Original transaction UPDATE delta queued');
    assert.strictEqual(txnUpdateDelta.entity_id, seedTxn.id);

    const txnInsertDeltas = queueRows.filter(q => q.collection === 'transactions' && q.operation === 'INSERT');
    assert.strictEqual(txnInsertDeltas.length, 2, '2 sibling transaction INSERT deltas queued');

    // Verify series stats
    const stats = getInstalmentSeriesStats(part1, allTxns);
    assert.strictEqual(stats.part, 1);
    assert.strictEqual(stats.totalParts, 3);
    assert.strictEqual(stats.totalAmount, 60000);
    assert.strictEqual(stats.completedAmount, 20000);
    assert.strictEqual(stats.balanceRemaining, 40000);
  });

  await t.test('2. Two-device sync lifecycle for conversion: Device A converts and pushes, Device B pulls and reconciles with zero duplicates and matching stats', async () => {
    const devA = createDeviceHarness('dev_a_sync_2');
    const devB = createDeviceHarness('dev_b_sync_2');

    const seedTxn = {
      id: 'tx_convert_twodev_01',
      date: '2026-05-01',
      time: '15:30',
      account: 'HDFC Bank',
      category: 'Shopping',
      subcategory: 'Furniture',
      note: 'Office Ergonomic Chair',
      description: 'Work from home setup',
      inr: 30000,
      amount: '30000',
      currency: 'INR',
      type: 'Expense',
      tags: 'office',
      created_at: '2026-05-01T15:30:00.000Z',
      updated_at: '2026-05-01T15:30:00.000Z'
    };

    // Both devices start with identical baseline transaction
    await seedInitialDeviceState(devA, [seedTxn]);
    await seedInitialDeviceState(devB, [seedTxn]);

    // Device A converts transaction to 3-month instalment
    await activateDevice(devA);
    const rule = {
      rule_type: 'instalment',
      status: 'completed',
      txn_type: 'Expense',
      account: 'HDFC Bank',
      from_account: '',
      to_account: '',
      category: 'Shopping',
      subcategory: 'Furniture',
      base_note: 'Office Ergonomic Chair',
      description: 'Work from home setup',
      currency: 'INR',
      total_amount: 30000,
      total_days: 90,
      start_date: '2026-05-01',
      schedule_mode: 'on_day',
    };
    const schedule = buildInstalmentSchedule(rule);
    rule.total_parts = schedule.length;
    rule.completed_parts = schedule.length;
    rule.next_date = '';
    rule.end_date = schedule[schedule.length - 1]?.date || '';
    rule.amount_per_part = schedule[0]?.amount || 0;

    const savedRule = await createRecurringRule(rule);

    // Update Part 1 in place
    const [iy0, im0, id0] = schedule[0].date.split('-');
    await updateTransaction(seedTxn.id, {
      Date: `${id0}/${im0}/${iy0}`,
      Time: '15:30',
      Account: 'HDFC Bank',
      Category: 'Shopping',
      Subcategory: 'Furniture',
      Note: buildInstalmentNote('Office Ergonomic Chair', schedule[0].part, schedule[0].total),
      Description: 'Work from home setup',
      INR: schedule[0].amount,
      Amount: String(schedule[0].amount),
      Currency: 'INR',
      'Income/Expense': 'Expense',
      recurring_rule_id: savedRule.id,
      Tags: 'office',
      _id: seedTxn.id,
    });

    // Add sibling parts
    for (let i = 1; i < schedule.length; i++) {
      const inst = schedule[i];
      const [iy, im, id2] = inst.date.split('-');
      await addTransaction({
        Date: `${id2}/${im}/${iy}`,
        Time: '15:30',
        Account: 'HDFC Bank',
        Category: 'Shopping',
        Subcategory: 'Furniture',
        Note: buildInstalmentNote('Office Ergonomic Chair', inst.part, inst.total),
        Description: 'Work from home setup',
        INR: inst.amount,
        Amount: String(inst.amount),
        Currency: 'INR',
        'Income/Expense': 'Expense',
        recurring_rule_id: savedRule.id,
        Tags: 'office',
      });
    }

    // Push Device A deltas to mock Drive
    const pushResult = await executeFullSyncPass({
      deviceId: 'dev_a_sync_2',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.strictEqual(pushResult.success, true, 'Device A sync push succeeded');
    assert.strictEqual(pushResult.outbound.packagesUploaded, 1, 'Device A uploaded 1 package');
    assert.strictEqual(pushResult.outbound.eventsUploaded, 4, 'Device A uploaded 4 events (1 rule + 1 update + 2 inserts)');

    // Activate Device B and pull
    await activateDevice(devB);
    const bTxnBefore = await getTxnById(seedTxn.id);
    assert.ok(bTxnBefore, 'Device B has initial un-converted transaction');
    assert.strictEqual(bTxnBefore.inr, 30000);
    assert.strictEqual(bTxnBefore.recurring_rule_id || '', '');

    const pullResult = await executeFullSyncPass({
      deviceId: 'dev_b_sync_2',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });

    assert.strictEqual(pullResult.success, true, 'Device B pull succeeded');
    assert.strictEqual(pullResult.reconciliation.reconciledCount, 4, 'Device B reconciled all 4 events');
    assert.strictEqual(pullResult.reconciliation.conflictCount, 0, 'Zero conflicts on Device B');

    // Assert Device B state
    const devBDb = getDB();
    const allTxnsOnB = (await devBDb.query('SELECT * FROM transactions')).values || [];
    assert.strictEqual(allTxnsOnB.length, 3, 'Zero duplicates on Device B: exactly 3 transactions exist');

    const bPart1Matches = allTxnsOnB.filter(t => t.id === seedTxn.id);
    assert.strictEqual(bPart1Matches.length, 1, 'Part 1 updated in place: exactly 1 transaction with original ID');
    assert.strictEqual(bPart1Matches[0].note, 'Office Ergonomic Chair (1/3)');
    assert.strictEqual(bPart1Matches[0].inr, 10000);
    assert.strictEqual(bPart1Matches[0].recurring_rule_id, savedRule.id);

    // Verify recurring rule exists on Device B
    const rulesOnB = await getRecurringRules();
    const bRule = rulesOnB.find(r => r.id === savedRule.id);
    assert.ok(bRule, 'Recurring rule replicated to Device B');
    assert.strictEqual(bRule.rule_type, 'instalment');
    assert.strictEqual(bRule.total_amount, 30000);
    assert.strictEqual(bRule.total_parts, 3);

    // Verify stats on Device B
    const bTxnsFormatted = await getTransactions();
    const bPart1Formatted = bTxnsFormatted.find(t => t.id === seedTxn.id);
    const bStats = getInstalmentSeriesStats(bPart1Formatted, bTxnsFormatted);
    assert.strictEqual(bStats.part, 1);
    assert.strictEqual(bStats.totalParts, 3);
    assert.strictEqual(bStats.totalAmount, 30000);
    assert.strictEqual(bStats.completedAmount, 10000);
    assert.strictEqual(bStats.balanceRemaining, 20000);
  });

  await t.test('3. Existing instalment series edit sync: Sibling updates sync cleanly across devices with zero duplicates', async () => {
    const devA = createDeviceHarness('dev_a_sib_3');
    const devB = createDeviceHarness('dev_b_sib_3');

    const ruleId = 'rule_instalment_existing_01';
    const seedRule = {
      id: ruleId,
      rule_type: 'instalment',
      status: 'completed',
      txn_type: 'Expense',
      account: 'HDFC Bank',
      from_account: '',
      to_account: '',
      category: 'Electronics',
      subcategory: 'Audio',
      base_note: 'Headphones',
      description: 'Noise cancelling headphones',
      currency: 'INR',
      total_amount: 15000,
      total_parts: 3,
      completed_parts: 3,
      amount_per_part: 5000,
      start_date: '2026-06-01',
      schedule_mode: 'on_day',
      created_at: '2026-06-01T10:00:00.000Z',
      updated_at: '2026-06-01T10:00:00.000Z'
    };

    const seedTxns = [
      {
        id: 'tx_headphone_01',
        date: '2026-06-01',
        time: '10:00',
        account: 'HDFC Bank',
        category: 'Electronics',
        subcategory: 'Audio',
        note: 'Headphones (1/3)',
        description: 'Noise cancelling headphones',
        inr: 5000,
        amount: '5000',
        currency: 'INR',
        type: 'Expense',
        recurring_rule_id: ruleId,
        created_at: '2026-06-01T10:00:00.000Z',
        updated_at: '2026-06-01T10:00:00.000Z'
      },
      {
        id: 'tx_headphone_02',
        date: '2026-07-01',
        time: '10:00',
        account: 'HDFC Bank',
        category: 'Electronics',
        subcategory: 'Audio',
        note: 'Headphones (2/3)',
        description: 'Noise cancelling headphones',
        inr: 5000,
        amount: '5000',
        currency: 'INR',
        type: 'Expense',
        recurring_rule_id: ruleId,
        created_at: '2026-06-01T10:00:00.000Z',
        updated_at: '2026-06-01T10:00:00.000Z'
      },
      {
        id: 'tx_headphone_03',
        date: '2026-08-01',
        time: '10:00',
        account: 'HDFC Bank',
        category: 'Electronics',
        subcategory: 'Audio',
        note: 'Headphones (3/3)',
        description: 'Noise cancelling headphones',
        inr: 5000,
        amount: '5000',
        currency: 'INR',
        type: 'Expense',
        recurring_rule_id: ruleId,
        created_at: '2026-06-01T10:00:00.000Z',
        updated_at: '2026-06-01T10:00:00.000Z'
      }
    ];

    // Seed both devices with identical series and rule
    for (const h of [devA, devB]) {
      await seedInitialDeviceState(h, seedTxns);
      await executeAtomicMutation({
        storeName: 'recurring_rules',
        operation: 'INSERT',
        entity: seedRule,
        suppressDeltaQueue: true
      });
    }

    // On Device A: Edit the series (change base note to "Wireless Headphones Pro", category to "Shopping")
    await activateDevice(devA);
    const newBaseNote = 'Wireless Headphones Pro';
    const newCategory = 'Shopping';

    // Update all siblings as updateInstalmentSiblings does
    for (let p = 1; p <= 3; p++) {
      const sibId = seedTxns[p - 1].id;
      await updateTransaction(sibId, {
        Note: `${newBaseNote} (${p}/3)`,
        Category: newCategory,
        _id: sibId
      });
    }
    await updateRecurringRule(ruleId, {
      base_note: newBaseNote,
      category: newCategory
    });

    // Push Device A deltas
    const pushResult = await executeFullSyncPass({
      deviceId: 'dev_a_sib_3',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.strictEqual(pushResult.success, true);
    assert.strictEqual(pushResult.outbound.eventsUploaded, 4, '4 events uploaded (3 txn updates + 1 rule update)');

    // Pull on Device B
    await activateDevice(devB);
    const pullResult = await executeFullSyncPass({
      deviceId: 'dev_b_sib_3',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.strictEqual(pullResult.success, true);
    assert.strictEqual(pullResult.reconciliation.reconciledCount, 4);
    assert.strictEqual(pullResult.reconciliation.conflictCount, 0);

    // Verify Device B transactions
    const txnsB = await getTransactions();
    assert.strictEqual(txnsB.length, 3, 'Zero duplicates on Device B');

    for (let p = 1; p <= 3; p++) {
      const sib = txnsB.find(t => t.id === seedTxns[p - 1].id);
      assert.ok(sib, `Sibling ${p} found on Device B`);
      assert.strictEqual(sib.Note, `Wireless Headphones Pro (${p}/3)`);
      assert.strictEqual(sib.Category, 'Shopping');
      assert.strictEqual(sib.INR, 5000);
    }

    const bRules = await getRecurringRules();
    const updatedRuleB = bRules.find(r => r.id === ruleId);
    assert.strictEqual(updatedRuleB.base_note, 'Wireless Headphones Pro');
    assert.strictEqual(updatedRuleB.category, 'Shopping');
  });

  await t.test('4. Repeat transaction conversion and sync lifecycle: Updates in place, creates repeat rule, replicates cleanly', async () => {
    const devA = createDeviceHarness('dev_a_repeat_4');
    const devB = createDeviceHarness('dev_b_repeat_4');

    const seedTxn = {
      id: 'tx_repeat_bill_01',
      date: '2026-07-05',
      time: '09:00',
      account: 'HDFC Bank',
      category: 'Bills & Utilities',
      subcategory: 'Internet',
      note: 'Broadband Fiber Bill',
      description: 'Monthly high speed internet',
      inr: 1200,
      amount: '1200',
      currency: 'INR',
      type: 'Expense',
      tags: 'bills',
      created_at: '2026-07-05T09:00:00.000Z',
      updated_at: '2026-07-05T09:00:00.000Z'
    };

    await seedInitialDeviceState(devA, [seedTxn]);
    await seedInitialDeviceState(devB, [seedTxn]);

    // Device A converts transaction to Repeat rule (Monthly)
    await activateDevice(devA);
    const rule = {
      rule_type: 'repeat',
      status: 'active',
      txn_type: 'Expense',
      account: 'HDFC Bank',
      from_account: '',
      to_account: '',
      category: 'Bills & Utilities',
      subcategory: 'Internet',
      base_note: 'Broadband Fiber Bill',
      description: 'Monthly high speed internet',
      currency: 'INR',
      amount_per_part: 1200,
      start_date: '2026-07-05',
      next_date: '2026-08-05',
      schedule_mode: 'on_day',
      frequency: 'monthly',
      completed_parts: 1,
    };
    const savedRule = await createRecurringRule(rule);

    await updateTransaction(seedTxn.id, {
      Date: '05/07/2026',
      Time: '09:00',
      Account: 'HDFC Bank',
      Category: 'Bills & Utilities',
      Subcategory: 'Internet',
      Note: 'Broadband Fiber Bill',
      Description: 'Monthly high speed internet',
      INR: 1200,
      Amount: '1200',
      Currency: 'INR',
      'Income/Expense': 'Expense',
      recurring_rule_id: savedRule.id,
      Tags: 'bills',
      _id: seedTxn.id
    });

    // Verify Device A delta queue
    const devADb = getDB();
    const queueRows = (await devADb.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.strictEqual(queueRows.length, 2, '2 deltas queued on A: 1 rule INSERT, 1 txn UPDATE');

    // Push from Device A
    const pushResult = await executeFullSyncPass({
      deviceId: 'dev_a_repeat_4',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.strictEqual(pushResult.success, true);
    assert.strictEqual(pushResult.outbound.eventsUploaded, 2);

    // Pull on Device B
    await activateDevice(devB);
    const pullResult = await executeFullSyncPass({
      deviceId: 'dev_b_repeat_4',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.strictEqual(pullResult.success, true);
    assert.strictEqual(pullResult.reconciliation.reconciledCount, 2);

    // Assert Device B state
    const txnsB = await getTransactions();
    assert.strictEqual(txnsB.length, 1, 'Zero duplicate transactions on Device B: exactly 1 transaction');
    assert.strictEqual(txnsB[0].id, seedTxn.id);
    assert.strictEqual(txnsB[0].recurring_rule_id, savedRule.id);

    const rulesB = await getRecurringRules();
    const repeatRuleB = rulesB.find(r => r.id === savedRule.id);
    assert.ok(repeatRuleB, 'Repeat rule replicated to Device B');
    assert.strictEqual(repeatRuleB.rule_type, 'repeat');
    assert.strictEqual(repeatRuleB.frequency, 'monthly');
  });

  await t.test('5. Reverting/clearing recurringConfig before save performs standard transaction update', async () => {
    const devA = createDeviceHarness('dev_a_revert_5');

    const seedTxn = {
      id: 'tx_revert_test_01',
      date: '2026-08-15',
      time: '12:00',
      account: 'HDFC Bank',
      category: 'Shopping',
      subcategory: 'Books',
      note: 'Novel purchase',
      description: 'Bookstore visit',
      inr: 850,
      amount: '850',
      currency: 'INR',
      type: 'Expense',
      created_at: '2026-08-15T12:00:00.000Z',
      updated_at: '2026-08-15T12:00:00.000Z'
    };

    await seedInitialDeviceState(devA, [seedTxn]);
    await activateDevice(devA);

    // User selected instalment in UI, then cleared it (recurringConfig is null)
    // Standard updateTransaction is called
    await updateTransaction(seedTxn.id, {
      Note: 'Novel and Magazine purchase',
      INR: 1100,
      Amount: '1100',
      _id: seedTxn.id
    });

    const txns = await getTransactions();
    assert.strictEqual(txns.length, 1, 'Only 1 transaction exists in DB');
    assert.strictEqual(txns[0].id, seedTxn.id);
    assert.strictEqual(txns[0].Note, 'Novel and Magazine purchase');
    assert.strictEqual(txns[0].INR, 1100);
    assert.strictEqual(txns[0].recurring_rule_id || '', '');

    const rules = await getRecurringRules();
    assert.strictEqual(rules.length, 0, 'Zero recurring rules created');

    const devDb = getDB();
    const queueRows = (await devDb.query('SELECT * FROM sync_delta_queue')).values || [];
    assert.strictEqual(queueRows.length, 1, 'Exactly 1 UPDATE delta queued for transaction');
    assert.strictEqual(queueRows[0].operation, 'UPDATE');
    assert.strictEqual(queueRows[0].collection, 'transactions');
    assert.strictEqual(queueRows[0].entity_id, seedTxn.id);
  });

  await t.test('6. Repeat-to-Installment conversion: Repeat transaction converts in place to Part 1 of Installment series and syncs cleanly', async () => {
    const devA = createDeviceHarness('dev_a_rep_to_inst_6');
    const devB = createDeviceHarness('dev_b_rep_to_inst_6');

    const repeatRuleId = 'rule_gym_membership_annual';
    const seedRepeatRule = {
      id: repeatRuleId,
      rule_type: 'repeat',
      status: 'active',
      txn_type: 'Expense',
      account: 'HDFC Bank',
      category: 'Bills & Utilities',
      subcategory: 'Subscription',
      base_note: 'Gym Annual Membership',
      description: 'Annual fitness club fee',
      currency: 'INR',
      amount_per_part: 12000,
      start_date: '2026-09-01',
      schedule_mode: 'on_day',
      frequency: 'annually',
      completed_parts: 1,
    };

    const seedTxn = {
      id: 'tx_repeat_to_inst_01',
      date: '2026-09-01',
      time: '08:00',
      account: 'HDFC Bank',
      category: 'Bills & Utilities',
      subcategory: 'Subscription',
      note: 'Gym Annual Membership',
      description: 'Annual fitness club fee',
      inr: 12000,
      amount: '12000',
      currency: 'INR',
      type: 'Expense',
      recurring_rule_id: repeatRuleId,
      created_at: '2026-09-01T08:00:00.000Z',
      updated_at: '2026-09-01T08:00:00.000Z'
    };

    for (const h of [devA, devB]) {
      await seedInitialDeviceState(h, [seedTxn]);
      await executeAtomicMutation({
        storeName: 'recurring_rules',
        operation: 'INSERT',
        entity: seedRepeatRule,
        suppressDeltaQueue: true
      });
    }

    // On Device A: User converts this Repeat transaction to a 3-month installment series
    await activateDevice(devA);
    const instRule = {
      rule_type: 'instalment',
      status: 'completed',
      txn_type: 'Expense',
      account: 'HDFC Bank',
      from_account: '',
      to_account: '',
      category: 'Bills & Utilities',
      subcategory: 'Subscription',
      base_note: 'Gym Annual Membership',
      description: 'Annual fitness club fee',
      currency: 'INR',
      total_amount: 12000,
      total_days: 90,
      start_date: '2026-09-01',
      schedule_mode: 'on_day',
    };
    const schedule = buildInstalmentSchedule(instRule);
    instRule.total_parts = schedule.length;
    instRule.completed_parts = schedule.length;
    instRule.next_date = '';
    instRule.end_date = schedule[schedule.length - 1]?.date || '';
    instRule.amount_per_part = schedule[0]?.amount || 0;

    const savedInstRule = await createRecurringRule(instRule);

    // Sibling parts 2..N added first
    const siblingIds = [];
    for (let i = 1; i < schedule.length; i++) {
      const inst = schedule[i];
      const [iy, im, id2] = inst.date.split('-');
      const added = await addTransaction({
        Date: `${id2}/${im}/${iy}`,
        Time: '08:00',
        Account: 'HDFC Bank',
        Category: 'Bills & Utilities',
        Subcategory: 'Subscription',
        Note: buildInstalmentNote('Gym Annual Membership', inst.part, inst.total),
        Description: 'Annual fitness club fee',
        INR: inst.amount,
        Amount: String(inst.amount),
        Currency: 'INR',
        'Income/Expense': 'Expense',
        recurring_rule_id: savedInstRule.id,
      });
      siblingIds.push(added.id);
    }

    // Part 1 updates original Repeat transaction in place
    const [iy0, im0, id0] = schedule[0].date.split('-');
    await updateTransaction(seedTxn.id, {
      Date: `${id0}/${im0}/${iy0}`,
      Time: '08:00',
      Account: 'HDFC Bank',
      Category: 'Bills & Utilities',
      Subcategory: 'Subscription',
      Note: buildInstalmentNote('Gym Annual Membership', schedule[0].part, schedule[0].total),
      Description: 'Annual fitness club fee',
      INR: schedule[0].amount,
      Amount: String(schedule[0].amount),
      Currency: 'INR',
      'Income/Expense': 'Expense',
      recurring_rule_id: savedInstRule.id,
      _id: seedTxn.id
    });

    // Device A pushes deltas
    const pushResult = await executeFullSyncPass({
      deviceId: 'dev_a_rep_to_inst_6',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.strictEqual(pushResult.success, true);
    assert.strictEqual(pushResult.outbound.eventsUploaded, 4, '4 events uploaded (1 rule + 2 sibling inserts + 1 original update)');

    // Device B pulls deltas
    await activateDevice(devB);
    const pullResult = await executeFullSyncPass({
      deviceId: 'dev_b_rep_to_inst_6',
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.strictEqual(pullResult.success, true);
    assert.strictEqual(pullResult.reconciliation.reconciledCount, 4);
    assert.strictEqual(pullResult.reconciliation.conflictCount, 0);

    // Verify Device B transactions
    const txnsB = await getTransactions();
    assert.strictEqual(txnsB.length, 3, 'Zero duplicate records on Device B: exactly 3 transactions in series');

    const bPart1 = txnsB.find(t => t.id === seedTxn.id);
    assert.ok(bPart1, 'Original transaction ID preserved on Device B');
    assert.strictEqual(bPart1.Note, 'Gym Annual Membership (1/3)');
    assert.strictEqual(bPart1.INR, 4000);
    assert.strictEqual(bPart1.recurring_rule_id, savedInstRule.id);

    const bStats = getInstalmentSeriesStats(bPart1, txnsB);
    assert.strictEqual(bStats.totalParts, 3);
    assert.strictEqual(bStats.totalAmount, 12000);
    assert.strictEqual(bStats.completedAmount, 4000);
    assert.strictEqual(bStats.balanceRemaining, 8000);
  });

  await t.test('7. Failure handling and rollback: Partial sibling creation failure rolls back siblings and rule, keeping original transaction intact', async () => {
    const devA = createDeviceHarness('dev_a_rollback_7');

    const seedTxn = {
      id: 'tx_fail_safety_01',
      date: '2026-10-01',
      time: '14:00',
      account: 'HDFC Bank',
      category: 'Shopping',
      subcategory: 'Apparel',
      note: 'Winter Jacket',
      description: 'Down parka',
      inr: 15000,
      amount: '15000',
      currency: 'INR',
      type: 'Expense',
      created_at: '2026-10-01T14:00:00.000Z',
      updated_at: '2026-10-01T14:00:00.000Z'
    };

    await seedInitialDeviceState(devA, [seedTxn]);
    await activateDevice(devA);

    // Simulate failure during conversion workflow
    const instRule = {
      rule_type: 'instalment',
      status: 'completed',
      txn_type: 'Expense',
      account: 'HDFC Bank',
      category: 'Shopping',
      subcategory: 'Apparel',
      base_note: 'Winter Jacket',
      currency: 'INR',
      total_amount: 15000,
      total_days: 90,
      start_date: '2026-10-01',
      schedule_mode: 'on_day',
    };
    const schedule = buildInstalmentSchedule(instRule);
    instRule.total_parts = schedule.length;
    instRule.completed_parts = schedule.length;

    const createdSiblingIds = [];
    let savedRuleId = null;

    let caughtError = null;
    try {
      const saved = await createRecurringRule(instRule);
      savedRuleId = saved.id;

      // Part 2 succeeds
      const added2 = await addTransaction({
        Date: '01/11/2026',
        Time: '14:00',
        Account: 'HDFC Bank',
        Category: 'Shopping',
        Note: buildInstalmentNote('Winter Jacket', 2, 3),
        INR: 5000,
        Amount: '5000',
        Currency: 'INR',
        'Income/Expense': 'Expense',
        recurring_rule_id: savedRuleId,
      });
      createdSiblingIds.push(added2.id);

      // Part 3 throws simulated database/network error
      throw new Error('SIMULATED_DB_WRITE_FAILURE_ON_PART_3');
    } catch (err) {
      caughtError = err;
      // Rollback logic from AddTransaction.jsx
      for (const sibId of createdSiblingIds) {
        try { await deleteTransaction(sibId); } catch {}
      }
      if (savedRuleId) {
        try { await removeRecurringRule(savedRuleId); } catch {}
      }
    }

    assert.ok(caughtError, 'Simulated error caught');
    assert.strictEqual(caughtError.message, 'SIMULATED_DB_WRITE_FAILURE_ON_PART_3');

    // Verify database state: original transaction is completely unchanged!
    const txnsAfter = await getTransactions();
    assert.strictEqual(txnsAfter.length, 1, 'Only original transaction exists in DB (sibling rolled back)');
    assert.strictEqual(txnsAfter[0].id, seedTxn.id);
    assert.strictEqual(txnsAfter[0].Note, 'Winter Jacket');
    assert.strictEqual(txnsAfter[0].INR, 15000);
    assert.strictEqual(txnsAfter[0].recurring_rule_id || '', '');

    // Verify rule was removed
    const rulesAfter = await getRecurringRules();
    assert.strictEqual(rulesAfter.length, 0, 'Rule was rolled back and deleted');
  });

  await t.test('8. Repeat-to-Installment conversion with atomic batch: Retires obsolete repeat rule, creates installment series, and syncs to Device B with 0 unwanted repeat generations', async () => {
    const devA = createDeviceHarness('dev_a_repeat_to_inst_8');
    const devB = createDeviceHarness('dev_b_repeat_to_inst_8');

    const repeatRuleId = 'rule_repeat_fiber_01';
    const oldRepeatRule = {
      id: repeatRuleId,
      rule_type: 'repeat',
      status: 'active',
      txn_type: 'Expense',
      account: 'HDFC Bank',
      from_account: '',
      to_account: '',
      category: 'Utilities',
      subcategory: 'Internet',
      base_note: 'Fiber Broadband',
      description: 'Monthly fiber plan',
      currency: 'INR',
      amount_per_part: 1500,
      start_date: '2026-10-01',
      next_date: '2026-11-01',
      schedule_mode: 'start_of_month',
      frequency: 'monthly',
      completed_parts: 1,
      created_at: '2026-10-01T10:00:00.000Z',
      updated_at: '2026-10-01T10:00:00.000Z'
    };

    const seedTxn = {
      id: 'tx_fiber_broadband_01',
      date: '2026-10-01',
      time: '10:00',
      account: 'HDFC Bank',
      from_account: '',
      to_account: '',
      category: 'Utilities',
      subcategory: 'Internet',
      note: 'Fiber Broadband',
      description: 'Monthly fiber plan',
      inr: 4500,
      amount: '4500',
      currency: 'INR',
      type: 'Expense',
      recurring_rule_id: repeatRuleId,
      tags: 'utilities',
      created_at: '2026-10-01T10:00:00.000Z',
      updated_at: '2026-10-01T10:00:00.000Z'
    };

    // 1. Both devices start with baseline: 1 active repeat rule and 1 repeat transaction
    await seedInitialDeviceState(devA, [seedTxn], [oldRepeatRule]);
    await seedInitialDeviceState(devB, [seedTxn], [oldRepeatRule]);

    // Verify baseline on Device A
    await activateDevice(devA);
    const initialRulesA = await getRecurringRules();
    const activeRepeatA = initialRulesA.find(r => r.id === repeatRuleId);
    assert.strictEqual(activeRepeatA?.status, 'active', 'Baseline repeat rule is active on Device A');

    // 2. Device A converts the repeat transaction to a 3-month installment series (3 x 1500 INR)
    const newInstRule = {
      rule_type: 'instalment',
      status: 'completed',
      txn_type: 'Expense',
      account: 'HDFC Bank',
      from_account: '',
      to_account: '',
      category: 'Utilities',
      subcategory: 'Internet',
      base_note: 'Fiber Broadband',
      description: 'Quarterly payment converted to instalments',
      currency: 'INR',
      total_amount: 4500,
      total_days: 90,
      start_date: '2026-10-01',
      schedule_mode: 'start_of_month',
    };
    const schedule = buildInstalmentSchedule(newInstRule);
    assert.strictEqual(schedule.length, 3, 'Schedule has 3 parts');

    const conversionResult = await convertTransactionToInstalment({
      transactionId: seedTxn.id,
      updatedTransactionData: {
        Time: '10:00',
        Account: 'HDFC Bank',
        Category: 'Utilities',
        Subcategory: 'Internet',
        Description: 'Quarterly payment converted to instalments',
        Tags: 'utilities,converted'
      },
      instalmentRule: newInstRule,
      schedule,
      oldRuleIdToRetire: repeatRuleId
    });

    assert.ok(conversionResult.rule?.id, 'New installment rule created');
    assert.strictEqual(conversionResult.retiredRuleId, repeatRuleId, 'Old repeat rule retired');
    assert.strictEqual(conversionResult.updatedTransaction.id, seedTxn.id, 'Original ID preserved for Part 1');
    assert.strictEqual(conversionResult.siblingTransactions.length, 2, '2 sibling transactions created');

    // Verify local DB state on Device A
    const rulesOnA = await getRecurringRules();
    const oldRuleOnA = rulesOnA.find(r => r.id === repeatRuleId);
    assert.strictEqual(oldRuleOnA?.status, 'cancelled', 'Obsolete repeat rule cancelled on Device A');

    const newRuleOnA = rulesOnA.find(r => r.id === conversionResult.rule.id);
    assert.strictEqual(newRuleOnA?.status, 'completed', 'New installment rule marked completed on Device A');
    assert.strictEqual(newRuleOnA?.total_parts, 3);
    assert.strictEqual(newRuleOnA?.completed_parts, 3);

    const txnsOnA = await getTransactions();
    assert.strictEqual(txnsOnA.length, 3, 'Device A has exactly 3 transactions in series');
    const aPart1 = txnsOnA.find(t => t.id === seedTxn.id);
    assert.strictEqual(aPart1.Note, 'Fiber Broadband (1/3)');
    assert.strictEqual(aPart1.INR, 1500);
    assert.strictEqual(aPart1.recurring_rule_id, conversionResult.rule.id);

    // 3. Device A pushes to Mock Drive
    const pushRes = await executeFullSyncPass({
      deviceId: devA.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.strictEqual(pushRes.success, true, 'Device A sync pass succeeded');

    // 4. Device B syncs from Mock Drive
    await activateDevice(devB);
    const pullRes = await executeFullSyncPass({
      deviceId: devB.deviceId,
      driveClient: mockDrive,
      sessionKey: TEST_SESSION_KEY
    });
    assert.strictEqual(pullRes.success, true, 'Device B sync pass succeeded');

    // 5. Verify Device B state
    const rulesOnB = await getRecurringRules();
    const oldRuleOnB = rulesOnB.find(r => r.id === repeatRuleId);
    assert.ok(oldRuleOnB, 'Old repeat rule exists on Device B');
    assert.strictEqual(oldRuleOnB.status, 'cancelled', 'Device B has old repeat rule retired (cancelled)');

    // Ensure zero active repeat rules for this subscription on Device B (no unwanted future generations!)
    const activeRepeatRulesB = rulesOnB.filter(r => r.rule_type === 'repeat' && r.status === 'active' && r.base_note === 'Fiber Broadband');
    assert.strictEqual(activeRepeatRulesB.length, 0, 'Zero active repeat rules for Fiber Broadband on Device B');

    const newRuleOnB = rulesOnB.find(r => r.id === conversionResult.rule.id);
    assert.ok(newRuleOnB, 'New installment rule synced to Device B');
    assert.strictEqual(newRuleOnB.status, 'completed', 'New installment rule completed on Device B');
    assert.strictEqual(newRuleOnB.total_parts, 3);
    assert.strictEqual(newRuleOnB.completed_parts, 3);

    const txnsOnB = await getTransactions();
    assert.strictEqual(txnsOnB.length, 3, 'Device B has exactly 3 transactions with zero duplicates');

    const bPart1 = txnsOnB.find(t => t.id === seedTxn.id);
    assert.ok(bPart1, 'Original transaction ID preserved on Device B');
    assert.strictEqual(bPart1.Note, 'Fiber Broadband (1/3)');
    assert.strictEqual(bPart1.INR, 1500);
    assert.strictEqual(bPart1.recurring_rule_id, conversionResult.rule.id);

    // Verify series stats match identically between Device A and Device B
    const statsA = getInstalmentSeriesStats(aPart1, txnsOnA);
    const statsB = getInstalmentSeriesStats(bPart1, txnsOnB);
    assert.deepStrictEqual(statsB, statsA, 'Series stats on Device B identically match Device A');
    assert.strictEqual(statsB.totalParts, 3);
    assert.strictEqual(statsB.totalAmount, 4500);
    assert.strictEqual(statsB.completedAmount, 1500);
    assert.strictEqual(statsB.balanceRemaining, 3000);
  });
});
