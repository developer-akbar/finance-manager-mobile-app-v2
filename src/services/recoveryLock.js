/**
 * recoveryLock.js — Persistent Recovery Safety Lock (Phase A)
 *
 * Guarantees that if a snapshot recovery or reconciliation process is initiated,
 * interrupted, or killed by an Out-Of-Memory (OOM) crash:
 * 1. The device is durably locked in SQLite settings and localStorage.
 * 2. On restart, automatic PIN restoration is completely suppressed.
 * 3. All automatic sync entry points (startup timers, focus, visibility,
 *    reconciliation checks, cloud discovery, delta sync) are blocked.
 * 4. The user's persisted PIN and encryption metadata remain intact.
 * 5. Only explicit user action with PIN confirmation can clear the lock.
 */

export const RECOVERY_SAFETY_LOCK_KEY = 'finman_recovery_safety_lock';

export const RECOVERY_LOCK_REASON = {
  RECONCILIATION_IN_PROGRESS: 'SNAPSHOT_RECONCILIATION_IN_PROGRESS',
  OOM_CRASH_DETECTED: 'OOM_CRASH_DETECTED',
  BOOTSTRAP_DEFAULT_LOCKED: 'RECOVERY_BOOTSTRAP_DEFAULT_LOCKED',
  MANUAL_LOCK: 'MANUAL_LOCK'
};

let _cachedLockState = false;
let _cachedLockDetails = null;
const _lockListeners = new Set();

/**
 * Checks whether runtime is running on Android / native platform
 */
export function isAndroidRuntime() {
  if (typeof window !== 'undefined') {
    if (window.Capacitor?.getPlatform?.() === 'android') return true;
    if (window.location?.protocol === 'capacitor:') return true;
    if (typeof navigator !== 'undefined' && navigator.userAgent && /android/i.test(navigator.userAgent)) return true;
  }
  return false;
}

/**
 * Synchronous check for persisted PIN in localStorage
 */
function hasPersistedPinInLocalStorage() {
  if (typeof localStorage !== 'undefined') {
    try {
      const p = localStorage.getItem('finman_persisted_sync_pin');
      if (p && typeof p === 'string' && p.trim()) return true;
    } catch {}
  }
  return false;
}

// Synchronous initialization & Android recovery-bootstrap from localStorage
if (typeof localStorage !== 'undefined') {
  try {
    const raw = localStorage.getItem(RECOVERY_SAFETY_LOCK_KEY);
    if (raw && typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed) {
          if (parsed.locked === true || parsed === 'LOCKED') {
            _cachedLockState = true;
            _cachedLockDetails = parsed;
          } else if (parsed.locked === false) {
            _cachedLockState = false;
            _cachedLockDetails = parsed;
          }
        }
      } catch {
        if (raw === 'LOCKED' || raw === 'true') {
          _cachedLockState = true;
          _cachedLockDetails = { locked: true, reason: raw };
        }
      }
    } else {
      // No recovery lock state exists yet in localStorage!
      // Requirement 1: Recovery-bootstrap mechanism that defaults to LOCKED for this recovery installation when no recovery lock state exists.
      if (isAndroidRuntime() || hasPersistedPinInLocalStorage()) {
        _cachedLockState = true;
        _cachedLockDetails = {
          locked: true,
          reason: RECOVERY_LOCK_REASON.BOOTSTRAP_DEFAULT_LOCKED,
          locked_at: new Date().toISOString(),
          details: 'Initial recovery lock established on updated APK bootstrap'
        };
        try {
          localStorage.setItem(RECOVERY_SAFETY_LOCK_KEY, JSON.stringify(_cachedLockDetails));
        } catch {}
      }
    }
  } catch (initErr) {
    // Fail closed: Any initialization error defaults to LOCKED
    _cachedLockState = true;
    _cachedLockDetails = {
      locked: true,
      reason: 'INIT_ERROR_FAIL_CLOSED',
      error: initErr?.message
    };
  }
}

function notifyRecoveryLockListeners(isLocked, details) {
  for (const listener of _lockListeners) {
    try {
      listener(isLocked, details);
    } catch (err) {
      console.warn('[RecoveryLock] Listener error:', err);
    }
  }
}

