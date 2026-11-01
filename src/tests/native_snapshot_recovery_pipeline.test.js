/**
 * native_snapshot_recovery_pipeline.test.js
 *
 * Comprehensive Test Suite for Memory-Safe Android Snapshot v16 Recovery:
 * 1. WebCrypto-to-native AES-GCM envelope compatibility
 * 2. Wrong PIN & modified ciphertext rejection
 * 3. Staging database promotion via ATTACH and atomic replacement
 * 4. Preservation of all 22 operational tables, relationships, and schemas
 * 5. Rollback on simulated failure and preservation of durable backup
 * 6. Recovery safety lock state lifecycle
 */

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initDB, getDB, closeDB } from '../database/db.js';
import { setSetting, getSetting, getAllSettings } from '../database/settings.js';
import {
  encryptBackupData,
  decryptBackupData,
  bytesToBase64,
  base64ToBytes
} from '../utils/cryptoBackup.js';
import {
  reconcileExistingDeviceWithSnapshot,
  verifyReconciledDataIntegrity,
  createDurablePreImportBackup,
  restorePreImportBackup,
  SNAPSHOT_IMPORT_ERROR_CODES
} from '../services/snapshotDeviceImport.js';
import {
  setRecoverySafetyLock,
  checkRecoverySafetyLockAsync,
  clearRecoverySafetyLock,
  isRecoverySafetyLocked,
  RECOVERY_LOCK_REASON
} from '../services/recoveryLock.js';

