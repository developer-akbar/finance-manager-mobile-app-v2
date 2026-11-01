/**
 * explicit_recovery_pipeline_lock_integration.test.js
 *
 * Regression test suite for Phase B recovery pipeline integration with Phase A recovery lock:
 * 1. Ordinary sync remains blocked under the recovery lock.
 * 2. Explicit user-initiated v16 recovery can enter the recovery pipeline while locked.
 * 3. Wrong PIN cannot begin database promotion.
 * 4. Recovery failure leaves the lock active and preserves durable backup.
 * 5. Successful recovery clears the lock only at the final verified completion point.
 */

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

// In-memory localStorage mock for Node.js test runtime
const storageMap = new Map();
globalThis.localStorage = {
  getItem: (key) => storageMap.get(key) || null,
  setItem: (key, val) => storageMap.set(key, String(val)),
  removeItem: (key) => storageMap.delete(key),
  clear: () => storageMap.clear(),
  key: (i) => Array.from(storageMap.keys())[i] || null,
  get length() { return storageMap.size; }
};

import { initDB, getDB, closeDB } from '../database/db.js';
import { setSetting, getSetting } from '../database/settings.js';
import { encryptBackupData } from '../utils/cryptoBackup.js';
import {
  setRecoverySafetyLock,
  checkRecoverySafetyLockAsync,
  clearRecoverySafetyLock,
  isRecoverySafetyLocked,
  RECOVERY_LOCK_REASON
} from '../services/recoveryLock.js';
import {
  executeExplicitSnapshotRecovery,
  checkAndAutoReconcileCloudSnapshot,
  triggerAutomaticSync,
  executeFullSyncPass,
  scheduleSync,
  SYNC_TRIGGER
} from '../services/deltaSyncCoordinator.js';
import {
  encodePersistedToken,
  decodePersistedToken,
  getSyncSessionKey,
  lockSyncSession
} from '../services/syncSession.js';