/**
 * Fast synchronous check for recovery safety lock (cached in memory and localStorage).
 */
export function isRecoverySafetyLocked() {
  if (_cachedLockState) return true;
  if (_cachedLockDetails && _cachedLockDetails.locked === false) return false;

  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(RECOVERY_SAFETY_LOCK_KEY);
      if (raw && typeof raw === 'string' && raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed) {
            if (parsed.locked === true || parsed === 'LOCKED') {
              _cachedLockState = true;
              _cachedLockDetails = parsed;
              return true;
            } else if (parsed.locked === false) {
              _cachedLockState = false;
              _cachedLockDetails = parsed;
              return false;
            }
          }
        } catch {
          if (raw === 'LOCKED' || raw === 'true') {
            _cachedLockState = true;
            _cachedLockDetails = { locked: true, reason: raw };
            return true;
          }
        }
      } else {
        // Uninitialized in localStorage: check bootstrap rule
        if (isAndroidRuntime() || hasPersistedPinInLocalStorage()) {
          _cachedLockState = true;
          _cachedLockDetails = {
            locked: true,
            reason: RECOVERY_LOCK_REASON.BOOTSTRAP_DEFAULT_LOCKED,
            locked_at: new Date().toISOString()
          };
          try {
            localStorage.setItem(RECOVERY_SAFETY_LOCK_KEY, JSON.stringify(_cachedLockDetails));
          } catch {}
          return true;
        }
      }
    } catch {}
  }
  return false;
}

/**
 * Reset in-memory cache for process restart simulation or clean test isolation
 */
export function resetRecoveryLockMemoryCache() {
  _cachedLockState = false;
  _cachedLockDetails = null;
}

/**
 * Asynchronous, durable check against both localStorage and SQLite settings.
 * If no recovery lock state exists on installation, defaults to LOCKED and persists the lock.
 * If SQLite and localStorage conflict, fails closed and remains LOCKED.
 */
