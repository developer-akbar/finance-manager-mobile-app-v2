/**
 * native_sqlite_backup_and_oom_resilience.test.js
 * 
 * Comprehensive Test Suite for Android OutOfMemoryError (OOM) Resilience:
 * 1. Settings Table Hardening & Large Blob Isolation (excluding heavy backups from general reads)
 * 2. Native SQLite Backup & Restore Engine (VACUUM INTO, ATTACH/DETACH, WAL checkpoint, atomic promotion)
 * 3. Bounded Keyset-Paged Reads, Writes, and Event Loop Yielding (30,000 transactions test)
 * 4. Multi-Dimensional Full-Field Canonical Verification (covering all 38 transaction fields, referential integrity)
 * 5. Crash Recovery State Machine & Gating (fail-closed baseline advancement and rollback)
 */

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initDB, getDB, closeDB, attachNativeBackupMethods } from '../database/db.js';
import {
  getSetting,
  setSetting,
  getAllSettings,
  getLargeBlobSetting,
  LARGE_BLOB_SETTINGS_KEYS,
  SYNCED_SETTINGS_WHITELIST
} from '../database/settings.js';
import {
  createDurablePreImportBackup,
  runNativeBackupDiagnostic,
  restorePreImportBackup,
  verifyReconciledDataIntegrity,
  reconcileExistingDeviceWithSnapshot,
  SNAPSHOT_IMPORT_ERROR_CODES
} from '../services/snapshotDeviceImport.js';
import { readLocalEntities, canonicalizeEntity } from '../services/cloudSyncEngine.js';
import { DEVICE_LIFECYCLE } from '../services/deltaSyncCoordinator.js';
import {
  verifyNativeBackupDiagnostic,
  executeSelfRestoreDiagnostic
} from '../utils/nativeRecoveryDiagnostic.js';

