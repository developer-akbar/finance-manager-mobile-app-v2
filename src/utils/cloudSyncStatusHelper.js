/**
 * cloudSyncStatusHelper.js — Pure UI State & Error Translation Helpers for FinMan Cloud Sync (Stage B1)
 * 
 * Provides:
 * 1. deriveUnifiedSyncStatus(state): Derives a single, high-clarity user-facing status model
 *    with deterministic precedence.
 * 2. translateSyncError(rawError): Translates technical exceptions into concise, actionable user advice.
 */

export const UNIFIED_SYNC_STATUS_KEYS = Object.freeze({
  UNINITIALIZED: 'UNINITIALIZED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  SESSION_LOCKED: 'SESSION_LOCKED',
  BOOTSTRAP_JOINING: 'BOOTSTRAP_JOINING',
  SYNCING: 'SYNCING',
  SYNC_ERROR: 'SYNC_ERROR',
  PENDING_CHANGES: 'PENDING_CHANGES',
  SYNCED: 'SYNCED'
});

/**
 * Translates low-level technical errors into clean, non-alarming user guidance.
 * Preserves raw message internally for diagnostics.
 */
export function translateSyncError(rawError) {
  if (!rawError) return null;
  const str = typeof rawError === 'string' ? rawError : (rawError.message || String(rawError));
  const lower = str.toLowerCase();

  // 1. Network & Connectivity Issues
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('network request failed') || lower.includes('econnrefused')) {
    return 'Unable to reach Google Drive. Please check your internet connection.';
  }

  // 2. Authentication & OAuth Token Expirations
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid_grant') || lower.includes('auth_required') || lower.includes('token expired') || lower.includes('authentication required')) {
    return 'Google Drive authorization expired. Please reconnect your account to resume sync.';
  }
  if (lower.includes('google sign-in failed') || lower.includes('popup was closed') || lower.includes('access_denied')) {
    return 'Google Sign-In was cancelled or could not be completed.';
  }

  // 3. Cryptographic Key & PIN Mismatch
  if (lower.includes('tag mismatch') || lower.includes('aes-gcm') || lower.includes('failed to decrypt') || lower.includes('invalid key') || lower.includes('pin mismatch')) {
    return 'Encryption key verification failed. Please check that your PIN is correct for this cloud data.';
  }

  // 4. Rate Limits & Google Drive Backend Errors
  if (lower.includes('429') || lower.includes('ratelimit') || lower.includes('user rate limit') || lower.includes('quota')) {
    return 'Google Drive request limit reached. Sync will pause and retry automatically.';
  }
  if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('504') || lower.includes('backend error') || lower.includes('internal error')) {
    return 'Google Drive is temporarily unavailable. FinMan will retry automatically shortly.';
  }

  // 5. Lineage & Peer Baseline Guards
  if (lower.includes('blocked_older_base') || lower.includes('blocked_unknown_base') || lower.includes('sequence_gap')) {
    return 'Peer synchronization is waiting for cloud baseline updates. Local financial records are completely safe.';
  }

  // 6. Safety Guardrails & Mass Deletion
  if (lower.includes('safety_abort_mass_deletion') || lower.includes('excessive deletion')) {
    return 'Safety shield triggered: Unusually high deletions detected. Sync paused to protect your financial data.';
  }

  // 7. Bootstrap & Initial Setup
  if (lower.includes('bootstrap_failed') || lower.includes('bootstrap_verification_failed') || lower.includes('existing_local_data_requires_merge')) {
    return 'Could not set up cloud repository. Please verify your connection and encryption PIN.';
  }

  // Fallback: Safe generic message
  return 'Cloud sync encountered a temporary issue. Your local data remains completely safe.';
}

