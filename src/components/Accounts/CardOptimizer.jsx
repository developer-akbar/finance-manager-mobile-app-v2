import React, { useMemo } from 'react';
import { useApp } from '../../contexts/AppContext.jsx';
import { isCreditCard } from './Accounts.jsx';
import BackButton from '../Common/BackButton.jsx';
import FeeWaiverTrackerSection from './FeeWaiverTrackerSection.jsx';

export default function CardOptimizer({ onBack }) {
  const { state } = useApp();
  const { accounts, transactions } = state;

  const today = new Date();

  // Calculate Grace Periods for every Credit Card
  const cardAnalysis = useMemo(() => {
    const list = [];
    const ccAccounts = (accounts || []).filter(isCreditCard);

    for (const card of ccAccounts) {
      const stmtDay = card.settlementDate || 1;
      const dueDays = card.paymentDueDays || 20;

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

      list.push({
        card,
        name: card.name || card,
        stmtDay,
        dueDays,
        graceDays,
        nextStmtDate,
        nextDueDate,
      });
    }

    return list.sort((a, b) => b.graceDays - a.graceDays);
  }, [accounts, today]);

  const bestCard = cardAnalysis.length > 0 ? cardAnalysis[0] : null;

  return (
    <div className="sub-screen" style={{ background: 'var(--bg-base)', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-hdr">
        <BackButton onClick={onBack} label="Back to Accounts" />
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

        {/* Unified Credit Card Overview (Billing, Grace Period & Fee Waiver) */}
        <FeeWaiverTrackerSection
          accounts={(accounts || []).filter(isCreditCard)}
          transactions={transactions || []}
        />
      </div>
    </div>
  );
}