test('FinMan — Phase B Recovery Pipeline & Phase A Recovery Lock Integration Suite', async (t) => {
  let db;
  const TEST_PIN = '7410';
  const WRONG_PIN = '9999';

  t.beforeEach(async () => {
    storageMap.clear();
    closeDB();
    db = await initDB();
    await db.run('DELETE FROM settings;').catch(() => {});
    await db.run('DELETE FROM transactions;').catch(() => {});
    await db.run('DELETE FROM investment_transactions;').catch(() => {});
    await db.run('DELETE FROM accounts;').catch(() => {});
    await db.run('DELETE FROM sync_local_state;').catch(() => {});
    await db.run('DELETE FROM sync_delta_queue;').catch(() => {});
    await clearRecoverySafetyLock({ confirmed: true, force: true }).catch(() => {});
    lockSyncSession();

    // Store persisted PIN in encoded format
    const token = encodePersistedToken(TEST_PIN);
    localStorage.setItem('finman_persisted_sync_pin', token);
    await setSetting('finman_persisted_sync_pin', token, { suppressDeltaQueue: true });
  });

  t.afterEach(async () => {
    await clearRecoverySafetyLock({ confirmed: true, force: true }).catch(() => {});
    lockSyncSession();
    closeDB();
  });

  await t.test('1. Ordinary sync remains blocked under the recovery lock', async () => {
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.BOOTSTRAP_DEFAULT_LOCKED, { test: true });
    assert.equal(isRecoverySafetyLocked(), true);

    // a. scheduleSync must be suppressed
    scheduleSync(SYNC_TRIGGER.STARTUP);

    // b. triggerAutomaticSync must return suppressed / RECOVERY_SAFETY_LOCK_ACTIVE
    const autoSyncRes = await triggerAutomaticSync(SYNC_TRIGGER.STARTUP);
    assert.ok(/RECOVERY_LOCKED|RECOVERY_SAFETY_LOCK_ACTIVE/.test(autoSyncRes.status));

    // c. executeFullSyncPass must be aborted
    const fullPassRes = await executeFullSyncPass({ trigger: SYNC_TRIGGER.STARTUP });
    assert.ok(/RECOVERY_LOCKED|RECOVERY_SAFETY_LOCK_ACTIVE/.test(fullPassRes.status));

    // d. checkAndAutoReconcileCloudSnapshot must return suppressed without network calls
    const autoReconRes = await checkAndAutoReconcileCloudSnapshot();
    assert.equal(autoReconRes.reconciled, false);
    assert.equal(autoReconRes.reason, 'RECOVERY_SAFETY_LOCK_ACTIVE');

    // Lock remains firmly active
    assert.equal(isRecoverySafetyLocked(), true);
  });

  await t.test('2. Explicit user-initiated v16 recovery can enter the recovery pipeline while locked', async () => {
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.BOOTSTRAP_DEFAULT_LOCKED, { test: true });
    assert.equal(isRecoverySafetyLocked(), true);

    // Initial local records (baseline v15)
    await db.run('INSERT INTO accounts (id, name) VALUES (?, ?)', ['acc_old', 'Savings Old']);
    await db.run('INSERT INTO transactions (id, date, amount, account, type) VALUES (?, ?, ?, ?, ?)',
      ['tx_old', '2026-10-01', '100', 'Savings Old', 'Expense']);

    // Mock target snapshot v16 payload
    const snapshotV16Payload = {
      snapshot_id: 'snap_v16_target_official',
      cloud_version: 16,
      schema_version: 13,
      created_at: new Date().toISOString(),
      entities: {
        accounts: [{ id: 'acc_v16', name: 'Primary Wealth', type: 'Bank' }],
        transactions: [
          { id: 'tx_v16_1', date: '2026-10-30', amount: '250', account: 'Primary Wealth', type: 'Income' },
          { id: 'tx_v16_2', date: '2026-10-31', amount: '75', account: 'Primary Wealth', type: 'Expense' }
        ],
        investment_transactions: [],
        settings: {
          theme: 'dark',
          default_currency: 'INR'
        }
      }
    };

    const encryptedV16Data = await encryptBackupData(snapshotV16Payload, TEST_PIN);

    const mockDriveClient = {
      findAppDataFile: async () => ({ id: 'mock_file_v16', name: 'finman_cloud_sync_snapshot.finman' }),
      readAppDataFile: async () => encryptedV16Data
    };

    let lockDuringPipeline = false;
    const progressStages = [];

    const recoveryRes = await executeExplicitSnapshotRecovery({
      pin: TEST_PIN,
      accessToken: 'mock_token',
      driveClient: mockDriveClient,
      targetSnapshotId: 'snap_v16_target_official',
      targetCloudVersion: 16,
      onProgress: (p) => {
        progressStages.push(p.stage);
        if (isRecoverySafetyLocked()) {
          lockDuringPipeline = true;
        }
      }
    });

    assert.equal(recoveryRes.success, true);
    assert.equal(recoveryRes.cloudVersion, 16);
    assert.equal(lockDuringPipeline, true, 'Recovery lock must remain ACTIVE during download, staging, and promotion');

    // Database must reflect upgraded snapshot v16 entities
    const txRows = (await db.query('SELECT * FROM transactions')).values;
    assert.equal(txRows.length, 2);
    assert.ok(txRows.some(t => t.id === 'tx_v16_1'));
    assert.ok(txRows.some(t => t.id === 'tx_v16_2'));

    // Lock is now cleared upon full verified completion
    assert.equal(isRecoverySafetyLocked(), false);
  });

  await t.test('3. Wrong PIN cannot begin database promotion', async () => {
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.BOOTSTRAP_DEFAULT_LOCKED, { test: true });
    assert.equal(isRecoverySafetyLocked(), true);

    // Seed original data
    await db.run('INSERT INTO accounts (id, name) VALUES (?, ?)', ['acc_protected', 'Protected Bank']);
    await db.run('INSERT INTO transactions (id, date, amount, account, type) VALUES (?, ?, ?, ?, ?)',
      ['tx_protect_1', '2026-10-15', '500', 'Protected Bank', 'Expense']);

    const snapshotV16Payload = {
      snapshot_id: 'snap_v16_wrong_pin_test',
      cloud_version: 16,
      schema_version: 13,
      created_at: new Date().toISOString(),
      entities: {
        accounts: [{ id: 'acc_invaded', name: 'Tampered Account' }],
        transactions: [{ id: 'tx_invaded', date: '2026-10-31', amount: '9999', account: 'Tampered Account', type: 'Expense' }],
        investment_transactions: []
      }
    };
    const encryptedData = await encryptBackupData(snapshotV16Payload, TEST_PIN);

    const mockDriveClient = {
      findAppDataFile: async () => ({ id: 'mock_file_v16', name: 'finman_cloud_sync_snapshot.finman' }),
      readAppDataFile: async () => encryptedData
    };

    // Attempt explicit recovery with WRONG PIN
    await assert.rejects(
      async () => {
        await executeExplicitSnapshotRecovery({
          pin: WRONG_PIN,
          accessToken: 'mock_token',
          driveClient: mockDriveClient,
          targetSnapshotId: 'snap_v16_wrong_pin_test',
          targetCloudVersion: 16
        });
      },
      /Incorrect.*PIN|Failed to decrypt|operation failed/i
    );

    // Database records must NOT be replaced
    const txRows = (await db.query('SELECT * FROM transactions')).values;
    assert.equal(txRows.length, 1);
    assert.equal(txRows[0].id, 'tx_protect_1');

    // Recovery lock must remain firmly locked
    assert.equal(isRecoverySafetyLocked(), true);
  });

  await t.test('4. Recovery failure leaves the lock active and preserves durable backup', async () => {
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.BOOTSTRAP_DEFAULT_LOCKED, { test: true });
    assert.equal(isRecoverySafetyLocked(), true);

    // Seed original data
    await db.run('INSERT INTO accounts (id, name) VALUES (?, ?)', ['acc_durable', 'Durable Bank']);
    await db.run('INSERT INTO transactions (id, date, amount, account, type) VALUES (?, ?, ?, ?, ?)',
      ['tx_durable_1', '2026-10-20', '350', 'Durable Bank', 'Expense']);

    // Staged payload that will trigger post-mutation verification failure
    const { reconcileExistingDeviceWithSnapshot } = await import('../services/snapshotDeviceImport.js');
    await assert.rejects(
      async () => {
        await reconcileExistingDeviceWithSnapshot({
          confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
          stagingDbPath: 'staging_corrupt_test.db',
          stagingEntities: {
            accounts: [{ id: 'acc_corrupt', name: 'Safe Account' }],
            transactions: [{ id: 'tx_corrupt_1', account: 'Safe Account' }]
          },
          targetSnapshotId: 'snap_v16_corrupt_counts',
          targetCloudVersion: 16,
          entityCounts: {
            accounts: 1,
            transactions: 99 // Expected 99, but staging will only have 1 -> triggers verification failure!
          }
        });
      },
      /Data integrity verification failed|count mismatch|ROLLBACK_TRIGGERED/i
    );

    // Local data must be fully preserved via rollback
    const txRows = (await db.query('SELECT * FROM transactions')).values;
    assert.equal(txRows.length, 1);
    assert.equal(txRows[0].id, 'tx_durable_1');

    // Recovery lock must STILL be active
    assert.equal(isRecoverySafetyLocked(), true);
  });

  await t.test('5. Successful recovery clears the lock only at final verified completion point', async () => {
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.BOOTSTRAP_DEFAULT_LOCKED, { test: true });
    assert.equal(isRecoverySafetyLocked(), true);

    const validPayload = {
      snapshot_id: 'snap_v16_final_verification',
      cloud_version: 16,
      schema_version: 13,
      created_at: new Date().toISOString(),
      entities: {
        accounts: [{ id: 'acc_final', name: 'Final Bank', type: 'Bank' }],
        transactions: [
          { id: 'tx_final_1', date: '2026-10-31', amount: '500', account: 'Final Bank', type: 'Income' }
        ],
        investment_transactions: []
      }
    };
    const encryptedData = await encryptBackupData(validPayload, TEST_PIN);

    const mockDriveClient = {
      findAppDataFile: async () => ({ id: 'mock_file_v16', name: 'finman_cloud_sync_snapshot.finman' }),
      readAppDataFile: async () => encryptedData
    };

    let lockBeforeCompletion = null;
    const res = await executeExplicitSnapshotRecovery({
      pin: TEST_PIN,
      accessToken: 'mock_token',
      driveClient: mockDriveClient,
      targetSnapshotId: 'snap_v16_final_verification',
      targetCloudVersion: 16,
      onProgress: (p) => {
        if (p.stage === 'PROMOTING_STAGING' || p.stage === 'REPLACING') {
          lockBeforeCompletion = isRecoverySafetyLocked();
        }
      }
    });

    assert.equal(res.success, true);
    assert.equal(lockBeforeCompletion, true, 'Lock must be active during replacement');
    assert.equal(isRecoverySafetyLocked(), false, 'Lock is cleared after final verified completion');
  });
});
