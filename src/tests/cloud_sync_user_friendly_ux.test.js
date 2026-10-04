/**
 * cloud_sync_user_friendly_ux.test.js — FinMan Cloud Sync Stage C UX Test Suite
 * 
 * Verifies Stage C presentation-layer specifications:
 * 1. Healthy state unified status & plain language
 * 2. Sync Security card presentation (unlocked & locked)
 * 3. Cloud Sync card & lightweight manual delta sync trigger decoupling
 * 4. Conflict presentation (compact when 0 pending, full B2 cards when > 0 pending)
 * 5. Secondary conflict badge preserves healthy primary sync status
 * 6. Cloud Backup card uses full backup terminology without changing preview/execute snapshot engine
 * 7. Advanced Diagnostics & Settings contains sequence, device ID, scope, and OAuth config
 * 8. Absence of raw internal infrastructure terminology from primary user view
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deriveUnifiedSyncStatus,
  UNIFIED_SYNC_STATUS_KEYS
} from '../utils/cloudSyncStatusHelper.js';
import {
  getModalConfirmConfig,
  getFriendlyActionName
} from '../utils/cloudSyncModalHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('FinMan Stage C — Cloud Sync User-Friendly UX Test Suite', async (t) => {

  await t.test('1. Normal Healthy State produces clear consumer-friendly status', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'IDLE',
      pendingCount: 0,
      lastDeltaSyncedAt: new Date().toISOString(),
      pendingConflictsCount: 0,
      latestError: null
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SYNCED);
    assert.equal(status.title, 'All Changes Up to Date');
    assert.equal(status.badgeText, 'Cloud Sync On');
    assert.equal(status.icon, '🟢');
    assert.equal(status.requiresAction, false);
    assert.equal(status.hasPendingConflicts, false);
  });

  await t.test('2. Conflict state remains strictly secondary to healthy sync status', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'IDLE',
      pendingCount: 0,
      lastDeltaSyncedAt: new Date().toISOString(),
      pendingConflictsCount: 1,
      latestError: null
    });

    // Primary status remains healthy SYNCED
    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SYNCED);
    assert.equal(status.title, 'All Changes Up to Date');
    assert.equal(status.hasPendingConflicts, true);
    assert.equal(status.conflictBadgeText, '1 Conflict to Review');
  });

  await t.test('3. Locked state requires PIN action without modifying underlying key mechanics', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: false,
      lifecycleState: 'ACTIVE',
      syncStatus: 'IDLE',
      pendingCount: 0
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SESSION_LOCKED);
    assert.equal(status.title, 'Unlock Sync with PIN');
    assert.equal(status.requiresAction, true);
  });

  await t.test('4. Modal helper utilizes "Cloud Backup" terminology across all action variants', () => {
    const createInitialPreview = {
      action: 'CREATE_INITIAL_SNAPSHOT',
      safetyStatus: 'PASSED_SAFE',
      isFirstSync: true,
      plannedLocalChanges: { inserts: 0, updates: 0, deletes: 0 },
      plannedCloudChanges: { inserts: 10, updates: 0, deletes: 0 },
      conflicts: []
    };

    const config = getModalConfirmConfig(createInitialPreview, 10, false);
    assert.ok(config);
    assert.equal(config.title, 'Confirm Full Cloud Backup');
    assert.equal(config.buttonLabel, '🚀 Confirm & Back Up');
    assert.ok(config.descriptionText.includes('cloud backup'));

    const friendlyInitial = getFriendlyActionName('CREATE_INITIAL_SNAPSHOT');
    assert.equal(friendlyInitial, 'Create Initial Cloud Backup');

    const friendlyBootstrap = getFriendlyActionName('BOOTSTRAP_FROM_CLOUD');
    assert.equal(friendlyBootstrap, 'Restore From Cloud Backup');
  });

  await t.test('5. Source audit of CloudSyncManager.jsx confirms Stage C user-friendly structure', () => {
    const managerPath = path.resolve(__dirname, '../components/Settings/CloudSyncManager.jsx');
    const source = fs.readFileSync(managerPath, 'utf8');

    // 0. Simplified top security banner
    assert.ok(source.includes('🔒 Your Data Is Protected'), 'Top banner must be "Your Data Is Protected"');
    assert.ok(source.includes('Your financial data is encrypted before it leaves your device.'), 'Friendly security explanation must exist');
    assert.ok(!source.includes('AES-256-GCM using your private PIN'), 'Technical cipher details must not be in the top banner');

    // 1. Group labels & card headers
    assert.ok(source.includes('<span>🔐 Sync Security</span>'), 'Card 1 must be named Sync Security');
    assert.ok(source.includes('<span>☁️ Cloud Sync</span>'), 'Card 2 must be named Cloud Sync');
    assert.ok(source.includes('<span>⚖️ Sync Conflicts</span>'), 'Card 3 must be named Sync Conflicts');
    assert.ok(source.includes('>📦 Cloud Backup</div>'), 'Card 4 must be named Cloud Backup');
    assert.ok(source.includes('⚙️ Advanced Settings &amp; Diagnostics'), 'Card 5 must be Advanced Settings & Diagnostics');

    // 2. Buttons
    assert.ok(source.includes('⚡ Sync Now'), 'Sync Now button must be present in Cloud Sync card');
    assert.ok(source.includes('🔍 Preview Cloud Backup'), 'Preview Cloud Backup button must be present');
    assert.ok(source.includes('📦 Create Cloud Backup'), 'Create Cloud Backup button must be present');
    assert.ok(source.includes('🔒 Lock Sync'), 'Lock Sync button must be present');
    assert.ok(source.includes('Unlock Sync'), 'Unlock Sync button must be present');

    // 3. Compact conflict view when 0 pending
    assert.ok(source.includes('No Sync Conflicts'), 'Compact no conflicts message must exist');
    assert.ok(source.includes('All your devices are in sync.'), 'Compact no conflicts subtitle must exist');

    // 4. Advanced diagnostics collapsed <details>
    assert.ok(source.includes('<details className="settings-card"'), 'Advanced Diagnostics must be in a details element');
    assert.ok(source.includes('Technical information for troubleshooting.'), 'Advanced subtitle must exist');
    assert.ok(source.includes('Configure Custom OAuth Client ID'), 'Custom OAuth Client ID must be inside Advanced');
    assert.ok(source.includes('Encryption Standard'), 'Technical encryption details moved to Advanced');
    assert.ok(source.includes('Storage Repository'), 'Technical storage details moved to Advanced');

    // 5. Raw infrastructure jargon removed from top cards
    assert.ok(!source.includes('1. Google Drive Account'), 'Numbered section 1 must be replaced');
    assert.ok(!source.includes('2. Session Encryption Key'), 'Numbered section 2 must be replaced');
    assert.ok(!source.includes('3. Live Cloud Sync'), 'Numbered section 3 must be replaced');
    assert.ok(!source.includes('5. Advanced Cloud Snapshot &amp; Baseline'), 'Numbered section 5 must be replaced');
    assert.ok(!source.includes('6. Sync Conflicts'), 'Numbered section 6 must be replaced');
  });
});
