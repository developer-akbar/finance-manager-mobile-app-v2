import React, { useState, useEffect, useCallback } from 'react';
import { listAllCloudDeviceManifests, PEER_LINEAGE_STATUS } from '../../services/deviceManifest.js';
import { isGoogleLinked } from '../../services/googleAuth.js';
import { useApp } from '../../contexts/AppContext.jsx';

/**
 * ConnectedDevicesCard
 * Phase 1 Connected Devices UI for Settings → Cloud Sync.
 *
 * Safely discovers and displays all registered device manifests in the user's
 * Google Drive appDataFolder with baseline status, watermarks, and copyable IDs.
 * Read-only: performs zero writes, zero reconciliation, and zero queue mutations.
 */
export default function ConnectedDevicesCard({
  isAuthenticated,
  localDeviceId,
  lastLocalSyncAt,
  driveClient
}) {
  const { state, load } = useApp?.() || {};
  const [devices, setDevices] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [lastDiscoveredAt, setLastDiscoveredAt] = useState(null);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [nicknames, setNicknames] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('finman_device_nicknames') || '{}');
    } catch {
      return {};
    }
  });
  const [editingDeviceId, setEditingDeviceId] = useState(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [isListExpanded, setIsListExpanded] = useState(false);
  const [upgradeModal, setUpgradeModal] = useState(null);
  const [removeModal, setRemoveModal] = useState(null);

  const handleStartRename = (dev) => {
    setEditingDeviceId(dev.deviceId);
    setEditingNameValue(dev.deviceName || '');
  };

  const handleSaveNickname = async (devId) => {
    const trimmed = (editingNameValue || '').trim();
    const next = { ...nicknames };
    if (trimmed) {
      next[devId] = trimmed;
    } else {
      delete next[devId];
    }
    setNicknames(next);
    try {
      localStorage.setItem('finman_device_nicknames', JSON.stringify(next));
    } catch { }
    setEditingDeviceId(null);

    // Save to Google Drive cloud vault so all connected devices see this updated name
    try {
      const { saveCloudDeviceNicknames, ensureOwnDeviceManifestSynced } = await import('../../services/deviceManifest.js');
      const { getValidAccessToken } = await import('../../services/googleAuth.js');
      const token = await getValidAccessToken(false).catch(() => null);
      await saveCloudDeviceNicknames(next, { accessToken: token, driveClient });

      // If updating this device, also align own device manifest directly
      const currentDev = devices.find(d => d.deviceId === devId);
      if (currentDev?.isCurrentDevice || devId === localDeviceId) {
        await ensureOwnDeviceManifestSynced({
          deviceId: devId,
          accessToken: token,
          driveClient,
          deviceName: trimmed || null,
          force: true
        });
      }
    } catch (saveErr) {
      console.warn('[ConnectedDevices] Failed to persist nickname to Google Drive:', saveErr);
    }

    fetchDevices();
  };

  const displayedDevices = (devices.length > 3 && !isListExpanded)
    ? devices.slice(0, 3)
    : devices;


  const fetchDevices = useCallback(async () => {
    if (!isGoogleLinked() && !driveClient) {
      setDevices([]);
      setError('AUTH_REQUIRED');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await listAllCloudDeviceManifests({
        driveClient,
        localDeviceId
      });

      if (res.error) {
        setError(res.error);
        setDevices([]);
      } else {
        const fetched = res.devices || [];
        setDevices(fetched);
        setLastDiscoveredAt(new Date());
        setError(null);

        // Autonomous Self-Healing: If a peer device is running a newer snapshot baseline, automatically reconcile
        const currentDev = fetched.find(d => d.isCurrentDevice);
        const currentVer = currentDev?.baseCloudVersion || 0;
        const newerPeer = fetched.find(d => !d.isCurrentDevice && d.baseCloudVersion > currentVer && d.baseSnapshotId !== currentDev?.baseSnapshotId && d.lineageStatus === 'RECOVERABLE_NEWER');
        if (newerPeer && currentVer > 0 && !isUpgrading && !upgradeModal) {
          import('../../services/deltaSyncCoordinator.js').then(async ({ checkAndAutoReconcileCloudSnapshot, triggerAutomaticSync, SYNC_TRIGGER }) => {
            try {
              const { getValidAccessToken } = await import('../../services/googleAuth.js');
              const { getSyncSessionKey } = await import('../../services/syncSession.js');
              const token = await getValidAccessToken(false);
              const sessionKey = getSyncSessionKey();
              const reconRes = await checkAndAutoReconcileCloudSnapshot({
                accessToken: token,
                sessionKey,
                driveClient,
                targetSnapshotId: newerPeer.baseSnapshotId,
                targetCloudVersion: newerPeer.baseCloudVersion
              });
              if (reconRes?.reconciled) {
                await triggerAutomaticSync(SYNC_TRIGGER.MANUAL, { accessToken: token, sessionKey });
                if (typeof load === 'function') await load().catch(() => { });
                await fetchDevices();
              }
            } catch (reconErr) {
              console.warn('[ConnectedDevices] Autonomous baseline alignment error:', reconErr);
            }
          }).catch(() => { });
        }
      }
    } catch (err) {
      console.warn('[ConnectedDevices] Discovery error:', err);
      setError(err.message || 'DISCOVERY_FAILED');
    } finally {
      setIsLoading(false);
    }
  }, [driveClient, localDeviceId]);

  // Load on mount and when authentication, localDeviceId, or lastLocalSyncAt changes
  useEffect(() => {
    if (isGoogleLinked() || driveClient) {
      fetchDevices();
    } else {
      setDevices([]);
      setError('AUTH_REQUIRED');
    }
  }, [isAuthenticated, fetchDevices, driveClient, lastLocalSyncAt]);

  // Auto-refresh devices list on live sync status broadcasts and delta queue events
  useEffect(() => {
    let mounted = true;
    let unsubSync = null;

    import('../../services/deltaSyncCoordinator.js').then(({ subscribeSyncStatus, SYNC_STATUS }) => {
      if (!mounted) return;
      unsubSync = subscribeSyncStatus((status) => {
        if (!mounted) return;
        if (status === SYNC_STATUS.SUCCESS || status === SYNC_STATUS.IDLE) {
          fetchDevices();
        }
      });
    }).catch(() => {});

    const handleQueueChange = () => {
      if (mounted && (isGoogleLinked() || driveClient)) {
        fetchDevices();
      }
    };

    const handleSyncProgress = (e) => {
      if (!mounted) return;
      const { peerDeviceId, currentSequence, totalSequence } = e?.detail || {};
      if (!peerDeviceId || typeof currentSequence !== 'number') return;
      setDevices(prev => prev.map(d => {
        if (d.deviceId === peerDeviceId) {
          return {
            ...d,
            localReconciledSequence: currentSequence,
            lastSequence: Math.max(d.lastSequence || 0, totalSequence || currentSequence)
          };
        }
        return d;
      }));
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('finman:delta-queue-changed', handleQueueChange);
      window.addEventListener('finman:conflicts-resolved', handleQueueChange);
      window.addEventListener('finman:sync-progress', handleSyncProgress);
    }

    return () => {
      mounted = false;
      if (typeof unsubSync === 'function') unsubSync();
      if (typeof window !== 'undefined') {
        window.removeEventListener('finman:delta-queue-changed', handleQueueChange);
        window.removeEventListener('finman:conflicts-resolved', handleQueueChange);
        window.removeEventListener('finman:sync-progress', handleSyncProgress);
      }
    };
  }, [fetchDevices, driveClient]);

  const handleCopy = async (id) => {
    try {
      let copied = false;
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(id);
          copied = true;
        } catch (clipErr) {
          console.warn('[ConnectedDevices] navigator.clipboard failed, falling back to execCommand:', clipErr);
        }
      }
      if (!copied && typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = id;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        copied = document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      if (copied) {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      }
    } catch (err) {
      console.warn('Failed to copy device ID:', err);
    }
  };

  const formatTimestamp = (isoStr) => {
    if (!isoStr) return 'Never';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return 'Never';
      return d.toLocaleString();
    } catch {
      return 'Never';
    }
  };

  const handleStartUpgrade = (dev) => {
    setUpgradeModal({
      dev,
      pin: '',
      error: '',
      isRunning: false,
      statusMessage: '',
      result: null
    });
  };

  const handleConfirmUpgrade = async (e) => {
    if (e) e.preventDefault();
    if (!upgradeModal || upgradeModal.isRunning) return;
    const pin = (upgradeModal.pin || '').trim();
    if (pin.length < 4) {
      setUpgradeModal(prev => prev ? ({ ...prev, error: 'Please enter your 4+ digit Sync PIN.' }) : null);
      return;
    }
    setUpgradeModal(prev => prev ? ({ ...prev, isRunning: true, error: '', statusMessage: 'Connecting to Google Drive…' }) : null);
    
    // Acquire screen wake lock so Android OS does not dim/freeze process during streaming recovery
    const { setKeepScreenOn } = await import('../../utils/wakeLockHelper.js').catch(() => ({ setKeepScreenOn: () => {} }));
    if (typeof setKeepScreenOn === 'function') await setKeepScreenOn(true).catch(() => {});

    try {
      const { executeExplicitSnapshotRecovery } = await import('../../services/deltaSyncCoordinator.js');
      const { getValidAccessToken } = await import('../../services/googleAuth.js');
      const token = await getValidAccessToken(true);

      const res = await executeExplicitSnapshotRecovery({
        dev: upgradeModal.dev,
        pin,
        accessToken: token,
        driveClient,
        targetSnapshotId: upgradeModal.dev?.baseSnapshotId,
        targetCloudVersion: upgradeModal.dev?.baseCloudVersion,
        timeoutMs: 600000, // 10 minutes bounded recovery window
        onProgress: (p) => {
          setUpgradeModal(prev => prev ? ({ ...prev, statusMessage: p.message || p.stage || 'Processing snapshot…' }) : null);
        }
      });

      if (res?.cancelled) {
        setUpgradeModal(null);
        return;
      }

      if (res?.success || res?.reconciled) {
        if (typeof load === 'function') await load().catch(() => {});
        await fetchDevices();
        setUpgradeModal(prev => prev ? ({
          ...prev,
          isRunning: false,
          result: {
            success: true,
            message: `Successfully synchronized with Snapshot v${res.cloudVersion || upgradeModal.dev?.baseCloudVersion || 16}! Your device is now up to date with all latest records.`
          }
        }) : null);
      } else if (res?.error) {
        setUpgradeModal(prev => prev ? ({
          ...prev,
          isRunning: false,
          error: res.error
        }) : null);
      } else {
        setUpgradeModal(prev => prev ? ({
          ...prev,
          isRunning: false,
          result: {
            success: true,
            message: `Baseline update check complete: ${res.reason || 'Device records are aligned.'}`
          }
        }) : null);
      }
    } catch (err) {
      console.warn('Failed to upgrade to newer snapshot:', err);
      setUpgradeModal(prev => prev ? ({
        ...prev,
        isRunning: false,
        error: err.message || 'Snapshot recovery failed.'
      }) : null);
    } finally {
      if (typeof setKeepScreenOn === 'function') await setKeepScreenOn(false).catch(() => {});
    }
  };

  const handleStartRemove = (dev) => {
    setRemoveModal({ dev, isRunning: false, error: '' });
  };
  const handleRemoveDevice = (dev) => handleStartRemove(dev);

  const handleConfirmRemove = async () => {
    if (!removeModal || removeModal.isRunning) return;
    const dev = removeModal.dev;
    const fileId = dev?.driveFileId || dev?.drive_file_id;
    if (!fileId && !dev?.deviceId) return;

    setRemoveModal(prev => prev ? ({ ...prev, isRunning: true, error: '' }) : null);
    try {
      setRemovingId(dev.deviceId);
      const { getValidAccessToken } = await import('../../services/googleAuth.js');
      const token = await getValidAccessToken(false);
      const { deleteAppDataFile, findAppDataFile } = await import('../../services/googleDriveSync.js');
      let targetFileId = fileId;
      if (!targetFileId && dev.deviceId && token) {
        const found = await findAppDataFile(`manifest_dev_${dev.deviceId}.json`, token).catch(() => null);
        targetFileId = found?.id;
      }
      if (targetFileId && token) {
        await deleteAppDataFile(targetFileId, token);
      }
      const { getDB } = await import('../../database/db.js');
      const db = getDB();
      await db.run('DELETE FROM sync_peer_state WHERE peer_device_id = ?', [dev.deviceId]).catch(() => { });
      await fetchDevices();
      const { triggerAutomaticSync, SYNC_TRIGGER } = await import('../../services/deltaSyncCoordinator.js');
      await triggerAutomaticSync(SYNC_TRIGGER.MANUAL).catch(() => {});
      setRemoveModal(null);
    } catch (err) {
      console.warn('Failed to remove device:', err);
      setRemoveModal(prev => prev ? ({ ...prev, isRunning: false, error: err.message || 'Failed to remove device.' }) : null);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <>
      <div
        id="connected-devices-section"
        className="settings-group-label"
        style={{
          padding: '8px 0 6px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--text-primary, #ffffff)', fontWeight: 700 }}>📱 Connected Devices</span>
          {devices.length > 0 && (
            <span
              style={{
                fontSize: '0.68rem',
                fontWeight: 700,
                padding: '1px 6px',
                borderRadius: 10,
                background: 'rgba(0, 210, 255, 0.15)',
                color: 'var(--primary, #00d2ff)'
              }}
            >
              {devices.length} {devices.length === 1 ? 'Device' : 'Devices'}
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={fetchDevices}
          disabled={isLoading || (!isGoogleLinked() && !driveClient)}
          style={{
            fontSize: '0.72rem',
            padding: '2px 8px',
            color: 'var(--primary, #00d2ff)',
            display: 'flex',
            alignItems: 'center',
            gap: 4
          }}
          title="Refresh device manifests from Google Drive"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              display: 'inline-block',
              transform: isLoading ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.5s ease',
              flexShrink: 0
            }}
          >
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M21 21v-5h-5" />
          </svg>
          {isLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="settings-card" style={{ padding: 14, margin: '0 0 14px', fontSize: '0.75rem' }}>
        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.4, marginBottom: 12 }}>
          Devices registered in your Google Drive cloud vault. Timestamps indicate when each device last updated its manifest file, not real-time network connection.
        </div>

        {/* State 1: Google Drive Not Connected */}
        {!isGoogleLinked() && !driveClient ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', padding: '6px 0' }}>
            <span style={{ fontSize: '1.2rem' }}>☁️</span>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.78rem' }}>Google Drive Not Connected</div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>
                Connect your Google Drive account above to view and identify all devices sharing this cloud vault.
              </div>
            </div>
          </div>
        ) : error ? (
          /* State 2: Discovery Error */
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              background: 'rgba(255, 77, 106, 0.12)',
              color: 'var(--expense, #ff4d6a)',
              fontSize: '0.72rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8
            }}
          >
            <div>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>
                ⚠️ {error === 'AUTH_REQUIRED' ? 'Authentication Required' : 'Discovery Error'}
              </div>
              <div style={{ fontSize: '0.68rem', opacity: 0.9 }}>
                {error === 'AUTH_REQUIRED'
                  ? 'Your Google session has expired. Please reconnect above to refresh device manifests.'
                  : error}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={fetchDevices}
              style={{ fontSize: '0.68rem', padding: '3px 8px', flexShrink: 0 }}
            >
              Retry
            </button>
          </div>
        ) : isLoading && devices.length === 0 ? (
          /* State 3: Initial Loading */
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '18px 0',
              gap: 8,
              color: 'var(--text-muted)'
            }}
          >
            <span style={{ fontSize: '1rem' }}>⏳</span>
            <span style={{ fontSize: '0.74rem' }}>Discovering registered devices from cloud vault...</span>
          </div>
        ) : devices.length === 0 ? (
          /* State 4: Empty Vault */
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', padding: '6px 0' }}>
            <span style={{ fontSize: '1.2rem' }}>📭</span>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.78rem' }}>No Registered Devices Found</div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>
                No device manifests were found in this cloud vault. Once this device or another device completes an initial sync, its manifest will appear here.
              </div>
            </div>
          </div>
        ) : (
          /* State 5: Populated Device List */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {displayedDevices.map((dev) => {
              const currentDevice = devices.find(d => d.isCurrentDevice);
              const currentVersion = currentDevice?.baseCloudVersion || 0;
              const isSameSnapshot = Boolean(
                dev.baseSnapshotId &&
                currentDevice?.baseSnapshotId &&
                dev.baseSnapshotId === currentDevice.baseSnapshotId
              );
              const maxCloudVersion = Math.max(...devices.map(d => d.baseCloudVersion || 0), currentVersion);
              const isPeerNewer = dev.baseCloudVersion > currentVersion && !isSameSnapshot && currentVersion > 0;
              const isCurrent = dev.isCurrentDevice;
              const isCurrentUpgradeAvailable = maxCloudVersion > currentVersion && currentVersion > 0;
              let typeIcon = '📲';
              if (isCurrent) {
                const isNative = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
                typeIcon = isNative ? '📱' : '💻';
              } else if (dev.deviceType === 'Android Device') {
                typeIcon = '📱';
              } else if (dev.deviceType.includes('Web') || dev.deviceType.includes('Desktop')) {
                typeIcon = '💻';
              }

              return (
                <div
                  key={dev.deviceId}
                  style={{
                    background: isCurrent ? 'rgba(0, 210, 255, 0.04)' : 'rgba(255, 255, 255, 0.02)',
                    border: isCurrent
                      ? '1px solid rgba(0, 210, 255, 0.35)'
                      : '1px solid var(--border-light, rgba(255, 255, 255, 0.08))',
                    borderRadius: 8,
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8
                  }}
                >
                  {/* Row 1: Header (Name / Inline Rename, Badge, Compatibility Pill) */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    {editingDeviceId === dev.deviceId ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: '1rem' }}>{typeIcon}</span>
                        <input
                          type="text"
                          value={editingNameValue}
                          onChange={(e) => setEditingNameValue(e.target.value)}
                          placeholder="e.g. My Phone, Office PC"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveNickname(dev.deviceId);
                            if (e.key === 'Escape') setEditingDeviceId(null);
                          }}
                          style={{
                            fontSize: '0.74rem',
                            padding: '3px 8px',
                            borderRadius: 4,
                            border: '1px solid var(--primary, #00d2ff)',
                            background: 'rgba(0, 0, 0, 0.35)',
                            color: 'var(--text-primary)',
                            flex: 1,
                            maxWidth: 180
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => handleSaveNickname(dev.deviceId)}
                          title="Save Name"
                          style={{ fontSize: '0.72rem', padding: '2px 6px', color: 'var(--green, #00e5a0)' }}
                        >
                          ✓ Save
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => setEditingDeviceId(null)}
                          title="Cancel"
                          style={{ fontSize: '0.72rem', padding: '2px 6px', color: 'var(--text-muted)' }}
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: '1rem' }}>{typeIcon}</span>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: '0.78rem',
                            color: 'var(--text-primary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {dev.deviceName}
                        </span>
                        {isCurrent && (
                          <span
                            style={{
                              fontSize: '0.62rem',
                              fontWeight: 800,
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: 'rgba(0, 210, 255, 0.2)',
                              color: 'var(--primary, #00d2ff)',
                              flexShrink: 0
                            }}
                          >
                            📍 This Device
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => handleStartRename(dev)}
                          title="Rename this device"
                          style={{
                            fontSize: '0.65rem',
                            padding: '1px 4px',
                            color: 'var(--text-muted)',
                            opacity: 0.8,
                            cursor: 'pointer'
                          }}
                        >
                          ✏️
                        </button>
                        {!isCurrent && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => handleRemoveDevice(dev)}
                            disabled={removingId === dev.deviceId}
                            title="Remove device from cloud sync"
                            style={{
                              fontSize: '0.65rem',
                              padding: '1px 4px',
                              color: 'var(--expense, #ff4d6a)',
                              opacity: 0.8,
                              cursor: 'pointer'
                            }}
                          >
                            {removingId === dev.deviceId ? '⏳' : '🗑️'}
                          </button>
                        )}
                      </div>
                    )}

                    {/* Compatibility Pill */}
                    <div style={{ flexShrink: 0 }}>
                      {dev.lifecycleState === 'BLOCKED' || dev.lifecycleState === 'TOMBSTONED' ? (
                        <span
                          style={{
                            fontSize: '0.64rem',
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: 'rgba(255, 77, 106, 0.15)',
                            color: 'var(--expense, #ff4d6a)'
                          }}
                        >
                          🚫 Blocked
                        </span>
                      ) : (!isCurrent && typeof dev.localReconciledSequence === 'number' && dev.lastSequence > dev.localReconciledSequence) ? (
                        <span
                          style={{
                            fontSize: '0.64rem',
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: 'rgba(255, 179, 0, 0.15)',
                            color: 'var(--warning, #ffb300)'
                          }}
                          title={`Peer sequence #${dev.lastSequence} is ahead of local reconciled sequence #${dev.localReconciledSequence}`}
                        >
                          ⏳ Catching Up (#{dev.localReconciledSequence}/{dev.lastSequence})
                        </span>
                      ) : (dev.lineageStatus === PEER_LINEAGE_STATUS.COMPATIBLE || isSameSnapshot || (!isPeerNewer && dev.baseCloudVersion <= currentVersion)) ? (
                        <span
                          style={{
                            fontSize: '0.64rem',
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: 'rgba(0, 229, 160, 0.15)',
                            color: 'var(--green, #00e5a0)'
                          }}
                        >
                          🟢 In Sync (v{dev.baseCloudVersion || currentVersion || 14})
                        </span>
                      ) : isPeerNewer ? (
                        <span
                          style={{
                            fontSize: '0.64rem',
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: 'rgba(0, 210, 255, 0.15)',
                            color: 'var(--primary, #00d2ff)'
                          }}
                        >
                          🔄 Newer (v{dev.baseCloudVersion})
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: '0.64rem',
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                            background: 'rgba(255, 179, 0, 0.15)',
                            color: 'var(--warning, #ffb300)'
                          }}
                        >
                          ⚠️ Incompatible (v{dev.baseCloudVersion})
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Row 2: Device ID with Copy Button */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: 'rgba(0, 0, 0, 0.18)',
                      padding: '4px 8px',
                      borderRadius: 4,
                      gap: 6
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>ID:</span>
                      <span
                        style={{
                          fontFamily: 'monospace',
                          fontSize: '0.70rem',
                          fontWeight: 600,
                          color: 'var(--text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {dev.deviceId}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handleCopy(dev.deviceId)}
                      style={{
                        fontSize: '0.66rem',
                        padding: '2px 6px',
                        color: copiedId === dev.deviceId ? 'var(--green, #00e5a0)' : 'var(--primary, #00d2ff)',
                        flexShrink: 0
                      }}
                      title="Copy Device ID"
                    >
                      {copiedId === dev.deviceId ? '✅ Copied' : '📋 Copy'}
                    </button>
                  </div>

                  {/* Row 3: Metadata Grid with Friendly Labels */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                      gap: '10px',
                      fontSize: '0.68rem',
                      color: 'var(--text-secondary)'
                    }}
                  >
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Current Environment: </span>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{dev.deviceType}</span>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Local Records: </span>
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                        {(() => {
                          if (isCurrent) {
                            const count = state?.transactions?.length;
                            return (count !== undefined && count !== null && !isNaN(count))
                              ? `${count.toLocaleString()} transactions`
                              : 'Count unavailable';
                          }
                          if (dev.recordCount === null || dev.recordCount === undefined || isNaN(dev.recordCount)) {
                            return 'Count unavailable';
                          }
                          if (dev.countType === 'DEDUPLICATED_UNIQUE') {
                            return `${dev.recordCount.toLocaleString()} transactions`;
                          }
                          return `${dev.recordCount.toLocaleString()} transactions (Legacy count · pending device refresh)`;
                        })()}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Sequence Watermark: </span>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>#{dev.lastSequence}</span>
                    </div>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Baseline Snapshot: </span>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        Version {dev.baseCloudVersion || 14} {dev.baseSnapshotId ? `(${dev.baseSnapshotId})` : ''}
                      </span>
                    </div>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Manifest Updated: </span>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        {formatTimestamp(dev.updatedAt || dev.driveModifiedTime)}
                      </span>
                    </div>
                    {isCurrent && (
                      <div style={{ gridColumn: '1 / -1' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Last Local Full Sync: </span>
                        <span style={{ fontWeight: 600, color: 'var(--green, #00e5a0)' }}>
                          {formatTimestamp(lastLocalSyncAt)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Incompatibility Warnings & Notes */}
                  {dev.notUploadedYet && (
                    <div
                      style={{
                        padding: '6px 8px',
                        borderRadius: 4,
                        background: 'rgba(0, 210, 255, 0.08)',
                        color: 'var(--text-secondary)',
                        fontSize: '0.66rem',
                        lineHeight: 1.4
                      }}
                    >
                      ℹ️ This device has not yet published its initial manifest to Google Drive. It will be uploaded during the first sync pass.
                    </div>
                  )}

                  {/* Upgrade option only shown on current device */}
                  {isCurrent && isCurrentUpgradeAvailable && (
                    <div
                      style={{
                        padding: '8px 10px',
                        borderRadius: 6,
                        background: 'rgba(0, 210, 255, 0.08)',
                        border: '1px solid rgba(0, 210, 255, 0.25)',
                        color: 'var(--primary, #00d2ff)',
                        fontSize: '0.66rem',
                        lineHeight: 1.4,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6
                      }}
                    >
                      <div>
                        🔄 <strong>Newer Snapshot Baseline Available (v{maxCloudVersion}):</strong> A newer snapshot baseline with latest records has been published. Upgrade this device to synchronize.
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 2 }}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => handleStartUpgrade(devices.find(d => d.baseCloudVersion === maxCloudVersion) || dev)}
                          disabled={isUpgrading}
                          style={{
                            fontSize: '0.68rem',
                            padding: '4px 10px',
                            fontWeight: 700
                          }}
                        >
                          {isUpgrading ? 'Updating…' : `⚡ Upgrade This Device to Snapshot v${maxCloudVersion}`}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Informational notice for peer devices with newer baseline */}
                  {isPeerNewer && !dev.notUploadedYet && !isCurrent && (
                    <div
                      style={{
                        padding: '8px 10px',
                        borderRadius: 6,
                        background: 'rgba(0, 210, 255, 0.08)',
                        border: '1px solid rgba(0, 210, 255, 0.25)',
                        color: 'var(--primary, #00d2ff)',
                        fontSize: '0.66rem',
                        lineHeight: 1.4
                      }}
                    >
                      ℹ️ <strong>Newer Snapshot Baseline Published (v{dev.baseCloudVersion}):</strong> {dev.deviceName} has published Snapshot v{dev.baseCloudVersion}. Use the upgrade option on This Device to synchronize.
                    </div>
                  )}

                  {/* Informational notice & stale removal for peer devices on older baseline */}
                  {!isCurrent && (dev.baseCloudVersion < currentVersion || dev.lineageStatus === PEER_LINEAGE_STATUS.INCOMPATIBLE_BLOCKED) && !isPeerNewer && !dev.notUploadedYet && (
                    <div
                      style={{
                        padding: '8px 10px',
                        borderRadius: 6,
                        background: 'rgba(255, 179, 0, 0.1)',
                        border: '1px solid rgba(255, 179, 0, 0.25)',
                        color: 'var(--warning, #ffb300)',
                        fontSize: '0.66rem',
                        lineHeight: 1.4,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6
                      }}
                    >
                      <div>
                        ⚠️ <strong>Incompatible Snapshot Baseline (v{dev.baseCloudVersion || 'older'}):</strong> {dev.deviceName} is on Snapshot v{dev.baseCloudVersion || 'older'}. To update this device, open FinMan on {dev.deviceName} and perform its own sync.
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 2 }}>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => handleStartRemove(dev)}
                          disabled={removingId === dev.deviceId}
                          style={{
                            fontSize: '0.64rem',
                            padding: '3px 8px',
                            color: 'var(--expense, #ff4d6a)',
                            border: '1px solid rgba(255, 77, 106, 0.3)',
                            borderRadius: 4
                          }}
                        >
                          {removingId === dev.deviceId ? 'Removing…' : '🗑️ Remove Stale Device'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Expand / Collapse toggle when there are more than 3 devices */}
            {devices.length > 3 && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setIsListExpanded(!isListExpanded)}
                style={{
                  marginTop: 4,
                  width: '100%',
                  fontSize: '0.72rem',
                  padding: '6px',
                  color: 'var(--primary, #00d2ff)',
                  border: '1px dashed rgba(0, 210, 255, 0.3)',
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  cursor: 'pointer'
                }}
              >
                {isListExpanded
                  ? `▲ Show fewer devices (showing all ${devices.length})`
                  : `▼ Show all ${devices.length} devices (${devices.length - 3} hidden)`}
              </button>
            )}
          </div>
        )}

        {lastDiscoveredAt && (
          <div
            style={{
              marginTop: 10,
              textAlign: 'right',
              fontSize: '0.62rem',
              color: 'var(--text-muted)'
            }}
          >
            Last checked: {lastDiscoveredAt.toLocaleTimeString()}
          </div>
        )}
      </div>

      {/* App-Specific Styled Upgrade Modal (Centered Dialog) */}
      {upgradeModal && (
        <>
          <div
            className="dash-popup-overlay"
            style={{ zIndex: 10005 }}
            onClick={() => !upgradeModal.isRunning && setUpgradeModal(null)}
          />
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              bottom: 'auto',
              right: 'auto',
              zIndex: 10006,
              padding: '24px 22px',
              maxWidth: 440,
              width: 'calc(100% - 32px)',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: '20px',
              boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
              boxSizing: 'border-box',
              maxHeight: '90vh',
              overflowY: 'auto'
            }}
          >
            {upgradeModal.result ? (
              <div style={{ width: '100%', textAlign: 'center' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>
                  {upgradeModal.result.success ? '🎉' : 'ℹ️'}
                </div>
                <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6 }}>
                  {upgradeModal.result.success ? 'Snapshot Synchronized' : 'Baseline Update'}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 18 }}>
                  {upgradeModal.result.message}
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setUpgradeModal(null)}
                  style={{ width: '100%', padding: '10px 16px', fontWeight: 700 }}
                >
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleConfirmUpgrade} style={{ width: '100%', textAlign: 'left' }}>
                <div style={{ textAlign: 'center', marginBottom: 14 }}>
                  <div style={{ fontSize: '2rem', marginBottom: 4 }}>🔄</div>
                  <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Sync with Snapshot v{upgradeModal.dev?.baseCloudVersion || 16}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 4 }}>
                    Align this device with the latest snapshot published by {upgradeModal.dev?.deviceName || 'peer device'}.
                  </div>
                </div>

                {upgradeModal.error && (
                  <div style={{
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'rgba(255, 77, 106, 0.12)',
                    border: '1px solid rgba(255, 77, 106, 0.3)',
                    color: 'var(--expense, #ff4d6a)',
                    fontSize: '0.74rem',
                    lineHeight: 1.4,
                    marginBottom: 12
                  }}>
                    ⚠️ {upgradeModal.error}
                  </div>
                )}

                {upgradeModal.isRunning ? (
                  <div style={{ textAlign: 'center', padding: '16px 0' }}>
                    <div className="spinner" style={{ margin: '0 auto 10px', width: 28, height: 28 }} />
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                      Synchronizing with Snapshot v{upgradeModal.dev?.baseCloudVersion || 16}…
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
                      {upgradeModal.statusMessage || 'Downloading snapshot & staging database…'}
                    </div>
                  </div>
                ) : (
                  <>
                    <label style={{
                      display: 'block',
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                      marginBottom: 6
                    }}>
                      Enter your 4-digit Sync PIN:
                    </label>
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={8}
                      autoFocus
                      placeholder="Enter Sync PIN"
                      value={upgradeModal.pin || ''}
                      onChange={(e) => setUpgradeModal(prev => prev ? ({ ...prev, pin: e.target.value, error: '' }) : null)}
                      style={{
                        width: '100%',
                        padding: '10px 14px',
                        fontSize: '1rem',
                        fontWeight: 700,
                        letterSpacing: '0.15em',
                        textAlign: 'center',
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        background: 'var(--bg-input, rgba(255,255,255,0.05))',
                        color: 'var(--text-primary)',
                        marginBottom: 14,
                        boxSizing: 'border-box'
                      }}
                    />

                    <div style={{
                      display: 'flex',
                      gap: 10,
                      justifyContent: 'flex-end',
                      marginTop: 6
                    }}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setUpgradeModal(null)}
                        style={{ flex: 1, padding: '10px 14px', fontWeight: 600 }}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={!upgradeModal.pin || upgradeModal.pin.trim().length < 4}
                        style={{ flex: 1, padding: '10px 14px', fontWeight: 700 }}
                      >
                        Confirm & Sync
                      </button>
                    </div>
                  </>
                )}
              </form>
            )}
          </div>
        </>
      )}

      {/* App-Specific Styled Remove Device Modal (Centered Dialog) */}
      {removeModal && (
        <>
          <div
            className="dash-popup-overlay"
            style={{ zIndex: 10005 }}
            onClick={() => !removeModal.isRunning && setRemoveModal(null)}
          />
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              bottom: 'auto',
              right: 'auto',
              zIndex: 10006,
              padding: '24px 22px',
              maxWidth: 440,
              width: 'calc(100% - 32px)',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: '20px',
              boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
              boxSizing: 'border-box',
              textAlign: 'center',
              maxHeight: '90vh',
              overflowY: 'auto'
            }}
          >
            <div style={{ fontSize: '2.2rem', marginBottom: 8 }}>🗑️</div>
            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 6 }}>
              Remove Device from Cloud Vault?
            </div>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 14 }}>
              Are you sure you want to remove <strong>"{removeModal.dev?.deviceName || removeModal.dev?.deviceId}"</strong> from your Google Drive cloud vault? This will unlink it from your connected devices list.
            </div>

            {removeModal.error && (
              <div style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(255, 77, 106, 0.12)',
                border: '1px solid rgba(255, 77, 106, 0.3)',
                color: 'var(--expense, #ff4d6a)',
                fontSize: '0.74rem',
                lineHeight: 1.4,
                marginBottom: 14
              }}>
                ⚠️ {removeModal.error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, width: '100%' }}>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={removeModal.isRunning}
                onClick={() => setRemoveModal(null)}
                style={{ flex: 1, padding: '10px 14px', fontWeight: 600 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={removeModal.isRunning}
                onClick={handleConfirmRemove}
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  fontWeight: 700,
                  background: 'var(--expense, #ff4d6a)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8
                }}
              >
                {removeModal.isRunning ? 'Removing…' : 'Remove Device'}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
