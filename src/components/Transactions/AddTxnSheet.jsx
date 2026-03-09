import React, { useState, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { dateForInput, inputToDate, todayISO } from '../../utils/format.js';
import './TxnSheet.css';

const TYPES = ['Expense', 'Income', 'Transfer-Out'];

export default function AddTxnSheet({ onClose, prefillDate = '' }) {
  const { addTransaction, accountNames, state, toast } = useApp();
  const { categories } = state;

  const [type,    setType]    = useState('Expense');
  const [date,    setDate]    = useState(prefillDate || todayISO());
  const [amount,  setAmount]  = useState('');
  const [account, setAccount] = useState(accountNames[0] || '');
  const [fromAcc, setFromAcc] = useState(accountNames[0] || '');
  const [toAcc,   setToAcc]   = useState(accountNames[1] || '');
  const [cat,     setCat]     = useState('');
  const [subcat,  setSubcat]  = useState('');
  const [note,    setNote]    = useState('');
  const [desc,    setDesc]    = useState('');
  const [saving,  setSaving]  = useState(false);
  const [errors,  setErrors]  = useState({});

  const filteredCats = categories.filter(c => c.type === type);
  const subs = filteredCats.find(c => c.name === cat)?.subcategories || [];

  useEffect(() => { setCat(''); setSubcat(''); }, [type]);
  useEffect(() => { setSubcat(''); }, [cat]);

  const validate = () => {
    const e = {};
    if (!amount || parseFloat(amount) < 0) e.amount = 'Enter a valid amount';
    if (type === 'Transfer-Out') {
      if (!fromAcc) e.fromAcc = 'Required';
      if (!toAcc)   e.toAcc   = 'Required';
      if (fromAcc === toAcc) e.toAcc = 'Must differ from From Account';
    } else {
      if (!account) e.account = 'Required';
      if (!cat)     e.cat     = 'Required';
    }
    setErrors(e);
    return !Object.keys(e).length;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      await addTransaction({
        Date:           inputToDate(date),
        'Income/Expense': type,
        Amount:         amount,
        INR:            parseFloat(amount),
        Account:        type === 'Transfer-Out' ? fromAcc : account,
        FromAccount:    type === 'Transfer-Out' ? fromAcc : '',
        ToAccount:      type === 'Transfer-Out' ? toAcc   : '',
        Category:       cat,
        Subcategory:    subcat,
        Note:           note,
        Description:    desc,
        Currency:       'INR',
      });
      toast('Transaction added ✓');
      onClose();
    } catch (e) {
      toast(e.message || 'Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sheet-overlay" onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <div className="sheet-body">
        <div className="sheet-handle" />
        <div className="txn-sheet-title">New Transaction</div>

        {/* Type tabs */}
        <div className="txn-type-tabs">
          {TYPES.map(t => (
            <button key={t} className={`txn-type-tab ${type===t?'active':''} ${t.toLowerCase().replace('-out','')}`}
              onClick={() => setType(t)}>
              {t === 'Transfer-Out' ? 'Transfer' : t}
            </button>
          ))}
        </div>

        {/* Amount */}
        <div className="txn-amount-row">
          <span className="txn-currency">₹</span>
          <input className="txn-amount-input" type="number" inputMode="decimal"
            placeholder="0" value={amount} onChange={e => setAmount(e.target.value)} autoFocus />
        </div>
        {errors.amount && <div className="txn-error">{errors.amount}</div>}

        {/* Date */}
        <div className="form-group-row">
          <div className="form-group-item">
            <label className="form-label">Date</label>
            <input className="form-control" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          {type !== 'Transfer-Out' ? (
            <div className="form-group-item">
              <label className="form-label">Account</label>
              <select className="form-control" value={account} onChange={e => setAccount(e.target.value)}>
                <option value="">Select…</option>
                {accountNames.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              {errors.account && <div className="txn-error">{errors.account}</div>}
            </div>
          ) : (
            <div className="form-group-item" />
          )}
        </div>

        {/* Transfer accounts */}
        {type === 'Transfer-Out' && (
          <div className="form-group-row">
            <div className="form-group-item">
              <label className="form-label">From</label>
              <select className="form-control" value={fromAcc} onChange={e => setFromAcc(e.target.value)}>
                <option value="">Select…</option>
                {accountNames.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              {errors.fromAcc && <div className="txn-error">{errors.fromAcc}</div>}
            </div>
            <div className="form-group-item">
              <label className="form-label">To</label>
              <select className="form-control" value={toAcc} onChange={e => setToAcc(e.target.value)}>
                <option value="">Select…</option>
                {accountNames.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              {errors.toAcc && <div className="txn-error">{errors.toAcc}</div>}
            </div>
          </div>
        )}

        {/* Category + Subcategory */}
        {type !== 'Transfer-Out' && (
          <div className="form-group-row">
            <div className="form-group-item">
              <label className="form-label">Category</label>
              <select className="form-control" value={cat} onChange={e => setCat(e.target.value)}>
                <option value="">Select…</option>
                {filteredCats.map(c => <option key={c.id} value={c.name}>{c.icon} {c.name}</option>)}
              </select>
              {errors.cat && <div className="txn-error">{errors.cat}</div>}
            </div>
            <div className="form-group-item">
              <label className="form-label">Subcategory</label>
              <select className="form-control" value={subcat} onChange={e => setSubcat(e.target.value)} disabled={!subs.length}>
                <option value="">None</option>
                {subs.map(s => <option key={s.id||s.name} value={s.name}>{s.name}</option>)}
              </select>
            </div>
          </div>
        )}

        {/* Note */}
        <div>
          <label className="form-label">Note</label>
          <input className="form-control" type="text" placeholder="What was this for?" value={note} onChange={e => setNote(e.target.value)} />
        </div>

        {/* Save */}
        <button className="btn btn-primary btn-full btn-lg" style={{marginTop:20}} onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Transaction'}
        </button>
        <button className="btn btn-ghost btn-full" style={{marginTop:10}} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
