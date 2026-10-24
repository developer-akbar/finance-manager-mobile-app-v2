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
  POPULATED_LOCAL_REQUIRES_CHOICE: 'POPULATED_LOCAL_REQUIRES_CHOICE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  SESSION_LOCKED: 'SESSION_LOCKED',
  BOOTSTRAP_JOINING: 'BOOTSTRAP_JOINING',
  SYNCING: 'SYNCING',
  SYNC_ERROR: 'SYNC_ERROR',
  BLOCKED_SYNC: 'BLOCKED_SYNC',
  PENDING_CHANGES: 'PENDING_CHANGES',
  SYNCED: 'SYNCED'
});

/**
 * Translates low-level technical errors into clean, non-alarming user guidance.
 * Preserves raw message internally for diagnostics.
 */
export function translateSyncError(rawError, context = {}) {
  if (!rawError) return null;
  const str = typeof rawError === 'string' ? rawError : (rawError.message || String(rawError));
  const lower = str.toLowerCase();

  // 0. Informational / Non-Error Auth States (Suppress noisy error banners during clean startup)
  if (lower.includes('no google drive credentials') || lower.includes('not connected to google drive') || lower === 'auth_required' || lower.includes('credentials missing')) {
    return null;
  }

  // 1. Missing OAuth Deployment Configuration
  if (
    lower.includes('developer configuration error') ||
    lower.includes('developer_error') ||
    lower.includes('sha-1') ||
    lower.includes('status code 10')
  ) {
    return 'Google Sign-In configuration error: Verify that package com.akbar.finman and your debug SHA-1 fingerprint are registered in Google Cloud Console.';
  }
  if (
    lower.includes('oauth client id is not configured') ||
    lower.includes('client id is not configured') ||
    lower.includes('missing google_client_id') ||
    lower.includes('google_client_id is not configured') ||
    lower.includes('vite_google_client_id')
  ) {
    return "Google Drive isn't configured for this FinMan deployment. Please contact the administrator.";
  }

  // 2. User Cancelled / Popup Blocked / Access Denied
  if (lower.includes('popup was closed') || lower.includes('popup_closed') || lower.includes('user_cancelled')) {
    return 'Google Sign-In was cancelled or the sign-in popup was closed.';
  }
  if (lower.includes('popup_blocked') || lower.includes('popup was blocked') || lower.includes('failed to open popup')) {
    return 'Google Sign-In popup was blocked by the browser. Please allow popups for this site.';
  }
  if (lower.includes('origin_mismatch') || lower.includes('unauthorized_client') || lower.includes('access_denied')) {
    return 'This domain is not authorized for Google Sign-In. Please check Google Cloud configuration.';
  }

  // 3. Network & Connectivity Issues & Timeouts
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('time out') || lower.includes('sync_pass_timeout') || lower.includes('drive_request_timeout')) {
    if (context?.pendingCount > 0) {
      return 'Sync could not finish due to a temporary network timeout. Your local changes remain queued and will sync once reconnected.';
    }
    return 'Google Drive request timed out. Sync lock was released and FinMan will retry automatically.';
  }
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('network request failed') || lower.includes('econnrefused')) {
    if (context?.pendingCount > 0) {
      return 'Sync could not finish due to a temporary network issue. Your local changes remain queued and will sync once reconnected.';
    }
    return 'Unable to reach Google Drive. Please check your internet connection.';
  }

  // 4. Authentication & OAuth Token Expirations & Permissions
  if (lower.includes('permission_denied') || lower.includes('insufficient_permissions')) {
    return 'Google Drive permissions require attention. Please check account permissions or reconnect your account.';
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid_grant') || lower.includes('token expired') || lower.includes('authentication required')) {
    return 'Google Drive authorization expired. Please reconnect your account to resume sync.';
  }
  if (lower.includes('google sign-in failed') || lower.includes('google authentication failed')) {
    return 'Google Sign-In could not be completed. Please try again.';
  }

  // 5. Cryptographic Key & PIN Mismatch
  if (
    lower.includes('tag mismatch') ||
    lower.includes('aes-gcm') ||
    lower.includes('failed to decrypt') ||
    lower.includes('invalid key') ||
    lower.includes('pin mismatch') ||
    lower.includes('incorrect password/pin')
  ) {
    return 'Encryption key verification failed. Please check that your PIN is correct for this cloud data.';
  }

  // 6. Rate Limits & Google Drive Backend Errors
  if (lower.includes('429') || lower.includes('ratelimit') || lower.includes('user rate limit') || lower.includes('quota')) {
    return 'Google Drive request limit reached. Sync will pause and retry automatically.';
  }
  if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('504') || lower.includes('backend error') || lower.includes('internal error')) {
    if (context?.pendingCount > 0) {
      return 'Google Drive is temporarily unavailable. Your local changes remain queued and will sync automatically once service resumes.';
    }
    return 'Google Drive is temporarily unavailable. FinMan will retry automatically shortly.';
  }

  // 7. Lineage & Peer Baseline Guards
  if (lower.includes('blocked_older_base') || lower.includes('blocked_unknown_base') || lower.includes('sequence_gap') || lower.includes('sequence gap')) {
    return 'Peer synchronization is waiting for cloud baseline updates. Local financial records are completely safe.';
  }

  // 7.5 Conflict and Reconciliation Failures
  if (
    lower.includes('reconcil') ||
    lower.includes('conflict') ||
    lower.includes('staged_events') ||
    context?.hasConflicts ||
    context?.status === 'CONFLICTS_PENDING'
  ) {
    return 'Reconciliation encountered conflicting updates. Please review the Sync Conflicts section to resolve items needing attention.';
  }

  // 8. Safety Guardrails & Mass Deletion
  if (lower.includes('safety_abort_mass_deletion') || lower.includes('excessive deletion')) {
    return 'Safety shield triggered: Unusually high deletions detected. Sync paused to protect your financial data.';
  }

  // 8.5 Fail-Closed Safeguard & Populated Device Protection
  if (
    lower.includes('bootstrap_safeguard_rejected') ||
    lower.includes('destructive bootstrap rejected') ||
    lower.includes('bootstrap_safeguard_failed')
  ) {
    return 'Safety shield active: Local financial records detected. Cloud restore was blocked to protect your data. Setup as primary device required.';
  }

  // 8.6 Local Database / SQLite Schema
  if (
    lower.includes('sqlite') ||
    lower.includes('no such column') ||
    lower.includes('has no column') ||
    lower.includes('syntax error') ||
    lower.includes('constraint') ||
    lower.includes('database_error')
  ) {
    return 'A local database issue interrupted synchronization. Local changes remain queued; please retry or view developer diagnostics.';
  }

  // 9. Bootstrap & Initial Setup
  if (lower.includes('bootstrap_failed') || lower.includes('bootstrap_verification_failed') || lower.includes('existing_local_data_requires_merge')) {
    return 'Could not set up cloud repository. Please verify your connection and encryption PIN.';
  }

  // 9.5 Baseline Alignment & Newer Snapshot Updates
  if (lower.includes('newer snapshot baseline detected') || lower.includes('aligning baseline') || lower.includes('aligning with newer')) {
    return 'Aligning with newer cloud snapshot baseline… Please wait a moment.';
  }

  // Fallback: Safe generic message with layered verification
  if (context?.localDataVerified === false) {
    return 'Cloud sync encountered an unexpected issue. Please retry sync. Local data status could not be verified.';
  }
  if (context?.pendingCount > 0) {
    return 'Cloud sync encountered a temporary issue. Local changes remain queued and will sync on retry.';
  }
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
    isDeltaSyncing = false,
    hasLocalRecords = false,
    localTransactionsCount = 0
  } = state;

  const conflictsNum = Math.max(0, Number(pendingConflictsCount) || 0);
  const conflictBadgeText = conflictsNum > 0 ? `${conflictsNum} ${conflictsNum === 1 ? 'Conflict' : 'Conflicts'} to Review` : null;

  // 1. Google Account Connection / Authentication Required
  if (!isGoogleLinked || (!isAuthenticated && syncStatus === 'AUTH_REQUIRED')) {
    return {
      key: UNIFIED_SYNC_STATUS_KEYS.AUTH_REQUIRED,
      title: isGoogleLinked ? 'Google Sign-In Required' : 'Google Drive Not Connected',
      explanation: isGoogleLinked
        ? 'Your FinMan data is safe on this device. Reconnect Google to continue syncing across your devices.'
        : 'Connect your Google Drive account to enable end-to-end encrypted multi-device sync.',
      badgeText: isGoogleLinked ? 'Reconnect Required' : 'Not Connected',
      badgeType: isGoogleLinked ? 'error' : 'info',
      icon: isGoogleLinked ? '🔐' : '☁️',
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
    const isPopulatedDevice = hasLocalRecords || (localTransactionsCount > 0) || (pendingCount > 0);
    if (isPopulatedDevice) {
      return {
        key: UNIFIED_SYNC_STATUS_KEYS.POPULATED_LOCAL_REQUIRES_CHOICE,
        title: 'Authoritative Setup Required',
        explanation: 'Local offline records detected. Publish this device as your cloud master to establish Snapshot v13 and activate sync.',
        badgeText: 'Setup Required',
        badgeType: 'warning',
        icon: '📱',
        hasPendingConflicts: conflictsNum > 0,
        conflictsCount: conflictsNum,
        conflictBadgeText,
        primaryActionKey: 'PUBLISH_MASTER',
        primaryActionLabel: 'Publish as Master Device',
        requiresAction: true,
        errorMessage: translateSyncError(latestError),
        rawError: latestError
      };
    }

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

  // 5. Active Live Delta Sync Cycle In-Progress (Strictly isolated from snapshot operations)
  const isActivelySyncing = Boolean(isDeltaSyncing) || syncStatus === 'SYNCING';
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

  // 5.5 Blocked Sync State (Sequence gaps, unresolved dependencies, or incompatible peer baselines)
  const isBlocked = 
    syncStatus === 'BLOCKED_SEQUENCE_GAP' ||
    syncStatus === 'BLOCKED_DEPENDENCY' ||
    syncStatus === 'BLOCKED_PEER_BASELINE' ||
    syncStatus === 'BLOCKED_INCOMPATIBLE_PEER' ||
    Number(state.blockedGapCount) > 0 ||
    Number(state.blockedDependencyCount) > 0 ||
    (Array.isArray(state.blockedPeers) && state.blockedPeers.length > 0);

  if (isBlocked) {
    let title = 'Sync Blocked — Attention Required';
    let explanation = 'Synchronization is waiting for missing prerequisite updates.';
    let badgeText = 'Sync Blocked';
    let badgeType = 'warning';

    if (syncStatus === 'BLOCKED_SEQUENCE_GAP' || Number(state.blockedGapCount) > 0) {
      title = 'Sync Blocked — Missing Sequence Updates';
      explanation = 'A peer device has sequence updates that are missing locally. Sync will pause until the missing sequence packages are received.';
      badgeText = 'Sequence Gap';
    } else if (syncStatus === 'BLOCKED_DEPENDENCY' || Number(state.blockedDependencyCount) > 0) {
      title = 'Sync Blocked — Missing Dependency';
      explanation = 'Some updates depend on earlier changes that have not yet arrived. Waiting for dependency resolution.';
      badgeText = 'Missing Dependency';
    } else if (syncStatus === 'BLOCKED_PEER_BASELINE' || syncStatus === 'BLOCKED_INCOMPATIBLE_PEER' || (Array.isArray(state.blockedPeers) && state.blockedPeers.length > 0)) {
      const hasTrulyIncompatible = Array.isArray(state.blockedPeers) && state.blockedPeers.some(p => {
        const reason = String(p.reason || p.lineage_reason || '').toUpperCase();
        return !reason.includes('NEWER') && p.lineageStatus !== 'RECOVERABLE_NEWER';
      });
      const isRecoverableNewer = Boolean(state.newerBaselineDetected || state.hasNewerBaseline || (!hasTrulyIncompatible && (syncStatus === 'BLOCKED_PEER_BASELINE' || (state.blockedPeers && state.blockedPeers.length === 0))));
      if (isRecoverableNewer && !hasTrulyIncompatible) {
        title = 'Newer Cloud Snapshot Available';
        explanation = 'A connected device published a newer snapshot baseline. FinMan is aligning with the latest records.';
        badgeText = 'Newer Baseline';
        badgeType = 'info';
      } else {
        title = 'Sync Blocked — Incompatible Peer Baseline';
        explanation = 'A peer device is using an incompatible snapshot baseline. Snapshot alignment or update is required.';
        badgeText = 'Incompatible Peer';
      }
    }

    return {
      key: UNIFIED_SYNC_STATUS_KEYS.BLOCKED_SYNC,
      title,
      explanation,
      badgeText,
      badgeType,
      icon: '⏸️',
      hasPendingConflicts: conflictsNum > 0,
      conflictsCount: conflictsNum,
      conflictBadgeText,
      primaryActionKey: 'RETRY_SYNC',
      primaryActionLabel: 'Retry Sync',
      requiresAction: true,
      errorMessage: null,
      rawError: latestError,
      diagnostics: {
        blockedGapCount: Number(state.blockedGapCount) || 0,
        blockedDependencyCount: Number(state.blockedDependencyCount) || 0,
        blockedPeers: state.blockedPeers || []
      }
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
