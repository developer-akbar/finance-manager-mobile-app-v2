import React, { useState, useEffect } from 'react';
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
import { getSetting } from '../../database/settings.js';

function getFriendlyActionName(action) {
  if (action === 'CREATE_INITIAL_SNAPSHOT') return 'Create Initial Cloud Snapshot';
  if (action === 'BOOTSTRAP_FROM_CLOUD') return 'Bootstrap From Cloud Snapshot';
  if (action === 'MERGE_CLEAN') return 'Reconcile & Synchronize';
  if (action === 'MERGE_WITH_CONFLICTS') return 'Reconcile (Review Conflicts)';
  if (action === 'NO_CHANGES') return 'Already Up to Date';
  return action || 'Reconcile';
}

export default function CloudSyncManager({ onBack }) {
  const { state, load } = useApp();

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
  const [operationType, setOperationType] = useState(null); // 'preview' | 'sync_now'
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [previewResult, setPreviewResult] = useState(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Persisted Sync Metadata (Read-Only)
  const [lastSyncInfo, setLastSyncInfo] = useState({
    lastSyncedAt: null,
    lastSnapshotId: null
  });

  // Subscribe to Session Key state changes
  useEffect(() => {
    const unsubscribe = subscribeSyncSession((unlocked) => {
      setIsUnlocked(unlocked);
    });
    return unsubscribe;
  }, []);

  // Load Client ID & Last Sync Info on mount
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
    loadMeta();
    return () => { mounted = false; };
  }, []);

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

      if (syncResult.status === SYNC_STATUS.SUCCESS || syncResult.status === SYNC_STATUS.NO_CHANGES || syncResult.status === BOOTSTRAP_STATUS.SUCCESS) {
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
        setSuccessMsg(
          syncResult.status === BOOTSTRAP_STATUS.SUCCESS
            ? '✓ Successfully bootstrapped database from cloud snapshot!'
            : syncResult.isFirstSync
            ? '✓ Initial cloud snapshot created and verified successfully!'
            : '✓ Sync completed successfully.'
        );
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

        {/* Section 1: Google Account Connection */}
        <div className="settings-group-label" style={{ padding: '8px 0 6px' }}>1. Google Drive Connection</div>
        <div className="settings-card" style={{ padding: 14, margin: '0 0 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: isAuthenticated ? 'var(--green)' : 'var(--text-muted)',
                boxShadow: isAuthenticated ? '0 0 6px var(--green)' : 'none'
              }} />
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {isAuthenticated ? 'Connected to Google Drive' : 'Not Connected'}
                </div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                  {isAuthenticated ? 'Scope: drive.appdata (Sandboxed)' : 'Connect your account to enable sync'}
                </div>
              </div>
            </div>

            {isAuthenticated ? (
              <button
                className="btn btn-ghost"
                onClick={handleDisconnect}
                style={{ fontSize: '0.75rem', color: 'var(--expense)', padding: '4px 10px' }}
              >
                Disconnect
              </button>
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
              ⚠️ {authError}
            </div>
          )}
        </div>

        {/* Section 2: Session Key / PIN Unlock */}
        <div className="settings-group-label" style={{ padding: '8px 0 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>2. Session Encryption Key</span>
          <span style={{ fontSize: '0.72rem', fontWeight: 800, color: isUnlocked ? 'var(--green)' : 'var(--text-muted)' }}>
            {isUnlocked ? '🔓 Sync Ready' : '🔒 Sync Locked'}
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
                  ⚠️ {pinError}
                </div>
              )}
            </>
          )}
        </div>

        {/* Section 3: Sync Actions */}
        <div className="settings-group-label" style={{ padding: '8px 0 6px' }}>3. Sync Operations</div>
        <div className="settings-card" style={{ padding: 14, margin: '0 0 14px' }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <button
              className="btn btn-secondary"
              onClick={handlePreview}
              disabled={isLoading || isSyncing || !isAuthenticated}
              style={{ flex: 1, padding: '10px 14px', fontSize: '0.82rem', fontWeight: 700 }}
            >
              {isLoading && operationType === 'preview' ? 'Inspecting...' : '🔍 Preview Sync'}
            </button>

            <button
              className="btn btn-primary"
              onClick={handleSyncNowClick}
              disabled={isLoading || isSyncing || !isAuthenticated}
              style={{ flex: 1, padding: '10px 14px', fontSize: '0.82rem', fontWeight: 800 }}
            >
              {isLoading && operationType === 'sync_now' ? 'Preparing...' : '⚡ Sync Now'}
            </button>
          </div>

          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
            • <strong>Preview Sync</strong>: Performs a 100% read-only inspection. Zero database changes, zero Drive writes.<br />
            • <strong>Sync Now</strong>: Encrypts and synchronizes your snapshot with Google Drive.
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
              🛑 {errorMsg}
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

        {/* Section 4: Sync Status & History Metadata */}
        <div className="settings-group-label" style={{ padding: '8px 0 6px' }}>4. Metadata &amp; State</div>
        <div className="settings-card" style={{ padding: 14, margin: '0 0 14px', fontSize: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-light)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Local Transactions</span>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{state.transactions.length.toLocaleString()}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-light)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Last Successful Sync</span>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              {lastSyncInfo.lastSyncedAt ? new Date(lastSyncInfo.lastSyncedAt).toLocaleString() : 'Never'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
            <span style={{ color: 'var(--text-muted)' }}>Last Snapshot ID</span>
            <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              {lastSyncInfo.lastSnapshotId || 'None'}
            </span>
          </div>
        </div>

        {/* Section 5: Preview Results Display */}
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
      {showConfirmModal && previewResult && (
        <>
          <div className="dash-popup-overlay" onClick={() => !isSyncing && setShowConfirmModal(false)} style={{ zIndex: 10000 }} />
          <div className="dash-popup-sheet" style={{ zIndex: 10001, padding: '20px 24px calc(var(--safe-bottom) + 20px)' }}>
            <div className="dash-popup-sheet-handle" />
            <div style={{ fontSize: '2.5rem', marginBottom: 8, textAlign: 'center' }}>
              {previewResult.action === 'BOOTSTRAP_FROM_CLOUD' ? '📥' : '⚡'}
            </div>
            <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6, textAlign: 'center' }}>
              {previewResult.action === 'BOOTSTRAP_FROM_CLOUD' ? 'Confirm Device Bootstrap' : 'Confirm Cloud Sync'}
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
                {getFriendlyActionName(previewResult.action)}
              </div>
              <div style={{ color: 'var(--text-primary)', marginBottom: 6 }}>
                {previewResult.action === 'BOOTSTRAP_FROM_CLOUD' ? (
                  <>
                    <strong>{(previewResult.cloudTxnCount || 0).toLocaleString()}</strong> transactions and all financial records will be decrypted from cloud and loaded into your local database.
                  </>
                ) : (
                  <>
                    <strong>{(state.transactions?.length || 0).toLocaleString()}</strong> transactions will be encrypted with your session key and synchronized to your private Google Drive AppData folder.
                  </>
                )}
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
                {isSyncing
                  ? (previewResult.action === 'BOOTSTRAP_FROM_CLOUD' ? 'Bootstrapping...' : 'Syncing snapshot...')
                  : (previewResult.action === 'BOOTSTRAP_FROM_CLOUD' ? '📥 Confirm & Bootstrap' : '🚀 Confirm & Upload')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
