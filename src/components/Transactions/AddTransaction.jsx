import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { inputToStorage, toInputDate, nowTimeStr, formatINR } from '../../utils/format.js';
import { resolveInvestmentAccounts } from '../../utils/brokerageAccounting.js';
import './AddTransaction.css';
import { AccountsManager, CategoriesManager } from '../Settings/Settings.jsx';
import {
  buildInstalmentSchedule, computeNextRepeatDate,
  buildInstalmentNote, stripInstalmentSuffix, parseInstalmentInfo, getInstalmentSeriesStats,
} from '../../database/recurring.js';
import { parseBankSMS } from '../../utils/smsParser.js';
import ReceiptViewer from '../Common/ReceiptViewer.jsx';

const TYPES = [
  { id: 'Expense', label: 'Expense', cls: 'expense' },
  { id: 'Income', label: 'Income', cls: 'income' },
  { id: 'Transfer-Out', label: 'Transfer', cls: 'transfer' },
  { id: 'Investment', label: 'Investment', cls: 'investment' },
];

const todayVal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── ReorderOverlay — shows AccountsManager or CategoriesManager inline ────
function ReorderOverlay({ screen, onClose }) {
  if (!screen) return null;
  // Use fullscreen-modal class so safe-area top/bottom padding applies correctly
  // and the sub-screen layout matches what AccountsManager/CategoriesManager expect
  return (
    <div className="fullscreen-modal" style={{ zIndex: 300, overflowY: 'auto', paddingLeft: 0, paddingRight: 0 }}>
      {screen === 'accounts' && <AccountsManager onBack={onClose} />}
      {screen === 'categories' && <CategoriesManager onBack={onClose} />}
    </div>
  );
}


// ── RecurringSheet — Instalment / Repeat picker ────────────────────────────
const REPEAT_OPTIONS = [
  { id: 'daily', label: 'Daily', icon: '📅' },
  { id: 'weekly', label: 'Weekly', icon: '🗓' },
  { id: 'fortnightly', label: 'Every 2 weeks', icon: '🗓' },
  { id: 'monthly', label: 'Monthly', icon: '📆' },
  { id: '3months', label: 'Every 3 months', icon: '📆' },
  { id: '6months', label: 'Every 6 months', icon: '📆' },
  { id: 'annually', label: 'Annually', icon: '🎯' },
];

function RecurringSheet({ onClose, onSave, isExpense, startDate }) {
  const [mode, setMode] = React.useState(null);           // null | 'instalment' | 'repeat'
  const [scheduleMode, setSchedule] = React.useState('start_of_month'); // default: start of month
  const [days, setDays] = React.useState('');             // instalment days
  const [months, setMonths] = React.useState('');             // instalment months (alt input)
  const [inputMode, setInputMode] = React.useState('months');       // 'months' | 'days'
  const [repeatFreq, setRepeatFreq] = React.useState('monthly');
  const [step, setStep] = React.useState(1);              // 1=type, 2=details, 3=schedule

  const handleInstSave = () => {
    const totalDays = inputMode === 'months'
      ? Math.round(parseFloat(months || 0) * 30)
      : parseInt(days || 0);
    if (!totalDays || totalDays < 1) return;
    onSave({ type: 'instalment', totalDays, scheduleMode });
    onClose();
  };

  const handleRepeatSave = () => {
    onSave({ type: 'repeat', frequency: repeatFreq, scheduleMode });
    onClose();
  };

  return (
    <>
      <div className="fullscreen-overlay" onClick={onClose} style={{ zIndex: 210 }} />
      <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)', zIndex: 211 }}>
        <div className="sheet-handle" />

        {step === 1 && (
          <>
            <div style={{ fontWeight: 800, fontSize: '0.95rem', marginBottom: 4 }}>Recurring</div>
            <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginBottom: 16 }}>
              Set up recurring or instalment payments
            </div>
            {/* Instalment — only for Expense */}
            {isExpense && (
              <div className="recur-option-row" onClick={() => { setMode('instalment'); setStep(2); }}>
                <div className="recur-option-icon">📋</div>
                <div className="recur-option-body">
                  <div className="recur-option-title">Instalment</div>
                  <div className="recur-option-sub">Split total amount over days/months</div>
                </div>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14" style={{ opacity: 0.4 }}><path d="M9 18l6-6-6-6" /></svg>
              </div>
            )}
            <div className="recur-option-row" onClick={() => { setMode('repeat'); setStep(2); }}>
              <div className="recur-option-icon">🔁</div>
              <div className="recur-option-body">
                <div className="recur-option-title">Repeat</div>
                <div className="recur-option-sub">Create same transaction on a schedule</div>
              </div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14" style={{ opacity: 0.4 }}><path d="M9 18l6-6-6-6" /></svg>
            </div>
            <button className="btn btn-ghost btn-full" style={{ marginTop: 12 }} onMouseDown={onClose}>Cancel</button>
          </>
        )}

        {step === 2 && mode === 'instalment' && (
          <>
            <div style={{ fontWeight: 800, fontSize: '0.95rem', marginBottom: 2 }}>📋 Instalment</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 14 }}>
              Amount will be split proportionally across instalments
            </div>
            {/* Months / Days toggle */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button className={`btn btn-sm ${inputMode === 'months' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setInputMode('months')}>Months</button>
              <button className={`btn btn-sm ${inputMode === 'days' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setInputMode('days')}>Days</button>
            </div>
            <div className="form-group" style={{ marginBottom: 14 }}>
              <label className="form-label">{inputMode === 'months' ? 'Number of Months' : 'Number of Days'}</label>
              <input
                ref={el => { if (el) setTimeout(() => el.focus(), 150); }}
                className="form-input" type="tel" inputMode="numeric" pattern="[0-9]*"
                placeholder={inputMode === 'months' ? 'e.g. 3' : 'e.g. 84'}
                value={inputMode === 'months' ? months : days}
                onFocus={e => e.target.select()}
                onChange={e => inputMode === 'months' ? setMonths(e.target.value) : setDays(e.target.value)}
              />
            </div>
            <button className="btn btn-primary btn-full" style={{ marginBottom: 8 }}
              onClick={() => setStep(3)}>Next →</button>
            <button className="btn btn-ghost btn-full" onClick={() => setStep(1)}>← Back</button>
          </>
        )}

        {step === 2 && mode === 'repeat' && (
          <>
            <div style={{ fontWeight: 800, fontSize: '0.95rem', marginBottom: 14 }}>🔁 Repeat frequency</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
              {REPEAT_OPTIONS.map(opt => (
                <div key={opt.id}
                  onClick={() => setRepeatFreq(opt.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10,
                    background: repeatFreq === opt.id ? 'rgba(0,229,160,0.10)' : 'var(--bg-card2)',
                    border: `1.5px solid ${repeatFreq === opt.id ? 'var(--accent)' : 'var(--border)'}`,
                    cursor: 'pointer'
                  }}>
                  <span style={{ fontSize: '1.1rem' }}>{opt.icon}</span>
                  <span style={{ flex: 1, fontSize: '0.85rem', fontWeight: 600, color: repeatFreq === opt.id ? 'var(--accent)' : 'var(--text-primary)' }}>{opt.label}</span>
                  {repeatFreq === opt.id && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>✓</span>}
                </div>
              ))}
            </div>
            <button className="btn btn-primary btn-full" style={{ marginBottom: 8 }}
              onClick={() => setStep(3)}>Next →</button>
            <button className="btn btn-ghost btn-full" onClick={() => setStep(1)}>← Back</button>
          </>
        )}

        {step === 3 && (
          <>
            <div style={{ fontWeight: 800, fontSize: '0.95rem', marginBottom: 2 }}>
              {mode === 'instalment' ? '📋 Instalment — Schedule' : '🔁 Repeat — Schedule'}
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 14 }}>
              How should dates be calculated?
            </div>
            {/* Schedule mode options */}
            {[
              {
                id: 'start_of_month', label: 'Start of month',
                sub: mode === 'instalment'
                  ? 'Remaining days this month, then 1st of each month (good for recharges)'
                  : 'Repeats on the 1st of each period'
              },
              {
                id: 'on_date', label: mode === 'instalment' ? 'On the day' : 'On the date',
                sub: mode === 'instalment'
                  ? `Same date each month (e.g. ${startDate ? startDate.slice(8) : '22'}nd of each month)`
                  : 'Repeats on the same date each period'
              },
            ].map(opt => (
              <div key={opt.id} onClick={() => setSchedule(opt.id)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px', borderRadius: 10, marginBottom: 8,
                  background: scheduleMode === opt.id ? 'rgba(0,229,160,0.10)' : 'var(--bg-card2)',
                  border: `1.5px solid ${scheduleMode === opt.id ? 'var(--accent)' : 'var(--border)'}`, cursor: 'pointer'
                }}>
                <div style={{
                  width: 18, height: 18, borderRadius: '50%', marginTop: 2, flexShrink: 0,
                  border: `2px solid ${scheduleMode === opt.id ? 'var(--accent)' : 'var(--border)'}`,
                  background: scheduleMode === opt.id ? 'var(--accent)' : 'transparent'
                }} />
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: scheduleMode === opt.id ? 'var(--accent)' : 'var(--text-primary)' }}>{opt.label}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>{opt.sub}</div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setStep(2)}>← Back</button>
              <button className="btn btn-primary" style={{ flex: 2 }}
                onClick={mode === 'instalment' ? handleInstSave : handleRepeatSave}>
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── PickerSheetInline — inline chip grid with recent row ────────────────────────────────
function PickerSheetInline({ label, items, recent, value, onSelect, onClose, exclude = '', onReorder }) {
  const [query, setQuery] = React.useState('');
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);
  const targetRef = React.useRef(null);

  const scrollToContent = () => {
    const list = listRef.current;
    const target = targetRef.current;
    if (list && target) {
      list.scrollTop = target.offsetTop;
    }
  };

  React.useLayoutEffect(() => {
    scrollToContent();
  }, []);

  React.useEffect(() => {
    scrollToContent();
    const id1 = requestAnimationFrame(scrollToContent);
    const id2 = setTimeout(scrollToContent, 30);
    const id3 = setTimeout(scrollToContent, 80);
    return () => {
      cancelAnimationFrame(id1);
      clearTimeout(id2);
      clearTimeout(id3);
    };
  }, []);

  const q = query.trim().toLowerCase();
  const recentList = recent.filter(i => i !== exclude && (!q || i.toLowerCase().includes(q)));
  const allItems = items.filter(i => i !== exclude && (!q || i.toLowerCase().includes(q)));
  const noResults = recentList.length === 0 && allItems.length === 0;

  const Chip = ({ name }) => (
    <button type="button"
      className={`picker-chip ${value === name ? 'picker-chip-active' : ''}`}
      onMouseDown={e => { e.preventDefault(); onSelect(name); onClose(); }}>
      {name}{value === name && <span className="picker-chip-check"> ✓</span>}
    </button>
  );

  return (
    <div className="picker-sheet-inline">
      <div className="picker-sheet-hdr" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
        <div className="picker-sheet-title">{label}</div>
        {!q && onReorder && (
          <button className="picker-reorder-hint" onMouseDown={e => { e.preventDefault(); onReorder(); onClose(); }}>
            ⠿ Edit
          </button>
        )}
        <button className="picker-sheet-close" onMouseDown={onClose}>✕</button>
      </div>
      <div className="picker-list" ref={listRef} style={{ position: 'relative' }}>
        <div className="picker-search-wrap">
          <span className="picker-search-icon">🔍</span>
          <input ref={inputRef} className="picker-search-input"
            placeholder={`Search ${label.toLowerCase()}…`}
            value={query} onChange={e => {
              setQuery(e.target.value);
              if (listRef.current) listRef.current.scrollTop = 0;
            }} />
          {query && <button className="picker-search-clear" onMouseDown={e => { e.preventDefault(); setQuery(''); }}>✕</button>}
        </div>
        {recentList.length > 0 && (
          <>
            <div className="picker-section-label">Recent</div>
            <div ref={targetRef} className="picker-recent-row">{recentList.map(n => <Chip key={n} name={n} />)}</div>
          </>
        )}
        {allItems.length > 0 && (
          <>
            <div ref={recentList.length === 0 ? targetRef : null} className="picker-chip-grid">{allItems.map(n => <Chip key={n} name={n} />)}</div>
          </>
        )}
        {noResults && <div className="picker-empty">No results for "{query}"</div>}
      </div>
    </div>
  );
}

// ── SubcategoryPickerInline — inline chip grid ──────────
function SubcategoryPickerInline({ items, recent, value, onSelect, onClose }) {
  const recentList = (recent || []).filter(i => items.includes(i));
  const allItems = items;

  const Chip = ({ name }) => (
    <button type="button"
      className={`picker-chip ${value === name ? 'picker-chip-active' : ''}`}
      onMouseDown={e => { e.preventDefault(); onSelect(name); onClose(); }}>
      {name}{value === name && <span className="picker-chip-check"> ✓</span>}
    </button>
  );

  return (
    <div className="picker-sheet-inline">
      <div className="picker-sheet-hdr" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
        <div className="picker-sheet-title">Subcategory</div>
        <button className="picker-sheet-close" onMouseDown={onClose}>✕</button>
      </div>
      <div className="picker-list" style={{ paddingBottom: 16 }}>
        {recentList.length > 0 && (
          <>
            <div className="picker-section-label">Recent</div>
            <div className="picker-recent-row">{recentList.map(n => <Chip key={n} name={n} />)}</div>
          </>
        )}
        <div className="picker-section-label">{recentList.length > 0 ? 'All' : 'Options'}</div>
        <div className="picker-chip-grid">
          <button type="button"
            className={`picker-chip ${!value ? 'picker-chip-active' : ''}`}
            onMouseDown={e => { e.preventDefault(); onSelect(''); onClose(); }}>
            None
          </button>
          {allItems.map(n => <Chip key={n} name={n} />)}
        </div>
      </div>
    </div>
  );
}

