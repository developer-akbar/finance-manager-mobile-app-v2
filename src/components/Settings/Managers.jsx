import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';

// ── AccountManager ────────────────────────────────────────────────────────────
export function AccountManager({ onBack }) {
  const { state, updateSettings } = useApp();
  const accounts = Array.isArray(state.accounts) ? state.accounts : [];
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  const add = async () => {
    const n = newName.trim();
    if (!n || accounts.includes(n)) return;
    setSaving(true);
    await updateSettings({ accounts: [...accounts, n] });
    setNewName('');
    setSaving(false);
  };

  const remove = async (name) => {
    if (!window.confirm(`Delete account "${name}"?`)) return;
    await updateSettings({ accounts: accounts.filter(a => a !== name) });
  };

  return (
    <div className="sub-panel">
      <div className="sub-panel-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <div className="sub-panel-title">Accounts</div>
      </div>
      <div style={{ padding:'var(--space-4)', display:'flex', flexDirection:'column', gap:'var(--space-4)' }}>
        <div style={{ display:'flex', gap:8 }}>
          <input className="form-input" style={{ flex:1 }} placeholder="New account name"
            value={newName} onChange={e => setNewName(e.target.value)}
            onKeyPress={e => e.key === 'Enter' && add()} />
          <button className="btn btn-primary" onClick={add} disabled={saving || !newName.trim()}>Add</button>
        </div>
        <div className="card" style={{ overflow:'hidden' }}>
          {accounts.length === 0 && <div style={{ padding:20, textAlign:'center', color:'var(--text-muted)', fontSize:13 }}>No accounts. Import data or add one above.</div>}
          {accounts.map(a => (
            <div key={a} className="list-row">
              <div style={{ fontSize:20 }}>💳</div>
              <div className="list-row-content"><div className="list-row-title">{a}</div></div>
              <button style={{ background:'none', border:'none', color:'var(--expense)', cursor:'pointer', fontSize:18 }} onClick={() => remove(a)}>🗑️</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── CategoryManager ───────────────────────────────────────────────────────────
export function CategoryManager({ onBack }) {
  const { state, updateSettings } = useApp();
  const cats = state.categories || {};
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('Expense');
  const [saving, setSaving]   = useState(false);

  const add = async () => {
    const n = newName.trim();
    if (!n || cats[n]) return;
    setSaving(true);
    await updateSettings({ categories: { ...cats, [n]: { type: newType, subcategories: [] } } });
    setNewName('');
    setSaving(false);
  };

  const remove = async (name) => {
    if (!window.confirm(`Delete category "${name}"?`)) return;
    const c = { ...cats }; delete c[name];
    await updateSettings({ categories: c });
  };

  const expenseCats = Object.entries(cats).filter(([,d]) => d.type === 'Expense');
  const incomeCats  = Object.entries(cats).filter(([,d]) => d.type === 'Income');

  return (
    <div className="sub-panel">
      <div className="sub-panel-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <div className="sub-panel-title">Categories</div>
      </div>
      <div style={{ padding:'var(--space-4)', display:'flex', flexDirection:'column', gap:'var(--space-4)' }}>
        <div style={{ display:'flex', gap:8 }}>
          <input className="form-input" style={{ flex:1 }} placeholder="New category"
            value={newName} onChange={e => setNewName(e.target.value)}
            onKeyPress={e => e.key === 'Enter' && add()} />
          <select className="form-input" style={{ width:110 }} value={newType} onChange={e => setNewType(e.target.value)}>
            <option>Expense</option><option>Income</option>
          </select>
          <button className="btn btn-primary" onClick={add} disabled={saving || !newName.trim()}>Add</button>
        </div>
        {[['Expense',expenseCats],['Income',incomeCats]].map(([type, list]) => (
          <div key={type}>
            <div className="section-label" style={{ padding:0, marginBottom:8 }}>{type} Categories ({list.length})</div>
            <div className="card" style={{ overflow:'hidden' }}>
              {list.length === 0 && <div style={{ padding:16, textAlign:'center', color:'var(--text-muted)', fontSize:13 }}>None yet</div>}
              {list.map(([name, data]) => (
                <div key={name} className="list-row">
                  <div style={{ fontSize:20 }}>🏷️</div>
                  <div className="list-row-content">
                    <div className="list-row-title">{name}</div>
                    <div className="list-row-subtitle">{(data.subcategories||[]).join(', ') || 'No subcategories'}</div>
                  </div>
                  <button style={{ background:'none', border:'none', color:'var(--expense)', cursor:'pointer', fontSize:18 }} onClick={() => remove(name)}>🗑️</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── BudgetManager ─────────────────────────────────────────────────────────────
export function BudgetManager({ onBack }) {
  const { state, saveBudget, removeBudget } = useApp();
  const budgets  = state.budgets  || [];
  const expCats  = Object.entries(state.categories||{}).filter(([,d]) => d.type==='Expense').map(([n])=>n);
  const [cat,    setCat]    = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (!cat || !amount) return;
    setSaving(true);
    await saveBudget(cat, parseFloat(amount), 'monthly');
    setCat(''); setAmount('');
    setSaving(false);
  };

  return (
    <div className="sub-panel">
      <div className="sub-panel-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <div className="sub-panel-title">Budgets</div>
      </div>
      <div style={{ padding:'var(--space-4)', display:'flex', flexDirection:'column', gap:'var(--space-4)' }}>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <select className="form-input" style={{ flex:1, minWidth:120 }} value={cat} onChange={e => setCat(e.target.value)}>
            <option value="">Category…</option>
            {expCats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <input className="form-input" style={{ flex:1, minWidth:100 }} type="number" placeholder="Monthly limit ₹"
            value={amount} onChange={e => setAmount(e.target.value)} />
          <button className="btn btn-primary" onClick={add} disabled={saving||!cat||!amount}>Set</button>
        </div>
        <div className="card" style={{ overflow:'hidden' }}>
          {budgets.length === 0 && <div style={{ padding:20, textAlign:'center', color:'var(--text-muted)', fontSize:13 }}>No budgets set.</div>}
          {budgets.map(b => (
            <div key={b.category} className="list-row">
              <div style={{ fontSize:20 }}>🎯</div>
              <div className="list-row-content">
                <div className="list-row-title">{b.category}</div>
                <div className="list-row-subtitle">₹{Number(b.amount).toLocaleString('en-IN')} / {b.period}</div>
              </div>
              <button style={{ background:'none', border:'none', color:'var(--expense)', cursor:'pointer', fontSize:18 }} onClick={() => removeBudget(b.category)}>🗑️</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── ProfileSettings ───────────────────────────────────────────────────────────
import { getSetting, setSetting as dbSetSetting } from '../../database/settings.js';
import { useEffect } from 'react';

export function ProfileSettings({ onBack }) {
  const { saveSetting } = useApp();
  const [name,    setName]    = useState('');
  const [pinOn,   setPinOn]   = useState(false);
  const [newPin,  setNewPin]  = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg,     setMsg]     = useState('');

  useEffect(() => {
    getSetting('profile_name').then(n => n && setName(n));
    getSetting('app_pin_enabled').then(v => setPinOn(v === 'true'));
  }, []);

  const saveName = async () => {
    await dbSetSetting('profile_name', name);
    setMsg('✅ Name saved');
    setTimeout(() => setMsg(''), 2000);
  };

  const savePin = async () => {
    if (!/^\d{4,6}$/.test(newPin)) { setMsg('❌ PIN must be 4-6 digits'); return; }
    if (newPin !== confirm)         { setMsg('❌ PINs do not match');      return; }
    await dbSetSetting('app_pin', newPin);
    await dbSetSetting('app_pin_enabled', 'true');
    setPinOn(true);
    setNewPin(''); setConfirm('');
    setMsg('✅ PIN set');
    setTimeout(() => setMsg(''), 2000);
  };

  const togglePin = async () => {
    const next = !pinOn;
    await dbSetSetting('app_pin_enabled', String(next));
    setPinOn(next);
  };

  return (
    <div className="sub-panel">
      <div className="sub-panel-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <div className="sub-panel-title">Profile & PIN</div>
      </div>
      <div style={{ padding:'var(--space-4)', display:'flex', flexDirection:'column', gap:'var(--space-4)' }}>
        {msg && <div style={{ padding:'10px 14px', borderRadius:'var(--r-md)', background: msg.startsWith('✅') ? 'var(--income-bg)' : 'var(--expense-bg)', color: msg.startsWith('✅') ? 'var(--income)' : 'var(--expense)', fontSize:14, fontWeight:600 }}>{msg}</div>}

        <div className="card" style={{ overflow:'hidden', padding:'var(--space-4)', display:'flex', flexDirection:'column', gap:'var(--space-4)' }}>
          <div className="form-group">
            <label className="form-label">Display Name</label>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
          </div>
          <button className="btn btn-primary" onClick={saveName}>Save Name</button>
        </div>

        <div className="card" style={{ overflow:'hidden', padding:'var(--space-4)', display:'flex', flexDirection:'column', gap:'var(--space-4)' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <div>
              <div style={{ fontSize:15, fontWeight:700, color:'var(--text-primary)' }}>🔒 PIN Lock</div>
              <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>Locks app after 30s background</div>
            </div>
            <div className={`toggle ${pinOn ? 'on' : ''}`} onClick={togglePin} />
          </div>
          <div className="form-group">
            <label className="form-label">New PIN (4-6 digits)</label>
            <input className="form-input" type="password" inputMode="numeric" maxLength={6} value={newPin} onChange={e => setNewPin(e.target.value)} placeholder="••••" />
          </div>
          <div className="form-group">
            <label className="form-label">Confirm PIN</label>
            <input className="form-input" type="password" inputMode="numeric" maxLength={6} value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="••••" />
          </div>
          <button className="btn btn-primary" onClick={savePin}>Set PIN</button>
        </div>
      </div>
    </div>
  );
}
