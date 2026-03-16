import React, { useEffect, useState } from 'react';
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

/**
 * Safe-area injection — runs synchronously before React paints.
 * Sets data-cap-android attribute so the CSS fallback kicks in immediately,
 * then tries to measure a more precise value.
 */
function applyAndroidSafeArea() {
  try {
    if (!window.Capacitor) return;
    if (window.Capacitor.getPlatform?.() !== 'android') return;

    // Apply CSS class immediately — gives 36px top / 56px bottom fallback via CSS
    document.documentElement.setAttribute('data-cap-android', '');

    // After paint, probe env() values for precise measurement
    requestAnimationFrame(() => {
      try {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);left:0;right:0;height:1px;pointer-events:none;opacity:0;';
        document.body.appendChild(probe);
        const topPx = probe.getBoundingClientRect().top;
        document.body.removeChild(probe);

        // Probe for bottom inset
        const probe2 = document.createElement('div');
        probe2.style.cssText = 'position:fixed;bottom:env(safe-area-inset-bottom,0px);left:0;right:0;height:1px;pointer-events:none;opacity:0;';
        document.body.appendChild(probe2);
        const bottomFromEdge = window.innerHeight - probe2.getBoundingClientRect().bottom;
        document.body.removeChild(probe2);

        if (topPx > 4 && topPx < 80)
          document.documentElement.style.setProperty('--safe-top', topPx + 'px');
        if (bottomFromEdge > 4 && bottomFromEdge < 120)
          document.documentElement.style.setProperty('--safe-bottom', bottomFromEdge + 'px');
      } catch { /* keep CSS fallbacks */ }
    });
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

function AppInner() {
  const { state, navigate } = useApp();
  const { currentView } = state;
  const [showAdd, setShowAdd] = useState(false);
  // Increment a key for each tab when it's re-tapped — child uses key= to force remount (reset)
  const [resetKeys, setResetKeys] = useState({ transactions:0, accounts:0, categories:0, settings:0, dashboard:0 });
  const handleNavTap = (id) => setResetKeys(k => ({ ...k, [id]: (k[id]||0)+1 }));

  // Child screens register a "handle back" callback here
  const backInterceptRef = React.useRef(null);

  useEffect(() => {
    const setup = async () => {
      try {
        if (!window.Capacitor || window.Capacitor.getPlatform?.() !== 'android') return;
        const { App } = await import('@capacitor/app');
        await App.removeAllListeners();
        App.addListener('backButton', () => {
          // 1. Close the Add/Edit modal
          if (showAdd) { setShowAdd(false); return; }
          // 2. Let the active child-screen handle it (e.g. account drill-down)
          if (backInterceptRef.current) { backInterceptRef.current(); return; }
          // 3. Any top-level tab → go home
          if (currentView !== 'dashboard') { navigate('dashboard'); return; }
          // 4. Already home → close app
          App.minimizeApp();
        });
      } catch { /* web */ }
    };
    setup();
    return () => {
      import('@capacitor/app').then(({ App }) => App.removeAllListeners()).catch(() => {});
    };
  }, [currentView, showAdd, navigate]);

  const screen = (() => {
    switch (currentView) {
      case 'transactions': return <Transactions key={resetKeys.transactions} onAddTransaction={() => setShowAdd(true)} backInterceptRef={backInterceptRef}/>;
      case 'accounts':     return <Accounts     key={resetKeys.accounts}     backInterceptRef={backInterceptRef}/>;
      case 'categories':   return <Categories   key={resetKeys.categories}   backInterceptRef={backInterceptRef}/>;
      case 'analytics':    return <Analytics/>;
      case 'settings':     return <Settings     key={resetKeys.settings}     backInterceptRef={backInterceptRef}/>;
      default:             return <Dashboard    key={resetKeys.dashboard}/>;
    }
  })();

  return (
    <PinLock>
      <Layout onNavTap={handleNavTap}>
        {screen}
      </Layout>
      {showAdd && <AddTransaction onClose={() => setShowAdd(false)} backInterceptRef={backInterceptRef}/>}
    </PinLock>
  );
}

export default function App() {
  const [ready, setReady] = React.useState(false);
  useEffect(() => { initDB().then(() => setReady(true)).catch(console.error); }, []);
  if (!ready) return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100dvh',background:'#0a0f1e',flexDirection:'column',gap:16}}>
      <div style={{width:40,height:40,border:'3px solid #00e5a0',borderTopColor:'transparent',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
  return <AppProvider><AppInner/></AppProvider>;
}
