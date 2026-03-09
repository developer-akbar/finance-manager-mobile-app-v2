import React, { useState } from 'react';
import { formatINR, friendlyDate, parseDate } from '../../utils/format.js';
import EditTxnSheet from '../Transactions/EditTxnSheet.jsx';

function typeColor(type) {
  if (type === 'Income')      return 'amt-in';
  if (type === 'Transfer-Out'||type==='Transfer') return 'amt-tr';
  return 'amt-out';
}
function typeSign(type) {
  if (type === 'Income')      return '+';
  if (type === 'Transfer-Out'||type==='Transfer') return '';
  return '-';
}
function typePrefix(type) {
  if (type === 'Income')      return <span style={{fontSize:11,color:'var(--green)'}}>▲ </span>;
  if (type === 'Transfer-Out'||type==='Transfer') return <span style={{fontSize:11,color:'var(--blue)'}}>⇄ </span>;
  return <span style={{fontSize:11,color:'var(--red)'}}>▼ </span>;
}

function TxnRow({ t, onDelete }) {
  const [editing, setEditing] = useState(false);
  const cls = typeColor(t['Income/Expense']);
  const sign = typeSign(t['Income/Expense']);

  return (
    <>
      <div className="txn-row card-pressable" onClick={() => setEditing(true)}>
        <div className="txn-row-left">
          <div className="txn-row-icon">
            {typePrefix(t['Income/Expense'])}
          </div>
          <div className="txn-row-info">
            <div className="txn-row-name">{t.Note || t.Category || '—'}</div>
            <div className="txn-row-sub">
              {[t.Category, t.Subcategory].filter(Boolean).join(' › ')}
              {t.Account ? ` • ${t.Account}` : ''}
            </div>
          </div>
        </div>
        <div className={`txn-row-amt ${cls}`}>
          {sign}{formatINR(t.INR || t.Amount)}
        </div>
      </div>
      {editing && <EditTxnSheet transaction={t} onClose={() => setEditing(false)} onDelete={() => { onDelete && onDelete(t._id); setEditing(false); }} />}
    </>
  );
}

export default function TxnList({ transactions, onDelete, flat = false }) {
  if (!transactions?.length) return (
    <div className="empty-state">
      <div className="empty-icon">💸</div>
      <div className="empty-title">No transactions</div>
      <div className="empty-sub">Tap + to add one</div>
    </div>
  );

  if (flat) {
    return (
      <div className="txn-list-card card">
        {transactions.map(t => <TxnRow key={t._id} t={t} onDelete={onDelete} />)}
      </div>
    );
  }

  // Group by date
  const groups = {};
  for (const t of transactions) {
    const d = t.Date || '';
    if (!groups[d]) groups[d] = [];
    groups[d].push(t);
  }
  const sorted = Object.entries(groups).sort(([a],[b]) => parseDate(b) - parseDate(a));

  return (
    <div className="txn-grouped">
      {sorted.map(([date, txns]) => {
        const dayInc = txns.filter(t=>t['Income/Expense']==='Income').reduce((s,t)=>s+parseFloat(t.INR||t.Amount||0),0);
        const dayExp = txns.filter(t=>t['Income/Expense']==='Expense').reduce((s,t)=>s+parseFloat(t.INR||t.Amount||0),0);
        return (
          <div key={date} className="txn-day-group">
            <div className="txn-day-header">
              <span className="txn-day-label">{friendlyDate(date)}</span>
              <span className="txn-day-totals">
                {dayInc > 0 && <span className="amt-in" style={{fontSize:12}}>+{formatINR(dayInc)}</span>}
                {dayExp > 0 && <span className="amt-out" style={{fontSize:12,marginLeft:8}}>-{formatINR(dayExp)}</span>}
              </span>
            </div>
            <div className="card">
              {txns.map(t => <TxnRow key={t._id} t={t} onDelete={onDelete} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
