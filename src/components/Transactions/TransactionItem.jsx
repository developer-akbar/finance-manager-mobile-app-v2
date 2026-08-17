import React, { useState } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, formatTime, formatDate, txnType, txnAmount, toInputDate, inputToStorage, calculateAge } from '../../utils/format.js';
import { parseInstalmentInfo, getInstalmentSeriesStats } from '../../database/recurring.js';
import AddTransaction from './AddTransaction.jsx';
import ReceiptViewer from '../Common/ReceiptViewer.jsx';
import './TransactionItem.css';

// ── Shared TXN row (used across screens) ────────────────────────────────────
export default function TransactionItem({ transaction: t, selected, onLongPress, onTap, showDate = false, overrideType, backInterceptRef, onCopy, runningBalance = null, isNewestInGroup = false }) {
  const { state } = useApp();
  const [showDetail, setShowDetail] = useState(false);
  const [isClosingDetail, setIsClosingDetail] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const pressTimer = React.useRef(null);
  const handlerRef = React.useRef(null);
  const prevHandlerRef = React.useRef(null);
  const startPos = React.useRef(null);

  const accountEntries = state.accounts || [];
  const isInvestmentAccount = (name) => {
    if (!name) return false;
    const acct = accountEntries.find(a => a.name.toLowerCase() === name.toLowerCase());
    return acct?.group?.toLowerCase() === 'investments';
  };

  const isInvested = isInvestmentAccount(t.Account) || isInvestmentAccount(t.FromAccount) || isInvestmentAccount(t.ToAccount);
  const isRedeemed = (t.Tags || t.tags || t.Note || t.Description || '').toLowerCase().includes('redeemed');
  const ageStr = isInvested && !isRedeemed ? calculateAge(t.Date, t.Time) : null;

  const baseType = txnType(t);
  const type     = overrideType || baseType;
  const amount   = txnAmount(t);
  const cls      = type === 'income' ? 'income' : type === 'expense' ? 'expense' : 'transfer';
  const sign     = type === 'income' ? '+' : type === 'expense' ? '−' : '';
  const isTransfer = baseType === 'transfer';
  const label    = isTransfer
    ? (t.Note || `${t.Account || t.FromAccount || '—'} → ${t.ToAccount || '—'}`)
    : (t.Note || t.Category || '—');
  const subLabel = !isTransfer ? (t.Category || '') : '';
  const hasAccount = !isTransfer && t.Account;
  const xferAccountLabel = isTransfer && t.Note ? `${t.Account || t.FromAccount || '—'} → ${t.ToAccount || '—'}` : '';

  const closeDetail = () => {
    if (showEdit) {
      setShowEdit(false);
    } else {
      setIsClosingDetail(true);
      setTimeout(() => {
        setShowDetail(false);
        setIsClosingDetail(false);
      }, 200);
    }
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

  const handlePressStart = (e) => {
    if (onLongPress) {
      pressTimer.current = setTimeout(() => onLongPress(t), 500);
      // Track initial position for movement detection
      if (e.touches && e.touches[0]) {
        startPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else {
        startPos.current = { x: e.clientX, y: e.clientY };
      }
    }
  };
  const handlePressEnd = () => { 
    if (pressTimer.current) clearTimeout(pressTimer.current);
    startPos.current = null;
  };
  const handlePressMove = (e) => {
    if (!pressTimer.current || !startPos.current) return;
    
    // Calculate movement distance
    let currentX, currentY;
    if (e.touches && e.touches[0]) {
      currentX = e.touches[0].clientX;
      currentY = e.touches[0].clientY;
    } else {
      currentX = e.clientX;
      currentY = e.clientY;
    }
    
    const deltaX = Math.abs(currentX - startPos.current.x);
    const deltaY = Math.abs(currentY - startPos.current.y);
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    // Cancel timer if moved more than 10 pixels (tolerance for slight finger movement)
    if (distance > 10) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
      startPos.current = null;
    }
  };

  const handleTap = () => {
    if (onTap) { onTap(t); return; }
    setShowDetail(true);
  };

  return (
    <>
      <div
        className={`txn-item ${selected ? 'selected-item' : ''}`}
        onClick={handleTap}
        onMouseDown={handlePressStart} onMouseUp={handlePressEnd} onMouseMove={handlePressMove}
        onTouchStart={handlePressStart} onTouchEnd={handlePressEnd} onTouchMove={handlePressMove}
      >
        {/* Colored dot */}
        <div className={`txn-dot txn-dot-${cls}`}/>
        {/* Content */}
        <div className="txn-mid">
          <div className="txn-note-l">
            {label}
            {t.receipt_image && <span style={{ marginLeft: 6, fontSize: '0.72rem' }}>🧾</span>}
            {t.warranty_expiry && <span style={{ marginLeft: 4, fontSize: '0.72rem' }}>🛡️</span>}
            {ageStr && (
              <span 
                className="txn-age-text" 
                style={{ 
                  marginLeft: 8, 
                  fontSize: '0.7rem', 
                  color: 'var(--text-muted)', 
                  fontWeight: 'normal',
                  whiteSpace: 'nowrap'
                }}
              >
                ({ageStr})
              </span>
            )}
          </div>
          <div className="txn-sub-l">
            {t.Time && <span className="txn-time-tag txn-time-first">{formatTime(t.Time)}</span>}
            {showDate && t.Date && <span className="txn-time-tag" style={{color:'var(--text-muted)'}}>{formatDate(t.Date,'short')}</span>}
            {subLabel && <span className="txn-cat-tag">{subLabel}</span>}
            {t.Subcategory && t.Subcategory !== 'Default' && t.Subcategory !== subLabel && <span className="txn-cat-tag">{t.Subcategory}</span>}
            {hasAccount && <span className="txn-time-tag">{t.Account}</span>}
            {xferAccountLabel && <span className="txn-time-tag">{xferAccountLabel}</span>}
          </div>
        </div>
        {/* Amount + running balance */}
        <div className="txn-amt-wrap">
          <div className={`txn-amt-col ${cls}`}>{sign}{formatINR(amount)}</div>
          {runningBalance !== null && (
            <div className="txn-running-bal">
              {isNewestInGroup
                ? `(Balance ${runningBalance < 0 ? '−' : ''}${formatINR(Math.abs(runningBalance))})`
                : `(${runningBalance < 0 ? '−' : ''}${formatINR(Math.abs(runningBalance))})`
              }
            </div>
          )}
        </div>
      </div>

      {showDetail && <DetailSheet t={t} onClose={closeDetail} onCopy={onCopy} backInterceptRef={backInterceptRef} isClosing={isClosingDetail}/>}
    </>
  );
}

// ── Detail + Edit sheet ──────────────────────────────────────────────────────
function DetailSheet({ t, onClose, onCopy, backInterceptRef, isClosing }) {
  const { deleteTransaction, updateInstalmentSiblings, updateInstalmentAmount, deleteAllInstalments, state } = useApp();
  const [showEdit,       setShowEdit]       = useState(false);
  const [showDelete,     setShowDelete]     = useState(false);
  const [showCopyPicker, setShowCopyPicker] = useState(false);
  const [showDebug,      setShowDebug]      = useState(false);
  const [viewingReceipt, setViewingReceipt] = useState(false);

  const type   = txnType(t);
  const amount = txnAmount(t);
  const cls    = type === 'income' ? 'income' : type === 'expense' ? 'expense' : 'transfer';
  const sign   = type === 'income' ? '+' : type === 'expense' ? '−' : '';
  const isXfer = type === 'transfer';

  // Instalment detection: use note pattern AND recurring_rule_id
  const ruleId      = t.recurring_rule_id;
  const instInfo    = parseInstalmentInfo(t.Note);
  const partLabel   = instInfo ? `${instInfo.part}/${instInfo.total}` : (t.Note || '').match(/\((\d+\/\d+)\)\s*$/)?.[1] || null;
  const ruleEntry   = ruleId ? (state.recurringRules || []).find(r => r.id === ruleId) : null;
  const isInstalment = !!(instInfo || partLabel || (ruleEntry?.rule_type === 'instalment'));
  const isRepeat     = ruleEntry?.rule_type === 'repeat';

  const accountEntries = state.accounts || [];
  const isInvestmentAccount = (name) => {
    if (!name) return false;
    const acct = accountEntries.find(a => a.name.toLowerCase() === name.toLowerCase());
    return acct?.group?.toLowerCase() === 'investments';
  };
  const isInvested = isInvestmentAccount(t.Account) || isInvestmentAccount(t.FromAccount) || isInvestmentAccount(t.ToAccount);
  const isRedeemed = (t.Tags || t.tags || t.Note || t.Description || '').toLowerCase().includes('redeemed');
  const ageStr = isInvested && !isRedeemed ? calculateAge(t.Date) : null;

  // Compute instalment series stats (Total amount, Remaining Balance)
  const instalmentStats = React.useMemo(() => {
    if (!isInstalment) return null;
    return getInstalmentSeriesStats(t, state.transactions);
  }, [isInstalment, t, state.transactions]);

  const handleCopyWithToday = () => {
    const now = new Date();
    const pad = n => String(n).padStart(2,'0');
    onCopy({ ...t,
      Date: `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`,
      Time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    });
    onClose();
  };
  const handleCopyWithOriginal = () => {
    onCopy(t);
    onClose();
  };

  if (showEdit) return (
    <AddTransaction
      editTransaction={t}
      onClose={onClose}
      backInterceptRef={backInterceptRef}
    />
  );

  return (
    <>
      <div className={`overlay ${isClosing ? 'closing' : ''}`} onClick={onClose}/>
      <div className={`bottom-sheet dp-sheet ${isClosing ? 'closing' : ''}`}>
        <div className="sheet-handle"/>
        
        {/* Debug Button */}
        <button type="button" onClick={() => setShowDebug(p => !p)} style={{
          position: 'absolute',
          right: 16,
          top: 14,
          background: 'none',
          border: 'none',
          color: showDebug ? 'var(--green)' : 'var(--text-muted)',
          cursor: 'pointer',
          fontSize: '1.1rem',
          padding: '6px',
          zIndex: 10,
          transition: 'color 0.15s ease',
        }} title="Toggle Debug Info">
          🐞
        </button>

        {/* Hero */}
        <div className="dp-hero" onClick={() => setShowEdit(true)} style={{cursor:'pointer'}}>
          <div className={`dp-amount ${cls}`}>{sign}{formatINR(amount)}</div>
          <div style={{display:'flex',gap:6,alignItems:'center',justifyContent:'center',flexWrap:'wrap'}}>
            <div className="dp-badge" style={{
              background: type==='income'?'var(--income-bg)':type==='expense'?'var(--expense-bg)':'var(--transfer-bg)',
              color: type==='income'?'var(--income)':type==='expense'?'var(--expense)':'var(--transfer)',
            }}>{t['Income/Expense'] || type}</div>
            {isInstalment && partLabel && (
              <div className="dp-badge" style={{background:'rgba(99,179,237,0.15)',color:'#63b3ed'}}>
                📋 Instalment {partLabel}
              </div>
            )}
            {isInstalment && instalmentStats && (
              <>
                <div className="dp-badge" style={{background:'rgba(0,229,160,0.15)',color:'var(--accent)'}}>
                  Total: {formatINR(instalmentStats.totalAmount)}
                </div>
                <div className="dp-badge" style={{background:'rgba(255,183,77,0.15)',color:'#ffb74d'}}>
                  Balance: {formatINR(instalmentStats.balanceRemaining)}
                </div>
              </>
            )}
            {isRepeat && (
              <div className="dp-badge" style={{background:'rgba(167,139,250,0.15)',color:'#a78bfa'}}>
                🔁 Repeat
              </div>
            )}
          </div>
        </div>
        {/* Fields */}
        <div className="dp-fields" onClick={() => setShowEdit(true)} style={{cursor:'pointer'}}>
          <DPRow label="Date"    value={formatDate(t.Date,'short')}/>
          {t.Time && <DPRow label="Time"    value={formatTime(t.Time)}/>}
          {ageStr && <DPRow label="Age" value={ageStr}/>}
          {isInvested && isRedeemed && <DPRow label="Portfolio Status" value="Redeemed (Inactive)"/>}
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
          {t.Tags        && <DPRow label="Tags"        value={t.Tags}/>}
          {isInstalment && instalmentStats && (
            <DPRow 
              label="Instalment Info" 
              value={`Part ${instalmentStats.part} of ${instalmentStats.totalParts} (Total: ${formatINR(instalmentStats.totalAmount)} · Bal: ${formatINR(instalmentStats.balanceRemaining)})`}
            />
          )}
          {t.serial_no   && <DPRow label="Invoice/SN"   value={t.serial_no}/>}
          {t.warranty_expiry && (
            <DPRow
              label="Warranty"
              value={`Until ${t.warranty_expiry} ${new Date(t.warranty_expiry) < new Date() ? '(Expired)' : '(Active)'}`}
            />
          )}
        </div>

        {/* Receipt Attachment Preview inside Detail Sheet */}
        {t.receipt_image && (
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 10, marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img
                src={t.receipt_image}
                alt="Receipt"
                onClick={() => setViewingReceipt(true)}
                style={{ width: 42, height: 42, objectFit: 'cover', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)' }}
              />
              <div>
                <div style={{ fontSize: '0.78rem', fontWeight: 700 }}>🧾 Attached Receipt</div>
                <div style={{ fontSize: '0.65rem', color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setViewingReceipt(true)}>
                  Tap to view / download
                </div>
              </div>
            </div>
            <button
              onClick={() => setViewingReceipt(true)}
              style={{
                background: 'rgba(0, 229, 160, 0.15)', border: '1px solid var(--accent)',
                color: 'var(--accent)', padding: '4px 10px', borderRadius: 8, fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer'
              }}
            >
              Zoom Bill
            </button>
          </div>
        )}

        {viewingReceipt && t.receipt_image && (
          <ReceiptViewer
            receiptUrl={t.receipt_image}
            title={t.Note || t.Category || 'Receipt Bill'}
            onClose={() => setViewingReceipt(false)}
          />
        )}

        {/* Debug Metadata Panel */}
        {showDebug && (
          <div className="dp-debug-section" style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            padding: '10px 14px',
            marginBottom: '12px',
            fontSize: '0.72rem',
            fontFamily: 'monospace',
            color: 'var(--text-secondary)',
            textAlign: 'left',
            lineHeight: 1.5
          }}>
            <div style={{fontWeight:800, color:'var(--green)', marginBottom:6, textTransform:'uppercase', letterSpacing:0.5, fontSize:'0.65rem'}}>🔍 Developer Debug Info</div>
            <div style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}><strong>Txn ID:</strong> {t._id || t.ID}</div>
            <div><strong>Created At:</strong> {t.created_at ? new Date(t.created_at).toLocaleString('en-IN') : '—'}</div>
            <div><strong>Last Modified:</strong> {t.updated_at ? new Date(t.updated_at).toLocaleString('en-IN') : '—'}</div>
            {t.recurring_rule_id && <div style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}><strong>Recurring Rule ID:</strong> {t.recurring_rule_id}</div>}
            <div><strong>Raw INR Value:</strong> {t.INR}</div>
            <div><strong>Currency:</strong> {t.Currency}</div>
            <div><strong>Original Type:</strong> {t['Income/Expense']}</div>
          </div>
        )}

        {/* Actions */}
        <div className="dp-actions" style={{ display: 'flex', gap: '10px' }}>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowEdit(true)}>✏️ Edit</button>
          {onCopy && <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCopyPicker(true)}>📋 Copy</button>}
          <button className="btn btn-danger" style={{ flex: 1 }} onClick={() => setShowDelete(true)}>🗑 Delete</button>
        </div>
        {/* Copy date picker popup */}
        {showCopyPicker && onCopy && (
          <div className="dp-delete-confirm">
            <div style={{fontSize:'1.4rem',marginBottom:8}}>📋</div>
            <div style={{fontSize:'0.95rem',fontWeight:800,marginBottom:6}}>Copy transaction as</div>
            <div style={{fontSize:'0.73rem',color:'var(--text-muted)',marginBottom:18,textAlign:'center'}}>
              Choose the date and time for the copied transaction
            </div>
            <button className="btn btn-primary btn-full" style={{marginBottom:10}} onClick={handleCopyWithToday}>
              Today's date &amp; time
              <div style={{fontSize:'0.65rem',fontWeight:400,opacity:0.75,marginTop:2}}>
                {new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})} · {new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true})}
              </div>
            </button>
            <button className="btn btn-secondary btn-full" style={{marginBottom:10}} onClick={handleCopyWithOriginal}>
              Original date &amp; time
              <div style={{fontSize:'0.65rem',fontWeight:400,opacity:0.75,marginTop:2}}>
                {t.Date ? t.Date.split('-').reverse().join('/') : ''}{t.Time ? ' · '+t.Time : ''}
              </div>
            </button>
            <button className="btn btn-ghost btn-full" onClick={() => setShowCopyPicker(false)}>Cancel</button>
          </div>
        )}
        {/* Delete confirm */}
        {showDelete && (
          <div className="dp-delete-confirm">
            <div style={{fontSize:'2rem',marginBottom:10}}>🗑️</div>
            <div style={{fontSize:'0.95rem',fontWeight:800,marginBottom:6}}>
              {isInstalment ? 'Delete instalment?' : 'Delete this transaction?'}
            </div>
            <div style={{fontSize:'0.75rem',color:'var(--text-muted)',marginBottom:18,textAlign:'center'}}>
              {t.Category} · {sign}{formatINR(amount)}<br/>
              <span style={{fontSize:'0.68rem'}}>{formatDate(t.Date,'short')}{t.Note ? ` · ${t.Note}` : ''}</span>
            </div>
            {isInstalment ? (
              <div style={{display:'flex',flexDirection:'column',gap:8,width:'100%'}}>
                <button className="btn btn-ghost btn-full" onClick={() => setShowDelete(false)}>Cancel</button>
                <button className="btn btn-secondary btn-full" onClick={async () => { await deleteTransaction(t._id); onClose(); }}>
                  Delete this instalment only
                </button>
                <button className="btn btn-danger btn-full" onClick={async () => {
                  if (!ruleId) { await deleteTransaction(t._id); onClose(); return; }
                  await deleteAllInstalments(ruleId); onClose();
                }}>
                  🗑 Delete all instalments
                </button>
              </div>
            ) : (
              <div style={{display:'flex',gap:10,width:'100%'}}>
                <button className="btn btn-ghost btn-full"  onClick={() => setShowDelete(false)}>Cancel</button>
                <button className="btn btn-danger btn-full" onClick={async () => { await deleteTransaction(t._id); onClose(); }}>Delete</button>
              </div>
            )}
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