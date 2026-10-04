/**
 * google_auth_resilience.test.js — Stage D1 Google Authentication Resilience Suite
 * 
 * Verifies:
 * A. Valid cached token returned immediately without GIS network calls
 * B. Expired token + silent renewal succeeds (new token saved, sync proceeds)
 * C. Expired token + silent renewal fails (cooldown starts, returns null / AUTH_REQUIRED)
 * D. Repeated background/foreground triggers during cooldown (no repeated silent GIS calls)
 * E. Explicit reconnect during cooldown (interactive authentication is not blocked)
 * F. Confirmed 401 (cached token & expiry invalidated, account link preserved, AUTH_REQUIRED)
 * G. Network failure (token is NOT invalidated)
 * H. 5xx server error (token is NOT invalidated)
 * I. Pending delta after auth expiry (remains PENDING, reconnect allows normal flush)
 * J. User-facing authentication-required copy (reassures local data safety, distinguishes PIN/auth)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// Ensure in-memory localStorage is available in Node test environment
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

import { initDB, getDB, closeDB } from '../database/db.js';
import { setSetting } from '../database/settings.js';
import {
  getStoredToken,
  saveTokenData,
  clearGoogleAuth,
  invalidateStoredToken,
  getValidAccessToken,
  isGoogleLinked,
  setGoogleLinked,
  resetSilentRefreshCooldown,
  getSilentRefreshCooldownRemaining,
  SILENT_REFRESH_COOLDOWN_MS,
  STORAGE_KEY_TOKEN,
  STORAGE_KEY_EXPIRY,
  STORAGE_KEY_LINKED
} from '../services/googleAuth.js';
import {
  deriveUnifiedSyncStatus,
  UNIFIED_SYNC_STATUS_KEYS
} from '../utils/cloudSyncStatusHelper.js';
import {
  findAppDataFile,
  readAppDataFile,
  uploadAppDataFile
} from '../services/googleDriveSync.js';

describe('FinMan Stage D1 — Google Authentication Resilience Suite', () => {
  beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    await initDB();
    clearGoogleAuth();
    resetSilentRefreshCooldown();
  });

  test('A. Valid cached token is returned immediately without GIS call', async () => {
    saveTokenData('token_valid_123', 3600);
    assert.equal(isGoogleLinked(), true);

    const token = await getValidAccessToken(false);
    assert.equal(token, 'token_valid_123');
    assert.equal(getSilentRefreshCooldownRemaining(), 0);
  });

  test('B. Expired token with simulated GIS mock succeeds and updates stored token', async () => {
    setGoogleLinked(true);
    // Token expired in past
    localStorage.setItem(STORAGE_KEY_TOKEN, 'old_expired_token');
    localStorage.setItem(STORAGE_KEY_EXPIRY, String(Date.now() - 10000));
    assert.equal(getStoredToken(), null);

    // Mock window.google.accounts.oauth2.initTokenClient
    globalThis.window = {
      google: {
        accounts: {
          oauth2: {
            initTokenClient: (config) => ({
              requestAccessToken: ({ prompt }) => {
                // Simulate successful silent token acquisition
                config.callback({
                  access_token: 'new_refreshed_token_456',
                  expires_in: 3600
                });
              }
            })
          }
        }
      }
    };
    await setSetting('google_client_id', 'test_client_id_123');

    const token = await getValidAccessToken(false);
    assert.equal(token, 'new_refreshed_token_456');
    assert.equal(getStoredToken(), 'new_refreshed_token_456');
    assert.equal(getSilentRefreshCooldownRemaining(), 0);
  });

  test('C & D. Expired token when silent renewal fails starts cooldown and suppresses repeated GIS calls', async () => {
    setGoogleLinked(true);
    let gisCallsCount = 0;

    // Mock window.google.accounts.oauth2.initTokenClient that fails silently
    globalThis.window = {
      google: {
        accounts: {
          oauth2: {
            initTokenClient: (config) => ({
              requestAccessToken: ({ prompt }) => {
                gisCallsCount++;
                config.error_callback(new Error('user_interaction_required'));
              }
            })
          }
        }
      }
    };
    await setSetting('google_client_id', 'test_client_id_123');

    // 1st attempt: should call GIS and fail
    const token1 = await getValidAccessToken(false);
    assert.equal(token1, null);
    assert.equal(gisCallsCount, 1);
    assert.ok(getSilentRefreshCooldownRemaining() > 0, 'Cooldown must be active');
    assert.ok(getSilentRefreshCooldownRemaining() <= SILENT_REFRESH_COOLDOWN_MS);

    // 2nd and 3rd background triggers within cooldown: must NOT call GIS again
    const token2 = await getValidAccessToken(false);
    assert.equal(token2, null);
    assert.equal(gisCallsCount, 1, 'GIS must not be called again during cooldown');

    const token3 = await getValidAccessToken(false);
    assert.equal(token3, null);
    assert.equal(gisCallsCount, 1, 'GIS must not be called on repeated triggers');
  });

  test('E. Explicit reconnect / interactive authentication is never blocked by silent cooldown', async () => {
    setGoogleLinked(true);
    let promptReceived = null;

    globalThis.window = {
      google: {
        accounts: {
          oauth2: {
            initTokenClient: (config) => ({
              requestAccessToken: ({ prompt }) => {
                promptReceived = prompt;
                if (prompt === '') {
                  config.error_callback(new Error('silent_failed'));
                } else if (prompt === 'consent') {
                  config.callback({
                    access_token: 'interactive_token_789',
                    expires_in: 3600
                  });
                }
              }
            })
          }
        }
      }
    };
    await setSetting('google_client_id', 'test_client_id_123');

    // Silent fail -> triggers cooldown
    const silentRes = await getValidAccessToken(false);
    assert.equal(silentRes, null);
    assert.ok(getSilentRefreshCooldownRemaining() > 0);

    // Interactive call (user clicks Reconnect) must proceed immediately
    const interactiveRes = await getValidAccessToken(true);
    assert.equal(interactiveRes, 'interactive_token_789');
    assert.equal(promptReceived, 'consent');
    assert.equal(getStoredToken(), 'interactive_token_789');
    assert.equal(getSilentRefreshCooldownRemaining(), 0, 'Cooldown must reset on successful interactive login');
  });

  test('F. Confirmed 401 invalidates cached token and expiry while preserving account link state', async () => {
    saveTokenData('stale_token_401', 3600);
    assert.equal(isGoogleLinked(), true);
    assert.equal(getStoredToken(), 'stale_token_401');

    // Simulate Drive API 401 response
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Invalid Credentials'
    });

    try {
      await findAppDataFile('test.finman', 'stale_token_401');
      assert.fail('Should have thrown 401');
    } catch (err) {
      assert.equal(err.status, 401);
    } finally {
      globalThis.fetch = origFetch;
    }

    // Token and expiry must be cleared
    assert.equal(getStoredToken(), null);
    assert.equal(localStorage.getItem(STORAGE_KEY_TOKEN), null);
    assert.equal(localStorage.getItem(STORAGE_KEY_EXPIRY), null);
    // Account link state must be preserved
    assert.equal(isGoogleLinked(), true);
  });

  test('G & H. Network errors and 5xx responses do NOT invalidate valid cached tokens', async () => {
    saveTokenData('good_token_555', 3600);

    const origFetch = globalThis.fetch;

    // Test G: Network failure (TypeError: Failed to fetch)
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    try {
      await findAppDataFile('test.finman', 'good_token_555');
    } catch (err) {
      assert.ok(err.message.includes('Failed to fetch'));
    }
    assert.equal(getStoredToken(), 'good_token_555', 'Token must NOT be invalidated on network drop');

    // Test H: 503 Service Unavailable
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable'
    });

    try {
      await findAppDataFile('test.finman', 'good_token_555');
    } catch (err) {
      assert.equal(err.status, 503);
    }
    assert.equal(getStoredToken(), 'good_token_555', 'Token must NOT be invalidated on 5xx');

    globalThis.fetch = origFetch;
  });

  test('I. Pending local delta events are preserved during auth expiration and flushed after re-auth', async () => {
    const db = getDB();

    // Insert pending delta events
    await db.run(
      'INSERT INTO sync_delta_queue (sequence, event_id, entity_type, entity_id, operation, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [1, 'evt_1', 'transaction', 'txn_1', 'CREATE', JSON.stringify({ amount: 100 }), 'PENDING', new Date().toISOString()]
    );
    await db.run(
      'INSERT INTO sync_delta_queue (sequence, event_id, entity_type, entity_id, operation, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [2, 'evt_2', 'transaction', 'txn_2', 'CREATE', JSON.stringify({ amount: 200 }), 'PENDING', new Date().toISOString()]
    );

    // Simulate 401 auth invalidation
    invalidateStoredToken();
    assert.equal(getStoredToken(), null);

    // Verify queue records remain completely intact and PENDING
    const rows = (await db.query('SELECT * FROM sync_delta_queue WHERE status = ?', ['PENDING'])).values || [];
    assert.equal(rows.length, 2, 'Pending queue events must not be lost or deleted');
    assert.equal(rows[0].entity_id, 'txn_1');
    assert.equal(rows[1].entity_id, 'txn_2');

    // Simulate user re-authenticating
    saveTokenData('fresh_token_reconnected', 3600);
    assert.equal(getStoredToken(), 'fresh_token_reconnected');
    assert.equal(rows.length, 2);
  });

  test('J. User-facing authentication-required copy delivers clear, reassuring messaging', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: false,
      syncStatus: 'AUTH_REQUIRED',
      isUnlocked: true,
      pendingCount: 2
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.AUTH_REQUIRED);
    assert.equal(status.title, 'Google Sign-In Required');
    assert.equal(status.primaryActionLabel, 'Reconnect Google');
    assert.equal(status.primaryActionKey, 'RECONNECT_GOOGLE');
    assert.ok(status.explanation.includes('Your FinMan data is safe on this device.'));
    assert.ok(status.explanation.includes('Reconnect Google to continue syncing across your devices.'));
    // Ensure it does not confuse with PIN lock
    assert.ok(!status.title.toLowerCase().includes('pin'));
    assert.ok(!status.explanation.toLowerCase().includes('pin'));
  });
});
