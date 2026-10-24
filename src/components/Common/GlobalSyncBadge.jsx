import React, { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { isGoogleLinked, subscribeGoogleAuth } from '../../services/googleAuth.js';
import { isSyncUnlocked, subscribeSyncSession } from '../../services/syncSession.js';
import { subscribeSyncStatus, getDeltaSyncMetrics, SYNC_STATUS } from '../../services/deltaSyncCoordinator.js';
import { getPendingConflicts } from '../../database/conflicts.js';

/**
 * GlobalSyncBadge
 * Persistent, live Cloud Sync status indicator for header and desktop sidebar.
 * Real-time reactivity across auth, session key unlock, and delta sync cycles.
 */
export default function GlobalSyncBadge({ isCollapsed = false, mobile = false, className = '' }) {
  const { navigate } = useApp?.() || {};

  const [isLinked, setIsLinked] = useState(() => isGoogleLinked());
  const [isUnlocked, setIsUnlocked] = useState(() => isSyncUnlocked());
  const [syncState, setSyncState] = useState({
    status: SYNC_STATUS.IDLE,
    pendingCount: 0,
    latestError: null
  });
  const [conflictCount, setConflictCount] = useState(0);

  useEffect(() => {
    let mounted = true;

    // 1. Auth Subscription
    const unsubAuth = subscribeGoogleAuth((isAuth) => {
      if (mounted) setIsLinked(isAuth || isGoogleLinked());
    });

    // 2. Session Key Subscription
    const unsubSession = subscribeSyncSession((unlocked) => {
      if (mounted) setIsUnlocked(unlocked);
    });

    // 3. Delta Sync Status Subscription
    const unsubSync = subscribeSyncStatus((status, details) => {
      if (!mounted) return;
      setSyncState(prev => ({
        ...prev,
        status: status || prev.status,
        latestError: (status === SYNC_STATUS.SUCCESS || details?.bootstrapped)
          ? null
          : (details?.error || details?.reason || prev.latestError)
      }));

      // Refresh live metrics & conflict count
      getDeltaSyncMetrics().then(m => {
        if (mounted && m) {
          setSyncState(prev => ({
            ...prev,
            pendingCount: m.pendingCount ?? prev.pendingCount,
            status: m.status ?? prev.status,
            lifecycleState: m.lifecycleState ?? prev.lifecycleState,
            latestError: prev.latestError || m.latestError || null
          }));
        }
      }).catch(() => { });

      getPendingConflicts().then(list => {
        if (mounted) setConflictCount(list?.length || 0);
      }).catch(() => { });
    });

    // Initial hydration
    getDeltaSyncMetrics().then(m => {
      if (mounted && m) {
        setSyncState({
          status: m.status || SYNC_STATUS.IDLE,
          pendingCount: m.pendingCount || 0,
          lifecycleState: m.lifecycleState || 'ACTIVE',
          latestError: m.latestError || null
        });
      }
    }).catch(() => { });

    getPendingConflicts().then(list => {
      if (mounted) setConflictCount(list?.length || 0);
    }).catch(() => { });

    return () => {
      mounted = false;
      unsubAuth();
      unsubSession();
      unsubSync();
    };
  }, []);

  const handleClick = (e) => {
    e.stopPropagation();
    if (typeof navigate === 'function') {
      navigate('settings', { screen: 'cloud_sync' });
    }
  };

  // Status mapping
  let config = {
    dotColor: 'var(--text-muted)',
    bgColor: 'rgba(255, 255, 255, 0.04)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    textColor: 'var(--text-muted)',
    icon: '☁️',
    label: 'Cloud Sync Off',
    tooltip: 'Google Drive sync is not connected. Tap to set up.'
  };

  if (!isLinked) {
    config = {
      dotColor: 'var(--text-muted)',
      bgColor: 'rgba(255, 255, 255, 0.04)',
      borderColor: 'rgba(255, 255, 255, 0.08)',
      textColor: 'var(--text-muted)',
      icon: '☁️',
      label: 'Sync Off',
      tooltip: 'Google Drive sync is not connected. Tap to set up.'
    };
  } else if (!isUnlocked) {
    config = {
      dotColor: 'var(--warning, #ffb300)',
      bgColor: 'rgba(255, 179, 0, 0.1)',
      borderColor: 'rgba(255, 179, 0, 0.3)',
      textColor: 'var(--warning, #ffb300)',
      icon: '🔒',
      label: 'Sync Locked',
      tooltip: 'Sync PIN required to unlock encryption. Tap to enter PIN.'
    };
  } else if (conflictCount > 0) {
    config = {
      dotColor: 'var(--warning, #ffb300)',
      bgColor: 'rgba(255, 179, 0, 0.12)',
      borderColor: 'rgba(255, 179, 0, 0.35)',
      textColor: 'var(--warning, #ffb300)',
      icon: '⚠️',
      label: `${conflictCount} Conflict${conflictCount > 1 ? 's' : ''}`,
      tooltip: `${conflictCount} record conflict(s) require review. Tap to resolve.`
    };
  } else if (syncState.lifecycleState === 'JOINING') {
    config = {
      dotColor: 'var(--primary, #00d2ff)',
      bgColor: 'rgba(0, 210, 255, 0.12)',
      borderColor: 'rgba(0, 210, 255, 0.35)',
      textColor: 'var(--primary, #00d2ff)',
      icon: '📥',
      label: 'Setting Up…',
      tooltip: 'Setting up cloud data from backup…'
    };
  } else if (syncState.lifecycleState === 'UNINITIALIZED') {
    config = {
      dotColor: 'var(--text-muted)',
      bgColor: 'rgba(255, 255, 255, 0.04)',
      borderColor: 'rgba(255, 255, 255, 0.08)',
      textColor: 'var(--text-muted)',
      icon: '☁️',
      label: 'Setup Required',
      tooltip: 'Cloud setup required. Tap to set up.'
    };
  } else if (syncState.status === SYNC_STATUS.SYNCING) {
    config = {
      dotColor: 'var(--primary, #00d2ff)',
      bgColor: 'rgba(0, 210, 255, 0.12)',
      borderColor: 'rgba(0, 210, 255, 0.35)',
      textColor: 'var(--primary, #00d2ff)',
      icon: '🔄',
      label: 'Syncing…',
      isSpinning: true,
      tooltip: 'Exchanging updates with Google Drive…'
    };
  } else if (syncState.latestError || syncState.status === SYNC_STATUS.ERROR || syncState.status === SYNC_STATUS.BLOCKED_SEQUENCE_GAP) {
    const isGap = syncState.status === SYNC_STATUS.BLOCKED_SEQUENCE_GAP || String(syncState.latestError || '').includes('SEQUENCE_GAP');
    config = {
      dotColor: 'var(--expense, #ff4d6a)',
      bgColor: 'rgba(255, 77, 106, 0.12)',
      borderColor: 'rgba(255, 77, 106, 0.35)',
      textColor: 'var(--expense, #ff4d6a)',
      icon: isGap ? '⏸️' : '⚠️',
      label: isGap ? 'Sync Paused' : 'Sync Alert',
      tooltip: isGap
        ? 'Sync paused: peer sequence updates pending. Tap for details.'
        : `Sync encountered an issue: ${syncState.latestError || 'Needs attention'}. Tap for details.`
    };
  } else if (syncState.pendingCount > 0) {
    config = {
      dotColor: 'var(--primary, #00d2ff)',
      bgColor: 'rgba(0, 210, 255, 0.08)',
      borderColor: 'rgba(0, 210, 255, 0.25)',
      textColor: 'var(--text-primary)',
      icon: '☁️',
      label: `${syncState.pendingCount} Waiting`,
      tooltip: `${syncState.pendingCount} local changes queued for cloud upload.`
    };
  } else {
    config = {
      dotColor: 'var(--green, #00e5a0)',
      bgColor: 'rgba(0, 229, 160, 0.08)',
      borderColor: 'rgba(0, 229, 160, 0.25)',
      textColor: 'var(--text-primary)',
      icon: '🟢',
      label: 'Synced',
      tooltip: 'All records are up to date across connected devices.'
    };
  }

  function SyncIconSvg({ size = 12, color = 'currentColor' }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: 'block', margin: 'auto' }}
      >
        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
        <path d="M21 21v-5h-5" />
      </svg>
    );
  }

  const renderIcon = (size = 12) => {
    if (config.isSpinning) {
      return (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size,
            height: size,
            animation: 'spin 1.2s linear infinite',
            flexShrink: 0
          }}
        >
          <SyncIconSvg size={size} color={config.textColor || 'currentColor'} />
        </span>
      );
    }
    return (
      <span
        style={{
          display: 'inline-block',
          fontSize: size <= 12 ? '0.74rem' : '0.9rem',
          lineHeight: 1,
          flexShrink: 0
        }}
      >
        {config.icon}
      </span>
    );
  };

  // Mobile Top Header Floating Pill Mode
  if (mobile) {
    return (
      <button
        type="button"
        onClick={handleClick}
        title={config.tooltip}
        aria-label={`Cloud Sync: ${config.label}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 8px',
          borderRadius: 14,
          background: config.bgColor,
          border: `1px solid ${config.borderColor}`,
          color: config.textColor,
          fontSize: '0.68rem',
          fontWeight: 700,
          cursor: 'pointer',
          userSelect: 'none',
          transition: 'all 0.2s ease',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          flexShrink: 0
        }}
        className={`global-sync-badge-mobile ${className}`}
      >
        {renderIcon(11)}
        <span style={{ whiteSpace: 'nowrap' }}>{config.label}</span>
      </button>
    );
  }

  // Desktop Sidebar (Collapsed state)
  if (isCollapsed) {
    return (
      <button
        type="button"
        onClick={handleClick}
        title={`Cloud Sync: ${config.label}\n${config.tooltip}`}
        aria-label={`Cloud Sync: ${config.label}`}
        style={{
          width: 44,
          height: 38,
          borderRadius: 8,
          background: config.bgColor,
          border: `1px solid ${config.borderColor}`,
          color: config.textColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          position: 'relative',
          transition: 'all 0.15s ease',
          margin: '0 auto',
          padding: 0
        }}
        className={`global-sync-badge-collapsed ${className}`}
      >
        {renderIcon(16)}
        <span
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: config.dotColor,
            boxShadow: `0 0 6px ${config.dotColor}`
          }}
        />
      </button>
    );
  }

  // Desktop Sidebar (Expanded state)
  return (
    <button
      type="button"
      onClick={handleClick}
      title={config.tooltip}
      aria-label={`Cloud Sync: ${config.label}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        padding: '7px 10px',
        borderRadius: 8,
        background: config.bgColor,
        border: `1px solid ${config.borderColor}`,
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'all 0.15s ease',
        textAlign: 'left',
        boxSizing: 'border-box'
      }}
      className={`global-sync-badge-expanded ${className}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        {renderIcon(13)}
        <span
          style={{
            fontSize: '0.74rem',
            fontWeight: 700,
            color: 'var(--theme-header-btn-color, var(--text-secondary))',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          Cloud Sync
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: config.dotColor,
            boxShadow: `0 0 6px ${config.dotColor}`
          }}
        />
        <span
          style={{
            fontSize: '0.68rem',
            fontWeight: 800,
            color: config.textColor,
            whiteSpace: 'nowrap'
          }}
        >
          {config.label}
        </span>
      </div>
    </button>
  );
}
