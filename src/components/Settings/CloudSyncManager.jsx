import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import {
  signInWithGoogle,
  getStoredToken,
  getValidAccessToken,
  isGoogleLinked,
  clearGoogleAuth,
  getGoogleClientId,
  setGoogleClientId
} from '../../services/googleAuth.js';
import {
  previewCloudSync,
  executeCloudSync,
  executeBootstrap,
  SYNC_STATUS,
  BOOTSTRAP_STATUS,
  CONFLICT_TYPES,
  DELETION_SAFETY_LIMIT_COUNT,
  DELETION_SAFETY_LIMIT_PERCENT
} from '../../services/cloudSyncEngine.js';
import {
  isSyncUnlocked,
  unlockSyncSession,
  lockSyncSession,
  subscribeSyncSession
} from '../../services/syncSession.js';
import {
  getDeltaSyncMetrics,
  subscribeSyncStatus,
  SYNC_STATUS as DELTA_SYNC_STATUS,
  SYNC_TRIGGER,
  triggerAutomaticSync,
  resolveConflict
} from '../../services/deltaSyncCoordinator.js';
import {
  getPendingConflicts,
  CONFLICT_RESOLUTION
} from '../../database/conflicts.js';
import {
  getFriendlyActionName,
  isNoOpPreview,
  getModalConfirmConfig
} from '../../utils/cloudSyncModalHelper.js';
import {
  deriveUnifiedSyncStatus,
  translateSyncError,
  UNIFIED_SYNC_STATUS_KEYS
} from '../../utils/cloudSyncStatusHelper.js';
import {
  formatConflictEntity,
  calculateEntityDiff
} from '../../utils/conflictFormatter.js';

export { getFriendlyActionName, isNoOpPreview, getModalConfirmConfig };

