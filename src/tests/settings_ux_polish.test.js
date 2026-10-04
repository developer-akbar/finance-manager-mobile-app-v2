/**
 * settings_ux_polish.test.js — FinMan Settings Stage E1 UX Safety & Terminology Test Suite
 * 
 * Verifies Stage E1 specifications:
 * 1. ConfirmModal custom action label support with fallback to "Yes, Delete"
 * 2. AccountsManager and CategoriesManager pass accurate non-destructive labels ("Move to Ungrouped", "Move to Unassigned")
 * 3. Factory reset wording accurately communicates local-only reset boundary and Drive preservation
 * 4. Settings user-facing copy is free of internal "3-way sync" and "Sandboxed AppData" jargon
 * 5. Explicit PIN terminology differentiation (App PIN vs Sync PIN vs Backup PIN)
 * 6. Generalized CAS import options without hardcoded personal accounts in generic dropdown
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const settingsFilePath = path.resolve(__dirname, '../components/Settings/Settings.jsx');

test('FinMan Stage E1 — Settings UX Safety & Terminology Polish Test Suite', async (t) => {
  const settingsSource = fs.readFileSync(settingsFilePath, 'utf8');

  await t.test('1. ConfirmModal source supports configurable confirmLabel with default fallback', () => {
    // Check ConfirmModal signature and implementation in Settings.jsx
    assert.match(
      settingsSource,
      /export function ConfirmModal\(\{[^}]*confirmLabel[^}]*\}\)/,
      'ConfirmModal must accept confirmLabel parameter'
    );
    assert.match(
      settingsSource,
      /\{\s*confirmLabel\s*\|\|\s*'Yes,\s*Delete'\s*\}/,
      'ConfirmModal must render confirmLabel or fallback to "Yes, Delete"'
    );
  });

  await t.test('2. Accounts & Categories managers use descriptive confirm labels for non-destructive moves', () => {
    // Verify source code sets confirmLabel for account & group delete with transactions
    assert.ok(
      settingsSource.includes("confirmLabel: 'Move to Ungrouped'"),
      'AccountsManager must pass confirmLabel "Move to Ungrouped"'
    );
    assert.ok(
      settingsSource.includes("confirmLabel: 'Move to Unassigned'"),
      'CategoriesManager must pass confirmLabel "Move to Unassigned"'
    );
  });

  await t.test('3. Factory Reset copy accurately describes local-only boundary and Drive preservation', () => {
    // Must explain local scope
    assert.ok(
      settingsSource.includes('Reset local database &amp; delete all data?') ||
      settingsSource.includes('Reset local database & delete all data?'),
      'Danger Zone modal title must reflect local database reset'
    );
    assert.ok(
      settingsSource.includes('Note: This affects only this device. Cloud backups and snapshots stored in Google Drive are not deleted.'),
      'Danger Zone must explicitly communicate that Google Drive backups are not deleted'
    );
    assert.ok(
      settingsSource.includes('A CSV safety backup of your transactions will be automatically exported and downloaded before clearing.'),
      'Danger Zone must explain automatic CSV safety backup'
    );
  });

  await t.test('4. Absence of raw internal "3-way sync" and "Sandboxed AppData" from user-facing Settings.jsx', () => {
    assert.doesNotMatch(
      settingsSource,
      /3-Way Sync/i,
      'Settings.jsx should not contain internal "3-way sync" in user-facing copy'
    );
    assert.doesNotMatch(
      settingsSource,
      /Sandboxed AppData/i,
      'Settings.jsx should not contain raw "Sandboxed AppData" in user-facing copy'
    );
    assert.ok(
      settingsSource.includes('Multi-device cloud sync protected by your Sync PIN'),
      'Settings.jsx Hub card must use Stage C consistent Cloud Sync copy'
    );
    assert.ok(
      settingsSource.includes('End-to-End Encrypted Cloud Sync · Google Drive'),
      'DataManager Cloud Sync row must use clear user-facing copy'
    );
  });

  await t.test('5. Explicit PIN terminology differentiation in Settings.jsx', () => {
    // ProfileManager must use "App PIN" and explain separation from Sync PIN
    assert.ok(
      settingsSource.includes('App PIN Lock'),
      'ProfileManager must label local lock as "App PIN Lock"'
    );
    assert.ok(
      settingsSource.includes('Protects access to FinMan on this device. This is separate from your Sync PIN.'),
      'ProfileManager must clearly distinguish App PIN from Sync PIN'
    );
    assert.ok(
      settingsSource.includes('New App PIN (4–6 digits)'),
      'ProfileManager inputs must refer to App PIN'
    );
    assert.ok(
      settingsSource.includes('App PIN set ✓ — app locks after 10s idle'),
      'ProfileManager success toast must refer to App PIN'
    );

    // DataManager encrypted export must use Backup PIN
    assert.ok(
      settingsSource.includes('AES-256 zero-knowledge backup protected by your Backup PIN'),
      'DataManager export row must refer to Backup PIN'
    );
    assert.ok(
      settingsSource.includes('Enter Backup PIN or Password'),
      'DataManager crypto modal input must placeholder Backup PIN'
    );
  });

  await t.test('6. CAS import options in DataManager do not contain hardcoded personal names', () => {
    assert.ok(
      settingsSource.includes('<option value="cas_liquid_mf">CAMS / KFintech CAS Statement (.pdf / .txt)</option>'),
      'CAS statement option must be generic and clearly describe file formats'
    );
    assert.doesNotMatch(
      settingsSource,
      /<option[^>]*>.*\(Ak ETMoney\).*<\/option>/,
      'Dropdown options should not have hardcoded personal account names'
    );
    assert.doesNotMatch(
      settingsSource,
      /<option[^>]*>.*\(Fareeda Groww\).*<\/option>/,
      'Dropdown options should not have hardcoded personal account names'
    );
    assert.doesNotMatch(
      settingsSource,
      /<option[^>]*>.*\(Ammi Groww\).*<\/option>/,
      'Dropdown options should not have hardcoded personal account names'
    );
  });
});