/**
 * Derives a unified, high-level sync status model for the primary banner.
 * 
 * Semantics & Precedence Ladder:
 * 1. Not Linked / Auth Required -> AUTH_REQUIRED (Cannot exchange data without cloud transport)
 * 2. Session Locked -> SESSION_LOCKED (Cannot encrypt/decrypt without user's in-memory key)
 * 3. Bootstrap / Joining -> BOOTSTRAP_JOINING (Initial download and database preparation)
 * 4. Active Sync In-Progress -> SYNCING (Active network push/pull/reconciliation cycle)
 * 5. Persistent Sync Failure -> SYNC_ERROR (Network, Drive 500, or protocol failure)
 * 6. Pending Local Changes -> PENDING_CHANGES (Local mutations waiting for debounce flush)
 * 7. Clean State -> SYNCED (All local and peer changes up to date)
 * 
 * Note on Conflicts:
 * In FinMan's distributed delta engine, pending conflicts are entity-scoped and do NOT stall
 * the global synchronization pipeline for unrelated entities. Therefore, conflicts are treated
 * as an urgent secondary attention banner rather than declaring the entire sync engine broken.
 */
export function deriveUnifiedSyncStatus(state = {}) {
  const {
    isGoogleLinked = false,
    isAuthenticated = false,
    isUnlocked = false,
    lifecycleState = 'ACTIVE',
    syncStatus = 'IDLE',
    pendingCount = 0,
    lastDeltaSyncedAt = null,
    pendingConflictsCount = 0,
    latestError = null,
    isSyncing = false,
    isDeltaSyncing = false
  } = state;

  const conflictsNum = Math.max(0, Number(pendingConflictsCount) || 0);
  const conflictBadgeText = conflictsNum > 0 ? `${conflictsNum} ${conflictsNum === 1 ? 'Conflict' : 'Conflicts'} to Review` : null;

  // 1. Google Account Connection / Authentication Required
  if (!isGoogleLinked || (!isAuthenticated && syncStatus === 'AUTH_REQUIRED')) {
    return {
      key: UNIFIED_SYNC_STATUS_KEYS.AUTH_REQUIRED,
      title: isGoogleLinked ? 'Google Drive Reconnect Required' : 'Google Drive Not Connected',
      explanation: isGoogleLinked
        ? 'Your Google Drive authorization has expired. Reconnect to resume automatic synchronization.'
        : 'Connect your Google Drive account to enable end-to-end encrypted multi-device sync.',
      badgeText: isGoogleLinked ? 'Reconnect Required' : 'Not Connected',
      badgeType: 'error',
      icon: '🔐',
      hasPendingConflicts: conflictsNum > 0,
      conflictsCount: conflictsNum,
      conflictBadgeText,
      primaryActionKey: isGoogleLinked ? 'RECONNECT_GOOGLE' : 'CONNECT_GOOGLE',
      primaryActionLabel: isGoogleLinked ? 'Reconnect Google' : 'Connect Google',
      requiresAction: true,
      errorMessage: translateSyncError(latestError),
      rawError: latestError
    };
  }

  // 2. Encryption Session Locked
  if (!isUnlocked) {
    return {
      key: UNIFIED_SYNC_STATUS_KEYS.SESSION_LOCKED,
      title: 'Unlock Sync with PIN',
      explanation: 'Enter your encryption PIN to resume automatic background synchronization.',
      badgeText: 'Sync Locked',
      badgeType: 'warning',
      icon: '🔒',
      hasPendingConflicts: conflictsNum > 0,
      conflictsCount: conflictsNum,
      conflictBadgeText,
      primaryActionKey: 'UNLOCK',
      primaryActionLabel: 'Unlock Sync',
      requiresAction: true,
      errorMessage: null, // Don't show confusing red sync error when just locked
      rawError: latestError
    };
  }

  // 3. Uninitialized / First Setup
  if (lifecycleState === 'UNINITIALIZED') {
    return {
      key: UNIFIED_SYNC_STATUS_KEYS.UNINITIALIZED,
      title: 'Set Up Cloud Repository',
      explanation: 'Prepare your encrypted FinMan cloud storage on Google Drive.',
      badgeText: 'Setup Required',
      badgeType: 'info',
      icon: '☁️',
      hasPendingConflicts: conflictsNum > 0,
      conflictsCount: conflictsNum,
      conflictBadgeText,
      primaryActionKey: 'SETUP_CLOUD',
      primaryActionLabel: 'Set Up Cloud Data',
      requiresAction: true,
      errorMessage: translateSyncError(latestError),
      rawError: latestError
    };
  }

  // 4. Joining / Bootstrap In-Progress
  if (lifecycleState === 'JOINING') {
    return {
      key: UNIFIED_SYNC_STATUS_KEYS.BOOTSTRAP_JOINING,
      title: 'Setting Up Your Cloud Data…',
      explanation: 'Downloading and preparing your encrypted FinMan data from Google Drive…',
      badgeText: 'Setting Up…',
      badgeType: 'info',
      icon: '📥',
      hasPendingConflicts: conflictsNum > 0,
      conflictsCount: conflictsNum,
      conflictBadgeText,
      primaryActionKey: null,
      primaryActionLabel: null,
      requiresAction: false,
      errorMessage: null,
      rawError: latestError
    };
  }

  // 5. Active Sync Cycle In-Progress
  const isActivelySyncing = isSyncing || isDeltaSyncing || syncStatus === 'SYNCING';
  if (isActivelySyncing) {
    return {
      key: UNIFIED_SYNC_STATUS_KEYS.SYNCING,
      title: 'Synchronizing Changes…',
      explanation: 'Exchanging encrypted delta updates with Google Drive…',
      badgeText: 'Syncing…',
      badgeType: 'info',
      icon: '🔄',
      hasPendingConflicts: conflictsNum > 0,
      conflictsCount: conflictsNum,
      conflictBadgeText,
      primaryActionKey: null,
      primaryActionLabel: null,
      requiresAction: false,
      errorMessage: null,
      rawError: latestError
    };
  }

  // 6. Persistent Operational Sync Error
  if (syncStatus === 'ERROR' && latestError) {
    return {
      key: UNIFIED_SYNC_STATUS_KEYS.SYNC_ERROR,
      title: 'Sync Paused — Needs Attention',
      explanation: translateSyncError(latestError),
      badgeText: 'Sync Paused',
      badgeType: 'error',
      icon: '⚠️',
      hasPendingConflicts: conflictsNum > 0,
      conflictsCount: conflictsNum,
      conflictBadgeText,
      primaryActionKey: 'RETRY_SYNC',
      primaryActionLabel: 'Retry Sync',
      requiresAction: true,
      errorMessage: translateSyncError(latestError),
      rawError: latestError
    };
  }

  // 7. Local Pending Changes Waiting for Debounce / Sync Pass
  const pendingNum = Math.max(0, Number(pendingCount) || 0);
  if (pendingNum > 0) {
    return {
      key: UNIFIED_SYNC_STATUS_KEYS.PENDING_CHANGES,
      title: `${pendingNum} ${pendingNum === 1 ? 'Change' : 'Changes'} Waiting to Sync`,
      explanation: 'Your recent local edits are safely queued and will sync automatically shortly.',
      badgeText: `${pendingNum} Pending`,
      badgeType: 'warning',
      icon: '⏳',
      hasPendingConflicts: conflictsNum > 0,
      conflictsCount: conflictsNum,
      conflictBadgeText,
      primaryActionKey: 'SYNC_NOW',
      primaryActionLabel: '⚡ Sync Now',
      requiresAction: false,
      errorMessage: null,
      rawError: latestError
    };
  }

  // 8. Fully Synchronized & Clean Baseline
  return {
    key: UNIFIED_SYNC_STATUS_KEYS.SYNCED,
    title: 'All Changes Up to Date',
    explanation: 'Your financial records are end-to-end encrypted and synchronized across all your devices.',
    badgeText: 'Cloud Sync On',
    badgeType: 'success',
    icon: '🟢',
    hasPendingConflicts: conflictsNum > 0,
    conflictsCount: conflictsNum,
    conflictBadgeText,
    primaryActionKey: conflictsNum > 0 ? 'REVIEW_CONFLICTS' : 'SYNC_NOW',
    primaryActionLabel: conflictsNum > 0 ? 'Review Conflicts' : '⚡ Sync Changes Now',
    requiresAction: conflictsNum > 0,
    errorMessage: null,
    rawError: latestError
  };
}