export async function checkRecoverySafetyLockAsync() {
  try {
    const { getDB } = await import('../database/db.js');
    const { getSetting, setSetting } = await import('../database/settings.js');
    
    // Assert database is responsive; failure to access DB must fail closed
    const db = getDB();
    if (!db) throw new Error('Database not initialized');

    const saved = await getSetting(RECOVERY_SAFETY_LOCK_KEY);

    let sqliteLocked = null;
    let sqliteDetails = null;

    // 1. Inspect SQLite persisted state
    if (saved && typeof saved === 'string' && saved.trim()) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed) {
          sqliteLocked = parsed.locked === true || parsed === 'LOCKED';
          sqliteDetails = parsed;
        }
      } catch {
        if (saved === 'LOCKED' || saved === 'true') {
          sqliteLocked = true;
          sqliteDetails = { locked: true, reason: saved };
        }
      }
    }

    // 2. Inspect localStorage persisted state
    let localLocked = null;
    let localDetails = null;
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(RECOVERY_SAFETY_LOCK_KEY);
        if (raw && typeof raw === 'string' && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (parsed) {
            localLocked = parsed.locked === true || parsed === 'LOCKED';
            localDetails = parsed;
          }
        }
      } catch {}
    }

    // 3. Conflict resolution / Fail-closed rule:
    // If either SQLite or localStorage indicates LOCKED, or if they conflict, device MUST remain LOCKED.
    if (sqliteLocked === true || localLocked === true) {
      _cachedLockState = true;
      _cachedLockDetails = (sqliteLocked ? sqliteDetails : localDetails) || {
        locked: true,
        reason: 'CONFLICT_FAIL_CLOSED_LOCKED'
      };
      // Harmonize both stores to locked
      const strLocked = JSON.stringify(_cachedLockDetails);
      if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem(RECOVERY_SAFETY_LOCK_KEY, strLocked); } catch {}
      }
      try {
        await setSetting(RECOVERY_SAFETY_LOCK_KEY, strLocked, { suppressDeltaQueue: true });
      } catch {}
      notifyRecoveryLockListeners(true, _cachedLockDetails);
      return true;
    }

    // 4. Both explicitly confirmed unlocked
    if (sqliteLocked === false && localLocked === false) {
      _cachedLockState = false;
      _cachedLockDetails = sqliteDetails || localDetails;
      return false;
    }

    // 5. Only one store has state and indicates unlocked -> harmonize
    if (sqliteLocked === false && localLocked === null) {
      _cachedLockState = false;
      _cachedLockDetails = sqliteDetails;
      if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem(RECOVERY_SAFETY_LOCK_KEY, saved); } catch {}
      }
      return false;
    }

    if (localLocked === false && sqliteLocked === null) {
      _cachedLockState = false;
      _cachedLockDetails = localDetails;
      try {
        await setSetting(RECOVERY_SAFETY_LOCK_KEY, JSON.stringify(localDetails), { suppressDeltaQueue: true });
      } catch {}
      return false;
    }

    // 6. NO RECOVERY LOCK RECORD EXISTS IN SQLITE OR LOCALSTORAGE!
    // Recovery-bootstrap rule: Check if device has an existing persisted PIN or is running on Android.
    const isAndroid = isAndroidRuntime();
    const hasPinLocal = hasPersistedPinInLocalStorage();
    const dbPin = await getSetting('finman_persisted_sync_pin').catch(() => null);
    const hasPinDb = Boolean(dbPin && typeof dbPin === 'string' && dbPin.trim());

    if (isAndroid || hasPinLocal || hasPinDb) {
      console.warn('[RecoveryLock] Bootstrap: No recovery lock state exists on installation with persisted PIN / Android. Defaulting to LOCKED.');
      const bootstrapPayload = {
        locked: true,
        reason: RECOVERY_LOCK_REASON.BOOTSTRAP_DEFAULT_LOCKED,
        locked_at: new Date().toISOString(),
        details: 'Initial recovery lock established on updated APK bootstrap'
      };
      const strPayload = JSON.stringify(bootstrapPayload);
      _cachedLockState = true;
      _cachedLockDetails = bootstrapPayload;

      if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem(RECOVERY_SAFETY_LOCK_KEY, strPayload); } catch {}
      }
      try {
        await setSetting(RECOVERY_SAFETY_LOCK_KEY, strPayload, { suppressDeltaQueue: true });
      } catch (err) {
        console.warn('[RecoveryLock] Failed to persist bootstrap lock in SQLite:', err);
      }
      notifyRecoveryLockListeners(true, bootstrapPayload);
      return true;
    }
  } catch (err) {
    // Fail-closed: Initialization or inspection errors must leave the system LOCKED
    console.warn('[RecoveryLock] Error in checkRecoverySafetyLockAsync (failing closed):', err);
    _cachedLockState = true;
    _cachedLockDetails = {
      locked: true,
      reason: 'INSPECTION_ERROR_FAIL_CLOSED',
      error: err?.message
    };
    notifyRecoveryLockListeners(true, _cachedLockDetails);
    return true;
  }

  _cachedLockState = false;
  _cachedLockDetails = null;
  return false;
}

/**
 * Returns current lock details or null if unlocked.
 */
export function getRecoverySafetyLockDetails() {
  return _cachedLockDetails;
}

/**
 * Durably arm the recovery safety lock. Must be set BEFORE a recovery attempt starts.
 */
export async function setRecoverySafetyLock(reason = RECOVERY_LOCK_REASON.RECONCILIATION_IN_PROGRESS, details = {}) {
  const lockPayload = {
    locked: true,
    reason,
    locked_at: new Date().toISOString(),
    ...details
  };
  const strPayload = JSON.stringify(lockPayload);

  _cachedLockState = true;
  _cachedLockDetails = lockPayload;

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(RECOVERY_SAFETY_LOCK_KEY, strPayload);
    } catch {}
  }

  try {
    const { setSetting } = await import('../database/settings.js');
    await setSetting(RECOVERY_SAFETY_LOCK_KEY, strPayload, { suppressDeltaQueue: true });
  } catch (err) {
    console.warn('[RecoveryLock] Warning: Failed to persist lock in SQLite settings:', err?.message);
  }

  notifyRecoveryLockListeners(true, lockPayload);
  return lockPayload;
}

