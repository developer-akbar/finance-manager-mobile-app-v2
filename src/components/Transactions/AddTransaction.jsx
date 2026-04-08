import React, { useState, useMemo, useRef } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { inputToStorage, toInputDate, nowTimeStr } from '../../utils/format.js';
import './AddTransaction.css';
import { AccountsManager, CategoriesManager } from '../Settings/Settings.jsx';
import {
  buildInstalmentSchedule, computeNextRepeatDate,
  buildInstalmentNote, stripInstalmentSuffix,
} from '../../database/recurring.js';

const TYPES = [
  { id:'Income',       label:'Income',   cls:'income'   },
  { id:'Expense',      label:'Expense',  cls:'expense'  },
  { id:'Transfer-Out', label:'Transfer', cls:'transfer' },
];

const todayVal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

// ── ReorderOverlay — shows AccountsManager or CategoriesManager inline ────
function ReorderOverlay({ screen, onClose }) {
  if (!screen) return null;
  // Use fullscreen-modal class so safe-area top/bottom padding applies correctly
  // and the sub-screen layout matches what AccountsManager/CategoriesManager expect
  return (
    <div className="fullscreen-modal" style={{zIndex:300,overflowY:'auto',paddingLeft:0,paddingRight:0}}>
      {screen === 'accounts'   && <AccountsManager   onBack={onClose} />}
      {screen === 'categories' && <CategoriesManager onBack={onClose} />}
    </div>
  );
}


// ── RecurringSheet — Instalment / Repeat picker ────────────────────────────
const REPEAT_OPTIONS = [
  { id:'daily',       label:'Daily',         icon:'📅' },
  { id:'weekly',      label:'Weekly',        icon:'🗓' },
  { id:'fortnightly', label:'Every 2 weeks', icon:'🗓' },
  { id:'monthly',     label:'Monthly',       icon:'📆' },
  { id:'3months',     label:'Every 3 months',icon:'📆' },
  { id:'6months',     label:'Every 6 months',icon:'📆' },
  { id:'annually',    label:'Annually',      icon:'🎯' },
];

