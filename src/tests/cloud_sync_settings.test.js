/**
 * cloud_sync_settings.test.js
 * 
 * Comprehensive Test Suite for Phase 6A.5 Synced Settings:
 * 1. Approved settings are serialized.
 * 2. Security-local settings are excluded.
 * 3. Device-local settings are excluded.
 * 4. Existing snapshot without settings remains readable.
 * 5. Settings canonicalization is deterministic.
 * 6. Identical settings produce NO_CHANGE.
 * 7. Local-only setting change is detected.
 * 8. Cloud-only setting change is detected.
 * 9. Same setting changed differently produces SETTINGS_CONFLICT.
 * 10. Different settings changed independently merge correctly.
 * 11. customTags addition/merge behavior (independent additions union).
 * 12. customTags deletion behavior (deletions propagate without resurrection).
 * 13. No OAuth token appears in serialized snapshot.
 * 14. No CryptoKey/raw PIN appears in serialized snapshot.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { initDB, getDB, closeDB } from '../database/db.js';
import { getSetting, setSetting } from '../database/settings.js';
import {
  readLocalEntities,
  createCanonicalSnapshotPayload,
  buildEntityManifest,
  canonicalizeEntity,
  reconcile3Way,
  reconcileSettings3Way,
  mergeCustomTags3Way,
  SYNCED_SETTINGS_WHITELIST,
  CONFLICT_TYPES
} from '../services/cloudSyncEngine.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed++;
    console.error(`❌ FAIL: ${message}`);
    throw new Error(message);
  } else {
    passed++;
    console.log(`✅ PASS: ${message}`);
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('Phase 6A.5: Synced Settings & customTags Test Suite');
  console.log('====================================================\n');

  // Reset isolated DB
  indexedDB = new IDBFactory();
  closeDB();
  await initDB();

  // Seed DB with a mix of Synced User Settings, Security Tokens, and Device-Local State
  await setSetting('theme', 'dark');
  await setSetting('headerColor', 'blue');
  await setSetting('fontSize', '1.1');
  await setSetting('fontFamily', 'Inter');
  await setSetting('fontDataWeight', 'bold');
  await setSetting('customTags', JSON.stringify(['#tax', '#personal', '#investment']));
  await setSetting('default_currency', 'INR');
  await setSetting('budget_start_day', '5');
  await setSetting('portfolio_benchmark', 'NIFTY50');
  await setSetting('profileName', 'Akbar');

  // Security and Device-Local (MUST BE EXCLUDED)
  await setSetting('google_client_id', 'client-id-xyz-secret.apps.googleusercontent.com');
  await setSetting('sync_base_manifest', JSON.stringify({ 'txn-1': { type: 'transaction' } }));
  await setSetting('last_synced_at', '2026-09-24T12:00:00Z');
  await setSetting('last_snapshot_id', 'snap_123_abc');
  await setSetting('pin', '123456');
  await setSetting('pinIdleSeconds', '10');
  await setSetting('biometricsEnabled', 'true');
  await setSetting('sub_accounts_migrated_v2', 'true');
  await setSetting('backupSchedule', 'weekly');
  await setSetting('lastBackupCheck', '2026-09-24');
  await setSetting('backupHistory', '[]');

  // ─────────────────────────────────────────────────────────────
  // TEST 1: Approved settings are serialized
  // ─────────────────────────────────────────────────────────────
  console.log('--- Test 1: Approved settings are serialized ---');
  const localEntities = await readLocalEntities();
  assert(localEntities.settings !== undefined, 'entities.settings is present');
  assert(localEntities.settings.theme === 'dark', 'theme serialized');
  assert(localEntities.settings.headerColor === 'blue', 'headerColor serialized');
  assert(localEntities.settings.fontSize === '1.1', 'fontSize serialized');
  assert(localEntities.settings.fontFamily === 'Inter', 'fontFamily serialized');
  assert(localEntities.settings.fontDataWeight === 'bold', 'fontDataWeight serialized');
  assert(localEntities.settings.default_currency === 'INR', 'default_currency serialized');
  assert(localEntities.settings.budget_start_day === '5', 'budget_start_day serialized');
  assert(localEntities.settings.portfolio_benchmark === 'NIFTY50', 'portfolio_benchmark serialized');
  assert(localEntities.settings.profileName === 'Akbar', 'profileName serialized');
  assert(localEntities.settings.customTags.includes('#tax'), 'customTags serialized');

  // ─────────────────────────────────────────────────────────────
  // TEST 2 & 3: Security-local and Device-local settings are excluded
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 2 & 3: Security-local & Device-local settings excluded ---');
  const excludedKeys = [
    'google_client_id',
    'sync_base_manifest',
    'last_synced_at',
    'last_snapshot_id',
    'pin',
    'pinIdleSeconds',
    'biometricsEnabled',
    'sub_accounts_migrated_v2',
    'backupSchedule',
    'lastBackupCheck',
    'backupHistory',
    'finman_gdrive_token',
    'finman_gdrive_token_exp',
    'finman_gdrive_linked'
  ];

  for (const k of excludedKeys) {
    assert(localEntities.settings[k] === undefined, `Key "${k}" is strictly excluded from entities.settings`);
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 4: Existing snapshot without settings remains readable
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 4: Existing snapshot without settings remains readable ---');
  const legacyCloudEntities = {
    transactions: [],
    accounts: [],
    categories: []
  };
  const legacyReconcile = await reconcile3Way({
    baseManifest: {},
    localEntities,
    cloudEntities: legacyCloudEntities
  });
  assert(legacyReconcile.conflicts.length === 0, 'No conflicts against legacy snapshot');
  assert(Object.keys(legacyReconcile.plannedLocalSettingsUpdates).length === 0, 'Local settings preserved when cloud has no settings');
  assert(legacyReconcile.plannedCloudSettingsUpdates.theme === 'dark', 'Local settings staged for cloud upload');

  // ─────────────────────────────────────────────────────────────
  // TEST 5: Settings canonicalization is deterministic
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 5: Settings canonicalization is deterministic ---');
  const c1 = canonicalizeEntity({ key: 'theme', value: 'dark' }, 'setting');
  const c2 = canonicalizeEntity({ id: 'theme', value: 'dark' }, 'setting');
  assert(c1 === 'theme:dark' && c1 === c2, 'Canonical string is deterministic (theme:dark)');

  const manifest = await buildEntityManifest(localEntities);
  assert(manifest['setting:theme']?.canonical === 'theme:dark', 'Manifest contains setting:theme');
  assert(manifest['setting:theme']?.type === 'setting', 'Manifest type is setting');
  assert(manifest['setting:google_client_id'] === undefined, 'Manifest strictly omits security keys');

  // ─────────────────────────────────────────────────────────────
  // TEST 6: Identical settings produce NO_CHANGE
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 6: Identical settings produce NO_CHANGE ---');
  const baseSettings = { ...localEntities.settings };
  const cloudSettingsIdentical = { ...localEntities.settings };
  const recIdentical = reconcileSettings3Way({
    baseSettings,
    localSettings: localEntities.settings,
    cloudSettings: cloudSettingsIdentical
  });
  assert(Object.keys(recIdentical.plannedLocalUpdates).length === 0, 'No local updates for identical settings');
  assert(Object.keys(recIdentical.plannedCloudUpdates).length === 0, 'No cloud updates for identical settings');
  assert(recIdentical.conflicts.length === 0, 'Zero conflicts for identical settings');

  // ─────────────────────────────────────────────────────────────
  // TEST 7: Local-only setting change is detected
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 7: Local-only setting change is detected ---');
  const localModified = { ...baseSettings, theme: 'light' };
  const recLocalMod = reconcileSettings3Way({
    baseSettings,
    localSettings: localModified,
    cloudSettings: baseSettings
  });
  assert(Object.keys(recLocalMod.plannedLocalUpdates).length === 0, 'No local updates for local-only change');
  assert(recLocalMod.plannedCloudUpdates.theme === 'light', 'Local theme change staged for cloud');
  assert(recLocalMod.conflicts.length === 0, 'No conflict for local-only change');

  // ─────────────────────────────────────────────────────────────
  // TEST 8: Cloud-only setting change is detected
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 8: Cloud-only setting change is detected ---');
  const cloudModified = { ...baseSettings, headerColor: 'pink' };
  const recCloudMod = reconcileSettings3Way({
    baseSettings,
    localSettings: baseSettings,
    cloudSettings: cloudModified
  });
  assert(recCloudMod.plannedLocalUpdates.headerColor === 'pink', 'Cloud headerColor change staged for local');
  assert(Object.keys(recCloudMod.plannedCloudUpdates).length === 0, 'No cloud updates for cloud-only change');
  assert(recCloudMod.conflicts.length === 0, 'No conflict for cloud-only change');

  // ─────────────────────────────────────────────────────────────
  // TEST 9: Same setting changed differently produces SETTINGS_CONFLICT
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 9: Same setting changed differently produces SETTINGS_CONFLICT ---');
  const localConflict = { ...baseSettings, theme: 'light' };
  const cloudConflict = { ...baseSettings, theme: 'oled' };
  const recConflict = reconcileSettings3Way({
    baseSettings,
    localSettings: localConflict,
    cloudSettings: cloudConflict
  });
  assert(recConflict.conflicts.length === 1, 'Exactly 1 conflict recorded');
  assert(recConflict.conflicts[0].type === CONFLICT_TYPES.SETTINGS_CONFLICT, 'Conflict type is SETTINGS_CONFLICT');
  assert(recConflict.conflicts[0].entityId === 'setting:theme', 'Conflict entityId is setting:theme');
  assert(recConflict.conflicts[0].local === 'light', 'Conflict records local value');
  assert(recConflict.conflicts[0].cloud === 'oled', 'Conflict records cloud value');

  // ─────────────────────────────────────────────────────────────
  // TEST 10: Different settings changed independently merge correctly
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 10: Different settings changed independently merge correctly ---');
  const localIndep = { ...baseSettings, theme: 'light' };
  const cloudIndep = { ...baseSettings, fontSize: '1.4' };
  const recIndep = reconcileSettings3Way({
    baseSettings,
    localSettings: localIndep,
    cloudSettings: cloudIndep
  });
  assert(recIndep.conflicts.length === 0, 'Zero conflicts for independent key changes');
  assert(recIndep.plannedLocalUpdates.fontSize === '1.4', 'Local receives cloud fontSize');
  assert(recIndep.plannedCloudUpdates.theme === 'light', 'Cloud receives local theme');
  assert(recIndep.mergedSettings.theme === 'light', 'Merged settings contains local theme');
  assert(recIndep.mergedSettings.fontSize === '1.4', 'Merged settings contains cloud fontSize');

  // ─────────────────────────────────────────────────────────────
  // TEST 11: customTags independent additions merge
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 11: customTags independent additions merge ---');
  const baseTagsRaw = JSON.stringify(['#tax', '#personal']);
  const localTagsRaw = JSON.stringify(['#tax', '#personal', '#work']);
  const cloudTagsRaw = JSON.stringify(['#tax', '#personal', '#travel']);
  const tagAddRes = mergeCustomTags3Way({
    baseRaw: baseTagsRaw,
    localRaw: localTagsRaw,
    cloudRaw: cloudTagsRaw
  });
  assert(!tagAddRes.conflict, 'No conflict on tag additions');
  assert(tagAddRes.tags.length === 4, 'Merged tag count is 4');
  assert(tagAddRes.tags.includes('#tax'), 'Contains #tax');
  assert(tagAddRes.tags.includes('#personal'), 'Contains #personal');
  assert(tagAddRes.tags.includes('#work'), 'Contains #work');
  assert(tagAddRes.tags.includes('#travel'), 'Contains #travel');

  // ─────────────────────────────────────────────────────────────
  // TEST 12: customTags deletion behavior (propagation without resurrection)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 12: customTags deletion behavior ---');
  // Local deleted #personal, Cloud added #travel
  const localTagsDel = JSON.stringify(['#tax']);
  const tagDelRes = mergeCustomTags3Way({
    baseRaw: baseTagsRaw,
    localRaw: localTagsDel,
    cloudRaw: cloudTagsRaw
  });
  assert(!tagDelRes.conflict, 'No conflict on tag deletion');
  assert(!tagDelRes.tags.includes('#personal'), '#personal was deleted and NOT resurrected');
  assert(tagDelRes.tags.includes('#tax'), '#tax preserved');
  assert(tagDelRes.tags.includes('#travel'), '#travel included');

  // ─────────────────────────────────────────────────────────────
  // TEST 13 & 14: No OAuth token, raw PIN, or CryptoKey in snapshot payload
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Test 13 & 14: Zero secret leakage in canonical snapshot payload ---');
  const snapshotRes = await createCanonicalSnapshotPayload({
    entities: localEntities,
    snapshotId: 'snap_test_settings_01',
    deviceId: 'test_dev'
  });
  const serializedJson = snapshotRes.canonicalJson;
  assert(!serializedJson.includes('client-id-xyz-secret'), 'Google OAuth client secret/id not in payload');
  assert(!serializedJson.includes('123456'), 'Raw PIN not in payload');
  assert(!serializedJson.includes('sync_base_manifest'), 'sync_base_manifest not in payload');
  assert(!serializedJson.includes('finman_gdrive_token'), 'finman_gdrive_token not in payload');

  console.log('\n====================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test suite failed with unhandled error:', err);
  process.exit(1);
});
