import React, { useState, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, parseDate } from '../../utils/format.js';
import TxnList from '../Common/TxnList.jsx';
import '../Common/TxnList.css';
import './Search.css';

export default function Search() {
  const { state, deleteTransaction } = useApp();
  const { transactions, accounts, categories } = state;

  const [q,        setQ]        = useState('');
  const [typeF,    setTypeF]    = useState('all');
  const [accountF, setAccountF] = useState('all');
  const [catF,     setCatF]     = useState('all');
  const [dateF,    setDateF]    = useState('all');
  const [sortBy,   setSortBy]   = useState('date-desc');
  const [showFilters, setShowFilters] = useState(false);

  const accountNames = [...new Set(transactions.map(t=>t.Account).filter(Boolean))].sort();
  const catNames     = [...new Set(transactions.map(t=>t.Category).filter(Boolean))].sort();

  const filtered = useMemo(() => {
    let list = [...transactions];

    if (q.trim()) {
      const ql = q.toLowerCase();
      list = list.filter(t =>
        (t.Note||'').toLowerCase().includes(ql) ||
        (t.Category||'').toLowerCase().includes(ql) ||
        (t.Subcategory||'').toLowerCase().includes(ql) ||
        (t.Account||'').toLowerCase().includes(ql) ||
        (t.Description||'').toLowerCase().includes(ql) ||
        String(t.INR||'').includes(ql)
      );
    }

    if (typeF    !== 'all') list = list.filter(t => t['Income/Expense'] === typeF);
    if (accountF !== 'all') list = list.filter(t => t.Account === accountF);
    if (catF     !== 'all') list = list.filter(t => t.Category === catF);

    if (dateF !== 'all') {
      const now = new Date();
      let cutoff = new Date();
      if (dateF==='today')  { cutoff.setHours(0,0,0,0); }
      if (dateF==='week')   { cutoff.setDate(now.getDate()-7); }
      if (dateF==='month')  { cutoff.setMonth(now.getMonth()-1); }
      if (dateF==='year')   { cutoff.setFullYear(now.getFullYear()-1); }
      list = list.filter(t => parseDate(t.Date) >= cutoff);
    }

    list.sort((a,b) => {
      if (sortBy==='date-desc')   return parseDate(b.Date)-parseDate(a.Date);
      if (sortBy==='date-asc')    return parseDate(a.Date)-parseDate(b.Date);
      if (sortBy==='amount-desc') return parseFloat(b.INR||0)-parseFloat(a.INR||0);
      if (sortBy==='amount-asc')  return parseFloat(a.INR||0)-parseFloat(b.INR||0);
      return 0;
    });

    return list;
  }, [transactions, q, typeF, accountF, catF, dateF, sortBy]);

  const totals = useMemo(() => {
    const inc = filtered.filter(t=>t['Income/Expense']==='Income').reduce((s,t)=>s+parseFloat(t.INR||0),0);
    const exp = filtered.filter(t=>t['Income/Expense']==='Expense').reduce((s,t)=>s+parseFloat(t.INR||0),0);
    return { inc, exp };
  }, [filtered]);

  const hasFilters = typeF!=='all'||accountF!=='all'||catF!=='all'||dateF!=='all';

  const clearAll = () => { setQ(''); setTypeF('all'); setAccountF('all'); setCatF('all'); setDateF('all'); };

  return (
    <div className="search-screen">
      <div className="page-header">
        <div className="page-title">Transactions</div>
        {hasFilters && <button className="btn btn-sm btn-danger" onClick={clearAll}>Clear</button>}
      </div>

      {/* Search bar */}
      <div className="search-bar-wrap">
        <div className="search-bar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <input type="text" placeholder="Search notes, categories, accounts…"
            value={q} onChange={e => setQ(e.target.value)} className="search-input" />
          {q && <button className="search-clear" onClick={() => setQ('')}>×</button>}
        </div>
        <button className={`btn btn-icon btn-secondary ${showFilters?'active':''}`}
          onClick={() => setShowFilters(s=>!s)} style={{flexShrink:0}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
        </button>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="search-filters">
          <div className="filter-row">
            <label className="form-label">Type</label>
            <div className="filter-chips">
              {[['all','All'],['Expense','Expense'],['Income','Income'],['Transfer-Out','Transfer']].map(([v,l]) => (
                <button key={v} className={`chip ${typeF===v?'active':''}`} onClick={() => setTypeF(v)}>{l}</button>
              ))}
            </div>
          </div>
          <div className="filter-row">
            <label className="form-label">Date Range</label>
            <div className="filter-chips">
              {[['all','All'],['today','Today'],['week','7 Days'],['month','Month'],['year','Year']].map(([v,l]) => (
                <button key={v} className={`chip ${dateF===v?'active':''}`} onClick={() => setDateF(v)}>{l}</button>
              ))}
            </div>
          </div>
          <div className="filter-row-2">
            <div>
              <label className="form-label">Account</label>
              <select className="form-control" value={accountF} onChange={e => setAccountF(e.target.value)}>
                <option value="all">All Accounts</option>
                {accountNames.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Category</label>
              <select className="form-control" value={catF} onChange={e => setCatF(e.target.value)}>
                <option value="all">All Categories</option>
                {catNames.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Result bar */}
      <div className="search-result-bar">
        <span className="search-count">{filtered.length.toLocaleString()} transactions</span>
        <div className="search-result-totals">
          <span className="amt-in" style={{fontSize:12}}>+{formatINR(totals.inc)}</span>
          <span className="amt-out" style={{fontSize:12}}>-{formatINR(totals.exp)}</span>
        </div>
        <select className="search-sort" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="date-desc">Newest</option>
          <option value="date-asc">Oldest</option>
          <option value="amount-desc">Highest</option>
          <option value="amount-asc">Lowest</option>
        </select>
      </div>

      {/* Results — always flat list since we already filter */}
      <TxnList transactions={filtered} onDelete={deleteTransaction} flat={!!(q||hasFilters)} />
      <div style={{height:20}} />
    </div>
  );
}
