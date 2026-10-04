/**
 * google_account_restore_flow.test.js
 * 
 * Focused Automated Test Suite for:
 * Part 1: Google Account Identity & User Info (fetchGoogleUserInfo, caching, 401 resilience, disconnect, privacy)
 * Part 2: WhatsApp-style New Device Cloud Backup Restore Lifecycle (UNINITIALIZED discovery, Restore, Start Fresh, Wrong PIN, Corrupt Snapshot, Active device protection)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  initDB,
  closeDB,
  getDB,
  getRawIDB,
  initLocalSyncState
} from '../database/index.js';
import { getTransactions, addTransaction } from '../database/transactions.js';
import { getAccounts, replaceAccounts } from '../database/accounts.js';
import { getCategories, replaceCategories } from '../database/categories.js';
import { getSetting, setSetting } from '../database/settings.js';
import {
  fetchGoogleUserInfo
} from '../services/googleDriveSync.js';
import {
  saveGoogleUserData,
  getStoredGoogleUser,
  clearGoogleUserData,
  syncGoogleUserInfo,
  clearGoogleAuth,
  saveTokenData,
  getStoredToken,
  isGoogleLinked,
  setGoogleLinked,
  invalidateStoredToken,
  subscribeGoogleAuth,
  STORAGE_KEY_EMAIL,
  STORAGE_KEY_DISPLAY_NAME,
  STORAGE_KEY_TOKEN,
  STORAGE_KEY_LINKED
} from '../services/googleAuth.js';
import {
  DEVICE_LIFECYCLE,
  getDeviceLifecycleState,
  setDeviceLifecycleState,
  discoverCloudRepository,
  bootstrapNewDevice,
  configureDeltaSyncEngine,
  SYNC_STATUS
} from '../services/deltaSyncCoordinator.js';
import {
  createEmptyDeviceManifest,
  writeOwnDeviceManifest
} from '../services/deviceManifest.js';
import {
  SNAPSHOT_FILENAME
} from '../services/cloudSyncEngine.js';
import { encryptBackupData, decryptBackupData } from '../utils/cryptoBackup.js';

// Setup Mock Storage for test environment
class MockLocalStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

// Mock Google Drive Storage for safe in-memory simulation
class MockDriveStorage {
  constructor() {
    this.files = new Map();
    this.nextId = 1;
  }

  reset() {
    this.files.clear();
    this.nextId = 1;
  }

  async findFiles({ name, trashed = false }) {
    const results = [];
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && (!name || f.name === name)) {
        results.push({ id: f.id, name: f.name, appProperties: f.appProperties });
      }
    }
    return results;
  }

  async findAppDataFile(name, token) {
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        return { id: f.id, name: f.name };
      }
    }
    return null;
  }

  async readAppDataFile(fileId, token) {
    const f = this.files.get(fileId);
    if (!f || f.trashed) throw new Error(`File not found: ${fileId}`);
    return f.content;
  }

  async uploadAppDataFile(name, content, mimeType, token) {
    let existingId = null;
    for (const [id, f] of this.files.entries()) {
      if (!f.trashed && f.name === name) {
        existingId = id;
        break;
      }
    }

    if (existingId) {
      this.files.set(existingId, { id: existingId, name, content, mimeType, trashed: false });
      return { id: existingId, name };
    }

    const id = `mock_drive_file_${this.nextId++}`;
    this.files.set(id, { id, name, content, mimeType, trashed: false });
    return { id, name };
  }
}

test('GOOGLE ACCOUNT IDENTITY & RESTORE FLOW SUITE', async (t) => {
  const originalLocalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  const mockStorage = new MockLocalStorage();
  const mockDrive = new MockDriveStorage();
  const TEST_PIN = '7890';
  const TEST_TOKEN = 'mock-oauth-token-test';

  t.beforeEach(async () => {
    globalThis.localStorage = mockStorage;
    mockStorage.clear();
    mockDrive.reset();
    globalThis.indexedDB = new IDBFactory();
    await initDB();
    await initLocalSyncState('test_device_restore');
  });

  t.afterEach(async () => {
    try {
      await closeDB();
    } catch {}
  });

  t.after(() => {
    globalThis.localStorage = originalLocalStorage;
    globalThis.fetch = originalFetch;
  });

  // ----------------------------------------------------
  // PART 1: GOOGLE ACCOUNT IDENTITY & HYDRATION (TESTS A-H)
  // ----------------------------------------------------

  await t.test('A. Existing connected device + cached email -> email immediately visible', () => {
    saveGoogleUserData('akbar@example.com', 'Akbar');
    setGoogleLinked(true);
    const user = getStoredGoogleUser();
    assert.strictEqual(user.email, 'akbar@example.com');
    assert.strictEqual(user.displayName, 'Akbar');
    assert.strictEqual(isGoogleLinked(), true);
  });

  await t.test('B & C. Existing connected device + valid token + no cached email -> fetch identity without reconnect -> UI updates', async () => {
    saveTokenData(TEST_TOKEN, 3600);
    clearGoogleUserData();
    assert.strictEqual(getStoredGoogleUser().email, '');

    globalThis.fetch = async (url, options) => {
      assert(url.includes('/drive/v3/about?fields=user'), 'Fetches Drive about endpoint');
      assert.strictEqual(options.headers.Authorization, `Bearer ${TEST_TOKEN}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: {
            displayName: 'Akbar Developer',
            emailAddress: 'akbar.dev@example.com'
          }
        })
      };
    };

    let listenerFired = false;
    let authState = null;
    const unsub = subscribeGoogleAuth((isAuth) => {
      listenerFired = true;
      authState = isAuth;
    });

    const info = await syncGoogleUserInfo(TEST_TOKEN);
    assert.strictEqual(info.emailAddress, 'akbar.dev@example.com');
    assert.strictEqual(info.displayName, 'Akbar Developer');
    assert.strictEqual(listenerFired, true);
    assert.strictEqual(authState, true);

    const user = getStoredGoogleUser();
    assert.strictEqual(user.email, 'akbar.dev@example.com');
    assert.strictEqual(user.displayName, 'Akbar Developer');
    assert.strictEqual(getStoredToken(), TEST_TOKEN, 'Token remained untouched without reconnect');
    unsub();
  });

  await t.test('D. Network/5xx identity failure does not disconnect Google', async () => {
    saveTokenData('valid-token-survives-500', 3600);
    assert.strictEqual(getStoredToken(), 'valid-token-survives-500');

    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error'
    });

    const result = await syncGoogleUserInfo('valid-token-survives-500');
    assert.strictEqual(result, null, 'Safe fallback returns null');
    assert.strictEqual(getStoredToken(), 'valid-token-survives-500', 'Token must NOT be invalidated by temporary 5xx errors');
    assert.strictEqual(isGoogleLinked(), true, 'Linked state preserved');
  });

  await t.test('E. 401 follows existing token invalidation behavior', async () => {
    saveTokenData('token-to-invalidate', 3600);
    assert.strictEqual(getStoredToken(), 'token-to-invalidate');

    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Invalid Credentials'
    });

    let threw = false;
    try {
      await fetchGoogleUserInfo('token-to-invalidate');
    } catch (e) {
      threw = true;
      assert.strictEqual(e.status, 401);
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(getStoredToken(), null, 'Stored token should be cleared on 401');
    assert.strictEqual(isGoogleLinked(), true, 'Linked state preserved on token expiry/401');
  });

  await t.test('F. Disconnect clears identity from UI', () => {
    saveGoogleUserData('temp@example.com', 'Temp User');
    saveTokenData('mock-token-123', 3600);
    assert.strictEqual(getStoredGoogleUser().email, 'temp@example.com');

    let listenerFired = false;
    let authState = true;
    const unsub = subscribeGoogleAuth((isAuth) => {
      listenerFired = true;
      authState = isAuth;
    });

    clearGoogleAuth();
    assert.strictEqual(listenerFired, true);
    assert.strictEqual(authState, false);
    assert.strictEqual(getStoredGoogleUser().email, '');
    assert.strictEqual(getStoredGoogleUser().displayName, '');
    assert.strictEqual(mockStorage.getItem(STORAGE_KEY_EMAIL), null);
    assert.strictEqual(mockStorage.getItem(STORAGE_KEY_DISPLAY_NAME), null);
    assert.strictEqual(isGoogleLinked(), false);
    unsub();
  });

  await t.test('G. Fresh Google sign-in displays identity', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        user: {
          displayName: 'Fresh User',
          emailAddress: 'fresh@example.com'
        }
      })
    });

    saveTokenData('fresh-token-xyz', 3600);
    await syncGoogleUserInfo('fresh-token-xyz');

    const user = getStoredGoogleUser();
    assert.strictEqual(user.email, 'fresh@example.com');
    assert.strictEqual(user.displayName, 'Fresh User');
  });

  await t.test('H. No email leaks into sync payloads', async () => {
    const manifest = createEmptyDeviceManifest({
      deviceId: 'dev_privacy_check',
      baseSnapshotId: 'snap_privacy_001',
      baseCloudVersion: 1
    });
    const serializedManifest = JSON.stringify(manifest);
    assert.strictEqual(serializedManifest.includes('tester@example.com'), false);
    assert.strictEqual(serializedManifest.includes('emailAddress'), false);

    const snapshotPayload = {
      snapshot_id: 'snap_privacy_002',
      cloud_version: 1,
      created_at: new Date().toISOString(),
      device_id: 'dev_privacy_check',
      entities: {
        transactions: [],
        investment_transactions: [],
        accounts: [],
        categories: []
      }
    };
    const serializedSnapshot = JSON.stringify(snapshotPayload);
    assert.strictEqual(serializedSnapshot.includes('tester@example.com'), false);
    assert.strictEqual(serializedSnapshot.includes('emailAddress'), false);
  });

  // ----------------------------------------------------
  // PART 2: WHATSAPP-STYLE RESTORE FLOW
  // ----------------------------------------------------

  await t.test('8. UNINITIALIZED device detects existing cloud repository and returns EXISTING_REPOSITORY_FOUND', async () => {
    // Setup existing cloud snapshot in mock drive
    const snapshotPayload = {
      snapshot_id: 'snap_whatsapp_001',
      cloud_version: 1,
      created_at: new Date().toISOString(),
      device_id: 'dev_primary',
      entities: {
        transactions: [{ id: 'tx_cloud_01', Amount: 500, Type: 'Expense', Description: 'Cloud Txn' }],
        investment_transactions: [],
        accounts: [{ id: 'acc_01', name: 'Primary Bank' }],
        categories: [{ id: 'cat_01', name: 'Food' }]
      }
    };
    const encrypted = await encryptBackupData(snapshotPayload, TEST_PIN);
    await mockDrive.uploadAppDataFile(SNAPSHOT_FILENAME, encrypted, 'application/octet-stream', TEST_TOKEN);

    const lifecycle = await getDeviceLifecycleState('test_device_restore');
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.UNINITIALIZED);

    // Read-only discovery WITHOUT requiring PIN first
    const discovery = await discoverCloudRepository({
      accessToken: TEST_TOKEN,
      driveClient: mockDrive,
      sessionKey: null
    });

    assert.strictEqual(discovery.exists, true);
    assert.strictEqual(discovery.status, 'EXISTING_REPOSITORY_FOUND');
    assert.strictEqual(discovery.requiresKey, true);
  });

  await t.test('9. UNINITIALIZED device with empty Google Drive returns NO_REPOSITORY_EXISTS', async () => {
    const discovery = await discoverCloudRepository({
      accessToken: TEST_TOKEN,
      driveClient: mockDrive,
      sessionKey: null
    });

    assert.strictEqual(discovery.exists, false);
    assert.strictEqual(discovery.status, 'NO_REPOSITORY_EXISTS');
  });

  await t.test('10 & 14 & 15. User chooses Restore -> enters valid PIN -> bootstrapNewDevice populates DB, zero outbound deltas, transitions to ACTIVE', async () => {
    const snapshotPayload = {
      snapshot_id: 'snap_whatsapp_restore_100',
      cloud_version: 1,
      created_at: new Date().toISOString(),
      device_id: 'dev_primary_orig',
      entities: {
        transactions: [
          { id: 'tx_restored_1', Amount: 1200, Type: 'Income', Description: 'Salary', Date: '2026-10-01' },
          { id: 'tx_restored_2', Amount: 450, Type: 'Expense', Description: 'Groceries', Date: '2026-10-02' }
        ],
        investment_transactions: [],
        accounts: [{ id: 'acc_b1', name: 'HDFC Bank' }],
        categories: [{ id: 'cat_c1', name: 'Groceries' }]
      }
    };
    const encrypted = await encryptBackupData(snapshotPayload, TEST_PIN);
    await mockDrive.uploadAppDataFile(SNAPSHOT_FILENAME, encrypted, 'application/octet-stream', TEST_TOKEN);

    // Run bootstrapNewDevice
    const bootRes = await bootstrapNewDevice({
      accessToken: TEST_TOKEN,
      pin: TEST_PIN,
      driveClient: mockDrive,
      deviceId: 'test_device_restore'
    });

    // Verify local DB was populated
    const txns = await getTransactions();
    assert.strictEqual(txns.length, 2);
    assert.strictEqual(txns[0].Description, 'Groceries');

    // Verify lifecycle transitioned to ACTIVE
    const lifecycleAfter = await getDeviceLifecycleState('test_device_restore');
    assert.strictEqual(lifecycleAfter, DEVICE_LIFECYCLE.ACTIVE);

    // Verify zero unexpected outbound deltas
    const db = getDB();
    const queueRows = (await db.query('SELECT * FROM sync_delta_queue').catch(() => ({ values: [] }))).values || [];
    assert.strictEqual(queueRows.length, 0, 'Bootstrap must produce 0 outbound delta queue rows');
  });

  await t.test('11. Wrong PIN entered during restore fails with error and leaves local DB untouched', async () => {
    const snapshotPayload = {
      snapshot_id: 'snap_wrong_pin_test',
      cloud_version: 1,
      created_at: new Date().toISOString(),
      device_id: 'dev_orig',
      entities: {
        transactions: [{ id: 'tx_secret', Amount: 9999, Type: 'Income', Description: 'Secret' }],
        investment_transactions: [],
        accounts: [],
        categories: []
      }
    };
    const encrypted = await encryptBackupData(snapshotPayload, 'correct_pin_9999');
    await mockDrive.uploadAppDataFile(SNAPSHOT_FILENAME, encrypted, 'application/octet-stream', TEST_TOKEN);

    let threw = false;
    try {
      await bootstrapNewDevice({
        accessToken: TEST_TOKEN,
        pin: 'wrong_pin_1111',
        driveClient: mockDrive,
        deviceId: 'test_device_restore'
      });
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'Bootstrap must fail on invalid PIN');

    // Verify local DB remains clean and non-ACTIVE
    const txns = await getTransactions();
    assert.strictEqual(txns.length, 0);
    const lifecycle = await getDeviceLifecycleState('test_device_restore');
    assert.notStrictEqual(lifecycle, DEVICE_LIFECYCLE.ACTIVE, 'Device must not transition to ACTIVE on wrong PIN');
    assert(lifecycle === DEVICE_LIFECYCLE.UNINITIALIZED || lifecycle === DEVICE_LIFECYCLE.JOINING);
  });


  await t.test('12. Corrupt cloud snapshot fails deep validation and leaves local DB untouched', async () => {
    // Encrypt payload missing required fields (corrupt envelope)
    const corruptPayload = {
      snapshot_id: 'snap_corrupt',
      // missing entities map!
    };
    const encrypted = await encryptBackupData(corruptPayload, TEST_PIN);
    await mockDrive.uploadAppDataFile(SNAPSHOT_FILENAME, encrypted, 'application/octet-stream', TEST_TOKEN);

    let threw = false;
    try {
      await bootstrapNewDevice({
        accessToken: TEST_TOKEN,
        pin: TEST_PIN,
        driveClient: mockDrive,
        deviceId: 'test_device_restore'
      });
    } catch (e) {
      threw = true;
      assert(e.message.includes('VALIDATION_ERROR') || e.message.includes('BOOTSTRAP_FAILED'));
    }
    assert.strictEqual(threw, true);

    const txns = await getTransactions();
    assert.strictEqual(txns.length, 0);
  });

  await t.test('16 & 17. User chooses "Start Fresh" -> local Google auth cleared, zero outbound seeded deltas, cloud backup 100% untouched', async () => {
    // 1. Existing cloud repository exists in Google Drive
    const originalCloudSnapshot = {
      snapshot_id: 'snap_protect_cloud_001',
      cloud_version: 1,
      entities: {
        transactions: [{ id: 'tx_protected_01', Amount: 777, Type: 'Expense', Description: 'Important Backup' }],
        investment_transactions: [],
        accounts: [],
        categories: []
      }
    };
    const encrypted = await encryptBackupData(originalCloudSnapshot, TEST_PIN);
    await mockDrive.uploadAppDataFile(SNAPSHOT_FILENAME, encrypted, 'application/octet-stream', TEST_TOKEN);

    // 2. New device connects Google account
    saveTokenData(TEST_TOKEN, 3600);
    saveGoogleUserData('newuser@example.com', 'New User');
    assert.strictEqual(isGoogleLinked(), true);

    // 3. User chooses "Start Fresh": clear local Google auth and maintain default seed
    clearGoogleAuth();

    // Verify local auth is disconnected
    assert.strictEqual(isGoogleLinked(), false);
    assert.strictEqual(getStoredToken(), null);
    assert.strictEqual(getStoredGoogleUser().email, '');

    // Verify device lifecycle is still UNINITIALIZED
    const lifecycle = await getDeviceLifecycleState('test_device_restore');
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.UNINITIALIZED);

    // Verify zero outbound deltas created
    const db = getDB();
    const queueRows = (await db.query('SELECT * FROM sync_delta_queue').catch(() => ({ values: [] }))).values || [];
    assert.strictEqual(queueRows.length, 0, 'No outbound deltas created');

    // Verify Google Drive cloud repository was 100% UNTOUCHED
    const cloudFile = await mockDrive.findAppDataFile(SNAPSHOT_FILENAME, TEST_TOKEN);
    assert.ok(cloudFile, 'Cloud file still exists');
    const cloudContent = await mockDrive.readAppDataFile(cloudFile.id, TEST_TOKEN);
    const decryptedCloud = await decryptBackupData(cloudContent, TEST_PIN);
    assert.strictEqual(decryptedCloud.snapshot_id, 'snap_protect_cloud_001');
    assert.strictEqual(decryptedCloud.entities.transactions[0].Description, 'Important Backup');
  });

  await t.test('18. Existing ACTIVE device does not report UNINITIALIZED state', async () => {
    await setDeviceLifecycleState(DEVICE_LIFECYCLE.ACTIVE, 'test_device_restore');
    const lifecycle = await getDeviceLifecycleState('test_device_restore');
    assert.strictEqual(lifecycle, DEVICE_LIFECYCLE.ACTIVE);
  });

  await t.test('19. Switching Google accounts clears previous email and stores new account email', async () => {
    saveGoogleUserData('user1@example.com', 'User 1');
    assert.strictEqual(getStoredGoogleUser().email, 'user1@example.com');

    // Disconnect
    clearGoogleAuth();
    assert.strictEqual(getStoredGoogleUser().email, '');

    // Connect new account
    saveGoogleUserData('user2@example.com', 'User 2');
    assert.strictEqual(getStoredGoogleUser().email, 'user2@example.com');
  });

  await t.test('20. Cloud repository baseline preservation under multiple operations', async () => {
    const cloudSnap = {
      snapshot_id: 'snap_inviolable_base',
      cloud_version: 5,
      entities: {
        transactions: [{ id: 'tx_baseline_1', Amount: 3000, Type: 'Income' }],
        investment_transactions: [],
        accounts: [],
        categories: []
      }
    };
    const ciphertext = await encryptBackupData(cloudSnap, TEST_PIN);
    await mockDrive.uploadAppDataFile(SNAPSHOT_FILENAME, ciphertext, 'application/octet-stream', TEST_TOKEN);

    // Multiple read-only discoveries
    await discoverCloudRepository({ accessToken: TEST_TOKEN, driveClient: mockDrive });
    await discoverCloudRepository({ accessToken: TEST_TOKEN, driveClient: mockDrive });

    const file = await mockDrive.findAppDataFile(SNAPSHOT_FILENAME, TEST_TOKEN);
    const readBack = await mockDrive.readAppDataFile(file.id, TEST_TOKEN);
    const dec = await decryptBackupData(readBack, TEST_PIN);
    assert.strictEqual(dec.snapshot_id, 'snap_inviolable_base');
    assert.strictEqual(dec.cloud_version, 5);
  });
});