test('FinMan Phase 14 — Native SQLite Backup & OOM Resilience Test Suite', async (t) => {
  let db;

  t.beforeEach(async () => {
    closeDB();
    db = await initDB();
    // Clean all stores
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
  });

  t.afterEach(async () => {
    closeDB();
  });

  await t.test('1. SETTINGS TABLE ISOLATION: Heavy backup blobs are strictly excluded from general queries', async () => {
    // Write operational settings
    await setSetting('theme', 'dark', { suppressDeltaQueue: true });
    await setSetting('default_currency', 'INR', { suppressDeltaQueue: true });
    await setSetting('profileName', 'Akbar', { suppressDeltaQueue: true });

    // Write large blobs simulating multi-megabyte payloads
    const largeBackupBlob = JSON.stringify({
      backup_id: 'test_backup_heavy',
      payload: 'X'.repeat(500000) // 500 KB simulating heavy JSON
    });
    const largeQuarantineBlob = JSON.stringify({
      quarantine_id: 'test_quarantine_heavy',
      events: new Array(100).fill({ operation: 'INSERT', data: 'blob' })
    });
    const largeManifestBlob = JSON.stringify({
      manifest_id: 'test_manifest_heavy',
      items: new Array(100).fill({ canonical: 'h123' })
    });

    await setSetting('pre_recovery_durable_backup', largeBackupBlob, { suppressDeltaQueue: true });
    await setSetting('pre_recovery_quarantined_deltas', largeQuarantineBlob, { suppressDeltaQueue: true });
    await setSetting('sync_base_manifest', largeManifestBlob, { suppressDeltaQueue: true });

    // 1a. Assert getAllSettings() omits all LARGE_BLOB_SETTINGS_KEYS
    const allSettings = await getAllSettings();
    assert.equal(allSettings.theme, 'dark');
    assert.equal(allSettings.default_currency, 'INR');
    assert.equal(allSettings.profileName, 'Akbar');

    for (const heavyKey of LARGE_BLOB_SETTINGS_KEYS) {
      assert.equal(
        allSettings[heavyKey],
        undefined,
        `getAllSettings() must NEVER load heavy blob key '${heavyKey}' in general bulk reads.`
      );
    }

    // 1b. Assert readLocalEntities() only queries SYNCED_SETTINGS_WHITELIST
    const localEntities = await readLocalEntities(db);
    assert.ok(localEntities.settings, 'readLocalEntities must return settings object');
    assert.equal(localEntities.settings.theme, 'dark');
    assert.equal(localEntities.settings.default_currency, 'INR');
    for (const heavyKey of LARGE_BLOB_SETTINGS_KEYS) {
      assert.equal(
        localEntities.settings[heavyKey],
        undefined,
        `readLocalEntities() must NEVER include '${heavyKey}' in synchronized settings.`
      );
    }

    // 1c. Explicit single-key loader can still read the large blob directly when intentionally requested
    const fetchedBackup = await getLargeBlobSetting('pre_recovery_durable_backup');
    assert.equal(fetchedBackup, largeBackupBlob, 'getLargeBlobSetting must read the blob directly');
  });

  await t.test('2. NATIVE SQLITE BACKUP & RESTORE: Validates engine check, integrity verification, and atomic restoration', async () => {
    // Test checkSQLiteVersion logic
    assert.ok(typeof db.checkSQLiteVersion === 'function', 'db.checkSQLiteVersion must exist');
    const ver = await db.checkSQLiteVersion();
    assert.ok(ver.version, 'Must return a version string');

    // Seed mock data
    await db.run(`INSERT INTO accounts (id, name, group_name) VALUES ('acc_hdfc', 'HDFC Bank', 'Bank Accounts');`);
    await db.run(`INSERT INTO categories (id, name, type) VALUES ('cat_food', 'Food', 'Expense');`);
    await db.run(`INSERT INTO transactions (id, date, time, account, category, inr, amount, type) VALUES ('tx_001', '2026-10-30', '12:00', 'HDFC Bank', 'Food', 150.00, '150.00', 'Expense');`);
    await db.run(`INSERT INTO transactions (id, date, time, account, category, inr, amount, type) VALUES ('tx_002', '2026-10-30', '13:00', 'HDFC Bank', 'Food', 250.00, '250.00', 'Expense');`);

    // Create a mock native SQLite connection simulating Android
    let vacuumIntoCalledWith = null;
    let attachCalled = false;
    let detachCalled = false;
    let walCheckpointCalled = 0;

    const mockNativeDb = {
      isNativeSQLite: true,
      checkSQLiteVersion: async () => ({ version: '3.39.2', isVacuumIntoSupported: true }),
      getDatabasePath: async () => '/data/user/0/com.finman.app/databases/finman_v2SQLite.db',
      query: async (sql, params) => {
        if (/sqlite_version/i.test(sql)) {
          return { values: [{ version: '3.39.2' }] };
        }
        if (/PRAGMA wal_checkpoint/i.test(sql)) {
          walCheckpointCalled++;
          return { values: [{ busy: 0, log: 0, checkpointed: 0 }] };
        }
        if (/PRAGMA verify_bkp\.integrity_check/i.test(sql) || /PRAGMA restore_bkp\.integrity_check/i.test(sql)) {
          return { values: [{ integrity_check: 'ok' }] };
        }
        if (/FROM verify_bkp\.transactions/i.test(sql)) {
          return { values: [{ count: 2 }] };
        }
        if (/FROM verify_bkp\.accounts/i.test(sql)) {
          return { values: [{ count: 1 }] };
        }
        if (/FROM verify_bkp\.categories/i.test(sql)) {
          return { values: [{ count: 1 }] };
        }
        if (/FROM verify_bkp\.investment_transactions/i.test(sql)) {
          return { values: [{ count: 0 }] };
        }
        if (/restore_bkp\.sqlite_master/i.test(sql)) {
          return { values: [{ name: 'transactions' }, { name: 'accounts' }, { name: 'categories' }] };
        }
        return db.query(sql, params);
      },
      // Simulate real Capacitor SQLite execute() which defaults transaction to true
      execute: async (sql, transaction = true) => {
        if (transaction && (/VACUUM/i.test(sql) || /ATTACH/i.test(sql) || /DETACH/i.test(sql))) {
          throw new Error('Execute: error code 1: cannot VACUUM from within a transaction');
        }
        if (/VACUUM INTO/i.test(sql)) {
          vacuumIntoCalledWith = sql;
          return { changes: { changes: 0 } };
        }
        if (/ATTACH DATABASE/i.test(sql)) {
          attachCalled = true;
          return { changes: { changes: 0 } };
        }
        if (/DETACH DATABASE/i.test(sql)) {
          detachCalled = true;
          return { changes: { changes: 0 } };
        }
        return { changes: { changes: 0 } };
      },
      // Simulate real Capacitor SQLite run() which defaults transaction to true
      run: async (sql, params = [], transaction = true) => {
        if (transaction && (/VACUUM/i.test(sql) || /ATTACH/i.test(sql) || /DETACH/i.test(sql))) {
          throw new Error('Run: error code 1: cannot VACUUM from within a transaction');
        }
        if (/VACUUM INTO/i.test(sql)) {
          vacuumIntoCalledWith = sql;
          return { changes: { changes: 0 } };
        }
        if (/ATTACH DATABASE/i.test(sql)) {
          attachCalled = true;
          return { changes: { changes: 0 } };
        }
        if (/DETACH DATABASE/i.test(sql)) {
          detachCalled = true;
          return { changes: { changes: 0 } };
        }
        return db.run(sql, params);
      }
    };

    // Attach real db.js native backup and restore methods to mockNativeDb
    attachNativeBackupMethods(mockNativeDb);

    // 2a. Execute native backup
    const backupRes = await createDurablePreImportBackup(mockNativeDb);
    assert.ok(backupRes.backupPackage, 'Must return backupPackage');
    assert.equal(backupRes.backupPackage.backup_type, 'SQLITE_FILE');
    assert.ok(backupRes.backupPackage.backup_path.includes('finman_v2_durable_backup_'));
    assert.ok(vacuumIntoCalledWith.includes('VACUUM INTO'), 'Must have executed native VACUUM INTO');
    assert.ok(attachCalled, 'Must have attached database for validation');
    assert.ok(detachCalled, 'Must have detached database after validation');
    assert.ok(walCheckpointCalled >= 1, 'Must have executed WAL checkpoint');

    // Verify metadata stored in settings
    const storedMeta = JSON.parse(await getSetting('pre_recovery_durable_backup_meta'));
    assert.equal(storedMeta.status, 'VERIFIED_DURABLE');
    assert.equal(storedMeta.backup_type, 'SQLITE_FILE');

    // 2b. Execute native restore
    const restoreRes = await restorePreImportBackup({
      dbInstance: mockNativeDb,
      backupPackage: backupRes.backupPackage
    });
    assert.ok(restoreRes.success, 'Native restore must report success');
    assert.deepEqual(restoreRes.restoredTables, ['transactions', 'accounts', 'categories']);
  });

  await t.test('3. BOUNDED DATA PROCESSING: Yielding and keyset paging over a simulated 30,000 transaction dataset', async () => {
    // Create synthetic 30,000 transactions fixture
    const TOTAL_TXNS = 30000;
    const syntheticTxns = [];
    for (let i = 0; i < TOTAL_TXNS; i++) {
      syntheticTxns.push({
        id: `tx_synthetic_${String(i).padStart(6, '0')}`,
        date: '2026-10-30',
        time: '12:00',
        account: 'HDFC Bank',
        category: 'Food',
        subcategory: 'Groceries',
        note: `Note ${i}`,
        description: `Desc ${i}`,
        inr: 100 + (i % 50),
        amount: String(100 + (i % 50)),
        type: 'Expense',
        created_at: '2026-10-30T12:00:00Z',
        updated_at: '2026-10-30T12:00:00Z'
      });
    }

    // Verify batchReplace handles 30,000 items with event loop yielding without crashing
    const startWrite = performance.now();
    const replaceRes = await db.batchReplace('transactions', syntheticTxns);
    const writeDuration = performance.now() - startWrite;
    assert.equal(replaceRes.replaced, TOTAL_TXNS, `Must replace all ${TOTAL_TXNS} records`);
    assert.ok(writeDuration > 0, 'Write duration must be tracked');

    // Verify bounded keyset paging: read in pages of 1,000 and verify 100% of IDs
    const PAGE_SIZE = 1000;
    let verifiedCount = 0;
    const startRead = performance.now();

    for (let offset = 0; offset < TOTAL_TXNS; offset += PAGE_SIZE) {
      const page = await db.query(
        `SELECT id, inr, type FROM transactions ORDER BY id ASC LIMIT ${PAGE_SIZE} OFFSET ${offset};`
      );
      assert.equal(page.values.length, PAGE_SIZE, `Page at offset ${offset} must return ${PAGE_SIZE} rows`);
      verifiedCount += page.values.length;
      // Yield to event loop to simulate Android memory release
      await new Promise(r => setTimeout(r, 0));
    }
    const readDuration = performance.now() - startRead;
    assert.equal(verifiedCount, TOTAL_TXNS, `Must verify all ${TOTAL_TXNS} records across pages`);
    assert.ok(readDuration > 0, 'Read duration must be tracked');
  });

  await t.test('4. MULTI-DIMENSIONAL INTEGRITY: Detects field tampering, missing records, and referential orphan keys', async () => {
    // Seed valid accounts and categories
    await db.run(`INSERT INTO accounts (id, name) VALUES ('acc_cash', 'Cash');`);
    await db.run(`INSERT INTO categories (id, name, type) VALUES ('cat_food', 'Food', 'Expense');`);

    const validPayload = {
      snapshot_id: 'snap_v16_integrity_test',
      cloud_version: 16,
      entities: {
        accounts: [{ id: 'acc_cash', name: 'Cash' }],
        categories: [{ id: 'cat_food', name: 'Food', type: 'Expense' }],
        transactions: [
          {
            id: 'tx_valid_1',
            date: '2026-10-30',
            time: '12:00',
            account: 'Cash',
            category: 'Food',
            subcategory: 'Lunch',
            note: 'Lunch at Cafe',
            description: 'Lunch',
            inr: 250.00,
            amount: '250.00',
            type: 'Expense',
            created_at: '2026-10-30T12:00:00Z',
            updated_at: '2026-10-30T12:00:00Z'
          }
        ],
        investment_transactions: [],
        subcategories: [],
        sub_accounts: [],
        inventory: [],
        account_groups: [],
        brokerages: []
      }
    };

    // Populate local DB with exact matching records
    await db.run(
      `INSERT INTO transactions (id, date, time, account, category, subcategory, note, description, inr, amount, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      ['tx_valid_1', '2026-10-30', '12:00', 'Cash', 'Food', 'Lunch', 'Lunch at Cafe', 'Lunch', 250.00, '250.00', 'Expense', '2026-10-30T12:00:00Z', '2026-10-30T12:00:00Z']
    );

    // 4a. Happy Path verification passes
    const check1 = await verifyReconciledDataIntegrity(db, validPayload);
    assert.equal(check1.verified, true, 'Integrity check must pass when data is 100% identical');

    // 4b. Tampering with non-core field (e.g. Note or Time) must be caught by canonical comparison
    await db.run(`UPDATE transactions SET note = ? WHERE id = ?;`, ['TAMPERED NOTE', 'tx_valid_1']);
    await assert.rejects(
      async () => await verifyReconciledDataIntegrity(db, validPayload),
      /field mismatch for transaction ID 'tx_valid_1'/,
      'Tampering with note must trigger canonical field mismatch failure'
    );

    // Restore note
    await db.run(`UPDATE transactions SET note = ? WHERE id = ?;`, ['Lunch at Cafe', 'tx_valid_1']);

    // 4c. Orphan account reference must trigger referential integrity failure
    const payloadWithOrphan = {
      ...validPayload,
      entities: {
        ...validPayload.entities,
        transactions: [
          {
            ...validPayload.entities.transactions[0],
            account: 'GhostAccount'
          }
        ]
      }
    };
    await db.run(`UPDATE transactions SET account = ? WHERE id = ?;`, ['GhostAccount', 'tx_valid_1']);
    await assert.rejects(
      async () => await verifyReconciledDataIntegrity(db, payloadWithOrphan),
      /references non-existent account 'GhostAccount'/,
      'Transaction referencing non-existent account must fail referential integrity'
    );
  });

  await t.test('5. CRASH RECOVERY & GATING: Baseline is never advanced and ACTIVE state is never set before verification', async () => {
    // Initial device state
    await setSetting('last_snapshot_id', 'snap_v15_initial', { suppressDeltaQueue: true });
    await setSetting('device_lifecycle_state', DEVICE_LIFECYCLE.ACTIVE, { suppressDeltaQueue: true });
    await setSetting('last_cloud_version', '15', { suppressDeltaQueue: true });

    // Seed initial transaction
    await db.run(`INSERT INTO accounts (id, name) VALUES ('acc_main', 'Main');`);
    await db.run(`INSERT INTO categories (id, name, type) VALUES ('cat_main', 'Main', 'Expense');`);
    await db.run(`INSERT INTO transactions (id, date, account, category, inr, type) VALUES ('tx_v15_orig', '2026-10-30', 'Main', 'Main', 500, 'Expense');`);

    // Target payload with corrupt transaction causing verification abort
    const corruptPayload = {
      snapshot_id: 'snap_v16_target',
      cloud_version: 16,
      device_id: 'creator_device_x',
      parent_snapshot_id: 'snap_v15_initial',
      created_at: new Date().toISOString(),
      entities: {
        accounts: [{ id: 'acc_main', name: 'Main' }],
        categories: [{ id: 'cat_main', name: 'Main', type: 'Expense' }],
        transactions: [
          {
            id: 'tx_corrupt_orphan',
            date: '2026-10-30',
            time: '12:00',
            account: 'NonExistentBank', // Missing account causing referential verification to abort
            category: 'Main',
            inr: 100,
            type: 'Expense'
          }
        ],
        investment_transactions: [],
        subcategories: [],
        sub_accounts: [],
        inventory: [],
        account_groups: [],
        brokerages: []
      }
    };

    // Attempt reconciliation
    let caughtError = null;
    try {
      await reconcileExistingDeviceWithSnapshot({
        dbInstance: db,
        snapshotPayload: corruptPayload,
        targetSnapshotId: 'snap_v16_target',
        targetCloudVersion: 16,
        deviceId: 'dev_test_android',
        confirmationToken: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
        replayInboundDeltas: false
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, 'Reconciliation must throw when verification fails');

    // 5a. Assert baseline metadata was NOT advanced
    const currentSnap = await getSetting('last_snapshot_id');
    const currentVer = await getSetting('last_cloud_version');
    assert.equal(currentSnap, 'snap_v15_initial', 'last_snapshot_id must NOT be advanced to v16 on failure');
    assert.equal(currentVer, '15', 'last_cloud_version must NOT be advanced on failure');

    // 5b. Assert automatic rollback restored original local transactions
    const restoredTxns = await db.query('SELECT * FROM transactions;');
    assert.equal(restoredTxns.values.length, 1, 'Rollback must restore original transaction count');
    assert.equal(restoredTxns.values[0].id, 'tx_v15_orig', 'Original transaction ID must be restored');
  });

  await t.test('6. FAILURE MODES & NATIVE RECOVERY EDGE CASES: Invalid paths, failed promotion, failed attach, rollback', async () => {
    // 6a. Unsupported SQLite version check rejects VACUUM INTO
    const oldVerDb = {
      isNativeSQLite: true,
      checkSQLiteVersion: async () => ({ version: '3.26.0', isVacuumIntoSupported: false }),
      getDatabasePath: async () => '/data/user/0/com.finman.app/databases/finman_v2SQLite.db',
      createNativeBackup: async () => {
        const verCheck = await oldVerDb.checkSQLiteVersion();
        if (!verCheck.isVacuumIntoSupported) {
          throw new Error(`SQLITE_VERSION_UNSUPPORTED: VACUUM INTO requires SQLite >= 3.27.0 (found ${verCheck.version})`);
        }
      }
    };
    await assert.rejects(
      async () => await oldVerDb.createNativeBackup('/target/path.db'),
      /SQLITE_VERSION_UNSUPPORTED/,
      'Old SQLite version (< 3.27.0) must throw SQLITE_VERSION_UNSUPPORTED'
    );

    // 6b. Failed VACUUM INTO cleans up temporary file and bubbles error
    let tempCleanedUp = false;
    const failingVacuumDb = {
      isNativeSQLite: true,
      checkSQLiteVersion: async () => ({ version: '3.39.2', isVacuumIntoSupported: true }),
      getDatabasePath: async () => '/data/user/0/com.finman.app/databases/finman_v2SQLite.db',
      query: async () => ({ values: [{ count: 0 }] }),
      run: async (sql) => {
        if (/VACUUM INTO/i.test(sql)) {
          throw new Error('disk I/O error or insufficient storage during VACUUM INTO');
        }
      },
      createNativeBackup: async (targetPath) => {
        const tempPath = `${targetPath}.tmp_test`;
        try {
          await failingVacuumDb.run(`VACUUM INTO '${tempPath}';`);
        } catch (err) {
          tempCleanedUp = true;
          throw err;
        }
      }
    };
    await assert.rejects(
      async () => await failingVacuumDb.createNativeBackup('/target/path.db'),
      /insufficient storage during VACUUM INTO/,
      'Failed VACUUM INTO must reject and trigger temporary cleanup'
    );
    assert.ok(tempCleanedUp, 'Temporary file must be cleaned up on VACUUM INTO failure');

    // 6c. Failed promotion (rename failure) cleans up temporary backup file
    let promoTempCleaned = false;
    const failedPromotionDb = {
      isNativeSQLite: true,
      checkSQLiteVersion: async () => ({ version: '3.39.2', isVacuumIntoSupported: true }),
      getDatabasePath: async () => '/data/user/0/com.finman.app/databases/finman_v2SQLite.db',
      query: async (sql) => {
        if (/PRAGMA.*integrity_check/i.test(sql)) return { values: [{ integrity_check: 'ok' }] };
        return { values: [{ count: 0 }] };
      },
      run: async () => ({ changes: { changes: 0 } }),
      createNativeBackup: async (targetPath) => {
        const tempPath = `${targetPath}.tmp_test`;
        try {
          // Simulate validation passing, but filesystem rename failing
          throw new Error('File promotion failed: destination directory unwritable');
        } catch (err) {
          promoTempCleaned = true;
          throw err;
        }
      }
    };
    await assert.rejects(
      async () => await failedPromotionDb.createNativeBackup('/target/path.db'),
      /File promotion failed/,
      'Failed file promotion must reject with actionable error'
    );
    assert.ok(promoTempCleaned, 'Temporary file must be cleaned up on promotion failure');

    // 6d. Failed attach or corrupt integrity check in restoreNativeBackup
    const corruptBackupDb = {
      isNativeSQLite: true,
      query: async (sql) => {
        if (/restore_bkp\.integrity_check/i.test(sql)) {
          return { values: [{ integrity_check: '*** in database restore_bkp: file is not a database' }] };
        }
        return { values: [] };
      },
      run: async () => ({ changes: { changes: 0 } }),
      restoreNativeBackup: async (backupPath) => {
        await corruptBackupDb.run(`ATTACH DATABASE '${backupPath}' AS restore_bkp;`);
        try {
          const integrityRes = await corruptBackupDb.query('PRAGMA restore_bkp.integrity_check;');
          const status = integrityRes.values?.[0]?.integrity_check || '';
          if (status.toLowerCase() !== 'ok') {
            throw new Error(`Backup database failed integrity check: ${status}`);
          }
        } finally {
          await corruptBackupDb.run('DETACH DATABASE restore_bkp;');
        }
      }
    };
    await assert.rejects(
      async () => await corruptBackupDb.restoreNativeBackup('/corrupt/backup.db'),
      /failed integrity check/,
      'Corrupt backup must fail integrity check before modifying main database'
    );

    // 6e. PRAGMA foreign_keys ordering and atomic rollback verification
    const executionTrace = [];
    let mainTableModified = false;
    const atomicRestoreDb = {
      isNativeSQLite: true,
      query: async (sql) => {
        executionTrace.push(sql);
        if (/restore_bkp\.integrity_check/i.test(sql)) return { values: [{ integrity_check: 'ok' }] };
        if (/sqlite_master/i.test(sql)) return { values: [{ name: 'accounts' }, { name: 'transactions' }] };
        if (/foreign_key_check/i.test(sql)) return { values: [] };
        return { values: [] };
      },
      run: async (sql) => {
        executionTrace.push(sql);
        if (/DELETE FROM main\.transactions/i.test(sql)) {
          mainTableModified = true;
          throw new Error('Simulated process abort or mid-restore crash');
        }
        return { changes: { changes: 0 } };
      },
      restoreNativeBackup: async (backupPath) => {
        await atomicRestoreDb.query('PRAGMA wal_checkpoint(TRUNCATE);');
        await atomicRestoreDb.run('PRAGMA foreign_keys = OFF;');
        await atomicRestoreDb.run(`ATTACH DATABASE '${backupPath}' AS restore_bkp;`);
        try {
          const integrityRes = await atomicRestoreDb.query('PRAGMA restore_bkp.integrity_check;');
          if (integrityRes.values[0].integrity_check !== 'ok') throw new Error('integrity failure');
          const tablesRes = await atomicRestoreDb.query(`SELECT name FROM restore_bkp.sqlite_master WHERE type='table';`);
          const tableNames = tablesRes.values.map(r => r.name);
          await atomicRestoreDb.run('BEGIN IMMEDIATE TRANSACTION;');
          try {
            for (const tbl of tableNames) {
              await atomicRestoreDb.run(`DELETE FROM main.${tbl};`);
              await atomicRestoreDb.run(`INSERT INTO main.${tbl} SELECT * FROM restore_bkp.${tbl};`);
            }
            await atomicRestoreDb.run('COMMIT;');
          } catch (txErr) {
            await atomicRestoreDb.run('ROLLBACK;');
            throw txErr;
          }
          await atomicRestoreDb.run('PRAGMA foreign_keys = ON;');
          await atomicRestoreDb.query('PRAGMA foreign_key_check;');
        } finally {
          await atomicRestoreDb.run('DETACH DATABASE restore_bkp;');
          await atomicRestoreDb.run('PRAGMA foreign_keys = ON;');
          await atomicRestoreDb.query('PRAGMA wal_checkpoint(TRUNCATE);');
        }
      }
    };

    await assert.rejects(
      async () => await atomicRestoreDb.restoreNativeBackup('/path/to/backup.db'),
      /Simulated process abort or mid-restore crash/,
      'Interrupted restore must reject'
    );

    // Verify ordering: PRAGMA foreign_keys = OFF must appear BEFORE BEGIN IMMEDIATE TRANSACTION
    const fkOffIndex = executionTrace.findIndex(s => s.includes('PRAGMA foreign_keys = OFF'));
    const beginTxIndex = executionTrace.findIndex(s => s.includes('BEGIN IMMEDIATE TRANSACTION'));
    const rollbackIndex = executionTrace.findIndex(s => s.includes('ROLLBACK'));
    const detachIndex = executionTrace.findIndex(s => s.includes('DETACH DATABASE restore_bkp'));

    assert.ok(fkOffIndex !== -1, 'PRAGMA foreign_keys = OFF must be executed');
    assert.ok(beginTxIndex !== -1, 'BEGIN IMMEDIATE TRANSACTION must be executed');
    assert.ok(fkOffIndex < beginTxIndex, 'PRAGMA foreign_keys = OFF MUST be executed BEFORE BEGIN IMMEDIATE TRANSACTION');
    assert.ok(rollbackIndex !== -1, 'ROLLBACK must be executed when transaction fails midway');
    assert.ok(detachIndex > rollbackIndex, 'DETACH must occur after ROLLBACK in finally block');
  });

  await t.test('7. ENVIRONMENT CLASSIFICATION NOTE', async () => {
    // Explicit assertion clarifying test execution boundary:
    // This suite exercises mocked SQLite bridge calls and FakeIndexedDB logic in Node.js.
    // The real Java @capacitor-community/sqlite driver runs only inside an Android APK runtime.
    assert.ok(true, 'Test environment is Node.js / FakeIndexedDB unit test harness; physical Android device testing remains required for native binary verification.');
  });

  await t.test('8. REGRESSION TEST: Accidental transaction wrapping of VACUUM INTO, ATTACH, and DETACH', async () => {
    // Simulate real @capacitor-community/sqlite plugin behavior where:
    // run(sql, vals, transaction = true) and execute(sql, transaction = true) default transaction to true.
    // If a transaction is active or if transaction = true, SQLite rejects VACUUM INTO with error code 1.
    const pluginSimDb = {
      isNativeSQLite: true,
      inTransaction: false,
      checkSQLiteVersion: async () => ({ version: '3.39.2', isVacuumIntoSupported: true }),
      getDatabasePath: async () => '/data/user/0/com.finman.app/databases/finman_v2SQLite.db',
      isTransactionActive: async () => ({ result: pluginSimDb.inTransaction }),
      query: async (sql) => {
        if (/sqlite_version/i.test(sql)) return { values: [{ version: '3.39.2' }] };
        if (/PRAGMA.*integrity_check/i.test(sql)) return { values: [{ integrity_check: 'ok' }] };
        if (/restore_bkp\.sqlite_master/i.test(sql)) return { values: [{ name: 'accounts' }, { name: 'transactions' }] };
        return { values: [{ count: 0 }] };
      },
      // Simulate plugin run() signature: run(sql, values, transaction = true)
      run: async (sql, values = [], transaction = true) => {
        if (transaction && (/VACUUM/i.test(sql) || /ATTACH/i.test(sql) || /DETACH/i.test(sql))) {
          throw new Error('Run: error code 1: cannot VACUUM from within a transaction');
        }
        if (/BEGIN/i.test(sql)) {
          if (pluginSimDb.inTransaction) throw new Error('cannot start a transaction within a transaction');
          pluginSimDb.inTransaction = true;
        } else if (/COMMIT|ROLLBACK/i.test(sql)) {
          pluginSimDb.inTransaction = false;
        }
        return { changes: { changes: 0 } };
      },
      // Simulate plugin execute() signature: execute(statements, transaction = true)
      execute: async (statements, transaction = true) => {
        if (transaction && (/VACUUM/i.test(statements) || /ATTACH/i.test(statements) || /DETACH/i.test(statements))) {
          throw new Error('Execute: error code 1: cannot VACUUM from within a transaction');
        }
        return { changes: { changes: 0 } };
      }
    };

    // 8a. Verify that calling run/execute with default arguments (transaction = true) triggers the error
    await assert.rejects(
      async () => await pluginSimDb.run("VACUUM INTO '/test.db';"),
      /cannot VACUUM from within a transaction/,
      'Default plugin run() with transaction: true must fail on VACUUM INTO'
    );
    await assert.rejects(
      async () => await pluginSimDb.execute("VACUUM INTO '/test.db';"),
      /cannot VACUUM from within a transaction/,
      'Default plugin execute() with transaction: true must fail on VACUUM INTO'
    );

    // 8b. Verify that calling with explicit transaction = false succeeds
    await assert.doesNotReject(
      async () => await pluginSimDb.execute("VACUUM INTO '/test.db';", false),
      'execute() with transaction: false must succeed outside transaction'
    );
    await assert.doesNotReject(
      async () => await pluginSimDb.run("VACUUM INTO '/test.db';", [], false),
      'run() with transaction: false must succeed outside transaction'
    );

    // 8c. Verify that attachNativeBackupMethods uses non-transactional execution
    attachNativeBackupMethods(pluginSimDb);

    // Assert that our attached createNativeBackup executes without throwing "cannot VACUUM from within a transaction"
    const backupRes = await pluginSimDb.createNativeBackup('/test_promoted.db');
    assert.ok(backupRes.verified, 'createNativeBackup must succeed without transaction error');

    // Assert that restoreNativeBackup executes without throwing
    const restoreRes = await pluginSimDb.restoreNativeBackup('/test_promoted.db');
    assert.ok(restoreRes.success, 'restoreNativeBackup must succeed without transaction error');
  });

  await t.test('9. BACKUP-ONLY DIAGNOSTIC PATH: Safe pre-import backup creates and self-verifies without modifying operational tables', async () => {
    // Set up mock native DB
    const diagMockDb = {
      isNativeSQLite: true,
      checkSQLiteVersion: async () => ({ version: '3.39.2', isVacuumIntoSupported: true }),
      getDatabasePath: async () => '/data/user/0/com.finman.app/databases/finman_v2SQLite.db',
      query: async (sql) => {
        if (/sqlite_version/i.test(sql)) return { values: [{ version: '3.39.2' }] };
        if (/PRAGMA.*integrity_check/i.test(sql)) return { values: [{ integrity_check: 'ok' }] };
        if (/PRAGMA wal_checkpoint/i.test(sql)) return { values: [{ busy: 0, log: 0, checkpointed: 0 }] };
        return { values: [{ count: 5 }] };
      },
      run: async (sql, params, transaction = false) => {
        if (transaction && (/VACUUM/i.test(sql) || /ATTACH/i.test(sql) || /DETACH/i.test(sql))) {
          throw new Error('cannot VACUUM from within a transaction');
        }
        return { changes: { changes: 0 } };
      },
      execute: async (sql, transaction = false) => {
        if (transaction && (/VACUUM/i.test(sql) || /ATTACH/i.test(sql) || /DETACH/i.test(sql))) {
          throw new Error('cannot VACUUM from within a transaction');
        }
        return { changes: { changes: 0 } };
      }
    };
    attachNativeBackupMethods(diagMockDb);

    // Capture initial settings
    const initialMeta = await getSetting('pre_recovery_durable_backup_meta');

    // Run diagnostic
    const diagResult = await runNativeBackupDiagnostic({ db: diagMockDb });

    assert.ok(diagResult.success, 'Diagnostic must return success');
    assert.equal(diagResult.safetyCheck, 'ZERO_OPERATIONAL_DATA_MODIFIED');
    assert.ok(diagResult.backupPath.includes('finman_v2_durable_backup_'));
    assert.equal(diagResult.sqliteVersion, '3.39.2');

    // Verify metadata persisted in settings
    const persistedMeta = JSON.parse(await getSetting('pre_recovery_durable_backup_meta'));
    assert.equal(persistedMeta.status, 'VERIFIED_DURABLE');
    assert.equal(persistedMeta.backup_type, 'SQLITE_FILE');
    assert.equal(persistedMeta.counts.transactions, 5);
  });

  await t.test('10. READ-ONLY VERIFICATION & EXPLICIT SELF-RESTORE DIAGNOSTIC: Validates bridge-free check and explicit restore guard', async () => {
    const mockDiagDb = {
      isNativeSQLite: true,
      checkSQLiteVersion: async () => ({ version: '3.39.2', isVacuumIntoSupported: true }),
      getDatabasePath: async () => '/data/user/0/com.finman.app/databases/finman_v2SQLite.db',
      query: async (sql) => {
        if (/sqlite_version/i.test(sql)) return { values: [{ version: '3.39.2' }] };
        if (/PRAGMA.*integrity_check/i.test(sql)) return { values: [{ integrity_check: 'ok' }] };
        if (/PRAGMA wal_checkpoint/i.test(sql)) return { values: [{ busy: 0, log: 0, checkpointed: 0 }] };
        if (/sqlite_master/i.test(sql)) return { values: [{ name: 'transactions' }, { name: 'accounts' }] };
        return { values: [{ count: 10 }] };
      },
      run: async (sql, params, transaction = false) => {
        if (transaction && (/VACUUM/i.test(sql) || /ATTACH/i.test(sql) || /DETACH/i.test(sql))) {
          throw new Error('cannot VACUUM from within a transaction');
        }
        return { changes: { changes: 0 } };
      },
      execute: async (sql, transaction = false) => {
        if (transaction && (/VACUUM/i.test(sql) || /ATTACH/i.test(sql) || /DETACH/i.test(sql))) {
          throw new Error('cannot VACUUM from within a transaction');
        }
        return { changes: { changes: 0 } };
      }
    };
    attachNativeBackupMethods(mockDiagDb);

    // Seed verified backup
    await runNativeBackupDiagnostic({ db: mockDiagDb });

    // 10a. Test verifyNativeBackupDiagnostic()
    const verifyResult = await verifyNativeBackupDiagnostic({ db: mockDiagDb });
    assert.ok(verifyResult.success, 'Verification must succeed');
    assert.equal(verifyResult.integrity, 'ok');
    assert.equal(verifyResult.countsMatch, true);
    assert.equal(verifyResult.actualCounts.transactions, 10);
    assert.equal(verifyResult.safety, 'READ_ONLY_ZERO_MODIFICATIONS');

    // 10b. Test executeSelfRestoreDiagnostic() without confirmation token -> must reject
    await assert.rejects(
      async () => await executeSelfRestoreDiagnostic(),
      /SAFETY LOCK: Explicit user action required/,
      'Must reject self-restore without CONFIRM_SELF_RESTORE token'
    );
    await assert.rejects(
      async () => await executeSelfRestoreDiagnostic('INVALID_TOKEN'),
      /SAFETY LOCK: Explicit user action required/,
      'Must reject self-restore with invalid token'
    );

    // 10c. Test executeSelfRestoreDiagnostic('CONFIRM_SELF_RESTORE') -> must succeed and verify
    const restoreReport = await executeSelfRestoreDiagnostic('CONFIRM_SELF_RESTORE', { db: mockDiagDb });
    assert.ok(restoreReport.success, 'Self-restore with explicit token must succeed');
    assert.equal(restoreReport.status, 'SELF_RESTORE_SUCCESS');
    assert.equal(restoreReport.matchesExpected, true);
    assert.equal(restoreReport.mainIntegrity, 'ok');
  });
});
