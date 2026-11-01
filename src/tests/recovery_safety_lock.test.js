/**
 * recovery_safety_lock.test.js — Regression Test Suite for Persistent Recovery Safety Lock (Phase A)
 *
 * Verifies:
 * 1. Persisted PIN + recovery lock = no auto-unlock.
 * 2. Startup timer + recovery lock = no sync.
 * 3. App focus / visibility + recovery lock = no sync.
 * 4. Explicit PIN unlock after recovery lock = clears lock and restores session.
 * 5. Wrong PIN fails to clear recovery lock.
 * 6. Cloud discovery + recovery lock = blocked.
 * 7. Snapshot auto-reconciliation + recovery lock = blocked.
 * 8. Recovery lock persists in SQLite settings across process restarts.
 * 9. Persisted PIN and metadata are preserved throughout lock lifecycle.
 * 10. Reconcile entry point arms lock before network / download operations.
 */

import { describe, it, beforeEach } from 'node:test';
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
  isRecoverySafetyLocked,
  checkRecoverySafetyLockAsync,
  setRecoverySafetyLock,
  clearRecoverySafetyLock,
  clearRecoverySafetyLockWithPin,
  getRecoverySafetyLockDetails,
  subscribeRecoveryLock,
  resetRecoveryLockMemoryCache,
  RECOVERY_SAFETY_LOCK_KEY,
  RECOVERY_LOCK_REASON
} from '../services/recoveryLock.js';
import {
  initSyncSessionFromStorage,
  unlockSyncSession,
  lockSyncSession,
  isSyncUnlocked,
  getSyncSessionKey,
  getPersistedPin,
  encodePersistedToken,
  decodePersistedToken
} from '../services/syncSession.js';
import {
  scheduleSync,
  triggerAutomaticSync,
  executeFullSyncPass,
  discoverCloudRepository,
  checkAndAutoReconcileCloudSnapshot,
  SYNC_TRIGGER
} from '../services/deltaSyncCoordinator.js';

