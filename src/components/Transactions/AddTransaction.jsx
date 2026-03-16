import React, { useState, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { inputToStorage, toInputDate, nowTimeStr } from '../../utils/format.js';

const TYPES = [
  { id:'Income',       label:'Income',   cls:'income'   },
  { id:'Expense',      label:'Expense',  cls:'expense'  },
  { id:'Transfer-Out', label:'Transfer', cls:'transfer' },
];

const todayVal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

export default function AddTransaction({ onClose, onSaveAndContinue = null, editTransaction = null, copyTransaction = null, prefillDate = null, prefillAccount = null, prefillCategory = null, backInterceptRef = null }) {
  const { state, addTransaction, updateTransaction } = useApp();
  const { accounts, categories, transactions } = state;
  const isEdit = !!editTransaction;
  const isCopy = !!copyTransaction;

  const lastTime = useMemo(() => {
    if (!transactions.length) return nowTimeStr();
    const sorted = [...transactions].sort((a,b) => { try { return new Date(b.created_at||0)-new Date(a.created_at||0); } catch { return 0; } });
    return sorted[0]?.Time || nowTimeStr();
  }, [transactions]);

  const lastTimeForDate = useMemo(() => {
    if (!prefillDate || !transactions.length) return null;
    // Find transactions for the prefill date
    let dateTxns = transactions.filter(t => t.Date === prefillDate);
    // If prefillAccount is available, filter by that too
    if (prefillAccount) {
      dateTxns = dateTxns.filter(t => (t.Account || t.FromAccount) === prefillAccount || t.ToAccount === prefillAccount);
    }
    // If prefillCategory is available, filter by that too
    if (prefillCategory) {
      dateTxns = dateTxns.filter(t => t.Category === prefillCategory);
    }
    if (!dateTxns.length) return null;
    // Get the most recent transaction for that date (by time or creation time)
    const sorted = dateTxns.sort((a, b) => {
      // First try to sort by time if available
      if (a.Time && b.Time) {
        return b.Time.localeCompare(a.Time);
      }
      // Fall back to creation time
      try {
        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      } catch {
        return 0;
      }
    });
    return sorted[0]?.Time || null;
  }, [prefillDate, prefillAccount, prefillCategory, transactions]);

  const [form, setForm] = useState(() => {
    if (isEdit) {
      const t = editTransaction;
      const rawType = t['Income/Expense'] || 'Expense';
      return {
        type:        rawType,
        amount:      String(t.INR || t.Amount || ''),
        date:        toInputDate(t.Date) || todayVal(),
        time:        t.Time || lastTime,
        account:     rawType.startsWith('Transfer') ? '' : (t.Account || ''),
        fromAccount: rawType.startsWith('Transfer') ? (t.Account || t.FromAccount || '') : '',
        toAccount:   rawType.startsWith('Transfer') ? (t.ToAccount || '') : '',
        category:    t.Category || '',
        subcategory: t.Subcategory && t.Subcategory !== 'Default' ? t.Subcategory : '',
        note:        t.Note        || '',
        description: t.Description || '',
      };
    }
    if (isCopy) {
      const t = copyTransaction;
      const rawType = t['Income/Expense'] || 'Expense';
      return {
        type:        rawType,
        amount:      String(t.INR || t.Amount || ''),
        date:        todayVal(), // Current date for copy
        time:        nowTimeStr(), // Current time for copy
        account:     rawType.startsWith('Transfer') ? '' : (t.Account || ''),
        fromAccount: rawType.startsWith('Transfer') ? (t.Account || t.FromAccount || '') : '',
        toAccount:   rawType.startsWith('Transfer') ? (t.ToAccount || '') : '',
        category:    t.Category || '',
        subcategory: t.Subcategory && t.Subcategory !== 'Default' ? t.Subcategory : '',
        note:        t.Note        || '',
        description: t.Description || '',
      };
    }
    return {
      type:'Expense', amount:'',
      date: prefillDate ? (toInputDate(prefillDate) || todayVal()) : todayVal(),
      time: prefillDate && lastTimeForDate ? lastTimeForDate : nowTimeStr(),
      account: prefillAccount || '',
      fromAccount:'', toAccount:'', category: prefillCategory || '', subcategory:'', note:'', description:'',
    };
  });

  const [errors,   setErrors]   = useState({});
  const [saving,   setSaving]   = useState(false);
  const [noteSugs, setNoteSugs] = useState([]);

  // Handle back button interception
  React.useEffect(() => {
    if (!backInterceptRef) return;
    backInterceptRef.current = onClose;
    return () => {
      if (backInterceptRef.current === onClose) {
        backInterceptRef.current = null;
      }
    };
  }, [backInterceptRef, onClose]);

  const set = (k, v) => {
    setForm(p => {
      if (k === 'type')     return { ...p, [k]: v, category:'', subcategory:'' };
      if (k === 'category') return { ...p, [k]: v, subcategory:'' };
      return { ...p, [k]: v };
    });
    if (errors[k]) setErrors(p => ({ ...p, [k]: '' }));
  };

  const isTransfer = form.type === 'Transfer-Out';

  const uniqueAccounts = useMemo(() => {
    const seen = new Set();
    return (accounts || []).filter(acc => {
        const duplicate = seen.has(acc.name);
        seen.add(acc.name);
        return !duplicate;
    });
  }, [accounts]);

  const accountList = useMemo(() =>
    (Array.isArray(uniqueAccounts) ? uniqueAccounts : []).map(a => a?.name || a).filter(Boolean).sort(),
    [uniqueAccounts]);

  const availCats = useMemo(() => {
    const wantType = form.type === 'Income' ? 'Income' : 'Expense';
    return Object.entries(categories || {})
      .filter(([, d]) => (d?.type || 'Expense') === wantType)
      .map(([n]) => n).sort();
  }, [categories, form.type]);

  const availSubs = useMemo(() =>
    (categories?.[form.category]?.subcategories || []).filter(s => s && s !== 'Default').sort(),
    [categories, form.category]);

  const handleNoteChange = (v) => {
    set('note', v);
    if (v.trim().length > 0) {
      const q = v.toLowerCase(), seen = new Set();
      const sugs = transactions.map(t => t.Note).filter(n => { if (!n || seen.has(n) || !n.toLowerCase().includes(q)) return false; seen.add(n); return true; }).slice(0, 6);
      setNoteSugs(sugs);
    } else setNoteSugs([]);
  };

  const validate = () => {
    const e = {};
    if (!form.amount || isNaN(parseFloat(form.amount)) || parseFloat(form.amount) < 0) e.amount = 'Enter a valid amount';
    if (!form.date) e.date = 'Required';
    if (isTransfer) {
      if (!form.fromAccount) e.fromAccount = 'Select from account';
      if (!form.toAccount)   e.toAccount   = 'Select to account';
      if (form.fromAccount && form.fromAccount === form.toAccount) e.toAccount = 'Must differ from From';
    } else {
      if (!form.account)  e.account  = 'Select account';
      if (!form.category) e.category = 'Select category';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async (shouldContinue = false) => {
    if (!validate() || saving) return;
    setSaving(true);
    try {
      const data = {
        Date:             inputToStorage(form.date),
        Time:             form.time || '',
        Account:          isTransfer ? form.fromAccount : form.account,
        FromAccount:      isTransfer ? form.fromAccount : '',
        ToAccount:        isTransfer ? form.toAccount   : '',
        Category:         isTransfer ? 'Transfer'       : form.category,
        Subcategory:      form.subcategory || 'Default',
        Note:             form.note || '',
        Description:      form.description || '',
        INR:              parseFloat(form.amount) || 0,
        Amount:           form.amount,
        Currency:         'INR',
        'Income/Expense': form.type,
      };
      if (isEdit) await updateTransaction(editTransaction._id, data);
      else        await addTransaction(data);
      
      if (shouldContinue && onSaveAndContinue) {
        onSaveAndContinue();
      } else {
        onClose();
      }
    } finally { setSaving(false); }
  };

  return (
    <>
      <div className="fullscreen-overlay" onClick={onClose}/>
      <div className="fullscreen-modal" data-type={form.type}>
        {/* Header */}
        <div className="add-hdr">
          <div className="add-title">{isEdit ? 'Edit' : 'Add'}</div>
          <button className="add-close" onClick={onClose}>✕</button>
        </div>

        {/* Type tabs */}
        <div className="type-tabs">
          {TYPES.map(tp => (
            <button key={tp.id}
              className={`type-tab ${tp.cls} ${form.type === tp.id ? 'active' : ''}`}
              onClick={() => set('type', tp.id)}>
              {tp.label}
            </button>
          ))}
        </div>

        {/* Amount */}
        <div className="amount-row">
          <span className="amount-prefix">₹</span>
          <input
            className={`form-input-amount ${errors.amount ? 'err' : ''}`}
            type="number" inputMode="decimal"
            value={form.amount}
            onChange={e => set('amount', e.target.value)}
            autoFocus={!isEdit}/>
        </div>
        {errors.amount && <div className="field-error" style={{padding:'0 var(--page-px) 2px'}}>{errors.amount}</div>}

        {/* Scrollable form body */}
        <div className="add-form">
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

          {isTransfer ? (
            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">From Account</label>
                <select className={`form-input ${errors.fromAccount?'err':''}`} value={form.fromAccount} onChange={e=>set('fromAccount',e.target.value)}>
                  <option value="">Select</option>
                  {accountList.map(a=><option key={a}>{a}</option>)}
                </select>
                {errors.fromAccount&&<div className="field-error">{errors.fromAccount}</div>}
              </div>
              <div className="form-group">
                <label className="form-label">To Account</label>
                <select className={`form-input ${errors.toAccount?'err':''}`} value={form.toAccount} onChange={e=>set('toAccount',e.target.value)}>
                  <option value="">Select</option>
                  {accountList.filter(a=>a!==form.fromAccount).map(a=><option key={a}>{a}</option>)}
                </select>
                {errors.toAccount&&<div className="field-error">{errors.toAccount}</div>}
              </div>
            </div>
          ) : (
            <div className="form-group">
              <label className="form-label">Account</label>
              <select className={`form-input ${errors.account?'err':''}`} value={form.account} onChange={e=>set('account',e.target.value)}>
                <option value="">Select account</option>
                {accountList.map(a=><option key={a}>{a}</option>)}
              </select>
              {errors.account&&<div className="field-error">{errors.account}</div>}
            </div>
          )}

          {!isTransfer && (
            <div className="grid-2">
              <div className="form-group">
                <label className="form-label">Category</label>
                <select className={`form-input ${errors.category?'err':''}`} value={form.category} onChange={e=>set('category',e.target.value)}>
                  <option value="">Select category</option>
                  {availCats.map(c=><option key={c}>{c}</option>)}
                </select>
                {errors.category&&<div className="field-error">{errors.category}</div>}
              </div>
              <div className="form-group">
                <label className="form-label">Subcategory</label>
                <select className="form-input" value={form.subcategory} onChange={e=>set('subcategory',e.target.value)} disabled={!availSubs.length}>
                  <option value="">None</option>
                  {availSubs.map(s=><option key={s}>{s}</option>)}
                </select>
              </div>
            </div>
          )}

          <div className="form-group" style={{position:'relative'}}>
            <label className="form-label">Note</label>
            <input className="form-input" type="text" value={form.note}
              onChange={e=>handleNoteChange(e.target.value)}
              onBlur={()=>setTimeout(()=>setNoteSugs([]),180)}/>
            {noteSugs.length > 0 && (
              <div className="note-sug-list">
                {noteSugs.map(s=><div key={s} className="note-sug-item" onMouseDown={()=>{set('note',s);setNoteSugs([]);}}>{s}</div>)}
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">Description</label>
            <textarea className="form-input" rows={3} value={form.description} onChange={e=>set('description',e.target.value)}/>
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
          <div style={{height:16}}/>
        </div>
      </div>
    </>
  );
}