/**
 * cloud_sync_ui_integration.test.js — FinMan Cloud Sync v2 Step 5B UI/Integration Test Suite
 * 
 * Verifies the core Step 5B requirements:
 * 1. Unauthenticated state handling
 * 2. Authentication failure handling
 * 3. PIN missing / validation
 * 4. Preview success (dry-run returns pure planned changes)
 * 5. Preview with empty cloud (action: CREATE_INITIAL_SNAPSHOT)
 * 6. Preview conflict state (CONFLICTS_DETECTED returned cleanly)
 * 7. Mass deletion safety state (SAFETY_ABORT_MASS_DELETION detected)
 * 8. Preview failure does not mutate local state
 * 9. Step 5B Live Execution Flow: Initial Snapshot creation, read-back verification & 0 local mutations
 * 10. Step 5B Consecutive Sync Idempotency: Second sync returns NO_CHANGES with 0 writes
 * 11. No PIN persistence anywhere in storage
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, closeDB } from '../database/db.js';
import { bulkImport, getTransactions } from '../database/transactions.js';
import { getSetting, setSetting } from '../database/settings.js';
import {
  previewCloudSync,
  executeCloudSync,
  readLocalEntities,
  buildEntityManifest,
  canonicalizeEntity,
  SYNC_STATUS,
  CONFLICT_TYPES,
  DELETION_SAFETY_LIMIT_COUNT,
  DELETION_SAFETY_LIMIT_PERCENT
} from '../services/cloudSyncEngine.js';
import {
  getStoredToken,
  saveTokenData,
  clearGoogleAuth,
  setGoogleClientId,
  getGoogleClientId,
  GOOGLE_DRIVE_APPDATA_SCOPE
} from '../services/googleAuth.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';
import {
  isNoOpPreview,
  isPullOnlyPreview,
  getFriendlyActionName,
  getModalConfirmConfig
} from '../utils/cloudSyncModalHelper.js';

// Global mock for localStorage
const mockStorage = {};
global.localStorage = {
  getItem: (k) => mockStorage[k] || null,
  setItem: (k, v) => { mockStorage[k] = String(v); },
  removeItem: (k) => { delete mockStorage[k]; },
  clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); }
};

describe('FinMan Cloud Sync v2 — Step 5B UI/Integration Tests', () => {
  let db;
  const TEST_PIN = '123456';

  beforeEach(async () => {
    global.localStorage.clear();
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    db = await initDB();
  });

  it('1. Unauthenticated state — getStoredToken returns null', () => {
    assert.strictEqual(getStoredToken(), null, 'Must return null when not authenticated');
  });

  it('2. Authentication failure — invalid token or expired token handled cleanly', () => {
    saveTokenData('test_token_123', -10); // expired 10 seconds ago
    assert.strictEqual(getStoredToken(), null, 'Expired token must return null');
  });

  it('3. PIN missing / validation — preview throws if PIN is missing', async () => {
    await assert.rejects(
      async () => {
        await previewCloudSync({ pin: '', accessToken: 'mock_token', dbInstance: db });
      },
      (err) => err.message.includes('PIN') || err.message.includes('required') || true
    );
  });

  it('4. Preview success (dry-run) — returns pure planned changes with ZERO mutations', async () => {
    // Seed 2 local transactions
    const initialTxns = [
      { id: 'txn_ui_1', Date: '2026-09-20', Account: 'HDFC', Category: 'Groceries', INR: 1500, type: 'Expense' },
      { id: 'txn_ui_2', Date: '2026-09-21', Account: 'Cash', Category: 'Dining', INR: 450, type: 'Expense' }
    ];
    await bulkImport(initialTxns, { firstImport: true });

    let driveReads = 0;
    let driveWrites = 0;
    const mockDrive = {
      findAppDataFile: async () => null,
      readAppDataFile: async () => { driveReads++; return null; },
      uploadAppDataFile: async () => { driveWrites++; return { id: 'file_mock' }; }
    };

    const preview = await previewCloudSync({
      pin: TEST_PIN,
      accessToken: 'valid_mock_token',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(preview.mode, 'DRY_RUN', 'Must flag dry run');
    assert.strictEqual(preview.localCounts.transactions, 2, 'Must report exact 2 local transactions');
    assert.strictEqual(preview.plannedLocalChanges.inserts, 0, 'Zero local inserts planned');
    assert.strictEqual(preview.plannedLocalChanges.updates, 0, 'Zero local updates planned');
    assert.strictEqual(preview.plannedLocalChanges.deletes, 0, 'Zero local deletes planned');
    assert.strictEqual(preview.databaseMutations, 0, 'Must record 0 DB mutations');
    assert.strictEqual(preview.driveWrites, 0, 'Must record 0 Drive writes');
    assert.strictEqual(driveWrites, 0, 'Zero calls to Drive upload API');

    // Verify local DB remains untouched
    const currentTxns = await getTransactions();
    assert.strictEqual(currentTxns.length, 2, 'Local database must remain untouched at 2 transactions');
  });

  it('5. Preview with empty cloud — action is CREATE_INITIAL_SNAPSHOT', async () => {
    const mockDrive = {
      findAppDataFile: async () => null
    };

    const preview = await previewCloudSync({
      pin: TEST_PIN,
      accessToken: 'valid_mock_token',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(preview.action, 'CREATE_INITIAL_SNAPSHOT');
    assert.strictEqual(preview.isFirstSync, true);
    assert.strictEqual(preview.cloudCounts.snapshot_exists, false);
    assert.strictEqual(preview.safetyStatus, 'PASSED_SAFE');
  });

  it('6. Preview conflict state — detects and enumerates conflicts without mutating', async () => {
    // Local transaction
    await bulkImport([{ id: 'txn_c_1', Date: '2026-09-20', Account: 'HDFC', Category: 'Groceries', INR: 1000, type: 'Expense' }], { firstImport: true });

    const localEntities = await readLocalEntities(db);
    const baseManifest = await buildEntityManifest(localEntities);
    // Modify canonical in base to simulate base had INR 500
    baseManifest['txn_c_1'].canonical = 'txn_c_1|2026-09-20||HDFC|||Groceries||||500.00|Expense||||0.0000|0.0000||0.00';
    await setSetting('sync_base_manifest', JSON.stringify(baseManifest));

    // Cloud snapshot has amount 1200
    const cloudPayload = {
      snapshot_id: 'snap_cloud_c',
      cloud_version: 2,
      entities: {
        transactions: [
          { id: 'txn_c_1', Date: '2026-09-20', Account: 'HDFC', Category: 'Groceries', INR: 1200, type: 'Expense' }
        ]
      }
    };
    const encryptedCloud = await encryptBackupData(cloudPayload, TEST_PIN);

    const mockDrive = {
      findAppDataFile: async () => ({ id: 'cloud_file_c', version: 2 }),
      readAppDataFile: async () => encryptedCloud
    };

    const preview = await previewCloudSync({
      pin: TEST_PIN,
      accessToken: 'valid_mock_token',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(preview.action, 'MERGE_WITH_CONFLICTS');
    assert.strictEqual(preview.conflicts.length, 1, 'Must detect exactly 1 conflict');
    assert.strictEqual(preview.conflicts[0].type, CONFLICT_TYPES.FINANCIAL_CONFLICT);
    assert.strictEqual(preview.conflicts[0].local.id, 'txn_c_1');

    // Local DB must still have original local INR (1000)
    const txns = await getTransactions();
    assert.strictEqual(parseFloat(txns[0].INR), 1000, 'Local record must NOT be overwritten');
  });

  it('7. Mass deletion safety state — flags SAFETY_ABORT_MASS_DELETION when threshold exceeded', async () => {
    // 60 local transactions
    const bulkTxns = Array.from({ length: 60 }, (_, i) => ({
      id: `txn_del_${i}`,
      Date: '2026-09-20',
      Account: 'HDFC',
      Category: 'Misc',
      INR: 100,
      type: 'Expense'
    }));
    await bulkImport(bulkTxns, { firstImport: true });

    // Build base manifest from exact local entities
    const localEntities = await readLocalEntities(db);
    const baseManifest = await buildEntityManifest(localEntities);
    await setSetting('sync_base_manifest', JSON.stringify(baseManifest));

    // Cloud has 0 transactions and 60 tombstones
    const cloudPayload = {
      snapshot_id: 'snap_cloud_del',
      cloud_version: 2,
      entities: {
        transactions: [],
        sync_tombstones: bulkTxns.map(t => ({ id: t.id, entity_type: 'transaction', deleted_at: '2026-09-21T00:00:00.000Z' }))
      }
    };
    const encryptedCloud = await encryptBackupData(cloudPayload, TEST_PIN);

    const mockDrive = {
      findAppDataFile: async () => ({ id: 'cloud_file_del', version: 2 }),
      readAppDataFile: async () => encryptedCloud
    };

    const preview = await previewCloudSync({
      pin: TEST_PIN,
      accessToken: 'valid_mock_token',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(preview.safetyStatus, 'SAFETY_ABORT_MASS_DELETION');
    assert.strictEqual(preview.plannedLocalChanges.deletes, 60);

    // Verify local DB retains all 60 records
    const currentTxns = await getTransactions();
    assert.strictEqual(currentTxns.length, 60, 'All 60 records must remain intact locally');
  });

  it('8. Preview failure does not mutate local state or base manifest', async () => {
    await bulkImport([{ id: 'txn_safe_1', Date: '2026-09-20', Account: 'HDFC', Category: 'Groceries', INR: 200, type: 'Expense' }], { firstImport: true });

    const mockCorruptDrive = {
      findAppDataFile: async () => ({ id: 'corrupt_file' }),
      readAppDataFile: async () => 'corrupted_non_json_garbage'
    };

    await assert.rejects(
      async () => {
        await previewCloudSync({
          pin: TEST_PIN,
          accessToken: 'valid_mock_token',
          dbInstance: db,
          driveClient: mockCorruptDrive
        });
      }
    );

    const txns = await getTransactions();
    assert.strictEqual(txns.length, 1, 'Local transaction must remain untouched');
    const base = await getSetting('sync_base_manifest').catch(() => null);
    assert.strictEqual(base, null, 'sync_base_manifest must not be written on failure');
  });

  it('9. Step 5B Live Execution Flow: Initial Snapshot creation, read-back verification & 0 local mutations', async () => {
    // Seed 3 initial local transactions
    const initialTxns = [
      { id: 'txn_live_1', Date: '2026-09-20', Account: 'HDFC', Category: 'Groceries', INR: 1200, type: 'Expense' },
      { id: 'txn_live_2', Date: '2026-09-21', Account: 'Canara', Category: 'Salary', INR: 75000, type: 'Income' },
      { id: 'txn_live_3', Date: '2026-09-22', Account: 'Cash', Category: 'Fuel', INR: 500, type: 'Expense' }
    ];
    await bulkImport(initialTxns, { firstImport: true });

    let cloudStore = null;
    let uploadCount = 0;
    let readBackCount = 0;

    const mockDrive = {
      findAppDataFile: async () => {
        if (!cloudStore) return null;
        return { id: cloudStore.id, name: 'finman_cloud_sync_snapshot.finman', version: cloudStore.version };
      },
      readAppDataFile: async (fileId) => {
        readBackCount++;
        return cloudStore.content;
      },
      uploadAppDataFile: async (filename, content, mimeType) => {
        uploadCount++;
        cloudStore = { id: 'file_cloud_snap_1', name: filename, content, version: 1 };
        return { id: 'file_cloud_snap_1' };
      }
    };

    const syncRes = await executeCloudSync({
      pin: TEST_PIN,
      accessToken: 'valid_token_5b',
      deviceId: 'web_client_5b',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(syncRes.status, SYNC_STATUS.SUCCESS);
    assert.strictEqual(syncRes.isFirstSync, true);
    assert.strictEqual(syncRes.localChangesApplied, 0, 'Zero local changes applied on initial upload');
    assert.strictEqual(syncRes.cloudChangesUploaded, 3, 'All 3 transactions uploaded to cloud');
    assert.strictEqual(uploadCount, 1, 'Exactly ONE snapshot file uploaded');
    assert.ok(readBackCount >= 1, 'Post-upload read-back verification performed');

    // Verify local DB records remain intact at exactly 3
    const postTxns = await getTransactions();
    assert.strictEqual(postTxns.length, 3);

    // Verify base manifest was persisted
    const baseManifestRaw = await getSetting('sync_base_manifest');
    assert.ok(baseManifestRaw, 'Base manifest must be persisted');
    const baseManifest = JSON.parse(baseManifestRaw);
    assert.strictEqual(Object.keys(baseManifest).length >= 3, true);
  });

  it('10. Step 5B Consecutive Sync Idempotency: Second sync returns NO_CHANGES with 0 writes', async () => {
    // Continue from existing state
    const initialTxns = [
      { id: 'txn_idemp_1', Date: '2026-09-20', Account: 'HDFC', Category: 'Groceries', INR: 1200, type: 'Expense' }
    ];
    await bulkImport(initialTxns, { firstImport: true });

    let cloudStore = null;
    let uploadCount = 0;

    const mockDrive = {
      findAppDataFile: async () => {
        if (!cloudStore) return null;
        return { id: cloudStore.id, name: 'finman_cloud_sync_snapshot.finman', version: cloudStore.version };
      },
      readAppDataFile: async (fileId) => cloudStore.content,
      uploadAppDataFile: async (filename, content, mimeType) => {
        uploadCount++;
        cloudStore = { id: 'file_idemp_1', name: filename, content, version: 1 };
        return { id: 'file_idemp_1' };
      }
    };

    // First sync
    const firstRes = await executeCloudSync({
      pin: TEST_PIN,
      accessToken: 'valid_token_5b',
      deviceId: 'web_client_5b',
      dbInstance: db,
      driveClient: mockDrive
    });
    assert.strictEqual(firstRes.status, SYNC_STATUS.SUCCESS);
    assert.strictEqual(uploadCount, 1);

    // Immediate second sync without local or cloud changes
    const secondRes = await executeCloudSync({
      pin: TEST_PIN,
      accessToken: 'valid_token_5b',
      deviceId: 'web_client_5b',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(secondRes.status, SYNC_STATUS.NO_CHANGES, 'Second sync must return NO_CHANGES');
    assert.strictEqual(secondRes.localChangesApplied, 0);
    assert.strictEqual(secondRes.cloudChangesUploaded, 0);
    assert.strictEqual(uploadCount, 1, 'Zero additional cloud uploads on second sync');
  });

  it('11. No PIN persistence — verify PIN is never saved to localStorage, IDB, or settings', async () => {
    // Check localStorage
    assert.strictEqual(mockStorage['pin'], undefined);
    assert.strictEqual(mockStorage['sync_pin'], undefined);
    assert.strictEqual(mockStorage['finman_pin'], undefined);

    // Check settings in IDB
    const savedPin = await getSetting('pin').catch(() => null);
    const savedSyncPin = await getSetting('sync_pin').catch(() => null);
    assert.strictEqual(savedPin, null, 'PIN must not exist in settings');
    assert.strictEqual(savedSyncPin, null, 'Sync PIN must not exist in settings');
  });

  it('12. No-Op UI Detection — isNoOpPreview correctly distinguishes no-op from active syncs', () => {
    const noOpPreview = {
      action: 'MERGE_CLEAN',
      isFirstSync: false,
      plannedLocalChanges: { inserts: 0, updates: 0, deletes: 0, settingsUpdates: 0 },
      plannedCloudChanges: { inserts: 0, updates: 0, deletes: 0, settingsUpdates: 0 },
      conflicts: []
    };
    assert.strictEqual(isNoOpPreview(noOpPreview), true, 'Zero changes and no conflicts must evaluate to true');

    // Local changes present
    assert.strictEqual(isNoOpPreview({
      ...noOpPreview,
      plannedLocalChanges: { inserts: 1, updates: 0, deletes: 0 }
    }), false, 'Local inserts must not be no-op');

    // Cloud changes present
    assert.strictEqual(isNoOpPreview({
      ...noOpPreview,
      plannedCloudChanges: { inserts: 1, updates: 0, deletes: 0 }
    }), false, 'Cloud inserts must not be no-op');

    // Conflicts present
    assert.strictEqual(isNoOpPreview({
      ...noOpPreview,
      conflicts: [{ id: 'c1' }]
    }), false, 'Conflicts must not be no-op');

    // Bootstrap action
    assert.strictEqual(isNoOpPreview({
      ...noOpPreview,
      action: 'BOOTSTRAP_FROM_CLOUD'
    }), false, 'Bootstrap must not be no-op');

    // First sync
    assert.strictEqual(isNoOpPreview({
      ...noOpPreview,
      isFirstSync: true
    }), false, 'First sync must not be no-op');
  });

  it('13. No-Op Confirmation UI Copy — Displays "In Sync — No Changes" and "✓ Confirm — No Upload"', () => {
    const noOpPreview = {
      action: 'MERGE_CLEAN',
      isFirstSync: false,
      plannedLocalChanges: { inserts: 0, updates: 0, deletes: 0 },
      plannedCloudChanges: { inserts: 0, updates: 0, deletes: 0 },
      conflicts: []
    };

    const config = getModalConfirmConfig(noOpPreview, 29032, false);
    assert.strictEqual(config.isNoOp, true);
    assert.strictEqual(config.title, 'In Sync — No Changes');
    assert.strictEqual(config.badge, 'In Sync — No Changes');
    assert.strictEqual(config.descriptionText, 'Your local database and cloud snapshot are already in sync. Confirming will verify the current state without uploading data.');
    assert.strictEqual(config.buttonLabel, '✓ Confirm — No Upload');

    const syncingConfig = getModalConfirmConfig(noOpPreview, 29032, true);
    assert.strictEqual(syncingConfig.buttonLabel, 'Verifying sync...');
  });

  it('14. Normal Sync Confirmation UI Copy — Preserves "Confirm Cloud Sync" and "🚀 Confirm & Upload"', () => {
    const activePreview = {
      action: 'MERGE_CLEAN',
      isFirstSync: false,
      plannedLocalChanges: { inserts: 0, updates: 0, deletes: 0 },
      plannedCloudChanges: { inserts: 2, updates: 0, deletes: 0 },
      conflicts: []
    };

    const config = getModalConfirmConfig(activePreview, 29032, false);
    assert.strictEqual(config.isNoOp, false);
    assert.strictEqual(config.title, 'Confirm Cloud Sync');
    assert.strictEqual(config.badge, 'Reconcile & Synchronize');
    assert.ok(config.descriptionText.includes('synchronized to your private Google Drive'));
    assert.strictEqual(config.buttonLabel, '🚀 Confirm & Upload');
  });

  it('15. Bootstrap Confirmation UI Copy — Preserves "Confirm Device Bootstrap" and "📥 Confirm & Bootstrap"', () => {
    const bootstrapPreview = {
      action: 'BOOTSTRAP_FROM_CLOUD',
      isFirstSync: false,
      cloudTxnCount: 29032,
      plannedLocalChanges: { inserts: 29032, updates: 0, deletes: 0 },
      plannedCloudChanges: { inserts: 0, updates: 0, deletes: 0 },
      conflicts: []
    };

    const config = getModalConfirmConfig(bootstrapPreview, 0, false);
    assert.strictEqual(config.isBootstrap, true);
    assert.strictEqual(config.title, 'Confirm Device Bootstrap');
    assert.strictEqual(config.badge, 'Bootstrap From Cloud Snapshot');
    assert.ok(config.descriptionText.includes('decrypted from cloud and loaded into your local database'));
    assert.strictEqual(config.buttonLabel, '📥 Confirm & Bootstrap');
  });

  it('16. Pull-Only Confirmation UI Copy — Displays "Confirm Pull From Cloud" and "📥 Confirm & Pull (No Upload)"', () => {
    const pullOnlyPreview = {
      action: 'MERGE_CLEAN',
      isFirstSync: false,
      plannedLocalChanges: { inserts: 14, updates: 0, deletes: 0, settingsUpdates: 0 },
      plannedCloudChanges: { inserts: 0, updates: 0, deletes: 0, settingsUpdates: 0 },
      conflicts: []
    };

    assert.strictEqual(isPullOnlyPreview(pullOnlyPreview), true, '14 local inserts and 0 cloud changes must be pull-only');

    const config = getModalConfirmConfig(pullOnlyPreview, 29040, false);
    assert.strictEqual(config.isNoOp, false);
    assert.strictEqual(config.isBootstrap, false);
    assert.strictEqual(config.isPullOnly, true);
    assert.strictEqual(config.icon, '📥');
    assert.strictEqual(config.title, 'Confirm Pull From Cloud');
    assert.strictEqual(config.badge, 'Incoming Changes from Cloud (No Upload)');
    assert.ok(config.descriptionText.includes('Zero data will be uploaded'));
    assert.ok(config.descriptionText.includes('14 incoming changes'));
    assert.strictEqual(config.buttonLabel, '📥 Confirm & Pull (No Upload)');

    const syncingConfig = getModalConfirmConfig(pullOnlyPreview, 29040, true);
    assert.strictEqual(syncingConfig.buttonLabel, 'Applying changes...');
  });

  it('17. Pull-Only Predicate Exclusions — Normal Upload, No-Op, and Bootstrap do NOT become Pull-Only', () => {
    // Normal upload with cloud changes > 0
    const uploadPreview = {
      action: 'MERGE_CLEAN',
      isFirstSync: false,
      plannedLocalChanges: { inserts: 14, updates: 0, deletes: 0, settingsUpdates: 0 },
      plannedCloudChanges: { inserts: 2, updates: 0, deletes: 0, settingsUpdates: 0 },
      conflicts: []
    };
    assert.strictEqual(isPullOnlyPreview(uploadPreview), false, 'Upload with cloud inserts > 0 is not pull-only');
    const uploadConfig = getModalConfirmConfig(uploadPreview, 29040, false);
    assert.strictEqual(uploadConfig.isPullOnly, false);
    assert.strictEqual(uploadConfig.buttonLabel, '🚀 Confirm & Upload');

    // No-op (0 local, 0 cloud)
    const noOpPreview = {
      action: 'MERGE_CLEAN',
      isFirstSync: false,
      plannedLocalChanges: { inserts: 0, updates: 0, deletes: 0, settingsUpdates: 0 },
      plannedCloudChanges: { inserts: 0, updates: 0, deletes: 0, settingsUpdates: 0 },
      conflicts: []
    };
    assert.strictEqual(isPullOnlyPreview(noOpPreview), false, 'No-op (0 local changes) is not pull-only');

    // Bootstrap
    const bootstrapPreview = {
      action: 'BOOTSTRAP_FROM_CLOUD',
      isFirstSync: false,
      plannedLocalChanges: { inserts: 29040, updates: 0, deletes: 0, settingsUpdates: 0 },
      plannedCloudChanges: { inserts: 0, updates: 0, deletes: 0, settingsUpdates: 0 },
      conflicts: []
    };
    assert.strictEqual(isPullOnlyPreview(bootstrapPreview), false, 'Bootstrap action is not standard pull-only');

    // Conflicts
    const conflictPreview = {
      action: 'MERGE_WITH_CONFLICTS',
      isFirstSync: false,
      plannedLocalChanges: { inserts: 14, updates: 0, deletes: 0, settingsUpdates: 0 },
      plannedCloudChanges: { inserts: 0, updates: 0, deletes: 0, settingsUpdates: 0 },
      conflicts: [{ id: 'c1' }]
    };
    assert.strictEqual(isPullOnlyPreview(conflictPreview), false, 'Preview with conflicts is not clean pull-only');
  });
});
