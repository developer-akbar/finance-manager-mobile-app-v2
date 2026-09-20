import React, { useEffect, useState, useRef, useCallback } from 'react';
import { AppProvider, useApp } from './contexts/AppContext.jsx';
import Layout from './components/Layout/Layout.jsx';
import Dashboard from './components/Dashboard/Dashboard.jsx';
import Transactions from './components/Transactions/Transactions.jsx';
import Accounts from './components/Accounts/Accounts.jsx';
import Categories from './components/Categories/Categories.jsx';
import Analytics from './components/Analytics/Analytics.jsx';
import Settings from './components/Settings/Settings.jsx';
import PinLock from './components/Common/PinLock.jsx';
import AddTransaction from './components/Transactions/AddTransaction.jsx';
import { initDB } from './database/index.js';
import './styles/globals.css';
import './SplashScreen.css';

/**
 * Safe-area injection — runs synchronously before React paints and on orientation changes.
 * Sets data-cap-android attribute so the CSS fallback kicks in immediately,
 * then measures precise inset values across portrait and landscape.
 */
function applyAndroidSafeArea() {
  try {
    if (!window.Capacitor) return;
    if (window.Capacitor.getPlatform?.() !== 'android') return;

    // Apply CSS class immediately
    document.documentElement.setAttribute('data-cap-android', '');

    const updateInsets = () => {
      try {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);bottom:env(safe-area-inset-bottom,0px);left:env(safe-area-inset-left,0px);right:env(safe-area-inset-right,0px);pointer-events:none;opacity:0;';
        document.body.appendChild(probe);
        const rect = probe.getBoundingClientRect();
        document.body.removeChild(probe);

        const topPx = rect.top;
        const bottomFromEdge = window.innerHeight - rect.bottom;
        const leftPx = rect.left;
        const rightFromEdge = window.innerWidth - rect.right;

        // Detect landscape reliably across orientation API and window dimensions
        const isLandscape = window.screen?.orientation?.type
          ? window.screen.orientation.type.includes('landscape')
          : (window.innerWidth > window.innerHeight);

        if (topPx >= 0 && topPx < 120) {
          document.documentElement.style.setProperty(
            '--safe-top',
            topPx > 0 ? topPx + 'px' : (isLandscape ? '24px' : '32px')
          );
        }
        if (bottomFromEdge >= 0 && bottomFromEdge < 140) {
          document.documentElement.style.setProperty(
            '--safe-bottom',
            bottomFromEdge > 0 ? bottomFromEdge + 'px' : '16px'
          );
        }
        if (leftPx >= 0 && leftPx < 120) {
          document.documentElement.style.setProperty(
            '--safe-left',
            leftPx > 0 ? leftPx + 'px' : (isLandscape ? '24px' : '0px')
          );
        }
        if (rightFromEdge >= 0 && rightFromEdge < 120) {
          document.documentElement.style.setProperty(
            '--safe-right',
            rightFromEdge > 0 ? rightFromEdge + 'px' : (isLandscape ? '24px' : '0px')
          );
        }
      } catch { /* keep CSS fallbacks */ }
    };

    requestAnimationFrame(updateInsets);
    window.addEventListener('resize', updateInsets, { passive: true });
    window.addEventListener('orientationchange', () => {
      [50, 150, 300, 500].forEach(delay => setTimeout(updateInsets, delay));
    }, { passive: true });
  } catch { /* silent */ }
}
applyAndroidSafeArea();

// ── Back button logic ─────────────────────────────────────────────────────────
// Rule: very simple two-level model.
// Level 1  = top-level tab (dashboard / transactions / accounts / categories / settings)
// Level 2+ = child screens opened WITHIN a tab (e.g. Account Detail inside Accounts)
//
// Back button:
//   • If Add-modal open   → close modal
//   • If a child-screen is signalled via backInterceptRef → let the tab handle it
//   • If on any tab (not dashboard) → go to dashboard
//   • If on dashboard → minimizeApp (close)
//
// Child screens (AccountDetail, CategoryDetail, Settings sub-screens, etc.) each
// receive an `onBack` prop.  They do NOT call navigate(); instead they manage their
// own local state (drill / screen).  The back button calls the ref callback when set.


// ── Splash screen ─────────────────────────────────────────────────────────────
const SplashScreen = () => (
  <div className="splash-screen">
    <div className="splash-logo-wrap">
      <img src="/icon-xhdpi.png" alt="FinMan" className="splash-logo" />
      <div className="splash-app-name">FinMan</div>
      <div className="splash-tagline">Your Personal Finance Manager</div>
    </div>
    <div className="splash-spinner"/>
  </div>
);

