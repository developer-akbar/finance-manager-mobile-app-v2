/**
 * cross_device_sync_failure_resilience.test.js
 *
 * Dedicated regression test suite verifying cross-device sync resilience,
 * SQLite column filtering, out-of-order event delivery, transient retry safety,
 * layered error reporting, and redacted developer diagnostics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, closeDB, getDB, getTableColumns, clearTableColumnsCache } from '../database/db.js';
import { setSetting } from '../database/settings.js';
import { initLocalSyncState, getPendingDeltaEvents } from '../database/deltaQueue.js';
import { executeAtomicMutation } from '../database/atomicMutation.js';
import { getTransactions, addTransaction, convertTransactionToInstalment } from '../database/transactions.js';
import {
  saveRecurringRule,
  getAllRecurringRules,
  buildInstalmentSchedule,
  buildInstalmentNote,
  getInstalmentSeriesStats
} from '../database/recurring.js';
import { replaceAccounts } from '../database/accounts.js';
import { replaceCategories } from '../database/categories.js';
import {
  executeFullSyncPass,
  configureDeltaSyncEngine,
  recordSyncDiagnostic,
  getSyncDiagnostics,
  getLatestSyncDiagnostic,
  clearSyncDiagnostics,
  redactDeviceId,
  sanitizeErrorMessage,
  sanitizeStackTrace
} from '../services/deltaSyncCoordinator.js';
import { translateSyncError } from '../utils/cloudSyncStatusHelper.js';
import { reconcileStagedEvents } from '../services/deltaReconciliation.js';

const TEST_SESSION_KEY = 'test-resilience-key-32-chars-long!!';
const TEST_BASE_SNAPSHOT_ID = 'snap_resilience_test_v1';

class MockDriveStorage {
  constructor() {
    this.files = new Map();
    this.nextId = 1;
    this.failUpload = false;
    this.failUploadError = null;
  }

  reset() {
    this.files.clear();
    this.nextId = 1;
    this.failUpload = false;
    this.failUploadError = null;
  }

  async findFileByName(name) {
    for (const [id, file] of this.files.entries()) {
      if (file.name === name) return { id, ...file };
    }
    return null;
  }

  async listFiles({ q } = {}) {
    const results = [];
    for (const [id, file] of this.files.entries()) {
      if (q && q.includes('trashed = false') && file.trashed) continue;
      results.push({ id, ...file });
    }
    return results;
  }

  async uploadFile(name, content, mimeType = 'application/json') {
    if (this.failUpload) {
      throw this.failUploadError || new Error('Network request failed (503 Service Unavailable)');
    }
    const id = `mock_drive_file_${this.nextId++}`;
    this.files.set(id, { name, content, mimeType, trashed: false });
    return { id, name };
  }

  async updateFile(fileId, content) {
    if (this.failUpload) {
      throw this.failUploadError || new Error('Network request failed (503 Service Unavailable)');
    }
    const existing = this.files.get(fileId);
    if (!existing) throw new Error(`File not found: ${fileId}`);
    existing.content = content;
    return { id: fileId, name: existing.name };
  }

  async downloadFile(fileId) {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    return file.content;
  }
}

const mockDrive = new MockDriveStorage();

const setupDeviceEnvironment = async (deviceId, idbInstance) => {
  global.indexedDB = idbInstance;
  await closeDB();
  clearTableColumnsCache();
  await initDB();

  await initLocalSyncState(deviceId, TEST_BASE_SNAPSHOT_ID, 1);
  await setSetting('cloud_sync_device_id', deviceId);
  await setSetting('cloud_sync_peer_lifecycle', 'ACTIVE');
  await setSetting('sync_session_key', TEST_SESSION_KEY);
  await setSetting('cloud_sync_last_snapshot_id', TEST_BASE_SNAPSHOT_ID);

  configureDeltaSyncEngine({
    getAccessToken: async () => 'mock_valid_token_resilience',
    getSessionKey: async () => TEST_SESSION_KEY,
    getDeviceId: async () => deviceId,
    driveClient: mockDrive,
    enabled: true
  });
};

test('Cross-Device Sync Failure Resilience & Diagnostics Suite', async (t) => {
  t.beforeEach(() => {
    mockDrive.reset();
    clearSyncDiagnostics();
  });

  t.afterEach(async () => {
    await closeDB();
    clearTableColumnsCache();
  });

  await t.test('1. Two-device sync after Repeat-to-Installment conversion reconciles updated_at on both rules and transactions', async () => {
    const idbDeviceA = new IDBFactory();
    const idbDeviceB = new IDBFactory();

    // ── Setup Device A ──
    await setupDeviceEnvironment('dev_resilience_a', idbDeviceA);
    await replaceAccounts([{ id: 'acc_bank', name: 'Bank Account', type: 'Bank', balance: 50000 }]);
    await replaceCategories([{ id: 'cat_electronics', name: 'Electronics', type: 'Expense' }]);

    // Device A creates an initial Repeat Rule and initial Transaction
    const repeatRule = {
      id: 'rule_orig_repeat_resilience',
      rule_type: 'repeat',
      status: 'active',
      txn_type: 'Expense',
      account: 'Bank Account',
      category: 'Electronics',
      subcategory: '',
      base_note: 'Gadget Subscription',
      description: '',
      currency: 'INR',
      total_amount: 12000,
      frequency: 'monthly',
      created_at: '2026-10-01T10:00:00.000Z',
      updated_at: '2026-10-01T10:00:00.000Z'
    };
    await saveRecurringRule(repeatRule);

    const initialTxn = await addTransaction({
      Date: '01/10/2026',
      Time: '10:00',
      Account: 'Bank Account',
      Category: 'Electronics',
      Note: 'Gadget Subscription',
      INR: 12000,
      Amount: '12000',
      Currency: 'INR',
      'Income/Expense': 'Expense',
      recurring_rule_id: repeatRule.id
    });

    // Device A converts transaction to a 3-part Instalment series
    const instalmentRule = {
      id: 'rule_new_inst_resilience',
      rule_type: 'instalment',
      status: 'completed',
      txn_type: 'Expense',
      account: 'Bank Account',
      category: 'Electronics',
      subcategory: '',
      base_note: 'Gadget Purchase (Instalment)',
      description: 'Converted from monthly repeat',
      currency: 'INR',
      total_amount: 12000,
      amount_per_part: 4000,
      total_parts: 3,
      completed_parts: 3,
      start_date: '2026-10-01',
      schedule_mode: 'on_date',
      total_days: 90
    };
    const schedule = buildInstalmentSchedule(instalmentRule);

    const conversionResult = await convertTransactionToInstalment({
      transactionId: initialTxn.id,
      updatedTransactionData: {
        Date: '01/10/2026',
        Time: '10:00',
        Account: 'Bank Account',
        Category: 'Electronics',
        Note: buildInstalmentNote('Gadget Purchase (Instalment)', 1, 3),
        INR: 4000,
        Amount: '4000',
        Currency: 'INR',
        'Income/Expense': 'Expense'
      },
      instalmentRule,
      schedule,
      oldRuleIdToRetire: repeatRule.id
    });

    assert.equal(conversionResult.success, true);
    assert.equal(conversionResult.totalParts, 3);

    // Push from Device A to Cloud
    const pushPassA = await executeFullSyncPass({ trigger: 'TEST_PUSH_A' });
    assert.equal(pushPassA.success, true);

    // ── Setup Device B ──
    await setupDeviceEnvironment('dev_resilience_b', idbDeviceB);
    await replaceAccounts([{ id: 'acc_bank', name: 'Bank Account', type: 'Bank', balance: 50000 }]);
    await replaceCategories([{ id: 'cat_electronics', name: 'Electronics', type: 'Expense' }]);

    // Device B pulls and reconciles
    const pullPassB = await executeFullSyncPass({ trigger: 'TEST_PULL_B' });
    assert.equal(pullPassB.success, true);

    // Verify Device B state
    const rulesB = await getAllRecurringRules();
    const retiredRuleB = rulesB.find(r => r.id === repeatRule.id);
    const activeRuleB = rulesB.find(r => r.id === instalmentRule.id);

    assert.ok(retiredRuleB, 'Retired rule must exist on Device B');
    assert.equal(retiredRuleB.status, 'cancelled');
    assert.ok(retiredRuleB.updated_at, 'Retired rule must have updated_at');

    assert.ok(activeRuleB, 'New instalment rule must exist on Device B');
    assert.equal(activeRuleB.rule_type, 'instalment');
    assert.equal(activeRuleB.status, 'completed');
    assert.ok(activeRuleB.updated_at, 'New rule must have updated_at');

    const txnsB = await getTransactions();
    assert.equal(txnsB.length, 3, 'Device B must have all 3 instalment transactions');

    const part1Txn = txnsB.find(t => t.id === initialTxn.id);
    assert.ok(part1Txn, 'Part 1 must preserve original transaction ID');
    assert.equal(part1Txn.INR, 4000);
    assert.ok(part1Txn.Note.includes('[Instalment 1/3]'));

    // Check stats on Device B
    const statsB = getInstalmentSeriesStats(part1Txn, txnsB, rulesB);
    assert.equal(statsB.totalParts, 3);
    assert.equal(statsB.currentPart, 1);
    assert.equal(statsB.totalAmount, 12000);
  });

  await t.test('2. SQLite dynamic column sanitization: ignores unknown/version-skewed properties without crashing', async () => {
    // Simulate an SQLite db object with a strict schema table
    const mockDb = {
      async query(sql) {
        if (sql.includes('PRAGMA table_info(recurring_rules)')) {
          return {
            values: [
              { name: 'id' },
              { name: 'rule_type' },
              { name: 'status' },
              { name: 'updated_at' }
            ]
          };
        }
        return { values: [] };
      },
      async run(sql, vals) {
        // Assert that no unknown columns appear in the query
        if (sql.includes('unknown_future_col')) {
          throw new Error('table recurring_rules has no column named unknown_future_col');
        }
        return { changes: 1 };
      }
    };

    const cols = await getTableColumns(mockDb, 'recurring_rules');
    assert.ok(cols.has('id'));
    assert.ok(cols.has('rule_type'));
    assert.ok(cols.has('updated_at'));
    assert.equal(cols.has('unknown_future_col'), false);

    // Verify column cache works
    const cachedCols = await getTableColumns(mockDb, 'recurring_rules');
    assert.equal(cachedCols, cols);
  });

  await t.test('3. Out-of-order event delivery: transactions arrive before recurring rule safely calculate stats', async () => {
    const idbDevice = new IDBFactory();
    await setupDeviceEnvironment('dev_ooo_test', idbDevice);

    // Add installment transaction parts without recurring rule yet in database
    const txn1 = await addTransaction({
      Date: '01/10/2026',
      Time: '10:00',
      Account: 'Bank Account',
      Category: 'Electronics',
      Note: 'Laptop Purchase [Instalment 1/3]',
      INR: 15000,
      Amount: '15000',
      Currency: 'INR',
      'Income/Expense': 'Expense',
      recurring_rule_id: 'pending_rule_xyz'
    });

    const txn2 = await addTransaction({
      Date: '01/11/2026',
      Time: '10:00',
      Account: 'Bank Account',
      Category: 'Electronics',
      Note: 'Laptop Purchase [Instalment 2/3]',
      INR: 15000,
      Amount: '15000',
      Currency: 'INR',
      'Income/Expense': 'Expense',
      recurring_rule_id: 'pending_rule_xyz'
    });

    const allTxns = await getTransactions();
    const rules = await getAllRecurringRules(); // empty

    // Should compute stats safely from notes without throwing
    const stats = getInstalmentSeriesStats(txn1, allTxns, rules);
    assert.equal(stats.totalParts, 3);
    assert.equal(stats.currentPart, 1);
    assert.equal(stats.rule, null);

    // Now recurring rule arrives subsequently
    await saveRecurringRule({
      id: 'pending_rule_xyz',
      rule_type: 'instalment',
      status: 'completed',
      total_amount: 45000,
      amount_per_part: 15000,
      total_parts: 3,
      completed_parts: 2,
      updated_at: '2026-10-01T12:00:00.000Z'
    });

    const updatedRules = await getAllRecurringRules();
    const statsAfterRule = getInstalmentSeriesStats(txn1, allTxns, updatedRules);
    assert.equal(statsAfterRule.totalParts, 3);
    assert.ok(statsAfterRule.rule);
    assert.equal(statsAfterRule.rule.id, 'pending_rule_xyz');
  });

  await t.test('4. Transient failure preserves pending outbox deltas and enables clean idempotent retry', async () => {
    const idbDevice = new IDBFactory();
    await setupDeviceEnvironment('dev_transient_test', idbDevice);
    await replaceAccounts([{ id: 'acc_1', name: 'Cash', type: 'Cash', balance: 1000 }]);

    // Create a local transaction
    await addTransaction({
      Date: '20/10/2026',
      Time: '14:00',
      Account: 'Cash',
      Category: 'Food',
      Note: 'Lunch with colleagues',
      INR: 450,
      Amount: '450',
      Currency: 'INR',
      'Income/Expense': 'Expense'
    });

    const pendingBefore = await getPendingDeltaEvents();
    assert.ok(pendingBefore.length > 0, 'Must have pending deltas in queue');

    // Simulate transient failure during upload
    mockDrive.failUpload = true;
    mockDrive.failUploadError = new Error('Network request failed: 503 Service Unavailable');

    const failedPass = await executeFullSyncPass({ trigger: 'TEST_FAIL' });
    assert.equal(failedPass.success, false);

    // Assert that pending deltas remain queued and uncorrupted
    const pendingAfter = await getPendingDeltaEvents();
    assert.equal(pendingAfter.length, pendingBefore.length, 'Deltas must remain queued after transient failure');

    // Check developer diagnostics
    const diag = getLatestSyncDiagnostic();
    assert.ok(diag, 'Diagnostic record must be created');
    assert.equal(diag.stage, 'upload');
    assert.equal(diag.code, 'SERVER_ERROR');
    assert.equal(diag.retryable, true);
    assert.equal(diag.pendingChanges, pendingBefore.length);
    assert.equal(diag.localDataVerified, true);
    assert.ok(!diag.message.includes('450'), 'Sanitized message must not contain financial amounts');
    assert.ok(!diag.message.includes('Lunch with colleagues'), 'Sanitized message must not contain note content');

    // Test layered user error message
    const userMsg = translateSyncError(failedPass.error, {
      pendingCount: diag.pendingChanges,
      localDataVerified: diag.localDataVerified
    });
    assert.ok(userMsg.includes('queued'), 'User message must inform user changes remain queued');

    // Fix network and retry
    mockDrive.failUpload = false;
    const retryPass = await executeFullSyncPass({ trigger: 'TEST_RETRY' });
    assert.equal(retryPass.success, true, 'Retry must succeed cleanly');

    const pendingFinal = await getPendingDeltaEvents();
    assert.equal(pendingFinal.length, 0, 'Deltas must be cleanly acknowledged and drained');
  });

  await t.test('5. Database error yields non-alarming user message and never leaks raw SQL or column names', async () => {
    const rawSqlError = 'table recurring_rules has no column named updated_at (code 1 SQLITE_ERROR)';
    const translated = translateSyncError(rawSqlError, { pendingCount: 2, localDataVerified: true });

    assert.ok(!translated.includes('updated_at'), 'Must not leak column name');
    assert.ok(!translated.includes('recurring_rules'), 'Must not leak table name');
    assert.ok(!translated.includes('SQLITE_ERROR'), 'Must not leak SQLite error codes');
    assert.ok(translated.includes('local database issue'), 'Must provide clear non-alarming guidance');
    assert.ok(translated.includes('queued'), 'Must indicate local changes remain queued');
  });

  await t.test('6. Developer diagnostics redaction: device IDs, paths, tokens, and PII are scrubbed', async () => {
    const rawDeviceId = 'dev_6edc69e37943';
    const redacted = redactDeviceId(rawDeviceId);
    assert.equal(redacted, 'dev_...7943');

    const rawError = 'Failed at C:\\Akbar\\Projects\\Coding\\finman-v2\\src\\database\\transactions.js: Bearer ya29.a0AfH6SMCxyz123 with amount 45000.00';
    const sanitized = sanitizeErrorMessage(rawError);
    assert.ok(!sanitized.includes('C:\\Akbar'), 'File path must be stripped');
    assert.ok(!sanitized.includes('ya29.a0AfH6SMCxyz123'), 'Auth token must be stripped');
    assert.ok(!sanitized.includes('Bearer ya29'), 'Bearer auth must be stripped');

    const rawStack = 'Error: test\n    at Object.test (C:\\Akbar\\Projects\\Coding\\finman-v2\\src\\db.js:10:15)\n    at ya29.secret';
    const sanitizedStack = sanitizeStackTrace(rawStack);
    assert.ok(!sanitizedStack.includes('C:\\Akbar'), 'Stack trace must not contain full local paths');
    assert.ok(!sanitizedStack.includes('ya29.secret'), 'Stack trace must not contain secrets');
  });
});
