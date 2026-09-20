import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { parseDate, formatINR, calcTotals, calcReportingTotals, groupByDate, txnType, txnAmount, inputToStorage, isSystemTag, getUserFacingTags, normalizeSuggestionQuery } from '../../utils/format.js';
import TransactionItem from './TransactionItem.jsx';
import AddTransaction from './AddTransaction.jsx';
import TransactionSyncModal from './TransactionSyncModal.jsx';
import { bundleRelatedTransactions, serializeTransactions } from '../../utils/finmanPayload.js';
import { toast } from '../Common/Toast.jsx';
import useSwipe from '../../hooks/useSwipe.js';
import './Transactions.css';

// ── BulkSelectionBar — reusable selection bar with delete & edit ────────────────────
export function BulkSelectionBar({ selected, setSelected, selTotals, allTxns, onDone, onDeleted }) {
  const { deleteTransaction, updateTransaction, state } = useApp();
  const { accounts, categories } = state;

  const [confirm, setConfirm] = React.useState(false);
  const [showEditSheet, setShowEditSheet] = React.useState(false);
  const [updating, setUpdating] = React.useState(false);
  const [progress, setProgress] = React.useState(0);

  // Checkboxes next to each field
  const [updDate, setUpdDate] = React.useState(false);
  const [updType, setUpdType] = React.useState(false);
  const [updAcct, setUpdAcct] = React.useState(false);
  const [updToAcct, setUpdToAcct] = React.useState(false);
  const [updCat, setUpdCat] = React.useState(false);
  const [updSubcat, setUpdSubcat] = React.useState(false);
  const [updNote, setUpdNote] = React.useState(false);

  // Field values
  const [dateVal, setDateVal] = React.useState('');
  const [typeVal, setTypeVal] = React.useState('Expense');
  const [acctVal, setAcctVal] = React.useState('');
  const [toAcctVal, setToAcctVal] = React.useState('');
  const [catVal, setCatVal] = React.useState('');
  const [subcatVal, setSubcatVal] = React.useState('');
  const [noteVal, setNoteVal] = React.useState('');

  const selArr = allTxns.filter(t => selected.has(t._id));

  // Escape key listener for bulk edit & delete confirmation sheets
  React.useEffect(() => {
    if (!confirm && !showEditSheet) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.stopPropagation();
        if (confirm) setConfirm(false);
        if (showEditSheet) setShowEditSheet(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [confirm, showEditSheet]);

  const handleBulkCopy = async () => {
    try {
      const selTxns = allTxns.filter(t => selected.has(t._id));
      if (!selTxns.length) return;
      const bundled = bundleRelatedTransactions(selTxns, state.transactions || allTxns);
      const payloadText = serializeTransactions(bundled.transactions, {
        source: 'FinMan',
        exportedAt: new Date().toISOString()
      });
      await navigator.clipboard.writeText(payloadText);
      if (bundled.linkedCount > 0) {
        toast.success(`Copied ${bundled.selectedCount} selected + ${bundled.linkedCount} linked item${bundled.linkedCount > 1 ? 's' : ''}`);
      } else {
        toast.success(`Copied ${bundled.selectedCount} transaction${bundled.selectedCount > 1 ? 's' : ''}`);
      }
      onDone();
    } catch (err) {
      console.error('Bulk copy failed:', err);
      toast.error('Copy to clipboard failed.');
    }
  };

  const filteredCategories = useMemo(() => {
    const wantType = typeVal;
    return Object.entries(categories || {})
      .filter(([, d]) => (d?.type || 'Expense') === wantType)
      .map(([n]) => n)
      .sort();
  }, [categories, typeVal]);

  const subcategoriesList = useMemo(() => {
    return (categories?.[catVal]?.subcategories || []).filter(s => s && s !== 'Default').sort();
  }, [categories, catVal]);

  const allVisibleIds = allTxns.map(tx => tx._id);
  const allSel = allVisibleIds.length > 0 && allVisibleIds.every(id => selected.has(id));
  const isIndeterminate = !allSel && allVisibleIds.some(id => selected.has(id));

  const handleSelectAllToggle = () => {
    if (allSel) {
      setSelected(prev => {
        const next = new Set(prev);
        allVisibleIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setSelected(prev => {
        const next = new Set(prev);
        allVisibleIds.forEach(id => next.add(id));
        return next;
      });
    }
  };

  const handleSaveBulk = async () => {
    setUpdating(true);
    setProgress(0);
    const ids = [...selected];
    const total = ids.length;
    
    for (let i = 0; i < total; i++) {
      const id = ids[i];
      const t = allTxns.find(x => x._id === id);
      if (!t) continue;
      
      // Start with the existing transaction data to prevent blanking out any fields!
      const payload = { ...t };
      
      if (updDate && dateVal) {
        payload.Date = inputToStorage(dateVal);
      }
      if (updNote) {
        payload.Note = noteVal;
      }
      if (updType) {
        payload['Income/Expense'] = typeVal; // 'Income', 'Expense', or 'Transfer'
        if (typeVal !== 'Transfer') {
          payload.ToAccount = '';
          payload.ToAccountGroup = '';
          payload.ToAccountOrder = '';
        }
      }
      if (updAcct && acctVal) {
        const acctObj = accounts.find(a => a.name === acctVal);
        if (acctObj) {
          payload.Account = acctObj.name;
          payload.AccountGroup = acctObj.group;
          payload.AccountOrder = acctObj.account_order;
          payload.AccountGroupOrder = acctObj.group_order;
          payload.FromAccount = acctObj.name;
          payload.FromAccountGroup = acctObj.group;
          payload.FromAccountOrder = acctObj.account_order;
        }
      }
      if (updToAcct && toAcctVal) {
        const destObj = accounts.find(a => a.name === toAcctVal);
        if (destObj) {
          payload.ToAccount = destObj.name;
          payload.ToAccountGroup = destObj.group;
          payload.ToAccountOrder = destObj.account_order;
          payload.Category = destObj.name;
        }
      }
      if (updCat && catVal) {
        payload.Category = catVal;
      }
      if (updSubcat) {
        payload.Subcategory = subcatVal;
      }
      
      await updateTransaction(id, payload);
      setProgress(Math.round(((i + 1) / total) * 100));
    }
    
    setUpdating(false);
    setShowEditSheet(false);
    onDone(); // Clears selection mode
  };

  return (
    <>
      <div className="search-sel-bar">
        <div style={{display:'flex',alignItems:'center',gap:6,flex:1,flexWrap:'wrap'}}>
          <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',userSelect:'none'}}>
            <input 
              type="checkbox" 
              checked={allSel}
              ref={el => {
                if (el) el.indeterminate = isIndeterminate;
              }}
              onChange={handleSelectAllToggle}
              style={{ cursor: 'pointer', transform: 'scale(1.2)', accentColor: 'var(--accent)' }}
              title={allSel ? "Deselect All Visible" : "Select All Visible"}
            />
            <span style={{fontWeight:800,fontSize:'0.82rem'}}>
              {selected.size} of {allVisibleIds.length} selected
            </span>
          </label>
          {selTotals.inc > 0 && <span className="sel-total-inc">+{formatINR(selTotals.inc)}</span>}
          {selTotals.exp > 0 && <span className="sel-total-exp">−{formatINR(selTotals.exp)}</span>}
          {selTotals.xfr > 0 && <span className="sel-total-xfr">⇄{formatINR(selTotals.xfr)}</span>}
          {(selTotals.inc > 0 || selTotals.exp > 0) && (
            <span className="sel-total-net" style={{color:selTotals.inc-selTotals.exp>=0?'var(--income)':'var(--expense)'}}>
              = {selTotals.inc-selTotals.exp>=0?'+':'−'}{formatINR(Math.abs(selTotals.inc-selTotals.exp))}
            </span>
          )}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0,position:'relative'}}>
          {selected.size > 0 && (
            <>
              <button onClick={handleBulkCopy}
                style={{background:'none',border:'none',cursor:'pointer',padding:'4px',display:'flex',alignItems:'center',color:'var(--accent)'}}
                title="Copy Selected (FinMan Sync Payload)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" width="18" height="18">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>

              <button onClick={()=>setShowEditSheet(true)}
                style={{background:'none',border:'none',cursor:'pointer',padding:'4px',display:'flex',alignItems:'center',color:'var(--text-secondary)'}}
                title="Bulk Edit Fields">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" width="18" height="18"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              
              <button onClick={()=>setConfirm(true)}
                style={{background:'none',border:'none',cursor:'pointer',padding:'4px',display:'flex',alignItems:'center',color:'var(--expense)'}}
                title="Delete Selected">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="18" height="18"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              </button>
            </>
          )}
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

      {showEditSheet && (
        <>
          <div className="overlay" onClick={()=>setShowEditSheet(false)}/>
          <div className="bottom-sheet" style={{paddingBottom:'calc(var(--safe-bottom) + 16px)', zIndex: 10000}}>
            <div className="sheet-handle"/>
            <div style={{fontWeight:800,fontSize:'0.95rem',marginBottom:10}}>Bulk Edit Transactions</div>
            <div style={{maxHeight:'55dvh',overflowY:'auto',display:'flex',flexDirection:'column',gap:14,padding:'4px 2px',marginBottom:16}}>
              
              {/* Note field */}
              <div style={{display:'flex',flexDirection:'column',gap:4}}>
                <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'0.75rem',fontWeight:700,cursor:'pointer'}}>
                  <input type="checkbox" checked={updNote} onChange={e=>setUpdNote(e.target.checked)} />
                  Update Notes
                </label>
                {updNote && (
                  <input 
                    type="text" 
                    value={noteVal} 
                    onChange={e=>setNoteVal(e.target.value)} 
                    placeholder="Enter note/description..."
                    style={{padding:'9px 12px',borderRadius:8,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)',fontSize:'0.8rem',outline:'none'}}
                  />
                )}
              </div>

              {/* Date field */}
              <div style={{display:'flex',flexDirection:'column',gap:4}}>
                <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'0.75rem',fontWeight:700,cursor:'pointer'}}>
                  <input type="checkbox" checked={updDate} onChange={e=>setUpdDate(e.target.checked)} />
                  Update Date
                </label>
                {updDate && (
                  <input 
                    type="date" 
                    value={dateVal} 
                    onChange={e=>setDateVal(e.target.value)}
                    style={{padding:'9px 12px',borderRadius:8,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)',fontSize:'0.8rem',outline:'none',fontFamily:'var(--font)'}}
                  />
                )}
              </div>

              {/* Type Context Selector */}
              <div style={{display:'flex',flexDirection:'column',gap:6,background:'var(--bg-surface-hover, rgba(255,255,255,0.03))',padding:10,borderRadius:10,border:'1px solid var(--border-light)'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                  <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'0.75rem',fontWeight:700,cursor:'pointer'}}>
                    <input type="checkbox" checked={updType} onChange={e=>setUpdType(e.target.checked)} />
                    Update Transaction Type
                  </label>
                  <span style={{fontSize:'0.65rem',color:'var(--text-muted)',fontWeight:600}}>
                    {updType ? 'Overwriting types' : 'Display context only'}
                  </span>
                </div>
                <div style={{display:'flex',gap:6,marginTop:4}}>
                  {['Expense', 'Income', 'Transfer'].map(t => (
                    <button 
                      key={t}
                      type="button"
                      onClick={() => {
                        setTypeVal(t);
                        setCatVal('');
                        setSubcatVal('');
                      }}
                      className={`portfolio-chip-btn ${typeVal === t ? 'active' : ''}`}
                      style={{flex:1,padding:'6px 0',fontSize:'0.74rem'}}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* From Account / Account field */}
              {typeVal !== 'Transfer' ? (
                <div style={{display:'flex',flexDirection:'column',gap:4}}>
                  <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'0.75rem',fontWeight:700,cursor:'pointer'}}>
                    <input type="checkbox" checked={updAcct} onChange={e=>setUpdAcct(e.target.checked)} />
                    Update Account
                  </label>
                  {updAcct && (
                    <select 
                      value={acctVal} 
                      onChange={e=>setAcctVal(e.target.value)}
                      style={{padding:'9px 12px',borderRadius:8,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)',fontSize:'0.8rem',outline:'none'}}
                    >
                      <option value="">Select Account...</option>
                      {(accounts || []).map(a => (
                        <option key={a.id || a.name} value={a.name}>{a.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              ) : (
                <>
                  {/* From Account */}
                  <div style={{display:'flex',flexDirection:'column',gap:4}}>
                    <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'0.75rem',fontWeight:700,cursor:'pointer'}}>
                      <input type="checkbox" checked={updAcct} onChange={e=>setUpdAcct(e.target.checked)} />
                      Update From Account
                    </label>
                    {updAcct && (
                      <select 
                        value={acctVal} 
                        onChange={e=>setAcctVal(e.target.value)}
                        style={{padding:'9px 12px',borderRadius:8,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)',fontSize:'0.8rem',outline:'none'}}
                      >
                        <option value="">Select From Account...</option>
                        {(accounts || []).map(a => (
                          <option key={a.id || a.name} value={a.name}>{a.name}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* To Account */}
                  <div style={{display:'flex',flexDirection:'column',gap:4}}>
                    <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'0.75rem',fontWeight:700,cursor:'pointer'}}>
                      <input type="checkbox" checked={updToAcct} onChange={e=>setUpdToAcct(e.target.checked)} />
                      Update To Account
                    </label>
                    {updToAcct && (
                      <select 
                        value={toAcctVal} 
                        onChange={e=>setToAcctVal(e.target.value)}
                        style={{padding:'9px 12px',borderRadius:8,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)',fontSize:'0.8rem',outline:'none'}}
                      >
                        <option value="">Select To Account...</option>
                        {(accounts || []).map(a => (
                          <option key={a.id || a.name} value={a.name}>{a.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </>
              )}

              {/* Category & Subcategory (only shown for Expense / Income) */}
              {typeVal !== 'Transfer' && (
                <>
                  {/* Category */}
                  <div style={{display:'flex',flexDirection:'column',gap:4}}>
                    <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'0.75rem',fontWeight:700,cursor:'pointer'}}>
                      <input type="checkbox" checked={updCat} onChange={e=>setUpdCat(e.target.checked)} />
                      Update Category
                    </label>
                    {updCat && (
                      <select 
                        value={catVal} 
                        onChange={e=>setCatVal(e.target.value)}
                        style={{padding:'9px 12px',borderRadius:8,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)',fontSize:'0.8rem',outline:'none'}}
                      >
                        <option value="">Select Category...</option>
                        {filteredCategories.map(c => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Subcategory */}
                  <div style={{display:'flex',flexDirection:'column',gap:4}}>
                    <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'0.75rem',fontWeight:700,cursor:'pointer'}}>
                      <input type="checkbox" checked={updSubcat} onChange={e=>setUpdSubcat(e.target.checked)} />
                      Update Subcategory
                    </label>
                    {updSubcat && (
                      subcategoriesList.length > 0 ? (
                        <select 
                          value={subcatVal} 
                          onChange={e=>setSubcatVal(e.target.value)}
                          style={{padding:'9px 12px',borderRadius:8,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)',fontSize:'0.8rem',outline:'none'}}
                        >
                          <option value="">Select Subcategory...</option>
                          <option value="Default">Default</option>
                          {subcategoriesList.map(s => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      ) : (
                        <input 
                          type="text" 
                          value={subcatVal} 
                          onChange={e=>setSubcatVal(e.target.value)} 
                          placeholder="Enter subcategory..."
                          style={{padding:'9px 12px',borderRadius:8,border:'1px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)',fontSize:'0.8rem',outline:'none'}}
                        />
                      )
                    )}
                  </div>
                </>
              )}

            </div>

            <div style={{display:'flex',gap:10}}>
              <button className="btn btn-ghost btn-full" onClick={()=>setShowEditSheet(false)}>Cancel</button>
              <button 
                className="btn btn-primary btn-full" 
                onClick={handleSaveBulk}
                disabled={!(updDate || updType || updAcct || updToAcct || updCat || updSubcat || updNote)}
              >
                Apply Changes
              </button>
            </div>
          </div>
        </>
      )}

      {updating && (
        <>
          <div className="overlay" style={{zIndex: 20000}} />
          <div className="bottom-sheet" style={{padding:'32px 16px', textAlign:'center', zIndex: 20001}}>
            <div className="loader-spinner" style={{margin:'0 auto 16px'}} />
            <div style={{fontWeight:800,fontSize:'0.95rem',marginBottom:4}}>Updating transactions...</div>
            <div style={{fontSize:'0.74rem',color:'var(--text-muted)'}}>{progress}% completed</div>
          </div>
        </>
      )}
    </>
  );
}




const MONTHS_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_F = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Date-grouped list ─────────────────────────────────────────────────────────
function DateGroupedList({ isActive, txns, onDateTap, selected, multiMode, onLongPress, onTap, onToggleDate, backInterceptRef, onCopy }) {
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
      const gt = calcReportingTotals(list);
      const d  = parseDate(list[0].Date);
      const isClosest = dk === groups.closestDk;
      const groupIds = list.map(t => t._id);
      const allDateSel = groupIds.length > 0 && groupIds.every(id => selected.has(id));
      const isDateIndeterminate = !allDateSel && groupIds.some(id => selected.has(id));

      const handleGroupToggle = (e) => {
        e?.stopPropagation?.();
        if (onToggleDate) {
          onToggleDate(groupIds, allDateSel);
        }
      };

      return (
        <div key={dk} ref={isClosest ? closestRef : null} className="date-group-container">
          <div
            className="dg-header"
            onClick={multiMode ? handleGroupToggle : (() => onDateTap && onDateTap(list[0].Date))}
          >
            <div className="dg-left">
              <div className="dg-day">{d.getDate()}</div>
              <div className="dg-meta">
                <div className="dg-wday">{d.toLocaleDateString('en-IN',{weekday:'short'}).toUpperCase()}</div>
                <div className="dg-month">{MONTHS_S[d.getMonth()]} {d.getFullYear()}</div>
              </div>
            </div>
            <div className="dg-right" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="dg-totals">
                {gt.income  > 0 && <span className="dg-inc">+{formatINR(gt.income)}</span>}
                {gt.expense > 0 && <span className="dg-exp">−{formatINR(gt.expense)}</span>}
              </div>
              {multiMode && (
                <div
                  className="dg-select-box"
                  onClick={handleGroupToggle}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <input
                    type="checkbox"
                    checked={allDateSel}
                    ref={el => { if (el) el.indeterminate = isDateIndeterminate; }}
                    onChange={handleGroupToggle}
                    style={{ cursor: 'pointer', transform: 'scale(1.2)', accentColor: 'var(--accent)' }}
                    title={allDateSel ? 'Deselect date' : 'Select all for date'}
                  />
                </div>
              )}
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
      const tot  = calcReportingTotals(txns);
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
  const { state } = useApp();
  const textInputRef = (el) => {
    if (!el) return;
    el.setAttribute('autocomplete', 'on');
    el.setAttribute('autocorrect', 'on');
    el.setAttribute('spellcheck', 'true');
    el.setAttribute('autocapitalize', 'sentences');
  };
  const [draftQuery,    setDraftQuery]    = useState('');
  const [committedQuery,setCommittedQuery]= useState('');
  const [isSearching,   setIsSearching]   = useState(false);
  const [noteSugs,      setNoteSugs]      = useState([]);
  const [showFilter,    setShowFilter]    = useState(false);
  const [selAccts,      setSelAccts]      = useState(new Set());
  const [selCats,       setSelCats]       = useState(new Set());
  const [selPeriod,     setSelPeriod]     = useState('All');
  const [periodOffset,  setPeriodOffset]  = useState(0); // for prev/next navigation
  const [customFrom,    setFrom]          = useState('');
  const [customTo,      setTo]            = useState('');
  const [selected,      setSelected]      = useState(new Set());
  const [multiMode,     setMultiMode]     = useState(false);
  const [copyTxn,       setCopyTxn]       = useState(null);

  // Advanced Search Scope & Multi-Filter Query Builder
  const [scopeNotes, setScopeNotes] = useState(true);
  const [scopeDesc, setScopeDesc]   = useState(true);
  const [scopeTags, setScopeTags]   = useState(true);
  const [minAmount, setMinAmount]   = useState('');
  const [maxAmount, setMaxAmount]   = useState('');
  const [txnTypeFilter, setTxnTypeFilter] = useState('All'); // 'All' | 'Expense' | 'Income' | 'Transfer'
  const [onlyWarranty, setOnlyWarranty]   = useState(false);

  const now = new Date();

  const allAcctNames = useMemo(() => (accounts||[]).map(a=>a?.name||a).filter(Boolean).sort(), [accounts]);
  const allCatNames  = useMemo(() => Object.keys(categories||{}).sort(), [categories]);

  // Handle back button interception hierarchy:
  // 1. If filter popup is open -> Android Back closes ONLY the filter popup
  // 2. If in multiMode -> Android Back exits multiMode
  // 3. Otherwise -> Android Back exits Search view and returns to Transactions
  React.useEffect(() => {
    if (!backInterceptRef) return;
    if (showFilter) {
      backInterceptRef.current = () => setShowFilter(false);
    } else if (multiMode) {
      backInterceptRef.current = () => { setMultiMode(false); setSelected(new Set()); };
    } else if (onClose) {
      backInterceptRef.current = onClose;
    }
    return () => {
      if (backInterceptRef.current === onClose) {
        backInterceptRef.current = null;
      }
    };
  }, [showFilter, multiMode, onClose, backInterceptRef]);

  // Handle keyboard Escape for search view
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (showFilter) {
          e.stopPropagation();
          setShowFilter(false);
          return;
        }
        if (multiMode) {
          e.stopPropagation();
          setMultiMode(false);
          setSelected(new Set());
          return;
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [multiMode, showFilter]);

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

  const hasQuery = committedQuery.trim().length > 0 || selAccts.size > 0 || selCats.size > 0 || selPeriod !== 'All' || minAmount || maxAmount || txnTypeFilter !== 'All' || onlyWarranty || !scopeNotes || !scopeDesc || !scopeTags;

  // Single-pass high performance filter based strictly on committed query and active filters
  const results = useMemo(() => {
    if (!hasQuery) return [];
    const q = committedQuery.trim().toLowerCase();
    const minA = parseFloat(minAmount);
    const maxA = parseFloat(maxAmount);
    const hasMinA = !isNaN(minA);
    const hasMaxA = !isNaN(maxA);
    const isTagSearch = q.startsWith('#');
    const cleanTag = isTagSearch ? q.slice(1) : '';
    const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hashRegex = isTagSearch && cleanTag ? new RegExp(`(^|\\s)#${escapeRegex(cleanTag)}(\\b|\\s|$)`, 'i') : null;

    const matched = [];
    for (let i = 0; i < transactions.length; i++) {
      const t = transactions[i];
      const amt = parseFloat(t.INR || t.Amount || 0);

      // Amount filter
      if (hasMinA && amt < minA) continue;
      if (hasMaxA && amt > maxA) continue;

      // Type filter
      const tp = (t['Income/Expense'] || 'Expense').toLowerCase();
      if (txnTypeFilter === 'Expense' && tp !== 'expense') continue;
      if (txnTypeFilter === 'Income' && tp !== 'income') continue;
      if (txnTypeFilter === 'Transfer' && !tp.startsWith('transfer')) continue;

      // Warranty / Receipt filter
      if (onlyWarranty && !t.warranty_expiry && !t.receipt_image && !t.serial_no) continue;

      // Account & Category filter
      if (selAccts.size > 0 && !selAccts.has(t.Account) && !selAccts.has(t.FromAccount) && !selAccts.has(t.ToAccount)) continue;
      if (selCats.size > 0 && !selCats.has(t.Category)) continue;

      // Period filter (only parse date if period is actively filtered)
      if (periodRange) {
        const d = parseDate(t.Date);
        if (d < periodRange.start || d > periodRange.end) continue;
      } else if (selPeriod === 'Custom' && customFrom && customTo) {
        const d = parseDate(t.Date);
        if (d < new Date(customFrom) || d > new Date(customTo + 'T23:59:59')) continue;
      }

      if (!q) {
        matched.push(t);
        continue;
      }

      // Scoped text matching
      if (isTagSearch) {
        let tagMatched = false;
        if (scopeTags && t.Tags) {
          const userTags = getUserFacingTags(t.Tags).map(x => x.replace(/^#/, '').toLowerCase());
          if (userTags.includes(cleanTag)) tagMatched = true;
        }
        if (!tagMatched && scopeTags && hashRegex) {
          if (hashRegex.test(t.Note || '') || hashRegex.test(t.Description || '')) tagMatched = true;
        }
        if (tagMatched) matched.push(t);
        continue;
      }

      // Standard text search with scope flags
      let isMatch = false;
      if (scopeNotes && t.Note && t.Note.toLowerCase().includes(q)) isMatch = true;
      else if (scopeDesc && t.Description && t.Description.toLowerCase().includes(q)) isMatch = true;
      else if (scopeTags && t.Tags) {
        const userTags = getUserFacingTags(t.Tags).map(x => x.toLowerCase());
        if (userTags.some(ut => ut.includes(q))) isMatch = true;
      }
      else if (t.Category && t.Category.toLowerCase().includes(q)) isMatch = true;
      else if (t.Subcategory && t.Subcategory.toLowerCase().includes(q)) isMatch = true;
      else if (t.Account && t.Account.toLowerCase().includes(q)) isMatch = true;
      else if (t.FromAccount && t.FromAccount.toLowerCase().includes(q)) isMatch = true;
      else if (t.ToAccount && t.ToAccount.toLowerCase().includes(q)) isMatch = true;

      if (isMatch) matched.push(t);
    }
    return matched;
  }, [transactions, committedQuery, selPeriod, periodRange, selAccts, selCats, customFrom, customTo, minAmount, maxAmount, txnTypeFilter, onlyWarranty, scopeNotes, scopeDesc, scopeTags, hasQuery]);

  // Derived Applicable Facets & Counts (Excel-like dynamic values in O(N))
  const { applicableAccounts, applicableCategories, facetCounts } = useMemo(() => {
    if (!hasQuery) {
      return {
        applicableAccounts: allAcctNames,
        applicableCategories: allCatNames,
        facetCounts: { accounts: {}, categories: {} }
      };
    }

    const acctCounts = {};
    const catCounts = {};

    for (let i = 0; i < results.length; i++) {
      const t = results[i];
      if (t.Account) acctCounts[t.Account] = (acctCounts[t.Account] || 0) + 1;
      if (t.FromAccount && t.FromAccount !== t.Account) acctCounts[t.FromAccount] = (acctCounts[t.FromAccount] || 0) + 1;
      if (t.ToAccount && t.ToAccount !== t.Account) acctCounts[t.ToAccount] = (acctCounts[t.ToAccount] || 0) + 1;
      if (t.Category) catCounts[t.Category] = (catCounts[t.Category] || 0) + 1;
    }

    // Keep all accounts that have matching results OR are currently selected in selAccts (with 0 count if no matches)
    const appAccts = allAcctNames.filter(a => acctCounts[a] > 0 || selAccts.has(a));
    // Keep all categories that have matching results OR are currently selected in selCats (with 0 count if no matches)
    const appCats = allCatNames.filter(c => catCounts[c] > 0 || selCats.has(c));

    return {
      applicableAccounts: appAccts,
      applicableCategories: appCats,
      facetCounts: { accounts: acctCounts, categories: catCounts }
    };
  }, [hasQuery, results, allAcctNames, allCatNames, selAccts, selCats]);

  const totals = useMemo(() => {
    let inc = 0, exp = 0, xfr = 0;
    for (let i = 0; i < results.length; i++) {
      const t = results[i];
      const tp = txnType(t), amt = txnAmount(t);
      if (tp === 'income') inc += amt;
      else if (tp === 'expense') exp += amt;
      else xfr += amt;
    }
    return { inc, exp, xfr };
  }, [results]);

  const selTotals = useMemo(() => {
    let inc = 0, exp = 0, xfr = 0;
    for (let i = 0; i < results.length; i++) {
      const t = results[i];
      if (!selected.has(t._id)) continue;
      const tp = txnType(t), amt = txnAmount(t);
      if (tp === 'income') inc += amt;
      else if (tp === 'expense') exp += amt;
      else xfr += amt;
    }
    return { inc, exp, xfr };
  }, [results, selected]);

  const allAvailableTags = useMemo(() => {
    const seen = new Set();
    const limit = Math.min(transactions.length, 500);
    for (let i = 0; i < limit; i++) {
      const t = transactions[i];
      if (t.Tags) {
        const cleanUserTags = getUserFacingTags(t.Tags);
        cleanUserTags.forEach(tag => seen.add(tag));
      }
    }
    try {
      const custom = JSON.parse(state.settings?.customTags || '[]');
      if (Array.isArray(custom)) {
        custom.forEach(ct => {
          const clean = String(ct).trim().toLowerCase();
          if (clean && !isSystemTag(clean)) seen.add(clean.startsWith('#') ? clean : `#${clean}`);
        });
      }
    } catch {}

    const defaults = ['#tax', '#personal', '#family', '#trip', '#impulse', '#work', '#medical'];
    defaults.forEach(d => seen.add(d));
    return Array.from(seen).slice(0, 25);
  }, [transactions, state.settings?.customTags]);

  const stripInstalment = (note) => {
    return (note || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
  };

  const handleNoteInput = v => {
    setDraftQuery(v);

    const norm = normalizeSuggestionQuery(v);
    if (norm) {
      const q = norm.toLowerCase(), seen = new Set();
      const sugs = [];
      for (let i = 0; i < transactions.length; i++) {
        const raw = transactions[i].Note; if (!raw) continue;
        const stripped = stripInstalment(raw);
        if (!stripped.toLowerCase().includes(q)) continue;
        if (seen.has(stripped)) continue;
        seen.add(stripped);
        sugs.push(stripped);
        if (sugs.length >= 15) break;
      }
      setNoteSugs(sugs);
    } else { setNoteSugs([]); }
  };

  const commitSearch = (overrideValue) => {
    const val = overrideValue !== undefined ? overrideValue : draftQuery;
    setDraftQuery(val);
    setNoteSugs([]);
    if (val !== committedQuery) {
      setIsSearching(true);
      setTimeout(() => {
        setCommittedQuery(val);
        setIsSearching(false);
      }, 20);
    }
  };

  const toggleSel  = t => setSelected(p => { const s = new Set(p); s.has(t._id) ? s.delete(t._id) : s.add(t._id); return s; });
  const toggleAcct = a => setSelAccts(p => { const s = new Set(p); s.has(a) ? s.delete(a) : s.add(a); return s; });
  const toggleCat  = c => setSelCats(p  => { const s = new Set(p); s.has(c) ? s.delete(c) : s.add(c); return s; });

  const PERIODS = ['All', 'Weekly', 'Monthly', 'Yearly', 'FY', 'Custom'];
  const canNav  = selPeriod !== 'All' && selPeriod !== 'Custom';

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (committedQuery.trim()) count += 1;
    if (selAccts.size > 0) count += selAccts.size;
    if (selCats.size > 0) count += selCats.size;
    if (selPeriod !== 'All') count += 1;
    if (txnTypeFilter !== 'All') count += 1;
    if (minAmount) count += 1;
    if (maxAmount) count += 1;
    if (onlyWarranty) count += 1;
    if (!scopeNotes || !scopeDesc || !scopeTags) count += 1;
    return count;
  }, [committedQuery, selAccts, selCats, selPeriod, txnTypeFilter, minAmount, maxAmount, onlyWarranty, scopeNotes, scopeDesc, scopeTags]);

  const handleClearAll = () => {
    setDraftQuery('');
    setCommittedQuery('');
    setNoteSugs([]);
    setIsSearching(false);
    setSelAccts(new Set());
    setSelCats(new Set());
    setSelPeriod('All');
    setPeriodOffset(0);
    setMinAmount('');
    setMaxAmount('');
    setTxnTypeFilter('All');
    setOnlyWarranty(false);
    setScopeNotes(true);
    setScopeDesc(true);
    setScopeTags(true);
    setFrom('');
    setTo('');
  };

  // Applied Filter Chips
  const appliedFilters = useMemo(() => {
    const list = [];
    if (committedQuery.trim()) {
      const qText = committedQuery.trim();
      list.push({
        id: 'query',
        label: `"${qText}"`,
        onRemove: () => {
          setDraftQuery('');
          setCommittedQuery('');
          setNoteSugs([]);
        }
      });
    }
    if (txnTypeFilter !== 'All') {
      list.push({
        id: 'type',
        label: `Type: ${txnTypeFilter}`,
        onRemove: () => setTxnTypeFilter('All')
      });
    }
    if (minAmount && maxAmount) {
      list.push({
        id: 'amount',
        label: `₹${minAmount} – ₹${maxAmount}`,
        onRemove: () => { setMinAmount(''); setMaxAmount(''); }
      });
    } else if (minAmount) {
      list.push({
        id: 'minAmount',
        label: `≥ ₹${minAmount}`,
        onRemove: () => setMinAmount('')
      });
    } else if (maxAmount) {
      list.push({
        id: 'maxAmount',
        label: `≤ ₹${maxAmount}`,
        onRemove: () => setMaxAmount('')
      });
    }
    if (onlyWarranty) {
      list.push({
        id: 'warranty',
        label: '🛡️ Receipt / Warranty',
        onRemove: () => setOnlyWarranty(false)
      });
    }
    if (selPeriod !== 'All') {
      list.push({
        id: 'period',
        label: selPeriod === 'Custom' ? `Custom: ${customFrom || '…'} to ${customTo || '…'}` : `${selPeriod}${periodLabel ? ` (${periodLabel})` : ''}`,
        onRemove: () => { setSelPeriod('All'); setPeriodOffset(0); setFrom(''); setTo(''); }
      });
    }
    selAccts.forEach(a => {
      list.push({
        id: `acct-${a}`,
        label: a,
        onRemove: () => toggleAcct(a)
      });
    });
    selCats.forEach(c => {
      list.push({
        id: `cat-${c}`,
        label: c,
        onRemove: () => toggleCat(c)
      });
    });
    return list;
  }, [committedQuery, txnTypeFilter, minAmount, maxAmount, onlyWarranty, selPeriod, periodLabel, customFrom, customTo, selAccts, selCats]);

  return (
    <div className="search-view" {...swipe}>
      <div className="search-workspace-layout">
        {/* Persistent left filter panel for desktop / tablet */}
        <aside className="search-desktop-filters">
          <SearchFilterControls
            scopeNotes={scopeNotes} setScopeNotes={setScopeNotes}
            scopeDesc={scopeDesc} setScopeDesc={setScopeDesc}
            scopeTags={scopeTags} setScopeTags={setScopeTags}
            minAmount={minAmount} setMinAmount={setMinAmount}
            maxAmount={maxAmount} setMaxAmount={setMaxAmount}
            txnTypeFilter={txnTypeFilter} setTxnTypeFilter={setTxnTypeFilter}
            onlyWarranty={onlyWarranty} setOnlyWarranty={setOnlyWarranty}
            PERIODS={PERIODS} selPeriod={selPeriod} handlePeriodChange={handlePeriodChange}
            customFrom={customFrom} setFrom={setFrom}
            customTo={customTo} setTo={setTo}
            allAcctNames={allAcctNames} selAccts={selAccts} toggleAcct={toggleAcct}
            allCatNames={allCatNames} categories={categories} selCats={selCats} toggleCat={toggleCat}
            applicableAccounts={applicableAccounts} applicableCategories={applicableCategories} facetCounts={facetCounts}
            appliedFilters={appliedFilters}
            activeFilterCount={activeFilterCount}
            onClearAll={handleClearAll}
            isDesktop={true}
          />
        </aside>

        {/* Main search and results area */}
        <div className="search-desktop-content">
          {/* Search bar */}
          <div className="search-bar-row">
            <button className="back-btn" onClick={onClose} title="Back">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            </button>
            <div className="search-input-wrap">
              <button
                type="button"
                className="search-commit-btn"
                onClick={() => commitSearch()}
                title="Search"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{width:15,height:15,flexShrink:0}}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              </button>
              <input ref={textInputRef} autoFocus type="text" className="search-input" value={draftQuery}
                onChange={e => handleNoteInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.target.blur();
                    commitSearch();
                  }
                }}
                onBlur={() => setTimeout(() => setNoteSugs([]), 180)}
                placeholder="Search note, category, account…"/>
              {(draftQuery || committedQuery) && (
                <button type="button" className="search-clear" onClick={() => {
                  setDraftQuery(''); setCommittedQuery(''); setIsSearching(false); setNoteSugs([]);
                }} title="Clear search">✕</button>
              )}
              {noteSugs.length > 0 && (
                <div className="note-sug-list" style={{top:'calc(100% + 4px)'}}>
                  {noteSugs.map(s => <div key={s} className="note-sug-item" onMouseDown={() => { commitSearch(s); }}>{s}</div>)}
                </div>
              )}
            </div>
            <button className="filter-btn mobile-only-filter-btn" onClick={() => setShowFilter(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{width:15,height:15}}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
              {activeFilterCount > 0 && <span className="filter-active-dot"/>}
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
          {multiMode && <BulkSelectionBar selected={selected} setSelected={setSelected} selTotals={selTotals} allTxns={results}
            onDone={()=>{setMultiMode(false);setSelected(new Set());}}
            onDeleted={()=>{setMultiMode(false);setSelected(new Set());}} />}

          {/* Totals bar */}
          {!isSearching && hasQuery && results.length > 0 && (
            <div className="search-totals-bar">
              <div className="search-total-item"><div className="search-total-l">Income</div><div className="search-total-v" style={{color:'var(--income)'}}>{formatINR(totals.inc)}</div></div>
              <div className="search-total-item"><div className="search-total-l">Expenses</div><div className="search-total-v" style={{color:'var(--expense)'}}>{formatINR(totals.exp)}</div></div>
              <div className="search-total-item"><div className="search-total-l">Transfer</div><div className="search-total-v" style={{color:'var(--transfer)'}}>{formatINR(totals.xfr)}</div></div>
              <div className="search-total-item"><div className="search-total-l">Count</div><div className="search-total-v">{results.length}</div></div>
            </div>
          )}

          {/* Results Area */}
          <div className="search-list">
            {isSearching ? (
              <div className="search-loading-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', gap: 12 }}>
                <div className="loader-spinner" style={{ width: 28, height: 28, borderWidth: 3, margin: 0 }} />
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>Searching transactions…</span>
              </div>
            ) : !hasQuery ? (
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
                          commitSearch(tag);
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
                onCopy={txn => setCopyTxn({ ...txn, _id: undefined })}/>
            ))}
            <div style={{height: 80}}/>
          </div>
        </div>
      </div>

      {/* Filter sheet for mobile / small screens */}
      {showFilter && (
        <>
          <div className="overlay" onClick={() => setShowFilter(false)}/>
          <div className="bottom-sheet" style={{maxHeight:'92dvh',display:'flex',flexDirection:'column',padding:'0 0 calc(var(--safe-bottom)+12px)'}}>
            <div className="sheet-handle" style={{marginTop:14}}/>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'0 var(--page-px) 10px',borderBottom:'1px solid var(--border)'}}>
              <div style={{fontWeight:800,fontSize:'0.9rem'}}>Search &amp; Filter Options</div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowFilter(false)}>Close</button>
            </div>
            <div style={{overflow:'auto',flex:1,padding:'10px var(--page-px)'}}>
              <SearchFilterControls
                scopeNotes={scopeNotes} setScopeNotes={setScopeNotes}
                scopeDesc={scopeDesc} setScopeDesc={setScopeDesc}
                scopeTags={scopeTags} setScopeTags={setScopeTags}
                minAmount={minAmount} setMinAmount={setMinAmount}
                maxAmount={maxAmount} setMaxAmount={setMaxAmount}
                txnTypeFilter={txnTypeFilter} setTxnTypeFilter={setTxnTypeFilter}
                onlyWarranty={onlyWarranty} setOnlyWarranty={setOnlyWarranty}
                PERIODS={PERIODS} selPeriod={selPeriod} handlePeriodChange={handlePeriodChange}
                customFrom={customFrom} setFrom={setFrom}
                customTo={customTo} setTo={setTo}
                allAcctNames={allAcctNames} selAccts={selAccts} toggleAcct={toggleAcct}
                allCatNames={allCatNames} categories={categories} selCats={selCats} toggleCat={toggleCat}
                applicableAccounts={applicableAccounts} applicableCategories={applicableCategories} facetCounts={facetCounts}
                appliedFilters={appliedFilters}
                activeFilterCount={activeFilterCount}
                onClearAll={handleClearAll}
                isDesktop={false}
              />
            </div>
            <div style={{padding:'10px var(--page-px) 0'}}>
              <button className="btn btn-primary btn-full" onClick={() => setShowFilter(false)}>Apply Filters</button>
            </div>
          </div>
        </>
      )}

      {copyTxn && (
        <AddTransaction
          copyTransaction={copyTxn}
          onClose={() => setCopyTxn(null)}
          onSaveAndContinue={() => setCopyTxn({ ...copyTxn, _id: undefined })}
          backInterceptRef={backInterceptRef}
        />
      )}
    </div>
  );
}

// ── SearchFilterControls — shared between desktop panel and mobile sheet ─────
function SearchFilterControls({
  scopeNotes, setScopeNotes,
  scopeDesc, setScopeDesc,
  scopeTags, setScopeTags,
  minAmount, setMinAmount,
  maxAmount, setMaxAmount,
  txnTypeFilter, setTxnTypeFilter,
  onlyWarranty, setOnlyWarranty,
  PERIODS, selPeriod, handlePeriodChange,
  customFrom, setFrom,
  customTo, setTo,
  allAcctNames, selAccts, toggleAcct,
  allCatNames, categories, selCats, toggleCat,
  applicableAccounts, applicableCategories, facetCounts,
  appliedFilters,
  activeFilterCount,
  onClearAll,
  isDesktop = false,
}) {
  const displayAccts = applicableAccounts || allAcctNames;
  const displayCats = applicableCategories || allCatNames;
  const expenseCats = displayCats.filter(c => (categories?.[c]?.type || 'Expense') === 'Expense');
  const incomeCats  = displayCats.filter(c => (categories?.[c]?.type || 'Expense') === 'Income');

  return (
    <div className={`search-filter-controls ${isDesktop ? 'desktop-panel' : 'sheet-panel'}`}>
      {isDesktop && (
        <div className="search-filter-panel-hdr">
          <div className="search-filter-panel-title">
            <span>Filters</span>
            {activeFilterCount > 0 && (
              <span className="search-filter-badge">{activeFilterCount}</span>
            )}
          </div>
        </div>
      )}

      <div className="search-filter-sections-scroll">
        {/* Applied Filters Chips Area */}
        {appliedFilters && appliedFilters.length > 0 && (
          <div className="applied-filters-section">
            <div className="applied-filters-hdr">
              <span className="applied-filters-label">Applied Filters ({appliedFilters.length})</span>
              <button type="button" className="btn-clear-applied" onClick={onClearAll}>Clear all</button>
            </div>
            <div className="applied-filters-chips">
              {appliedFilters.map(af => (
                <span key={af.id} className="applied-filter-chip">
                  <span className="applied-chip-text">{af.label}</span>
                  <button
                    type="button"
                    className="applied-chip-remove"
                    onClick={af.onRemove}
                    title="Remove filter"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Section 1: Search Target Scope Checkboxes */}
        <div className="filter-section">
          <div className="filter-section-label">Search Query In (Target Scope)</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div className="filter-check-row" style={{ background: 'var(--bg-card2)', padding: '6px 10px', borderRadius: 8 }} onClick={() => setScopeNotes(p => !p)}>
              <div className={`filter-check-box ${scopeNotes ? 'checked' : ''}`}>{scopeNotes && '✓'}</div>
              <div className="filter-check-label">Notes</div>
            </div>
            <div className="filter-check-row" style={{ background: 'var(--bg-card2)', padding: '6px 10px', borderRadius: 8 }} onClick={() => setScopeDesc(p => !p)}>
              <div className={`filter-check-box ${scopeDesc ? 'checked' : ''}`}>{scopeDesc && '✓'}</div>
              <div className="filter-check-label">Description</div>
            </div>
            <div className="filter-check-row" style={{ background: 'var(--bg-card2)', padding: '6px 10px', borderRadius: 8 }} onClick={() => setScopeTags(p => !p)}>
              <div className={`filter-check-box ${scopeTags ? 'checked' : ''}`}>{scopeTags && '✓'}</div>
              <div className="filter-check-label">#Tags</div>
            </div>
          </div>
        </div>

        {/* Section 2: Amount Range Filter */}
        <div className="filter-section">
          <div className="filter-section-label">Amount Range (₹)</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="number"
              className="form-input"
              placeholder="Min ₹ (e.g. 1000)"
              value={minAmount}
              onChange={e => setMinAmount(e.target.value)}
              style={{ flex: 1, background: 'var(--bg-card2)', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)' }}
            />
            <input
              type="number"
              className="form-input"
              placeholder="Max ₹ (e.g. 50000)"
              value={maxAmount}
              onChange={e => setMaxAmount(e.target.value)}
              style={{ flex: 1, background: 'var(--bg-card2)', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)' }}
            />
          </div>
        </div>

        {/* Section 3: Transaction Type Filter */}
        <div className="filter-section">
          <div className="filter-section-label">Transaction Type</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['All', 'Expense', 'Income', 'Transfer'].map(t => (
              <button
                key={t}
                type="button"
                className={`chip ${txnTypeFilter === t ? 'active' : ''}`}
                onClick={() => setTxnTypeFilter(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Section 4: Period Filter */}
        <div className="filter-section">
          <div className="filter-section-label">Period</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {PERIODS.map(p => (
              <button
                key={p}
                type="button"
                className={`chip ${selPeriod === p ? 'active' : ''}`}
                onClick={() => handlePeriodChange(p)}
              >
                {p}
              </button>
            ))}
          </div>
          {selPeriod === 'Custom' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input type="date" className="form-input" style={{ flex: 1 }} value={customFrom} onChange={e => setFrom(e.target.value)} />
              <input type="date" className="form-input" style={{ flex: 1 }} value={customTo} onChange={e => setTo(e.target.value)} />
            </div>
          )}
        </div>

        {/* Section 5: Accounts Filter */}
        {displayAccts.length > 0 && (
          <div className="filter-section">
            <div className="filter-section-label">Accounts {selAccts.size > 0 && `(${selAccts.size} selected)`}</div>
            <div className="filter-checkbox-list">
              {displayAccts.map(a => (
                <div key={a} className={`filter-check-row ${selAccts.has(a) ? 'selected' : ''}`} onClick={() => toggleAcct(a)}>
                  <div className="filter-check-left">
                    <div className={`filter-check-box ${selAccts.has(a) ? 'checked' : ''}`}>{selAccts.has(a) && '✓'}</div>
                    <div className="filter-check-label">{a}</div>
                  </div>
                  {facetCounts?.accounts && facetCounts.accounts[a] !== undefined && (
                    <span className="filter-check-count">{facetCounts.accounts[a]}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Section 6: Categories Filter */}
        {displayCats.length > 0 && (
          <div className="filter-section">
            <div className="filter-section-label">Categories {selCats.size > 0 && `(${selCats.size} selected)`}</div>
            {expenseCats.length > 0 && (
              <>
                <div style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--expense)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '6px 0 4px' }}>Expense</div>
                <div className="filter-checkbox-list">
                  {expenseCats.map(c => (
                    <div key={c} className={`filter-check-row ${selCats.has(c) ? 'selected' : ''}`} onClick={() => toggleCat(c)}>
                      <div className="filter-check-left">
                        <div className={`filter-check-box ${selCats.has(c) ? 'checked' : ''}`}>{selCats.has(c) && '✓'}</div>
                        <div className="filter-check-label">{c}</div>
                      </div>
                      {facetCounts?.categories && facetCounts.categories[c] !== undefined && (
                        <span className="filter-check-count">{facetCounts.categories[c]}</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
            {incomeCats.length > 0 && (
              <>
                <div style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--income)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '6px 0 4px', marginTop: 6 }}>Income</div>
                <div className="filter-checkbox-list">
                  {incomeCats.map(c => (
                    <div key={c} className={`filter-check-row ${selCats.has(c) ? 'selected' : ''}`} onClick={() => toggleCat(c)}>
                      <div className="filter-check-left">
                        <div className={`filter-check-box ${selCats.has(c) ? 'checked' : ''}`}>{selCats.has(c) && '✓'}</div>
                        <div className="filter-check-label">{c}</div>
                      </div>
                      {facetCounts?.categories && facetCounts.categories[c] !== undefined && (
                        <span className="filter-check-count">{facetCounts.categories[c]}</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Section 7: Special Filters (Moved to Bottom) */}
        <div className="filter-section">
          <div className="filter-section-label">Special Filters</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`chip ${minAmount === '5000' ? 'active' : ''}`}
              onClick={() => { setMinAmount(minAmount === '5000' ? '' : '5000'); }}
            >
              💎 High Value (&gt; ₹5,000)
            </button>
            <button
              type="button"
              className={`chip ${onlyWarranty ? 'active' : ''}`}
              onClick={() => setOnlyWarranty(p => !p)}
            >
              🛡️ Has Receipt / Warranty
            </button>
          </div>
        </div>
      </div>
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
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncInitialText, setSyncInitialText] = useState('');

  const [showScrollTop, setShowScrollTop] = useState(false);
  const scrollRef = useRef(null);

  const multiModePrevHandler = React.useRef(null);
  const multiModeHandler = React.useRef(null);

  const handleOpenSyncModal = async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.includes('"format"') && text.includes('finman-transactions')) {
          setSyncInitialText(text);
          setShowSyncModal(true);
          return;
        }
      }
    } catch (e) {
      console.warn('Auto clipboard read skipped:', e);
    }
    setSyncInitialText('');
    setShowSyncModal(true);
  };

  // Sync year and view from dashboard clicks
  useEffect(() => {
    if (viewParams) {
      if (viewParams.mode === 'search') {
        setViewMode('search');
      } else {
        if (viewParams.year !== undefined && viewParams.year !== null) {
          setViewYear(Number(viewParams.year));
        }
        if (viewParams.month !== undefined && viewParams.month !== null) {
          setViewMonth(Number(viewParams.month));
          setViewMode('daily');
        } else if (viewParams.year !== undefined && viewParams.year !== null) {
          setViewMode('monthly');
        }
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

  // Handle back button interception for sync modal, calendar, and multi-mode
  React.useEffect(() => {
    if (!backInterceptRef) return;
    if (showSyncModal) {
      backInterceptRef.current = () => { setShowSyncModal(false); setSyncInitialText(''); };
    } else if (showCal) {
      backInterceptRef.current = () => setShowCal(false);
    } else if (multiMode) {
      backInterceptRef.current = () => { setMultiMode(false); setSelected(new Set()); };
    } else {
      backInterceptRef.current = null;
    }
    return () => {
      if (backInterceptRef.current) backInterceptRef.current = null;
    };
  }, [showSyncModal, showCal, multiMode, backInterceptRef]);

  // Handle keyboard Escape for main Transactions screen
  React.useEffect(() => {
    if (!multiMode) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (showSyncModal || showCal || addDate || copyTxn) return;
        const activeOverlays = document.querySelectorAll('.overlay, .bottom-sheet, .modal-backdrop, .modal-overlay, .dialog-overlay');
        if (activeOverlays.length > 0) return;
        e.stopPropagation();
        setMultiMode(false);
        setSelected(new Set());
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [multiMode, showSyncModal, showCal, addDate, copyTxn]);

  const prevMonth = () => { if(viewMonth===0){setViewMonth(11);setViewYear(y=>y-1);}else setViewMonth(m=>m-1); };
  const nextMonth = () => { if(viewMonth===11){setViewMonth(0);setViewYear(y=>y+1);}else setViewMonth(m=>m+1); };
  const swipe = useSwipe(nextMonth, prevMonth);
  // Only attach swipe handlers in daily mode and not in multiMode
  const swipeProps = viewMode === 'daily' && !multiMode ? swipe : {};

  const monthTxns   = useMemo(() => transactions.filter(t=>{const d=parseDate(t.Date);return d.getFullYear()===viewYear&&d.getMonth()===viewMonth;}), [transactions,viewYear,viewMonth]);
  const monthTotals = useMemo(() => calcReportingTotals(monthTxns), [monthTxns]);

  const toggleSel = t => setSelected(p => { const s = new Set(p); s.has(t._id) ? s.delete(t._id) : s.add(t._id); return s; });

  const handleToggleDate = (dateIds, isAllSelected) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (isAllSelected) {
        dateIds.forEach(id => next.delete(id));
      } else {
        dateIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  const allMonthIds = useMemo(() => monthTxns.map(t => t._id), [monthTxns]);
  const allMonthSel = allMonthIds.length > 0 && allMonthIds.every(id => selected.has(id));
  const isMonthIndeterminate = !allMonthSel && allMonthIds.some(id => selected.has(id));

  const handleSelectMonthToggle = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allMonthSel) {
        allMonthIds.forEach(id => next.delete(id));
      } else {
        allMonthIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

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
      {/* Row 1: [Daily | Monthly] on left, [📋 Paste | 🔍] on right */}
      <div className="txn-header">
        <div className="txn-view-tabs">
          <button className={`txn-view-tab ${viewMode==='daily'?'active':''}`} onClick={()=>setViewMode('daily')}>Daily</button>
          <button className={`txn-view-tab ${viewMode==='monthly'?'active':''}`} onClick={()=>setViewMode('monthly')}>Monthly</button>
        </div>
        <div className="txn-header-actions">
          <button className="txn-paste-btn" onClick={handleOpenSyncModal} title="Paste Transactions (Cross-Environment Sync)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" width="15" height="15">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
            </svg>
            <span className="txn-paste-btn-lbl">Paste</span>
          </button>
          <button className="txn-search-btn" onClick={()=>setViewMode('search')} title="Search Transactions">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          </button>
        </div>
      </div>

      {/* Row 2: Month navigator — Daily mode only */}
      {viewMode==='daily' && (
        <div className="txn-month-row">
          <button className="pp-arrow" onClick={prevMonth} disabled={multiMode} style={multiMode ? { opacity: 0.3, cursor: 'default' } : {}}>‹</button>
          <div className="month-title-btn">
            <span className="month-name">{MONTHS_F[viewMonth]}</span>
            <span className="month-yr">{viewYear}</span>
          </div>
          {multiMode ? (
            <button
              type="button"
              className="month-sel-all-btn"
              onClick={handleSelectMonthToggle}
              style={{
                fontSize: '0.74rem',
                padding: '4px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg-card2)',
                color: 'var(--accent)',
                fontWeight: 700,
                cursor: 'pointer',
              }}
              title={allMonthSel ? 'Deselect entire month' : 'Select all transactions in this month'}
            >
              {allMonthSel ? 'Deselect Month' : isMonthIndeterminate ? 'Select All Month' : 'Select Month'}
            </button>
          ) : (
            <button className="pp-arrow" onClick={nextMonth}>›</button>
          )}
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
          {multiMode && <BulkSelectionBar selected={selected} setSelected={setSelected} selTotals={selTotals} allTxns={monthTxns}
            onDone={()=>{setMultiMode(false);setSelected(new Set());}}
            onDeleted={()=>{setMultiMode(false);setSelected(new Set());}} />}
          <div ref={scrollRef} className="txn-list" onScroll={handleScroll}>
            {monthTxns.length===0
              ? <div className="empty-state"><div className="empty-icon">📅</div><div className="empty-title">No transactions</div><div className="empty-desc">{MONTHS_F[viewMonth]} {viewYear}</div></div>
              : <DateGroupedList isActive={isActive} txns={monthTxns} onDateTap={multiMode ? null : date=>setAddDate(date)} selected={selected} multiMode={multiMode} onLongPress={tt => { setMultiMode(true); setSelected(new Set([tt._id])); }} onTap={multiMode ? toggleSel : null} onToggleDate={handleToggleDate} backInterceptRef={backInterceptRef} onCopy={handleCopy} />
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

      {showSyncModal && (
        <TransactionSyncModal
          isOpen={showSyncModal}
          initialPayloadText={syncInitialText}
          onClose={() => { setShowSyncModal(false); setSyncInitialText(''); }}
        />
      )}

      {/* Floating FAB — bottom left */}
      <button className="trans-fab" onClick={onAddTransaction}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  );
}