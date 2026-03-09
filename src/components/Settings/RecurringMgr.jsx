import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, todayISO } from '../../utils/format.js';
import './Settings.css';

export default function RecurringMgr({ onBack }) {
  const { state, upsertRecurring, removeRecurring, addTransaction, toast } = useApp();
  const { recurring, categories } = state;
  const { accountNames } = useApp();

  const [name,    setName]    = useState('');
  const [amount,  setAmount]  = useState('');
  const [account, setAccount] = useState('');
  const [cat,     setCat]     = useState('');
  const [type,    setType]    = useState('Expense');
  const [freq,    setFreq]    = useState('monthly');
  const [next,    setNext]    = useState(todayISO());
  const [saving,  setSaving]  = useState(false);

  const filteredCats = categories.filter(c=>c.type===type).map(c=>c.name);

  const doAdd = async () => {
    if (!name.trim() || !amount) return;
    setSaving(true);
    try {
      await upsertRecurring({ name:name.trim(), amount:parseFloat(amount), account, category:cat, type, frequency:freq, next_date:next });
      setName(''); setAmount(''); toast('Recurring saved ✓');
    } finally { setSaving(false); }
  };

  const doDelete = async (id) => {
    await removeRecurring(id);
    toast('Removed');
  };

  const doAddNow = async (r) => {
    await addTransaction({
      Date: todayISO().replace(/-/g,'/').split('/').reverse().join('/'), // DD/MM/YYYY
      'Income/Expense': r.type, Amount: String(r.amount), INR: r.amount,
      Account: r.account, Category: r.category, Note: r.name, Currency: 'INR',
    });
    toast(`Added: ${r.name} ✓`);
  };

  return (
    <div className="subpage settings-screen">
      <div className="subpage-header">
        <button className="back-btn" onClick={onBack}><BackIcon/></button>
        <div className="subpage-title">Recurring</div>
      </div>

      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>Add Recurring Transaction</div>
        <div className="card" style={{padding:16,display:'flex',flexDirection:'column',gap:10}}>
          <input className="form-control" placeholder="Name (e.g. Monthly Salary)" value={name} onChange={e=>setName(e.target.value)} />
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <input className="form-control" type="number" placeholder="Amount (₹)" value={amount} onChange={e=>setAmount(e.target.value)} />
            <select className="form-control" value={type} onChange={e=>setType(e.target.value)}>
              <option value="Expense">Expense</option>
              <option value="Income">Income</option>
            </select>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <select className="form-control" value={account} onChange={e=>setAccount(e.target.value)}>
              <option value="">Account…</option>
              {accountNames.map(a=><option key={a} value={a}>{a}</option>)}
            </select>
            <select className="form-control" value={cat} onChange={e=>setCat(e.target.value)}>
              <option value="">Category…</option>
              {filteredCats.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <select className="form-control" value={freq} onChange={e=>setFreq(e.target.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
            <input className="form-control" type="date" value={next} onChange={e=>setNext(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-full" onClick={doAdd} disabled={!name.trim()||!amount||saving}>+ Add Recurring</button>
        </div>
      </div>

      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>Active ({recurring.length})</div>
        {recurring.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">🔄</div><div className="empty-title">No recurring transactions</div><div className="empty-sub">Set up salary, rent, subscriptions…</div></div>
        ) : (
          <div className="settings-list">
            {recurring.map(r=>(
              <div key={r.id} className="settings-row" style={{flexWrap:'wrap',gap:8}}>
                <div className="settings-row-icon" style={{background:r.type==='Income'?'var(--green-dim)':'var(--red-dim)'}}>{r.type==='Income'?'💰':'💸'}</div>
                <div className="settings-row-text">
                  <div className="settings-row-title">{r.name}</div>
                  <div className="settings-row-sub">{formatINR(r.amount)} · {r.frequency} · {r.next_date||'—'}</div>
                </div>
                <div style={{display:'flex',gap:6}}>
                  <button className="btn btn-secondary btn-sm" onClick={()=>doAddNow(r)}>+ Add Now</button>
                  <button className="btn btn-danger btn-sm" onClick={()=>doDelete(r.id)}>✕</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const BackIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>;
