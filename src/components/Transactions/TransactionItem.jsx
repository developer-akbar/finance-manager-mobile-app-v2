import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, formatTime, formatDate, txnType, txnAmount, toInputDate, inputToStorage } from '../../utils/format.js';
import AddTransaction from './AddTransaction.jsx';
import './TransactionItem.css';

// ── Shared TXN row (used across screens) ────────────────────────────────────
export default function TransactionItem({ transaction: t, selected, onLongPress, onTap, showDate = false, overrideType, backInterceptRef }) {
  const [showDetail, setShowDetail] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const pressTimer = React.useRef(null);
  const handlerRef = React.useRef(null);
  const prevHandlerRef = React.useRef(null);

  const baseType = txnType(t);
  const type     = overrideType || baseType;
  const amount   = txnAmount(t);
  const cls      = type === 'income' ? 'income' : type === 'expense' ? 'expense' : 'transfer';
  const sign     = type === 'income' ? '+' : type === 'expense' ? '−' : '';
  const isTransfer = baseType === 'transfer';
  const label    = isTransfer
    ? `${t.Account || t.FromAccount || '—'} → ${t.ToAccount || '—'}`
    : (t.Note || t.Category || '—');
  const subLabel = !isTransfer ? (t.Category || '') : '';
  const hasAccount = !isTransfer && t.Account;

  const closeDetail = () => {
    setShowEdit(false);
    setShowDetail(false);
  };

  React.useEffect(() => {
    if (!backInterceptRef) return;
    if (showDetail || showEdit) {
      const handler = () => closeDetail();
      handlerRef.current = handler;
      prevHandlerRef.current = backInterceptRef.current;
      backInterceptRef.current = handler;
      return () => {
        if (backInterceptRef.current === handler) backInterceptRef.current = prevHandlerRef.current;
        handlerRef.current = null;
        prevHandlerRef.current = null;
      };
    }
    return undefined;
  }, [showDetail, showEdit, backInterceptRef]);

  const handlePressStart = () => {
    if (onLongPress) pressTimer.current = setTimeout(() => onLongPress(t), 500);
  };
  const handlePressEnd = () => { if (pressTimer.current) clearTimeout(pressTimer.current); };

  const handleTap = () => {
    if (onTap) { onTap(t); return; }
    setShowDetail(true);
  };

  return (
    <>
      <div
        className={`txn-item ${selected ? 'selected-item' : ''}`}
        onClick={handleTap}
        onMouseDown={handlePressStart} onMouseUp={handlePressEnd}
        onTouchStart={handlePressStart} onTouchEnd={handlePressEnd}
      >
        {/* Colored dot */}
        <div className={`txn-dot txn-dot-${cls}`}/>
        {/* Content */}
        <div className="txn-mid">
          <div className="txn-note-l">{label}</div>
          <div className="txn-sub-l">
            {t.Time && <span className="txn-time-tag txn-time-first">{formatTime(t.Time)}</span>}
            {showDate && t.Date && <span className="txn-time-tag" style={{color:'var(--text-muted)'}}>{formatDate(t.Date,'short')}</span>}
            {subLabel && <span className="txn-cat-tag">{subLabel}</span>}
            {t.Subcategory && t.Subcategory !== 'Default' && t.Subcategory !== subLabel && <span className="txn-cat-tag">{t.Subcategory}</span>}
            {hasAccount && <span className="txn-time-tag">{t.Account}</span>}
          </div>
        </div>
        {/* Amount */}
        <div className={`txn-amt-col ${cls}`}>{sign}{formatINR(amount)}</div>
      </div>

      {showDetail && <DetailSheet t={t} onClose={() => setShowDetail(false)}/>}
    </>
  );
}

// ── Detail + Edit sheet ──────────────────────────────────────────────────────
function DetailSheet({ t, onClose }) {
  const { deleteTransaction } = useApp();
  const [showEdit,   setShowEdit]   = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  const type   = txnType(t);
  const amount = txnAmount(t);
  const cls    = type === 'income' ? 'income' : type === 'expense' ? 'expense' : 'transfer';
  const sign   = type === 'income' ? '+' : type === 'expense' ? '−' : '';
  const isXfer = type === 'transfer';

  if (showEdit) return <AddTransaction editTransaction={t} onClose={onClose}/>;

  return (
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="bottom-sheet dp-sheet">
        <div className="sheet-handle"/>
        {/* Hero */}
        <div className="dp-hero" onClick={() => setShowEdit(true)} style={{cursor:'pointer'}}>
          <div className={`dp-amount ${cls}`}>{sign}{formatINR(amount)}</div>
          <div className="dp-badge" style={{
            background: type==='income'?'var(--income-bg)':type==='expense'?'var(--expense-bg)':'var(--transfer-bg)',
            color: type==='income'?'var(--income)':type==='expense'?'var(--expense)':'var(--transfer)',
          }}>{t['Income/Expense'] || type}</div>
        </div>
        {/* Fields */}
        <div className="dp-fields" onClick={() => setShowEdit(true)} style={{cursor:'pointer'}}>
          <DPRow label="Date"    value={formatDate(t.Date,'short')}/>
          {t.Time && <DPRow label="Time"    value={formatTime(t.Time)}/>}
          {isXfer ? <>
            <DPRow label="From"  value={t.Account || t.FromAccount || '—'}/>
            <DPRow label="To"    value={t.ToAccount || '—'}/>
          </> : <>
            <DPRow label="Account"     value={t.Account || '—'}/>
            <DPRow label="Category"    value={t.Category || '—'}/>
            {t.Subcategory && t.Subcategory !== 'Default' && <DPRow label="Subcategory" value={t.Subcategory}/>}
          </>}
          {t.Note        && <DPRow label="Note"        value={t.Note}/>}
          {t.Description && <DPRow label="Description" value={t.Description}/>}
        </div>
        {/* Actions */}
        <div className="dp-actions">
          <button className="btn btn-ghost"     onClick={onClose}>Close</button>
          <button className="btn btn-secondary" onClick={() => setShowEdit(true)}>✏️ Edit</button>
          <button className="btn btn-danger"    onClick={() => setShowDelete(true)}>🗑 Delete</button>
        </div>
        {/* Delete confirm */}
        {showDelete && (
          <div className="dp-delete-confirm">
            <div style={{fontSize:'2rem',marginBottom:10}}>🗑️</div>
            <div style={{fontSize:'0.95rem',fontWeight:800,marginBottom:6}}>Delete this transaction?</div>
            <div style={{fontSize:'0.75rem',color:'var(--text-muted)',marginBottom:18,textAlign:'center'}}>
              {t.Category} · {sign}{formatINR(amount)}<br/>
              <span style={{fontSize:'0.68rem'}}>{formatDate(t.Date,'short')}{t.Note ? ` · ${t.Note}` : ''}</span>
            </div>
            <div style={{display:'flex',gap:10,width:'100%'}}>
              <button className="btn btn-ghost btn-full"  onClick={() => setShowDelete(false)}>Cancel</button>
              <button className="btn btn-danger btn-full" onClick={async () => { await deleteTransaction(t._id); onClose(); }}>Delete</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function DPRow({ label, value }) {
  return (
    <div className="dp-row">
      <div className="dp-row-label">{label}</div>
      <div className="dp-row-value">{value}</div>
    </div>
  );
}