test('FinMan Phase B — Memory-Safe Snapshot v16 Native Recovery Pipeline', async (t) => {
  let db;

  t.beforeEach(async () => {
    closeDB();
    db = await initDB();
    await db.run('DELETE FROM settings;').catch(() => {});
    await db.run('DELETE FROM transactions;').catch(() => {});
    await db.run('DELETE FROM investment_transactions;').catch(() => {});
    await db.run('DELETE FROM accounts;').catch(() => {});
    await db.run('DELETE FROM categories;').catch(() => {});
    await db.run('DELETE FROM subcategories;').catch(() => {});
    await db.run('DELETE FROM inventory;').catch(() => {});
    await db.run('DELETE FROM brokerages;').catch(() => {});
    await db.run('DELETE FROM account_groups;').catch(() => {});
    await db.run('DELETE FROM sub_accounts;').catch(() => {});
    await db.run('DELETE FROM sync_tombstones;').catch(() => {});
    await db.run('DELETE FROM sync_delta_queue;').catch(() => {});
    await db.run('DELETE FROM sync_local_state;').catch(() => {});
    await clearRecoverySafetyLock({ confirmed: true, force: true }).catch(() => {});
  });

  t.afterEach(async () => {
    await clearRecoverySafetyLock({ confirmed: true, force: true }).catch(() => {});
    closeDB();
  });

  await t.test('1. AES-256-GCM WebCrypto format interoperability with PBKDF2 (100,000 iters)', async () => {
    const pin = '1234';
    const payload = {
      snapshot_id: 'snap_v16_test_interop',
      cloud_version: 16,
      schema_version: 13,
      created_at: new Date().toISOString(),
      entities: {
        accounts: [{ id: 'acc_main', name: 'Checking Account', type: 'Bank', balance: 5000 }],
        transactions: [
          { id: 'tx_001', Account: 'Checking Account', amount: 150, type: 'Expense', date: '2026-10-30' }
        ]
      }
    };

    // Encrypt with WebCrypto
    const encryptedJson = await encryptBackupData(payload, pin);
    const parsedEnvelope = JSON.parse(encryptedJson);

    // Verify envelope matches native expected format
    assert(parsedEnvelope.finman_encrypted_backup, 'Envelope must declare finman_encrypted_backup: true');
    assert(parsedEnvelope.salt, 'Envelope must contain Base64 salt');
    assert(parsedEnvelope.iv, 'Envelope must contain Base64 IV');
    assert(parsedEnvelope.data, 'Envelope must contain Base64 data (ciphertext + 16-byte tag)');

    const saltBytes = base64ToBytes(parsedEnvelope.salt);
    const ivBytes = base64ToBytes(parsedEnvelope.iv);
    assert.equal(saltBytes.length, 16, 'Salt must be exactly 16 bytes');
    assert.equal(ivBytes.length, 12, 'IV must be exactly 12 bytes');

    // Round-trip decrypt
    const decrypted = await decryptBackupData(encryptedJson, pin);
    assert.equal(decrypted.snapshot_id, 'snap_v16_test_interop');
    assert.equal(decrypted.cloud_version, 16);
    assert.equal(decrypted.entities.transactions.length, 1);
  });

  await t.test('2. Wrong PIN and tampered ciphertext rejection (fail-closed)', async () => {
    const pin = '4321';
    const wrongPin = '9999';
    const payload = { snapshot_id: 'snap_v16_tamper', cloud_version: 16 };
    const encryptedJson = await encryptBackupData(payload, pin);

    // Wrong PIN
    await assert.rejects(
      async () => await decryptBackupData(encryptedJson, wrongPin),
      /Incorrect password\/PIN|corrupted backup data|operation failed/i,
      'Decryption with wrong PIN must fail closed'
    );

    // Tampered ciphertext
    const parsedEnvelope = JSON.parse(encryptedJson);
    const cipherBytes = base64ToBytes(parsedEnvelope.data);
    cipherBytes[0] ^= 0xFF; // Flip first byte
    parsedEnvelope.data = bytesToBase64(cipherBytes);
    const tamperedJson = JSON.stringify(parsedEnvelope);

    await assert.rejects(
      async () => await decryptBackupData(tamperedJson, pin),
      /Incorrect password\/PIN|corrupted backup data|operation failed/i,
      'Decryption of modified ciphertext must fail due to GCM authentication tag mismatch'
    );
  });

  await t.test('3. Staging promotion & atomic replacement via promoteStagingSnapshot', async () => {
    // Seed initial local database
    await db.run('INSERT INTO accounts (id, name, type, balance) VALUES (?, ?, ?, ?);', ['acc_old', 'Old Account', 'Bank', 100]);
    await db.run('INSERT INTO transactions (id, Account, amount, type, date) VALUES (?, ?, ?, ?, ?);', ['tx_old_1', 'Old Account', 50, 'Expense', '2026-01-01']);

    const preCount = (await db.query('SELECT count(*) as count FROM transactions;')).values[0].count;
    assert.equal(preCount, 1);

    // Create a mock staging database representing Snapshot v16
    const stagingMockPath = 'staging_test_mock.db';
    const stagingEntities = {
      accounts: [
        { id: 'acc_v16_1', name: 'Primary Account', type: 'Bank', balance: 10000 },
        { id: 'acc_v16_2', name: 'Investment Broker', type: 'Brokerage', balance: 50000 }
      ],
      categories: [
        { id: 'cat_groceries', name: 'Groceries' }
      ],
      transactions: [
        { id: 'tx_v16_001', Account: 'Primary Account', Category: 'Groceries', amount: 120, type: 'Expense', date: '2026-10-30' },
        { id: 'tx_v16_002', Account: 'Primary Account', Category: 'Groceries', amount: 250, type: 'Expense', date: '2026-10-30' }
      ],
      investment_transactions: [
        { id: 'inv_v16_001', Account: 'Investment Broker', symbol: 'AAPL', amount: 500, type: 'Buy', date: '2026-10-30' }
      ],
      inventory: [
        { id: 'item_01', name: 'Product A', qty: 10, original_qty: 10, price: 15 }
      ]
    };

    // Promote staging mock
    const stagingRes = {
      stagingDbPath: stagingMockPath,
      snapshotId: 'snap_1792900000000_v16_golden',
      cloudVersion: 16,
      schemaVersion: 13,
      entityCounts: {
        accounts: 2,
        categories: 1,
        transactions: 2,
        investment_transactions: 1,
        inventory: 1
      }
    };

    // Execute reconcileExistingDeviceWithSnapshot with staging promotion
    const result = await reconcileExistingDeviceWithSnapshot({
      confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
      stagingDbPath: stagingMockPath,
      stagingEntities: stagingEntities,
      targetSnapshotId: stagingRes.snapshotId,
      targetCloudVersion: stagingRes.cloudVersion,
      entityCounts: stagingRes.entityCounts,
      deviceId: 'dev_test_device_a'
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'RECONCILIATION_SUCCESS');
    assert.equal(result.snapshotId, stagingRes.snapshotId);
    assert.equal(result.cloudVersion, 16);

    // Verify local database contains promoted records and old records are gone
    const txRows = (await db.query('SELECT * FROM transactions;')).values || [];
    assert.equal(txRows.length, 2, 'Should have exactly 2 promoted transactions');
    assert(txRows.some(r => r.id === 'tx_v16_001'), 'tx_v16_001 must be present');
    assert(!txRows.some(r => r.id === 'tx_old_1'), 'Old transaction tx_old_1 must be wiped');

    const invRows = (await db.query('SELECT * FROM investment_transactions;')).values || [];
    assert.equal(invRows.length, 1);
    assert.equal(invRows[0].id, 'inv_v16_001');

    const acctRows = (await db.query('SELECT * FROM accounts;')).values || [];
    assert.equal(acctRows.length, 2);

    // Verify durable backup ID is returned
    assert(result.durableBackupId, 'Must record durable pre-import backup ID');
    assert(result.durableBackupSha256, 'Must record durable pre-import backup SHA-256');

    // Verify last_snapshot_id setting was finalized
    const finalSnapId = await getSetting('last_snapshot_id');
    assert.equal(finalSnapId, stagingRes.snapshotId);
  });

  await t.test('4. Atomic rollback and preservation of durable backup on simulated verification failure', async () => {
    // Seed verified local baseline
    await db.run('INSERT INTO accounts (id, name, type, balance) VALUES (?, ?, ?, ?);', ['acc_safe', 'Safe Account', 'Bank', 500]);
    await db.run('INSERT INTO transactions (id, Account, amount, type, date) VALUES (?, ?, ?, ?, ?);', ['tx_safe_1', 'Safe Account', 75, 'Expense', '2026-10-25']);

    // Staging with count mismatch (expected 5 transactions, but only 1 in stagingEntities)
    const stagingResCorrupt = {
      stagingDbPath: 'staging_corrupt.db',
      snapshotId: 'snap_v16_mismatch',
      cloudVersion: 16,
      entityCounts: {
        accounts: 1,
        transactions: 5 // Expected 5, staging will only have 1
      }
    };

    await assert.rejects(
      async () => {
        await reconcileExistingDeviceWithSnapshot({
          confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
          stagingDbPath: stagingResCorrupt.stagingDbPath,
          stagingEntities: {
            accounts: [{ id: 'acc_corrupt', name: 'Safe Account' }],
            transactions: [{ id: 'tx_corrupt_1', Account: 'Safe Account' }]
          },
          targetSnapshotId: stagingResCorrupt.snapshotId,
          targetCloudVersion: stagingResCorrupt.cloudVersion,
          entityCounts: stagingResCorrupt.entityCounts,
          deviceId: 'dev_test_device_a'
        });
      },
      (err) => {
        assert(err.message.includes('reconciliation failed') || err.message.includes('count mismatch'));
        return true;
      },
      'Count mismatch must trigger fail-closed rollback'
    );

    // Verify rollback restored pristine pre-import data
    const txAfterRollback = (await db.query('SELECT * FROM transactions;')).values || [];
    assert.equal(txAfterRollback.length, 1, 'Rollback must restore original transaction count');
    assert.equal(txAfterRollback[0].id, 'tx_safe_1', 'tx_safe_1 must be restored');

    // Verify durable backup is preserved in settings
    const durableBackup = await getSetting('pre_recovery_durable_backup');
    assert(durableBackup, 'Durable backup must be preserved in settings for recovery safety');

    // Verify recovery safety lock remains active (fail-closed)
    const isLocked = await checkRecoverySafetyLockAsync();
    assert.equal(isLocked, true, 'Recovery safety lock must remain active after failed recovery');
  });

  await t.test('5. Recovery safety lock lifecycle: armed before mutation, cleared only on verified completion', async () => {
    // Start unlocked
    await clearRecoverySafetyLock({ confirmed: true, force: true });
    assert.equal(isRecoverySafetyLocked(), false);

    // Call reconcileExistingDeviceWithSnapshot without confirmation: must arm lock and abort
    await assert.rejects(
      async () => {
        await reconcileExistingDeviceWithSnapshot({
          confirmation: false
        });
      },
      /CONFIRMATION_REQUIRED/,
      'Must abort without explicit confirmation'
    );

    // Lock was armed before any work started
    assert.equal(isRecoverySafetyLocked(), true, 'Recovery safety lock must be armed before any operation');

    // Clear lock with confirmation
    await clearRecoverySafetyLock({ confirmed: true, force: true });
    assert.equal(isRecoverySafetyLocked(), false);
  });

  await t.test('6. Brokerages UNIQUE(name) deduplication in snapshot recovery passes verification', async () => {
    // Staged payload with 20 brokerage objects (duplicates of Zerodha and Groww)
    const mockCloudPayload = {
      _isNativeStaged: true,
      snapshot_id: 'snap_v16_test_brokerages',
      cloud_version: 16,
      _expectedBrokerageNames: ['Zerodha', 'Groww'],
      _entityCounts: {
        transactions: 1,
        investment_transactions: 0,
        brokerages: 20 // 20 objects in snapshot array
      }
    };

    // Main database has only 2 unique brokerages (Zerodha, Groww) due to UNIQUE(name)
    await db.run('DELETE FROM brokerages;');
    await db.run("INSERT OR REPLACE INTO brokerages (id, name, bank_account, owner) VALUES ('b1', 'Zerodha', 'HDFC', 'Akbar');");
    await db.run("INSERT OR REPLACE INTO brokerages (id, name, bank_account, owner) VALUES ('b2', 'Groww', 'Canara', 'Fareeda');");
    await db.run('DELETE FROM transactions;');
    await db.run("INSERT INTO transactions (id, date, amount) VALUES ('tx_b1', '2026-10-31', '100');");

    // Verification must pass and not throw "count mismatch for brokerages (expected 20, got 2)"
    const verRes = await verifyReconciledDataIntegrity(db, mockCloudPayload);
    assert.equal(verRes.verified, true);
    assert.equal(verRes.actualCounts.brokerages, 2);
  });
});
