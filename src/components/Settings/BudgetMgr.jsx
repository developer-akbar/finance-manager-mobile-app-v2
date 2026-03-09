import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, parseDate, monthName } from '../../utils/format.js';
import './Settings.css';

export default function BudgetMgr({ onBack }) {
  const { state, upsertBudget, removeBudget, toast } = useApp();
  const { budgets, categories, transactions } = state;
  const now = new Date();

  const [cat,    setCat]    = useState('');
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState('monthly');
  const [saving, setSaving] = useState(false);

  const expCats = categories.filter(c=>c.type==='Expense').map(c=>c.name);

  const doAdd = async () => {
    if (!cat || !amount) return;
    setSaving(true);
    try {
      await upsertBudget({ category:cat, amount:parseFloat(amount), period });
      setCat(''); setAmount(''); toast('Budget saved ✓');
    } finally { setSaving(false); }
  };

  const doDelete = async (id) => {
    await removeBudget(id);
    toast('Budget removed');
  };

  const getSpent = (cat, period) => {
    return transactions.filter(t => {
      const d = parseDate(t.Date);
      const ok = period==='monthly'
        ? d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth()
        : d.getFullYear()===now.getFullYear();
      return t.Category===cat && t['Income/Expense']==='Expense' && ok;
    }).reduce((s,t)=>s+parseFloat(t.INR||0),0);
  };

  return (
    <div className="subpage settings-screen">
      <div className="subpage-header">
        <button className="back-btn" onClick={onBack}><BackIcon/></button>
        <div className="subpage-title">Budgets</div>
      </div>

      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>Add Budget</div>
        <div className="card" style={{padding:16,display:'flex',flexDirection:'column',gap:10}}>
          <select className="form-control" value={cat} onChange={e=>setCat(e.target.value)}>
            <option value="">Select category…</option>
            {expCats.map(c=><option key={c} value={c}>{c}</option>)}
          </select>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <input className="form-control" type="number" placeholder="Budget amount (₹)" value={amount} onChange={e=>setAmount(e.target.value)} />
            <select className="form-control" value={period} onChange={e=>setPeriod(e.target.value)}>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <button className="btn btn-primary btn-full" onClick={doAdd} disabled={!cat||!amount||saving}>+ Set Budget</button>
        </div>
      </div>

      <div className="mgr-section">
        <div className="settings-group-label" style={{padding:0,marginBottom:12}}>
          Active Budgets — {monthName(now.getMonth())} {now.getFullYear()}
        </div>
        {budgets.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">🎯</div><div className="empty-title">No budgets yet</div><div className="empty-sub">Set spending limits per category</div></div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {budgets.map(b => {
              const spent = getSpent(b.category, b.period);
              const pct   = Math.min(100, (spent/b.amount)*100);
              return (
                <div key={b.id} className="card" style={{padding:16}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                    <div style={{fontWeight:700,fontSize:15,color:'var(--text)'}}>{b.category}</div>
                    <div style={{display:'flex',alignItems:'center',gap:10}}>
                      <span style={{fontSize:12,background:'var(--bg4)',padding:'3px 8px',borderRadius:8,color:'var(--text3)'}}>{b.period}</span>
                      <button className="btn btn-danger btn-sm" onClick={()=>doDelete(b.id)}>✕</button>
                    </div>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:8}}>
                    <span style={{color:pct>=100?'var(--red)':'var(--text2)',fontFamily:'var(--mono)',fontWeight:600}}>{formatINR(spent)}</span>
                    <span style={{color:'var(--text3)',fontFamily:'var(--mono)'}}>/ {formatINR(b.amount)}</span>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{width:`${pct}%`,background:pct>=100?'var(--red)':pct>=80?'var(--gold)':'var(--green)'}} />
                  </div>
                  <div style={{fontSize:11,color:'var(--text3)',marginTop:6,textAlign:'right'}}>
                    {pct.toFixed(0)}% used · {formatINR(Math.max(0,b.amount-spent))} left
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const BackIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>;
