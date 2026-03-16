import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseDate, formatINR, calcTotals, groupByDate, txnType, txnAmount } from '../../utils/format.js';
import TransactionItem from './TransactionItem.jsx';
import AddTransaction from './AddTransaction.jsx';
import useSwipe from '../../hooks/useSwipe.js';
import './Transactions.css';

const MONTHS_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_F = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Date-grouped list ─────────────────────────────────────────────────────────
function DateGroupedList({ txns, onDateTap, selected, multiMode, onLongPress, onTap, backInterceptRef, onCopy }) {
  const closestRef = useRef(null);

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
    if (closestRef.current) {
      closestRef.current.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
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
function MonthlyView({ transactions, onMonthClick }) {
  const [year, setYear] = useState(new Date().getFullYear());
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
    <div style={{overflow:'auto',flex:1}} {...swipe}>
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

  const hasQuery = debouncedQ.trim().length > 0 || selAccts.size > 0 || selCats.size > 0 || selPeriod !== 'All';

  const results = useMemo(() => {
    if (!hasQuery) return [];
    const q = debouncedQ.trim().toLowerCase();
    return transactions.filter(t => {
      const d = parseDate(t.Date);
      if (periodRange) {
        if (d < periodRange.start || d > periodRange.end) return false;
      } else if (selPeriod === 'Custom' && customFrom && customTo) {
        if (d < new Date(customFrom) || d > new Date(customTo + 'T23:59:59')) return false;
      }
      if (selAccts.size > 0 && !selAccts.has(t.Account) && !selAccts.has(t.FromAccount) && !selAccts.has(t.ToAccount)) return false;
      if (selCats.size > 0 && !selCats.has(t.Category)) return false;
      if (!q) return true;
      return [t.Note, t.Category, t.Account, t.Subcategory, t.Description, t.FromAccount, t.ToAccount]
        .some(f => f && f.toLowerCase().includes(q));
    }).sort((a, b) => parseDate(b.Date) - parseDate(a.Date));
  }, [transactions, debouncedQ, selPeriod, periodRange, selAccts, selCats, customFrom, customTo, hasQuery]);

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
        if (sugs.length >= 6) break;
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
          <input autoFocus type="text" className="search-input" value={query}
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
      {multiMode && selected.size > 0 && (
        <div className="search-sel-bar">
          <div style={{display:'flex',alignItems:'center',gap:6,flex:1,flexWrap:'wrap'}}>
            <span style={{fontWeight:800,fontSize:'0.82rem'}}>{selected.size} selected</span>
            {selTotals.inc > 0 && <span className="sel-total-inc">+{formatINR(selTotals.inc)}</span>}
            {selTotals.exp > 0 && <span className="sel-total-exp">−{formatINR(selTotals.exp)}</span>}
            {selTotals.xfr > 0 && <span className="sel-total-xfr">⇄{formatINR(selTotals.xfr)}</span>}
            {(selTotals.inc > 0 || selTotals.exp > 0) && (
              <span className="sel-total-net" style={{color: selTotals.inc - selTotals.exp >= 0 ? 'var(--income)' : 'var(--expense)'}}>
                = {selTotals.inc - selTotals.exp >= 0 ? '+' : '−'}{formatINR(Math.abs(selTotals.inc - selTotals.exp))}
              </span>
            )}
          </div>
          <button style={{background:'none',border:'none',color:'var(--accent)',fontWeight:700,cursor:'pointer',flexShrink:0,fontSize:'0.82rem'}} onClick={() => { setMultiMode(false); setSelected(new Set()); }}>Done</button>
        </div>
      )}

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
          <div className="empty-state">
            <div className="empty-icon">🔍</div>
            <div className="empty-title">Search transactions</div>
            <div className="empty-desc">Type a note, category, or account</div>
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
              <div style={{fontWeight:800,fontSize:'0.9rem'}}>Filters</div>
              <button className="btn btn-ghost btn-sm" onClick={() => { setSelAccts(new Set()); setSelCats(new Set()); setSelPeriod('All'); setPeriodOffset(0); setShowFilter(false); }}>Clear all</button>
            </div>
            <div style={{overflow:'auto',flex:1,padding:'10px var(--page-px)'}}>
              <div className="filter-section">
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
              {allAcctNames.length > 0 && (
                <div className="filter-section">
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
              {allCatNames.length > 0 && (() => {
                const expenseCats = allCatNames.filter(c => (categories?.[c]?.type || 'Expense') === 'Expense');
                const incomeCats  = allCatNames.filter(c => (categories?.[c]?.type || 'Expense') === 'Income');
                return (
                  <div className="filter-section">
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
              <button className="btn btn-primary btn-full" onClick={() => setShowFilter(false)}>Apply</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main Transactions screen ──────────────────────────────────────────────────
export default function Transactions({ onAddTransaction, backInterceptRef }) {
  const { state } = useApp();
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
  const [copyTxn,   setCopyTxn]   = useState(null);

  const multiModePrevHandler = React.useRef(null);
  const multiModeHandler = React.useRef(null);

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
    // Create a copy with current date/time but keep all other data
    setCopyTxn({
      ...txn,
      Date: new Date().toISOString().split('T')[0], // Current date
      Time: new Date().toTimeString().slice(0, 5), // Current time (HH:MM)
      _id: undefined, // Remove ID so it gets a new one
    });
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
        <MonthlyView transactions={transactions} onMonthClick={(y,mi)=>{setViewYear(y);setViewMonth(mi);setViewMode('daily');}}/>
      ) : (
        <>
          {multiMode && selected.size > 0 && (
            <div className="search-sel-bar">
              <div style={{display:'flex',alignItems:'center',gap:6,flex:1,flexWrap:'wrap'}}>
                <span style={{fontWeight:800,fontSize:'0.82rem'}}>{selected.size} selected</span>
                {selTotals.inc > 0 && <span className="sel-total-inc">+{formatINR(selTotals.inc)}</span>}
                {selTotals.exp > 0 && <span className="sel-total-exp">−{formatINR(selTotals.exp)}</span>}
                {selTotals.xfr > 0 && <span className="sel-total-xfr">⇄{formatINR(selTotals.xfr)}</span>}
                {(selTotals.inc > 0 || selTotals.exp > 0) && (
                  <span className="sel-total-net" style={{color: selTotals.inc - selTotals.exp >= 0 ? 'var(--income)' : 'var(--expense)'}}>
                    = {selTotals.inc - selTotals.exp >= 0 ? '+' : '−'}{formatINR(Math.abs(selTotals.inc - selTotals.exp))}
                  </span>
                )}
              </div>
              <button style={{background:'none',border:'none',color:'var(--accent)',fontWeight:700,cursor:'pointer',flexShrink:0,fontSize:'0.82rem'}} onClick={() => { setMultiMode(false); setSelected(new Set()); }}>Done</button>
            </div>
          )}
          <div className="txn-list">
            {monthTxns.length===0
              ? <div className="empty-state"><div className="empty-icon">📅</div><div className="empty-title">No transactions</div><div className="empty-desc">{MONTHS_F[viewMonth]} {viewYear}</div></div>
              : <DateGroupedList txns={monthTxns} onDateTap={multiMode ? null : date=>setAddDate(date)} selected={selected} multiMode={multiMode} onLongPress={tt => { setMultiMode(true); setSelected(new Set([tt._id])); }} onTap={multiMode ? toggleSel : null} backInterceptRef={backInterceptRef} onCopy={handleCopy} />
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