function AppInner() {
  const { state, navigate, processDueRepeat } = useApp();
  const { currentView } = state;

  // ALL hooks must be called unconditionally before any early return
  const [showAdd, setShowAdd]   = useState(false);
  const [addKey,  setAddKey]    = useState(0);
  const [backupDue, setBackupDue] = useState(false);

  // Global viewport & orientation alignment safety
  React.useEffect(() => {
    const handleViewportChange = () => {
      window.scrollTo(0, 0);
      if (document.documentElement.scrollLeft !== 0) document.documentElement.scrollLeft = 0;
      if (document.body.scrollLeft !== 0) document.body.scrollLeft = 0;
      const root = document.getElementById('root');
      if (root && root.scrollLeft !== 0) root.scrollLeft = 0;
      const shell = document.querySelector('.app-shell');
      if (shell && shell.scrollLeft !== 0) shell.scrollLeft = 0;

      // Reset horizontal scroll on all non-table scrollable surfaces
      document.querySelectorAll('.dash-screen, .dash-scrollable-content, .txn-screen, .txn-list-body, .accounts-screen, .accounts-list, .settings-screen, .settings-root, .categories-screen, .categories-list, .layout-body, .layout-screen').forEach(el => {
        if (el && el.scrollLeft !== 0) el.scrollLeft = 0;
      });

      applyAndroidSafeArea();
    };

    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.addEventListener('orientationchange', () => {
      handleViewportChange();
      [50, 150, 300, 500].forEach(delay => setTimeout(handleViewportChange, delay));
    }, { passive: true });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportChange, { passive: true });
    }
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('orientationchange', handleViewportChange);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleViewportChange);
      }
    };
  }, []);

  // Process due repeat transactions on app open
  React.useEffect(() => {
    if (!state.loading) processDueRepeat();
  }, [state.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check if auto backup is due on app load
  React.useEffect(() => {
    const schedule = state.settings?.backupSchedule;
    if (!schedule || schedule === 'off') return;
    const last = state.settings?.lastBackupCheck;
    if (!last) { setBackupDue(true); return; }
    const daysSince = (Date.now() - new Date(last).getTime()) / (1000*60*60*24);
    const threshold = schedule === 'daily' ? 1 : schedule === 'weekly' ? 7 : 30;
    if (daysSince >= threshold) setBackupDue(true);
  }, [state.settings?.backupSchedule, state.settings?.lastBackupCheck]);

  const [toast, setToast] = useState(null);
  const toastTimeoutRef = useRef(null);
  const showToast = useCallback((msg) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToast(msg);
    toastTimeoutRef.current = setTimeout(() => {
      setToast(null);
    }, 2000);
  }, []);

  const handleNavTap = (id) => {
    // Find the scrollable elements in the active view
    const activeEl = document.querySelector('.tab-view.active-tab');
    let wasScrolled = false;
    if (activeEl) {
      const txnList = activeEl.querySelector('.txn-list');
      if (id === 'transactions') {
        wasScrolled = true;
        window.dispatchEvent(new CustomEvent('transactions-nav-tap'));
      } else {
        const scrollables = activeEl.querySelectorAll('.sub-body, .acct-detail-body, .cat-detail-body, .dash-scrollable-content, .settings-root, .accounts-list, .categories-list, .analytics-scrollable-content, .analytics-screen, .txn-monthly-list');
        scrollables.forEach(el => {
          if (el.scrollTop > 10) {
            wasScrolled = true;
            el.scrollTo({ top: 0, behavior: 'smooth' });
          }
        });
      }
    }
    // If already at top and inside deep navigation, return to parent view
    if (!wasScrolled) {
      if (id === 'categories') {
        window.dispatchEvent(new CustomEvent('reset-categories-view'));
      }
      if (id === 'accounts') {
        window.dispatchEvent(new CustomEvent('reset-accounts-view'));
      }
      if (id === 'analytics') {
        window.dispatchEvent(new CustomEvent('reset-analytics-view'));
      }
      if (id === 'settings') {
        window.dispatchEvent(new CustomEvent('reset-settings-view'));
      }
    }
  };

  const backInterceptRef = React.useRef(null);
  const lastBackPressRef = useRef(0);

  // Android hardware back button handler
  useEffect(() => {
    const setup = async () => {
      try {
        const { App: CapApp } = await import('@capacitor/app');
        CapApp.addListener('backButton', () => {
          // 1. If an active screen registered a back-intercept callback, execute it and stop
          if (backInterceptRef.current) {
            backInterceptRef.current();
            return;
          }
          // 2. If AddTransaction modal is open, close it
          if (showAdd) {
            setShowAdd(false);
            return;
          }
          // 3. If on a sub-screen, go to dashboard
          if (currentView !== 'dashboard') {
            navigate('dashboard');
            return;
          }
          // 4. On dashboard root: double-tap within 2s to exit
          const now = Date.now();
          if (now - lastBackPressRef.current < 2000) {
            CapApp.exitApp();
          } else {
            lastBackPressRef.current = now;
            showToast('Press BACK again to exit');
          }
        });
      } catch { /* web */ }
    };
    setup();
    return () => {
      import('@capacitor/app').then(({ App }) => App.removeAllListeners()).catch(() => {});
    };
  }, [currentView, showAdd, navigate, showToast]);

  // Safe to return early here — all hooks have already been called above
  if (state.loading) return <SplashScreen />;

  return (
    <PinLock>
      <Layout onNavTap={handleNavTap}>
        <div className={`tab-view ${currentView === 'dashboard' ? 'active-tab' : 'hidden'}`}>
          <Dashboard onAddTransaction={() => { setShowAdd(true); setAddKey(k => k + 1); }} backInterceptRef={backInterceptRef}/>
        </div>
        <div className={`tab-view ${currentView === 'transactions' ? 'active-tab' : 'hidden'}`}>
          <Transactions isActive={currentView === 'transactions'} onAddTransaction={() => { setShowAdd(true); setAddKey(k => k + 1); }} backInterceptRef={backInterceptRef} viewParams={state.viewParams}/>
        </div>
        <div className={`tab-view ${currentView === 'accounts' ? 'active-tab' : 'hidden'}`}>
          <Accounts backInterceptRef={backInterceptRef}/>
        </div>
        <div className={`tab-view ${currentView === 'categories' ? 'active-tab' : 'hidden'}`}>
          <Categories backInterceptRef={backInterceptRef} viewParams={state.viewParams}/>
        </div>
        <div className={`tab-view ${currentView === 'analytics' ? 'active-tab' : 'hidden'}`}>
          <Analytics backInterceptRef={backInterceptRef}/>
        </div>
        <div className={`tab-view ${currentView === 'settings' ? 'active-tab' : 'hidden'}`}>
          <Settings backInterceptRef={backInterceptRef}/>
        </div>
      </Layout>
      {showAdd && <AddTransaction key={addKey} onClose={() => setShowAdd(false)} onSaveAndContinue={() => {}} backInterceptRef={backInterceptRef}/>}
      {backupDue && (
        <div style={{position:'fixed',bottom:'calc(64px + var(--safe-bottom, 0px) + 8px)',left:12,right:12,background:'var(--bg-card)',border:'1px solid rgba(0,229,160,0.35)',borderRadius:12,padding:'10px 14px',display:'flex',alignItems:'center',gap:10,zIndex:9998,boxShadow:'0 4px 20px rgba(0,0,0,0.4)'}}>
          <span style={{fontSize:'1.2rem'}}>☁️</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:'0.78rem',fontWeight:700,color:'var(--text-primary)'}}>Backup Due</div>
            <div style={{fontSize:'0.65rem',color:'var(--text-muted)'}}>Go to Settings → Data to back up now</div>
          </div>
          <button onClick={() => { navigate('settings'); setBackupDue(false); }} style={{background:'var(--accent)',border:'none',borderRadius:8,color:'var(--text-primary)',fontSize:'0.68rem',fontWeight:700,padding:'5px 10px',cursor:'pointer',flexShrink:0}}>Back up</button>
          <button onClick={() => setBackupDue(false)} style={{background:'none',border:'none',color:'var(--text-muted)',fontSize:'1rem',cursor:'pointer',padding:'0 2px',flexShrink:0}}>✕</button>
        </div>
      )}
      {toast && (
        <div style={{
          position: 'fixed',
          bottom: '100px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(20, 25, 40, 0.95)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          color: '#fff',
          padding: '10px 18px',
          borderRadius: '20px',
          fontSize: '0.78rem',
          fontWeight: 600,
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          zIndex: 99999,
          pointerEvents: 'none',
          letterSpacing: '0.3px'
        }}>
          {toast}
        </div>
      )}
    </PinLock>
  );
}

export default function App() {
  const [ready, setReady] = React.useState(false);
  useEffect(() => { initDB().then(() => setReady(true)).catch(console.error); }, []);
  if (!ready) return <SplashScreen />;
  return <AppProvider><AppInner/></AppProvider>;
}