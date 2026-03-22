import React, { useState, useMemo, useRef } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { inputToStorage, toInputDate, nowTimeStr } from '../../utils/format.js';
import './AddTransaction.css';

const TYPES = [
  { id:'Income',       label:'Income',   cls:'income'   },
  { id:'Expense',      label:'Expense',  cls:'expense'  },
  { id:'Transfer-Out', label:'Transfer', cls:'transfer' },
];

const todayVal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

// ── PickerSheet — chip grid with recent row ───────────────────────────────────
function PickerSheet({ label, items, recent, value, onSelect, onClose, exclude = '' }) {
  const [query, setQuery] = React.useState('');
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const q = query.trim().toLowerCase();
  const recentList = recent.filter(i => i !== exclude && (!q || i.toLowerCase().includes(q)));
  const recentSet  = new Set(recentList);
  // All items minus recent, filtered by search, in user-defined order
  const allItems   = items.filter(i => i !== exclude && !recentSet.has(i) && (!q || i.toLowerCase().includes(q)));
  const noResults  = recentList.length === 0 && allItems.length === 0;

  const Chip = ({ name }) => (
    <button
      type="button"
      className={`picker-chip ${value === name ? 'picker-chip-active' : ''}`}
      onMouseDown={e => { e.preventDefault(); onSelect(name); onClose(); }}
    >
      {name}
      {value === name && <span className="picker-chip-check"> ✓</span>}
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
        {/* Search */}
        <div className="picker-search-wrap">
          <span className="picker-search-icon">🔍</span>
          <input
            ref={inputRef}
            className="picker-search-input"
            placeholder={`Search ${label.toLowerCase()}…`}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button className="picker-search-clear" onMouseDown={e => { e.preventDefault(); setQuery(''); }}>✕</button>
          )}
        </div>
        <div className="picker-list">
          {/* Recent — horizontal scrollable chip row */}
          {recentList.length > 0 && (
            <>
              <div className="picker-section-label">Recent</div>
              <div className="picker-recent-row">
                {recentList.map(n => <Chip key={n} name={n} />)}
              </div>
            </>
          )}
          {/* All items — 3-column chip grid in user-defined order */}
          {allItems.length > 0 && (
            <>
              <div className="picker-section-label">
                {recentList.length > 0 ? 'All' : ''}
                <span style={{float:'right',fontWeight:400,opacity:0.6,textTransform:'none',letterSpacing:0}}>
                  {!q && 'drag in Settings to reorder'}
                </span>
              </div>
              <div className="picker-chip-grid">
                {allItems.map(n => <Chip key={n} name={n} />)}
              </div>
            </>
          )}
          {noResults && (
            <div className="picker-empty">No results for "{query}"</div>
          )}
        </div>
      </div>
    </>
  );
}

function PickerField({ label, value, placeholder, error, items, recent, onSelect, exclude = '' }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <button
        type="button"
        className={`form-input picker-trigger ${error ? 'err' : ''} ${!value ? 'picker-trigger-empty' : ''}`}
        onClick={() => setOpen(true)}
      >
        <span className="picker-trigger-value">{value || placeholder}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" style={{flexShrink:0,opacity:0.5}}><path d="M6 9l6 6 6-6"/></svg>
      </button>
      {error && <div className="field-error">{error}</div>}
      {open && (
        <PickerSheet
          label={label}
          items={items}
          recent={recent}
          value={value}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
          exclude={exclude}
        />
      )}
    </div>
  );
}

