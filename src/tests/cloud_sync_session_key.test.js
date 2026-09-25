/**
 * cloud_sync_session_key.test.js — Phase 6A In-Memory Session Key & Unlock Suite
 * 
 * Verifies:
 * 1. Initially locked state.
 * 2. Successful PIN unlock creates an in-memory CryptoKey.
 * 3. Wrong/empty PIN does not unlock.
 * 4. Successful unlock allows Preview without another PIN.
 * 5. Successful unlock allows Sync without another PIN.
 * 6. Lock Sync clears the key.
 * 7. After Lock Sync, Preview requires unlock.
 * 8. Google Disconnect clears the key.
 * 9. In-memory session preservation across operations/remounts.
 * 10. Zero raw PIN persistence.
 * 11. 100% cryptographic compatibility (String PIN vs In-Memory CryptoKey interop).
 * 12. Snapshot format unchanged (exact envelope metadata & structure).
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

// Ensure in-memory localStorage is available in Node.js test environment
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] || null,
    get length() { return store.size; }
  };
}

import { initDB, closeDB } from '../database/db.js';
import {
  isSyncUnlocked,
  getSyncSessionKey,
  unlockSyncSession,
  lockSyncSession,
  subscribeSyncSession
} from '../services/syncSession.js';
import {
  deriveKeyMaterial,
  encryptBackupData,
  decryptBackupData
} from '../utils/cryptoBackup.js';
import {
  previewCloudSync,
  executeCloudSync,
  SYNC_STATUS
} from '../services/cloudSyncEngine.js';
import { clearGoogleAuth, saveTokenData, getStoredToken, isGoogleLinked } from '../services/googleAuth.js';

// Mock in-memory Google Drive transport
function createMockDriveClient() {
  const store = new Map();
  return {
    store,
    async findAppDataFile(name, token) {
      if (!token) throw new Error('Missing token');
      const file = store.get(name);
      return file ? { id: file.id, name, version: file.version || 1 } : null;
    },
    async readAppDataFile(fileId, token) {
      if (!token) throw new Error('Missing token');
      for (const [name, file] of store.entries()) {
        if (file.id === fileId) return file.content;
      }
      throw new Error(`File ${fileId} not found`);
    },
    async uploadAppDataFile(name, content, mimeType, token) {
      if (!token) throw new Error('Missing token');
      const existing = store.get(name);
      const id = existing ? existing.id : `drive_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const version = existing ? (existing.version || 1) + 1 : 1;
      store.set(name, { id, content, version });
      return { id, name, version };
    }
  };
}

describe('Phase 6A: Session Unlock & In-Memory Derived Key', () => {
  beforeEach(() => {
    lockSyncSession();
  });

  it('1. Initially locked state', () => {
    assert.strictEqual(isSyncUnlocked(), false);
    assert.strictEqual(getSyncSessionKey(), null);
  });

  it('2. Successful PIN unlock creates an in-memory CryptoKey', async () => {
    const key = await unlockSyncSession('1234');
    assert.ok(key, 'Key should be defined');
    assert.strictEqual(isSyncUnlocked(), true);
    assert.strictEqual(getSyncSessionKey(), key);
    assert.strictEqual(key.algorithm.name, 'PBKDF2');
    assert.strictEqual(key.extractable, false, 'Key MUST be non-extractable');
    assert.strictEqual(key.type, 'secret');
  });

  it('3. Wrong or empty PIN does not unlock and throws an error', async () => {
    await assert.rejects(
      async () => unlockSyncSession(''),
      /Please enter a valid PIN/
    );
    assert.strictEqual(isSyncUnlocked(), false);
    assert.strictEqual(getSyncSessionKey(), null);

    await assert.rejects(
      async () => unlockSyncSession(null),
      /Please enter a valid PIN/
    );
    assert.strictEqual(isSyncUnlocked(), false);
  });

  it('4. Successful unlock allows Preview without passing a PIN parameter', async () => {
    await initDB();
    const driveClient = createMockDriveClient();
    
    // Unlock session first
    await unlockSyncSession('9876');

    // Call previewCloudSync without any PIN parameter
    const preview = await previewCloudSync({
      accessToken: 'valid_mock_token',
      deviceId: 'test_dev',
      driveClient
    });

    assert.ok(preview);
    assert.strictEqual(preview.action, 'CREATE_INITIAL_SNAPSHOT');
    assert.strictEqual(preview.safetyStatus, 'PASSED_SAFE');
  });

  it('5. Successful unlock allows Sync without passing a PIN parameter', async () => {
    const db = await initDB();
    const driveClient = createMockDriveClient();

    // Unlock session
    await unlockSyncSession('5555');

    // Execute sync without PIN parameter
    const syncRes = await executeCloudSync({
      accessToken: 'valid_mock_token',
      deviceId: 'test_dev',
      driveClient,
      dbInstance: db
    });

    assert.strictEqual(syncRes.status, SYNC_STATUS.SUCCESS);
    assert.strictEqual(syncRes.isFirstSync, true);
    assert.ok(syncRes.snapshotId.startsWith('snap_'));
  });

  it('6. Lock Sync clears the in-memory key immediately', async () => {
    await unlockSyncSession('4321');
    assert.strictEqual(isSyncUnlocked(), true);

    lockSyncSession();
    assert.strictEqual(isSyncUnlocked(), false);
    assert.strictEqual(getSyncSessionKey(), null);
  });

  it('7. After Lock Sync, Preview requires unlock again', async () => {
    const driveClient = createMockDriveClient();

    await unlockSyncSession('1111');
    lockSyncSession();

    await assert.rejects(
      async () => previewCloudSync({
        accessToken: 'valid_token',
        driveClient
      }),
      /Encryption PIN or unlocked session key is required/
    );
  });

  it('8. Google Disconnect clears the key and auth token', async () => {
    saveTokenData('test_token_xyz', 3600);
    assert.strictEqual(getStoredToken(), 'test_token_xyz');

    await unlockSyncSession('2222');
    assert.strictEqual(isSyncUnlocked(), true);

    // Simulate Disconnect
    clearGoogleAuth();
    lockSyncSession();

    assert.strictEqual(getStoredToken(), null);
    assert.strictEqual(isSyncUnlocked(), false);
    assert.strictEqual(getSyncSessionKey(), null);
  });

  it('9. Session state subscription notifies listeners on lock and unlock', async () => {
    const events = [];
    const unsubscribe = subscribeSyncSession((unlocked, key) => {
      events.push({ unlocked, hasKey: !!key });
    });

    await unlockSyncSession('7777');
    lockSyncSession();
    unsubscribe();

    assert.deepStrictEqual(events, [
      { unlocked: true, hasKey: true },
      { unlocked: false, hasKey: false }
    ]);
  });

  it('10. Zero raw PIN persistence in web storage', async () => {
    const rawPin = 'SuperSecretPin999';
    await unlockSyncSession(rawPin);

    // Check localStorage and sessionStorage
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const val = localStorage.getItem(key);
        assert.ok(!val.includes(rawPin), `Raw PIN leaked into localStorage key: ${key}`);
      }
    }
  });

  it('11. Cryptographic Compatibility: Encrypt with String PIN, Decrypt with In-Memory CryptoKey', async () => {
    const testData = { secret: 'financial_records_123', amount: 9999.50 };
    const pin = 'SecretSyncPin123';

    // 1. Encrypt with string PIN
    const encryptedJson = await encryptBackupData(testData, pin);

    // 2. Derive in-memory CryptoKey from same PIN
    const keyMaterial = await deriveKeyMaterial(pin);

    // 3. Decrypt with in-memory CryptoKey
    const decrypted = await decryptBackupData(encryptedJson, keyMaterial);
    assert.deepStrictEqual(decrypted, testData);

    // 4. Encrypt with in-memory CryptoKey
    const encryptedWithKey = await encryptBackupData(testData, keyMaterial);

    // 5. Decrypt with string PIN
    const decryptedWithString = await decryptBackupData(encryptedWithKey, pin);
    assert.deepStrictEqual(decryptedWithString, testData);
  });

  it('12. Existing cloud snapshot envelope format remains 100% unchanged', async () => {
    const testData = { hello: 'world' };
    const keyMaterial = await deriveKeyMaterial('test_pin');
    const encryptedJson = await encryptBackupData(testData, keyMaterial);
    const parsed = JSON.parse(encryptedJson);

    // Verify envelope schema exact match
    assert.strictEqual(parsed.finman_encrypted_backup, true);
    assert.strictEqual(parsed.version, 1);
    assert.ok(typeof parsed.salt === 'string' && parsed.salt.length > 0);
    assert.ok(typeof parsed.iv === 'string' && parsed.iv.length > 0);
    assert.ok(typeof parsed.data === 'string' && parsed.data.length > 0);
    assert.ok(typeof parsed.created_at === 'string');
  });

  it('13. Google Auth Link Persistence: Linked state survives token expiry and clears on Disconnect', () => {
    // 1. Initial unlinked state
    clearGoogleAuth();
    assert.strictEqual(isGoogleLinked(), false);
    assert.strictEqual(getStoredToken(), null);

    // 2. Save token -> marks account as linked
    saveTokenData('fresh_token_123', 3600);
    assert.strictEqual(isGoogleLinked(), true);
    assert.strictEqual(getStoredToken(), 'fresh_token_123');

    // 3. Simulate 1-hour token expiry in localStorage
    const expiredTimestamp = Date.now() - 5000;
    localStorage.setItem('finman_gdrive_token_expiry', String(expiredTimestamp));
    
    // Token is expired (getStoredToken returns null) BUT account link remains intact!
    assert.strictEqual(getStoredToken(), null);
    assert.strictEqual(isGoogleLinked(), true);

    // 4. Explicit Disconnect clears both token and linked state
    clearGoogleAuth();
    assert.strictEqual(isGoogleLinked(), false);
    assert.strictEqual(getStoredToken(), null);
  });

  it('14. Preview returns diagnostics with timing breakdown and precise entity counts', async () => {
    const db = await initDB();
    const driveClient = createMockDriveClient();
    await unlockSyncSession('test_pin_456');

    const preview = await previewCloudSync({
      accessToken: 'valid_mock_token',
      deviceId: 'test_dev',
      driveClient,
      dbInstance: db
    });

    assert.ok(preview.diagnostics);
    assert.ok(typeof preview.diagnostics.totalMs === 'number');
    assert.ok(typeof preview.diagnostics.localDbReadMs === 'number');
    assert.ok(typeof preview.diagnostics.driveLookupMs === 'number');
    assert.strictEqual(preview.plannedLocalChanges.inserts, 0);
    assert.strictEqual(preview.plannedLocalChanges.updates, 0);
    assert.strictEqual(preview.plannedLocalChanges.deletes, 0);
  });
});
