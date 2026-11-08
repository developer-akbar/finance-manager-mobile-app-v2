import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

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

import { initDB, closeDB, getDB } from '../database/db.js';
import { getSetting, setSetting } from '../database/settings.js';
import {
  checkRecoverySafetyLockAsync,
  clearRecoverySafetyLock,
  clearRecoverySafetyLockWithPin,
  setRecoverySafetyLock,
  resetRecoveryLockMemoryCache,
  isRecoverySafetyLocked,
  RECOVERY_SAFETY_LOCK_KEY
} from '../services/recoveryLock.js';
import {
  lockSyncSession,
  encodePersistedToken
} from '../services/syncSession.js';

test('FinMan Recovery Lock — 5 Fail-Closed Safety Guarantees', async (t) => {
  const beforeEachTest = async () => {
    closeDB();
    storageMap.clear();
    await initDB();
    lockSyncSession();
    resetRecoveryLockMemoryCache();
  };

  await t.test('1. Missing stored PIN fails closed when attempting unlock', async () => {
    await beforeEachTest();
    await setRecoverySafetyLock('MANUAL_LOCK');
    assert.equal(isRecoverySafetyLocked(), true);

    // No PIN is in localStorage or DB
    await assert.rejects(
      async () => await clearRecoverySafetyLockWithPin('1234'),
      /No encryption PIN is registered on this device/,
      'Must reject unlock when no PIN is registered'
    );
    assert.equal(isRecoverySafetyLocked(), true, 'Lock must remain armed');
  });

  await t.test('2. SQLite persistence failures cannot report success and re-arm lock', async () => {
    await beforeEachTest();
    await setRecoverySafetyLock('TEST_LOCK');

    // Simulate DB closure / disconnection to force SQLite write failure
    closeDB();

    await assert.rejects(
      async () => await clearRecoverySafetyLock({ confirmed: true }),
      /CRITICAL: Failed to persist cleared recovery lock in SQLite settings/,
      'Must reject clear operation on SQLite write failure'
    );
    assert.equal(isRecoverySafetyLocked(), true, 'Lock must be immediately re-armed in-memory');
    const local = JSON.parse(localStorage.getItem(RECOVERY_SAFETY_LOCK_KEY));
    assert.equal(local.locked, true, 'Lock must be re-armed in localStorage');
    assert.equal(local.reason, 'SQLITE_PERSISTENCE_FAILURE');
  });

  await t.test('3. Conflicting SQLite/localStorage lock states remain locked', async () => {
    await beforeEachTest();
    
    // SQLite says unlocked, but localStorage says locked
    await setSetting(RECOVERY_SAFETY_LOCK_KEY, JSON.stringify({ locked: false }), { suppressDeltaQueue: true });
    localStorage.setItem(RECOVERY_SAFETY_LOCK_KEY, JSON.stringify({ locked: true, reason: 'LOCAL_LOCKED' }));

    const isLocked = await checkRecoverySafetyLockAsync();
    assert.equal(isLocked, true, 'Conflicting states must fail-closed to LOCKED');
    assert.equal(isRecoverySafetyLocked(), true);

    // Verify harmonization: SQLite must now be armed as well
    const harmonized = await getSetting(RECOVERY_SAFETY_LOCK_KEY);
    assert.equal(JSON.parse(harmonized).locked, true);
  });

  await t.test('4. Session unlock failure cannot leave the recovery lock cleared', async () => {
    await beforeEachTest();
    await setRecoverySafetyLock('MANUAL_LOCK');

    // Persist valid PIN
    const correctPin = '888888';
    const token = encodePersistedToken(correctPin);
    localStorage.setItem('finman_persisted_sync_pin', token);
    await setSetting('finman_persisted_sync_pin', token, { suppressDeltaQueue: true });

    // Attempt unlock with WRONG pin: session unlock cannot succeed
    await assert.rejects(
      async () => await clearRecoverySafetyLockWithPin('000000'),
      /Incorrect PIN/,
      'Must reject when PIN does not match'
    );
    assert.equal(isRecoverySafetyLocked(), true, 'Recovery lock must remain armed');
    const local = JSON.parse(localStorage.getItem(RECOVERY_SAFETY_LOCK_KEY));
    assert.equal(local.locked, true);
  });

  await t.test('5. Inspection / initialization errors fail closed', async () => {
    await beforeEachTest();
    // Simulate corrupted state / closed DB during async check
    closeDB();

    const isLocked = await checkRecoverySafetyLockAsync();
    assert.equal(isLocked, true, 'Inspection error must fail closed to LOCKED');
    assert.equal(isRecoverySafetyLocked(), true);
  });
});
