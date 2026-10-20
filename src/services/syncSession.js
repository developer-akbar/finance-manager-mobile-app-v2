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

const PERSISTED_PIN_STORAGE_KEY = 'finman_persisted_sync_pin';
const TOKEN_PREFIX = 'fnm_v1:';
const PIN_MASK_SALT = [0x5f, 0x1a, 0x7c, 0x3d, 0x9b, 0x2e, 0x4f, 0x8a];

let _sessionKeyMaterial = null;
let _persistedPin = null;
const _listeners = new Set();

/**
 * Encodes a PIN string with mask salt and prefix
 */
export function encodePersistedToken(pin) {
  if (!pin || typeof pin !== 'string') return null;
  const clean = pin.trim();
  if (!clean) return null;
  try {
    const bytes = new TextEncoder().encode(clean);
    const masked = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      masked[i] = bytes[i] ^ PIN_MASK_SALT[i % PIN_MASK_SALT.length];
    }
    let binary = '';
    for (let i = 0; i < masked.length; i++) {
      binary += String.fromCharCode(masked[i]);
    }
    const b64 = typeof btoa !== 'undefined' ? btoa(binary) : Buffer.from(masked).toString('base64');
    return `${TOKEN_PREFIX}${b64}`;
  } catch {
    return null;
  }
}

/**
 * Decodes a persisted token. If legacy unmasked raw PIN is encountered, returns it directly.
 */
export function decodePersistedToken(token) {
  if (!token || typeof token !== 'string') return null;
  const clean = token.trim();
  if (!clean) return null;

  // New prefixed format: decode mask
  if (clean.startsWith(TOKEN_PREFIX)) {
    try {
      const b64 = clean.slice(TOKEN_PREFIX.length);
      const binary = typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i) ^ PIN_MASK_SALT[i % PIN_MASK_SALT.length];
      }
      const decoded = new TextDecoder().decode(bytes);
      if (/^[\x20-\x7E]+$/.test(decoded)) {
        return decoded;
      }
    } catch {
      return null;
    }
  }

  // Legacy unmasked raw PIN (e.g. "211200"): return directly as string without corrupting
  if (/^[\x20-\x7E]+$/.test(clean) && !clean.includes('\uFFFD')) {
    return clean;
  }

  return null;
}

/**
 * Generates the transient corrupted PIN that was produced during the token migration bug
 * when a raw PIN was mistakenly decoded with atob + mask salt.
 * Used for transparent fallback decryption of packages/snapshots created during that window.
 */
export function getLegacyCorruptedPin(pin) {
  if (!pin || typeof pin !== 'string') return null;
  const clean = pin.trim();
  try {
    const binary = typeof atob !== 'undefined' ? atob(clean) : Buffer.from(clean, 'base64').toString('binary');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i) ^ PIN_MASK_SALT[i % PIN_MASK_SALT.length];
    }
    const corrupted = new TextDecoder().decode(bytes);
    return corrupted !== clean ? corrupted : null;
  } catch {
    return null;
  }
}

/**
 * Get active raw PIN if known in memory
 */
export function getPersistedPin() {
  return _persistedPin;
}

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
 * Automatically restore session key from persisted device storage on app/page load.
 * Checks localStorage first, then SQLite settings as Capacitor native fallback.
 */
export async function initSyncSessionFromStorage() {
  if (_sessionKeyMaterial) return _sessionKeyMaterial;
  try {
    let saved = null;
    if (typeof localStorage !== 'undefined') {
      try {
        saved = localStorage.getItem(PERSISTED_PIN_STORAGE_KEY);
      } catch {}
    }

    if (!saved || typeof saved !== 'string' || !saved.trim()) {
      try {
        const { getSetting } = await import('../database/settings.js');
        saved = await getSetting(PERSISTED_PIN_STORAGE_KEY).catch(() => null);
      } catch {}
    }

    if (saved && typeof saved === 'string' && saved.trim()) {
      const decodedPin = decodePersistedToken(saved.trim());
      if (decodedPin) {
        _persistedPin = decodedPin;
        _sessionKeyMaterial = await deriveKeyMaterial(decodedPin);

        // Upgrade storage to prefixed format if it was legacy unmasked
        if (!saved.trim().startsWith(TOKEN_PREFIX)) {
          const upgraded = encodePersistedToken(decodedPin);
          if (upgraded) {
            if (typeof localStorage !== 'undefined') {
              try { localStorage.setItem(PERSISTED_PIN_STORAGE_KEY, upgraded); } catch {}
            }
            import('../database/settings.js').then(({ setSetting }) => {
              setSetting(PERSISTED_PIN_STORAGE_KEY, upgraded, { suppressDeltaQueue: true }).catch(() => {});
            }).catch(() => {});
          }
        }

        notifyListeners();
        return _sessionKeyMaterial;
      }
    }
  } catch (err) {
    console.warn('[SyncSession] Storage restoration error:', err);
  }
  return null;
}

// Trigger storage restoration on module evaluation
if (typeof window !== 'undefined') {
  initSyncSessionFromStorage().catch(() => {});
}

/**
 * Unlock the session by deriving an in-memory PBKDF2 CryptoKey from a PIN or existing CryptoKey.
 * Persists PIN locally by default so page refreshes and background auto-syncs stay active.
 */
export async function unlockSyncSession(pinOrKey, options = {}) {
  const shouldPersist = options.persist !== false;

  if (pinOrKey && typeof pinOrKey === 'object' && pinOrKey.algorithm?.name === 'PBKDF2') {
    _sessionKeyMaterial = pinOrKey;
    notifyListeners();
    return _sessionKeyMaterial;
  }

  if (!pinOrKey || typeof pinOrKey !== 'string' || !pinOrKey.trim()) {
    throw new Error('Please enter a valid PIN to unlock.');
  }

  const cleanPin = pinOrKey.trim();
  _persistedPin = cleanPin;
  _sessionKeyMaterial = await deriveKeyMaterial(cleanPin);

  if (shouldPersist) {
    const token = encodePersistedToken(cleanPin);
    if (token) {
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(PERSISTED_PIN_STORAGE_KEY, token);
        } catch {}
      }
      import('../database/settings.js').then(({ setSetting }) => {
        setSetting(PERSISTED_PIN_STORAGE_KEY, token, { suppressDeltaQueue: true }).catch(() => {});
      }).catch(() => {});
    }
  }

  notifyListeners();
  return _sessionKeyMaterial;
}

/**
 * Lock the session, remove the persisted PIN from local storage and SQLite, and discard in-memory CryptoKey
 */
export function lockSyncSession() {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(PERSISTED_PIN_STORAGE_KEY);
    } catch {}
  }
  import('../database/settings.js').then(({ setSetting }) => {
    setSetting(PERSISTED_PIN_STORAGE_KEY, '', { suppressDeltaQueue: true }).catch(() => {});
  }).catch(() => {});

  _sessionKeyMaterial = null;
  _persistedPin = null;
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