function PickerField({ label, value, placeholder, error, items, recent, onSelect, exclude = '', onReorder, onAfterSelect, setPickerState, hideLabel = false, active }, ref) {
  React.useImperativeHandle(ref, () => ({
    open: () => {
      setPickerState({
        type: label.toLowerCase().replace(' ', ''),
        label,
        value,
        items,
        recent,
        onSelect: (v) => { onSelect(v); if (onAfterSelect) setTimeout(onAfterSelect, 100); },
        exclude,
        onReorder
      });
    }
  }), [label, value, items, recent, onSelect, onAfterSelect, exclude, onReorder, setPickerState]);
  return (
    <div className="form-group">
      {!hideLabel && <label className="form-label">{label}</label>}
      <button type="button"
        className={`form-input picker-trigger ${error ? 'err' : ''} ${!value ? 'picker-trigger-empty' : ''}` + (active ? ' focus' : '')}
        onClick={() => {
          setPickerState({
            type: label.toLowerCase().replace(' ', ''),
            label,
            value,
            items,
            recent,
            onSelect: (v) => { onSelect(v); if (onAfterSelect) setTimeout(onAfterSelect, 100); },
            exclude,
            onReorder
          });
        }}>
        <span className="picker-trigger-value">{value || placeholder}</span>
      </button>
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}
const PickerFieldFR = React.forwardRef(PickerField);

function SubcatField({ value, items, onChange, onAfterSelect, hideLabel = false }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  // Expose open via ref for focus flow
  React.useImperativeHandle(ref, () => ({ open: () => { if (items.length > 0) setOpen(true); } }));

  const handleSelect = (v) => {
    onChange(v);
    if (onAfterSelect) setTimeout(onAfterSelect, 100);
  };

  if (items.length === 0) return (
    <div className="form-group">
      {!hideLabel && <label className="form-label">Subcategory</label>}
      <div className="form-input picker-trigger picker-trigger-empty" style={{ cursor: 'default', opacity: 0.5 }}>
        <span className="picker-trigger-value">None</span>
      </div>
    </div>
  );

  return (
    <div className="form-group">
      {!hideLabel && <label className="form-label">Subcategory</label>}
      <button type="button"
        className={`form-input picker-trigger ${!value ? 'picker-trigger-empty' : ''}`}
        onClick={() => setOpen(true)}>
        <span className="picker-trigger-value">{value || 'None'}</span>
      </button>
      {open && (
        <SubcategoryPicker items={items} value={value}
          onSelect={handleSelect} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
const SubcatFieldFR = React.forwardRef((props, ref) => {
  React.useImperativeHandle(ref, () => ({
    open: () => {
      if (props.items.length > 0) {
        props.setPickerState({
          type: 'subcategory',
          label: 'Subcategory',
          value: props.value,
          items: props.items,
          recent: props.recent || [],
          onSelect: (v) => { props.onChange(v); if (props.onAfterSelect) setTimeout(() => props.onAfterSelect(v), 100); },
          exclude: '',
          onReorder: null
        });
      }
    }
  }), [props.items, props.value, props.onChange, props.onAfterSelect, props.setPickerState, props.recent]);
  // Always mark key='subcategory' so goNextEmpty knows subcat was explicitly touched (even None)
  if (props.items.length === 0) return (
    <div className="form-group">
      <div className={`form-input picker-trigger picker-trigger-empty` + (props.active ? ' focus' : '')} style={{ cursor: 'default', opacity: 0.5 }}>
        <span className="picker-trigger-value">None</span>
      </div>
    </div>
  );
  return (
    <div className="form-group">
      <button type="button"
        className={`form-input picker-trigger ${!props.value ? 'picker-trigger-empty' : ''}` + (props.active ? ' focus' : '')}
        onClick={() => {
          props.setPickerState({
            type: 'subcategory',
            label: 'Subcategory',
            value: props.value,
            items: props.items,
            recent: props.recent || [],
            onSelect: (v) => { props.onChange(v); if (props.onAfterSelect) setTimeout(() => props.onAfterSelect(v), 100); },
            exclude: '',
            onReorder: null
          });
        }}>
        <span className="picker-trigger-value">{props.value || 'None'}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" style={{ flexShrink: 0, opacity: 0.5 }}><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </div>
  );
});

// ── Main AddTransaction ────────────────────────────────────────────────────
export default function AddTransaction({
  onClose, onSaveAndContinue = null, editTransaction = null, copyTransaction = null,
  prefillDate = null, prefillAccount = null, prefillCategory = null,
  prefillType = null, prefillFromAccount = null, prefillToAccount = null, prefillAmount = null, prefillNote = null, prefillTags = null,
  prefillSubAccount = null,
  backInterceptRef = null, onSaveInstalment = null
}) {
  const { state, navigate, addTransaction, updateTransaction, createRecurringRule, updateInstalmentSiblings } = useApp();
  const { accounts = [], categories = {}, transactions = [] } = state || {};
  const isEdit = !!editTransaction;

  // Helper to check if an account belongs to Investments group
  const isInvestmentAccount = useCallback((name) => {
    if (!name) return false;
    const a = (accounts || []).find(acc => (acc.name || acc || '').toLowerCase() === String(name).toLowerCase());
    return a?.group?.toLowerCase() === 'investments';
  }, [accounts]);

  // Robust helper to extract and deduplicate subaccount string names regardless of data shape or source
  const getSubAccountNames = useCallback((acctObj) => {
    if (!acctObj) return [];
    const subs = Array.isArray(acctObj.subAccounts) ? acctObj.subAccounts : (acctObj.subAccounts ? Array.from(acctObj.subAccounts) : []);
    const extracted = subs.map(s => (typeof s === 'string' ? s : (s?.name || s?.id || '')).trim()).filter(Boolean);

    // Guaranteed canonical defaults for parent accounts
    const acctName = String(acctObj.name || acctObj || '').trim().toLowerCase();
    let canonicalDefaults = [];
    if (acctName === 'mutual funds tax saver') canonicalDefaults = ['Ak ETMoney'];
    else if (acctName === 'liquid mutual funds') canonicalDefaults = ['Fareeda Groww', 'Ammi Groww', 'Ak ETMoney'];
    else if (acctName === 'share market') canonicalDefaults = ['Zerodha', 'Fareeda Groww'];

    const rawList = [...extracted, ...canonicalDefaults];

    // Universal case-insensitive deduplication preserving clean display casing
    const seen = new Set();
    const unique = [];
    for (const name of rawList) {
      const key = name.trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        unique.push(name.trim());
      }
    }
    return unique;
  }, []);

  // Compute sub-account balances to sort them by highest balance
  const subAcctBalances = useMemo(() => {
    const map = {};
    const looksNumeric = (s) => s !== '' && !isNaN(parseFloat(s)) && isFinite(String(s).trim());
    const txnAmountLocal = (t) => parseFloat(t.INR || t.Amount || t.amount || 0);
    
    for (const t of transactions) {
      const amt = txnAmountLocal(t);
      const type = String(t['Income/Expense'] || '').trim();
      const acct = String(t.Account || '').trim();
      const fromAcct = String(t.FromAccount || t.Account || '').trim();
      const dest = String(t.ToAccount || '').trim();
      
      const sub = String(t.SubAccount || t.sub_account || '').trim();
      const fromSub = String(t.FromSubAccount || t.from_sub_account || '').trim();
      const toSub = String(t.ToSubAccount || t.to_sub_account || '').trim();

      if (type === 'Income') {
        const targetAcct = dest || acct;
        const targetSub = toSub || sub;
        if (targetAcct && targetSub && !looksNumeric(targetAcct)) {
          if (!map[targetAcct]) map[targetAcct] = {};
          map[targetAcct][targetSub] = (map[targetAcct][targetSub] || 0) + amt;
        }
      } else if (type === 'Expense') {
        const targetAcct = fromAcct || acct;
        const targetSub = fromSub || sub;
        if (targetAcct && targetSub && !looksNumeric(targetAcct)) {
          if (!map[targetAcct]) map[targetAcct] = {};
          map[targetAcct][targetSub] = (map[targetAcct][targetSub] || 0) - amt;
        }
      } else if (type === 'Transfer-Out') {
        if (fromAcct && fromSub && !looksNumeric(fromAcct)) {
          if (!map[fromAcct]) map[fromAcct] = {};
          map[fromAcct][fromSub] = (map[fromAcct][fromSub] || 0) - amt;
        }
        if (dest && toSub && !looksNumeric(dest)) {
          if (!map[dest]) map[dest] = {};
          map[dest][toSub] = (map[dest][toSub] || 0) + amt;
        }
      }
    }
    return map;
  }, [transactions]);

  const getSortedSubs = useCallback((acctObj) => {
    if (!acctObj) return [];
    const names = getSubAccountNames(acctObj);
    if (!names.length) return [];
    const name = acctObj.name || acctObj;
    const sorted = [...names].sort((a, b) => {
      const balA = subAcctBalances[name]?.[a] ?? 0;
      const balB = subAcctBalances[name]?.[b] ?? 0;
      return balB - balA;
    });

    // Universal deduplication guarantee
    const seen = new Set();
    const result = [];
    for (const s of sorted) {
      const key = s.trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        result.push(s);
      }
    }
    return result;
  }, [getSubAccountNames, subAcctBalances]);
  const isCopy = !!copyTransaction;

  // Reorder overlay state (stays inside AddTransaction — no navigation needed)
  const [reorderScreen, setReorderScreen] = useState(null);

  // Picker state for inline sheet below form
  const [pickerState, setPickerState] = useState(null); // {type, label, value, items, recent, onSelect, exclude?, onReorder?}

  // Refs for focus flow
  const amountRef = useRef(null);
  const noteRef = useRef(null);
  const accountRef = useRef(null);
  const categoryRef = useRef(null);
  const subcatRef = useRef(null);
  const fromRef = useRef(null);
  const toRef = useRef(null);
  const descriptionRef = useRef(null);

  const lastTime = useMemo(() => {
    if (!transactions.length) return nowTimeStr();
    const sorted = [...transactions].sort((a, b) => { try { return new Date(b.created_at || 0) - new Date(a.created_at || 0); } catch { return 0; } });
    return sorted[0]?.Time || nowTimeStr();
  }, [transactions]);

  const lastTimeForDate = useMemo(() => {
    if (!prefillDate || !transactions.length) return null;
    let dt = transactions.filter(t => t.Date === prefillDate);
    if (prefillAccount) dt = dt.filter(t => (t.Account || t.FromAccount) === prefillAccount || t.ToAccount === prefillAccount);
    if (prefillCategory) dt = dt.filter(t => t.Category === prefillCategory);
    if (!dt.length) return null;
    return dt.sort((a, b) => { if (a.Time && b.Time) return b.Time.localeCompare(a.Time); try { return new Date(b.created_at || 0) - new Date(a.created_at || 0); } catch { return 0; } })[0]?.Time || null;
  }, [prefillDate, prefillAccount, prefillCategory, transactions]);

  const [form, setForm] = useState(() => {
    if (isEdit) {
      const t = editTransaction;
      const isInv = Boolean(
        t.InvestmentTransactionType ||
        t.investment_transaction_type ||
        t.Brokerage ||
        t.brokerage ||
        (t.SecuritySymbol && t.SecurityISIN)
      );
      const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim().toUpperCase();

      let rt = t['Income/Expense'] || 'Expense';
      if (rt === 'Transfer') rt = 'Transfer-Out';
      if (isInv && (invType === 'BUY' || invType === 'SELL')) {
        rt = invType;
      }

      // Strip (x/x) instalment suffix from Note so user sees clean note in edit form
      const cleanNote = stripInstalmentSuffix(t.Note || t.note || '');
      const dispAmt = String(t.TradeValue || t.trade_value || t.INR || t.Amount || t.amount || '');

      let initialAccount = rt.startsWith('Transfer') ? '' : (t.Account || t.FromAccount || '');
      let initialInvestmentAccount = '';
      let initialSubAccount = t.SubAccount || t.sub_account || t.FromSubAccount || t.to_sub_account || t.Brokerage || t.brokerage || '';
      let initialFundingAccount = (t.FromAccount && t.FromAccount !== t.Account ? t.FromAccount : '') || (t.ToAccount && t.ToAccount !== t.Account ? t.ToAccount : '');
      let initialSettlementAccount = '';

      if (isInv) {
        const res = resolveInvestmentAccounts(t, accounts);
        initialInvestmentAccount = res.investmentAccount || t.InvestmentAccount || t.Category || t.ToAccount || '';
        initialAccount = initialInvestmentAccount;
        if (res.invType === 'BUY') {
          initialFundingAccount = res.bankAccount;
        } else {
          initialSettlementAccount = res.bankAccount;
        }
        if (res.subAccount) initialSubAccount = res.subAccount;
      }

      return {
        type: isInv ? 'Investment' : rt,
        amount: dispAmt,
        date: toInputDate(t.Date) || todayVal(),
        time: t.Time || lastTime,
        investmentAccount: initialInvestmentAccount,
        account: initialAccount,
        fromAccount: rt.startsWith('Transfer') ? (t.Account || t.FromAccount || '') : '',
        toAccount: rt.startsWith('Transfer') ? (t.ToAccount || '') : '',
        category: t.Category || '',
        subcategory: t.Subcategory && t.Subcategory !== 'Default' ? t.Subcategory : '',
        note: cleanNote,
        description: t.Description || t.description || '',
        tags: t.Tags || t.tags || '',
        receipt_image: t.receipt_image || '',
        warranty_expiry: t.warranty_expiry || '',
        serial_no: t.serial_no || '',
        subAccount: initialSubAccount,
        fromSubAccount: t.FromSubAccount || t.from_sub_account || '',
        toSubAccount: t.ToSubAccount || t.to_sub_account || '',
        fundingAccount: initialFundingAccount,
        settlementAccount: initialSettlementAccount,
        // Investment specific state
        investmentTransactionType: invType || (rt === 'BUY' || rt === 'SELL' ? rt : 'BUY'),
        securitySymbol: t.SecuritySymbol || t.security_symbol || '',
        securityISIN: t.SecurityISIN || t.security_isin || '',
        quantity: String(Math.abs(parseFloat(t.Quantity || t.quantity || t.PositionQuantityChange || t.position_qty_change || 0)) || ''),
        unitPrice: String(t.UnitPrice || t.unit_price || ''),
        tradeValue: String(t.TradeValue || t.trade_value || dispAmt || ''),
        costBasis: String(t.CostBasis || t.cost_basis || ''),
        realizedPnl: String(t.RealizedPnl || t.realized_pnl || ''),
        brokerage: initialSubAccount,
        source: t.Source || t.source || ''
      };
    }
    if (isCopy) {
      const t = copyTransaction;
      let rt = t['Income/Expense'] || 'Expense';
      if (rt === 'Transfer') rt = 'Transfer-Out';
      return {
        type: rt, amount: String(t.INR || t.Amount || ''), date: toInputDate(t.Date) || todayVal(), time: t.Time || nowTimeStr(),
        account: rt.startsWith('Transfer') ? '' : (t.Account || ''), fromAccount: rt.startsWith('Transfer') ? (t.Account || t.FromAccount || '') : '',
        toAccount: rt.startsWith('Transfer') ? (t.ToAccount || '') : '', category: t.Category || '',
        subcategory: t.Subcategory && t.Subcategory !== 'Default' ? t.Subcategory : '', note: t.Note || '', description: t.Description || '',
        tags: t.Tags || t.tags || '',
        receipt_image: t.receipt_image || '',
        warranty_expiry: t.warranty_expiry || '',
        serial_no: t.serial_no || '',
        subAccount: t.SubAccount || t.sub_account || '',
        fromSubAccount: t.FromSubAccount || t.from_sub_account || t.SubAccount || t.sub_account || '',
        toSubAccount: t.ToSubAccount || t.to_sub_account || '',
        investmentAccount: '',
        fundingAccount: '',
        settlementAccount: '',
        investmentTransactionType: 'BUY',
        securitySymbol: '',
        securityISIN: '',
        quantity: '',
        unitPrice: '',
        tradeValue: '',
        costBasis: '',
        realizedPnl: '',
        brokerage: '',
        source: ''
      };
    }
    return {
      type: (prefillType === 'Transfer' ? 'Transfer-Out' : prefillType) || 'Expense',
      amount: prefillAmount ? String(prefillAmount) : '',
      date: prefillDate ? (toInputDate(prefillDate) || todayVal()) : todayVal(),
      time: prefillDate && lastTimeForDate ? lastTimeForDate : nowTimeStr(),
      investmentAccount: '',
      account: prefillAccount || '',
      fromAccount: prefillFromAccount || '',
      toAccount: prefillToAccount || '',
      category: prefillCategory || '',
      subcategory: '',
      note: prefillNote || '',
      description: '',
      tags: prefillTags || '',
      receipt_image: '',
      warranty_expiry: '',
      serial_no: '',
      subAccount: prefillSubAccount || '',
      fromSubAccount: prefillSubAccount || '',
      toSubAccount: '',
      fundingAccount: '',
      settlementAccount: '',
      investmentTransactionType: 'BUY',
      securitySymbol: '',
      securityISIN: '',
      quantity: '',
      unitPrice: '',
      tradeValue: '',
      costBasis: '',
      realizedPnl: '',
      brokerage: '',
      source: ''
    };
  });

  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [noteSugs, setNoteSugs] = useState([]);
  const [noteFocused, setNoteFocused] = useState(false);
  const formRefLatest = useRef(form);
  formRefLatest.current = form;

  // SMS / UPI Parser State
  const [smsModal, setSmsModal] = useState(false);
  const [smsInputText, setSmsInputText] = useState('');
  const [smsFeedback, setSmsFeedback] = useState('');
  const [viewingReceipt, setViewingReceipt] = useState(false);
  const fileInputRef = useRef(null);

  // Recurring
  const [showRecurring, setShowRecurring] = useState(false);
  const [recurringConfig, setRecurringConfig] = useState(null); // {type, totalDays?, scheduleMode, frequency?}

  // Split Transaction state
  const [isSplit, setIsSplit] = useState(false);
  const [splits, setSplits] = useState([
    { id: 's1', category: '', subcategory: '', amount: '', note: '' },
    { id: 's2', category: '', subcategory: '', amount: '', note: '' },
  ]);
  const [splitNoteFocusedIdx, setSplitNoteFocusedIdx] = useState(null);
  const [splitNoteSugs, setSplitNoteSugs] = useState([]);

  const allocatedSplitSum = useMemo(() => {
    return splits.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);
  }, [splits]);

  const splitRemaining = useMemo(() => {
    const total = parseFloat(form.amount) || 0;
    return Math.round((total - allocatedSplitSum) * 100) / 100;
  }, [form.amount, allocatedSplitSum]);

  const textInputRef = (el) => {
    if (!el) return;
    el.setAttribute('autocomplete', 'on'); el.setAttribute('autocorrect', 'on');
    el.setAttribute('spellcheck', 'true'); el.setAttribute('autocapitalize', 'sentences');
  };

  // Auto-resize textarea on mount and description changes
  React.useEffect(() => {
    const textarea = document.querySelector('.description-section textarea');
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 220) + 'px';
    }
  }, [form.description]);

  React.useEffect(() => {
    if (!backInterceptRef) return;
    if (reorderScreen) {
      // While reorder overlay is open, Back closes it (not the whole AddTransaction)
      backInterceptRef.current = () => setReorderScreen(null);
    } else {
      backInterceptRef.current = onClose;
    }
    return () => {
      // Only clear if we set it — don't clear if something else took over
      if (backInterceptRef.current === onClose || reorderScreen) {
        backInterceptRef.current = null;
      }
    };
  }, [backInterceptRef, onClose, reorderScreen]);

  // Open account picker as first focus on mount (add/copy only, not edit)
  React.useEffect(() => {
    if (isEdit) return;
    if (isTransfer) {
      if (form.fromAccount && !form.toAccount) {
        const t = setTimeout(() => toRef.current?.open(), 200);
        return () => clearTimeout(t);
      }
      return;
    }
    const t = setTimeout(() => accountRef.current?.open(), 200);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, v) => {
    setForm(p => {
      if (k === 'type') {
        const n = { ...p, type: v, category: '', subcategory: '' };
        if (v === 'Transfer-Out' && p.account) { n.fromAccount = p.account; n.account = ''; }
        else if (p.type === 'Transfer-Out' && v !== 'Transfer-Out' && p.fromAccount) { n.account = p.fromAccount; n.fromAccount = ''; n.toAccount = ''; }
        return n;
      }
      if (k === 'category') return { ...p, [k]: v, subcategory: '' };
      if (k === 'investmentAccount') return { ...p, investmentAccount: v, account: v };
      return { ...p, [k]: v };
    });
    if (errors[k]) setErrors(p => ({ ...p, [k]: '' }));
    // Auto-open picker for Transfer
    if (k === 'type') {
      setPickerState(null);
      if (v === 'Transfer-Out') {
        setTimeout(() => setPickerState({
          type: 'from',
          label: 'From',
          value: form.fromAccount,
          items: accountList,
          recent: recentAccounts,
          onSelect: (val) => { set('fromAccount', val); goNextEmpty({ key: 'fromAccount', val }); },
          onReorder: () => setReorderScreen('accounts')
        }), 100);
      } else {
        setTimeout(() => {
          accountRef.current?.open();
        }, 100);
      }
    }
  };

  const isTransfer = form.type === 'Transfer-Out';

  const selectedAcctObj = useMemo(() => {
    const acctName = form.investmentAccount || form.account || '';
    return (accounts || []).find(a => (a.name || '').toLowerCase() === acctName.toLowerCase()) || { name: acctName, subAccounts: [] };
  }, [accounts, form.investmentAccount, form.account]);

  const fromAcctObj = useMemo(() => {
    return (accounts || []).find(a => a.name === form.fromAccount);
  }, [accounts, form.fromAccount]);

  const toAcctObj = useMemo(() => {
    return (accounts || []).find(a => a.name === form.toAccount);
  }, [accounts, form.toAccount]);

  const accountList = useMemo(() => {
    const accts = (accounts || []).filter((a, i, arr) => arr.findIndex(b => (b.name || b) === (a.name || a)) === i);
    const groups = state.accountGroups || [];
    const result = [];
    for (const grp of groups) result.push(...accts.filter(a => (a.group || '') === grp).map(a => a.name || a).filter(Boolean));
    const inAnyGroup = new Set(result);
    result.push(...accts.filter(a => !inAnyGroup.has(a.name || a) && (a.name || a)).map(a => a.name || a));
    return result;
  }, [accounts, state.accountGroups]);

  const availCats = useMemo(() => {
    const wantType = form.type === 'Income' ? 'Income' : 'Expense';
    const catArr = state.categoriesArr || [];
    if (catArr.length > 0) return catArr.filter(c => (c.type || 'Expense') === wantType).map(c => c.name);
    return Object.entries(categories || {}).filter(([, d]) => (d?.type || 'Expense') === wantType).map(([n]) => n);
  }, [categories, state.categoriesArr, form.type]);

  const availSubs = useMemo(() =>
    (categories?.[form.category]?.subcategories || []).filter(s => s && s !== 'Default').sort(),
    [categories, form.category]);

  const instInfo = useMemo(() => isEdit ? parseInstalmentInfo(editTransaction?.Note) : null, [isEdit, editTransaction]);
  const isInstalmentEdit = isEdit && (!!editTransaction?.recurring_rule_id || !!instInfo);

  const instalmentStats = useMemo(() => {
    if (!isInstalmentEdit) return null;
    return getInstalmentSeriesStats(editTransaction, state.transactions, form.amount);
  }, [isInstalmentEdit, editTransaction, state.transactions, form.amount]);

  const getRecentSubsForCategory = useCallback((cat) => {
    if (!cat) return [];
    const seen = new Set(), result = [];
    for (const t of [...transactions].sort((a, b) => (b.Date || '').localeCompare(a.Date || ''))) {
      if (t.Category === cat && t.Subcategory && t.Subcategory !== 'Default') {
        if (!seen.has(t.Subcategory)) {
          seen.add(t.Subcategory);
          result.push(t.Subcategory);
        }
      }
      if (result.length >= 4) break;
    }
    return result;
  }, [transactions]);

  const recentAccounts = useMemo(() => {
    const seen = new Set(), result = [];
    for (const t of [...transactions].sort((a, b) => (b.Date || '').localeCompare(a.Date || ''))) {
      const name = t.Account || t.FromAccount || '';
      if (name && !seen.has(name)) { seen.add(name); result.push(name); }
      if (result.length >= 5) break;
    }
    return result;
  }, [transactions]);

  const recentCats = useMemo(() => {
    const wantType = form.type === 'Income' ? 'income' : 'expense';
    const seen = new Set(), result = [];
    for (const t of [...transactions].sort((a, b) => (b.Date || '').localeCompare(a.Date || ''))) {
      const tp = (t['Income/Expense'] || '').toLowerCase();
      if (tp !== wantType) continue;
      const cat = t.Category || '';
      if (cat && cat !== 'Transfer' && !seen.has(cat)) { seen.add(cat); result.push(cat); }
      if (result.length >= 5) break;
    }
    return result;
  }, [transactions, form.type]);

  const recentSubs = useMemo(() => {
    if (!form.category) return [];
    const seen = new Set(), result = [];
    for (const t of [...transactions].sort((a, b) => (b.Date || '').localeCompare(a.Date || ''))) {
      if (t.Category === form.category) {
        const sub = t.Subcategory || '';
        if (sub && sub !== 'Default' && !seen.has(sub)) {
          seen.add(sub);
          result.push(sub);
        }
      }
      if (result.length >= 5) break;
    }
    return result;
  }, [transactions, form.category]);

  const allAvailableTags = useMemo(() => {
    const seen = new Set();
    const isSystemTag = (tag) => {
      const t = tag.toLowerCase().trim();
      return t === '#stock' || t === '#consumed' || t === '#lent' || t === '#instalment' || t.startsWith('#stock_ref_');
    };
    for (const t of transactions) {
      if (t.Tags) {
        t.Tags.split(',').forEach(tag => {
          const clean = tag.trim().toLowerCase();
          if (clean && !isSystemTag(clean)) {
            seen.add(clean.startsWith('#') ? clean : `#${clean}`);
          }
        });
      }
      const matches = ((t.Note || '') + ' ' + (t.Description || '')).match(/#[a-zA-Z0-9_\u0900-\u097F-]+/g);
      if (matches) {
        matches.forEach(m => {
          const clean = m.toLowerCase();
          if (!isSystemTag(clean)) seen.add(clean);
        });
      }
    }
    try {
      const custom = JSON.parse(state.settings?.customTags || '[]');
      if (Array.isArray(custom)) {
        custom.forEach(ct => {
          const clean = String(ct).trim().toLowerCase();
          if (clean && !isSystemTag(clean)) {
            seen.add(clean.startsWith('#') ? clean : `#${clean}`);
          }
        });
      }
    } catch { }

    const defaults = ['#tax', '#personal', '#family', '#trip', '#impulse', '#work', '#medical'];
    defaults.forEach(d => seen.add(d));
    return Array.from(seen).slice(0, 25);
  }, [transactions, state.settings?.customTags]);

  const handlePasteAndParseSMS = async (directText = '') => {
    let textToParse = directText;
    if (!textToParse) {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          textToParse = await navigator.clipboard.readText();
        }
      } catch { /* clipboard read blocked */ }
    }
    if (!textToParse) {
      setSmsModal(true);
      return;
    }
    const parsed = parseBankSMS(textToParse, accountList, categories);
    if (parsed) {
      setForm(p => ({
        ...p,
        amount: parsed.amount || p.amount,
        type: parsed.type || p.type,
        account: parsed.account || p.account,
        category: parsed.category || p.category,
        note: parsed.note || p.note,
        date: parsed.date || p.date,
        time: parsed.time || p.time,
      }));
      setSmsFeedback(`⚡ Pre-filled ₹${parsed.amount} (${parsed.type}) from SMS!`);
      setTimeout(() => setSmsFeedback(''), 4000);
      setSmsModal(false);
      setSmsInputText('');
    } else {
      setSmsFeedback('Could not detect financial transaction in text.');
      setTimeout(() => setSmsFeedback(''), 4000);
    }
  };

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        set('receipt_image', dataUrl);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  const getRecentAndMostUsedNotes = (targetType = form.type) => {
    const isTargetXfer = targetType.toLowerCase().startsWith('transfer');
    const matchingTxns = transactions.filter(t => {
      const tType = (t['Income/Expense'] || 'Expense').toLowerCase();
      if (isTargetXfer) return tType.startsWith('transfer');
      return tType === targetType.toLowerCase();
    });

    // Compute frequencies of each note (stripped of instalment suffixes)
    const frequencies = {};
    for (const t of matchingTxns) {
      const note = stripInstalmentSuffix(t.Note || '').trim();
      if (!note) continue;
      frequencies[note] = (frequencies[note] || 0) + 1;
    }

    // 1. Most Used: Sort distinct notes by frequency descending
    const mostUsedNotes = Object.keys(frequencies)
      .sort((a, b) => frequencies[b] - frequencies[a])
      .slice(0, 6);

    // 2. Recent Used: Sort transactions by created_at descending (saved dates)
    const sortedByCreated = [...matchingTxns].sort((a, b) => {
      // Sort by created_at (DB saving timestamp)
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      if (Math.abs(tb - ta) > 2000) { // If difference is more than 2 seconds, trust created_at
        return tb - ta;
      }
      // Fallback to calendar date
      const da = (a.Date || '').split('/').reverse().join('-'); // Convert dd/mm/yyyy to yyyy-mm-dd
      const db = (b.Date || '').split('/').reverse().join('-');
      const dateCompare = db.localeCompare(da);
      if (dateCompare !== 0) return dateCompare;

      // Fallback to Time
      return (b.Time || '').localeCompare(a.Time || '');
    });

    const recentNotes = [];
    const seenRecent = new Set(mostUsedNotes); // Do not duplicate most used notes in recent notes
    for (const t of sortedByCreated) {
      const note = stripInstalmentSuffix(t.Note || '').trim();
      if (note && !seenRecent.has(note)) {
        seenRecent.add(note);
        recentNotes.push(note);
      }
      if (recentNotes.length >= 9) break;
    }

    const result = [];
    for (const note of mostUsedNotes) {
      result.push({ note, type: 'most_used' });
    }
    for (const note of recentNotes) {
      result.push({ note, type: 'recent' });
    }
    return result;
  };

  // State & Ref for Security Autocomplete and Note tracking
  const [secFocused, setSecFocused] = useState(false);
  const [secSugs, setSecSugs] = useState([]);
  const noteUserEditedRef = useRef(Boolean(isEdit));
  const lastEditedInvInputRef = useRef('quantity');

  // Extract distinct investment securities from transactions
  const investmentSecurities = useMemo(() => {
    const map = new Map();
    for (const t of transactions) {
      const sym = String(t.SecuritySymbol || t.security_symbol || '').trim();
      const note = stripInstalmentSuffix(t.Note || t.note || '').trim();
      const isin = String(t.SecurityISIN || t.security_isin || '').trim();
      const invType = String(t.InvestmentTransactionType || t.investment_transaction_type || '').trim();
      const isInv = Boolean(invType || isin || t.Brokerage || t.brokerage);

      const candidateKey = sym || (isInv ? note : '');
      if (!candidateKey) continue;

      const cleanDisplay = sym || note;
      // Strip technical scheme codes / plan suffixes for the clean Note
      let cleanNote = note;
      if (!cleanNote || cleanNote.includes('- Regular Plan') || cleanNote.includes('- Direct Plan') || /^[0-9A-Za-z]+[-_]/.test(cleanNote)) {
        cleanNote = cleanSecurityToNote(sym || note);
      }

      if (!map.has(candidateKey.toLowerCase())) {
        map.set(candidateKey.toLowerCase(), {
          symbol: cleanDisplay,
          note: cleanNote || cleanDisplay,
          count: 1,
          date: t.Date || ''
        });
      } else {
        const item = map.get(candidateKey.toLowerCase());
        item.count += 1;
        if (!item.note && cleanNote) item.note = cleanNote;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [transactions]);

  // Clean canonical security name into short human-readable Note
  function cleanSecurityToNote(securityStr) {
    if (!securityStr) return '';
    let s = String(securityStr).trim();
    // Strip leading technical code prefix (e.g. "127LTGPG-", "166TPDGG-", "119ETTSD-")
    s = s.replace(/^[0-9A-Za-z]+[-_]\s*/, '');
    // Strip common technical fund suffixes
    s = s.replace(/\s*-\s*(Direct|Regular)\s+Plan.*$/i, '');
    s = s.replace(/\s*\((Non Demat|Demat)\)/gi, '');
    s = s.replace(/\s*-\s*Growth.*$/i, '');
    s = s.replace(/\s+Growth(\s+Plan)?/gi, '');
    // Clean trailing punctuation / whitespace
    s = s.replace(/[\s\-_]+$/, '').trim();
    return s;
  }

  const handleSecurityChange = (v) => {
    set('securitySymbol', v);
    if (v.trim().length > 0) {
      const q = v.toLowerCase();
      const filtered = investmentSecurities.filter(s =>
        s.symbol.toLowerCase().includes(q) || (s.note && s.note.toLowerCase().includes(q))
      ).slice(0, 10);
      setSecSugs(filtered);
    } else {
      setSecSugs([]);
    }
  };

  const handleSelectSecurity = (item) => {
    set('securitySymbol', item.symbol);
    // If user has not manually customized their Note, auto-fill Note with clean human-readable name
    if (!noteUserEditedRef.current && (!form.note || !form.note.trim())) {
      const cleanName = item.note || cleanSecurityToNote(item.symbol) || item.symbol;
      set('note', cleanName);
    }
    setSecSugs([]);
    setSecFocused(false);
  };

  const roundNum = (n, maxDec = 2) => {
    if (isNaN(n) || n === null || n === '') return '';
    const factor = Math.pow(10, maxDec);
    return String(Math.round((Number(n) + Number.EPSILON) * factor) / factor);
  };

  const calcPnl = (tradeValStr, costBasisStr) => {
    if (tradeValStr === '' || tradeValStr === null || tradeValStr === undefined) return '';
    if (costBasisStr === '' || costBasisStr === null || costBasisStr === undefined) return '';
    const v = parseFloat(tradeValStr);
    const cb = parseFloat(costBasisStr);
    if (!isNaN(v) && !isNaN(cb)) {
      return roundNum(v - cb, 2);
    }
    return '';
  };

  // Controlled 2-of-3 calculation model for Units, Price, Trade Value & SELL Realized P&L
  const handleUnitsChange = (val) => {
    lastEditedInvInputRef.current = 'quantity';
    setForm(prev => {
      const q = parseFloat(val);
      const p = parseFloat(prev.unitPrice);
      const invType = (prev.investmentTransactionType || 'BUY').toUpperCase();

      let nextTradeVal = prev.tradeValue;

      // Rule: Editing Units only derives Trade Value if BOTH Units and NAV are valid positive numbers.
      // Editing Units NEVER mutates NAV.
      if (!isNaN(q) && q > 0 && !isNaN(p) && p > 0) {
        nextTradeVal = roundNum(q * p, 2);
      }

      const nextPnl = invType === 'SELL' ? calcPnl(nextTradeVal, prev.costBasis) : prev.realizedPnl;

      return {
        ...prev,
        quantity: val,
        tradeValue: nextTradeVal,
        amount: nextTradeVal,
        realizedPnl: nextPnl
      };
    });
    if (errors.quantity) setErrors(p => ({ ...p, quantity: '' }));
  };

  const handlePriceChange = (val) => {
    lastEditedInvInputRef.current = 'unitPrice';
    setForm(prev => {
      const p = parseFloat(val);
      const q = parseFloat(prev.quantity);
      const invType = (prev.investmentTransactionType || 'BUY').toUpperCase();

      let nextTradeVal = prev.tradeValue;

      // Rule: Editing NAV only derives Trade Value if BOTH Units and NAV are valid positive numbers.
      // Editing NAV NEVER mutates Units.
      if (!isNaN(p) && p > 0 && !isNaN(q) && q > 0) {
        nextTradeVal = roundNum(q * p, 2);
      }

      const nextPnl = invType === 'SELL' ? calcPnl(nextTradeVal, prev.costBasis) : prev.realizedPnl;

      return {
        ...prev,
        unitPrice: val,
        tradeValue: nextTradeVal,
        amount: nextTradeVal,
        realizedPnl: nextPnl
      };
    });
    if (errors.unitPrice) setErrors(p => ({ ...p, unitPrice: '' }));
  };

  const handleTradeValueChange = (val) => {
    setForm(prev => {
      const v = parseFloat(val);
      const q = parseFloat(prev.quantity);
      const p = parseFloat(prev.unitPrice);
      const invType = (prev.investmentTransactionType || 'BUY').toUpperCase();

      let nextUnitPrice = prev.unitPrice;
      let nextQuantity = prev.quantity;

      // Rule: Editing Trade Value derives either NAV or Units only when Trade Value is a valid positive number.
      if (!isNaN(v) && v > 0) {
        if (!isNaN(q) && q > 0) {
          nextUnitPrice = roundNum(v / q, 4);
        } else if (!isNaN(p) && p > 0) {
          nextQuantity = roundNum(v / p, 3);
        }
      }

      const nextPnl = invType === 'SELL' ? calcPnl(val, prev.costBasis) : prev.realizedPnl;

      return {
        ...prev,
        tradeValue: val,
        amount: val,
        unitPrice: nextUnitPrice,
        quantity: nextQuantity,
        realizedPnl: nextPnl
      };
    });
    if (errors.tradeValue) setErrors(p => ({ ...p, tradeValue: '' }));
    if (errors.amount) setErrors(p => ({ ...p, amount: '' }));
  };

  const handleCostBasisChange = (val) => {
    setForm(prev => {
      const currentTradeVal = prev.tradeValue || prev.amount;
      const nextPnl = calcPnl(currentTradeVal, val);
      return {
        ...prev,
        costBasis: val,
        realizedPnl: nextPnl
      };
    });
    if (errors.costBasis) setErrors(p => ({ ...p, costBasis: '' }));
  };

  const handleNoteChange = (v) => {
    noteUserEditedRef.current = true;
    set('note', v);
    if (v.trim().length > 0) {
      const q = v.toLowerCase(), seen = new Set();
      if (isInvMode) {
        const sugs = investmentSecurities
          .map(s => s.note || cleanSecurityToNote(s.symbol) || s.symbol)
          .filter(n => {
            if (!n || seen.has(n.toLowerCase()) || !n.toLowerCase().includes(q)) return false;
            seen.add(n.toLowerCase());
            return true;
          }).slice(0, 10);
        setNoteSugs(sugs);
      } else {
        const matchedTxns = transactions.filter(t => {
          const isTargetXfer = form.type.toLowerCase().startsWith('transfer');
          const tType = (t['Income/Expense'] || 'Expense').toLowerCase();
          if (isTargetXfer) return tType.startsWith('transfer');
          return tType === form.type.toLowerCase();
        });
        const sugs = matchedTxns.map(t => stripInstalmentSuffix(t.Note || '')).filter(n => {
          if (!n || seen.has(n.toLowerCase()) || !n.toLowerCase().includes(q)) return false;
          seen.add(n.toLowerCase());
          return true;
        }).slice(0, 15);
        setNoteSugs(sugs);
      }
    } else {
      setNoteSugs([]);
    }
  };

  const handleNoteFocus = () => {
    setPickerState(null);
    setNoteFocused(true);
    // Never show suggestions on empty Note field
    if (!form.note || !form.note.trim()) {
      setNoteSugs([]);
    } else {
      handleNoteChange(form.note);
    }
  };

  const isInvEdit = Boolean(
    editTransaction?.InvestmentTransactionType ||
    editTransaction?.investment_transaction_type ||
    editTransaction?.Brokerage ||
    editTransaction?.brokerage ||
    (editTransaction?.SecuritySymbol && editTransaction?.SecurityISIN)
  );
  const isInvMode = Boolean(form.type === 'Investment' || form.type === 'BUY' || form.type === 'SELL' || isInvEdit);

  const currentTypes = TYPES;

  const validate = () => {
    const e = {};
    if (!form.date) e.date = 'Required';

    if (isInvMode && !isTransfer) {
      const invType = (form.investmentTransactionType || 'BUY').toUpperCase();
      if (!form.account) e.account = 'Select investment account';
      if (!form.securitySymbol && !form.note) e.securitySymbol = 'Enter security name or note';

      const q = parseFloat(form.quantity);
      const p = parseFloat(form.unitPrice);
      const v = parseFloat(form.tradeValue || form.amount);

      const hasQ = !isNaN(q) && q > 0;
      const hasP = !isNaN(p) && p > 0;
      const hasV = !isNaN(v) && v > 0;

      const suppliedCount = [hasQ, hasP, hasV].filter(Boolean).length;
      if (suppliedCount < 2) {
        e.tradeValue = 'Enter at least 2 of: Units, Price/NAV, Trade Value';
        if (!hasQ) e.quantity = 'Required (or enter Price + Trade Value)';
        if (!hasP) e.unitPrice = 'Required (or enter Units + Trade Value)';
      } else if (hasQ && hasP && hasV) {
        const expectedV = q * p;
        const diff = Math.abs(expectedV - v);
        const tolerance = Math.max(0.50, v * 0.01); // 50 paisa or 1% tolerance
        if (diff > tolerance) {
          e.tradeValue = `Trade Value (₹${v.toFixed(2)}) inconsistent with Units (${q}) × Price (₹${p}) = ₹${expectedV.toFixed(2)}`;
        }
      }

      if (invType === 'SELL') {
        const cb = parseFloat(form.costBasis);
        if (isNaN(cb) || cb < 0) {
          e.costBasis = 'Enter cost basis for SELL transaction';
        }
      }
    } else if (isTransfer) {
      if (form.amount === '' || form.amount === undefined || isNaN(parseFloat(form.amount))) e.amount = 'Enter a valid amount';
      if (!form.fromAccount) e.fromAccount = 'Select from account';
      if (!form.toAccount) e.toAccount = 'Select to account';
    } else if (isSplit) {
      if (form.amount === '' || form.amount === undefined || isNaN(parseFloat(form.amount))) e.amount = 'Enter a valid amount';
      if (!form.account) e.account = 'Select account';
      if (form.amount && !isNaN(parseFloat(form.amount)) && Math.abs(splitRemaining) >= 0.01) {
        e.splits = `Allocated sum (₹${allocatedSplitSum}) must match entered total (₹${form.amount})`;
      }
      for (let i = 0; i < splits.length; i++) {
        if (!splits[i].category) e.splits = `Select category for split part ${i + 1}`;
        if (splits[i].amount === '' || isNaN(parseFloat(splits[i].amount))) e.splits = `Enter valid amount for split part ${i + 1}`;
        if (!splits[i].note || !splits[i].note.trim()) e.splits = `Enter note for split part ${i + 1}`;
      }
    } else {
      if (form.amount === '' || form.amount === undefined || isNaN(parseFloat(form.amount))) e.amount = 'Enter a valid amount';
      if (!form.account) e.account = 'Select account';
      if (!form.category) e.category = 'Select category';
    }
    setErrors(e); return Object.keys(e).length === 0;
  };

  const handleSave = async (shouldContinue = false) => {
    if (!validate() || saving) return;
    setSaving(true);
    try {
      const baseNote = form.note || '';
      const totalAmount = isSplit && allocatedSplitSum > 0 ? allocatedSplitSum : (parseFloat(form.amount) || 0);

      // Extract hashtags from Note & Description and combine with manual tags
      const noteAndDesc = `${baseNote} ${form.description || ''}`;
      const extractedHashtags = (noteAndDesc.match(/#[a-zA-Z0-9_\u0900-\u097F-]+/g) || []).map(t => t.toLowerCase());
      const manualTags = (form.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean).map(t => t.startsWith('#') ? t : `#${t}`);
      const combinedTags = Array.from(new Set([...manualTags, ...extractedHashtags])).join(', ');

      if (isSplit && !isTransfer && !isEdit) {
        const splitGroupId = 'split-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        for (const s of splits) {
          const splitAmt = parseFloat(s.amount) || 0;
          await addTransaction({
            Date: inputToStorage(form.date),
            Time: form.time || '',
            Account: form.account,
            Category: s.category,
            Subcategory: s.subcategory || 'Default',
            Note: s.note.trim(),
            Description: form.description || '',
            INR: splitAmt,
            Amount: String(splitAmt),
            Currency: 'INR',
            'Income/Expense': form.type,
            Tags: combinedTags,
            split_group_id: splitGroupId,
            SubAccount: form.subAccount,
          });
        }
        onClose();
        return;
      }

      if (!isEdit && recurringConfig) {
        const isoDate = form.date;
        const txnDate = inputToStorage(form.date);

        if (recurringConfig.type === 'instalment') {
          const rule = {
            rule_type: 'instalment', status: 'completed',
            txn_type: form.type,
            account: form.account, from_account: form.fromAccount || '', to_account: form.toAccount || '',
            category: form.category, subcategory: form.subcategory || '',
            base_note: baseNote, description: form.description || '',
            currency: 'INR', total_amount: totalAmount,
            total_days: recurringConfig.totalDays,
            start_date: isoDate,
            schedule_mode: recurringConfig.scheduleMode,
          };
          const schedule = buildInstalmentSchedule(rule);
          rule.total_parts = schedule.length;
          rule.completed_parts = schedule.length;
          rule.next_date = '';
          rule.end_date = schedule[schedule.length - 1]?.date || '';
          rule.amount_per_part = schedule[0]?.amount || 0;
          const saved = await createRecurringRule(rule);
          for (const inst of schedule) {
            const [iy, im, id2] = inst.date.split('-');
            const instTxnDate = `${id2}/${im}/${iy}`;
            await addTransaction({
              Date: instTxnDate, Time: form.time || '00:00',
              Account: form.account, FromAccount: form.fromAccount || '', ToAccount: form.toAccount || '',
              Category: form.category, Subcategory: form.subcategory || 'Default',
              Note: buildInstalmentNote(baseNote, inst.part, inst.total),
              Description: form.description || '',
              INR: inst.amount, Amount: String(inst.amount),
              Currency: 'INR', 'Income/Expense': form.type,
              recurring_rule_id: saved.id,
              Tags: combinedTags,
              SubAccount: isTransfer ? form.fromSubAccount : form.subAccount,
              FromSubAccount: isTransfer ? form.fromSubAccount : '',
              ToSubAccount: isTransfer ? form.toSubAccount : '',
            });
          }
        } else if (recurringConfig.type === 'repeat') {
          const nextDate = computeNextRepeatDate(isoDate, recurringConfig.frequency, recurringConfig.scheduleMode);
          const rule = {
            rule_type: 'repeat', status: 'active',
            txn_type: form.type,
            account: form.account, from_account: form.fromAccount || '', to_account: form.toAccount || '',
            category: form.category, subcategory: form.subcategory || '',
            base_note: baseNote, description: form.description || '',
            currency: 'INR', amount_per_part: totalAmount,
            start_date: isoDate,
            next_date: nextDate,
            schedule_mode: recurringConfig.scheduleMode,
            frequency: recurringConfig.frequency,
            completed_parts: 1,
          };
          const saved = await createRecurringRule(rule);
          await addTransaction({
            Date: txnDate, Time: form.time || '',
            Account: form.account, FromAccount: form.fromAccount || '', ToAccount: form.toAccount || '',
            Category: isTransfer ? 'Transfer' : form.category,
            Subcategory: form.subcategory || 'Default',
            Note: baseNote, Description: form.description || '',
            INR: totalAmount, Amount: form.amount,
            Currency: 'INR', 'Income/Expense': form.type,
            recurring_rule_id: saved.id,
            Tags: combinedTags,
            SubAccount: isTransfer ? form.fromSubAccount : form.subAccount,
            FromSubAccount: isTransfer ? form.fromSubAccount : '',
            ToSubAccount: isTransfer ? form.toSubAccount : '',
          });
        }
      } else {
        // Check if saving an investment transaction
        const isInvSave = Boolean(
          form.type === 'Investment' ||
          form.type === 'BUY' ||
          form.type === 'SELL' ||
          form.investmentTransactionType ||
          (isEdit && (editTransaction?.InvestmentTransactionType || editTransaction?.Brokerage))
        );

        if (isInvSave && !isTransfer) {
          const invType = form.type === 'BUY' || form.type === 'SELL' ? form.type : (form.investmentTransactionType || 'BUY');
          let qty = parseFloat(form.quantity) || 0;
          let price = parseFloat(form.unitPrice) || 0;
          let tradeVal = parseFloat(form.tradeValue) || (qty * price) || parseFloat(form.amount) || 0;

          if (tradeVal > 0 && qty > 0 && (!price || price <= 0)) {
            price = parseFloat(roundNum(tradeVal / qty, 4));
          } else if (tradeVal > 0 && price > 0 && (!qty || qty <= 0)) {
            qty = parseFloat(roundNum(tradeVal / price, 3));
          } else if (qty > 0 && price > 0 && (!tradeVal || tradeVal <= 0)) {
            tradeVal = parseFloat(roundNum(qty * price, 2));
          }

          const costBasis = parseFloat(form.costBasis) || 0;
          const realizedPnl = parseFloat(form.realizedPnl) || 0;

          const currentInvAcct = form.investmentAccount || form.account || '';
          const currentSubAcct = form.subAccount || '';
          const fundingBankAcct = (invType === 'BUY' ? form.fundingAccount : (form.settlementAccount || form.fundingAccount)) || '';
          const isFundedFromBank = Boolean(fundingBankAcct && fundingBankAcct.toLowerCase() !== currentInvAcct.toLowerCase());

          // For BUY: money leaves fundingBankAcct (FromAccount) and enters currentInvAcct (ToAccount)
          // For SELL: money leaves currentInvAcct (FromAccount) and enters fundingBankAcct (ToAccount)
          const fromAcct = invType === 'BUY'
            ? (isFundedFromBank ? fundingBankAcct : currentInvAcct)
            : currentInvAcct;

          const toAcct = invType === 'BUY'
            ? currentInvAcct
            : (isFundedFromBank ? fundingBankAcct : currentInvAcct);

          // Preserve exact Amount & INR semantics for historical CAS vs other investment records:
          const isCasSell = isEdit && invType === 'SELL' && (parseFloat(editTransaction?.INR || 0) === 0 || String(editTransaction?.Amount || '') === '0.0') && !isFundedFromBank;
          const savedInr = isCasSell ? 0 : tradeVal;
          const savedAmount = isCasSell ? (editTransaction?.Amount || '0.0') : String(tradeVal);

          const fromSub = invType === 'BUY'
            ? (isFundedFromBank ? '' : currentSubAcct)
            : currentSubAcct;

          const toSub = invType === 'BUY'
            ? currentSubAcct
            : (isFundedFromBank ? '' : currentSubAcct);

          // In double-entry, Account represents the primary source / outflow account:
          const primaryAcct = isFundedFromBank && invType === 'BUY' ? fundingBankAcct : currentInvAcct;

          const invData = {
            Date: inputToStorage(form.date),
            Time: form.time || '',
            Account: primaryAcct,
            FromAccount: fromAcct,
            ToAccount: toAcct,
            Category: currentInvAcct,
            Subcategory: form.subcategory || 'Default',
            Note: baseNote || form.securitySymbol || '',
            Description: form.description || (isEdit ? (editTransaction?.Description || '') : ''),
            INR: savedInr,
            Amount: savedAmount,
            Currency: 'INR',
            'Income/Expense': isEdit ? (editTransaction?.['Income/Expense'] || 'Transfer-Out') : 'Transfer-Out',
            recurring_rule_id: editTransaction?.recurring_rule_id || '',
            Tags: combinedTags,
            receipt_image: form.receipt_image || '',
            warranty_expiry: form.warranty_expiry || '',
            serial_no: form.serial_no || '',
            _id: editTransaction?._id,
            ID: editTransaction?.ID || editTransaction?.id || editTransaction?._id,
            InvestmentAccount: currentInvAcct,
            investment_account: currentInvAcct,
            SubAccount: currentSubAcct,
            FromSubAccount: fromSub,
            ToSubAccount: toSub,
            InvestmentTransactionType: invType,
            Brokerage: currentSubAcct,
            SecuritySymbol: form.securitySymbol || baseNote || '',
            SecurityISIN: form.securityISIN || (isEdit ? (editTransaction?.SecurityISIN || '') : ''),
            Quantity: qty,
            UnitPrice: price,
            TradeValue: tradeVal,
            CostBasis: costBasis,
            RealizedPnl: realizedPnl,
            CashImpact: isCasSell ? 0 : (invType === 'BUY' ? -tradeVal : tradeVal),
            PositionQuantityChange: invType === 'SELL' ? -Math.abs(qty) : Math.abs(qty),
            Source: isEdit ? (editTransaction?.Source || 'Manual') : 'Manual',
            AccountingClassification: isEdit ? (editTransaction?.AccountingClassification || 'REAL_INVESTMENT_TRANSACTION') : 'REAL_INVESTMENT_TRANSACTION'
          };

          if (isEdit) {
            await updateTransaction(editTransaction._id || editTransaction.id || editTransaction.ID, invData);
          } else {
            await addTransaction(invData);
          }
        } else {
          // Normal single transaction or instalment edit
          const instInfo = parseInstalmentInfo(editTransaction?.Note);
          const isInstalmentEdit = isEdit && (!!editTransaction?.recurring_rule_id || !!instInfo);
          const thisNote = isInstalmentEdit && instInfo
            ? `${baseNote} (${instInfo.part}/${instInfo.total})`.trim()
            : baseNote;
          const data = {
            Date: inputToStorage(form.date), Time: form.time || '',
            Account: isTransfer ? form.fromAccount : form.account,
            FromAccount: isTransfer ? form.fromAccount : '', ToAccount: isTransfer ? form.toAccount : '',
            Category: isTransfer ? 'Transfer' : form.category,
            Subcategory: form.subcategory || 'Default',
            Note: thisNote, Description: form.description || '',
            INR: totalAmount, Amount: form.amount,
            Currency: 'INR', 'Income/Expense': form.type,
            recurring_rule_id: editTransaction?.recurring_rule_id || '',
            Tags: combinedTags,
            receipt_image: form.receipt_image || '',
            warranty_expiry: form.warranty_expiry || '',
            serial_no: form.serial_no || '',
            _id: editTransaction?._id,
            SubAccount: isTransfer ? form.fromSubAccount : form.subAccount,
            FromSubAccount: isTransfer ? form.fromSubAccount : '',
            ToSubAccount: isTransfer ? form.toSubAccount : '',
          };
          if (isInstalmentEdit) {
            await updateInstalmentSiblings(editTransaction.recurring_rule_id, data, editTransaction);
          } else if (isEdit) {
            await updateTransaction(editTransaction._id, data);
          } else {
            await addTransaction(data);
          }
        }
      }
      if (shouldContinue) {
        setForm(p => ({
          ...p,
          amount: '',
          note: '',
          description: '',
          tags: '',
        }));
        setRecurringConfig(null);
        setShowRecurring(false);
        setErrors({});
        setSaving(false);
        setTimeout(() => {
          amountRef.current?.focus();
        }, 100);
        if (onSaveAndContinue) onSaveAndContinue();
      } else {
        onClose();
      }
    } finally { setSaving(false); }
  };

  // Smart focus flow: after a field is selected, move to the next EMPTY required field
  // Order: account → category → subcategory (if available) → amount (if empty) → note
  // subsForCat: pass the subcategories for the just-selected category (avoids stale closure)
  // afterCategory: called when category is selected (both add AND edit mode).
  // In edit: opens subcat picker if subs exist (user just changed category, may need new subcat).
  // In add:  same, then continues to amount/note if no subs.
  const afterCategory = (catVal, freshSubs) => {
    setTimeout(() => {
      if (freshSubs && freshSubs.length > 0) {
        subcatRef.current?.open();
      } else if (!isEdit) {
        if (!form.amount) amountRef.current?.focus(); else noteRef.current?.focus();
      }
    }, 120);
  };

  // goNextEmpty: smart flow for account/amount/note — does NOT touch subcategory
  const goNextEmpty = (justFilled) => {
    if (isEdit) return;
    const currentForm = formRefLatest.current;
    const snap = { ...currentForm };
    if (justFilled) snap[justFilled.key] = justFilled.val;
    const currentIsTransfer = snap.type === 'Transfer-Out';
    setTimeout(() => {
      if (currentIsTransfer) {
        if (!snap.fromAccount) { fromRef.current?.open(); return; }
        if (!snap.toAccount) {
          setTimeout(() => { toRef.current?.open(); }, 80);
          return;
        }
      } else {
        if (!snap.account) { accountRef.current?.open(); return; }
        if (!snap.category) { categoryRef.current?.open(); return; }
      }
      if (!snap.amount) { amountRef.current?.focus(); return; }
      if (!snap.note) { noteRef.current?.focus(); return; }
    }, 120);
  };

  return (
    <>
      <div className="fullscreen-modal" data-type={form.type}>
        <div className="add-hdr">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="add-title">{form.type === 'Transfer-Out' ? 'Transfer' : form.type || (isEdit ? 'Edit' : 'Add')}</div>
            {!isEdit && (
              <button
                type="button"
                onClick={() => handlePasteAndParseSMS()}
                style={{
                  background: 'rgba(0, 229, 160, 0.15)',
                  border: '1px solid var(--accent)',
                  color: 'var(--accent)',
                  borderRadius: 12,
                  padding: '3px 8px',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3
                }}
              >
                ⚡ Paste SMS / UPI
              </button>
            )}
          </div>
          <button className="add-close" onClick={onClose}>✕</button>
        </div>
        {smsFeedback && (
          <div style={{
            background: smsFeedback.includes('Pre-filled') ? 'rgba(0,229,160,0.15)' : 'rgba(255,77,106,0.15)',
            color: smsFeedback.includes('Pre-filled') ? 'var(--income)' : 'var(--expense)',
            fontSize: '0.72rem', fontWeight: 700, padding: '4px 14px', textAlign: 'center'
          }}>
            {smsFeedback}
          </div>
        )}
        <div className="type-tabs">
          {currentTypes.map(tp => (
            <button key={tp.id} className={`type-tab ${tp.cls} ${form.type === tp.id ? 'active' : ''}`} onClick={() => {
              set('type', tp.id);
              if (noteFocused) {
                if (!form.note || !form.note.trim()) {
                  setNoteSugs(getRecentAndMostUsedNotes(tp.id));
                } else {
                  const q = form.note.toLowerCase(), seen = new Set();
                  const matched = transactions
                    .filter(t => (t['Income/Expense'] || 'Expense').toLowerCase() === tp.id.toLowerCase())
                    .map(t => stripInstalmentSuffix(t.Note || ''))
                    .filter(n => {
                      if (!n || seen.has(n) || !n.toLowerCase().includes(q)) return false;
                      seen.add(n);
                      return true;
                    }).slice(0, 6);
                  setNoteSugs(matched);
                }
              }
            }}>
              {tp.label}
            </button>
          ))}
        </div>

        <div className="add-form">
          {isInvMode ? (
            <>
              {/* Investment Mode Toggle Pills */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button
                  type="button"
                  style={{
                    flex: 1, padding: '8px 12px', borderRadius: 'var(--r-md)', fontWeight: 800, fontSize: '0.82rem',
                    background: (form.investmentTransactionType || 'BUY') === 'BUY' ? 'rgba(0,229,160,0.2)' : 'var(--bg-input)',
                    color: (form.investmentTransactionType || 'BUY') === 'BUY' ? 'var(--income)' : 'var(--text-muted)',
                    border: `1.5px solid ${(form.investmentTransactionType || 'BUY') === 'BUY' ? 'var(--income)' : 'var(--border)'}`,
                    cursor: 'pointer', transition: 'var(--transition)'
                  }}
                  onClick={() => set('investmentTransactionType', 'BUY')}
                >
                  🟢 BUY
                </button>
                <button
                  type="button"
                  style={{
                    flex: 1, padding: '8px 12px', borderRadius: 'var(--r-md)', fontWeight: 800, fontSize: '0.82rem',
                    background: form.investmentTransactionType === 'SELL' ? 'rgba(255,77,106,0.2)' : 'var(--bg-input)',
                    color: form.investmentTransactionType === 'SELL' ? 'var(--expense)' : 'var(--text-muted)',
                    border: `1.5px solid ${form.investmentTransactionType === 'SELL' ? 'var(--expense)' : 'var(--border)'}`,
                    cursor: 'pointer', transition: 'var(--transition)'
                  }}
                  onClick={() => {
                    setForm(prev => {
                      const nextPnl = calcPnl(prev.tradeValue || prev.amount, prev.costBasis);
                      return {
                        ...prev,
                        investmentTransactionType: 'SELL',
                        realizedPnl: nextPnl || prev.realizedPnl
                      };
                    });
                  }}
                >
                  🔴 SELL
                </button>
              </div>

              {/* 1. Date & Time */}
              <div className="form-group date-time-group">
                <label className="form-label">Date</label>
                <div className="date-time-row">
                  <div className="date-time-inputs">
                    <input className={`form-input ${errors.date ? 'err' : ''}`} type="date" value={form.date} onChange={e => set('date', e.target.value)} onFocus={() => setPickerState(null)} />
                    <input className="form-input" type="time" value={form.time} onChange={e => set('time', e.target.value)} onFocus={() => setPickerState(null)} />
                  </div>
                </div>
              </div>

              {/* 2. Investment Account */}
              <PickerFieldFR
                setPickerState={setPickerState}
                ref={accountRef}
                label="Investment Account"
                value={form.investmentAccount || form.account}
                placeholder="Select investment account"
                error={errors.account}
                items={accountList}
                recent={recentAccounts}
                onSelect={v => {
                  setForm(prev => {
                    const matched = (accounts || []).find(a => (a.name || '').toLowerCase() === v.toLowerCase()) || { name: v, subAccounts: [] };
                    const subs = getSortedSubs(matched);
                    const nextSub = subs.length > 0 ? (subs.includes(prev.subAccount) ? prev.subAccount : subs[0]) : '';
                    return {
                      ...prev,
                      investmentAccount: v,
                      account: v,
                      subAccount: nextSub
                    };
                  });
                }}
                onAfterSelect={() => setPickerState(null)}
                onReorder={() => setReorderScreen('accounts')}
                active={pickerState && pickerState.type === 'investmentaccount'}
              />

              {/* 3. Platform / Subaccount */}
              <div className="form-group" style={{ marginTop: 8 }}>
                <label className="form-label" style={{ fontSize: '0.68rem', marginBottom: 2 }}>Platform / Subaccount</label>
                <select
                  className="form-input"
                  style={{ fontSize: '0.78rem', height: 36, padding: '4px 8px' }}
                  value={form.subAccount}
                  onChange={e => set('subAccount', e.target.value)}
                >
                  <option value="">(Select Platform / Subaccount)</option>
                  {selectedAcctObj && getSortedSubs(selectedAcctObj).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              {/* 4. Funding Account (BUY) or Settlement Account (SELL) */}
              <div className="form-group" style={{ marginTop: 8 }}>
                <label className="form-label" style={{ fontSize: '0.68rem', marginBottom: 2 }}>
                  {(form.investmentTransactionType || 'BUY') === 'BUY' ? 'Funding Account' : 'Settlement Account'}
                </label>
                <select
                  className="form-input"
                  style={{ fontSize: '0.78rem', height: 36, padding: '4px 8px' }}
                  value={(form.investmentTransactionType || 'BUY') === 'BUY' ? form.fundingAccount : (form.settlementAccount || form.fundingAccount)}
                  onChange={e => {
                    const val = e.target.value;
                    setForm(p => ({ ...p, fundingAccount: val, settlementAccount: val }));
                  }}
                >
                  <option value="">(None / Direct Portfolio Cash)</option>
                  {accountList.filter(a => a.toLowerCase() !== (form.investmentAccount || form.account || '').toLowerCase()).map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>

              {/* 5. Security / Fund */}
              <div className="form-group" style={{ marginTop: 8, position: 'relative' }}>
                <label className="form-label">Security / Fund</label>
                <input
                  className={`form-input ${errors.securitySymbol ? 'err' : ''}`}
                  type="text"
                  placeholder="e.g. Motilal Oswal ELSS or TCS"
                  value={form.securitySymbol}
                  onFocus={() => {
                    setSecFocused(true);
                    if (form.securitySymbol && form.securitySymbol.trim()) {
                      handleSecurityChange(form.securitySymbol);
                    } else {
                      setSecSugs([]);
                    }
                  }}
                  onChange={e => handleSecurityChange(e.target.value)}
                  onBlur={() => {
                    setTimeout(() => setSecFocused(false), 200);
                    if (!noteUserEditedRef.current && (!form.note || !form.note.trim()) && form.securitySymbol?.trim()) {
                      set('note', cleanSecurityToNote(form.securitySymbol) || form.securitySymbol.trim());
                    }
                  }}
                />
                {errors.securitySymbol && <div className="field-error" style={{ color: 'var(--expense)', fontSize: '0.7rem', marginTop: 3 }}>{errors.securitySymbol}</div>}
                {secFocused && secSugs.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                    background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.4)', maxHeight: 200, overflowY: 'auto', marginTop: 4
                  }}>
                    {secSugs.map((s, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                        }}
                        onMouseDown={() => handleSelectSecurity(s)}
                      >
                        <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>{s.symbol}</span>
                        {s.note && s.note !== s.symbol && (
                          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{s.note}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 6. Note */}
              <div className="form-group" style={{ marginTop: 8 }}>
                <label className="form-label">Note</label>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input
                    ref={el => { textInputRef(el); noteRef.current = el; }}
                    className="form-input"
                    type="text"
                    value={form.note}
                    placeholder="e.g. Motilal Oswal ELSS"
                    style={{ paddingRight: (form.note || noteFocused) ? '30px' : undefined }}
                    autoComplete="on" autoCorrect="on" spellCheck="true" autoCapitalize="sentences"
                    onChange={e => handleNoteChange(e.target.value)}
                    onFocus={handleNoteFocus}
                    onBlur={() => { setNoteFocused(false); setTimeout(() => setNoteSugs([]), 180); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); descriptionRef.current?.focus(); } }}
                  />
                  {noteFocused && (
                    <button
                      type="button"
                      onMouseDown={e => { e.preventDefault(); set('note', ''); setNoteSugs([]); setNoteFocused(false); }}
                      style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, padding: '4px', borderRadius: '50%', zIndex: 1 }}
                    >
                      ✕
                    </button>
                  )}
                  {noteSugs.length > 0 && (
                    <div className="note-sug-list">
                      {noteSugs.map(s => {
                        const isObj = typeof s === 'object';
                        const label = isObj ? s.note : s;
                        return (
                          <div key={label} className="note-sug-item" onMouseDown={() => { set('note', label); setNoteSugs([]); }} style={{ display: 'flex', alignItems: 'center' }}>
                            <span className="note-sug-text">{label}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* 7. Controlled 2-of-3 inputs: Units, NAV/Price, Trade Value */}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <div className="form-group" style={{ flex: 1, margin: 0 }}>
                  <label className="form-label">Units / Quantity</label>
                  <input
                    className={`form-input ${errors.quantity ? 'err' : ''}`}
                    type="text"
                    inputMode="decimal"
                    placeholder="0.000"
                    value={form.quantity}
                    onChange={e => handleUnitsChange(e.target.value)}
                  />
                  {errors.quantity && <div className="field-error" style={{ color: 'var(--expense)', fontSize: '0.7rem', marginTop: 3 }}>{errors.quantity}</div>}
                </div>
                <div className="form-group" style={{ flex: 1, margin: 0 }}>
                  <label className="form-label">NAV / Price (₹)</label>
                  <input
                    className={`form-input ${errors.unitPrice ? 'err' : ''}`}
                    type="text"
                    inputMode="decimal"
                    placeholder="0.0000"
                    value={form.unitPrice}
                    onChange={e => handlePriceChange(e.target.value)}
                  />
                  {errors.unitPrice && <div className="field-error" style={{ color: 'var(--expense)', fontSize: '0.7rem', marginTop: 3 }}>{errors.unitPrice}</div>}
                </div>
              </div>

              <div className="form-group" style={{ marginTop: 8 }}>
                <label className="form-label">Trade Value (₹)</label>
                <input
                  className={`form-input ${errors.tradeValue || errors.amount ? 'err' : ''}`}
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={form.tradeValue || form.amount}
                  onChange={e => handleTradeValueChange(e.target.value)}
                />
                {errors.tradeValue && <div className="field-error" style={{ color: 'var(--expense)', fontSize: '0.7rem', marginTop: 3 }}>{errors.tradeValue}</div>}
              </div>

              {/* 8. SELL-specific: Cost Basis & Realized P&L */}
              {(form.investmentTransactionType || 'BUY') === 'SELL' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <div className="form-group" style={{ flex: 1, margin: 0 }}>
                    <label className="form-label">Cost Basis (₹)</label>
                    <input
                      className={`form-input ${errors.costBasis ? 'err' : ''}`}
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={form.costBasis}
                      onChange={e => handleCostBasisChange(e.target.value)}
                    />
                    {errors.costBasis && <div className="field-error" style={{ color: 'var(--expense)', fontSize: '0.7rem', marginTop: 3 }}>{errors.costBasis}</div>}
                  </div>
                  <div className="form-group" style={{ flex: 1, margin: 0 }}>
                    <label className="form-label">Realized P&L (₹)</label>
                    <input
                      className="form-input"
                      type="text"
                      readOnly
                      placeholder="0.00"
                      value={form.realizedPnl}
                      style={{
                        fontWeight: 700,
                        color: parseFloat(form.realizedPnl) >= 0 ? 'var(--income)' : 'var(--expense)',
                        background: 'var(--bg-card)'
                      }}
                    />
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              {/* Row 1: Date + Time */}
              <div className="form-group date-time-group">
                <label className="form-label">Date</label>
                <div className="date-time-row">
                  <div className="date-time-inputs">
                    <input className={`form-input ${errors.date ? 'err' : ''}`} type="date" value={form.date} onChange={e => set('date', e.target.value)} onFocus={() => setPickerState(null)} />
                    <input className="form-input" type="time" value={form.time} onChange={e => set('time', e.target.value)} onFocus={() => setPickerState(null)} />
                  </div>
                  {!isEdit && (
                    <button type="button" className="recurring-button" onClick={() => setShowRecurring(true)}>
                      <span>{recurringConfig ? (recurringConfig.type === 'instalment' ? '📋' : '🔁') : '🔁'}</span>
                      <span>{recurringConfig ? (recurringConfig.type === 'instalment' ? 'Instalment' : 'Repeat') : 'Rep/Inst'}</span>
                    </button>
                  )}
                </div>
              </div>
              {/* Recurring summary for selected config */}
              {!isEdit && recurringConfig && (
                <div className="recurring-summary">
                  <span>
                    {recurringConfig.type === 'instalment'
                      ? `📋 Instalment · ${recurringConfig.totalDays} days · ${recurringConfig.scheduleMode === 'start_of_month' ? 'Start of month' : 'On the day'}`
                      : `🔁 Repeat ${recurringConfig.frequency} · ${recurringConfig.scheduleMode === 'start_of_month' ? 'Start of month' : 'On date'}`}
                  </span>
                  <button type="button" onClick={() => setRecurringConfig(null)} className="recurring-clear">✕</button>
                </div>
              )}

              {/* Row 2: Account(s) */}
              {isTransfer ? (
                <>
                  <div className="transfer-swap-row">
                    <PickerFieldFR ref={fromRef} setPickerState={setPickerState} label="From" value={form.fromAccount} placeholder="Select"
                      error={errors.fromAccount} items={accountList} recent={recentAccounts}
                      onSelect={v => { set('fromAccount', v); goNextEmpty({ key: 'fromAccount', val: v }); }}
                      onAfterSelect={() => setPickerState(null)}
                      onReorder={() => setReorderScreen('accounts')}
                      active={pickerState && pickerState.type === 'from'} />
                    <button type="button" className="swap-btn" title="Swap"
                      onClick={() => setForm(p => ({ ...p, fromAccount: p.toAccount, toAccount: p.fromAccount, fromSubAccount: p.toSubAccount, toSubAccount: p.fromSubAccount }))}>
                      ⇅
                    </button>
                    <PickerFieldFR ref={toRef} setPickerState={setPickerState} label="To" value={form.toAccount} placeholder="Select"
                      error={errors.toAccount} items={accountList} recent={recentAccounts}
                      onSelect={v => { set('toAccount', v); goNextEmpty({ key: 'toAccount', val: v }); }}
                      onAfterSelect={() => setPickerState(null)}
                      onReorder={() => setReorderScreen('accounts')}
                      active={pickerState && pickerState.type === 'to'} />
                  </div>
                  {((fromAcctObj && getSortedSubs(fromAcctObj).length > 0) ||
                    (toAcctObj && getSortedSubs(toAcctObj).length > 0)) && (
                    <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                      {fromAcctObj && getSortedSubs(fromAcctObj).length > 0 ? (
                        <div className="form-group" style={{ flex: 1, margin: 0 }}>
                          <label className="form-label" style={{ fontSize: '0.68rem', marginBottom: 2 }}>From Sub Account</label>
                          <select className="form-input" style={{ fontSize: '0.78rem', height: 36, padding: '4px 8px' }} value={form.fromSubAccount} onChange={e => set('fromSubAccount', e.target.value)}>
                            <option value="">(Select Sub Account)</option>
                            {getSortedSubs(fromAcctObj).map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                      ) : <div style={{ flex: 1 }} />}
                      {toAcctObj && getSortedSubs(toAcctObj).length > 0 ? (
                        <div className="form-group" style={{ flex: 1, margin: 0 }}>
                          <label className="form-label" style={{ fontSize: '0.68rem', marginBottom: 2 }}>To Sub Account</label>
                          <select className="form-input" style={{ fontSize: '0.78rem', height: 36, padding: '4px 8px' }} value={form.toSubAccount} onChange={e => set('toSubAccount', e.target.value)}>
                            <option value="">(Select Sub Account)</option>
                            {getSortedSubs(toAcctObj).map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                      ) : <div style={{ flex: 1 }} />}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <PickerFieldFR setPickerState={setPickerState} ref={accountRef} label="Account" value={form.account} placeholder="Select account"
                    error={errors.account} items={accountList} recent={recentAccounts}
                    onSelect={v => { set('account', v); goNextEmpty({ key: 'account', val: v }); }}
                    onAfterSelect={() => setPickerState(null)}
                    onReorder={() => setReorderScreen('accounts')}
                    active={pickerState && pickerState.type === 'account'} />
                  {selectedAcctObj && getSortedSubs(selectedAcctObj).length > 0 && (
                    <div className="form-group" style={{ marginTop: 8 }}>
                      <label className="form-label" style={{ fontSize: '0.68rem', marginBottom: 2 }}>Sub Account / Platform</label>
                      <select className="form-input" style={{ fontSize: '0.78rem', height: 36, padding: '4px 8px' }} value={form.subAccount} onChange={e => set('subAccount', e.target.value)}>
                        <option value="">(Select Sub Account)</option>
                        {getSortedSubs(selectedAcctObj).map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* Row 3: Category + Subcategory (hidden when isTransfer or isInvestmentTrade) */}
          {!isTransfer && !isSplit && !isInvMode && (
            <div className="form-group category-subcat-group">
              <label className="form-label">Category</label>
              <div className="category-subcat-wrap">
                <PickerFieldFR setPickerState={setPickerState} ref={categoryRef} label="Category" value={form.category} placeholder="Select category"
                  hideLabel
                  error={errors.category} items={availCats} recent={recentCats}
                  onSelect={v => {
                    set('category', v);
                    const freshSubs = (categories?.[v]?.subcategories || []).filter(s => s && s !== 'Default');
                    afterCategory(v, freshSubs);
                  }}
                  onAfterSelect={() => setPickerState(null)}
                  onReorder={() => setReorderScreen('categories')}
                  active={pickerState && pickerState.type === 'category'} />
                <SubcatFieldFR setPickerState={setPickerState} ref={subcatRef} value={form.subcategory} items={availSubs}
                  hideLabel
                  recent={recentSubs}
                  onChange={v => set('subcategory', v)}
                  onAfterSelect={() => { if (!isEdit) { if (!form.amount) setTimeout(() => amountRef.current?.focus(), 120); else setTimeout(() => noteRef.current?.focus(), 120); } }}
                  active={pickerState && pickerState.type === 'subcategory'} />
              </div>
            </div>
          )}

          {/* Row 4: Amount for Non-Investment Transactions */}
          {!isInvMode && (
            <div className="form-group">
              <label className="form-label">{isTransfer ? 'Amount' : 'Amount'}</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
                  <span style={{ position: 'absolute', left: 10, fontSize: '0.9rem', color: 'var(--text-muted)', pointerEvents: 'none', zIndex: 1 }}>₹</span>
                  <input ref={amountRef}
                    className={`form-input ${errors.amount ? 'err' : ''}`}
                    style={{ paddingLeft: 24 }}
                    type="text" inputMode="decimal" pattern="^-?[0-9]*([.,][0-9]+)?"
                    autoComplete="off" autoCorrect="off" spellCheck="false"
                    placeholder="0"
                    onFocus={e => { setPickerState(null); e.target.select(); }}
                    value={form.amount} onChange={e => set('amount', e.target.value)} />
                </div>
                {!isTransfer && !isEdit && (
                  <button
                    type="button"
                    onClick={() => setIsSplit(v => !v)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 12,
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    border: `1.5px solid ${isSplit ? 'var(--accent)' : 'var(--border)'}`,
                    background: isSplit ? 'rgba(0, 229, 160, 0.12)' : 'var(--bg-card)',
                    color: isSplit ? 'var(--accent)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  ⚡ {isSplit ? 'Split Active' : 'Split'}
                </button>
              )}
            </div>
            {errors.amount && <div className="field-error">{errors.amount}</div>}
            {isInstalmentEdit && instalmentStats && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginTop: 6,
                fontSize: '0.74rem',
                fontWeight: 600,
                color: 'var(--text-muted)',
              }}>
                <span>Balance: <strong style={{ color: '#ffb74d' }}>{formatINR(instalmentStats.balanceRemaining)}</strong></span>
                <span style={{ opacity: 0.35 }}>·</span>
                <span>Total: <strong style={{ color: 'var(--accent)' }}>{formatINR(instalmentStats.totalAmount)}</strong></span>
              </div>
            )}
          </div>
        )}

          {/* Split Allocation Section */}
          {isSplit && !isTransfer && (
            <div style={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 14, padding: 12, marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 800 }}>⚡ Split Breakdown</span>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: splitRemaining === 0 ? 'var(--income)' : 'var(--expense)' }}>
                  {splitRemaining === 0 ? '✓ Fully Balanced' : `Remaining: ₹${splitRemaining}`}
                </span>
              </div>
              {errors.splits && <div className="field-error" style={{ marginBottom: 10 }}>{errors.splits}</div>}

              {splits.map((s, idx) => (
                <div key={s.id} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 10, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)' }}>SPLIT #{idx + 1}</span>
                    {splits.length > 2 && (
                      <button
                        type="button"
                        onClick={() => setSplits(prev => prev.filter((_, i) => i !== idx))}
                        style={{ background: 'none', border: 'none', color: 'var(--expense)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700 }}
                      >
                        Remove ✕
                      </button>
                    )}
                  </div>

                  {/* Category & Subcategory chip selectors */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => setPickerState({
                        type: `split-cat-${idx}`,
                        label: `Select Category (Split #${idx + 1})`,
                        value: s.category,
                        items: availCats,
                        recent: recentCats,
                        onSelect: (v) => {
                          const freshSubs = (categories?.[v]?.subcategories || []).filter(sub => sub && sub !== 'Default');
                          const recSubs = getRecentSubsForCategory(v);
                          setSplits(prev => prev.map((item, i) => i === idx ? { ...item, category: v, subcategory: '' } : item));
                          if (freshSubs.length > 0) {
                            setTimeout(() => {
                              setPickerState({
                                type: `split-sub-${idx}`,
                                label: `Select Subcategory for ${v}`,
                                value: '',
                                items: freshSubs,
                                recent: recSubs,
                                onSelect: (subVal) => {
                                  setSplits(prev => prev.map((item, i) => i === idx ? { ...item, subcategory: subVal } : item));
                                  setPickerState(null);
                                }
                              });
                            }, 50);
                          } else {
                            setPickerState(null);
                          }
                        }
                      })}
                      style={{
                        flex: 1, padding: '8px 10px', borderRadius: 10, background: 'var(--bg-base)',
                        border: `1px solid ${!s.category && errors.splits ? 'var(--expense)' : 'var(--border)'}`,
                        color: s.category ? 'var(--text-primary)' : 'var(--text-muted)',
                        fontSize: '0.78rem', fontWeight: 700, textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                      }}
                    >
                      <span>{s.category || 'Select Category'}</span>
                      <span style={{ fontSize: '0.65rem' }}>▼</span>
                    </button>

                    {s.category && (categories?.[s.category]?.subcategories || []).filter(sub => sub && sub !== 'Default').length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const freshSubs = (categories?.[s.category]?.subcategories || []).filter(sub => sub && sub !== 'Default');
                          const recSubs = getRecentSubsForCategory(s.category);
                          setPickerState({
                            type: `split-sub-${idx}`,
                            label: `Select Subcategory for ${s.category}`,
                            value: s.subcategory,
                            items: freshSubs,
                            recent: recSubs,
                            onSelect: (v) => {
                              setSplits(prev => prev.map((item, i) => i === idx ? { ...item, subcategory: v } : item));
                              setPickerState(null);
                            }
                          });
                        }}
                        style={{
                          flex: 1, padding: '8px 10px', borderRadius: 10, background: 'var(--bg-base)',
                          border: '1px solid var(--border)',
                          color: s.subcategory ? 'var(--text-primary)' : 'var(--text-muted)',
                          fontSize: '0.78rem', fontWeight: 700, textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                        }}
                      >
                        <span>{s.subcategory || 'Subcategory'}</span>
                        <span style={{ fontSize: '0.65rem' }}>▼</span>
                      </button>
                    )}
                  </div>

                  {/* Amount & Note in split row */}
                  <div style={{ display: 'flex', gap: 6, position: 'relative' }}>
                    <div style={{ position: 'relative', width: '38%' }}>
                      <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>₹</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="Amount"
                        className="form-input"
                        style={{ paddingLeft: 22, fontSize: '0.8rem', padding: '6px 8px 6px 20px' }}
                        value={s.amount}
                        onFocus={e => e.target.select()}
                        onChange={e => {
                          const val = e.target.value;
                          setSplits(prev => {
                            const next = prev.map((item, i) => i === idx ? { ...item, amount: val } : item);
                            const total = next.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
                            set('amount', String(total));
                            return next;
                          });
                        }}
                      />
                    </div>

                    <div style={{ position: 'relative', flex: 1 }}>
                      <input
                        type="text"
                        placeholder="Note (e.g. Vegetables)"
                        className="form-input"
                        style={{ width: '100%', fontSize: '0.8rem', padding: '6px 10px' }}
                        value={s.note}
                        onFocus={() => {
                          setSplitNoteFocusedIdx(idx);
                          setSplitNoteSugs(getRecentAndMostUsedNotes(form.type, s.category));
                        }}
                        onBlur={() => {
                          setTimeout(() => {
                            setSplitNoteFocusedIdx(null);
                            setSplitNoteSugs([]);
                          }, 200);
                        }}
                        onChange={e => {
                          const val = e.target.value;
                          setSplits(prev => prev.map((item, i) => i === idx ? { ...item, note: val } : item));
                          setSplitNoteSugs(getRecentAndMostUsedNotes(form.type, s.category).filter(n => {
                            const noteStr = typeof n === 'object' ? n.note : n;
                            return noteStr.toLowerCase().includes(val.toLowerCase());
                          }));
                        }}
                      />
                      {splitNoteFocusedIdx === idx && splitNoteSugs.length > 0 && (
                        <div className="note-sug-list" style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 10, maxHeight: 150, overflowY: 'auto' }}>
                          {splitNoteSugs.map(item => {
                            const isObj = typeof item === 'object';
                            const label = isObj ? item.note : item;
                            const icon = isObj ? (item.type === 'most_used' ? '🔥' : '🕒') : null;
                            return (
                              <div
                                key={label}
                                className="note-sug-item"
                                onMouseDown={() => {
                                  setSplits(prev => prev.map((part, i) => i === idx ? { ...part, note: label } : part));
                                  setSplitNoteFocusedIdx(null);
                                  setSplitNoteSugs([]);
                                }}
                                style={{ display: 'flex', alignItems: 'center', fontSize: '0.78rem', padding: '6px 10px' }}
                              >
                                {icon && <span style={{ marginRight: 6, fontSize: '0.7rem' }}>{icon}</span>}
                                <span>{label}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => setSplits(prev => [...prev, { id: 's' + (prev.length + 1), category: '', subcategory: '', amount: '', note: '' }])}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer' }}
                >
                  + Add Split Part
                </button>
                {splitRemaining > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSplits(prev => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last && (!last.amount || parseFloat(last.amount) === 0)) {
                          last.amount = String(splitRemaining);
                        } else {
                          next.push({ id: 's' + (next.length + 1), category: '', subcategory: '', amount: String(splitRemaining), note: '' });
                        }
                        return next;
                      });
                    }}
                    style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.74rem', fontWeight: 600, cursor: 'pointer' }}
                  >
                    Auto-Fill Remaining (₹{splitRemaining})
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Row 5: Note (hidden when isSplit or isInvMode) */}
          {!isSplit && !isInvMode && (
            <div className="form-group">
              <label className="form-label">Note</label>
              <div style={{ position: 'relative', flex: 1 }}>
                <input ref={el => { textInputRef(el); noteRef.current = el; }} className="form-input" type="text" value={form.note}
                  style={{ paddingRight: (form.note || noteFocused) ? '30px' : undefined }}
                  autoComplete="on" autoCorrect="on" spellCheck="true" autoCapitalize="sentences"
                  onChange={e => handleNoteChange(e.target.value)}
                  onFocus={handleNoteFocus}
                  onBlur={() => { setNoteFocused(false); setTimeout(() => setNoteSugs([]), 180); }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); descriptionRef.current?.focus(); } }}
                />
                {noteFocused && (
                  <button type="button" onMouseDown={e => { e.preventDefault(); set('note', ''); setNoteSugs([]); setNoteFocused(false); }}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, padding: '4px', borderRadius: '50%', zIndex: 1 }}>✕</button>
                )}
                {noteSugs.length > 0 && (
                  <div className="note-sug-list">
                    {noteSugs.map(s => {
                      const isObj = typeof s === 'object';
                      const label = isObj ? s.note : s;
                      const icon = isObj ? (s.type === 'most_used' ? '🔥' : '🕒') : null;
                      return (
                        <div key={label} className="note-sug-item" onMouseDown={() => { set('note', label); setNoteSugs([]); setTimeout(() => descriptionRef.current?.focus(), 150); }} style={{ display: 'flex', alignItems: 'center' }}>
                          {icon && <span className="note-sug-icon" style={{ marginRight: 8, fontSize: '0.75rem' }}>{icon}</span>}
                          <span className="note-sug-text">{label}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="description-section">
            <div className="form-group">
              <textarea ref={el => { textInputRef(el); descriptionRef.current = el; }} className="form-input" rows={1} value={form.description}
                autoComplete="on" autoCorrect="on" spellCheck="true" autoCapitalize="sentences"
                onFocus={() => setPickerState(null)}
                onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 220) + 'px'; }}
                onChange={e => set('description', e.target.value)} placeholder='Description' />
            </div>
          </div>

          {/* Tags (Header with label above, tags below full width) */}
          <div className="tags-section" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14, width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label className="form-label" style={{ margin: 0, fontWeight: 700 }}>Tags</label>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Type #tag or tap below</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, width: '100%' }}>
              {allAvailableTags.map(tag => {
                const currentTags = (form.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
                const isSelected = currentTags.includes(tag.toLowerCase()) ||
                  ((form.note || '') + ' ' + (form.description || '')).toLowerCase().includes(tag.toLowerCase());
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      let nextTags;
                      if (isSelected) {
                        nextTags = currentTags.filter(t => t !== tag.toLowerCase());
                      } else {
                        nextTags = [...currentTags, tag.toLowerCase()];
                      }
                      set('tags', nextTags.join(', '));
                    }}
                    style={{
                      padding: '5px 12px',
                      borderRadius: 14,
                      fontSize: '0.74rem',
                      fontWeight: isSelected ? 800 : 500,
                      border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                      background: isSelected ? 'rgba(0, 229, 160, 0.15)' : 'var(--bg-card2)',
                      color: isSelected ? 'var(--accent)' : 'var(--text-muted)',
                      cursor: 'pointer',
                      transition: 'all 0.12s ease',
                    }}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Receipt & Warranty Section */}
          <div style={{
            background: 'var(--bg-card2)', borderRadius: 12, border: '1px solid var(--border)',
            padding: 12, display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>
                🧾 Receipt &amp; 🛡️ Warranty (Optional)
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: 'none' }}
                onChange={handleImageUpload}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{
                  background: 'rgba(0, 229, 160, 0.15)', border: '1px solid var(--accent)',
                  color: 'var(--accent)', padding: '4px 10px', borderRadius: 8, fontSize: '0.7rem',
                  fontWeight: 700, cursor: 'pointer'
                }}
              >
                {form.receipt_image ? '📷 Replace Bill' : '📷 Attach Bill'}
              </button>
            </div>

            {/* Receipt Preview if uploaded */}
            {form.receipt_image && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-base)', padding: 6, borderRadius: 8 }}>
                <img
                  src={form.receipt_image}
                  alt="Receipt Preview"
                  onClick={() => setViewingReceipt(true)}
                  style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, cursor: 'pointer' }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--income)' }}>Bill Photo Attached ✓</div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => setViewingReceipt(true)}>
                    Tap image to zoom
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => set('receipt_image', '')}
                  style={{ background: 'none', border: 'none', color: 'var(--expense)', fontSize: '0.75rem', cursor: 'pointer', padding: 4 }}
                >
                  ✕ Remove
                </button>
              </div>
            )}

            {/* Warranty Expiry Date & Serial No */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>
                  Warranty Expiry
                </label>
                <input
                  type="date"
                  className="form-input"
                  style={{ fontSize: '0.75rem', padding: '4px 6px' }}
                  value={form.warranty_expiry}
                  onChange={e => set('warranty_expiry', e.target.value)}
                />
              </div>
              <div>
                <label style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>
                  Invoice / Serial No.
                </label>
                <input
                  type="text"
                  className="form-input"
                  style={{ fontSize: '0.75rem', padding: '4px 6px' }}
                  placeholder="e.g. INV-9281"
                  value={form.serial_no}
                  onChange={e => set('serial_no', e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="form-actions" style={{ display: 'flex', gap: '10px' }}>
            <button className="btn btn-primary btn-lg" style={{ flex: 2 }} onClick={() => handleSave(false)} disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Update' : (isCopy ? 'Copy' : 'Save')}
            </button>
            {!isEdit && onSaveAndContinue && (
              <button className="btn btn-secondary btn-lg" style={{ flex: 1 }} onClick={() => handleSave(true)} disabled={saving}>
                {saving ? 'Saving…' : 'Continue'}
              </button>
            )}
          </div>
          <div style={{ height: 16 }} />
        </div>

        {/* Inline Picker Room */}
        {pickerState && (
          <div className="picker-room">
            {pickerState.type === 'subcategory' ? (
              <SubcategoryPickerInline
                items={pickerState.items}
                recent={pickerState.recent}
                value={pickerState.value}
                onSelect={pickerState.onSelect}
                onClose={() => setPickerState(null)}
              />
            ) : (
              <PickerSheetInline
                label={pickerState.label}
                items={pickerState.items}
                recent={pickerState.recent}
                value={pickerState.value}
                onSelect={pickerState.onSelect}
                onClose={() => setPickerState(null)}
                exclude={pickerState.exclude}
                onReorder={pickerState.onReorder}
              />
            )}
          </div>
        )}
      </div>

      {/* Inline reorder overlay — keeps AddTransaction mounted */}
      <ReorderOverlay screen={reorderScreen} onClose={() => setReorderScreen(null)} />
      {/* Recurring sheet */}
      {showRecurring && (
        <RecurringSheet
          isExpense={form.type === 'Expense'}
          startDate={form.date}
          onClose={() => setShowRecurring(false)}
          onSave={cfg => { setRecurringConfig(cfg); setShowRecurring(false); }}
        />
      )}

      {/* SMS Paste & Parse Sheet */}
      {smsModal && (
        <>
          <div className="overlay" onClick={() => setSmsModal(false)} />
          <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
            <div className="sheet-handle" />
            <div style={{ fontSize: '1rem', fontWeight: 800, marginBottom: 4 }}>
              ⚡ Paste Bank SMS or UPI Alert
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 12 }}>
              Paste any transaction notification from HDFC, SBI, ICICI, Axis, PayTM, GPay, etc. to auto-fill amount, type, account, and merchant.
            </div>
            <textarea
              className="form-input"
              style={{ minHeight: 80, fontSize: '0.82rem', marginBottom: 14, background: 'var(--bg-card2)', borderRadius: 8, padding: 10 }}
              placeholder="e.g. Rs 450.00 debited from A/c ending 1234 on 08-Aug at Swiggy via UPI..."
              value={smsInputText}
              onChange={e => setSmsInputText(e.target.value)}
            />
            <button
              className="btn btn-primary btn-full"
              disabled={!smsInputText.trim()}
              onClick={() => handlePasteAndParseSMS(smsInputText)}
            >
              Parse &amp; Auto-Fill Form
            </button>
          </div>
        </>
      )}

      {/* Receipt Fullscreen Zoom Viewer */}
      {viewingReceipt && form.receipt_image && (
        <ReceiptViewer
          receiptUrl={form.receipt_image}
          title={form.note || form.category || 'Receipt Bill'}
          onClose={() => setViewingReceipt(false)}
        />
      )}
    </>
  );
}