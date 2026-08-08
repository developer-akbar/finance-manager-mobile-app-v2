import React, { useState, useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { formatINR, formatINRCompact, parseDate } from '../../utils/format.js';
import { isCreditCard } from './Accounts.jsx';

export default function CardOptimizer({ onBack }) {
  const { state, updateAccount } = useApp();
  const { accounts, transactions } = state;
  const [editingCard, setEditingCard] = useState(null);
  const [targetInput, setTargetInput] = useState('');

  const today = new Date();

  // Calculate Grace Periods & Annual Milestone for every Credit Card
  const cardAnalysis = useMemo(() => {
    const list = [];
    const ccAccounts = (accounts || []).filter(isCreditCard);

    for (const card of ccAccounts) {
      const stmtDay = card.settlementDate || 1;
      const dueDays = card.paymentDueDays || 20;
      const annualTarget = card.feeWaiverTarget || 200000;

      // 1. Calculate Interest-Free Grace Days if swiped today
      let nextStmtDate;
      const thisMonthStmt = new Date(today.getFullYear(), today.getMonth(), stmtDay);

      if (today.getDate() < stmtDay) {
        nextStmtDate = thisMonthStmt;
      } else {
        nextStmtDate = new Date(today.getFullYear(), today.getMonth() + 1, stmtDay);
      }

      const nextDueDate = new Date(nextStmtDate.getFullYear(), nextStmtDate.getMonth(), nextStmtDate.getDate() + dueDays);
      const diffMs = nextDueDate.getTime() - today.getTime();
      const graceDays = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

      // 2. Calculate Annual Card Spends (last 365 days / current financial year)
      const oneYearAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
      let annualSpent = 0;

      for (const t of transactions) {
        if ((t.Account === card.name || t.Account === card) && (t['Income/Expense'] === 'Expense')) {
          const tDate = parseDate(t.Date);
          if (tDate >= oneYearAgo && tDate <= today) {
            annualSpent += parseFloat(t.INR || t.Amount || 0);
          }
        }
      }

      const progressPct = Math.min(100, Math.round((annualSpent / annualTarget) * 100));
      const remainingTarget = Math.max(0, annualTarget - annualSpent);

      list.push({
        card,
        name: card.name || card,
        stmtDay,
        dueDays,
        graceDays,
        nextStmtDate,
        nextDueDate,
        annualSpent,
        annualTarget,
        progressPct,
        remainingTarget,
      });
    }

    return list.sort((a, b) => b.graceDays - a.graceDays);
  }, [accounts, transactions, today]);

  const bestCard = cardAnalysis.length > 0 ? cardAnalysis[0] : null;

  const handleSaveTarget = async (cardObj) => {
    const val = parseFloat(targetInput);
    if (!isNaN(val) && val > 0) {
      await updateAccount(cardObj.id || cardObj.name, { ...cardObj, feeWaiverTarget: val });
    }
    setEditingCard(null);
  };

  return (
    <div className="sub-screen" style={{ background: 'var(--bg-base)', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-hdr">
        <button className="back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="16" height="16"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <div>
          <div className="page-hdr-title">💳 Credit Card Optimizer &amp; Perks</div>
          <div className="page-hdr-sub">Maximize interest-free days &amp; fee waivers</div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px var(--page-px) calc(var(--nav-height, 56px) + var(--safe-bottom, 0px) + 32px)', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Recommendation Hero */}
        {bestCard && (
          <div style={{
            background: 'linear-gradient(135deg, rgba(0,229,160,0.15) 0%, rgba(77,159,255,0.15) 100%)',
            border: '1.5px solid var(--accent)', borderRadius: 16, padding: 16, display: 'flex', flexDirection: 'column', gap: 6
          }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.8 }}>
              ⚡ BEST CARD TO SWIPE TODAY ({today.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--text-primary)' }}>
              {bestCard.name}
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-primary)', fontWeight: 600 }}>
              Enjoy <strong style={{ color: 'var(--accent)', fontSize: '0.95rem' }}>{bestCard.graceDays} interest-free days</strong> before payment is due on {bestCard.nextDueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}!
            </div>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Statement closes on {bestCard.nextStmtDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} • Payment due in {bestCard.dueDays} days
            </div>
          </div>
        )}

        {/* All Cards Breakdown */}
        <div style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--text-muted)' }}>
          ALL CREDIT CARDS GRACE PERIODS &amp; MILESTONES
        </div>

        {cardAnalysis.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30, fontSize: '0.82rem' }}>
            No credit cards found in your accounts list. Add a credit card with its statement closing day in Settings to enable the optimizer!
          </div>
        ) : (
          cardAnalysis.map((item, idx) => (
            <div
              key={item.name}
              style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 10
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: '1.1rem' }}>💳</span>
                    <span style={{ fontSize: '0.95rem', fontWeight: 800 }}>{item.name}</span>
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    Billing Cycle: {item.stmtDay}th of month • {item.dueDays} days to pay
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '1rem', fontWeight: 900, color: idx === 0 ? 'var(--accent)' : 'var(--income)' }}>
                    {item.graceDays} Days
                  </div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>
                    Grace Period
                  </div>
                </div>
              </div>

              {/* Annual Fee Waiver Milestone Progress */}
              <div style={{ background: 'var(--bg-card2)', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)' }}>
                    🎯 Annual Fee Waiver Progress
                  </span>
                  <button
                    onClick={() => {
                      setEditingCard(item.card);
                      setTargetInput(String(item.annualTarget));
                    }}
                    style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer' }}
                  >
                    Edit Target ⚙️
                  </button>
                </div>

                {/* Progress Bar */}
                <div style={{ width: '100%', height: 6, background: 'var(--bg-base)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${item.progressPct}%`, height: '100%', background: item.progressPct >= 100 ? 'var(--income)' : 'var(--accent)', transition: 'width 0.3s' }} />
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                  <span>Spent: <strong style={{ color: 'var(--text-primary)' }}>{formatINR(item.annualSpent)}</strong> / {formatINRCompact(item.annualTarget)}</span>
                  <span>{item.progressPct >= 100 ? '🎉 Waiver Achieved!' : `${formatINRCompact(item.remainingTarget)} remaining (${item.progressPct}%)`}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Edit Milestone Target Modal */}
      {editingCard && (
        <>
          <div className="overlay" onClick={() => setEditingCard(null)} />
          <div className="bottom-sheet" style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
            <div className="sheet-handle" />
            <div style={{ fontSize: '1rem', fontWeight: 800, marginBottom: 4 }}>
              Set Annual Fee Waiver Target for {editingCard.name || editingCard}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 14 }}>
              Enter the annual spend required by your bank to waive off the renewal membership fee (e.g. ₹2,00,000).
            </div>
            <div style={{ position: 'relative', marginBottom: 16 }}>
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '0.9rem' }}>₹</span>
              <input
                type="number"
                className="form-input"
                style={{ paddingLeft: 26, fontSize: '0.95rem' }}
                value={targetInput}
                onChange={e => setTargetInput(e.target.value)}
                placeholder="200000"
              />
            </div>
            <button className="btn btn-primary btn-full" onClick={() => handleSaveTarget(editingCard)}>
              Save Target
            </button>
          </div>
        </>
      )}
    </div>
  );
}
