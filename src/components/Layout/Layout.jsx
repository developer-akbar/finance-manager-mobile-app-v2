import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import './Layout.css';

const HomeIco = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
const TxnIco  = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>;
const AcctIco = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>;
const CatIco  = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z"/><circle cx="17.5" cy="17.5" r="3.5"/></svg>;
const ChartIco = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>;
const SetIco  = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
const MoonIco = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>;
const SunIco  = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;

// Mobile Bottom Navigation items (5 items)
const MOBILE_NAV = [
  { id:'dashboard',    label:'Home',       Icon:HomeIco },
  { id:'transactions', label:'Trans.',     Icon:TxnIco  },
  { id:'accounts',     label:'Accounts',   Icon:AcctIco },
  { id:'categories',   label:'Categories', Icon:CatIco  },
  { id:'settings',     label:'Settings',   Icon:SetIco  },
];

// Desktop Sidebar Navigation items (Full navigation)
const DESKTOP_NAV = [
  { id:'dashboard',    label:'Dashboard',    Icon:HomeIco, badge: null },
  { id:'transactions', label:'Transactions', Icon:TxnIco,  badge: null },
  { id:'accounts',     label:'Accounts',     Icon:AcctIco, badge: null },
  { id:'categories',   label:'Categories',   Icon:CatIco,  badge: null },
  { id:'analytics',    label:'Analytics',    Icon:ChartIco, badge: null },
  { id:'settings',     label:'Settings',     Icon:SetIco,  badge: null },
];

export default function Layout({ children, onNavTap }) {
  const { state, navigate, setTheme } = useApp();
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [logoLoaded, setLogoLoaded] = useState(true);
  const scrollTargetRef = useRef(null);

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem('finman_sidebar_collapsed');
      return saved !== null ? saved === 'true' : false;
    } catch {
      return false;
    }
  });

  const toggleSidebar = () => {
    setIsSidebarCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem('finman_sidebar_collapsed', String(next));
      } catch {}
      return next;
    });
  };

  const theme = state.theme || state.settings?.theme || 'dark';

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
  };

  // Global scroll listener across window and any scrollable container
  useEffect(() => {
    const handleScroll = (e) => {
      const target = e.target;
      if (!target || !(target instanceof HTMLElement)) return;
      const st = target.scrollTop || window.scrollY || 0;
      if (st > 140) {
        scrollTargetRef.current = target;
        setShowScrollTop(true);
      } else if (scrollTargetRef.current === target && st <= 80) {
        setShowScrollTop(false);
      }
    };

    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, []);

  // Hide scroll-to-top when navigating tabs
  useEffect(() => {
    setShowScrollTop(false);
  }, [state.currentView]);

  const handleScrollToTop = () => {
    if (scrollTargetRef.current && scrollTargetRef.current.scrollTop > 0) {
      scrollTargetRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const selectors = [
      '.layout-screen',
      '.dash-scrollable-content',
      '.txn-list-body',
      '.sub-body',
      '.acct-detail-body',
      '.cat-detail-body',
      '.debt-tracker-body',
      '.settings-root',
      '.categories-list',
      '.accounts-list',
      '.analytics-scrollable-content',
      '.analytics-screen',
      '.txn-monthly-list',
      '.txn-screen-body',
      '.search-list',
      '.report-screen'
    ];
    document.querySelectorAll(selectors.join(', ')).forEach(el => {
      if (el.scrollTop > 0) {
        el.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
    setTimeout(() => setShowScrollTop(false), 250);
  };

  const handleNavClick = (id) => {
    if (state.currentView === id) {
      // Already on this tab — signal a reset to the child
      onNavTap?.(id);
    } else {
      navigate(id);
      if (id === 'dashboard') {
        window.dispatchEvent(new CustomEvent('reset-dashboard-view'));
      }
    }
  };

  return (
    <div className="app-shell">
      {/* ── DESKTOP SIDEBAR (>= 1024px) ── */}
      <aside className={`desktop-sidebar ${isSidebarCollapsed ? 'collapsed' : 'expanded'}`}>
        <div className="sidebar-brand">
          <div
            className="brand-logo-wrap"
            onClick={toggleSidebar}
            style={{ cursor: 'pointer' }}
            title={isSidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSidebar(); }}
          >
            <img
              src="/icon-xhdpi.png"
              alt="FinMan"
              className="brand-logo"
              onError={() => setLogoLoaded(false)}
              style={{ display: logoLoaded ? 'block' : 'none' }}
            />
            {!logoLoaded && (
              <div className="brand-logo brand-logo-fallback">
                FM
              </div>
            )}
            {!isSidebarCollapsed && (
              <div className="brand-title-group">
                <div className="brand-name">FinMan</div>
                <div className="brand-version">v2.2</div>
              </div>
            )}
          </div>
        </div>

        <nav className="sidebar-nav">
          {DESKTOP_NAV.map(({ id, label, Icon }, idx) => {
            const isActive = state.currentView === id;
            return (
              <button
                key={id}
                className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
                onClick={() => handleNavClick(id)}
                title={isSidebarCollapsed ? label : undefined}
                style={{ '--nav-idx': idx }}
              >
                <div className="sidebar-item-icon">
                  <Icon />
                </div>
                {!isSidebarCollapsed && <span className="sidebar-item-label">{label}</span>}
                {isActive && <div className="sidebar-active-pill" />}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button className="theme-toggle-btn" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} mode`}>
            {theme === 'dark' ? <SunIco /> : <MoonIco />}
            <span className="theme-toggle-label">{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
          </button>
          <div className="sidebar-user-info" title="Ledger Active">
            <div className="user-dot" />
            <span className="user-status">Ledger Active</span>
          </div>
        </div>
      </aside>

      {/* ── MAIN CONTENT AREA ── */}
      <div className="layout-body">
        <div className="layout-screen">{children}</div>
      </div>

      {showScrollTop && (
        <button
          className="global-scroll-top-btn"
          onClick={handleScrollToTop}
          title="Scroll to top"
          aria-label="Scroll to top"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
            <path d="M18 15l-6-6-6 6"/>
          </svg>
        </button>
      )}

      {/* ── MOBILE BOTTOM NAV (< 1024px) ── */}
      <nav className="bottom-nav">
        {MOBILE_NAV.map(({ id, label, Icon }) => (
          <button key={id} className={`nav-btn ${state.currentView === id ? 'active' : ''}`} onClick={() => handleNavClick(id)}>
            <Icon/><span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
