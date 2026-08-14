import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import './Layout.css';

const HomeIco = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
const TxnIco  = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>;
const AcctIco = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>;
const CatIco  = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z"/><circle cx="17.5" cy="17.5" r="3.5"/></svg>;
const SetIco  = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;

const NAV = [
  { id:'dashboard',    label:'Home',       Icon:HomeIco },
  { id:'transactions', label:'Trans.',     Icon:TxnIco  },
  { id:'accounts',     label:'Accounts',   Icon:AcctIco },
  { id:'categories',   label:'Categories', Icon:CatIco  },
  { id:'settings',     label:'Settings',   Icon:SetIco  },
];

export default function Layout({ children, onNavTap }) {
  const { state, navigate } = useApp();
  const [showScrollTop, setShowScrollTop] = useState(false);
  const scrollTargetRef = useRef(null);

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
      '.forecast-body',
      '.settings-root',
      '.categories-list',
      '.accounts-list',
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
    }
  };

  return (
    <div className="app-shell">
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

      <nav className="bottom-nav">
        {NAV.map(({ id, label, Icon }) => (
          <button key={id} className={`nav-btn ${state.currentView === id ? 'active' : ''}`} onClick={() => handleNavClick(id)}>
            <Icon/><span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