/**
 * Clear the recovery lock. Requires explicit confirmation or force option.
 * Never silently called on startup. Durably stores locked: false.
 * If SQLite persistence fails, fails closed and re-arms in-memory and localStorage lock.
 */
export async function clearRecoverySafetyLock(options = {}) {
  if (!options.confirmed && !options.force) {
    throw new Error('Explicit confirmation is required to clear the recovery safety lock.');
  }

  const clearedPayload = {
    locked: false,
    status: 'CLEARED_BY_USER_PIN',
    cleared_at: new Date().toISOString(),
    reason: options.reason || 'EXPLICIT_CONFIRMATION'
  };
  const strPayload = JSON.stringify(clearedPayload);

  _cachedLockState = false;
  _cachedLockDetails = clearedPayload;

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(RECOVERY_SAFETY_LOCK_KEY, strPayload);
    } catch {}
  }

  try {
    const { setSetting } = await import('../database/settings.js');
    await setSetting(RECOVERY_SAFETY_LOCK_KEY, strPayload, { suppressDeltaQueue: true });
  } catch (err) {
    // Fail-closed: SQLite write failed! Cannot report success. Re-arm immediately.
    _cachedLockState = true;
    _cachedLockDetails = {
      locked: true,
      reason: 'SQLITE_PERSISTENCE_FAILURE',
      error: err?.message
    };
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(RECOVERY_SAFETY_LOCK_KEY, JSON.stringify(_cachedLockDetails));
      } catch {}
    }
    notifyRecoveryLockListeners(true, _cachedLockDetails);
    throw new Error(`CRITICAL: Failed to persist cleared recovery lock in SQLite settings: ${err?.message}`);
  }

  notifyRecoveryLockListeners(false, clearedPayload);
  return { success: true };
}

/**
 * Verifies PIN and clears the recovery safety lock with explicit user confirmation.
 * Session unlock must succeed BEFORE the recovery lock is cleared.
 * Missing stored PIN fails closed.
 */
export async function clearRecoverySafetyLockWithPin(pin, options = {}) {
  if (!pin || typeof pin !== 'string' || !pin.trim()) {
    throw new Error('Please enter your encryption PIN to clear the recovery lock.');
  }
  const cleanPin = pin.trim();

  // Validate PIN against stored persisted token if one exists
  let storedPin = null;
  if (typeof localStorage !== 'undefined') {
    try {
      const storedToken = localStorage.getItem('finman_persisted_sync_pin');
      if (storedToken) {
        const { decodePersistedToken } = await import('./syncSession.js');
        storedPin = decodePersistedToken(storedToken);
      }
    } catch {}
  }

  if (!storedPin) {
    try {
      const { getSetting } = await import('../database/settings.js');
      const dbToken = await getSetting('finman_persisted_sync_pin');
      if (dbToken) {
        const { decodePersistedToken } = await import('./syncSession.js');
        storedPin = decodePersistedToken(dbToken);
      }
    } catch {}
  }

  // Fail-closed: If no PIN is registered on device, lock CANNOT be cleared
  if (!storedPin) {
    throw new Error('No encryption PIN is registered on this device. Recovery lock cannot be cleared.');
  }

  if (storedPin !== cleanPin) {
    throw new Error('Incorrect PIN. Recovery safety lock cannot be cleared.');
  }

  // 1. Session unlock must succeed first. If it throws, lock remains armed.
  const { unlockSyncSession } = await import('./syncSession.js');
  await unlockSyncSession(cleanPin, { persist: true });

  // 2. Clear lock durably only after session is confirmed unlocked
  await clearRecoverySafetyLock({ confirmed: true, reason: 'USER_PIN_VERIFIED' });

  return { success: true };
}

/**
 * Subscribe to recovery lock state changes.
 */
export function subscribeRecoveryLock(listener) {
  _lockListeners.add(listener);
  // Initial emission to subscriber
  try {
    listener(_cachedLockState, _cachedLockDetails);
  } catch (e) {
    console.warn('[RecoveryLock] Initial subscriber notification error:', e);
  }
  return () => {
    _lockListeners.delete(listener);
  };
}
