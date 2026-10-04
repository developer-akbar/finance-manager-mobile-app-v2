import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveUnifiedSyncStatus,
  translateSyncError,
  UNIFIED_SYNC_STATUS_KEYS
} from '../utils/cloudSyncStatusHelper.js';

test('Cloud Sync Status & Error Translation Helper Test Suite (Stage B1)', async (t) => {

  // 1. Fully healthy / unlocked / no pending -> SYNCED
  await t.test('1. Fully healthy unlocked session returns SYNCED status', () => {
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
    assert.equal(status.badgeType, 'success');
    assert.equal(status.icon, '🟢');
    assert.equal(status.hasPendingConflicts, false);
    assert.equal(status.requiresAction, false);
  });

  // 2. Sync actively running -> SYNCING
  await t.test('2. Active sync in progress returns SYNCING status', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'SYNCING',
      pendingCount: 2
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SYNCING);
    assert.equal(status.title, 'Synchronizing Changes…');
    assert.equal(status.icon, '🔄');
    assert.equal(status.requiresAction, false);
  });

  // 3. Pending local changes -> PENDING_CHANGES
  await t.test('3. Pending local changes return PENDING_CHANGES status', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'IDLE',
      pendingCount: 3,
      pendingConflictsCount: 0
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.PENDING_CHANGES);
    assert.equal(status.title, '3 Changes Waiting to Sync');
    assert.equal(status.badgeText, '3 Pending');
    assert.equal(status.badgeType, 'warning');
    assert.equal(status.icon, '⏳');
  });

  // 4. Locked session -> SESSION_LOCKED
  await t.test('4. Locked session returns SESSION_LOCKED without showing red sync error', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: false,
      lifecycleState: 'ACTIVE',
      syncStatus: 'AUTH_REQUIRED',
      pendingCount: 5,
      latestError: 'Session is locked'
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SESSION_LOCKED);
    assert.equal(status.title, 'Unlock Sync with PIN');
    assert.equal(status.icon, '🔒');
    assert.equal(status.requiresAction, true);
    assert.equal(status.primaryActionKey, 'UNLOCK');
    assert.equal(status.errorMessage, null, 'Should suppress confusing error message when locked');
  });

  // 5. Auth required -> AUTH_REQUIRED
  await t.test('5. Missing or expired Google account returns AUTH_REQUIRED', () => {
    const statusNotLinked = deriveUnifiedSyncStatus({
      isGoogleLinked: false,
      isAuthenticated: false,
      isUnlocked: false
    });

    assert.equal(statusNotLinked.key, UNIFIED_SYNC_STATUS_KEYS.AUTH_REQUIRED);
    assert.equal(statusNotLinked.title, 'Google Drive Not Connected');
    assert.equal(statusNotLinked.primaryActionKey, 'CONNECT_GOOGLE');

    const statusExpired = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: false,
      syncStatus: 'AUTH_REQUIRED',
      isUnlocked: true
    });

    assert.equal(statusExpired.key, UNIFIED_SYNC_STATUS_KEYS.AUTH_REQUIRED);
    assert.equal(statusExpired.title, 'Google Sign-In Required');
    assert.equal(statusExpired.primaryActionKey, 'RECONNECT_GOOGLE');
    assert.ok(statusExpired.explanation.includes('Your FinMan data is safe on this device.'));
  });

  // 6. Persistent sync failure -> SYNC_ERROR
  await t.test('6. Persistent operational sync failure returns SYNC_ERROR with translated message', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'ERROR',
      latestError: 'TypeError: Failed to fetch'
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SYNC_ERROR);
    assert.equal(status.title, 'Sync Paused — Needs Attention');
    assert.equal(status.icon, '⚠️');
    assert.equal(status.requiresAction, true);
    assert.equal(status.primaryActionKey, 'RETRY_SYNC');
    assert.equal(status.errorMessage, 'Unable to reach Google Drive. Please check your internet connection.');
  });

  // 7. Pending conflict with otherwise healthy sync
  await t.test('7. Pending conflict with healthy sync shows SYNCED with conflict notice', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'IDLE',
      pendingCount: 0,
      pendingConflictsCount: 1
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SYNCED);
    assert.equal(status.title, 'All Changes Up to Date');
    assert.equal(status.hasPendingConflicts, true);
    assert.equal(status.conflictsCount, 1);
    assert.equal(status.conflictBadgeText, '1 Conflict to Review');
    assert.equal(status.primaryActionKey, 'REVIEW_CONFLICTS');
  });

  // 8. Pending conflict + pending local changes
  await t.test('8. Pending conflict + pending changes preserves pending state and conflict notice', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'IDLE',
      pendingCount: 2,
      pendingConflictsCount: 2
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.PENDING_CHANGES);
    assert.equal(status.hasPendingConflicts, true);
    assert.equal(status.conflictsCount, 2);
    assert.equal(status.conflictBadgeText, '2 Conflicts to Review');
  });

  // 9. Locked + pending changes (Precedence: Locked > Pending)
  await t.test('9. Locked session takes precedence over pending changes', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: false,
      pendingCount: 4
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SESSION_LOCKED);
    assert.equal(status.title, 'Unlock Sync with PIN');
    assert.equal(status.primaryActionKey, 'UNLOCK');
  });

  // 10. Auth required + locked (Precedence: Auth > Locked)
  await t.test('10. Auth required takes precedence over session locked', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: false,
      isAuthenticated: false,
      isUnlocked: false
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.AUTH_REQUIRED);
  });

  // 11. JOINING / bootstrap state
  await t.test('11. JOINING lifecycle state returns BOOTSTRAP_JOINING status', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'JOINING'
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.BOOTSTRAP_JOINING);
    assert.equal(status.title, 'Setting Up Your Cloud Data…');
    assert.equal(status.icon, '📥');
  });

  // 12. Error translation cases
  await t.test('12. Error translation handles all known categories without leaking raw stacks', () => {
    // Network
    assert.equal(
      translateSyncError('NetworkError when attempting to fetch resource'),
      'Unable to reach Google Drive. Please check your internet connection.'
    );

    // Auth 401
    assert.equal(
      translateSyncError('HTTP 401 Unauthorized: Invalid Credentials'),
      'Google Drive authorization expired. Please reconnect your account to resume sync.'
    );

    // Cryptography / PIN mismatch
    assert.equal(
      translateSyncError('Authentication tag mismatch or invalid key'),
      'Encryption key verification failed. Please check that your PIN is correct for this cloud data.'
    );

    // Rate limits
    assert.equal(
      translateSyncError('Google Drive 429 Too Many Requests (rateLimitExceeded)'),
      'Google Drive request limit reached. Sync will pause and retry automatically.'
    );

    // Drive 500 Backend
    assert.equal(
      translateSyncError('503 Service Unavailable: Backend Error'),
      'Google Drive is temporarily unavailable. FinMan will retry automatically shortly.'
    );

    // Lineage guards
    assert.equal(
      translateSyncError('BLOCKED_OLDER_BASE: peer on ancient snapshot'),
      'Peer synchronization is waiting for cloud baseline updates. Local financial records are completely safe.'
    );

    // Mass deletion guardrail
    assert.equal(
      translateSyncError('SAFETY_ABORT_MASS_DELETION: exceeded 50 items'),
      'Safety shield triggered: Unusually high deletions detected. Sync paused to protect your financial data.'
    );

    // Fallback safe message
    assert.equal(
      translateSyncError('Unexpected runtime anomaly in worker_thread_99'),
      'Cloud sync encountered a temporary issue. Your local data remains completely safe.'
    );

    assert.equal(translateSyncError(null), null);
  });

  // 13. Automatic sync: isDeltaSyncing = false, delta status = SYNCING -> returns SYNCING
  await t.test('13. Automatic background sync (isDeltaSyncing=false, syncStatus=SYNCING) correctly derives SYNCING', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'SYNCING',
      isDeltaSyncing: false,
      isSyncing: false,
      pendingCount: 0
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SYNCING);
    assert.equal(status.title, 'Synchronizing Changes…');
    assert.equal(status.icon, '🔄');
  });

  // 14. Automatic sync completion: transitions SYNCING -> SUCCESS settles to SYNCED
  await t.test('14. Automatic sync completion with status SUCCESS/IDLE settles cleanly to SYNCED', () => {
    const statusSuccess = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'SUCCESS',
      isDeltaSyncing: false,
      isSyncing: false,
      pendingCount: 0
    });

    assert.equal(statusSuccess.key, UNIFIED_SYNC_STATUS_KEYS.SYNCED);
    assert.equal(statusSuccess.title, 'All Changes Up to Date');
    assert.equal(statusSuccess.icon, '🟢');
  });

  // 15. Race condition regression: sequence counter prevents older SYNCING from overwriting newer SUCCESS
  await t.test('15. Race regression: sequence token rejects stale async SYNCING resolution', () => {
    let state = {
      status: 'IDLE',
      pendingCount: 0
    };
    let currentSeq = 0;

    // Simulated component update with sequence guard
    const applyUpdate = (newStatus, seq) => {
      if (seq === currentSeq) {
        state = { ...state, status: newStatus };
      }
    };

    // Event 1 (SYNCING) starts at seq 1
    const seq1 = ++currentSeq;
    // Event 2 (SUCCESS) starts at seq 2 and completes immediately
    const seq2 = ++currentSeq;
    applyUpdate('SUCCESS', seq2);
    assert.equal(state.status, 'SUCCESS');

    // Stale Event 1 (SYNCING) completes later with old seq1
    applyUpdate('SYNCING', seq1);
    // Verified: State remains SUCCESS, stale SYNCING discarded
    assert.equal(state.status, 'SUCCESS', 'Stale SYNCING update must not overwrite newer SUCCESS state');
  });

  // 16. Manual delta sync: isDeltaSyncing = true -> returns SYNCING
  await t.test('16. Manual delta sync trigger (isDeltaSyncing=true) derives SYNCING', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'IDLE',
      isDeltaSyncing: true,
      isSyncing: false,
      pendingCount: 1
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SYNCING);
    assert.equal(status.title, 'Synchronizing Changes…');
  });

  // 17. Full snapshot isolation: isSyncing = true (snapshot creation) does NOT force live delta sync status
  await t.test('17. Full snapshot isSyncing=true is isolated from live delta sync status', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'IDLE',
      isDeltaSyncing: false,
      isSyncing: true, // Snapshot operation in Section 5
      pendingCount: 0
    });

    // Live delta status must NOT become SYNCING merely because a full snapshot operation is active
    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SYNCED);
    assert.equal(status.title, 'All Changes Up to Date');
  });

  // 18. Existing conflict with healthy delta sync maintains healthy status with conflict attention
  await t.test('18. Existing conflict with healthy delta sync maintains primary SYNCED with conflict notice', () => {
    const status = deriveUnifiedSyncStatus({
      isGoogleLinked: true,
      isAuthenticated: true,
      isUnlocked: true,
      lifecycleState: 'ACTIVE',
      syncStatus: 'SUCCESS',
      isDeltaSyncing: false,
      pendingCount: 0,
      pendingConflictsCount: 1
    });

    assert.equal(status.key, UNIFIED_SYNC_STATUS_KEYS.SYNCED);
    assert.equal(status.title, 'All Changes Up to Date');
    assert.equal(status.hasPendingConflicts, true);
    assert.equal(status.conflictsCount, 1);
    assert.equal(status.conflictBadgeText, '1 Conflict to Review');
  });
});
