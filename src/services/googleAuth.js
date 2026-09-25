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

export const GOOGLE_DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const STORAGE_KEY_TOKEN = 'finman_gdrive_token';
export const STORAGE_KEY_EXPIRY = 'finman_gdrive_token_expiry';
export const STORAGE_KEY_LINKED = 'finman_gdrive_linked';

let _tokenClient = null;
let _gisLoadedPromise = null;

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
  } catch {}
  return (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GOOGLE_CLIENT_ID) || '';
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

/**
 * Store access token, expiry timestamp, and mark account as linked
 */
export function saveTokenData(accessToken, expiresInSeconds) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY_TOKEN, accessToken);
    const expiryTimestamp = Date.now() + (expiresInSeconds || 3500) * 1000;
    localStorage.setItem(STORAGE_KEY_EXPIRY, String(expiryTimestamp));
    setGoogleLinked(true);
  } catch (err) {
    console.error('Failed to save Google token data:', err);
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
    setGoogleLinked(false);
    if (typeof window !== 'undefined' && window.google?.accounts?.oauth2?.revoke && token) {
      window.google.accounts.oauth2.revoke(token, () => {});
    }
  } catch (err) {
    console.warn('Error clearing Google auth:', err);
  }
}

/**
 * Trigger Google Sign-In & Authorization
 * Requests strictly drive.appdata scope.
 */
export async function signInWithGoogle({ prompt = 'consent' } = {}) {
  const clientId = await getGoogleClientId();
  if (!clientId) {
    throw new Error('Google OAuth Client ID is not configured. Please enter your Client ID in Cloud Sync settings.');
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
          if (response.access_token) {
            saveTokenData(response.access_token, response.expires_in);
            resolve({
              accessToken: response.access_token
            });
          } else {
            reject(new Error('No access token received from Google.'));
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
}

/**
 * Get a valid access token.
 * 1. Checks unexpired cached token.
 * 2. If expired/missing but account is linked, attempts GIS silent refresh (prompt: '').
 * 3. If interactive is true and silent refresh fails, prompts user with popup.
 */
export async function getValidAccessToken(interactive = false) {
  const stored = getStoredToken();
  if (stored) return stored;

  // Attempt silent refresh if account was previously linked
  if (isGoogleLinked()) {
    try {
      const result = await signInWithGoogle({ prompt: '' });
      if (result && result.accessToken) {
        return result.accessToken;
      }
    } catch (silentErr) {
      console.warn('[GoogleAuth] Silent token refresh failed:', silentErr.message);
    }
  }

  if (interactive) {
    const result = await signInWithGoogle({ prompt: 'consent' });
    return result.accessToken;
  }

  return null;
}