// ── Main AddTransaction ───────────────────────────────────────────────────────
export default function AddTransaction({ onClose, onSaveAndContinue = null, editTransaction = null, copyTransaction = null, prefillDate = null, prefillAccount = null, prefillCategory = null, backInterceptRef = null }) {
  const { state, addTransaction, updateTransaction } = useApp();
  const { accounts, categories, transactions } = state;
  const isEdit = !!editTransaction;
  const isCopy = !!copyTransaction;

  const lastTime = React.useMemo(() => {
    if (!transactions.length) return nowTimeStr();
    const sorted = [...transactions].sort((a,b) => { try { return new Date(b.created_at||0)-new Date(a.created_at||0); } catch { return 0; } });
    return sorted[0]?.Time || nowTimeStr();
  }, [transactions]);

  const lastTimeForDate = React.useMemo(() => {
    if (!prefillDate || !transactions.length) return null;
    let dateTxns = transactions.filter(t => t.Date === prefillDate);
    if (prefillAccount) dateTxns = dateTxns.filter(t => (t.Account || t.FromAccount) === prefillAccount || t.ToAccount === prefillAccount);
    if (prefillCategory) dateTxns = dateTxns.filter(t => t.Category === prefillCategory);
    if (!dateTxns.length) return null;
    const sorted = dateTxns.sort((a, b) => {
      if (a.Time && b.Time) return b.Time.localeCompare(a.Time);
      try { return new Date(b.created_at || 0) - new Date(a.created_at || 0); } catch { return 0; }
    });
    return sorted[0]?.Time || null;
  }, [prefillDate, prefillAccount, prefillCategory, transactions]);

  const [form, setForm] = useState(() => {
    if (isEdit) {
      const t = editTransaction;
      const rawType = t["Income/Expense"] || "Expense";
      return { type: rawType, amount: String(t.INR || t.Amount || ""), date: toInputDate(t.Date) || todayVal(), time: t.Time || lastTime,
        account: rawType.startsWith("Transfer") ? "" : (t.Account || ""), fromAccount: rawType.startsWith("Transfer") ? (t.Account || t.FromAccount || "") : "",
        toAccount: rawType.startsWith("Transfer") ? (t.ToAccount || "") : "", category: t.Category || "",
        subcategory: t.Subcategory && t.Subcategory !== "Default" ? t.Subcategory : "", note: t.Note || "", description: t.Description || "" };
    }
    if (isCopy) {
      const t = copyTransaction;
      const rawType = t["Income/Expense"] || "Expense";
      return { type: rawType, amount: String(t.INR || t.Amount || ""), date: toInputDate(t.Date) || todayVal(), time: t.Time || nowTimeStr(),
        account: rawType.startsWith("Transfer") ? "" : (t.Account || ""), fromAccount: rawType.startsWith("Transfer") ? (t.Account || t.FromAccount || "") : "",
        toAccount: rawType.startsWith("Transfer") ? (t.ToAccount || "") : "", category: t.Category || "",
        subcategory: t.Subcategory && t.Subcategory !== "Default" ? t.Subcategory : "", note: t.Note || "", description: t.Description || "" };
    }
    return { type:"Expense", amount:"", date: prefillDate ? (toInputDate(prefillDate) || todayVal()) : todayVal(),
      time: prefillDate && lastTimeForDate ? lastTimeForDate : nowTimeStr(),
      account: prefillAccount || "", fromAccount:"", toAccount:"", category: prefillCategory || "", subcategory:"", note:"", description:"" };
  });

  const [errors,      setErrors]      = useState({});
  const [saving,      setSaving]      = useState(false);
  const [noteSugs,    setNoteSugs]    = useState([]);
  const [noteFocused, setNoteFocused] = useState(false);

  const textInputRef = (el) => {
    if (!el) return;
    el.setAttribute("autocomplete","on"); el.setAttribute("autocorrect","on");
    el.setAttribute("spellcheck","true"); el.setAttribute("autocapitalize","sentences");
    el.setAttribute("inputmode","text");
  };

  React.useEffect(() => {
    if (!backInterceptRef) return;
    backInterceptRef.current = onClose;
    return () => { if (backInterceptRef.current === onClose) backInterceptRef.current = null; };
  }, [backInterceptRef, onClose]);

  const set = (k, v) => {
    setForm(p => {
      if (k === "type") {
        const n = { ...p, type: v, category: "", subcategory: "" };
        if (v === "Transfer-Out" && p.account) { n.fromAccount = p.account; n.account = ""; }
        else if (p.type === "Transfer-Out" && v !== "Transfer-Out" && p.fromAccount) { n.account = p.fromAccount; n.fromAccount = ""; n.toAccount = ""; }
        return n;
      }
      if (k === "category") return { ...p, [k]: v, subcategory: "" };
      return { ...p, [k]: v };
    });
    if (errors[k]) setErrors(p => ({ ...p, [k]: "" }));
  };

  const isTransfer = form.type === "Transfer-Out";

  // accountList: ordered by account group order, then within each group by sort_order.
  // Ungrouped accounts go at the end in their own sort_order sequence.
  const accountList = React.useMemo(() => {
    const accts = (accounts || []).filter((a, i, arr) => {
      // deduplicate by name
      return arr.findIndex(b => (b.name||b) === (a.name||a)) === i;
    });
    const groups = state.accountGroups || [];
    const result = [];
    // Add accounts in group order first
    for (const grp of groups) {
      const inGroup = accts.filter(a => (a.group||'') === grp);
      result.push(...inGroup.map(a => a.name || a).filter(Boolean));
    }
    // Then ungrouped accounts
    const inAnyGroup = new Set(result);
    const ungrouped = accts.filter(a => !inAnyGroup.has(a.name || a) && (a.name||a));
    result.push(...ungrouped.map(a => a.name || a));
    return result;
  }, [accounts, state.accountGroups]);

  const availCats = React.useMemo(() => {
    const wantType = form.type === "Income" ? "Income" : "Expense";
    // Use state.categoriesArr (sorted by sortOrder) if available, else fall back to Object.entries
    // categories object doesn't preserve insertion order reliably, so we use the sorted array
    const catArr = state.categoriesArr || [];
    if (catArr.length > 0) {
      return catArr.filter(c => (c.type||'Expense') === wantType).map(c => c.name);
    }
    // fallback: Object.entries without sort — order from DB via catsArrToObj
    return Object.entries(categories || {}).filter(([,d]) => (d?.type||"Expense") === wantType).map(([n]) => n);
  }, [categories, state.categoriesArr, form.type]);

  const availSubs = React.useMemo(() =>
    (categories?.[form.category]?.subcategories || []).filter(s => s && s !== "Default").sort(),
    [categories, form.category]);

  // Recent accounts: last 5 distinct used
  const recentAccounts = React.useMemo(() => {
    const seen = new Set(), result = [];
    for (const t of [...transactions].sort((a,b) => (b.Date||"").localeCompare(a.Date||""))) {
      const name = t.Account || t.FromAccount || "";
      if (name && !seen.has(name)) { seen.add(name); result.push(name); }
      if (result.length >= 5) break;
    }
    return result;
  }, [transactions]);

  // Recent categories for current type: last 5 distinct
  const recentCats = React.useMemo(() => {
    const wantType = form.type === "Income" ? "income" : "expense";
    const seen = new Set(), result = [];
    for (const t of [...transactions].sort((a,b) => (b.Date||"").localeCompare(a.Date||""))) {
      const tp = (t["Income/Expense"]||"").toLowerCase();
      if (tp !== wantType) continue;
      const cat = t.Category || "";
      if (cat && cat !== "Transfer" && !seen.has(cat)) { seen.add(cat); result.push(cat); }
      if (result.length >= 5) break;
    }
    return result;
  }, [transactions, form.type]);

  const handleNoteChange = (v) => {
    set("note", v);
    if (v.trim().length > 0) {
      const q = v.toLowerCase(), seen = new Set();
      const sugs = transactions.map(t => t.Note).filter(n => { if (!n || seen.has(n) || !n.toLowerCase().includes(q)) return false; seen.add(n); return true; }).slice(0,6);
      setNoteSugs(sugs);
    } else setNoteSugs([]);
  };

  const validate = () => {
    const e = {};
    if (!form.amount || isNaN(parseFloat(form.amount)) || parseFloat(form.amount) < 0) e.amount = "Enter a valid amount";
    if (!form.date) e.date = "Required";
    if (isTransfer) {
      if (!form.fromAccount) e.fromAccount = "Select from account";
      if (!form.toAccount)   e.toAccount   = "Select to account";
      if (form.fromAccount && form.fromAccount === form.toAccount) e.toAccount = "Must differ from From";
    } else {
      if (!form.account)  e.account  = "Select account";
      if (!form.category) e.category = "Select category";
    }
    setErrors(e); return Object.keys(e).length === 0;
  };

  const handleSave = async (shouldContinue = false) => {
    if (!validate() || saving) return;
    setSaving(true);
    try {
      const data = {
        Date: inputToStorage(form.date), Time: form.time || "",
        Account: isTransfer ? form.fromAccount : form.account,
        FromAccount: isTransfer ? form.fromAccount : "",
        ToAccount: isTransfer ? form.toAccount : "",
        Category: isTransfer ? "Transfer" : form.category,
        Subcategory: form.subcategory || "Default",
        Note: form.note || "", Description: form.description || "",
        INR: parseFloat(form.amount) || 0, Amount: form.amount,
        Currency: "INR", "Income/Expense": form.type,
      };
      if (isEdit) await updateTransaction(editTransaction._id, data);
      else        await addTransaction(data);
      if (shouldContinue && onSaveAndContinue) onSaveAndContinue(); else onClose();
    } finally { setSaving(false); }
  };

  return (
    <>
      <div className="fullscreen-overlay" onClick={onClose}/>
      <div className="fullscreen-modal" data-type={form.type}>
        <div className="add-hdr">
          <div className="add-title">{isEdit ? "Edit" : "Add"}</div>
          <button className="add-close" onClick={onClose}>✕</button>
        </div>
        <div className="type-tabs">
          {TYPES.map(tp => (
            <button key={tp.id} className={`type-tab ${tp.cls} ${form.type===tp.id?"active":""}`} onClick={()=>set("type",tp.id)}>
              {tp.label}
            </button>
          ))}
        </div>
        <div className="amount-row">
          <span className="amount-prefix">₹</span>
          <input className={`form-input-amount ${errors.amount?"err":""}`} type="tel" inputMode="decimal" pattern="[0-9]*([.,][0-9]+)?"
            autoComplete="off" autoCorrect="off" spellCheck="false"
            onKeyDown={e=>{const a=["Backspace","Delete","ArrowLeft","ArrowRight","Tab","Enter",".",","]; if(!a.includes(e.key)&&!/^[0-9]$/.test(e.key))e.preventDefault();}}
            value={form.amount} onChange={e=>set("amount",e.target.value)} autoFocus={!isEdit}/>
        </div>
        {errors.amount && <div className="field-error" style={{padding:"0 var(--page-px) 2px"}}>{errors.amount}</div>}

        <div className="add-form">
          <div className="grid-2">
            <div className="form-group">
              <label className="form-label">Date</label>
              <input className={`form-input ${errors.date?"err":""}`} type="date" value={form.date} onChange={e=>set("date",e.target.value)}/>
            </div>
            <div className="form-group">
              <label className="form-label">Time</label>
              <input className="form-input" type="time" value={form.time} onChange={e=>set("time",e.target.value)}/>
            </div>
          </div>

          {isTransfer ? (
            <div className="grid-2">
              <PickerField label="From Account" value={form.fromAccount} placeholder="Select" error={errors.fromAccount}
                items={accountList} recent={recentAccounts} onSelect={v=>set("fromAccount",v)}/>
              <PickerField label="To Account" value={form.toAccount} placeholder="Select" error={errors.toAccount}
                items={accountList} recent={recentAccounts} onSelect={v=>set("toAccount",v)} exclude={form.fromAccount}/>
            </div>
          ) : (
            <PickerField label="Account" value={form.account} placeholder="Select account" error={errors.account}
              items={accountList} recent={recentAccounts} onSelect={v=>set("account",v)}/>
          )}

          {!isTransfer && (
            <div className="grid-2">
              <PickerField label="Category" value={form.category} placeholder="Select category" error={errors.category}
                items={availCats} recent={recentCats} onSelect={v=>set("category",v)}/>
              <div className="form-group">
                <label className="form-label">Subcategory</label>
                <select className="form-input" value={form.subcategory} onChange={e=>set("subcategory",e.target.value)} disabled={!availSubs.length}>
                  <option value="">None</option>
                  {availSubs.map(s=><option key={s}>{s}</option>)}
                </select>
              </div>
            </div>
          )}

          <div className="form-group" style={{position:"relative"}}>
            <label className="form-label">Note</label>
            <div style={{position:"relative"}}>
              <input ref={textInputRef} className="form-input" type="text" value={form.note}
                style={{paddingRight:(form.note||noteFocused)?"30px":undefined}}
                autoComplete="on" autoCorrect="on" spellCheck="true" autoCapitalize="sentences"
                onChange={e=>handleNoteChange(e.target.value)}
                onFocus={()=>setNoteFocused(true)}
                onBlur={()=>{setNoteFocused(false);setTimeout(()=>setNoteSugs([]),180);}}/>
              {(form.note||noteFocused)&&(
                <button type="button" onMouseDown={e=>{e.preventDefault();set("note","");setNoteSugs([]);setNoteFocused(false);}}
                  style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--text-muted)",cursor:"pointer",fontSize:"1.1rem",lineHeight:1,padding:"2px 4px",zIndex:1}}>✕</button>
              )}
            </div>
            {noteSugs.length>0&&(
              <div className="note-sug-list">
                {noteSugs.map(s=><div key={s} className="note-sug-item" onMouseDown={()=>{set("note",s);setNoteSugs([]);}}>{s}</div>)}
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">Description</label>
            <textarea ref={textInputRef} className="form-input" rows={3} value={form.description}
              autoComplete="on" autoCorrect="on" spellCheck="true" autoCapitalize="sentences"
              onChange={e=>set("description",e.target.value)}/>
          </div>

          <div className="form-actions" style={{display:"flex",gap:"10px"}}>
            <button className="btn btn-primary btn-lg" style={{flex:2}} onClick={()=>handleSave(false)} disabled={saving}>
              {saving?"Saving…":isEdit?"Update":(isCopy?"Copy":"Save")}
            </button>
            {!isEdit&&onSaveAndContinue&&(
              <button className="btn btn-secondary btn-lg" style={{flex:1}} onClick={()=>handleSave(true)} disabled={saving}>
                {saving?"Saving…":"Continue"}
              </button>
            )}
          </div>
          <div style={{height:16}}/>
        </div>
      </div>
    </>
  );
}