export default function CloudSyncManager({ onBack }) {
  const { state, load } = useApp();
  const refreshSeqRef = useRef(0);

  // Authentication & Configuration State
  const [isAuthenticated, setIsAuthenticated] = useState(() => isGoogleLinked());
  const [clientId, setClientId] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [authError, setAuthError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // In-Memory Session Key State (Never Persisted to Storage)
  const [isUnlocked, setIsUnlocked] = useState(() => isSyncUnlocked());
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [pinError, setPinError] = useState('');

  // Operations State
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isDeltaSyncing, setIsDeltaSyncing] = useState(false);
  const [operationType, setOperationType] = useState(null); // 'preview' | 'sync_now'
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [previewResult, setPreviewResult] = useState(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Persisted Legacy Snapshot Metadata (Read-Only)
  const [lastSyncInfo, setLastSyncInfo] = useState({
    lastSyncedAt: null,
    lastSnapshotId: null
  });

  // Live Phase 7.5 Delta Sync Observability State
  const [deltaMetrics, setDeltaMetrics] = useState({
    status: DELTA_SYNC_STATUS.IDLE,
    pendingCount: 0,
    lastAllocatedSequence: 0,
    lastUploadedSequence: 0,
    lastAckedSequence: 0,
    deviceId: 'local_device',
    lastDeltaSyncedAt: null,
    latestError: null
  });

  // Live Phase 7.5 Delta Sync Conflict State
  const [pendingConflicts, setPendingConflicts] = useState([]);
  const [resolvingId, setResolvingId] = useState(null);
  const [resolutionMsg, setResolutionMsg] = useState(null);
  const [confirmResolutionModal, setConfirmResolutionModal] = useState(null);

  // Subscribe to Session Key state changes
  useEffect(() => {
    const unsubscribe = subscribeSyncSession((unlocked) => {
      setIsUnlocked(unlocked);
    });
    return unsubscribe;
  }, []);

  // Subscribe to Phase 7.5 Delta Sync Coordinator State, Metrics & Conflicts & Sync Metadata
  useEffect(() => {
    let mounted = true;

    async function loadMeta() {
      try {
        const id = await getGoogleClientId();
        const lastAt = await getSetting('last_synced_at').catch(() => null);
        const lastSnap = await getSetting('last_snapshot_id').catch(() => null);
        if (mounted) {
          setClientId(id || '');
          setLastSyncInfo({
            lastSyncedAt: lastAt,
            lastSnapshotId: lastSnap
          });
          setIsAuthenticated(isGoogleLinked());
          setIsUnlocked(isSyncUnlocked());

          if (isGoogleLinked() && !getStoredToken()) {
            getValidAccessToken(false).then(token => {
              if (mounted) setIsAuthenticated(!!token || isGoogleLinked());
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('Failed to load cloud sync metadata:', err);
      }
    }

    async function refreshDeltaMetrics(details = {}, status = null, seq = null) {
      try {
        const m = await getDeltaSyncMetrics();
        if (mounted && (seq === null || seq === refreshSeqRef.current)) {
          setDeltaMetrics(prev => {
            let nextError = prev.latestError;
            if (status === DELTA_SYNC_STATUS.SUCCESS || details?.status === 'BOOTSTRAP_SUCCESS' || details?.operation === 'BOOTSTRAP' || details?.bootstrapped) {
              nextError = null;
            } else if (details?.error || details?.reason) {
              nextError = details.error || details.reason;
            }
            return {
              ...m,
              status: status || m.status || prev.status,
              latestError: nextError
            };
          });
        }
      } catch {}
    }

    async function refreshConflicts() {
      try {
        const list = await getPendingConflicts();
        if (mounted) {
          setPendingConflicts(list || []);
        }
      } catch {}
    }

    async function refreshAll(details = {}, status = null) {
      const currentSeq = ++refreshSeqRef.current;
      await refreshDeltaMetrics(details, status, currentSeq);
      if (currentSeq !== refreshSeqRef.current || !mounted) return;
      await refreshConflicts();
      if (currentSeq !== refreshSeqRef.current || !mounted) return;
      await loadMeta();
      if (currentSeq !== refreshSeqRef.current || !mounted) return;
      if (status === DELTA_SYNC_STATUS.SUCCESS || details?.bootstrapped || details?.status === 'BOOTSTRAP_SUCCESS' || details?.operation === 'BOOTSTRAP') {
        if (typeof load === 'function') {
          try { await load(); } catch {}
        }
      }
    }

    refreshAll();

    const unsubscribeDelta = subscribeSyncStatus((status, details) => {
      // 1. Immediately and synchronously update status to maintain real-time UI responsiveness
      if (mounted && status) {
        setDeltaMetrics(prev => ({
          ...prev,
          status,
          latestError: (status === DELTA_SYNC_STATUS.SUCCESS || details?.bootstrapped) ? null : (details?.error || details?.reason || prev.latestError)
        }));
      }
      // 2. Perform sequenced async database hydration
      refreshAll(details, status);
    });

    return () => {
      mounted = false;
      unsubscribeDelta();
    };
  }, [isUnlocked, isAuthenticated, load]);

  // Handle Google Sign-In
  const handleConnect = async () => {
    setAuthError('');
    setIsAuthenticating(true);
    try {
      if (clientId.trim()) {
        await setGoogleClientId(clientId.trim());
      }
      const res = await signInWithGoogle({ prompt: 'consent' });
      if (res && res.accessToken) {
        setIsAuthenticated(true);
      }
    } catch (err) {
      setAuthError(err.message || 'Google authentication failed.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  // Handle Google Disconnect
  const handleDisconnect = () => {
    clearGoogleAuth();
    lockSyncSession();
    setIsAuthenticated(false);
    setPreviewResult(null);
    setShowConfirmModal(false);
    setSuccessMsg('');
    setPin('');
  };

  // Handle Custom Client ID Save
  const handleSaveClientId = async () => {
    try {
      await setGoogleClientId(clientId.trim());
      setShowConfig(false);
    } catch (err) {
      setAuthError('Failed to save Client ID.');
    }
  };

  // Handle Explicit Session Unlock
  const handleUnlock = async () => {
    if (!pin || !pin.trim()) {
      setPinError('Please enter your encryption PIN.');
      return false;
    }
    if (pin.trim().length < 4) {
      setPinError('PIN must be at least 4 characters.');
      return false;
    }
    setPinError('');
    setIsUnlocking(true);
    try {
      await unlockSyncSession(pin.trim());
      setPin(''); // Immediately clear raw PIN from component input state
      return true;
    } catch (err) {
      setPinError(err.message || 'Failed to unlock with PIN.');
      return false;
    } finally {
      setIsUnlocking(false);
    }
  };

  // Handle Explicit Session Lock
  const handleLock = () => {
    lockSyncSession();
    setPin('');
    setPreviewResult(null);
    setShowConfirmModal(false);
    setConfirmResolutionModal(null);
  };

  // Open Conflict Resolution Confirmation Modal
  const handleOpenResolveConfirm = (conflict, resolution) => {
    setResolutionMsg(null);
    setConfirmResolutionModal({
      conflict,
      resolution
    });
  };

  // Execute Conflict Resolution
  const handleExecuteConflictResolution = async () => {
    if (!confirmResolutionModal || !confirmResolutionModal.conflict) return;
    const { conflict, resolution } = confirmResolutionModal;

    setResolvingId(conflict.conflict_id);
    setResolutionMsg(null);
    try {
      await resolveConflict(conflict.conflict_id, resolution);

      const successText = resolution === CONFLICT_RESOLUTION.KEEP_LOCAL
        ? 'Resolved: your version will be propagated to other devices.'
        : 'Resolved: the remote version will be propagated to other devices.';

      setResolutionMsg({
        type: 'success',
        text: successText
      });

      // Refresh conflicts, metrics, and in-memory React state
      const updatedList = await getPendingConflicts();
      setPendingConflicts(updatedList || []);
      const updatedMetrics = await getDeltaSyncMetrics();
      setDeltaMetrics(prev => ({ ...prev, ...updatedMetrics }));

      if (typeof load === 'function') {
        load().catch(() => {});
      }
    } catch (err) {
      setResolutionMsg({
        type: 'error',
        text: `Resolution failed: ${err.message}`
      });
    } finally {
      setResolvingId(null);
      setConfirmResolutionModal(null);
    }
  };

  // Step 5B/7.5 Live Cloud Sync (Manual Trigger — lightweight delta push/pull, NEVER invokes executeCloudSync)
  const handleSyncChangesNow = async () => {
    if (!isUnlocked) {
      if (!pin || pin.trim().length < 4) {
        setPinError('Please enter your 4+ digit PIN to unlock sync.');
        return;
      }
      const ok = await handleUnlock();
      if (!ok) return;
    }

    const token = await getValidAccessToken(true);
    if (!token) {
      setAuthError('Please connect your Google Drive account first.');
      return;
    }

    setIsDeltaSyncing(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const result = await triggerAutomaticSync(SYNC_TRIGGER.MANUAL);
      if (result && result.status === 'ERROR') {
        setErrorMsg(result.error || 'Live delta sync failed.');
      } else if (result && result.status === 'AUTH_REQUIRED') {
        setErrorMsg('Authentication or session unlock required.');
      } else {
        setSuccessMsg('✓ Live sync completed — all changes synchronized.');
        if (typeof load === 'function') {
          load().catch(() => {});
        }
        const updatedMetrics = await getDeltaSyncMetrics();
        setDeltaMetrics(prev => ({ ...prev, ...updatedMetrics }));
      }
    } catch (err) {
      setErrorMsg(err.message || 'Live sync failed.');
    } finally {
      setIsDeltaSyncing(false);
    }
  };

  // Run Preview / Dry-Run (Strictly Read-Only)
  const handlePreview = async () => {
    if (!isUnlocked) {
      if (!pin || pin.trim().length < 4) {
        setPinError('Please enter your 4+ digit PIN to unlock sync.');
        return;
      }
      const ok = await handleUnlock();
      if (!ok) return;
    }

    const token = await getValidAccessToken(true);
    if (!token) {
      setAuthError('Please connect your Google Drive account first.');
      return;
    }

    setIsLoading(true);
    setOperationType('preview');
    setErrorMsg('');
    setSuccessMsg('');
    setPreviewResult(null);

    try {
      const result = await previewCloudSync({
        accessToken: token,
        deviceId: 'web_client'
      });
      if (result?.diagnostics) {
        console.log('[CloudSyncPreviewDiagnostic]', JSON.stringify(result.diagnostics, null, 2));
      }
      setPreviewResult(result);
    } catch (err) {
      setErrorMsg(err.message || 'Preview failed. Local data remains completely safe.');
    } finally {
      setIsLoading(false);
      setOperationType(null);
    }
  };

  // Step 5B/6A Sync Now Click (Validates -> Runs Preview -> Opens Confirmation Modal)
  const handleSyncNowClick = async () => {
    if (!isUnlocked) {
      if (!pin || pin.trim().length < 4) {
        setPinError('Please enter your 4+ digit PIN to unlock sync.');
        return;
      }
      const ok = await handleUnlock();
      if (!ok) return;
    }

    const token = await getValidAccessToken(true);
    if (!token) {
      setAuthError('Please connect your Google Drive account first.');
      return;
    }

    setIsLoading(true);
    setOperationType('sync_now');
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const result = await previewCloudSync({
        accessToken: token,
        deviceId: 'web_client'
      });
      setPreviewResult(result);
      if (result.safetyStatus === 'SAFETY_ABORT_MASS_DELETION') {
        setErrorMsg('Safety guardrail triggered: Proposed sync contains excessive deletions. Sync is blocked.');
        return;
      }
      setShowConfirmModal(true);
    } catch (err) {
      setErrorMsg(err.message || 'Sync preparation failed. Local data remains untouched.');
    } finally {
      setIsLoading(false);
      setOperationType(null);
    }
  };

  // Step 5B/6A/6B Live Cloud Sync & Bootstrap Execution
  const handleExecuteLiveSync = async () => {
    if (!isUnlocked) {
      setErrorMsg('Session is locked. Please unlock with your PIN first.');
      setShowConfirmModal(false);
      return;
    }

    const token = await getValidAccessToken(true);
    if (!token) {
      setAuthError('Please connect your Google Drive account first.');
      return;
    }

    setIsSyncing(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      let syncResult;
      const isBootstrapAction = previewResult?.action === 'BOOTSTRAP_FROM_CLOUD' || previewResult?.isBootstrapEligible;

      if (isBootstrapAction) {
        syncResult = await executeBootstrap({
          accessToken: token,
          deviceId: 'web_client'
        });
      } else {
        syncResult = await executeCloudSync({
          accessToken: token,
          deviceId: 'web_client'
        });
      }

      const isSuccess = syncResult.status === SYNC_STATUS.SUCCESS || 
                        syncResult.status === SYNC_STATUS.NO_CHANGES || 
                        syncResult.status === BOOTSTRAP_STATUS.SUCCESS ||
                        syncResult.status === 'BOOTSTRAP_SUCCESS';

      if (isSuccess) {
        if (typeof load === 'function') {
          try {
            await load();
          } catch (loadErr) {
            console.warn('[CloudSyncManager] Post-sync state reload warning:', loadErr);
          }
        }
        const nowIso = new Date().toISOString();
        setLastSyncInfo({
          lastSyncedAt: nowIso,
          lastSnapshotId: syncResult.snapshotId
        });

        let successText = '✓ Sync completed successfully.';
        if (syncResult.operation === 'BOOTSTRAP' || syncResult.status === 'BOOTSTRAP_SUCCESS') {
          successText = '✓ Successfully bootstrapped database from cloud snapshot!';
        } else if (syncResult.operation === 'NO_OP' || syncResult.status === SYNC_STATUS.NO_CHANGES) {
          successText = '✓ Already up to date — No changes to sync.';
        } else if (syncResult.isFirstSync) {
          successText = '✓ Initial cloud snapshot created and verified successfully!';
        }

        setSuccessMsg(successText);
        setPreviewResult(null);
        setShowConfirmModal(false);
      } else if (syncResult.status === SYNC_STATUS.SAFETY_ABORT_MASS_DELETION) {
        setErrorMsg(syncResult.error || 'Sync aborted by safety guardrail.');
        setShowConfirmModal(false);
      } else if (syncResult.status === BOOTSTRAP_STATUS.EXISTING_LOCAL_DATA_REQUIRES_MERGE) {
        setErrorMsg('Local database already contains financial records. Bootstrap aborted.');
        setShowConfirmModal(false);
      } else {
        setErrorMsg(`Sync ended with status: ${syncResult.status}`);
        setShowConfirmModal(false);
      }
    } catch (err) {
      setErrorMsg(err.message || 'Cloud sync failed. Local financial data remains untouched.');
      setShowConfirmModal(false);
    } finally {
      setIsSyncing(false);
    }
  };

  // Authoritative live delta sync state across the entire component (Strictly isolates full snapshot isSyncing)
  const isLiveDeltaSyncing = isDeltaSyncing || deltaMetrics.status === DELTA_SYNC_STATUS.SYNCING;

  return (
    <div className="settings-root" style={{ paddingBottom: 'calc(var(--safe-bottom) + 32px)' }}>
      {/* Header with polished Light-Mode accessible back button */}
      <div className="page-hdr settings-main-hdr" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          className="back-btn"
          onClick={onBack}
          aria-label="Back to Settings"
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <div className="page-hdr-title" style={{ fontSize: '1.2rem', fontWeight: 800 }}>
            Cloud Sync (Google Drive)
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            Zero-Knowledge 3-Way Sync · Sandboxed Storage
          </div>
        </div>
      </div>

      <div style={{ padding: '0 var(--page-px)', maxWidth: 640, margin: '0 auto' }}>
        {/* Security & Privacy Notice */}
        <div style={{
          background: 'rgba(0, 229, 160, 0.08)',
          border: '1px solid rgba(0, 229, 160, 0.25)',
          borderRadius: 10,
          padding: '12px 14px',
          marginBlock: 14,
          fontSize: '0.75rem',
          lineHeight: 1.45,
          color: 'var(--text-primary)'
        }}>
          <div style={{ fontWeight: 800, color: 'var(--green)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>🔒 End-to-End Encrypted</span>
          </div>
          <div>
            Your financial data is encrypted with AES-256-GCM using your private PIN before leaving your device. Google Drive acts solely as a private sync repository in your sandboxed AppData folder.
          </div>
        </div>

        {/* --- UNIFIED PRIMARY STATUS BANNER (Stage B1) --- */}
        {(() => {
          const unifiedStatus = deriveUnifiedSyncStatus({
            isGoogleLinked: isGoogleLinked(),
            isAuthenticated,
            isUnlocked,
            lifecycleState: deltaMetrics.lifecycleState,
            syncStatus: deltaMetrics.status,
            pendingCount: deltaMetrics.pendingCount,
            lastDeltaSyncedAt: deltaMetrics.lastDeltaSyncedAt,
            pendingConflictsCount: pendingConflicts.length,
            latestError: deltaMetrics.latestError || authError,
            isDeltaSyncing: isLiveDeltaSyncing
          });

          const bannerStyles = {
            success: {
              bg: 'rgba(0, 229, 160, 0.08)',
              border: '1px solid rgba(0, 229, 160, 0.3)',
              badgeBg: 'rgba(0, 229, 160, 0.15)',
              badgeColor: 'var(--green)'
            },
            warning: {
              bg: 'rgba(255, 179, 0, 0.08)',
              border: '1px solid rgba(255, 179, 0, 0.3)',
              badgeBg: 'rgba(255, 179, 0, 0.15)',
              badgeColor: 'var(--warning)'
            },
            error: {
              bg: 'rgba(255, 77, 106, 0.08)',
              border: '1px solid rgba(255, 77, 106, 0.3)',
              badgeBg: 'rgba(255, 77, 106, 0.15)',
              badgeColor: 'var(--expense)'
            },
            info: {
              bg: 'rgba(74, 144, 226, 0.08)',
              border: '1px solid rgba(74, 144, 226, 0.3)',
              badgeBg: 'rgba(74, 144, 226, 0.15)',
              badgeColor: 'var(--accent)'
            }
          }[unifiedStatus.badgeType] || {
            bg: 'var(--bg-surface)',
            border: '1px solid var(--border-light)',
            badgeBg: 'rgba(255, 255, 255, 0.05)',
            badgeColor: 'var(--text-muted)'
          };

          return (
            <div style={{
              background: bannerStyles.bg,
              border: bannerStyles.border,
              borderRadius: 12,
              padding: '14px 16px',
              marginBottom: 16
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: '1.2rem', lineHeight: 1 }}>{unifiedStatus.icon}</span>
                  <div style={{ fontSize: '0.92rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {unifiedStatus.title}
                  </div>
                </div>
                <span style={{
                  fontSize: '0.68rem',
                  fontWeight: 800,
                  padding: '3px 8px',
                  borderRadius: 4,
                  background: bannerStyles.badgeBg,
                  color: bannerStyles.badgeColor,
                  flexShrink: 0
                }}>
                  {unifiedStatus.badgeText}
                </span>
              </div>

              <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.45, marginTop: 4 }}>
                {unifiedStatus.explanation}
              </div>

              {/* Localized Error Guidance */}
              {unifiedStatus.errorMessage && (
                <div style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'rgba(255, 77, 106, 0.12)',
                  color: 'var(--expense)',
                  fontSize: '0.72rem',
                  fontWeight: 600
                }}>
                  ⚠️ {unifiedStatus.errorMessage}
                </div>
              )}

              {/* Secondary Conflict Notice */}
              {unifiedStatus.hasPendingConflicts && (
                <div style={{
                  marginTop: 8,
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: 'rgba(255, 179, 0, 0.15)',
                  border: '1px solid rgba(255, 179, 0, 0.3)',
                  color: 'var(--text-primary)',
                  fontSize: '0.72rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8
                }}>
                  <span>⚠️ <strong>{unifiedStatus.conflictBadgeText}</strong> — Both versions are safely preserved.</span>
                  <button
                    type="button"
                    onClick={() => {
                      const conflictEl = document.getElementById('sync-conflicts-section');
                      if (conflictEl) conflictEl.scrollIntoView({ behavior: 'smooth' });
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--warning)',
                      fontWeight: 800,
                      fontSize: '0.72rem',
                      cursor: 'pointer',
                      padding: 0,
                      textDecoration: 'underline'
                    }}
                  >
                    Review ↓
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* Section 1: Google Account Connection */}
        <div className="settings-group-label" style={{ padding: '8px 0 6px' }}>1. Google Drive Account</div>
        <div className="settings-card" style={{ padding: 14, margin: '0 0 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: isAuthenticated ? 'var(--green)' : (isGoogleLinked() ? 'var(--warning)' : 'var(--text-muted)'),
                boxShadow: isAuthenticated ? '0 0 6px var(--green)' : (isGoogleLinked() ? '0 0 6px var(--warning)' : 'none')
              }} />
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {isAuthenticated
                    ? 'Connected to Google Drive'
                    : (isGoogleLinked() ? 'Google Account Linked (Needs Reconnect)' : 'Not Connected')}
                </div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                  {isAuthenticated
                    ? 'Scope: drive.appdata (Sandboxed)'
                    : (isGoogleLinked() ? 'Authorization expired — reconnect to sync' : 'Connect your account to enable sync')}
                </div>
              </div>
            </div>

            {isGoogleLinked() ? (
              <div style={{ display: 'flex', gap: 6 }}>
                {!isAuthenticated && (
                  <button
                    className="btn btn-primary"
                    onClick={handleConnect}
                    disabled={isAuthenticating}
                    style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                  >
                    {isAuthenticating ? 'Connecting...' : 'Reconnect'}
                  </button>
                )}
                <button
                  className="btn btn-ghost"
                  onClick={handleDisconnect}
                  style={{ fontSize: '0.75rem', color: 'var(--expense)', padding: '4px 10px' }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                className="btn btn-primary"
                onClick={handleConnect}
                disabled={isAuthenticating}
                style={{ fontSize: '0.78rem', padding: '6px 14px' }}
              >
                {isAuthenticating ? 'Connecting...' : 'Connect Google'}
              </button>
            )}
          </div>

          {/* Client ID Configuration Toggle */}
          <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 8, marginTop: 6 }}>
            <button
              className="btn btn-ghost"
              onClick={() => setShowConfig(!showConfig)}
              style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textDecoration: 'underline' }}
            >
              {showConfig ? 'Hide OAuth Client ID Config' : 'Configure Custom OAuth Client ID'}
            </button>

            {showConfig && (
              <div style={{ marginTop: 8 }}>
                <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  OAuth 2.0 Web Client ID
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="e.g. 123456...apps.googleusercontent.com"
                    value={clientId}
                    onChange={e => setClientId(e.target.value)}
                    style={{ flex: 1, fontSize: '0.75rem', padding: '6px 10px' }}
                  />
                  <button
                    className="btn btn-secondary"
                    onClick={handleSaveClientId}
                    style={{ fontSize: '0.72rem', padding: '6px 12px' }}
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>

          {authError && (
            <div style={{
              marginTop: 10,
              padding: '8px 12px',
              borderRadius: 6,
              background: 'rgba(255, 77, 106, 0.12)',
              color: 'var(--expense)',
              fontSize: '0.72rem',
              fontWeight: 600
            }}>
              ⚠️ {translateSyncError(authError)}
            </div>
          )}
        </div>

        {/* Section 2: Session Key / PIN Unlock */}
        <div className="settings-group-label" style={{ padding: '8px 0 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>2. Session Encryption Key</span>
          <span style={{ fontSize: '0.72rem', fontWeight: 800, color: isUnlocked ? 'var(--green)' : 'var(--warning)' }}>
            {isUnlocked ? '🔓 Session Unlocked' : '🔒 Sync Locked'}
          </span>
        </div>
        <div className="settings-card" style={{ padding: 14, margin: '0 0 14px' }}>
          {isUnlocked ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>Session Unlocked</span>
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
                  Non-extractable key cached in memory. Cleared on refresh, tab close, or Lock Sync.
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleLock}
                style={{ fontSize: '0.75rem', color: 'var(--expense)', border: '1px solid var(--border-light)', padding: '5px 12px', flexShrink: 0 }}
              >
                🔒 Lock Sync
              </button>
            </div>
          ) : (
            <>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 10 }}>
                Enter your PIN once to unlock cloud sync for this browser session. The raw PIN is never stored.
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input
                    type={showPin ? 'text' : 'password'}
                    className={`form-input ${pinError ? 'input-error' : ''}`}
                    placeholder="Enter 4+ digit sync PIN"
                    value={pin}
                    onChange={e => { setPin(e.target.value); setPinError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') handleUnlock(); }}
                    style={{ width: '100%', fontSize: '0.85rem', padding: '8px 40px 8px 12px' }}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin(!showPin)}
                    style={{
                      position: 'absolute',
                      right: 8,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      fontSize: '0.9rem',
                      cursor: 'pointer',
                      opacity: 0.6
                    }}
                    aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                  >
                    {showPin ? '👁️' : '🔒'}
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleUnlock}
                  disabled={isUnlocking}
                  style={{ fontSize: '0.78rem', padding: '8px 16px', flexShrink: 0 }}
                >
                  {isUnlocking ? 'Unlocking...' : 'Unlock'}
                </button>
              </div>

              {pinError && (
                <div style={{ color: 'var(--expense)', fontSize: '0.7rem', fontWeight: 600, marginTop: 6 }}>
                  ⚠️ {translateSyncError(pinError)}
                </div>
              )}
            </>
          )}
        </div>

        {/* Section 3: Live Cloud Sync */}
        <div className="settings-group-label" style={{ padding: '8px 0 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>3. Live Cloud Sync</span>
          <span style={{
            fontSize: '0.68rem',
            fontWeight: 800,
            padding: '2px 8px',
            borderRadius: 4,
            background: !isUnlocked
              ? 'rgba(255, 179, 0, 0.15)'
              : (isLiveDeltaSyncing
                  ? 'rgba(74, 144, 226, 0.15)'
                  : (deltaMetrics.pendingCount > 0 ? 'rgba(255, 179, 0, 0.15)' : 'rgba(0, 229, 160, 0.15)')),
            color: !isUnlocked
              ? 'var(--warning)'
              : (isLiveDeltaSyncing
                  ? 'var(--accent)'
                  : (deltaMetrics.pendingCount > 0 ? 'var(--warning)' : 'var(--green)'))
          }}>
            {!isUnlocked
              ? 'Sync Locked'
              : (isLiveDeltaSyncing
                  ? 'Syncing…'
                  : (deltaMetrics.pendingCount > 0 ? `${deltaMetrics.pendingCount} Pending` : 'Cloud Sync On'))}
          </span>
        </div>
        <div className="settings-card" style={{ padding: 14, margin: '0 0 14px', fontSize: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-light)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Status</span>
            <span style={{
              fontWeight: 700,
              color: !isUnlocked
                ? 'var(--warning)'
                : (isLiveDeltaSyncing ? 'var(--accent)' : 'var(--text-primary)')
            }}>
              {!isUnlocked
                ? '🔒 Sync Locked (PIN Required)'
                : (isLiveDeltaSyncing
                    ? 'Syncing changes…'
                    : (deltaMetrics.pendingCount > 0 ? 'Changes Waiting' : 'All Changes Up to Date'))}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-light)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Pending Changes</span>
            <span style={{ fontWeight: 700, color: deltaMetrics.pendingCount > 0 ? 'var(--warning)' : (!isUnlocked ? 'var(--text-secondary)' : 'var(--green)') }}>
              {deltaMetrics.pendingCount} {deltaMetrics.pendingCount === 1 ? 'change' : 'changes'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
            <span style={{ color: 'var(--text-muted)' }}>Last Live Sync</span>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              {deltaMetrics.lastDeltaSyncedAt ? new Date(deltaMetrics.lastDeltaSyncedAt).toLocaleString() : 'Never'}
            </span>
          </div>

          <button
            className={!isUnlocked ? "btn btn-secondary" : "btn btn-primary"}
            onClick={!isUnlocked ? () => {
              const pinInput = document.querySelector('input[placeholder*="sync PIN"]');
              if (pinInput) pinInput.focus();
            } : handleSyncChangesNow}
            disabled={!isUnlocked ? false : (isLiveDeltaSyncing || isLoading || isSyncing || !isGoogleLinked())}
            style={{
              width: '100%',
              marginTop: 12,
              padding: '10px 14px',
              fontSize: '0.82rem',
              fontWeight: 800
            }}
          >
            {!isUnlocked
              ? '🔒 Unlock Sync with PIN to Sync'
              : (isLiveDeltaSyncing ? 'Syncing Changes...' : '⚡ Sync Changes Now')}
          </button>

          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.4, marginTop: 8 }}>
            {!isUnlocked ? (
              <span>• <strong>Sync Locked</strong>: Enter your PIN in Section 2 above to resume live cloud synchronization.</span>
            ) : (
              <span>• <strong>Sync Changes Now</strong>: Flushes pending local changes and pulls updates from peer devices (fast & lightweight).</span>
            )}
          </div>
        </div>

        {/* Section 4: Technical Details & Diagnostics (Collapsible Accordion) */}
        <details className="settings-card" style={{ padding: 14, margin: '0 0 14px', fontSize: '0.75rem', cursor: 'pointer' }}>
          <summary style={{ fontWeight: 700, fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', userSelect: 'none' }}>
            <span>⚙️ Technical Details &amp; Diagnostics</span>
            <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Expand / Collapse</span>
          </summary>
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border-light)', paddingTop: 8, cursor: 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border-light)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Uploaded Sequence</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-primary)' }}>
                {deltaMetrics.lastUploadedSequence}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border-light)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Acknowledged Sequence</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-primary)' }}>
                {deltaMetrics.lastAckedSequence}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border-light)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Local Device ID</span>
              <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {deltaMetrics.deviceId}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border-light)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Lifecycle State</span>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                {deltaMetrics.lifecycleState}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border-light)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Active Snapshot ID</span>
              <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {lastSyncInfo.lastSnapshotId || 'None'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
              <span style={{ color: 'var(--text-muted)' }}>Local Transactions</span>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                {state.transactions.length.toLocaleString()}
              </span>
            </div>
            {deltaMetrics.latestError && (
              <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 4, background: 'rgba(255, 77, 106, 0.08)', color: 'var(--expense)', fontSize: '0.68rem', fontFamily: 'monospace', wordBreak: 'break-word' }}>
                Diagnostic Log: {deltaMetrics.latestError}
              </div>
            )}
          </div>
        </details>

        {/* Section 5: Full Cloud Snapshot (Stage A Separation Preserved) */}
        <div className="settings-group-label" style={{ padding: '8px 0 6px' }}>5. Advanced Cloud Snapshot &amp; Baseline</div>
        <div className="settings-card" style={{ padding: 14, margin: '0 0 14px', fontSize: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-light)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Local Database Records</span>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{state.transactions.length.toLocaleString()} transactions</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-light)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Last Full Snapshot</span>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              {lastSyncInfo.lastSyncedAt ? new Date(lastSyncInfo.lastSyncedAt).toLocaleString() : 'Never'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 12, marginBottom: 12 }}>
            <button
              className="btn btn-secondary"
              onClick={handlePreview}
              disabled={isLoading || isSyncing || isDeltaSyncing || !isGoogleLinked()}
              style={{ flex: 1, padding: '10px 14px', fontSize: '0.82rem', fontWeight: 700 }}
            >
              {isLoading && operationType === 'preview' ? 'Inspecting...' : '🔍 Preview Snapshot'}
            </button>

            <button
              className="btn btn-primary"
              onClick={handleSyncNowClick}
              disabled={isLoading || isSyncing || isDeltaSyncing || !isGoogleLinked()}
              style={{ flex: 1, padding: '10px 14px', fontSize: '0.82rem', fontWeight: 800 }}
            >
              {isLoading && operationType === 'sync_now' ? 'Preparing...' : '📦 Create Full Snapshot'}
            </button>
          </div>

          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
            • <strong>Preview Snapshot</strong>: Performs a 100% read-only inspection. Zero database changes, zero Drive writes.<br />
            • <strong>Create Full Snapshot</strong>: Encrypts and saves your entire database as a new cloud baseline.
          </div>

          {errorMsg && (
            <div style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'rgba(255, 77, 106, 0.12)',
              color: 'var(--expense)',
              fontSize: '0.74rem',
              fontWeight: 600
            }}>
              🛑 {translateSyncError(errorMsg)}
            </div>
          )}

          {successMsg && (
            <div style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'rgba(0, 229, 160, 0.12)',
              color: 'var(--green)',
              fontSize: '0.74rem',
              fontWeight: 700
            }}>
              {successMsg}
            </div>
          )}
        </div>

        {/* Section 6: Sync Conflicts (Automatic V3) */}
        <div id="sync-conflicts-section" className="settings-group-label" style={{ padding: '8px 0 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>6. Sync Conflicts</span>
          <span style={{
            fontSize: '0.68rem',
            fontWeight: 800,
            padding: '2px 8px',
            borderRadius: 4,
            background: pendingConflicts.length > 0 ? 'rgba(255, 179, 0, 0.15)' : 'rgba(0, 229, 160, 0.15)',
            color: pendingConflicts.length > 0 ? 'var(--warning)' : 'var(--green)'
          }}>
            {pendingConflicts.length > 0 ? `⚠️ ${pendingConflicts.length} Pending` : '0 Pending'}
          </span>
        </div>

        <div className="settings-card" style={{ padding: 14, margin: '0 0 14px', fontSize: '0.75rem' }}>
          {resolutionMsg && (
            <div style={{
              marginBottom: 12,
              padding: '10px 12px',
              borderRadius: 8,
              background: resolutionMsg.type === 'success' ? 'rgba(0, 229, 160, 0.12)' : 'rgba(255, 77, 106, 0.12)',
              color: resolutionMsg.type === 'success' ? 'var(--green)' : 'var(--expense)',
              fontSize: '0.74rem',
              fontWeight: 700
            }}>
              {resolutionMsg.type === 'success' ? '✅ ' : '🛑 '}{resolutionMsg.text}
            </div>
          )}

          {pendingConflicts.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
              No sync conflicts detected. All local and peer delta events have reconciled cleanly.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{
                padding: '10px 12px',
                borderRadius: 8,
                background: 'rgba(255, 179, 0, 0.08)',
                border: '1px solid rgba(255, 179, 0, 0.25)',
                color: 'var(--text-primary)',
                fontSize: '0.72rem',
                lineHeight: 1.45
              }}>
                <div style={{ fontWeight: 800, color: 'var(--warning)', marginBottom: 3 }}>
                  🛡️ Both versions are safely preserved while you review.
                </div>
                <div>
                  This conflict affects only this record. Other transactions and accounts continue syncing normally. Choose which version should become authoritative.
                </div>
              </div>

              {pendingConflicts.map((c) => {
                const isCurrentResolving = resolvingId === c.conflict_id;
                const formatted = formatConflictEntity(c);
                const diff = calculateEntityDiff(c.local_payload, c.remote_payload, c.collection);

                return (
                  <div
                    key={c.conflict_id}
                    style={{
                      border: '1px solid var(--border-light)',
                      borderRadius: 10,
                      padding: 14,
                      background: 'var(--bg-surface)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12
                    }}
                  >
                    {/* Conflict Header */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{
                          fontSize: '0.68rem',
                          fontWeight: 800,
                          padding: '2px 8px',
                          borderRadius: 4,
                          background: 'rgba(255, 179, 0, 0.15)',
                          color: 'var(--warning)'
                        }}>
                          ⚠️ {formatted.friendlyType}
                        </span>
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                          {formatted.collectionLabel}
                        </span>
                      </div>
                      <div style={{ fontWeight: 800, fontSize: '0.88rem', color: 'var(--text-primary)', wordBreak: 'break-word', marginTop: 4 }}>
                        {formatted.primaryTitle}
                      </div>
                      {formatted.primarySubtitle && (
                        <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--accent)', marginTop: 2 }}>
                          {formatted.primarySubtitle}
                        </div>
                      )}
                    </div>

                    {/* What Changed (Field Diff Highlights) */}
                    {diff.changedFields.length > 0 && (
                      <div style={{
                        background: 'rgba(255, 255, 255, 0.03)',
                        border: '1px solid var(--border-light)',
                        borderRadius: 8,
                        padding: '10px 12px'
                      }}>
                        <div style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--warning)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span>⚡</span>
                          <span>What Changed</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {diff.changedFields.map((field) => (
                            <div key={field.key} style={{
                              padding: '6px 8px',
                              borderRadius: 6,
                              background: 'rgba(255, 179, 0, 0.06)',
                              border: '1px solid rgba(255, 179, 0, 0.15)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 2
                            }}>
                              <div style={{ fontWeight: 700, fontSize: '0.72rem', color: 'var(--text-primary)' }}>
                                {field.label}
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', flexWrap: 'wrap', gap: 4 }}>
                                <span style={{ color: 'var(--accent)' }}>
                                  This Device: <strong>{field.localValue}</strong>
                                </span>
                                <span style={{ color: 'var(--warning)' }}>
                                  Other Device: <strong>{field.remoteValue}</strong>
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Unchanged Fields Collapsible */}
                    {diff.unchangedFields.length > 0 && (
                      <details style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '2px 0' }}>
                          Show unchanged fields ({diff.unchangedFields.length})
                        </summary>
                        <div style={{ padding: '6px 8px', background: 'var(--bg-card)', borderRadius: 6, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {diff.unchangedFields.map((f) => (
                            <div key={f.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem' }}>
                              <span>{f.label}:</span>
                              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{f.localValue}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {/* Side-by-Side Version Cards */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
                      {/* Local Version */}
                      <div style={{
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: 'rgba(74, 144, 226, 0.08)',
                        border: '1px solid rgba(74, 144, 226, 0.2)'
                      }}>
                        <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--accent)', marginBottom: 2 }}>
                          📱 This Device
                        </div>
                        <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                          Current version on this device
                        </div>
                        <div style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                          {formatted.localDescriptor.note || formatted.localDescriptor.title}
                        </div>
                        {formatted.localDescriptor.amount && (
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>
                            Amount: {formatted.localDescriptor.amount}
                          </div>
                        )}
                        {formatted.localDescriptor.date && (
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                            Date: {formatted.localDescriptor.date}
                          </div>
                        )}
                      </div>

                      {/* Remote Version */}
                      <div style={{
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: 'rgba(255, 179, 0, 0.08)',
                        border: '1px solid rgba(255, 179, 0, 0.2)'
                      }}>
                        <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--warning)', marginBottom: 2 }}>
                          ☁️ Other Device
                        </div>
                        <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                          Incoming version from cloud sync
                        </div>
                        <div style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                          {formatted.remoteDescriptor.note || formatted.remoteDescriptor.title}
                        </div>
                        {formatted.remoteDescriptor.amount && (
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>
                            Amount: {formatted.remoteDescriptor.amount}
                          </div>
                        )}
                        {formatted.remoteDescriptor.date && (
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                            Date: {formatted.remoteDescriptor.date}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => handleOpenResolveConfirm(c, CONFLICT_RESOLUTION.KEEP_LOCAL)}
                        disabled={!isUnlocked || isCurrentResolving}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '8px 10px',
                          borderRadius: 8,
                          textAlign: 'center'
                        }}
                      >
                        <span style={{ fontWeight: 800, fontSize: '0.76rem' }}>
                          {isCurrentResolving ? 'Resolving...' : "📱 Keep This Device's Version"}
                        </span>
                        <span style={{ fontSize: '0.64rem', fontWeight: 400, opacity: 0.85, marginTop: 2 }}>
                          Keep local edits and sync this version to your other devices
                        </span>
                      </button>

                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => handleOpenResolveConfirm(c, CONFLICT_RESOLUTION.ACCEPT_REMOTE)}
                        disabled={!isUnlocked || isCurrentResolving}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '8px 10px',
                          borderRadius: 8,
                          textAlign: 'center'
                        }}
                      >
                        <span style={{ fontWeight: 800, fontSize: '0.76rem' }}>
                          {isCurrentResolving ? 'Resolving...' : "☁️ Accept Other Device's Version"}
                        </span>
                        <span style={{ fontSize: '0.64rem', fontWeight: 400, opacity: 0.85, marginTop: 2 }}>
                          Replace this device's version with incoming version and sync it
                        </span>
                      </button>
                    </div>

                    {!isUnlocked && (
                      <div style={{ fontSize: '0.68rem', color: 'var(--warning)', fontWeight: 600 }}>
                        🔒 Unlock the sync session above to resolve this conflict.
                      </div>
                    )}

                    {/* Collapsible Technical Diagnostics */}
                    <details style={{
                      marginTop: 4,
                      padding: '6px 10px',
                      borderRadius: 6,
                      background: 'rgba(0, 0, 0, 0.15)',
                      border: '1px solid var(--border-light)',
                      fontSize: '0.68rem',
                      color: 'var(--text-muted)'
                    }}>
                      <summary style={{ cursor: 'pointer', fontWeight: 700, color: 'var(--text-secondary)' }}>
                        ⚙️ Technical Diagnostics (ID: {formatted.shortEntityId})
                      </summary>
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3, fontFamily: 'monospace', fontSize: '0.65rem' }}>
                        <div><strong>Conflict ID:</strong> {c.conflict_id}</div>
                        <div><strong>Collection:</strong> {c.collection}</div>
                        <div><strong>Entity ID:</strong> {c.entity_id}</div>
                        <div><strong>Conflict Type:</strong> {c.conflict_type}</div>
                        <div><strong>Peer Device ID:</strong> {c.peer_device_id || '—'}</div>
                        <div><strong>Event ID:</strong> {c.event_id || '—'}</div>
                        <div><strong>Package ID:</strong> {c.package_id || '—'}</div>
                        <div><strong>Base Checksum:</strong> {c.base_checksum ? c.base_checksum.slice(0, 16) + '...' : '—'}</div>
                        <div><strong>Local Checksum:</strong> {c.local_checksum ? c.local_checksum.slice(0, 16) + '...' : '—'}</div>
                        <div><strong>Remote Checksum:</strong> {c.remote_checksum ? c.remote_checksum.slice(0, 16) + '...' : '—'}</div>
                      </div>
                    </details>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Preview Results Display */}
        {previewResult && (
          <>
            <div className="settings-group-label" style={{ padding: '8px 0 6px' }}>Sync Preview Results (Dry-Run)</div>
            <div className="settings-card" style={{ padding: 14, margin: '0 0 14px', border: '1px solid var(--green)' }}>
              {/* Safety Badge */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                  Action: <span style={{ color: 'var(--green)' }}>{getFriendlyActionName(previewResult.action)}</span>
                </div>
                <div style={{
                  fontSize: '0.68rem',
                  fontWeight: 800,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: previewResult.safetyStatus === 'PASSED_SAFE' ? 'rgba(0, 229, 160, 0.15)' : 'rgba(255, 77, 106, 0.15)',
                  color: previewResult.safetyStatus === 'PASSED_SAFE' ? 'var(--green)' : 'var(--expense)'
                }}>
                  {previewResult.safetyStatus === 'PASSED_SAFE' ? '🛡️ PASSED SAFE' : '⚠️ MASS DELETION ABORT'}
                </div>
              </div>

              {/* Mass Deletion Warning */}
              {previewResult.safetyStatus === 'SAFETY_ABORT_MASS_DELETION' && (
                <div style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'rgba(255, 77, 106, 0.18)',
                  color: 'var(--expense)',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  marginBottom: 12
                }}>
                  🛑 Safety Guardrail Triggered: The proposed sync contains excessive deletions exceeding the safety threshold ({DELETION_SAFETY_LIMIT_COUNT} or {DELETION_SAFETY_LIMIT_PERCENT * 100}%). Sync execution is blocked to protect your financial records.
                </div>
              )}

              {/* Local Changes Breakdown */}
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Local changes to apply:
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 8,
                background: 'var(--bg-card2)',
                borderRadius: 8,
                padding: 10,
                marginBottom: 12,
                textAlign: 'center'
              }}>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Inserts</div>
                  <div style={{ fontSize: '1rem', fontWeight: 800, color: previewResult.plannedLocalChanges.inserts > 0 ? 'var(--green)' : 'var(--text-primary)' }}>
                    {previewResult.plannedLocalChanges.inserts > 0 ? `+${previewResult.plannedLocalChanges.inserts}` : '0'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Updates</div>
                  <div style={{ fontSize: '1rem', fontWeight: 800, color: previewResult.plannedLocalChanges.updates > 0 ? 'var(--accent)' : 'var(--text-primary)' }}>
                    {previewResult.plannedLocalChanges.updates > 0 ? `~${previewResult.plannedLocalChanges.updates}` : '0'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Deletes</div>
                  <div style={{ fontSize: '1rem', fontWeight: 800, color: previewResult.plannedLocalChanges.deletes > 0 ? 'var(--expense)' : 'var(--text-primary)' }}>
                    {previewResult.plannedLocalChanges.deletes > 0 ? `-${previewResult.plannedLocalChanges.deletes}` : '0'}
                  </div>
                </div>
              </div>

              {/* Entity Breakdown */}
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                <div>• Cloud Snapshot: <strong>{previewResult.cloudCounts.snapshot_exists ? 'Exists in Drive' : 'None (First Initial Sync)'}</strong></div>
                <div>• Cloud Action: <strong>{getFriendlyActionName(previewResult.action)}</strong></div>
                {previewResult.isFirstSync ? (
                  <div>• Dataset to Upload: <strong>{previewResult.localCounts.transactions.toLocaleString()}</strong> transactions, <strong>{previewResult.localCounts.investment_transactions || 0}</strong> trades (1 encrypted snapshot)</div>
                ) : (
                  <div>
                    • Local Entities Inspected: <strong>{previewResult.localCounts.transactions.toLocaleString()}</strong> transactions, <strong>{previewResult.localCounts.investment_transactions || 0}</strong> trades<br />
                    • Cloud Changes: <strong>{previewResult.plannedCloudChanges.inserts}</strong> inserts, <strong>{previewResult.plannedCloudChanges.updates}</strong> updates, <strong>{previewResult.plannedCloudChanges.deletes}</strong> deletes
                  </div>
                )}
                <div>• Conflicts Detected: <strong>{previewResult.conflicts.length}</strong></div>
                <div>• Dry-Run Safety: <strong>0 Local DB Writes, 0 Drive Writes</strong></div>
                {previewResult.diagnostics && typeof previewResult.diagnostics.identityMatchedTransactions === 'number' && (
                  <div>
                    • Identity Reconciliation: <strong>{previewResult.diagnostics.identityMatchedTransactions.toLocaleString()}</strong> transactions, <strong>{previewResult.diagnostics.identityMatchedInvestments || 0}</strong> trades paired (0 duplicate inserts)
                  </div>
                )}
                {previewResult.diagnostics && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 4, opacity: 0.8 }}>
                    ⏱️ Diagnostic Time: {previewResult.diagnostics.totalMs}ms (Download: {previewResult.diagnostics.driveDownloadMs}ms, Reconcile: {previewResult.diagnostics.reconciliationMs}ms, DB: {previewResult.diagnostics.localDbReadMs}ms)
                  </div>
                )}
              </div>

              {/* Conflict Breakdown (Read-Only) */}
              {previewResult.conflicts.length > 0 && (
                <div style={{ marginTop: 14, borderTop: '1px solid var(--border-light)', paddingTop: 10 }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--gold)', marginBottom: 8 }}>
                    ⚠️ Detected Conflicts ({previewResult.conflicts.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 200, overflowY: 'auto' }}>
                    {previewResult.conflicts.map((c, idx) => (
                      <div key={idx} style={{
                        background: 'var(--bg-surface)',
                        padding: '8px 10px',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        fontSize: '0.7rem'
                      }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
                          {c.type} · {c.entityType} ({c.id})
                        </div>
                        {Array.isArray(c.differences) && c.differences.map((d, dIdx) => (
                          <div key={dIdx} style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                            • {d.field}: Local [{String(d.val1)}] vs Cloud [{String(d.val2)}]
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Confirmation Bottom-Sheet Modal */}
      {showConfirmModal && previewResult && (() => {
        const modalConfig = getModalConfirmConfig(previewResult, state.transactions?.length || 0, isSyncing);
        if (!modalConfig) return null;

        return (
          <>
            <div className="dash-popup-overlay" onClick={() => !isSyncing && setShowConfirmModal(false)} style={{ zIndex: 10000 }} />
            <div className="dash-popup-sheet" style={{ zIndex: 10001, padding: '20px 24px calc(var(--safe-bottom) + 20px)' }}>
              <div className="dash-popup-sheet-handle" />
              <div style={{ fontSize: '2.5rem', marginBottom: 8, textAlign: 'center' }}>
                {modalConfig.icon}
              </div>
              <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6, textAlign: 'center' }}>
                {modalConfig.title}
              </div>

              <div style={{
                background: 'rgba(0, 229, 160, 0.08)',
                border: '1px solid rgba(0, 229, 160, 0.25)',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: '0.75rem',
                color: 'var(--text-primary)',
                marginBottom: 16,
                lineHeight: 1.5,
                textAlign: 'center'
              }}>
                <div style={{ fontWeight: 800, color: 'var(--green)', marginBottom: 6, fontSize: '0.82rem' }}>
                  {modalConfig.badge}
                </div>
                <div style={{ color: 'var(--text-primary)', marginBottom: 6 }}>
                  {modalConfig.descriptionText}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  Local changes: {previewResult.plannedLocalChanges?.inserts || 0} inserts, {previewResult.plannedLocalChanges?.updates || 0} updates, {previewResult.plannedLocalChanges?.deletes || 0} deletes.
                </div>
              </div>

              <div style={{ display: 'flex', gap: 12, width: '100%' }}>
                <button
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => setShowConfirmModal(false)}
                  disabled={isSyncing}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  style={{ flex: 1.5, fontWeight: 800 }}
                  onClick={handleExecuteLiveSync}
                  disabled={isSyncing}
                >
                  {modalConfig.buttonLabel}
                </button>
              </div>
            </div>
          </>
        );
      })()}

      {/* Conflict Resolution Confirmation Bottom-Sheet Modal */}
      {confirmResolutionModal && confirmResolutionModal.conflict && (() => {
        const modalConflict = confirmResolutionModal.conflict;
        const modalRes = confirmResolutionModal.resolution;
        const modalFormatted = formatConflictEntity(modalConflict);

        return (
          <>
            <div
              className="dash-popup-overlay"
              onClick={() => !resolvingId && setConfirmResolutionModal(null)}
              style={{ zIndex: 10000 }}
            />
            <div className="dash-popup-sheet" style={{ zIndex: 10001, padding: '20px 24px calc(var(--safe-bottom) + 20px)' }}>
              <div className="dash-popup-sheet-handle" />
              <div style={{ fontSize: '2.5rem', marginBottom: 8, textAlign: 'center' }}>
                ⚖️
              </div>
              <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4, textAlign: 'center' }}>
                Confirm Conflict Resolution
              </div>

              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--accent)', marginBottom: 12, textAlign: 'center' }}>
                {modalFormatted.primaryTitle}
                {modalFormatted.primarySubtitle && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, marginTop: 2 }}>
                    {modalFormatted.primarySubtitle}
                  </div>
                )}
              </div>

              <div style={{
                background: 'rgba(255, 179, 0, 0.08)',
                border: '1px solid rgba(255, 179, 0, 0.25)',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: '0.75rem',
                color: 'var(--text-primary)',
                marginBottom: 16,
                lineHeight: 1.5,
                textAlign: 'center'
              }}>
                <div style={{ fontWeight: 800, color: 'var(--warning)', marginBottom: 6, fontSize: '0.82rem' }}>
                  {modalRes === CONFLICT_RESOLUTION.KEEP_LOCAL
                    ? "📱 You are choosing: This Device's Version"
                    : "☁️ You are choosing: Other Device's Version"}
                </div>
                <div style={{ color: 'var(--text-primary)', marginBottom: 6 }}>
                  {modalRes === CONFLICT_RESOLUTION.KEEP_LOCAL
                    ? 'You are choosing to keep the version on this device. Your other synced devices will receive this version during synchronization.'
                    : 'You are choosing to accept the version from the other device. This device will be updated to match that version during synchronization.'}
                </div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                  Record: {modalFormatted.collectionLabel} (ID: {modalFormatted.shortEntityId})
                </div>
              </div>

              <div style={{ display: 'flex', gap: 12, width: '100%' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => setConfirmResolutionModal(null)}
                  disabled={Boolean(resolvingId)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1.5, fontWeight: 800 }}
                  onClick={handleExecuteConflictResolution}
                  disabled={Boolean(resolvingId)}
                >
                  {resolvingId
                    ? 'Resolving...'
                    : (modalRes === CONFLICT_RESOLUTION.KEEP_LOCAL
                      ? 'Yes, Keep This Version'
                      : 'Yes, Accept Remote Version')}
                </button>
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}