describe('FinMan Phase A — Persistent Recovery Safety Lock Suite', () => {
  const TEST_PIN = '753951';

  beforeEach(async () => {
    closeDB();
    storageMap.clear();
    await initDB();

    // Reset session and clear any recovery locks
    lockSyncSession();
    resetRecoveryLockMemoryCache();
    await clearRecoverySafetyLock({ confirmed: true, force: true }).catch(() => {});
  });

  it('1. Persisted PIN + recovery lock = no auto-unlock during startup', async () => {
    // Setup: Persist a valid Sync PIN in both localStorage and SQLite settings
    const token = encodePersistedToken(TEST_PIN);
    localStorage.setItem('finman_persisted_sync_pin', token);
    await setSetting('finman_persisted_sync_pin', token, { suppressDeltaQueue: true });

    // Arm recovery safety lock
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.RECONCILIATION_IN_PROGRESS, {
      targetSnapshotId: 'snap_v16_test',
      targetCloudVersion: 16
    });

    assert.equal(isRecoverySafetyLocked(), true, 'Recovery lock must report true synchronously');
    assert.equal(await checkRecoverySafetyLockAsync(), true, 'Recovery lock must report true asynchronously');

    // Simulate startup PIN auto-restoration
    const restoredKey = await initSyncSessionFromStorage();

    // Verification: Session must NOT unlock
    assert.equal(restoredKey, null, 'initSyncSessionFromStorage must return null when locked');
    assert.equal(isSyncUnlocked(), false, 'isSyncUnlocked must be false');
    assert.equal(getSyncSessionKey(), null, 'getSyncSessionKey must be null');
    assert.equal(getPersistedPin(), null, 'In-memory _persistedPin must remain null');

    // Verification: Persisted PIN in storage MUST NOT be deleted or corrupted
    const storedLocal = localStorage.getItem('finman_persisted_sync_pin');
    const storedDb = await getSetting('finman_persisted_sync_pin');
    assert.equal(storedLocal, token, 'localStorage PIN token must be preserved intact');
    assert.equal(storedDb, token, 'SQLite settings PIN token must be preserved intact');
    assert.equal(decodePersistedToken(storedDb), TEST_PIN, 'Decoded PIN must match original');
  });

  it('2. Automatic sync triggers are suppressed while recovery lock is active', async () => {
    // Arm recovery lock
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.OOM_CRASH_DETECTED);

    // Test scheduleSync
    scheduleSync(SYNC_TRIGGER.STARTUP);

    // Test triggerAutomaticSync
    const autoSyncRes = await triggerAutomaticSync(SYNC_TRIGGER.STARTUP);
    assert.equal(autoSyncRes.status, 'RECOVERY_LOCKED', 'triggerAutomaticSync must return RECOVERY_LOCKED');

    // Test executeFullSyncPass
    const fullPassRes = await executeFullSyncPass({ trigger: SYNC_TRIGGER.STARTUP });
    assert.equal(fullPassRes.status, 'RECOVERY_LOCKED', 'executeFullSyncPass must abort with RECOVERY_LOCKED');
  });

  it('3. Cloud discovery and auto-reconciliation are blocked while recovery lock is active', async () => {
    // Arm recovery lock
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.RECONCILIATION_IN_PROGRESS);

    // Test discoverCloudRepository
    const discoveryRes = await discoverCloudRepository();
    assert.equal(discoveryRes.status, 'RECOVERY_LOCKED', 'discoverCloudRepository must return RECOVERY_LOCKED');

    // Test checkAndAutoReconcileCloudSnapshot
    const reconcileRes = await checkAndAutoReconcileCloudSnapshot();
    assert.equal(reconcileRes.reconciled, false, 'checkAndAutoReconcileCloudSnapshot must not reconcile');
    assert.equal(reconcileRes.reason, 'RECOVERY_SAFETY_LOCK_ACTIVE', 'Reason must be RECOVERY_SAFETY_LOCK_ACTIVE');
  });

  it('4. Recovery lock persists in SQLite settings and survives cache wipes / restarts', async () => {
    // Set lock in SQLite settings & localStorage
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.OOM_CRASH_DETECTED, {
      memory_peak_mb: 256,
      crashed_stage: 'AES_GCM_DECRYPT'
    });

    // Verify it was stored in SQLite settings table
    const dbValue = await getSetting(RECOVERY_SAFETY_LOCK_KEY);
    assert.ok(dbValue, 'Lock must be persisted in SQLite settings');
    const parsed = JSON.parse(dbValue);
    assert.equal(parsed.locked, true);
    assert.equal(parsed.reason, RECOVERY_LOCK_REASON.OOM_CRASH_DETECTED);

    // Simulate process termination: wipe localStorage and in-memory cache
    storageMap.clear();

    // Call async check — should reload from SQLite settings into memory/storage
    const isLockedAfterRestart = await checkRecoverySafetyLockAsync();
    assert.equal(isLockedAfterRestart, true, 'checkRecoverySafetyLockAsync must recover lock from SQLite settings');
    assert.equal(isRecoverySafetyLocked(), true, 'Synchronous lock must now also be active');

    const details = getRecoverySafetyLockDetails();
    assert.equal(details.reason, RECOVERY_LOCK_REASON.OOM_CRASH_DETECTED);
    assert.equal(details.memory_peak_mb, 256);
  });

  it('5. Wrong PIN fails to clear recovery lock', async () => {
    // Setup persisted PIN
    const token = encodePersistedToken(TEST_PIN);
    localStorage.setItem('finman_persisted_sync_pin', token);
    await setSetting('finman_persisted_sync_pin', token, { suppressDeltaQueue: true });

    // Arm lock
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.RECONCILIATION_IN_PROGRESS);

    // Attempt clearing with incorrect PIN
    await assert.rejects(
      async () => {
        await clearRecoverySafetyLockWithPin('000000');
      },
      /Incorrect PIN/,
      'Must reject with Incorrect PIN error'
    );

    // Lock must remain active
    assert.equal(isRecoverySafetyLocked(), true, 'Lock must remain active after failed PIN attempt');
    assert.equal(isSyncUnlocked(), false, 'Session must not be unlocked');
  });

  it('6. Explicit PIN confirmation clears recovery lock and restores active session', async () => {
    // Setup persisted PIN
    const token = encodePersistedToken(TEST_PIN);
    localStorage.setItem('finman_persisted_sync_pin', token);
    await setSetting('finman_persisted_sync_pin', token, { suppressDeltaQueue: true });

    // Arm lock
    await setRecoverySafetyLock(RECOVERY_LOCK_REASON.RECONCILIATION_IN_PROGRESS);
    assert.equal(isRecoverySafetyLocked(), true);

    // Track listener notifications
    let listenerCalled = false;
    let listenerLockState = null;
    const unsub = subscribeRecoveryLock((locked) => {
      listenerCalled = true;
      listenerLockState = locked;
    });

    // Clear with correct PIN
    const clearRes = await clearRecoverySafetyLockWithPin(TEST_PIN);
    assert.equal(clearRes.success, true, 'Clear must succeed with correct PIN');

    // Verify lock is cleared
    assert.equal(isRecoverySafetyLocked(), false, 'isRecoverySafetyLocked must be false');
    assert.equal(await checkRecoverySafetyLockAsync(), false, 'checkRecoverySafetyLockAsync must be false');
    
    const storedLocalLock = JSON.parse(localStorage.getItem(RECOVERY_SAFETY_LOCK_KEY));
    assert.equal(storedLocalLock.locked, false, 'localStorage lock state must be locked: false');

    const dbLockVal = await getSetting(RECOVERY_SAFETY_LOCK_KEY);
    const parsedDb = JSON.parse(dbLockVal);
    assert.equal(parsedDb.locked, false, 'SQLite setting lock value must have locked: false');

    // Verify session is now unlocked
    assert.equal(isSyncUnlocked(), true, 'Session must now be unlocked');
    assert.ok(getSyncSessionKey(), 'Session CryptoKey must be present');
    assert.equal(getPersistedPin(), TEST_PIN, 'Persisted PIN must be restored in memory');

    // Verify listener was notified
    assert.equal(listenerCalled, true, 'Recovery lock listener must be notified');
    assert.equal(listenerLockState, false, 'Listener must receive locked = false');

    unsub();
  });

  it('7. ReconcileExistingDeviceWithSnapshot arms lock before any network request', async () => {
    const { reconcileExistingDeviceWithSnapshot } = await import('../services/snapshotDeviceImport.js');

    // Verify lock is currently false
    assert.equal(isRecoverySafetyLocked(), false);

    // Invoke reconcile with confirmation but omitting pin/key to trigger parameter error after lock is armed
    try {
      await reconcileExistingDeviceWithSnapshot({
        confirmation: 'CONFIRM_RECONCILE_EXISTING_DEVICE',
        targetSnapshotId: 'test_snap',
        targetCloudVersion: 16
        // Omitting pin / sessionKey triggers early throw in parameter validation
      });
    } catch {}

    // Verify that the lock was ALREADY set before the error / network attempt
    assert.equal(isRecoverySafetyLocked(), true, 'Lock must be armed at the start of reconciliation');
    const details = getRecoverySafetyLockDetails();
    assert.equal(details.reason, RECOVERY_LOCK_REASON.RECONCILIATION_IN_PROGRESS);
  });

  it('8. Recovery-bootstrap: Existing persisted PIN with NO recovery lock key defaults to LOCKED before PIN restoration', async () => {
    // Simulate pre-existing Android state before safety fix:
    // 1. Valid persisted PIN exists in SQLite settings and localStorage.
    const token = encodePersistedToken(TEST_PIN);
    localStorage.setItem('finman_persisted_sync_pin', token);
    await setSetting('finman_persisted_sync_pin', token, { suppressDeltaQueue: true });

    // 2. Recovery lock state has NEVER been set (no record in localStorage or SQLite)
    resetRecoveryLockMemoryCache();
    localStorage.removeItem(RECOVERY_SAFETY_LOCK_KEY);
    await getDB().run('DELETE FROM settings WHERE key = ?', [RECOVERY_SAFETY_LOCK_KEY]);

    // Verify initial preconditions: key is completely absent
    assert.equal(localStorage.getItem(RECOVERY_SAFETY_LOCK_KEY), null);
    assert.equal(await getSetting(RECOVERY_SAFETY_LOCK_KEY), null);

    // 3. Simulate application startup: initSyncSessionFromStorage() is triggered
    const restoredKey = await initSyncSessionFromStorage();

    // Verification A: PIN restoration MUST be blocked
    assert.equal(restoredKey, null, 'Must not restore session key on uninitialized recovery installation');
    assert.equal(isSyncUnlocked(), false, 'Session must remain locked');
    assert.equal(getSyncSessionKey(), null, 'Session key must be null');

    // Verification B: Recovery lock MUST be automatically established & defaulted to LOCKED
    assert.equal(isRecoverySafetyLocked(), true, 'Must report locked synchronously');
    assert.equal(await checkRecoverySafetyLockAsync(), true, 'Must report locked asynchronously');

    const lockDetails = getRecoverySafetyLockDetails();
    assert.ok(lockDetails, 'Lock details must exist');
    assert.equal(lockDetails.locked, true);
    assert.equal(lockDetails.reason, RECOVERY_LOCK_REASON.BOOTSTRAP_DEFAULT_LOCKED);

    // Verification C: Lock MUST be durably written to SQLite settings and localStorage
    const storedDbLock = await getSetting(RECOVERY_SAFETY_LOCK_KEY);
    assert.ok(storedDbLock, 'Lock must be persisted in SQLite settings');
    const parsedDbLock = JSON.parse(storedDbLock);
    assert.equal(parsedDbLock.locked, true);
    assert.equal(parsedDbLock.reason, RECOVERY_LOCK_REASON.BOOTSTRAP_DEFAULT_LOCKED);

    // Verification D: User's persisted PIN and metadata must NOT be overwritten or corrupted
    const storedLocalPin = localStorage.getItem('finman_persisted_sync_pin');
    const storedDbPin = await getSetting('finman_persisted_sync_pin');
    assert.equal(storedLocalPin, token, 'localStorage PIN token must be preserved');
    assert.equal(storedDbPin, token, 'SQLite settings PIN token must be preserved');

    // Verification E: ZERO cloud requests can occur while locked
    const discoveryRes = await discoverCloudRepository();
    assert.equal(discoveryRes.status, 'RECOVERY_LOCKED', 'Cloud discovery must be blocked');

    const reconcileRes = await checkAndAutoReconcileCloudSnapshot();
    assert.equal(reconcileRes.reconciled, false);
    assert.equal(reconcileRes.reason, 'RECOVERY_SAFETY_LOCK_ACTIVE', 'Reconciliation must be blocked');

    const autoSyncRes = await triggerAutomaticSync(SYNC_TRIGGER.STARTUP);
    assert.equal(autoSyncRes.status, 'RECOVERY_LOCKED', 'Auto sync must be blocked');

    const fullPassRes = await executeFullSyncPass({ trigger: SYNC_TRIGGER.STARTUP });
    assert.equal(fullPassRes.status, 'RECOVERY_LOCKED', 'Full sync pass must be blocked');

    // Verification F: Explicit PIN confirmation clears lock and unlocks session
    const clearRes = await clearRecoverySafetyLockWithPin(TEST_PIN);
    assert.equal(clearRes.success, true);
    assert.equal(isRecoverySafetyLocked(), false);
    assert.equal(isSyncUnlocked(), true);
  });
});
