/**
 * googleAuth.js — Multi-Platform Google OAuth & Transport Identity Service
 * 
 * Provides Google Identity Services (GIS) token authentication for Web
 * and Capacitor environments.
 * 
 * Targets ONLY the minimal, sandboxed scope:
 * https://www.googleapis.com/auth/drive.appdata
 * 
 * Zero access to user's personal Google Drive files.
 * Zero personal profile or email data requested.
 */

import { getSetting, setSetting } from '../database/settings.js';
import { Capacitor, registerPlugin } from '@capacitor/core';

export const GoogleAuthBridge = registerPlugin('GoogleAuthBridge');
let _authBridge = GoogleAuthBridge;

/**
 * Configure or override the native auth bridge instance (useful for test isolation)
 */
export function setNativeAuthBridge(bridge) {
  _authBridge = bridge || GoogleAuthBridge;
}

export function getNativeAuthBridge() {
  return _authBridge;
}

export const AUTH_WATCHDOG_TIMEOUT_MS = 60000; // 60 seconds

export const GOOGLE_DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const STORAGE_KEY_TOKEN = 'finman_gdrive_token';
export const STORAGE_KEY_EXPIRY = 'finman_gdrive_token_expiry';
export const STORAGE_KEY_LINKED = 'finman_gdrive_linked';
export const STORAGE_KEY_EMAIL = 'finman_gdrive_email';
export const STORAGE_KEY_DISPLAY_NAME = 'finman_gdrive_display_name';

export const SILENT_REFRESH_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

let _tokenClient = null;
let _gisLoadedPromise = null;
let _lastSilentRefreshFailureTime = 0;

/**
 * Check if the active runtime platform supports native Google Play Services Auth
 */
export function isNativeAuthSupported() {
  try {
    return typeof Capacitor !== 'undefined' && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Reset the silent refresh failure cooldown timer (useful for testing and user-initiated auth resets)
 */
export function resetSilentRefreshCooldown() {
  _lastSilentRefreshFailureTime = 0;
}

/**
 * Get remaining cooldown time in milliseconds before next silent refresh attempt is allowed
 */
export function getSilentRefreshCooldownRemaining() {
  const elapsed = Date.now() - _lastSilentRefreshFailureTime;
  return Math.max(0, SILENT_REFRESH_COOLDOWN_MS - elapsed);
}

/**
 * Check if the user has previously linked their Google Drive account
 */
export function isGoogleLinked() {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY_LINKED) === 'true';
  } catch {
    return false;
  }
}

/**
 * Set or clear the persistent Google Account link state
 */
export function setGoogleLinked(linked) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (linked) {
      localStorage.setItem(STORAGE_KEY_LINKED, 'true');
    } else {
      localStorage.removeItem(STORAGE_KEY_LINKED);
    }
  } catch (err) {
    console.warn('Failed to set Google linked state:', err);
  }
}

/**
 * Dynamically load Google Identity Services (GIS) client script on web
 */
export function loadGisScript() {
  if (_gisLoadedPromise) return _gisLoadedPromise;
  _gisLoadedPromise = new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.google?.accounts?.oauth2) {
      resolve(window.google.accounts.oauth2);
      return;
    }
    if (typeof document === 'undefined') {
      reject(new Error('DOM environment not available for GIS script loader.'));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google?.accounts?.oauth2) {
        resolve(window.google.accounts.oauth2);
      } else {
        reject(new Error('Google Identity Services script failed to initialize.'));
      }
    };
    script.onerror = () => reject(new Error('Failed to load Google Identity Services SDK.'));
    document.head.appendChild(script);
  });
  return _gisLoadedPromise;
}

/**
 * Get configured Google OAuth Client ID
 * Reads from database settings or environment variable.
 * Does not hardcode personal client IDs.
 */
export async function getGoogleClientId() {
  try {
    const saved = await getSetting('google_client_id');
    if (saved && saved.trim()) return saved.trim();
  } catch { }
  return (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GOOGLE_CLIENT_ID) || (typeof process !== 'undefined' && process.env?.VITE_GOOGLE_CLIENT_ID) || '';
}

/**
 * Inspect source and classification of active Google OAuth Client ID
 * Returns whether active ID is a custom database setting or environment fallback.
 */
export async function getGoogleClientIdSource() {
  try {
    const saved = await getSetting('google_client_id');
    if (saved && saved.trim()) {
      return {
        isCustom: true,
        source: 'CUSTOM_SAVED'
      };
    }
  } catch { }
  const envId = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GOOGLE_CLIENT_ID) || (typeof process !== 'undefined' && process.env?.VITE_GOOGLE_CLIENT_ID) || '';
  return {
    isCustom: false,
    source: envId ? 'ENV_DEFAULT' : 'NONE'
  };
}

/**
 * Save custom Google OAuth Client ID
 */
export async function setGoogleClientId(clientId) {
  await setSetting('google_client_id', (clientId || '').trim());
  _tokenClient = null; // Reset token client instance
}

