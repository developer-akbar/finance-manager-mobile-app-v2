/**
 * syncSession.js — In-Memory Ephemeral Key & Session State Manager (Phase 6A)
 * 
 * Manages the transient, non-extractable PBKDF2 CryptoKey in JavaScript memory
 * during the active browser session.
 * 
 * Guarantees:
 * - Zero persistence: NEVER written to localStorage, sessionStorage, IndexedDB, or cookies.
 * - Non-extractable: CryptoKey cannot be exported or serialized.
 * - Minimal raw PIN lifetime: Raw string PIN is immediately discarded after key import.
 * - Zero leakage: Key is never exposed in logs, console, or UI.
 * - Cleared on: explicit Lock Sync, Google Disconnect, page refresh, or tab close.
 */

import { deriveKeyMaterial } from '../utils/cryptoBackup.js';

let _sessionKeyMaterial = null;
const _listeners = new Set();

function notifyListeners() {
  const isUnlocked = !!_sessionKeyMaterial;
  for (const listener of _listeners) {
    try {
      listener(isUnlocked, _sessionKeyMaterial);
    } catch (err) {
      console.warn('[SyncSession] Listener error:', err);
    }
  }
}

/**
 * Check if the sync session is currently unlocked with an in-memory key
 */
export function isSyncUnlocked() {
  return !!_sessionKeyMaterial;
}

/**
 * Get the in-memory non-extractable CryptoKey (null if locked)
 */
export function getSyncSessionKey() {
  return _sessionKeyMaterial;
}

/**
 * Unlock the session by deriving an in-memory PBKDF2 CryptoKey from a PIN or existing CryptoKey
 */
export async function unlockSyncSession(pinOrKey) {
  if (pinOrKey && typeof pinOrKey === 'object' && pinOrKey.algorithm?.name === 'PBKDF2') {
    _sessionKeyMaterial = pinOrKey;
    notifyListeners();
    return _sessionKeyMaterial;
  }

  if (!pinOrKey || typeof pinOrKey !== 'string' || !pinOrKey.trim()) {
    throw new Error('Please enter a valid PIN to unlock.');
  }

  // Derive non-extractable CryptoKey and immediately discard the raw PIN string
  _sessionKeyMaterial = await deriveKeyMaterial(pinOrKey.trim());
  notifyListeners();
  return _sessionKeyMaterial;
}

/**
 * Lock the session and immediately discard the in-memory CryptoKey
 */
export function lockSyncSession() {
  _sessionKeyMaterial = null;
  notifyListeners();
}

/**
 * Subscribe to sync session lock/unlock state changes
 */
export function subscribeSyncSession(listener) {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}
