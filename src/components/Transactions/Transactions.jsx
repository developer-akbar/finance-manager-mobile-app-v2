import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseDate, formatINR, calcTotals, groupByDate, txnType, txnAmount } from '../../utils/format.js';
import TransactionItem from './TransactionItem.jsx';
import AddTransaction from './AddTransaction.jsx';
import useSwipe from '../../hooks/useSwipe.js';
import './Transactions.css';

// ── BulkSelectionBar — reusable selection bar with delete ────────────────────
export function BulkSelectionBar({ selected, selTotals, allTxns, onDone, onDeleted }) {
  const { deleteTransaction } = useApp();
  const [confirm, setConfirm] = React.useState(false);
  const selArr = allTxns.filter(t => selected.has(t._id));
  if (!selected.size) return null;
  return (
    <>
      <div className="search-sel-bar">
        <div style={{display:'flex',alignItems:'center',gap:6,flex:1,flexWrap:'wrap'}}>
          <span style={{fontWeight:800,fontSize:'0.82rem'}}>{selected.size} selected</span>
          {selTotals.inc > 0 && <span className="sel-total-inc">+{formatINR(selTotals.inc)}</span>}
          {selTotals.exp > 0 && <span className="sel-total-exp">−{formatINR(selTotals.exp)}</span>}
          {selTotals.xfr > 0 && <span className="sel-total-xfr">⇄{formatINR(selTotals.xfr)}</span>}
          {(selTotals.inc > 0 || selTotals.exp > 0) && (
            <span className="sel-total-net" style={{color:selTotals.inc-selTotals.exp>=0?'var(--income)':'var(--expense)'}}>
              = {selTotals.inc-selTotals.exp>=0?'+':'−'}{formatINR(Math.abs(selTotals.inc-selTotals.exp))}
            </span>
          )}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}}>
          <button onClick={()=>setConfirm(true)}
            style={{background:'none',border:'none',cursor:'pointer',padding:'4px',display:'flex',alignItems:'center',color:'var(--expense)'}}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="18" height="18"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
          <button style={{background:'none',border:'none',color:'var(--accent)',fontWeight:700,cursor:'pointer',fontSize:'0.82rem'}} onClick={onDone}>Done</button>
        </div>
      </div>
      {confirm && (
        <>
          <div className="overlay" onClick={()=>setConfirm(false)}/>
          <div className="bottom-sheet" style={{paddingBottom:'calc(var(--safe-bottom) + 16px)'}}>
            <div className="sheet-handle"/>
            <div style={{fontWeight:800,fontSize:'0.95rem',marginBottom:6}}>Delete {selected.size} transaction{selected.size>1?'s':''}?</div>
            <div style={{fontSize:'0.73rem',color:'var(--text-muted)',marginBottom:12}}>This cannot be undone.</div>
            <div style={{maxHeight:'40dvh',overflowY:'auto',marginBottom:14,borderRadius:8,border:'1px solid var(--border-light)'}}>
              {selArr.map(t=>(
                <div key={t._id} style={{display:'flex',justifyContent:'space-between',padding:'7px 12px',borderBottom:'1px solid var(--border-light)',fontSize:'0.75rem'}}>
                  <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',paddingRight:8,color:'var(--text-primary)'}}>
                    {t.Note||t.Category||'—'} · {t.Date}
                  </span>
                  <span style={{color:'var(--expense)',flexShrink:0,fontFamily:'var(--font)',fontWeight:600}}>−{formatINR(t.INR||0)}</span>
                </div>
              ))}
            </div>
            <div style={{display:'flex',gap:10}}>
              <button className="btn btn-ghost btn-full" onClick={()=>setConfirm(false)}>Cancel</button>
              <button className="btn btn-danger btn-full" onClick={async()=>{
                for (const id of [...selected]) await deleteTransaction(id);
                setConfirm(false);
                onDeleted();
              }}>Delete {selected.size}</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}


const MONTHS_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_F = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Date-grouped list ─────────────────────────────────────────────────────────
function DateGroupedList({ isActive, txns, onDateTap, selected, multiMode, onLongPress, onTap, backInterceptRef, onCopy }) {
  const closestRef = useRef(null);
  const hasScrolledInitial = useRef(false);

  const groups = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Group transactions by date
    const groupedByDate = groupByDate(txns, false); // Pass false to disable sorting in groupByDate

    // Sort the date groups by descending date
    const sortedGroups = Object.entries(groupedByDate).sort(([dateA], [dateB]) => {
      const d1 = parseDate(dateA);
      const d2 = parseDate(dateB);
      return d2 - d1;
    });

    // Find the closest date to today
    let closestDk = null;
    let minDiff = Infinity;
    for (const [dk] of sortedGroups) {
      const d = parseDate(dk);
      d.setHours(0, 0, 0, 0);
      const diff = Math.abs(d - today);
      if (diff < minDiff) {
        minDiff = diff;
        closestDk = dk;
      }
    }

    return { sortedGroups, closestDk };
  }, [txns]);

  useEffect(() => {
    if (isActive && closestRef.current && !hasScrolledInitial.current) {
      hasScrolledInitial.current = true;
      // Scroll instantly so the user doesn't even see the transition
      closestRef.current.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }, [isActive, groups.closestDk]);

  useEffect(() => {
    const handleScrollToToday = () => {
      if (closestRef.current) {
        closestRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    window.addEventListener('scroll-to-today', handleScrollToToday);
    return () => window.removeEventListener('scroll-to-today', handleScrollToToday);
  }, [groups.closestDk]);

  return <>
    {groups.sortedGroups.map(([dk, list]) => {
      const gt = calcTotals(list);
      const d  = parseDate(list[0].Date);
      const isClosest = dk === groups.closestDk;
      return (
        <div key={dk} ref={isClosest ? closestRef : null} className="date-group-container">
          <div className="dg-header" onClick={() => onDateTap && onDateTap(list[0].Date)}>
            <div className="dg-left">
              <div className="dg-day">{d.getDate()}</div>
              <div className="dg-meta">
                <div className="dg-wday">{d.toLocaleDateString('en-IN',{weekday:'short'}).toUpperCase()}</div>
                <div className="dg-month">{MONTHS_S[d.getMonth()]} {d.getFullYear()}</div>
              </div>
            </div>
            <div className="dg-totals">
              {gt.income  > 0 && <span className="dg-inc">+{formatINR(gt.income)}</span>}
              {gt.expense > 0 && <span className="dg-exp">−{formatINR(gt.expense)}</span>}
            </div>
          </div>
          <div className="dg-items">
            {list.map(t => <TransactionItem key={t._id} transaction={t}
              selected={selected.has(t._id)}
              backInterceptRef={backInterceptRef}
              onLongPress={onLongPress}
              onTap={onTap}
              onCopy={onCopy}
            />)}
          </div>
        </div>
      );
    })}
    <div style={{height:80}}/>
  </>;
}

// ── Monthly summary ───────────────────────────────────────────────────────────
function MonthlyView({ transactions, year, setYear, onMonthClick }) {
  const now = new Date();

  const prevYear = () => setYear(y => y - 1);
  const nextYear = () => setYear(y => y + 1);
  const swipe = useSwipe(nextYear, prevYear);

  const data = useMemo(() =>
    MONTHS_S.map((s, mi) => {
      const txns = transactions.filter(t => { const d=parseDate(t.Date); return d.getFullYear()===year&&d.getMonth()===mi; });
      const tot  = calcTotals(txns);
      return { s, mi, income:tot.income, expense:tot.expense, net:tot.balance, count:txns.length };
    }), [transactions, year]);

  const totals = data.reduce((a,m) => ({ income:a.income+m.income, expense:a.expense+m.expense }), {income:0,expense:0});

  return (
    <div className="txn-monthly-list" style={{overflow:'auto',flex:1}} {...swipe}>
      <div className="txn-month-row">
        <button className="pp-arrow" onClick={prevYear}>‹</button>
        <div className="pp-label">{year}</div>
        <button className="pp-arrow" onClick={nextYear}>›</button>
      </div>
      <div className="bal-strip">
        <div className="bal-strip-item"><div className="bal-strip-l">Income</div><div className="bal-strip-v" style={{color:'var(--income)'}}>{formatINR(totals.income)}</div></div>
        <div className="bal-strip-div"/>
        <div className="bal-strip-item"><div className="bal-strip-l">Expenses</div><div className="bal-strip-v" style={{color:'var(--expense)'}}>{formatINR(totals.expense)}</div></div>
        <div className="bal-strip-div"/>
        <div className="bal-strip-item"><div className="bal-strip-l">Net</div><div className="bal-strip-v">{formatINR(totals.income-totals.expense)}</div></div>
      </div>
      {data.map(m => (
        <div key={m.mi} className={`month-row ${m.count===0?'month-row-empty':''}`} onClick={()=>m.count&&onMonthClick(year,m.mi)}>
          <div className="month-row-name">{MONTHS_F[m.mi]}</div>
          {m.count === 0 ? <div className="month-row-none">—</div> : <>
            <div className="month-row-vals">
              {m.income  > 0 && <span className="month-row-inc">+{formatINR(m.income)}</span>}
              {m.expense > 0 && <span className="month-row-exp">−{formatINR(m.expense)}</span>}
            </div>
            <div className={`month-row-net ${m.net>=0?'pos':'neg'}`}>{m.net>=0?'+':''}{formatINR(m.net)}</div>
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" width="11" height="11"><path d="M9 18l6-6-6-6"/></svg>
          </>}
        </div>
      ))}
      <div style={{height:80}}/>
    </div>
  );
}

// ── Search view ───────────────────────────────────────────────────────────────
function SearchView({ transactions, accounts, categories, onClose, backInterceptRef, onCopy }) {
  const textInputRef = (el) => {
    if (!el) return;
    el.setAttribute('autocomplete', 'on');
    el.setAttribute('autocorrect', 'on');
    el.setAttribute('spellcheck', 'true');
    el.setAttribute('autocapitalize', 'sentences');
  };
  const [query,     setQuery]     = useState('');
  const [debouncedQ,setDebouncedQ]= useState('');
  const debTimer = useRef(null);
  const [noteSugs,  setNoteSugs]  = useState([]);
  const [showFilter,setShowFilter]= useState(false);
  const [selAccts,  setSelAccts]  = useState(new Set());
  const [selCats,   setSelCats]   = useState(new Set());
  const [selPeriod, setSelPeriod] = useState('All');
  const [periodOffset, setPeriodOffset] = useState(0); // for prev/next navigation
  const [customFrom,setFrom]      = useState('');
  const [customTo,  setTo]        = useState('');
  const [selected,  setSelected]  = useState(new Set());
  const [multiMode, setMultiMode] = useState(false);

  // Advanced Search Scope & Multi-Filter Query Builder
  const [scopeNotes, setScopeNotes] = useState(true);
  const [scopeDesc, setScopeDesc]   = useState(true);
  const [scopeTags, setScopeTags]   = useState(true);
  const [minAmount, setMinAmount]   = useState('');
  const [maxAmount, setMaxAmount]   = useState('');
  const [txnTypeFilter, setTxnTypeFilter] = useState('All'); // 'All' | 'Expense' | 'Income' | 'Transfer'
  const [onlyWarranty, setOnlyWarranty]   = useState(false);

  const now = new Date();
  const multiModePrevHandler = React.useRef(null);
  const multiModeHandler = React.useRef(null);

  const allAcctNames = useMemo(() => (accounts||[]).map(a=>a?.name||a).filter(Boolean).sort(), [accounts]);
  const allCatNames  = useMemo(() => Object.keys(categories||{}).sort(), [categories]);

  // Handle back button interception for multi-mode
  React.useEffect(() => {
    if (!backInterceptRef) return;
    if (multiMode) {
      multiModePrevHandler.current = backInterceptRef.current;
      multiModeHandler.current = () => { setMultiMode(false); setSelected(new Set()); };
      backInterceptRef.current = multiModeHandler.current;
    } else {
      if (backInterceptRef.current === multiModeHandler.current) {
        backInterceptRef.current = multiModePrevHandler.current;
        multiModePrevHandler.current = null;
        multiModeHandler.current = null;
      }
    }
  }, [multiMode]); // Removed backInterceptRef from deps

  // Reset offset when period changes
  const handlePeriodChange = (p) => { setSelPeriod(p); setPeriodOffset(0); };
  const swipe = useSwipe(
    () => canNav && setPeriodOffset(o => o - 1),
    () => canNav && setPeriodOffset(o => o + 1)
  );

  // Compute period range with offset for prev/next navigation
  const periodRange = useMemo(() => {
    if (selPeriod === 'All' || selPeriod === 'Custom') return null;
    const base = new Date(now);
    if (selPeriod === 'Weekly') {
      const end = new Date(base); end.setDate(end.getDate() - periodOffset * 7);
      const start = new Date(end); start.setDate(start.getDate() - 6);
      return { start, end };
    }
    if (selPeriod === 'Monthly') {
      let m = now.getMonth() - periodOffset;
      let y = now.getFullYear() + Math.floor(m / 12);
      m = ((m % 12) + 12) % 12;
      const start = new Date(y, m, 1);
      const end   = new Date(y, m + 1, 0, 23, 59, 59);
      return { start, end };
    }
    if (selPeriod === 'Yearly') {
      const y = now.getFullYear() - periodOffset;
      return { start: new Date(y, 0, 1), end: new Date(y, 11, 31, 23, 59, 59) };
    }
    if (selPeriod === 'FY') {
      const baseY = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      const y = baseY - periodOffset;
      return { start: new Date(y, 3, 1), end: new Date(y + 1, 2, 31, 23, 59, 59) };
    }
    return null;
  }, [selPeriod, periodOffset]);

  // Period label for display
  const periodLabel = useMemo(() => {
    if (!periodRange) return '';
    if (selPeriod === 'Weekly') {
      const s = periodRange.start, e = periodRange.end;
      return `${s.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][s.getMonth()]} – ${e.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][e.getMonth()]}`;
    }
    if (selPeriod === 'Monthly') {
      return `${['January','February','March','April','May','June','July','August','September','October','November','December'][periodRange.start.getMonth()]} ${periodRange.start.getFullYear()}`;
    }
    if (selPeriod === 'Yearly') return `${periodRange.start.getFullYear()}`;
    if (selPeriod === 'FY') return `FY ${periodRange.start.getFullYear()}–${String(periodRange.end.getFullYear()).slice(2)}`;
    return '';
  }, [periodRange, selPeriod]);

  const hasQuery = debouncedQ.trim().length > 0 || selAccts.size > 0 || selCats.size > 0 || selPeriod !== 'All' || minAmount || maxAmount || txnTypeFilter !== 'All' || onlyWarranty;

  const results = useMemo(() => {
    if (!hasQuery) return [];
    const q = debouncedQ.trim().toLowerCase();
    const minA = parseFloat(minAmount);
    const maxA = parseFloat(maxAmount);

    return transactions.filter(t => {
      const d = parseDate(t.Date);
      const amt = parseFloat(t.INR || t.Amount || 0);

      // Period filter
      if (periodRange) {
        if (d < periodRange.start || d > periodRange.end) return false;
      } else if (selPeriod === 'Custom' && customFrom && customTo) {
        if (d < new Date(customFrom) || d > new Date(customTo + 'T23:59:59')) return false;
      }

      // Amount filter
      if (!isNaN(minA) && amt < minA) return false;
      if (!isNaN(maxA) && amt > maxA) return false;

      // Type filter
      const tp = (t['Income/Expense'] || 'Expense').toLowerCase();
      if (txnTypeFilter === 'Expense' && tp !== 'expense') return false;
      if (txnTypeFilter === 'Income' && tp !== 'income') return false;
      if (txnTypeFilter === 'Transfer' && !tp.startsWith('transfer')) return false;

      // Warranty / Receipt filter
      if (onlyWarranty && !t.warranty_expiry && !t.receipt_image && !t.serial_no) return false;

      // Account & Category filter
      if (selAccts.size > 0 && !selAccts.has(t.Account) && !selAccts.has(t.FromAccount) && !selAccts.has(t.ToAccount)) return false;
      if (selCats.size > 0 && !selCats.has(t.Category)) return false;

      if (!q) return true;

      // Scoped text matching
      if (q.startsWith('#')) {
        const cleanTag = q.replace(/^#/, '');
        const tagList = (t.Tags || '').split(',').map(x => x.trim().toLowerCase().replace(/^#/, ''));
        if (scopeTags && tagList.includes(cleanTag)) return true;

        const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hashRegex = new RegExp(`(^|\\s)#${escapeRegex(cleanTag)}(\\b|\\s|$)`, 'i');
        if (scopeNotes && hashRegex.test(t.Note || '')) return true;
        if (scopeDesc && hashRegex.test(t.Description || '')) return true;
        if (scopeTags && hashRegex.test(t.Tags || '')) return true;
        return false;
      }

      // Standard text search with scope flags
      const matches = [];
      if (scopeNotes && t.Note && t.Note.toLowerCase().includes(q)) matches.push(true);
      if (scopeDesc && t.Description && t.Description.toLowerCase().includes(q)) matches.push(true);
      if (scopeTags && t.Tags && t.Tags.toLowerCase().includes(q)) matches.push(true);
      if (t.Category && t.Category.toLowerCase().includes(q)) matches.push(true);
      if (t.Subcategory && t.Subcategory.toLowerCase().includes(q)) matches.push(true);
      if (t.Account && t.Account.toLowerCase().includes(q)) matches.push(true);
      if (t.FromAccount && t.FromAccount.toLowerCase().includes(q)) matches.push(true);
      if (t.ToAccount && t.ToAccount.toLowerCase().includes(q)) matches.push(true);

      return matches.length > 0;
    }).sort((a, b) => parseDate(b.Date) - parseDate(a.Date));
  }, [transactions, debouncedQ, selPeriod, periodRange, selAccts, selCats, customFrom, customTo, minAmount, maxAmount, txnTypeFilter, onlyWarranty, scopeNotes, scopeDesc, scopeTags, hasQuery]);

  const totals = useMemo(() => {
    let inc = 0, exp = 0, xfr = 0;
    for (const t of results) {
      const tp = txnType(t), amt = txnAmount(t);
      if (tp === 'income') inc += amt;
      else if (tp === 'expense') exp += amt;
      else xfr += amt;
    }
    return { inc, exp, xfr };
  }, [results]);

  const selTotals = useMemo(() => {
    let inc = 0, exp = 0, xfr = 0;
    for (const t of results.filter(r => selected.has(r._id))) {
      const tp = txnType(t), amt = txnAmount(t);
      if (tp === 'income') inc += amt;
      else if (tp === 'expense') exp += amt;
      else xfr += amt;
    }
    return { inc, exp, xfr };
  }, [results, selected]);

  const allAvailableTags = useMemo(() => {
    const seen = new Set();
    for (const t of transactions) {
      if (t.Tags) {
        t.Tags.split(',').forEach(tag => {
          const clean = tag.trim().toLowerCase();
          if (clean) seen.add(clean.startsWith('#') ? clean : `#${clean}`);
        });
      }
      const matches = ((t.Note || '') + ' ' + (t.Description || '')).match(/#[a-zA-Z0-9_\u0900-\u097F-]+/g);
      if (matches) matches.forEach(m => seen.add(m.toLowerCase()));
    }
    try {
      const custom = JSON.parse(state.settings?.customTags || '[]');
      if (Array.isArray(custom)) {
        custom.forEach(ct => {
          const clean = String(ct).trim().toLowerCase();
          if (clean) seen.add(clean.startsWith('#') ? clean : `#${clean}`);
        });
      }
    } catch {}

    const defaults = ['#tax', '#personal', '#family', '#trip', '#impulse', '#work', '#medical'];
    defaults.forEach(d => seen.add(d));
    return Array.from(seen).slice(0, 25);
  }, [transactions, state.settings?.customTags]);

  const stripInstalment = (note) => {
    // Strip installment suffixes like "(5/12)", "(2/6)" from note suggestions
    return (note || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
  };

  const handleNoteInput = v => {
    setQuery(v);
    if (v.trim()) {
      const q = v.toLowerCase(), seen = new Set();
      const sugs = [];
      for (const t of transactions) {
        const raw = t.Note; if (!raw) continue;
        const stripped = stripInstalment(raw);
        if (!stripped.toLowerCase().includes(q)) continue;
        if (seen.has(stripped)) continue;
        seen.add(stripped);
        sugs.push(stripped);
        if (sugs.length >= 15) break;
      }
      setNoteSugs(sugs);
    } else { setNoteSugs([]); }
    // Do NOT auto-trigger search on debounce — wait for Enter or suggestion select
  };

  const triggerSearch = (v) => {
    setDebouncedQ(v ?? query);
    setNoteSugs([]);
  };

  const toggleSel  = t => setSelected(p => { const s = new Set(p); s.has(t._id) ? s.delete(t._id) : s.add(t._id); return s; });
  const toggleAcct = a => setSelAccts(p => { const s = new Set(p); s.has(a) ? s.delete(a) : s.add(a); return s; });
  const toggleCat  = c => setSelCats(p  => { const s = new Set(p); s.has(c) ? s.delete(c) : s.add(c); return s; });

  const PERIODS = ['All', 'Weekly', 'Monthly', 'Yearly', 'FY', 'Custom'];
  const canNav  = selPeriod !== 'All' && selPeriod !== 'Custom';

  return (
    <div className="search-view" {...swipe}>
      {/* Search bar */}
      <div className="search-bar-row">
        <button className="back-btn" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div className="search-input-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{width:14,height:14,flexShrink:0}}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input ref={textInputRef} autoFocus type="text" className="search-input" value={query}
            onChange={e => handleNoteInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.target.blur(); triggerSearch(); } }}
            onBlur={() => setTimeout(() => setNoteSugs([]), 180)}
            placeholder="Search note, category, account…"/>
          {(query || debouncedQ) && (
            <button className="search-clear" onClick={() => {
              setQuery(''); setDebouncedQ(''); setNoteSugs([]);
              if (debTimer.current) clearTimeout(debTimer.current);
            }}>✕</button>
          )}
          {noteSugs.length > 0 && (
            <div className="note-sug-list" style={{top:'calc(100% + 4px)'}}>
              {noteSugs.map(s => <div key={s} className="note-sug-item" onMouseDown={() => { setQuery(s); triggerSearch(s); setNoteSugs([]); }}>{s}</div>)}
            </div>
          )}
        </div>
        <button className="filter-btn" onClick={() => setShowFilter(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{width:15,height:15}}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          {(selAccts.size + selCats.size > 0 || selPeriod !== 'All') && <span className="filter-active-dot"/>}
        </button>
      </div>

      {/* Period nav bar — shown when a navigable period is selected */}
      {canNav && (
        <div className="period-nav-bar">
          <div className="period-nav-inner">
            <button className="period-nav-btn" onClick={() => setPeriodOffset(o => o + 1)}>‹</button>
            <span className="period-nav-label">{periodLabel}</span>
            <button className="period-nav-btn" onClick={() => setPeriodOffset(o => o - 1)}>›</button>
          </div>
        </div>
      )}

      {/* Multi-select summary bar */}
      {multiMode && <BulkSelectionBar selected={selected} selTotals={selTotals} allTxns={transactions}
        onDone={()=>{setMultiMode(false);setSelected(new Set());}}
        onDeleted={()=>{setMultiMode(false);setSelected(new Set());}} />}

      {/* Totals bar */}
      {hasQuery && results.length > 0 && (
        <div className="search-totals-bar">
          <div className="search-total-item"><div className="search-total-l">Income</div><div className="search-total-v" style={{color:'var(--income)'}}>{formatINR(totals.inc)}</div></div>
          <div className="search-total-item"><div className="search-total-l">Expenses</div><div className="search-total-v" style={{color:'var(--expense)'}}>{formatINR(totals.exp)}</div></div>
          <div className="search-total-item"><div className="search-total-l">Transfer</div><div className="search-total-v" style={{color:'var(--transfer)'}}>{formatINR(totals.xfr)}</div></div>
          <div className="search-total-item"><div className="search-total-l">Count</div><div className="search-total-v">{results.length}</div></div>
        </div>
      )}

      {/* Results */}
      <div className="search-list">
        {!hasQuery ? (
          <div className="empty-state" style={{ padding: '24px 16px' }}>
            <div className="empty-icon">🔍</div>
            <div className="empty-title">Search transactions</div>
            <div className="empty-desc" style={{ marginBottom: 18 }}>Type a note, category, account, or tap a tag</div>
            {allAvailableTags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', maxWidth: 360, margin: '0 auto' }}>
                {allAvailableTags.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      setQuery(tag);
                      triggerSearch(tag);
                    }}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 18,
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      border: '1px solid var(--border)',
                      background: 'var(--bg-card2)',
                      color: 'var(--accent)',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : results.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">😶</div><div className="empty-title">No results</div></div>
        ) : results.map(t => (
          <TransactionItem key={t._id} transaction={t}
            selected={selected.has(t._id)}
            showDate={true}
            backInterceptRef={backInterceptRef}
            onLongPress={tt => { setMultiMode(true); setSelected(new Set([tt._id])); }}
            onTap={multiMode ? () => toggleSel(t) : undefined}
            onCopy={onCopy}/>
        ))}
        <div style={{height: 80}}/>
      </div>

      {/* Filter sheet */}
      {showFilter && (
        <>
          <div className="overlay" onClick={() => setShowFilter(false)}/>
          <div className="bottom-sheet" style={{maxHeight:'92dvh',display:'flex',flexDirection:'column',padding:'0 0 calc(var(--safe-bottom)+12px)'}}>
            <div className="sheet-handle" style={{marginTop:14}}/>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'0 var(--page-px) 10px',borderBottom:'1px solid var(--border)'}}>
              <div style={{fontWeight:800,fontSize:'0.9rem'}}>Search &amp; Filter Options</div>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                setSelAccts(new Set()); setSelCats(new Set()); setSelPeriod('All'); setPeriodOffset(0);
                setMinAmount(''); setMaxAmount(''); setTxnTypeFilter('All'); setOnlyWarranty(false);
                setScopeNotes(true); setScopeDesc(true); setScopeTags(true);
                setShowFilter(false);
              }}>Clear all</button>
            </div>
            <div style={{overflow:'auto',flex:1,padding:'10px var(--page-px)',display:'flex',flexDirection:'column',gap:14}}>
              
              {/* Search Target Scope Checkboxes */}
              <div className="filter-section" style={{marginBottom:0}}>
                <div className="filter-section-label">Search Query In (Target Scope)</div>
                <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                  <div className="filter-check-row" style={{background:'var(--bg-card2)',padding:'6px 10px',borderRadius:8}} onClick={() => setScopeNotes(p => !p)}>
                    <div className={`filter-check-box ${scopeNotes ? 'checked' : ''}`}>{scopeNotes && '✓'}</div>
                    <div className="filter-check-label">Notes</div>
                  </div>
                  <div className="filter-check-row" style={{background:'var(--bg-card2)',padding:'6px 10px',borderRadius:8}} onClick={() => setScopeDesc(p => !p)}>
                    <div className={`filter-check-box ${scopeDesc ? 'checked' : ''}`}>{scopeDesc && '✓'}</div>
                    <div className="filter-check-label">Description</div>
                  </div>
                  <div className="filter-check-row" style={{background:'var(--bg-card2)',padding:'6px 10px',borderRadius:8}} onClick={() => setScopeTags(p => !p)}>
                    <div className={`filter-check-box ${scopeTags ? 'checked' : ''}`}>{scopeTags && '✓'}</div>
                    <div className="filter-check-label">#Tags</div>
                  </div>
                </div>
              </div>

              {/* Amount Range Filter */}
              <div className="filter-section" style={{marginBottom:0}}>
                <div className="filter-section-label">Amount Range (₹)</div>
                <div style={{display:'flex',gap:8}}>
                  <input
                    type="number"
                    className="form-input"
                    placeholder="Min ₹ (e.g. 1000)"
                    value={minAmount}
                    onChange={e => setMinAmount(e.target.value)}
                    style={{flex:1,background:'var(--bg-card2)',padding:'6px 10px',borderRadius:8,border:'1px solid var(--border)'}}
                  />
                  <input
                    type="number"
                    className="form-input"
                    placeholder="Max ₹ (e.g. 50000)"
                    value={maxAmount}
                    onChange={e => setMaxAmount(e.target.value)}
                    style={{flex:1,background:'var(--bg-card2)',padding:'6px 10px',borderRadius:8,border:'1px solid var(--border)'}}
                  />
                </div>
              </div>

              {/* Transaction Type Filter */}
              <div className="filter-section" style={{marginBottom:0}}>
                <div className="filter-section-label">Transaction Type</div>
                <div style={{display:'flex',gap:6}}>
                  {['All', 'Expense', 'Income', 'Transfer'].map(t => (
                    <button
                      key={t}
                      className={`chip ${txnTypeFilter === t ? 'active' : ''}`}
                      onClick={() => setTxnTypeFilter(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quick Presets & Warranty Toggle */}
              <div className="filter-section" style={{marginBottom:0}}>
                <div className="filter-section-label">Special Filters</div>
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  <button
                    className={`chip ${minAmount === '5000' ? 'active' : ''}`}
                    onClick={() => { setMinAmount(minAmount === '5000' ? '' : '5000'); }}
                  >
                    💎 High Value (&gt; ₹5,000)
                  </button>
                  <button
                    className={`chip ${onlyWarranty ? 'active' : ''}`}
                    onClick={() => setOnlyWarranty(p => !p)}
                  >
                    🛡️ Has Receipt / Warranty
                  </button>
                </div>
              </div>

              {/* Period Filter */}
              <div className="filter-section" style={{marginBottom:0}}>
                <div className="filter-section-label">Period</div>
                <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                  {PERIODS.map(p => <button key={p} className={`chip ${selPeriod === p ? 'active' : ''}`} onClick={() => handlePeriodChange(p)}>{p}</button>)}
                </div>
                {selPeriod === 'Custom' && (
                  <div style={{display:'flex',gap:8,marginTop:8}}>
                    <input type="date" className="form-input" style={{flex:1}} value={customFrom} onChange={e => setFrom(e.target.value)}/>
                    <input type="date" className="form-input" style={{flex:1}} value={customTo} onChange={e => setTo(e.target.value)}/>
                  </div>
                )}
              </div>

              {/* Accounts Filter */}
              {allAcctNames.length > 0 && (
                <div className="filter-section" style={{marginBottom:0}}>
                  <div className="filter-section-label">Accounts</div>
                  <div className="filter-checkbox-list">
                    {allAcctNames.map(a => (
                      <div key={a} className="filter-check-row" onClick={() => toggleAcct(a)}>
                        <div className={`filter-check-box ${selAccts.has(a) ? 'checked' : ''}`}>{selAccts.has(a) && '✓'}</div>
                        <div className="filter-check-label">{a}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Categories Filter */}
              {allCatNames.length > 0 && (() => {
                const expenseCats = allCatNames.filter(c => (categories?.[c]?.type || 'Expense') === 'Expense');
                const incomeCats  = allCatNames.filter(c => (categories?.[c]?.type || 'Expense') === 'Income');
                return (
                  <div className="filter-section" style={{marginBottom:0}}>
                    <div className="filter-section-label">Categories</div>
                    {expenseCats.length > 0 && (
                      <>
                        <div style={{fontSize:'0.6rem',fontWeight:700,color:'var(--expense)',textTransform:'uppercase',letterSpacing:'0.5px',padding:'6px 0 4px'}}>Expense</div>
                        <div className="filter-checkbox-list">
                          {expenseCats.map(c => (
                            <div key={c} className="filter-check-row" onClick={() => toggleCat(c)}>
                              <div className={`filter-check-box ${selCats.has(c) ? 'checked' : ''}`}>{selCats.has(c) && '✓'}</div>
                              <div className="filter-check-label">{c}</div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                    {incomeCats.length > 0 && (
                      <>
                        <div style={{fontSize:'0.6rem',fontWeight:700,color:'var(--income)',textTransform:'uppercase',letterSpacing:'0.5px',padding:'6px 0 4px'}}>Income</div>
                        <div className="filter-checkbox-list">
                          {incomeCats.map(c => (
                            <div key={c} className="filter-check-row" onClick={() => toggleCat(c)}>
                              <div className={`filter-check-box ${selCats.has(c) ? 'checked' : ''}`}>{selCats.has(c) && '✓'}</div>
                              <div className="filter-check-label">{c}</div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
            <div style={{padding:'10px var(--page-px) 0'}}>
              <button className="btn btn-primary btn-full" onClick={() => setShowFilter(false)}>Apply Filters</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main Transactions screen ──────────────────────────────────────────────────
export default function Transactions({ isActive, onAddTransaction, backInterceptRef, viewParams }) {
  const { state, clearNavParams } = useApp();
  const { transactions, accounts, categories } = state;
  const now = new Date();

  const [viewMode,  setViewMode]  = useState('daily');
  const [viewYear,  setViewYear]  = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [showCal,   setShowCal]   = useState(false);
  const [pickerY,   setPickerY]   = useState(now.getFullYear());
  const [addDate,   setAddDate]   = useState(null);
  const [selected,  setSelected]  = useState(new Set());
  const [multiMode, setMultiMode] = useState(false);
  const [copyTxn,       setCopyTxn]       = useState(null);

  const [showScrollTop, setShowScrollTop] = useState(false);
  const scrollRef = useRef(null);

  const multiModePrevHandler = React.useRef(null);
  const multiModeHandler = React.useRef(null);

  // Sync year and view from dashboard clicks
  useEffect(() => {
    if (viewParams) {
      if (viewParams.year !== undefined && viewParams.year !== null) {
        setViewYear(Number(viewParams.year));
      }
      if (viewParams.month !== undefined && viewParams.month !== null) {
        setViewMonth(Number(viewParams.month));
        setViewMode('daily');
      } else if (viewParams.year !== undefined && viewParams.year !== null) {
        setViewMode('monthly');
      }
      clearNavParams();
    }
  }, [viewParams, clearNavParams]);

  // Handle double-tap tab reset to Daily tab / current date
  useEffect(() => {
    const handleReset = () => {
      setViewMode('daily');
      const now = new Date();
      setViewYear(now.getFullYear());
      setViewMonth(now.getMonth());
      setPickerY(now.getFullYear());
      setMultiMode(false);
      setSelected(new Set());
    };
    window.addEventListener('reset-transactions-view', handleReset);
    return () => window.removeEventListener('reset-transactions-view', handleReset);
  }, []);

  useEffect(() => {
    const handleNavTap = () => {
      const listEl = scrollRef.current;
      const now = new Date();
      const isCurrentMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth() && viewMode === 'daily';

      if (!isCurrentMonth) {
        // Other month or mode is active
        if (listEl && listEl.scrollTop > 10) {
          // First preference: scroll to top of that month's list
          listEl.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          // Next click: go to current month daily view and scroll to today
          setViewMode('daily');
          setViewYear(now.getFullYear());
          setViewMonth(now.getMonth());
          setPickerY(now.getFullYear());
          setMultiMode(false);
          setSelected(new Set());
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('scroll-to-today'));
          }, 100);
        }
      } else {
        // Current month is active
        if (listEl && listEl.scrollTop > 10) {
          // Scroll to today's date (or closest date to today)
          window.dispatchEvent(new CustomEvent('scroll-to-today'));
        } else {
          // Already at top, scroll to absolute top of page
          if (listEl) listEl.scrollTo({ top: 0, behavior: 'smooth' });
        }
      }
    };

    window.addEventListener('transactions-nav-tap', handleNavTap);
    return () => window.removeEventListener('transactions-nav-tap', handleNavTap);
  }, [viewYear, viewMonth, viewMode]);

  const handleScroll = (e) => {
    if (e.target.scrollTop > 450) {
      setShowScrollTop(true);
    } else {
      setShowScrollTop(false);
    }
  };

  const scrollToTop = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // Handle back button interception for multi-mode
  React.useEffect(() => {
    if (!backInterceptRef) return;
    if (multiMode) {
      multiModePrevHandler.current = backInterceptRef.current;
      multiModeHandler.current = () => { setMultiMode(false); setSelected(new Set()); };
      backInterceptRef.current = multiModeHandler.current;
    } else {
      if (backInterceptRef.current === multiModeHandler.current) {
        backInterceptRef.current = multiModePrevHandler.current;
        multiModePrevHandler.current = null;
        multiModeHandler.current = null;
      }
    }
  }, [multiMode]); // Removed backInterceptRef from deps

  const prevMonth = () => { if(viewMonth===0){setViewMonth(11);setViewYear(y=>y-1);}else setViewMonth(m=>m-1); };
  const nextMonth = () => { if(viewMonth===11){setViewMonth(0);setViewYear(y=>y+1);}else setViewMonth(m=>m+1); };
  const swipe = useSwipe(nextMonth, prevMonth);
  // Only attach swipe handlers in daily mode and not in multiMode
  const swipeProps = viewMode === 'daily' && !multiMode ? swipe : {};

  const monthTxns   = useMemo(() => transactions.filter(t=>{const d=parseDate(t.Date);return d.getFullYear()===viewYear&&d.getMonth()===viewMonth;}), [transactions,viewYear,viewMonth]);
  const monthTotals = useMemo(() => calcTotals(monthTxns), [monthTxns]);

  const toggleSel = t => setSelected(p => { const s = new Set(p); s.has(t._id) ? s.delete(t._id) : s.add(t._id); return s; });

  const handleCopy = (txn) => {
    // Pass txn as-is — the copy picker in DetailSheet sets date/time based on user choice.
    setCopyTxn({ ...txn, _id: undefined });
  };

  const selTotals = useMemo(() => {
    let inc = 0, exp = 0, xfr = 0;
    for (const t of monthTxns.filter(r => selected.has(r._id))) {
      const tp = txnType(t), amt = txnAmount(t);
      if (tp === 'income') inc += amt;
      else if (tp === 'expense') exp += amt;
      else xfr += amt;
    }
    return { inc, exp, xfr };
  }, [monthTxns, selected]);

  if (viewMode==='search') return (
    <SearchView transactions={transactions} accounts={accounts} categories={categories} onClose={()=>setViewMode('daily')} backInterceptRef={backInterceptRef} onCopy={handleCopy} />
  );

  return (
    <div className="txn-screen" {...swipeProps}>
      {/* Row 1: [Daily | Monthly] on left, 🔍 on right */}
      <div className="txn-header">
        <div className="txn-view-tabs">
          <button className={`txn-view-tab ${viewMode==='daily'?'active':''}`} onClick={()=>setViewMode('daily')}>Daily</button>
          <button className={`txn-view-tab ${viewMode==='monthly'?'active':''}`} onClick={()=>setViewMode('monthly')}>Monthly</button>
        </div>
        <button className="txn-search-btn" onClick={()=>setViewMode('search')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </button>
      </div>

      {/* Row 2: Month navigator — Daily mode only */}
      {viewMode==='daily' && (
        <div className="txn-month-row">
          <button className="pp-arrow" onClick={prevMonth}>‹</button>
          <div className="month-title-btn">
            <span className="month-name">{MONTHS_F[viewMonth]}</span>
            <span className="month-yr">{viewYear}</span>
          </div>
          <button className="pp-arrow" onClick={nextMonth}>›</button>
        </div>
      )}

      {/* Row 3: Summary strip — Daily mode only */}
      {viewMode==='daily' && (
        <div className="bal-strip">
          <div className="bal-strip-item"><div className="bal-strip-l">Income</div><div className="bal-strip-v" style={{color:'var(--income)'}}>{formatINR(monthTotals.income)}</div></div>
          <div className="bal-strip-div"/>
          <div className="bal-strip-item"><div className="bal-strip-l">Expenses</div><div className="bal-strip-v" style={{color:'var(--expense)'}}>{formatINR(monthTotals.expense)}</div></div>
          <div className="bal-strip-div"/>
          <div className="bal-strip-item"><div className="bal-strip-l">Net</div><div className="bal-strip-v" style={{color:monthTotals.balance>=0?'var(--income)':'var(--expense)'}}>{monthTotals.balance>=0?'+':''}{formatINR(monthTotals.balance)}</div></div>
        </div>
      )}

      {/* Transaction list (daily) or monthly list */}
      {viewMode==='monthly' ? (
        <MonthlyView transactions={transactions} year={viewYear} setYear={setViewYear} onMonthClick={(y,mi)=>{setViewYear(y);setViewMonth(mi);setViewMode('daily');}}/>
      ) : (
        <>
          {multiMode && <BulkSelectionBar selected={selected} selTotals={selTotals} allTxns={transactions}
            onDone={()=>{setMultiMode(false);setSelected(new Set());}}
            onDeleted={()=>{setMultiMode(false);setSelected(new Set());}} />}
          <div ref={scrollRef} className="txn-list" onScroll={handleScroll}>
            {monthTxns.length===0
              ? <div className="empty-state"><div className="empty-icon">📅</div><div className="empty-title">No transactions</div><div className="empty-desc">{MONTHS_F[viewMonth]} {viewYear}</div></div>
              : <DateGroupedList isActive={isActive} txns={monthTxns} onDateTap={multiMode ? null : date=>setAddDate(date)} selected={selected} multiMode={multiMode} onLongPress={tt => { setMultiMode(true); setSelected(new Set([tt._id])); }} onTap={multiMode ? toggleSel : null} backInterceptRef={backInterceptRef} onCopy={handleCopy} />
            }
          </div>
        </>
      )}

      {/* Month picker sheet */}
      {showCal&&(
        <>
          <div className="overlay" onClick={()=>setShowCal(false)}/>
          <div className="bottom-sheet">
            <div className="sheet-handle"/>
            <div className="cal-picker-hdr">
              <button className="pp-arrow" onClick={()=>setPickerY(y=>y-1)}>‹</button>
              <div className="pp-label">{pickerY}</div>
              <button className="pp-arrow" onClick={()=>setPickerY(y=>y+1)}>›</button>
            </div>
            <div className="cal-grid">
              {MONTHS_S.map((lbl,idx)=>(
                <button key={idx} className={`cal-month-btn ${pickerY===viewYear&&idx===viewMonth?'selected':''}`}
                  onClick={()=>{setViewYear(pickerY);setViewMonth(idx);setShowCal(false);}}>
                  {lbl}
                </button>
              ))}
            </div>
            <div style={{height:16}}/>
          </div>
        </>
      )}

      {addDate&&<AddTransaction prefillDate={addDate} onClose={()=>setAddDate(null)} onSaveAndContinue={() => setAddDate(addDate)} backInterceptRef={backInterceptRef}/>}
      {copyTxn&&<AddTransaction 
        copyTransaction={copyTxn}
        onClose={()=>setCopyTxn(null)} 
        onSaveAndContinue={() => setCopyTxn({...copyTxn, _id: undefined})}
        backInterceptRef={backInterceptRef}
      />}

      {/* Floating FAB — bottom left */}
      <button className="trans-fab" onClick={onAddTransaction}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  );
}