/**
 * Check if a cached access token is valid and unexpired
 */
export function getStoredToken() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const token = localStorage.getItem(STORAGE_KEY_TOKEN);
    const expiry = localStorage.getItem(STORAGE_KEY_EXPIRY);
    if (!token) return null;
    if (expiry && Date.now() > parseInt(expiry, 10) - 60000) {
      // Token expired or expires within 60 seconds
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

const _authListeners = new Set();

function notifyAuthListeners(isAuthenticated, token) {
  _authListeners.forEach(fn => {
    try {
      fn(isAuthenticated, token);
    } catch (e) {
      console.warn('[GoogleAuth] Listener error:', e);
    }
  });
}

/**
 * Subscribe to Google OAuth state changes (connect, reconnect, token refresh, disconnect)
 */
export function subscribeGoogleAuth(listener) {
  if (typeof listener !== 'function') return () => { };
  _authListeners.add(listener);
  return () => {
    _authListeners.delete(listener);
  };
}

/**
 * Get cached Google user identity from local storage
 */
export function getStoredGoogleUser() {
  try {
    if (typeof localStorage === 'undefined') return { email: '', displayName: '' };
    return {
      email: localStorage.getItem(STORAGE_KEY_EMAIL) || '',
      displayName: localStorage.getItem(STORAGE_KEY_DISPLAY_NAME) || ''
    };
  } catch {
    return { email: '', displayName: '' };
  }
}

/**
 * Save Google user identity to local storage
 */
export function saveGoogleUserData(emailAddress, displayName) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (emailAddress) {
      localStorage.setItem(STORAGE_KEY_EMAIL, String(emailAddress).trim());
    } else {
      localStorage.removeItem(STORAGE_KEY_EMAIL);
    }
    if (displayName) {
      localStorage.setItem(STORAGE_KEY_DISPLAY_NAME, String(displayName).trim());
    } else {
      localStorage.removeItem(STORAGE_KEY_DISPLAY_NAME);
    }
  } catch (err) {
    console.warn('Failed to save Google user identity:', err);
  }
}

/**
 * Clear cached Google user identity
 */
export function clearGoogleUserData() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY_EMAIL);
    localStorage.removeItem(STORAGE_KEY_DISPLAY_NAME);
  } catch { }
}

/**
 * Asynchronously fetch and cache Google user info without blocking auth
 */
export async function syncGoogleUserInfo(accessToken) {
  if (!accessToken) return null;
  try {
    const { fetchGoogleUserInfo } = await import('./googleDriveSync.js');
    const info = await fetchGoogleUserInfo(accessToken);
    if (info && info.emailAddress) {
      saveGoogleUserData(info.emailAddress, info.displayName);
      notifyAuthListeners(true, accessToken);
    }
    return info;
  } catch (err) {
    // Non-blocking: identity fetch failure (e.g. offline/network) must not break auth token
    return null;
  }
}

/**
 * Store access token, expiry timestamp, and mark account as linked
 */
export function saveTokenData(accessToken, expiresInSeconds) {
  if (!accessToken || typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('Refusing to save invalid or empty access token.');
  }
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY_TOKEN, accessToken);
    const expiryTimestamp = Date.now() + (expiresInSeconds || 3500) * 1000;
    localStorage.setItem(STORAGE_KEY_EXPIRY, String(expiryTimestamp));
    setGoogleLinked(true);
    _lastSilentRefreshFailureTime = 0; // Clear failure cooldown on successful token save
    notifyAuthListeners(true, accessToken);
    // Non-blocking background fetch of user info
    syncGoogleUserInfo(accessToken).catch(() => { });
  } catch (err) {
    console.error('Failed to save Google token data:', err);
  }
}

/**
 * Invalidate cached access token on confirmed authorization failure (e.g. 401).
 * Clears access token and expiry from storage while preserving account linked state.
 */
export function invalidateStoredToken() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY_TOKEN);
      localStorage.removeItem(STORAGE_KEY_EXPIRY);
    }
    notifyAuthListeners(false, null);
  } catch (err) {
    console.warn('[GoogleAuth] Error invalidating stored token:', err);
  }
}

/**
 * Clear cached authentication data, link state, and revoke token
 */
export function clearGoogleAuth() {
  try {
    const token = getStoredToken();
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY_TOKEN);
      localStorage.removeItem(STORAGE_KEY_EXPIRY);
    }
    clearGoogleUserData();
    _lastSilentRefreshFailureTime = 0;
    setGoogleLinked(false);
    notifyAuthListeners(false, null);

    if (isNativeAuthSupported()) {
      getGoogleClientId().then(cid => {
        _authBridge.signOut({ clientId: cid }).catch(() => {});
      }).catch(() => {});
    } else if (typeof window !== 'undefined' && window.google?.accounts?.oauth2?.revoke && token) {
      window.google.accounts.oauth2.revoke(token, () => { });
    }
  } catch (err) {
    console.warn('Error clearing Google auth:', err);
  }
}

/**
 * Native Android Google Sign-In via Google Play Services
 */
