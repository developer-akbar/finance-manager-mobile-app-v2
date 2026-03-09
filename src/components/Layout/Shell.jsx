import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import Dashboard   from '../Dashboard/Dashboard.jsx';
import Stats       from '../Stats/Stats.jsx';
import Search      from '../Search/Search.jsx';
import Settings    from '../Settings/Settings.jsx';
import AddTxnSheet from '../Transactions/AddTxnSheet.jsx';

const VIEWS = ['dashboard','stats','search','settings'];

export default function Shell() {
  const { state, dispatch } = useApp();
  const [showAdd, setShowAdd] = useState(false);
  const view = state.currentView;

  const go = v => dispatch({ type:'SET_VIEW', v });

  return (
    <div className="app-shell">
      <div className="screen-area">
        <div className={`screen ${view==='dashboard' ? 'active':''}`}><Dashboard onAdd={() => setShowAdd(true)} /></div>
        <div className={`screen ${view==='stats'     ? 'active':''}`}><Stats /></div>
        <div className={`screen ${view==='search'    ? 'active':''}`}><Search /></div>
        <div className={`screen ${view==='settings'  ? 'active':''}`}><Settings /></div>
      </div>

      <nav className="bottom-nav">
        <NavItem label="Home"    icon={<HomeIcon />}    active={view==='dashboard'} onClick={() => go('dashboard')} />
        <NavItem label="Stats"   icon={<StatsIcon />}   active={view==='stats'}     onClick={() => go('stats')} />
        <button className="nav-fab" onClick={() => setShowAdd(true)} aria-label="Add transaction">
          <PlusIcon />
        </button>
        <NavItem label="Search"  icon={<SearchIcon />}  active={view==='search'}    onClick={() => go('search')} />
        <NavItem label="Settings"icon={<SettingsIcon />}active={view==='settings'}  onClick={() => go('settings')} />
      </nav>

      {showAdd && <AddTxnSheet onClose={() => setShowAdd(false)} />}
    </div>
  );
}

function NavItem({ label, icon, active, onClick }) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

// Icons
const HomeIcon    = () => <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>;
const StatsIcon   = () => <svg viewBox="0 0 24 24"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>;
const PlusIcon    = () => <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>;
const SearchIcon  = () => <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>;
const SettingsIcon= () => <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
