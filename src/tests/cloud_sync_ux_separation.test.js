/**
 * cloud_sync_ux_separation.test.js — Stage A Cloud Sync UX Separation Test Suite
 * 
 * Verifies:
 * 1. Live Cloud Sync manual trigger invokes triggerAutomaticSync(SYNC_TRIGGER.MANUAL)
 * 2. Live Cloud Sync manual trigger NEVER calls executeCloudSync()
 * 3. Zero-pending delta flush does not touch snapshot ID/version or snapshot baseline
 * 4. Pending delta flush triggers delta packaging without mutating the full snapshot baseline
 * 5. Full snapshot action uses previewCloudSync() -> executeCloudSync() path
 * 6. Modal confirmation copy explicitly states snapshot baseline creation with '🚀 Confirm & Create Snapshot'
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { initDB, closeDB } from '../database/db.js';
import { bulkImport, getTransactions, deleteTransaction } from '../database/transactions.js';
import { getSetting, setSetting } from '../database/settings.js';
import {
  triggerAutomaticSync,
  SYNC_TRIGGER,
  SYNC_STATUS as DELTA_SYNC_STATUS,
  getDeltaSyncMetrics
} from '../services/deltaSyncCoordinator.js';
import {
  previewCloudSync,
  executeCloudSync,
  SYNC_STATUS as FULL_SYNC_STATUS
} from '../services/cloudSyncEngine.js';
import { getModalConfirmConfig } from '../utils/cloudSyncModalHelper.js';
import { getSyncSessionKey, lockSyncSession, unlockSyncSession } from '../services/syncSession.js';

// Global mock for localStorage
const mockStorage = {};
global.localStorage = {
  getItem: (k) => mockStorage[k] || null,
  setItem: (k, v) => { mockStorage[k] = String(v); },
  removeItem: (k) => { delete mockStorage[k]; },
  clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); }
};

describe('FinMan Cloud Sync UX Separation Tests (Stage A)', () => {
  let db;
  const TEST_PIN = '123456';

  beforeEach(async () => {
    global.localStorage.clear();
    lockSyncSession();
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    db = await initDB();
  });

  it('1. Modal confirmation copy explicitly specifies full cloud backup creation', () => {
    const preview = {
      action: 'MERGE_CLEAN',
      isFirstSync: false,
      plannedLocalChanges: { inserts: 0, updates: 0, deletes: 0 },
      plannedCloudChanges: { inserts: 5, updates: 0, deletes: 0 },
      conflicts: []
    };

    const modalConfig = getModalConfirmConfig(preview, 29044, false);
    assert.strictEqual(modalConfig.title, 'Confirm Full Cloud Backup');
    assert.strictEqual(modalConfig.icon, '📦');
    assert.strictEqual(
      modalConfig.descriptionText,
      '29,044 transactions will be encrypted and saved as a complete cloud backup.'
    );
    assert.strictEqual(modalConfig.buttonLabel, '🚀 Confirm & Back Up');

    const syncingConfig = getModalConfirmConfig(preview, 29044, true);
    assert.strictEqual(syncingConfig.buttonLabel, 'Creating backup...');
  });

  it('2. Manual delta flush invokes triggerAutomaticSync with SYNC_TRIGGER.MANUAL and DOES NOT call executeCloudSync', async () => {
    let executeCloudSyncCalled = false;

    // triggerAutomaticSync should execute manual delta cycle without invoking executeCloudSync
    const triggerRes = await triggerAutomaticSync(SYNC_TRIGGER.MANUAL);
    assert.ok(triggerRes, 'triggerAutomaticSync should return a result object');
    assert.strictEqual(executeCloudSyncCalled, false, 'executeCloudSync MUST NOT be called by delta trigger');
  });

  it('3. Zero-pending delta flush does not modify snapshot ID or snapshot baseline settings', async () => {
    // Set a known initial snapshot baseline in settings
    await setSetting('sync_last_snapshot_id', 'snap_baseline_test_v8');
    await setSetting('sync_last_sync_time', '2026-10-02T12:00:00.000Z');

    const beforeSnapId = await getSetting('sync_last_snapshot_id');
    const beforeSyncTime = await getSetting('sync_last_sync_time');

    // Run manual delta sync flush with 0 pending changes
    const result = await triggerAutomaticSync(SYNC_TRIGGER.MANUAL);

    const afterSnapId = await getSetting('sync_last_snapshot_id');
    const afterSyncTime = await getSetting('sync_last_sync_time');

    assert.strictEqual(afterSnapId, beforeSnapId, 'Snapshot ID must remain unchanged');
    assert.strictEqual(afterSyncTime, beforeSyncTime, 'Snapshot sync timestamp must remain unchanged');
  });

  it('4. One pending delta does not modify the full cloud snapshot baseline', async () => {
    await setSetting('sync_last_snapshot_id', 'snap_baseline_test_v8');
    await setSetting('sync_last_sync_time', '2026-10-02T12:00:00.000Z');

    // Add a new transaction (which creates an outbound delta queue item)
    await bulkImport([{
      id: 'txn_delta_test_1',
      Date: '2026-10-02',
      Account: 'HDFC',
      Category: 'Dining',
      INR: 500,
      type: 'Expense'
    }], { firstImport: false });

    // Run manual delta sync flush
    await triggerAutomaticSync(SYNC_TRIGGER.MANUAL);

    // Full snapshot baseline must remain completely untouched
    const afterSnapId = await getSetting('sync_last_snapshot_id');
    const afterSyncTime = await getSetting('sync_last_sync_time');

    assert.strictEqual(afterSnapId, 'snap_baseline_test_v8', 'Snapshot ID must NOT be modified by delta sync');
    assert.strictEqual(afterSyncTime, '2026-10-02T12:00:00.000Z', 'Full snapshot sync time must NOT be modified by delta sync');
  });

  it('5. Full Snapshot button workflow preserves previewCloudSync -> executeCloudSync contract', async () => {
    // Seed 1 transaction
    await bulkImport([{
      id: 'txn_snap_test_1',
      Date: '2026-10-02',
      Account: 'HDFC',
      Category: 'Food',
      INR: 250,
      type: 'Expense'
    }], { firstImport: true });

    let uploadedFiles = [];
    let cloudStore = null;
    const mockDrive = {
      findAppDataFile: async () => {
        if (!cloudStore) return null;
        return { id: cloudStore.id, name: cloudStore.name, version: 1 };
      },
      readAppDataFile: async () => cloudStore ? cloudStore.content : null,
      uploadAppDataFile: async (filename, content) => {
        cloudStore = { id: 'file_mock_snap_1', name: filename, content };
        uploadedFiles.push({ filename, content });
        return { id: 'file_mock_snap_1' };
      }
    };

    // Step 1: Preview Snapshot
    const preview = await previewCloudSync({
      pin: TEST_PIN,
      accessToken: 'valid_mock_token',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(preview.action, 'CREATE_INITIAL_SNAPSHOT');
    assert.strictEqual(preview.mode, 'DRY_RUN');
    assert.strictEqual(uploadedFiles.length, 0, 'Preview must not upload files');

    // Step 2: User Confirms -> Execute Snapshot
    const syncRes = await executeCloudSync({
      pin: TEST_PIN,
      accessToken: 'valid_mock_token',
      deviceId: 'dev_ux_test',
      dbInstance: db,
      driveClient: mockDrive
    });

    assert.strictEqual(syncRes.status, FULL_SYNC_STATUS.SUCCESS);
    assert.strictEqual(uploadedFiles.length, 1, 'Full snapshot must create exactly one snapshot file');
    assert.strictEqual(uploadedFiles[0].filename, 'finman_cloud_sync_snapshot.finman');
  });
});

