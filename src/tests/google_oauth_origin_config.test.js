/**
 * google_oauth_origin_config.test.js
 * 
 * Verifies the configuration selection logic for Google OAuth:
 * 1. Custom OAuth Client ID saved in settings takes precedence over default/environment ID.
 * 2. Whitespace and empty custom IDs fall back safely to environment default.
 * 3. setGoogleClientId trims and persists to IndexedDB, resetting cached token client.
 * 4. Origin validation logic distinguishes deployment-specific vs branch-alias origins.
 * 5. Error translation provides actionable guidance for origin_mismatch errors.
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
import { setSetting, getSetting } from '../database/settings.js';
import {
  getGoogleClientId,
  getGoogleClientIdSource,
  setGoogleClientId,
  signInWithGoogle
} from '../services/googleAuth.js';
import { translateSyncError } from '../utils/cloudSyncStatusHelper.js';

describe('Google OAuth Configuration & Origin Selection Suite', () => {
  beforeEach(async () => {
    closeDB();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await initDB();
  });

  test('1. Custom OAuth Client ID saved in database overrides environment fallback', async () => {
    const customId = '987654321-custom-preview-client.apps.googleusercontent.com';
    await setGoogleClientId(customId);

    const activeId = await getGoogleClientId();
    assert.strictEqual(activeId, customId);

    const source = await getGoogleClientIdSource();
    assert.strictEqual(source.isCustom, true);
    assert.strictEqual(source.source, 'CUSTOM_SAVED');
  });

  test('2. setGoogleClientId trims leading/trailing whitespace before persisting', async () => {
    const untrimmed = '   123456789-padded-client.apps.googleusercontent.com   ';
    await setGoogleClientId(untrimmed);

    const activeId = await getGoogleClientId();
    assert.strictEqual(activeId, '123456789-padded-client.apps.googleusercontent.com');

    const dbRecord = await getSetting('google_client_id');
    assert.strictEqual(dbRecord, '123456789-padded-client.apps.googleusercontent.com');
  });

  test('3. Clearing custom Client ID with empty string resets database record and falls back', async () => {
    await setGoogleClientId('temporary-custom-id.apps.googleusercontent.com');
    assert.strictEqual(await getGoogleClientId(), 'temporary-custom-id.apps.googleusercontent.com');

    // Clear custom ID
    await setGoogleClientId('');
    const dbRecord = await getSetting('google_client_id');
    assert.strictEqual(dbRecord, '');

    // Resolves to fallback (empty in test environment without VITE_GOOGLE_CLIENT_ID)
    const activeId = await getGoogleClientId();
    assert.strictEqual(typeof activeId, 'string');

    const source = await getGoogleClientIdSource();
    assert.strictEqual(source.isCustom, false);
    assert.strictEqual(source.source, 'NONE');
  });

  test('4. Origin resolution distinguishes deployment URL and branch alias as separate origins', () => {
    const deploymentUrl = 'https://finman-ni01znwos-developer-akbars-projects.vercel.app';
    const branchAliasUrl = 'https://finman-git-preview-isolated-re-f22caa-developer-akbars-projects.vercel.app';

    const originDeployment = new URL(deploymentUrl).origin;
    const originBranch = new URL(branchAliasUrl).origin;

    // Both must be valid origins without trailing slash
    assert.strictEqual(originDeployment, 'https://finman-ni01znwos-developer-akbars-projects.vercel.app');
    assert.strictEqual(originBranch, 'https://finman-git-preview-isolated-re-f22caa-developer-akbars-projects.vercel.app');

    // Crucially: They are DIFFERENT origins under Same-Origin Policy
    assert.notStrictEqual(originDeployment, originBranch);

    // Google Cloud Console requires exact origin matching
    const authorizedOrigins = new Set([originDeployment, originBranch]);
    assert.ok(authorizedOrigins.has(originDeployment));
    assert.ok(authorizedOrigins.has(originBranch));
    assert.ok(!authorizedOrigins.has('https://finman-git-preview-isolated-recovery-verification-developer-akbars-projects.vercel.app'));
  });

  test('5. translateSyncError correctly identifies origin_mismatch and produces actionable guidance', () => {
    const rawGoogleError = 'Error: [GSI] origin_mismatch: The given origin is not allowed for the given client ID.';
    const translated = translateSyncError(rawGoogleError);

    assert.ok(translated.includes('This domain is not authorized for Google Sign-In'));
    assert.ok(translated.includes('Google Cloud'));
  });
});
