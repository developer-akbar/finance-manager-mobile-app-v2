import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, formatINRCompact, parseDate, txnAmount, txnType } from '../../utils/format.js';
import AddTransaction from '../Transactions/AddTransaction.jsx';
import './DebtTracker.css';

export function extractPersonName(rawNote) {
  if (!rawNote) return 'Unspecified';
  let s = rawNote.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
  // Strip directional prefixes
  s = s.replace(/^(to\s*:?|from\s*:?|lend\s*to\s*:?|lend\s*from\s*:?|borrow\s*from\s*:?|given\s*to\s*:?|received\s*from\s*:?|return\s*from\s*:?|repay\s*to\s*:?|paid\s*to\s*:?)\s+/i, '');
  s = s.replace(/\s+(return|settlement|repayment|lent|borrowed|advance)$/i, '');
  s = s.trim();
  if (!s) return 'Unspecified';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function DebtTracker({ onBack, onSettle, backInterceptRef }) {
  const { state } = useApp();
  const { transactions } = state;
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState('pending'); // 'pending' | 'all' | 'settled'
  const [selectedPerson, setSelectedPerson] = useState(null); // for viewing history
  const [modalFilter, setModalFilter] = useState('pending'); // 'pending' | 'all' | 'settled'
  const [editTxn, setEditTxn] = useState(null);

  // Back button interception
  useEffect(() => {
    if (!backInterceptRef) return;
    if (editTxn) {
      backInterceptRef.current = () => setEditTxn(null);
    } else if (selectedPerson) {
      backInterceptRef.current = () => setSelectedPerson(null);
    } else {
      backInterceptRef.current = onBack;
    }
    return () => { if (backInterceptRef) backInterceptRef.current = null; };
  }, [editTxn, selectedPerson, onBack, backInterceptRef]);

  // Extract and calculate FIFO Itemized Debt Ledgers
  const { totalReceivable, totalPayable, personLedgers } = useMemo(() => {
    let rec = 0, pay = 0;
    const ledgerMap = {};

    for (const t of transactions) {
      const acct = (t.Account || t.FromAccount || '').toLowerCase().trim();
      const toAcct = (t.ToAccount || '').toLowerCase().trim();
      const cat = (t.Category || '').toLowerCase().trim();
      const type = (t['Income/Expense'] || 'Expense').toLowerCase().trim();
      const rawNote = t.Note || '';
      const amt = parseFloat(t.INR || t.Amount || 0);

      // A transaction belongs to Debt Tracker ONLY if Account or Category is explicitly Lend or Borrow
      const isLendAccount = acct === 'lend' || toAcct === 'lend' || cat === 'lend';
      const isBorrowAccount = acct === 'borrow' || toAcct === 'borrow' || cat === 'borrow';

      if (!isLendAccount && !isBorrowAccount) continue;

      const personKey = extractPersonName(rawNote);

      if (!ledgerMap[personKey]) {
        ledgerMap[personKey] = {
          name: personKey,
          lent: 0,
          received: 0,
          borrowed: 0,
          repaid: 0,
          txnCount: 0,
          lastDate: t.Date,
          rawTxns: [],
        };
      }

      const p = ledgerMap[personKey];
      p.txnCount += 1;

      if (isLendAccount) {
        // Giving money to someone (Lend Account as destination OR Expense from Lend)
        const isGiving = toAcct === 'lend' || (type === 'expense' && acct === 'lend') || /^(to|lend\s*to|given\s*to)\s+/i.test(rawNote);
        if (isGiving) {
          p.lent += amt;
          rec += amt;
          p.rawTxns.push({ ...t, _role: 'lent', _amt: amt });
        } else {
          // Receiving repayment from someone
          p.received += amt;
          rec -= amt;
          p.rawTxns.push({ ...t, _role: 'received', _amt: amt });
        }
      } else if (isBorrowAccount) {
        // Borrowing money from someone (Borrow Account as source OR Income from Borrow)
        const isBorrowing = acct === 'borrow' || (type === 'income' && acct === 'borrow') || /^(borrow\s*from|from|received\s*from)\s+/i.test(rawNote);
        if (isBorrowing) {
          p.borrowed += amt;
          pay += amt;
          p.rawTxns.push({ ...t, _role: 'borrowed', _amt: amt });
        } else {
          // Repaying money to someone
          p.repaid += amt;
          pay -= amt;
          p.rawTxns.push({ ...t, _role: 'repaid', _amt: amt });
        }
      }
    }

    const list = Object.values(ledgerMap).map(p => {
      const net = (p.lent - p.received) - (p.borrowed - p.repaid);

      // Sort chronologically (oldest first) to run FIFO settlement allocation
      const chronoTxns = [...p.rawTxns].sort((a, b) => parseDate(a.Date) - parseDate(b.Date));

      // 1. Allocate Lend repayments against lent items
      let unallocatedReceived = p.received;
      const processedLendTxns = [];

      for (const item of chronoTxns.filter(x => x._role === 'lent')) {
        if (unallocatedReceived >= item._amt) {
          processedLendTxns.push({
            ...item,
            itemStatus: 'settled',
            pendingAmt: 0,
            paidAmt: item._amt,
          });
          unallocatedReceived -= item._amt;
        } else if (unallocatedReceived > 0) {
          processedLendTxns.push({
            ...item,
            itemStatus: 'partial',
            pendingAmt: Math.round((item._amt - unallocatedReceived) * 100) / 100,
            paidAmt: Math.round(unallocatedReceived * 100) / 100,
          });
          unallocatedReceived = 0;
        } else {
          processedLendTxns.push({
            ...item,
            itemStatus: 'pending',
            pendingAmt: item._amt,
            paidAmt: 0,
          });
        }
      }

      // 2. Allocate Borrow repayments against borrowed items
      let unallocatedMyRepaid = p.repaid;
      const processedBorrowTxns = [];

      for (const item of chronoTxns.filter(x => x._role === 'borrowed')) {
        if (unallocatedMyRepaid >= item._amt) {
          processedBorrowTxns.push({
            ...item,
            itemStatus: 'settled',
            pendingAmt: 0,
            paidAmt: item._amt,
          });
          unallocatedMyRepaid -= item._amt;
        } else if (unallocatedMyRepaid > 0) {
          processedBorrowTxns.push({
            ...item,
            itemStatus: 'partial',
            pendingAmt: Math.round((item._amt - unallocatedMyRepaid) * 100) / 100,
            paidAmt: Math.round(unallocatedMyRepaid * 100) / 100,
          });
          unallocatedMyRepaid = 0;
        } else {
          processedBorrowTxns.push({
            ...item,
            itemStatus: 'pending',
            pendingAmt: item._amt,
            paidAmt: 0,
          });
        }
      }

      // 3. Mark Repayments received & made
      const otherTxns = chronoTxns
        .filter(x => x._role === 'received' || x._role === 'repaid')
        .map(x => ({
          ...x,
          itemStatus: 'repayment',
          pendingAmt: 0,
          paidAmt: x._amt,
        }));

      // Combine and sort newest first for ledger view
      const allProcessedTxns = [...processedLendTxns, ...processedBorrowTxns, ...otherTxns]
        .sort((a, b) => parseDate(b.Date) - parseDate(a.Date));

      const pendingCount = allProcessedTxns.filter(t => t.itemStatus === 'pending' || t.itemStatus === 'partial').length;

      return {
        ...p,
        netBalance: Math.round(net * 100) / 100,
        txns: allProcessedTxns,
        pendingCount,
      };
    }).sort((a, b) => Math.abs(b.netBalance) - Math.abs(a.netBalance));

    return {
      totalReceivable: Math.max(0, rec),
      totalPayable: Math.max(0, pay),
      personLedgers: list,
    };
  }, [transactions]);

  // Keep selectedPerson reference updated when transactions change
  useEffect(() => {
    if (!selectedPerson) return;
    const fresh = personLedgers.find(p => p.name === selectedPerson.name);
    if (fresh) setSelectedPerson(fresh);
  }, [personLedgers]);

  // Filtered persons list
  const filteredPersons = useMemo(() => {
    let res = personLedgers;
    if (search.trim()) {
      const q = search.toLowerCase();
      res = res.filter(p => p.name.toLowerCase().includes(q));
    }
    if (filterMode === 'pending') {
      res = res.filter(p => Math.abs(p.netBalance) >= 1);
    } else if (filterMode === 'settled') {
      res = res.filter(p => Math.abs(p.netBalance) < 1);
    }
    return res;
  }, [personLedgers, search, filterMode]);

  // Filtered transactions inside Person History modal
  const modalFilteredTxns = useMemo(() => {
    if (!selectedPerson) return [];
    if (modalFilter === 'pending') {
      return selectedPerson.txns.filter(t => t.itemStatus === 'pending' || t.itemStatus === 'partial');
    }
    if (modalFilter === 'settled') {
      return selectedPerson.txns.filter(t => t.itemStatus === 'settled' || t.itemStatus === 'repayment');
    }
    return selectedPerson.txns;
  }, [selectedPerson, modalFilter]);

  return (
    <div className="debt-tracker-screen">
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div className="page-hdr-title">Debt &amp; Lending Ledger</div>
      </div>

      <div className="debt-tracker-body">
        {/* Summary Card */}
        <div className="debt-summary-card">
          <div className="debt-summary-row">
            <div className="debt-summary-col">
              <span className="debt-summary-label">Total to Receive</span>
              <span className="debt-summary-val pos">+{formatINR(totalReceivable)}</span>
            </div>
            <div className="debt-summary-divider" />
            <div className="debt-summary-col">
              <span className="debt-summary-label">Total to Repay</span>
              <span className="debt-summary-val neg">−{formatINR(totalPayable)}</span>
            </div>
          </div>
        </div>

        {/* Search & Filter Pills */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            className="form-input"
            style={{ fontSize: '0.82rem', padding: '8px 12px' }}
            placeholder="Search person (e.g. Suri, Ramesh)..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          <div style={{ display: 'flex', gap: 6 }}>
            {['pending', 'all', 'settled'].map(mode => (
              <button
                key={mode}
                onClick={() => setFilterMode(mode)}
                style={{
                  flex: 1,
                  padding: '6px 0',
                  borderRadius: 20,
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  textTransform: 'capitalize',
                  border: filterMode === mode ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                  background: filterMode === mode ? 'rgba(0, 229, 160, 0.15)' : 'var(--bg-card)',
                  color: filterMode === mode ? 'var(--accent)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {mode === 'pending' ? '⏳ Pending' : mode === 'settled' ? '✓ Settled' : 'All Persons'}
              </button>
            ))}
          </div>
        </div>

        {/* Person Cards List */}
        <div className="debt-person-list">
          {filteredPersons.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30, fontSize: '0.85rem' }}>
              {search ? 'No matching persons found.' : filterMode === 'pending' ? 'No pending debt or lending dues! 🎉' : 'No records found.'}
            </div>
          ) : (
            filteredPersons.map(p => {
              const isReceivable = p.netBalance > 0.5;
              const isPayable = p.netBalance < -0.5;
              const isSettled = Math.abs(p.netBalance) < 0.5;

              return (
                <div key={p.name} className="debt-person-card" onClick={() => { setSelectedPerson(p); setModalFilter(p.pendingCount > 0 ? 'pending' : 'all'); }}>
                  <div className="debt-person-top">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '1.2rem' }}>👤</span>
                      <div className="debt-person-name">{p.name}</div>
                    </div>
                    <div className={`debt-person-bal ${isReceivable ? 'pos' : isPayable ? 'neg' : 'zero'}`}>
                      {isReceivable ? `+${formatINR(p.netBalance)} to receive` : isPayable ? `−${formatINR(Math.abs(p.netBalance))} to repay` : 'Settled ✓'}
                    </div>
                  </div>

                  <div className="debt-person-stats">
                    {p.pendingCount > 0 && (
                      <span className="debt-pending-pill">
                        ⏳ {p.pendingCount} unpaid {p.pendingCount === 1 ? 'item' : 'items'}
                      </span>
                    )}
                    {p.lent > 0 && <span>Lent: {formatINRCompact(p.lent)}</span>}
                    {p.received > 0 && <span>Received: {formatINRCompact(p.received)}</span>}
                    {p.borrowed > 0 && <span>Borrowed: {formatINRCompact(p.borrowed)}</span>}
                    {p.repaid > 0 && <span>Repaid: {formatINRCompact(p.repaid)}</span>}
                    <span>• {p.txnCount} txns ›</span>
                  </div>

                  {!isSettled && onSettle && (
                    <button
                      className="debt-settle-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSettle({
                          name: p.name,
                          amount: Math.abs(p.netBalance),
                          type: isReceivable ? 'receive' : 'repay'
                        });
                      }}
                    >
                      🤝 {isReceivable ? 'Record Return' : 'Record Repayment'}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Person Transaction History Modal with Itemized Settlement Tracking */}
      {selectedPerson && (
        <>
          <div className="overlay" onClick={() => setSelectedPerson(null)} />
          <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)', maxHeight: '82dvh', display: 'flex', flexDirection: 'column' }}>
            <div className="sheet-handle" />

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: '1.05rem', fontWeight: 800 }}>👤 {selectedPerson.name}</div>
                <div style={{ fontSize: '0.75rem', color: selectedPerson.netBalance > 0.5 ? 'var(--income)' : selectedPerson.netBalance < -0.5 ? 'var(--expense)' : 'var(--text-muted)', fontWeight: 700, marginTop: 2 }}>
                  {selectedPerson.netBalance > 0.5 ? `Pending to receive: +${formatINR(selectedPerson.netBalance)}` : selectedPerson.netBalance < -0.5 ? `Pending to repay: −${formatINR(Math.abs(selectedPerson.netBalance))}` : 'Account fully settled ✓'}
                </div>
              </div>
              <button
                onClick={() => setSelectedPerson(null)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '1.2rem', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            {/* In-modal filter tabs */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexShrink: 0 }}>
              {[
                { id: 'pending', label: `🔴 Pending (${selectedPerson.pendingCount})` },
                { id: 'all', label: `All (${selectedPerson.txnCount})` },
                { id: 'settled', label: `🟢 Settled (${selectedPerson.txnCount - selectedPerson.pendingCount})` }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setModalFilter(tab.id)}
                  style={{
                    flex: 1,
                    padding: '4px 0',
                    borderRadius: 14,
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    border: modalFilter === tab.id ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                    background: modalFilter === tab.id ? 'rgba(0, 229, 160, 0.15)' : 'var(--bg-card)',
                    color: modalFilter === tab.id ? 'var(--accent)' : 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {modalFilteredTxns.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24, fontSize: '0.78rem' }}>
                  {modalFilter === 'pending' ? 'All items are paid & settled! 🎉' : 'No transactions match filter.'}
                </div>
              ) : (
                modalFilteredTxns.map((t, idx) => {
                  const amt = txnAmount(t);
                  const tp = txnType(t);
                  return (
                    <div
                      key={t._id || idx}
                      onClick={() => setEditTxn(t)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)', cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0, paddingRight: 8 }}>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.Note || t.Category}
                        </div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                          {t.Date} • {t.Account || `${t.FromAccount} → ${t.ToAccount}`}
                        </div>
                        <div>
                          {t.itemStatus === 'pending' && (
                            <span className="debt-tag pending">⏳ {formatINR(t.pendingAmt)} unpaid</span>
                          )}
                          {t.itemStatus === 'partial' && (
                            <span className="debt-tag partial">🟡 {formatINR(t.pendingAmt)} unpaid ({formatINR(t.paidAmt)} paid)</span>
                          )}
                          {t.itemStatus === 'settled' && (
                            <span className="debt-tag settled">✓ Paid in full</span>
                          )}
                          {t.itemStatus === 'repayment' && (
                            <span className="debt-tag repayment">🤝 Repayment</span>
                          )}
                        </div>
                      </div>

                      <div style={{ fontSize: '0.88rem', fontWeight: 800, color: tp === 'income' ? 'var(--income)' : tp === 'expense' ? 'var(--expense)' : 'var(--transfer)', flexShrink: 0, textAlign: 'right' }}>
                        <div>{tp === 'income' ? '+' : tp === 'expense' ? '−' : '⇄'}{formatINR(amt)}</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {Math.abs(selectedPerson.netBalance) >= 0.5 && onSettle && (
              <button
                className="btn btn-primary btn-full"
                style={{ flexShrink: 0 }}
                onClick={() => {
                  const p = selectedPerson;
                  setSelectedPerson(null);
                  onSettle({
                    name: p.name,
                    amount: Math.abs(p.netBalance),
                    type: p.netBalance > 0 ? 'receive' : 'repay'
                  });
                }}
              >
                🤝 {selectedPerson.netBalance > 0 ? `Record Return (+${formatINR(selectedPerson.netBalance)})` : `Record Repayment (−${formatINR(Math.abs(selectedPerson.netBalance))})`}
              </button>
            )}
          </div>
        </>
      )}

      {editTxn && (
        <AddTransaction
          editTransaction={editTxn}
          onClose={() => setEditTxn(null)}
          onSaveAndContinue={() => setEditTxn(null)}
          backInterceptRef={backInterceptRef}
        />
      )}
    </div>
  );
}