export async function signInWithGoogleNative(clientId, prompt = 'consent') {
  const res = await _authBridge.signIn({ clientId });
  const token = res?.accessToken;
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new Error('Native Google Sign-In returned invalid access token.');
  }
  saveTokenData(token, res.expiresIn || 3500);
  if (res.email) {
    saveGoogleUserData(res.email, res.displayName || '');
  }
  return {
    accessToken: token
  };
}

/**
 * Native Android silent token refresh via Google Play Services
 */
export async function refreshNativeToken() {
  const oldToken = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY_TOKEN)) || '';
  const clientId = await getGoogleClientId();
  const res = await _authBridge.refresh({ clientId, oldToken });
  const token = res?.accessToken;
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new Error('Native silent refresh returned invalid access token.');
  }
  saveTokenData(token, res.expiresIn || 3500);
  if (res.email) {
    saveGoogleUserData(res.email, res.displayName || '');
  }
  return token;
}

/**
 * Trigger Google Sign-In & Authorization
 * Requests strictly drive.appdata scope.
 * Automatically delegates to native Google Play Services on Android or GIS on Web.
 */
export async function signInWithGoogle({ prompt = 'consent', signal } = {}) {
  if (signal?.aborted) {
    throw new Error('Authentication was cancelled.');
  }

  const clientId = await getGoogleClientId();
  if (!clientId) {
    throw new Error('Google OAuth Client ID is not configured. Please enter your Client ID in Cloud Sync settings.');
  }

  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Authentication timed out. Please try again.'));
    }, AUTH_WATCHDOG_TIMEOUT_MS);
  });

  const abortPromise = signal ? new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('Authentication was cancelled.'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new Error('Authentication was cancelled.'));
    }, { once: true });
  }) : null;

  const authPromise = (async () => {
    if (isNativeAuthSupported()) {
      return signInWithGoogleNative(clientId, prompt);
    }

    // Web / GIS flow
    await loadGisScript();

    return new Promise((resolve, reject) => {
      try {
        _tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: GOOGLE_DRIVE_APPDATA_SCOPE,
          prompt: prompt,
          callback: async (response) => {
            if (response.error) {
              reject(new Error(response.error_description || response.error));
              return;
            }
            if (response.access_token && typeof response.access_token === 'string' && response.access_token.trim().length >= 20) {
              saveTokenData(response.access_token, response.expires_in);
              resolve({
                accessToken: response.access_token
              });
            } else {
              reject(new Error('No valid access token received from Google.'));
            }
          },
          error_callback: (err) => {
            reject(new Error(err.message || 'Google Sign-In failed or popup was closed.'));
          }
        });

        _tokenClient.requestAccessToken({ prompt: prompt });
      } catch (err) {
        reject(err);
      }
    });
  })();

  const raceTargets = [authPromise, timeoutPromise];
  if (abortPromise) raceTargets.push(abortPromise);

  try {
    const result = await Promise.race(raceTargets);
    return result;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Get a valid access token.
 * 1. Checks unexpired cached token.
 * 2. If expired/missing but account is linked:
 *    - On Android: Attempts Google Play Services silent refresh via GoogleAuthBridge.refresh()
 *    - On Web: Attempts GIS silent refresh (prompt: '') if not in cooldown
 * 3. If interactive is true and silent refresh fails (or was in cooldown), prompts user with interactive dialog.
 */
export async function getValidAccessToken(interactive = false) {
  const stored = getStoredToken();
  if (stored) {
    const user = getStoredGoogleUser();
    if (!user.email) {
      syncGoogleUserInfo(stored).catch(() => { });
    }
    return stored;
  }

  // Attempt silent refresh if account was previously linked and not in cooldown
  const isCooldownActive = (Date.now() - _lastSilentRefreshFailureTime) < SILENT_REFRESH_COOLDOWN_MS;
  if (isGoogleLinked() && !isCooldownActive) {
    try {
      if (isNativeAuthSupported()) {
        const freshToken = await refreshNativeToken();
        if (freshToken) {
          _lastSilentRefreshFailureTime = 0;
          syncGoogleUserInfo(freshToken).catch(() => { });
          return freshToken;
        }
      } else {
        const result = await signInWithGoogle({ prompt: '' });
        if (result && result.accessToken) {
          _lastSilentRefreshFailureTime = 0;
          syncGoogleUserInfo(result.accessToken).catch(() => { });
          return result.accessToken;
        }
      }
    } catch (silentErr) {
      _lastSilentRefreshFailureTime = Date.now();
      console.warn('[GoogleAuth] Silent token refresh failed, starting cooldown:', silentErr.message);
    }
  }

  // Interactive authentication is never blocked by silent refresh cooldown
  if (interactive) {
    const result = await signInWithGoogle({ prompt: 'consent' });
    if (result && result.accessToken) {
      _lastSilentRefreshFailureTime = 0;
      syncGoogleUserInfo(result.accessToken).catch(() => { });
      return result.accessToken;
    }
  }

  return null;
}
