import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { dateForInput, inputToDate } from '../../utils/format.js';
import './TxnSheet.css';

export default function EditTxnSheet({ transaction: t, onClose, onDelete }) {
  const { updateTransaction, toast } = useApp();
  const { accountNames, state: { categories } } = useApp();

  const [type,    setType]    = useState(t['Income/Expense'] || 'Expense');
  const [date,    setDate]    = useState(dateForInput(t.Date));
  const [amount,  setAmount]  = useState(String(t.INR || t.Amount || ''));
  const [account, setAccount] = useState(t.Account || '');
  const [fromAcc, setFromAcc] = useState(t.FromAccount || '');
  const [toAcc,   setToAcc]   = useState(t.ToAccount   || '');
  const [cat,     setCat]     = useState(t.Category    || '');
  const [subcat,  setSubcat]  = useState(t.Subcategory || '');
  const [note,    setNote]    = useState(t.Note        || '');
  const [saving,  setSaving]  = useState(false);
  const [confirm, setConfirm] = useState(false);

  const filteredCats = categories.filter(c => c.type === type);
  const subs = filteredCats.find(c => c.name === cat)?.subcategories || [];

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateTransaction(t._id, {
        Date: inputToDate(date), 'Income/Expense': type,
        Amount: amount, INR: parseFloat(amount),
        Account: type === 'Transfer-Out' ? fromAcc : account,
        FromAccount: fromAcc, ToAccount: toAcc,
        Category: cat, Subcategory: subcat,
        Note: note, Description: t.Description || '', Currency: 'INR',
      });
      toast('Transaction updated ✓');
      onClose();
    } catch (e) { toast(e.message||'Failed','error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="sheet-overlay" onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <div className="sheet-body">
        <div className="sheet-handle" />
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
          <div className="txn-sheet-title">Edit Transaction</div>
          <button className="btn btn-danger btn-sm" onClick={() => setConfirm(true)}>Delete</button>
        </div>

        {confirm && (
          <div className="txn-confirm-box">
            <p>Delete this transaction?</p>
            <div style={{display:'flex',gap:10,marginTop:10}}>
              <button className="btn btn-danger btn-sm" onClick={onDelete}>Yes, Delete</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="txn-type-tabs">
          {['Expense','Income','Transfer-Out'].map(tp => (
            <button key={tp} className={`txn-type-tab ${type===tp?'active':''} ${tp.toLowerCase().replace('-out','')}`}
              onClick={() => setType(tp)}>
              {tp === 'Transfer-Out' ? 'Transfer' : tp}
            </button>
          ))}
        </div>

        <div className="txn-amount-row">
          <span className="txn-currency">₹</span>
          <input className="txn-amount-input" type="number" inputMode="decimal"
            value={amount} onChange={e => setAmount(e.target.value)} />
        </div>

        <div className="form-group-row">
          <div className="form-group-item">
            <label className="form-label">Date</label>
            <input className="form-control" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          {type !== 'Transfer-Out' && (
            <div className="form-group-item">
              <label className="form-label">Account</label>
              <select className="form-control" value={account} onChange={e => setAccount(e.target.value)}>
                {accountNames.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          )}
        </div>

        {type === 'Transfer-Out' && (
          <div className="form-group-row">
            <div className="form-group-item">
              <label className="form-label">From</label>
              <select className="form-control" value={fromAcc} onChange={e => setFromAcc(e.target.value)}>
                {accountNames.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div className="form-group-item">
              <label className="form-label">To</label>
              <select className="form-control" value={toAcc} onChange={e => setToAcc(e.target.value)}>
                {accountNames.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          </div>
        )}

        {type !== 'Transfer-Out' && (
          <div className="form-group-row">
            <div className="form-group-item">
              <label className="form-label">Category</label>
              <select className="form-control" value={cat} onChange={e => setCat(e.target.value)}>
                <option value="">None</option>
                {filteredCats.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-group-item">
              <label className="form-label">Subcategory</label>
              <select className="form-control" value={subcat} onChange={e => setSubcat(e.target.value)}>
                <option value="">None</option>
                {subs.map(s => <option key={s.id||s.name} value={s.name}>{s.name}</option>)}
              </select>
            </div>
          </div>
        )}

        <div>
          <label className="form-label">Note</label>
          <input className="form-control" type="text" value={note} onChange={e => setNote(e.target.value)} />
        </div>

        <button className="btn btn-primary btn-full btn-lg" style={{marginTop:20}} onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Update Transaction'}
        </button>
        <button className="btn btn-ghost btn-full" style={{marginTop:10}} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