function RecurringSheet({ onClose, onSave, isExpense, startDate }) {
  const [mode, setMode]           = React.useState(null);           // null | 'instalment' | 'repeat'
  const [scheduleMode, setSchedule] = React.useState('start_of_month'); // default: start of month
  const [days, setDays]           = React.useState('');             // instalment days
  const [months, setMonths]       = React.useState('');             // instalment months (alt input)
  const [inputMode, setInputMode] = React.useState('months');       // 'months' | 'days'
  const [repeatFreq, setRepeatFreq] = React.useState('monthly');
  const [step, setStep]           = React.useState(1);              // 1=type, 2=details, 3=schedule

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
      <div className="overlay" onMouseDown={onClose} style={{zIndex:210}} />
      <div className="bottom-sheet" style={{paddingBottom:'calc(var(--safe-bottom) + 16px)',zIndex:211}}>
        <div className="sheet-handle" />

        {step === 1 && (
          <>
            <div style={{fontWeight:800,fontSize:'0.95rem',marginBottom:4}}>Recurring</div>
            <div style={{fontSize:'0.73rem',color:'var(--text-muted)',marginBottom:16}}>
              Set up recurring or instalment payments
            </div>
            {/* Instalment — only for Expense */}
            {isExpense && (
              <div className="recur-option-row" onClick={()=>{setMode('instalment');setStep(2);}}>
                <div className="recur-option-icon">📋</div>
                <div className="recur-option-body">
                  <div className="recur-option-title">Instalment</div>
                  <div className="recur-option-sub">Split total amount over days/months</div>
                </div>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14" style={{opacity:0.4}}><path d="M9 18l6-6-6-6"/></svg>
              </div>
            )}
            <div className="recur-option-row" onClick={()=>{setMode('repeat');setStep(2);}}>
              <div className="recur-option-icon">🔁</div>
              <div className="recur-option-body">
                <div className="recur-option-title">Repeat</div>
                <div className="recur-option-sub">Create same transaction on a schedule</div>
              </div>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14" style={{opacity:0.4}}><path d="M9 18l6-6-6-6"/></svg>
            </div>
            <button className="btn btn-ghost btn-full" style={{marginTop:12}} onMouseDown={onClose}>Cancel</button>
          </>
        )}

        {step === 2 && mode === 'instalment' && (
          <>
            <div style={{fontWeight:800,fontSize:'0.95rem',marginBottom:2}}>📋 Instalment</div>
            <div style={{fontSize:'0.72rem',color:'var(--text-muted)',marginBottom:14}}>
              Amount will be split proportionally across instalments
            </div>
            {/* Months / Days toggle */}
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              <button className={`btn btn-sm ${inputMode==='months'?'btn-primary':'btn-secondary'}`}
                onClick={()=>setInputMode('months')}>Months</button>
              <button className={`btn btn-sm ${inputMode==='days'?'btn-primary':'btn-secondary'}`}
                onClick={()=>setInputMode('days')}>Days</button>
            </div>
            <div className="form-group" style={{marginBottom:14}}>
              <label className="form-label">{inputMode === 'months' ? 'Number of Months' : 'Number of Days'}</label>
              <input
                ref={el => { if (el) setTimeout(() => el.focus(), 150); }}
                className="form-input" type="tel" inputMode="numeric" pattern="[0-9]*"
                placeholder={inputMode === 'months' ? 'e.g. 3' : 'e.g. 84'}
                value={inputMode === 'months' ? months : days}
                onChange={e => inputMode === 'months' ? setMonths(e.target.value) : setDays(e.target.value)}
              />
            </div>
            <button className="btn btn-primary btn-full" style={{marginBottom:8}}
              onClick={()=>setStep(3)}>Next →</button>
            <button className="btn btn-ghost btn-full" onClick={()=>setStep(1)}>← Back</button>
          </>
        )}

        {step === 2 && mode === 'repeat' && (
          <>
            <div style={{fontWeight:800,fontSize:'0.95rem',marginBottom:14}}>🔁 Repeat frequency</div>
            <div style={{display:'flex',flexDirection:'column',gap:6,marginBottom:14}}>
              {REPEAT_OPTIONS.map(opt => (
                <div key={opt.id}
                  onClick={()=>setRepeatFreq(opt.id)}
                  style={{display:'flex',alignItems:'center',gap:12,padding:'10px 12px',borderRadius:10,
                    background: repeatFreq===opt.id ? 'rgba(0,229,160,0.10)' : 'var(--bg-card2)',
                    border: `1.5px solid ${repeatFreq===opt.id ? 'var(--accent)' : 'var(--border)'}`,
                    cursor:'pointer'}}>
                  <span style={{fontSize:'1.1rem'}}>{opt.icon}</span>
                  <span style={{flex:1,fontSize:'0.85rem',fontWeight:600,color:repeatFreq===opt.id?'var(--accent)':'var(--text-primary)'}}>{opt.label}</span>
                  {repeatFreq===opt.id && <span style={{color:'var(--accent)',fontWeight:700}}>✓</span>}
                </div>
              ))}
            </div>
            <button className="btn btn-primary btn-full" style={{marginBottom:8}}
              onClick={()=>setStep(3)}>Next →</button>
            <button className="btn btn-ghost btn-full" onClick={()=>setStep(1)}>← Back</button>
          </>
        )}

        {step === 3 && (
          <>
            <div style={{fontWeight:800,fontSize:'0.95rem',marginBottom:2}}>
              {mode === 'instalment' ? '📋 Instalment — Schedule' : '🔁 Repeat — Schedule'}
            </div>
            <div style={{fontSize:'0.72rem',color:'var(--text-muted)',marginBottom:14}}>
              How should dates be calculated?
            </div>
            {/* Schedule mode options */}
            {[
              { id:'start_of_month', label:'Start of month',
                sub: mode==='instalment'
                  ? 'Remaining days this month, then 1st of each month (good for recharges)'
                  : 'Repeats on the 1st of each period' },
              { id:'on_date', label: mode==='instalment' ? 'On the day' : 'On the date',
                sub: mode==='instalment'
                  ? `Same date each month (e.g. ${startDate ? startDate.slice(8) : '22'}nd of each month)`
                  : 'Repeats on the same date each period' },
            ].map(opt => (
              <div key={opt.id} onClick={()=>setSchedule(opt.id)}
                style={{display:'flex',alignItems:'flex-start',gap:12,padding:'12px',borderRadius:10,marginBottom:8,
                  background: scheduleMode===opt.id ? 'rgba(0,229,160,0.10)' : 'var(--bg-card2)',
                  border:`1.5px solid ${scheduleMode===opt.id?'var(--accent)':'var(--border)'}`,cursor:'pointer'}}>
                <div style={{width:18,height:18,borderRadius:'50%',marginTop:2,flexShrink:0,
                  border:`2px solid ${scheduleMode===opt.id?'var(--accent)':'var(--border)'}`,
                  background:scheduleMode===opt.id?'var(--accent)':'transparent'}}/>
                <div>
                  <div style={{fontSize:'0.85rem',fontWeight:700,color:scheduleMode===opt.id?'var(--accent)':'var(--text-primary)'}}>{opt.label}</div>
                  <div style={{fontSize:'0.7rem',color:'var(--text-muted)',marginTop:2}}>{opt.sub}</div>
                </div>
              </div>
            ))}
            <div style={{display:'flex',gap:8,marginTop:8}}>
              <button className="btn btn-ghost" style={{flex:1}} onClick={()=>setStep(2)}>← Back</button>
              <button className="btn btn-primary" style={{flex:2}}
                onClick={mode==='instalment' ? handleInstSave : handleRepeatSave}>
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── PickerSheet — chip grid with recent row ────────────────────────────────
function PickerSheet({ label, items, recent, value, onSelect, onClose, exclude='', onReorder }) {
  const [query, setQuery] = React.useState('');
  const inputRef = React.useRef(null);

  // No auto-focus on search — user opens picker and taps search if needed

  const q = query.trim().toLowerCase();
  const recentList = recent.filter(i => i !== exclude && (!q || i.toLowerCase().includes(q)));
  const recentSet  = new Set(recentList);
  const allItems   = items.filter(i => i !== exclude && !recentSet.has(i) && (!q || i.toLowerCase().includes(q)));
  const noResults  = recentList.length === 0 && allItems.length === 0;

  const Chip = ({ name }) => (
    <button type="button"
      className={`picker-chip ${value === name ? 'picker-chip-active' : ''}`}
      onMouseDown={e => { e.preventDefault(); onSelect(name); onClose(); }}>
      {name}{value === name && <span className="picker-chip-check"> ✓</span>}
    </button>
  );

  return (
    <>
      <div className="overlay" onMouseDown={onClose} />
      <div className="bottom-sheet picker-sheet">
        <div className="sheet-handle" />
        <div className="picker-sheet-hdr">
          <div className="picker-sheet-title">{label}</div>
          <button className="picker-sheet-close" onMouseDown={onClose}>✕</button>
        </div>
        <div className="picker-search-wrap">
          <span className="picker-search-icon">🔍</span>
          <input ref={inputRef} className="picker-search-input"
            placeholder={`Search ${label.toLowerCase()}…`}
            value={query} onChange={e => setQuery(e.target.value)} />
          {query && <button className="picker-search-clear" onMouseDown={e=>{e.preventDefault();setQuery('');}}>✕</button>}
        </div>
        <div className="picker-list">
          {recentList.length > 0 && (
            <>
              <div className="picker-section-label">Recent</div>
              <div className="picker-recent-row">{recentList.map(n => <Chip key={n} name={n} />)}</div>
            </>
          )}
          {allItems.length > 0 && (
            <>
              <div className="picker-section-label" style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <span>{recentList.length > 0 ? 'All' : ''}</span>
                {!q && onReorder && (
                  <button className="picker-reorder-hint" onMouseDown={e=>{e.preventDefault();onReorder();onClose();}}>
                    ⠿ reorder in Settings
                  </button>
                )}
              </div>
              <div className="picker-chip-grid">{allItems.map(n => <Chip key={n} name={n} />)}</div>
            </>
          )}
          {noResults && <div className="picker-empty">No results for "{query}"</div>}
        </div>
      </div>
    </>
  );
}

// ── SubcategoryPicker — chip grid (no search needed, small list) ──────────
function SubcategoryPicker({ items, value, onSelect, onClose }) {
  const Chip = ({ name }) => (
    <button type="button"
      className={`picker-chip ${value === name ? 'picker-chip-active' : ''}`}
      onMouseDown={e => { e.preventDefault(); onSelect(name); onClose(); }}>
      {name}{value === name && <span className="picker-chip-check"> ✓</span>}
    </button>
  );
  return (
    <>
      <div className="overlay" onMouseDown={onClose} />
      <div className="bottom-sheet picker-sheet" style={{maxHeight:'50dvh'}}>
        <div className="sheet-handle" />
        <div className="picker-sheet-hdr">
          <div className="picker-sheet-title">Subcategory</div>
          <button className="picker-sheet-close" onMouseDown={onClose}>✕</button>
        </div>
        <div className="picker-list" style={{paddingBottom:16}}>
          <div className="picker-chip-grid">
            <button type="button"
              className={`picker-chip ${!value ? 'picker-chip-active' : ''}`}
              onMouseDown={e=>{e.preventDefault();onSelect('');onClose();}}>
              None
            </button>
            {items.map(n => <Chip key={n} name={n} />)}
          </div>
        </div>
      </div>
    </>
  );
}

function PickerField({ label, value, placeholder, error, items, recent, onSelect, exclude='', onReorder, onAfterSelect }, ref) {
  const [open, setOpen] = React.useState(false);
  React.useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
  const handleSelect = (v) => { onSelect(v); if (onAfterSelect) setTimeout(onAfterSelect, 100); };
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <button type="button"
        className={`form-input picker-trigger ${error?'err':''} ${!value?'picker-trigger-empty':''}`}
        onClick={() => setOpen(true)}>
        <span className="picker-trigger-value">{value || placeholder}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" style={{flexShrink:0,opacity:0.5}}><path d="M6 9l6 6 6-6"/></svg>
      </button>
      {error && <div className="field-error">{error}</div>}
      {open && (
        <PickerSheet label={label} items={items} recent={recent}
          value={value} onSelect={handleSelect} onClose={()=>setOpen(false)}
          exclude={exclude} onReorder={onReorder} />
      )}
    </div>
  );
}
const PickerFieldFR = React.forwardRef(PickerField);

function SubcatField({ value, items, onChange, onAfterSelect }) {
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
      <label className="form-label">Subcategory</label>
      <div className="form-input picker-trigger picker-trigger-empty" style={{cursor:'default',opacity:0.5}}>
        <span className="picker-trigger-value">None</span>
      </div>
    </div>
  );

  return (
    <div className="form-group">
      <label className="form-label">Subcategory</label>
      <button type="button"
        className={`form-input picker-trigger ${!value?'picker-trigger-empty':''}`}
        onClick={() => setOpen(true)}>
        <span className="picker-trigger-value">{value || 'None'}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" style={{flexShrink:0,opacity:0.5}}><path d="M6 9l6 6 6-6"/></svg>
      </button>
      {open && (
        <SubcategoryPicker items={items} value={value}
          onSelect={handleSelect} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
const SubcatFieldFR = React.forwardRef((props, ref) => {
  const [open, setOpen] = React.useState(false);
  React.useImperativeHandle(ref, () => ({ open: () => { if (props.items.length > 0) setOpen(true); } }), [props.items]);
  // Always mark key='subcategory' so goNextEmpty knows subcat was explicitly touched (even None)
  const handleSelect = (v) => { props.onChange(v); if (props.onAfterSelect) setTimeout(() => props.onAfterSelect(v), 100); };
  if (props.items.length === 0) return (
    <div className="form-group">
      <label className="form-label">Subcategory</label>
      <div className="form-input picker-trigger picker-trigger-empty" style={{cursor:'default',opacity:0.5}}>
        <span className="picker-trigger-value">None</span>
      </div>
    </div>
  );
  return (
    <div className="form-group">
      <label className="form-label">Subcategory</label>
      <button type="button"
        className={`form-input picker-trigger ${!props.value?'picker-trigger-empty':''}`}
        onClick={() => setOpen(true)}>
        <span className="picker-trigger-value">{props.value || 'None'}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" style={{flexShrink:0,opacity:0.5}}><path d="M6 9l6 6 6-6"/></svg>
      </button>
      {open && <SubcategoryPicker items={props.items} value={props.value} onSelect={handleSelect} onClose={()=>setOpen(false)} />}
    </div>
  );
});

// ── Main AddTransaction ────────────────────────────────────────────────────
export default function AddTransaction({ onClose, onSaveAndContinue=null, editTransaction=null, copyTransaction=null, prefillDate=null, prefillAccount=null, prefillCategory=null, backInterceptRef=null, onSaveInstalment=null }) {
  const { state, addTransaction, updateTransaction, createRecurringRule } = useApp();
  const { accounts, categories, transactions } = state;
  const isEdit = !!editTransaction;
  const isCopy = !!copyTransaction;

  // Reorder overlay state (stays inside AddTransaction — no navigation needed)
  const [reorderScreen, setReorderScreen] = useState(null);

  // Refs for focus flow
  const amountRef       = useRef(null);
  const noteRef         = useRef(null);
  const accountRef      = useRef(null);
  const categoryRef     = useRef(null);
  const subcatRef       = useRef(null);

  const lastTime = useMemo(() => {
    if (!transactions.length) return nowTimeStr();
    const sorted = [...transactions].sort((a,b)=>{ try{return new Date(b.created_at||0)-new Date(a.created_at||0);}catch{return 0;} });
    return sorted[0]?.Time || nowTimeStr();
  }, [transactions]);

  const lastTimeForDate = useMemo(() => {
    if (!prefillDate||!transactions.length) return null;
    let dt = transactions.filter(t=>t.Date===prefillDate);
    if (prefillAccount) dt=dt.filter(t=>(t.Account||t.FromAccount)===prefillAccount||t.ToAccount===prefillAccount);
    if (prefillCategory) dt=dt.filter(t=>t.Category===prefillCategory);
    if (!dt.length) return null;
    return dt.sort((a,b)=>{if(a.Time&&b.Time)return b.Time.localeCompare(a.Time);try{return new Date(b.created_at||0)-new Date(a.created_at||0);}catch{return 0;}})[0]?.Time||null;
  }, [prefillDate, prefillAccount, prefillCategory, transactions]);

  const [form, setForm] = useState(() => {
    if (isEdit) {
      const t=editTransaction, rt=t['Income/Expense']||'Expense';
      // Strip (x/x) instalment suffix from Note so user sees clean note in edit form
      const cleanNote = (t.Note||'').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
      return {type:rt,amount:String(t.INR||t.Amount||''),date:toInputDate(t.Date)||todayVal(),time:t.Time||lastTime,
        account:rt.startsWith('Transfer')?'':(t.Account||''),fromAccount:rt.startsWith('Transfer')?(t.Account||t.FromAccount||''):'',
        toAccount:rt.startsWith('Transfer')?(t.ToAccount||''):'',category:t.Category||'',
        subcategory:t.Subcategory&&t.Subcategory!=='Default'?t.Subcategory:'',note:cleanNote,description:t.Description||''};
    }
    if (isCopy) {
      const t=copyTransaction, rt=t['Income/Expense']||'Expense';
      return {type:rt,amount:String(t.INR||t.Amount||''),date:toInputDate(t.Date)||todayVal(),time:t.Time||nowTimeStr(),
        account:rt.startsWith('Transfer')?'':(t.Account||''),fromAccount:rt.startsWith('Transfer')?(t.Account||t.FromAccount||''):'',
        toAccount:rt.startsWith('Transfer')?(t.ToAccount||''):'',category:t.Category||'',
        subcategory:t.Subcategory&&t.Subcategory!=='Default'?t.Subcategory:'',note:t.Note||'',description:t.Description||''};
    }
    return {type:'Expense',amount:'',date:prefillDate?(toInputDate(prefillDate)||todayVal()):todayVal(),
      time:prefillDate&&lastTimeForDate?lastTimeForDate:nowTimeStr(),
      account:prefillAccount||'',fromAccount:'',toAccount:'',category:prefillCategory||'',subcategory:'',note:'',description:''};
  });

  const [errors,      setErrors]      = useState({});
  const [saving,      setSaving]      = useState(false);
  const [noteSugs,    setNoteSugs]    = useState([]);
  const [noteFocused, setNoteFocused] = useState(false);
  // Recurring
  const [showRecurring, setShowRecurring] = useState(false);
  const [recurringConfig, setRecurringConfig] = useState(null); // {type, totalDays?, scheduleMode, frequency?}

  const textInputRef = (el) => {
    if (!el) return;
    el.setAttribute('autocomplete','on'); el.setAttribute('autocorrect','on');
    el.setAttribute('spellcheck','true'); el.setAttribute('autocapitalize','sentences');
    el.setAttribute('inputmode','text');
  };

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
    if (isTransfer) return; // transfer has From/To, leave as-is
    const t = setTimeout(() => accountRef.current?.open(), 200);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, v) => {
    setForm(p => {
      if (k==='type') {
        const n={...p,type:v,category:'',subcategory:''};
        if (v==='Transfer-Out'&&p.account){n.fromAccount=p.account;n.account='';}
        else if(p.type==='Transfer-Out'&&v!=='Transfer-Out'&&p.fromAccount){n.account=p.fromAccount;n.fromAccount='';n.toAccount='';}
        return n;
      }
      if (k==='category') return {...p,[k]:v,subcategory:''};
      return {...p,[k]:v};
    });
    if (errors[k]) setErrors(p=>({...p,[k]:''}));
  };

  const isTransfer = form.type==='Transfer-Out';

  const accountList = useMemo(() => {
    const accts=(accounts||[]).filter((a,i,arr)=>arr.findIndex(b=>(b.name||b)===(a.name||a))===i);
    const groups=state.accountGroups||[];
    const result=[];
    for (const grp of groups) result.push(...accts.filter(a=>(a.group||'')===grp).map(a=>a.name||a).filter(Boolean));
    const inAnyGroup=new Set(result);
    result.push(...accts.filter(a=>!inAnyGroup.has(a.name||a)&&(a.name||a)).map(a=>a.name||a));
    return result;
  }, [accounts, state.accountGroups]);

  const availCats = useMemo(() => {
    const wantType=form.type==='Income'?'Income':'Expense';
    const catArr=state.categoriesArr||[];
    if (catArr.length>0) return catArr.filter(c=>(c.type||'Expense')===wantType).map(c=>c.name);
    return Object.entries(categories||{}).filter(([,d])=>(d?.type||'Expense')===wantType).map(([n])=>n);
  }, [categories, state.categoriesArr, form.type]);

  const availSubs = useMemo(() =>
    (categories?.[form.category]?.subcategories||[]).filter(s=>s&&s!=='Default').sort(),
    [categories, form.category]);

  const recentAccounts = useMemo(() => {
    const seen=new Set(),result=[];
    for (const t of [...transactions].sort((a,b)=>(b.Date||'').localeCompare(a.Date||''))) {
      const name=t.Account||t.FromAccount||'';
      if (name&&!seen.has(name)){seen.add(name);result.push(name);}
      if (result.length>=5) break;
    }
    return result;
  }, [transactions]);

  const recentCats = useMemo(() => {
    const wantType=form.type==='Income'?'income':'expense';
    const seen=new Set(),result=[];
    for (const t of [...transactions].sort((a,b)=>(b.Date||'').localeCompare(a.Date||''))) {
      const tp=(t['Income/Expense']||'').toLowerCase();
      if (tp!==wantType) continue;
      const cat=t.Category||'';
      if (cat&&cat!=='Transfer'&&!seen.has(cat)){seen.add(cat);result.push(cat);}
      if (result.length>=5) break;
    }
    return result;
  }, [transactions, form.type]);

  const handleNoteChange = (v) => {
    set('note',v);
    if (v.trim().length>0){
      const q=v.toLowerCase(),seen=new Set();
      const sugs=transactions.map(t=>stripInstalmentSuffix(t.Note||'')).filter(n=>{if(!n||seen.has(n)||!n.toLowerCase().includes(q))return false;seen.add(n);return true;}).slice(0,6);
      setNoteSugs(sugs);
    } else setNoteSugs([]);
  };

  const validate = () => {
    const e={};
    if (!form.amount||isNaN(parseFloat(form.amount))||parseFloat(form.amount)<0) e.amount='Enter a valid amount';
    if (!form.date) e.date='Required';
    if (isTransfer){
      if (!form.fromAccount) e.fromAccount='Select from account';
      if (!form.toAccount)   e.toAccount='Select to account';
      if (form.fromAccount&&form.fromAccount===form.toAccount) e.toAccount='Must differ from From';
    } else {
      if (!form.account)  e.account='Select account';
      if (!form.category) e.category='Select category';
    }
    setErrors(e); return Object.keys(e).length===0;
  };

  const handleSave = async (shouldContinue=false) => {
    if (!validate()||saving) return;
    setSaving(true);
    try {
      const baseNote = form.note || '';
      const totalAmount = parseFloat(form.amount) || 0;

      if (!isEdit && recurringConfig) {
        // form.date is YYYY-MM-DD (HTML date input format)
        // inputToStorage converts to DD/MM/YYYY for transaction storage
        // recurring rule stores start_date/next_date in YYYY-MM-DD internally
        const isoDate = form.date; // YYYY-MM-DD — used for recurring rule storage
        const txnDate = inputToStorage(form.date); // DD/MM/YYYY — used for transaction records

        if (recurringConfig.type === 'instalment') {
          // Rule stores start_date in YYYY-MM-DD so buildInstalmentSchedule can parse it
          const rule = {
            rule_type: 'instalment', status: 'completed', // all parts created upfront
            txn_type: form.type,
            account: form.account, from_account: form.fromAccount || '', to_account: form.toAccount || '',
            category: form.category, subcategory: form.subcategory || '',
            base_note: baseNote, description: form.description || '',
            currency: 'INR', total_amount: totalAmount,
            total_days: recurringConfig.totalDays,
            start_date: isoDate,                // YYYY-MM-DD
            schedule_mode: recurringConfig.scheduleMode,
          };
          const schedule = buildInstalmentSchedule(rule);
          rule.total_parts    = schedule.length;
          rule.completed_parts = schedule.length; // all created now
          rule.next_date      = '';               // no pending parts
          rule.end_date       = schedule[schedule.length - 1]?.date || '';
          rule.amount_per_part = schedule[0]?.amount || 0;
          const saved = await createRecurringRule(rule);
          // Create all instalment transactions — inst.date is YYYY-MM-DD, convert to DD/MM/YYYY
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
            });
          }
        } else if (recurringConfig.type === 'repeat') {
          // next_date stored as YYYY-MM-DD
          const nextDate = computeNextRepeatDate(isoDate, recurringConfig.frequency, recurringConfig.scheduleMode);
          const rule = {
            rule_type: 'repeat', status: 'active',
            txn_type: form.type,
            account: form.account, from_account: form.fromAccount || '', to_account: form.toAccount || '',
            category: form.category, subcategory: form.subcategory || '',
            base_note: baseNote, description: form.description || '',
            currency: 'INR', amount_per_part: totalAmount,
            start_date:    isoDate,             // YYYY-MM-DD
            next_date:     nextDate,            // YYYY-MM-DD
            schedule_mode: recurringConfig.scheduleMode,
            frequency:     recurringConfig.frequency,
            completed_parts: 1,
          };
          const saved = await createRecurringRule(rule);
          // Save first transaction
          await addTransaction({
            Date: txnDate, Time: form.time || '',
            Account: form.account, FromAccount: form.fromAccount || '', ToAccount: form.toAccount || '',
            Category: isTransfer ? 'Transfer' : form.category,
            Subcategory: form.subcategory || 'Default',
            Note: baseNote, Description: form.description || '',
            INR: totalAmount, Amount: form.amount,
            Currency: 'INR', 'Income/Expense': form.type,
            recurring_rule_id: saved.id,
          });
        }
      } else {
        // Normal single transaction
        // For instalment edits: keep recurring_rule_id and re-apply (x/x) suffix to THIS transaction
        const thisNote = isEdit && onSaveInstalment
          ? (() => {
              // Re-apply the original (x/x) suffix from the transaction being edited
              const m = (editTransaction.Note||'').match(/\s*\(\d+\/\d+\)\s*$/);
              return m ? baseNote + m[0].trimStart() : baseNote;
            })()
          : baseNote;
        const data={
          Date:inputToStorage(form.date),Time:form.time||'',
          Account:isTransfer?form.fromAccount:form.account,
          FromAccount:isTransfer?form.fromAccount:'',ToAccount:isTransfer?form.toAccount:'',
          Category:isTransfer?'Transfer':form.category,
          Subcategory:form.subcategory||'Default',
          Note:thisNote,Description:form.description||'',
          INR:totalAmount,Amount:form.amount,
          Currency:'INR','Income/Expense':form.type,
          // Preserve recurring_rule_id so instalment link is never lost
          recurring_rule_id: editTransaction?.recurring_rule_id || '',
        };
        if (isEdit && onSaveInstalment) {
          // Instalment edit: update this transaction (with its own suffix), bulk-update siblings
          await updateTransaction(editTransaction._id, data);
          await onSaveInstalment(data);
        } else if (isEdit) {
          await updateTransaction(editTransaction._id, data);
        } else {
          await addTransaction(data);
        }
      }
      if (shouldContinue&&onSaveAndContinue) onSaveAndContinue(); else onClose();
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
    const snap = { ...form };
    if (justFilled) snap[justFilled.key] = justFilled.val;
    setTimeout(() => {
      if (!isTransfer) {
        if (!snap.account)  { accountRef.current?.open();  return; }
        if (!snap.category) { categoryRef.current?.open(); return; }
      }
      if (!snap.amount) { amountRef.current?.focus(); return; }
      if (!snap.note)   { noteRef.current?.focus();   return; }
    }, 120);
  };

  return (
    <>
      <div className="fullscreen-overlay" onClick={onClose}/>
      <div className="fullscreen-modal" data-type={form.type}>
        <div className="add-hdr">
          <div className="add-title">{isEdit?'Edit':'Add'}</div>
          <button className="add-close" onClick={onClose}>✕</button>
        </div>
        <div className="type-tabs">
          {TYPES.map(tp=>(
            <button key={tp.id} className={`type-tab ${tp.cls} ${form.type===tp.id?'active':''}`} onClick={()=>set('type',tp.id)}>
              {tp.label}
            </button>
          ))}
        </div>

        <div className="add-form">
          {/* Row 1: Date + Time — Rep/Inst label floats right above row */}
          {!isEdit && (
            <div style={{display:'flex',justifyContent:'flex-end',marginBottom:2}}>
              <span
                onClick={()=>setShowRecurring(true)}
                style={{fontSize:'0.68rem',fontWeight:700,cursor:'pointer',
                  color:recurringConfig?'var(--accent)':'var(--text-muted)',
                  display:'flex',alignItems:'center',gap:3}}>
                {recurringConfig ? (recurringConfig.type==='instalment'?'📋 Instalment':'🔁 Repeat') : '🔁 Rep / Inst'}
              </span>
            </div>
          )}
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Date</label>
              <input className={`form-input ${errors.date?'err':''}`} type="date" value={form.date} onChange={e=>set('date',e.target.value)}/>
            </div>
            <div className="form-group">
              <label className="form-label">Time</label>
              <input className="form-input" type="time" value={form.time} onChange={e=>set('time',e.target.value)}/>
            </div>
          </div>
          {/* Show recurring config summary */}
          {!isEdit && recurringConfig && (
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',
              padding:'6px 10px',borderRadius:8,background:'rgba(0,229,160,0.08)',
              border:'1px solid rgba(0,229,160,0.25)',marginTop:-4}}>
              <span style={{fontSize:'0.72rem',color:'var(--accent)',fontWeight:600}}>
                {recurringConfig.type==='instalment'
                  ? `📋 Instalment · ${recurringConfig.totalDays} days · ${recurringConfig.scheduleMode==='start_of_month'?'Start of month':'On the day'}`
                  : `🔁 Repeat ${recurringConfig.frequency} · ${recurringConfig.scheduleMode==='start_of_month'?'Start of month':'On date'}`}
              </span>
              <button type="button" onClick={()=>setRecurringConfig(null)}
                style={{background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:'0.8rem',padding:'0 2px'}}>✕</button>
            </div>
          )}

          {/* Row 2: Account(s) */}
          {isTransfer ? (
            <div className="transfer-swap-row">
              <PickerFieldFR label="From" value={form.fromAccount} placeholder="Select"
                error={errors.fromAccount} items={accountList} recent={recentAccounts}
                onSelect={v=>{set('fromAccount',v);goNextEmpty({key:'fromAccount',val:v});}}
                onReorder={()=>setReorderScreen('accounts')} />
              <button type="button" className="swap-btn" title="Swap"
                onClick={()=>setForm(p=>({...p,fromAccount:p.toAccount,toAccount:p.fromAccount}))}>
                ⇄
              </button>
              <PickerFieldFR label="To" value={form.toAccount} placeholder="Select"
                error={errors.toAccount} items={accountList} recent={recentAccounts}
                onSelect={v=>{set('toAccount',v);goNextEmpty({key:'toAccount',val:v});}}
                exclude={form.fromAccount}
                onReorder={()=>setReorderScreen('accounts')} />
            </div>
          ) : (
            <PickerFieldFR ref={accountRef} label="Account" value={form.account} placeholder="Select account"
              error={errors.account} items={accountList} recent={recentAccounts}
              onSelect={v=>{set('account',v);goNextEmpty({key:'account',val:v});}}
              onReorder={()=>setReorderScreen('accounts')} />
          )}

          {/* Row 3: Category + Subcategory */}
          {!isTransfer && (
            <div className="grid-2">
              <PickerFieldFR ref={categoryRef} label="Category" value={form.category} placeholder="Select category"
                error={errors.category} items={availCats} recent={recentCats}
                onSelect={v=>{
                  set('category',v);
                  const freshSubs=(categories?.[v]?.subcategories||[]).filter(s=>s&&s!=='Default');
                  afterCategory(v, freshSubs);
                }}
                onReorder={()=>setReorderScreen('categories')} />
              <SubcatFieldFR ref={subcatRef} value={form.subcategory} items={availSubs}
                onChange={v=>set('subcategory',v)}
                onAfterSelect={()=>{ if(!isEdit){ if(!form.amount) setTimeout(()=>amountRef.current?.focus(),120); else setTimeout(()=>noteRef.current?.focus(),120); } }} />
            </div>
          )}

          {/* Row 4: Amount */}
          <div className="form-group">
            <label className="form-label">Amount</label>
            <div style={{position:'relative',display:'flex',alignItems:'center'}}>
              <span style={{position:'absolute',left:10,fontSize:'0.9rem',color:'var(--text-muted)',pointerEvents:'none',zIndex:1}}>₹</span>
              <input ref={amountRef}
                className={`form-input ${errors.amount?'err':''}`}
                style={{paddingLeft:24}}
                type="tel" inputMode="decimal" pattern="[0-9]*([.,][0-9]+)?"
                autoComplete="off" autoCorrect="off" spellCheck="false"
                onKeyDown={e=>{
                  const a=['Backspace','Delete','ArrowLeft','ArrowRight','Tab','.',','];
                  if (e.key==='Enter'){e.preventDefault();goNextEmpty({key:'amount',val:form.amount});}
                  else if (!a.includes(e.key)&&!/^[0-9]$/.test(e.key)) e.preventDefault();
                }}
                value={form.amount} onChange={e=>set('amount',e.target.value)}/>
            </div>
            {errors.amount && <div className="field-error">{errors.amount}</div>}
          </div>

          {/* Row 5: Note */}
          <div className="form-group" style={{position:'relative'}}>
            <label className="form-label">Note</label>
            <div style={{position:'relative'}}>
              <input ref={el=>{textInputRef(el);noteRef.current=el;}} className="form-input" type="text" value={form.note}
                style={{paddingRight:(form.note||noteFocused)?'30px':undefined}}
                autoComplete="on" autoCorrect="on" spellCheck="true" autoCapitalize="sentences"
                onChange={e=>handleNoteChange(e.target.value)}
                onFocus={()=>setNoteFocused(true)}
                onBlur={()=>{setNoteFocused(false);setTimeout(()=>setNoteSugs([]),180);}}
                onKeyDown={e=>{if(e.key==='Enter'&&!isEdit){e.preventDefault();noteRef.current?.blur();}}}
              />
              {(form.note||noteFocused)&&(
                <button type="button" onMouseDown={e=>{e.preventDefault();set('note','');setNoteSugs([]);setNoteFocused(false);}}
                  style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:'1.1rem',lineHeight:1,padding:'2px 4px',zIndex:1}}>✕</button>
              )}
            </div>
            {noteSugs.length>0&&(
              <div className="note-sug-list">
                {noteSugs.map(s=><div key={s} className="note-sug-item" onMouseDown={()=>{set('note',s);setNoteSugs([]);}}>{s}</div>)}
              </div>
            )}
          </div>

          {/* Row 6: Description */}
          <div className="form-group">
            <label className="form-label">Description</label>
            <textarea ref={textInputRef} className="form-input" rows={3} value={form.description}
              autoComplete="on" autoCorrect="on" spellCheck="true" autoCapitalize="sentences"
              onChange={e=>set('description',e.target.value)}/>
          </div>

          <div className="form-actions" style={{display:'flex',gap:'10px'}}>
            <button className="btn btn-primary btn-lg" style={{flex:2}} onClick={()=>handleSave(false)} disabled={saving}>
              {saving?'Saving…':isEdit?'Update':(isCopy?'Copy':'Save')}
            </button>
            {!isEdit&&onSaveAndContinue&&(
              <button className="btn btn-secondary btn-lg" style={{flex:1}} onClick={()=>handleSave(true)} disabled={saving}>
                {saving?'Saving…':'Continue'}
              </button>
            )}
          </div>
          <div style={{height:16}}/>
        </div>
      </div>

      {/* Inline reorder overlay — keeps AddTransaction mounted */}
      <ReorderOverlay screen={reorderScreen} onClose={()=>setReorderScreen(null)} />
      {/* Recurring sheet */}
      {showRecurring && (
        <RecurringSheet
          isExpense={form.type==='Expense'}
          startDate={form.date}
          onClose={()=>setShowRecurring(false)}
          onSave={cfg=>{setRecurringConfig(cfg);setShowRecurring(false);}}
        />
      )}
    </>
  );
}