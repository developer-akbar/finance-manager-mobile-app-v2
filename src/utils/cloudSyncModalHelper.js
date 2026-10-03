/**
 * cloudSyncModalHelper.js — Pure UI State & Copy Helpers for Cloud Sync Confirmation Modal
 */

export function getFriendlyActionName(action) {
  if (action === 'CREATE_INITIAL_SNAPSHOT') return 'Create Initial Cloud Snapshot';
  if (action === 'BOOTSTRAP_FROM_CLOUD') return 'Bootstrap From Cloud Snapshot';
  if (action === 'MERGE_CLEAN') return 'Reconcile & Synchronize';
  if (action === 'MERGE_WITH_CONFLICTS') return 'Reconcile (Review Conflicts)';
  if (action === 'NO_CHANGES') return 'Already Up to Date';
  return action || 'Reconcile';
}

export function isNoOpPreview(previewResult) {
  if (!previewResult) return false;
  if (previewResult.action === 'BOOTSTRAP_FROM_CLOUD' || previewResult.isFirstSync) return false;
  if (previewResult.conflicts && previewResult.conflicts.length > 0) return false;

  const localInserts = previewResult.plannedLocalChanges?.inserts || 0;
  const localUpdates = previewResult.plannedLocalChanges?.updates || 0;
  const localDeletes = previewResult.plannedLocalChanges?.deletes || 0;
  const localSettings = previewResult.plannedLocalChanges?.settingsUpdates || 0;

  const cloudInserts = previewResult.plannedCloudChanges?.inserts || 0;
  const cloudUpdates = previewResult.plannedCloudChanges?.updates || 0;
  const cloudDeletes = previewResult.plannedCloudChanges?.deletes || 0;
  const cloudSettings = previewResult.plannedCloudChanges?.settingsUpdates || 0;

  return (
    localInserts === 0 &&
    localUpdates === 0 &&
    localDeletes === 0 &&
    localSettings === 0 &&
    cloudInserts === 0 &&
    cloudUpdates === 0 &&
    cloudDeletes === 0 &&
    cloudSettings === 0
  );
}

export function isPullOnlyPreview(previewResult) {
  if (!previewResult) return false;
  if (previewResult.action === 'BOOTSTRAP_FROM_CLOUD' || previewResult.isFirstSync) return false;
  if (previewResult.conflicts && previewResult.conflicts.length > 0) return false;

  const totalLocalChanges = (previewResult.plannedLocalChanges?.inserts || 0) +
                            (previewResult.plannedLocalChanges?.updates || 0) +
                            (previewResult.plannedLocalChanges?.deletes || 0) +
                            (previewResult.plannedLocalChanges?.settingsUpdates || 0);

  const totalCloudChanges = (previewResult.plannedCloudChanges?.inserts || 0) +
                            (previewResult.plannedCloudChanges?.updates || 0) +
                            (previewResult.plannedCloudChanges?.deletes || 0) +
                            (previewResult.plannedCloudChanges?.settingsUpdates || 0);

  return totalLocalChanges > 0 && totalCloudChanges === 0;
}

export function getModalConfirmConfig(previewResult, stateTransactionsCount = 0, isSyncing = false) {
  if (!previewResult) return null;

  const isBootstrap = previewResult.action === 'BOOTSTRAP_FROM_CLOUD';
  const isNoOp = isNoOpPreview(previewResult);
  const isPullOnly = isPullOnlyPreview(previewResult);

  if (isBootstrap) {
    return {
      isNoOp: false,
      isBootstrap: true,
      isPullOnly: false,
      icon: '📥',
      title: 'Confirm Device Bootstrap',
      badge: 'Bootstrap From Cloud Snapshot',
      descriptionText: `${(previewResult.cloudTxnCount || 0).toLocaleString()} transactions and all financial records will be decrypted from cloud and loaded into your local database.`,
      buttonLabel: isSyncing ? 'Bootstrapping...' : '📥 Confirm & Bootstrap'
    };
  }

  if (isNoOp) {
    return {
      isNoOp: true,
      isBootstrap: false,
      isPullOnly: false,
      icon: '✨',
      title: 'In Sync — No Changes',
      badge: 'In Sync — No Changes',
      descriptionText: 'Your local database and cloud snapshot are already in sync. Confirming will verify the current state without uploading data.',
      buttonLabel: isSyncing ? 'Verifying sync...' : '✓ Confirm — No Upload'
    };
  }

  if (isPullOnly) {
    const totalLocalChanges = (previewResult.plannedLocalChanges?.inserts || 0) +
                              (previewResult.plannedLocalChanges?.updates || 0) +
                              (previewResult.plannedLocalChanges?.deletes || 0) +
                              (previewResult.plannedLocalChanges?.settingsUpdates || 0);

    return {
      isNoOp: false,
      isBootstrap: false,
      isPullOnly: true,
      icon: '📥',
      title: 'Confirm Pull From Cloud',
      badge: 'Incoming Changes from Cloud (No Upload)',
      descriptionText: `${totalLocalChanges} incoming changes from cloud will be applied to your local database. Zero data will be uploaded to Google Drive.`,
      buttonLabel: isSyncing ? 'Applying changes...' : '📥 Confirm & Pull (No Upload)'
    };
  }

  return {
    isNoOp: false,
    isBootstrap: false,
    isPullOnly: false,
    icon: '📦',
    title: 'Confirm Full Cloud Snapshot',
    badge: getFriendlyActionName(previewResult.action),
    descriptionText: `${stateTransactionsCount.toLocaleString()} transactions will be encrypted and saved as a full cloud snapshot baseline.`,
    buttonLabel: isSyncing ? 'Creating snapshot...' : '🚀 Confirm & Create Snapshot'
  };
}
