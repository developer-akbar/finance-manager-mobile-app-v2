import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { v4 as uuid } from 'uuid';
import './Settings.css';

const ICONS  = ['💳','🏦','💰','🪙','📱','💵','🏧','💎','🌟','🔵'];
const COLORS = ['#4d9fff','#00e5a0','#a78bfa','#ffd166','#ff4d6a','#fb923c','#2dd4bf','#f472b6'];

export default function AccountMgr({ onBack }) {
  const { state, saveAccounts, saveAccountGroups, toast } = useApp();
  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  const groups   = Array.isArray(state.accountGroups) ? state.accountGroups : [];

  const [newName,  setNewName]  = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [newIcon,  setNewIcon]  = useState('💳');
  const [newColor, setNewColor] = useState('#4d9fff');
  const [grpName,  setGrpName]  = useState('');
  const [saving,   setSaving]   = useState(false);

  const doAddAccount = async () => {
    if (!newName.trim()) return;
    if (accounts.some(a=>a.name===newName.trim())) { toast('Account already exists','error'); return; }
    setSaving(true);
    try {
      await saveAccounts([...accounts, { id:uuid(), name:newName.trim(), group_name:newGroup, icon:newIcon, color:newColor, sort_order:accounts.length }]);
      setNewName(''); toast('Account added ✓');
    } finally { setSaving(false); }
  };

  const doAddGroup = async () => {
    if (!grpName.trim()) return;
    if (groups.some(g=>g.name===grpName.trim())) { toast('Group already exists','error'); return; }
    await saveAccountGroups([...groups, { id:uuid(), name:grpName.trim(), sort_order:groups.length }]);
    setGrpName(''); toast('Group added ✓');
  };

  const doDeleteAccount = async (id) => {
    const used = state.transactions.some(t => state.accounts.find(a=>a.id===id)?.name === t.Account);
    if (used && !window.confirm('This account has transactions. Delete anyway?')) return;
    await saveAccounts(accounts.filter(a=>a.id!==id));
    toast('Deleted');
  };

  const doDeleteGroup = async (id) => {
    await saveAccountGroups(groups.filter(g=>g.id!==id));
    toast('Group deleted');
  };

  return (
    <div className="subpage settings-screen">
      <div className="subpage-header">
        <button className="back-btn" onClick={onBack}><BackIcon/></button>
        <div className="subpage-title">Accounts</div>
      </div>

      {/* Add Account */}
      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>Add Account</div>
        <div className="card" style={{padding:16,display:'flex',flexDirection:'column',gap:10}}>
          <input className="form-control" placeholder="Account name" value={newName} onChange={e=>setNewName(e.target.value)} />
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <select className="form-control" value={newGroup} onChange={e=>setNewGroup(e.target.value)}>
              <option value="">No group</option>
              {groups.map(g=><option key={g.id} value={g.name}>{g.name}</option>)}
            </select>
            <select className="form-control" value={newColor} onChange={e=>setNewColor(e.target.value)}>
              {COLORS.map(c=><option key={c} value={c} style={{color:c}}>●</option>)}
            </select>
          </div>
          <div className="icon-picker">
            {ICONS.map(i=>(
              <button key={i} className={`icon-btn ${newIcon===i?'active':''}`} onClick={()=>setNewIcon(i)}>{i}</button>
            ))}
          </div>
          <button className="btn btn-primary btn-full" onClick={doAddAccount} disabled={!newName.trim()||saving}>
            + Add Account
          </button>
        </div>
      </div>

      {/* Account Groups */}
      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>Groups</div>
        <div style={{display:'flex',gap:10,marginBottom:10}}>
          <input className="form-control" placeholder="New group name" value={grpName} onChange={e=>setGrpName(e.target.value)} style={{flex:1}} />
          <button className="btn btn-secondary" onClick={doAddGroup} disabled={!grpName.trim()}>Add</button>
        </div>
        {groups.length > 0 && (
          <div className="settings-list">
            {groups.map(g=>(
              <div key={g.id} className="settings-row">
                <div className="settings-row-icon">📁</div>
                <div className="settings-row-text"><div className="settings-row-title">{g.name}</div></div>
                <button className="btn btn-danger btn-sm" onClick={()=>doDeleteGroup(g.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Accounts list */}
      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>All Accounts ({accounts.length})</div>
        {accounts.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">💳</div><div className="empty-title">No accounts yet</div></div>
        ) : (
          <div className="settings-list">
            {accounts.map(a=>(
              <div key={a.id} className="settings-row">
                <div className="settings-row-icon" style={{fontSize:20,background:`${a.color}20`,border:`1px solid ${a.color}40`}}>{a.icon||'💳'}</div>
                <div className="settings-row-text">
                  <div className="settings-row-title">{a.name}</div>
                  {a.group_name && <div className="settings-row-sub">{a.group_name}</div>}
                </div>
                <button className="btn btn-danger btn-sm" onClick={()=>doDeleteAccount(a.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const BackIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>;
